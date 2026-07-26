import {
  type Address,
  erc20Abi,
  getAddress,
  parseAbi,
  type PublicClient,
  zeroAddress,
} from "viem";
import { ADDRESSES, DEAD_ADDRESS, FACTORY_DEPLOY_BLOCK } from "./addresses.js";

const v3FactoryAbi = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
]);

export interface HolderSnapshot {
  holders: { address: Address; balance: bigint }[];
  totalEligible: bigint;
}

/**
 * Reconstruct the current holder set of an ERC-20 by replaying Transfer logs to
 * gather candidate addresses, then reading live balances. Protocol-owned
 * addresses (pool, locker, position manager, factory, burn sink) are excluded —
 * the EVM analog of the Solana version filtering out bonding-curve / vault PDAs.
 */
export async function snapshotHolders(
  pc: PublicClient,
  token: Address,
  opts: {
    poolFee: bigint;
    totalSupply: bigint;
    minHolderBps: number;
    self: Address;
    weth: Address;
    fromBlock?: bigint;
  },
): Promise<HolderSnapshot> {
  if (opts.totalSupply === 0n) return { holders: [], totalEligible: 0n };

  const fromBlock = opts.fromBlock ?? FACTORY_DEPLOY_BLOCK.active;
  const latest = await pc.getBlockNumber();
  const STEP = 50_000n;

  const candidates = new Set<Address>();
  for (let start = fromBlock; start <= latest; start += STEP) {
    const end = start + STEP - 1n > latest ? latest : start + STEP - 1n;
    const logs = await pc.getContractEvents({
      address: token,
      abi: erc20Abi,
      eventName: "Transfer",
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const { from, to } = (log as unknown as { args: { from?: Address; to?: Address } }).args;
      if (from) candidates.add(getAddress(from));
      if (to) candidates.add(getAddress(to));
    }
  }

  // Resolve the Uniswap V3 pool so we can exclude its reserves.
  let pool: Address = zeroAddress;
  try {
    pool = (await pc.readContract({
      address: ADDRESSES.v3Factory,
      abi: v3FactoryAbi,
      functionName: "getPool",
      args: [token, opts.weth, Number(opts.poolFee)],
    })) as Address;
  } catch {
    /* leave pool as zero */
  }

  const excluded = new Set<string>(
    [
      zeroAddress,
      DEAD_ADDRESS,
      pool,
      token,
      opts.self,
      opts.weth,
      ADDRESSES.ponsLocker,
      ADDRESSES.positionManager,
      ADDRESSES.swapRouter,
      ADDRESSES.v3Factory,
      ADDRESSES.ponsFactory,
      ADDRESSES.ponsFactoryLegacy,
      ADDRESSES.multicall3,
    ].map((a) => a.toLowerCase()),
  );

  const list = [...candidates].filter((a) => !excluded.has(a.toLowerCase()));
  if (list.length === 0) return { holders: [], totalEligible: 0n };

  // Live balances via multicall.
  const balances = await pc.multicall({
    allowFailure: true,
    contracts: list.map((address) => ({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf" as const,
      args: [address],
    })),
  });

  const minAmount = (opts.totalSupply * BigInt(opts.minHolderBps)) / 10_000n;

  const holders: { address: Address; balance: bigint }[] = [];
  let totalEligible = 0n;
  for (let i = 0; i < list.length; i++) {
    const r = balances[i];
    if (!r || r.status !== "success") continue;
    const bal = r.result as bigint;
    if (bal >= minAmount && bal > 0n) {
      holders.push({ address: list[i]!, balance: bal });
      totalEligible += bal;
    }
  }

  return { holders, totalEligible };
}
