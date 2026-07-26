/**
 * Read-only preflight. Verifies RPC connectivity and that the vendored pons ABIs
 * / addresses actually respond on Robinhood Chain. Sends NO transactions and does
 * not require a funded key — if PRIVATE_KEY is unset it uses a throwaway account.
 *
 *   npm run check
 */
import "dotenv/config";
import { formatEther, getAddress, isAddress, type Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ponsFactoryAbi, ponsLockerAbi, ponsSwapRouterAbi } from "./core/abis.js";
import { ADDRESSES } from "./core/addresses.js";
import { makeClients } from "./core/chain.js";
import { listFeeTokens } from "./core/discovery.js";
import { makeLogger } from "./core/logger.js";

const log = makeLogger("check");

async function main() {
  const pkEnv = process.env.PRIVATE_KEY?.trim();
  const privateKey =
    pkEnv && /^0x[0-9a-fA-F]{64}$/.test(pkEnv.startsWith("0x") ? pkEnv : `0x${pkEnv}`)
      ? ((pkEnv.startsWith("0x") ? pkEnv : `0x${pkEnv}`) as `0x${string}`)
      : generatePrivateKey();
  const ephemeral = privateKey !== pkEnv && !(pkEnv?.startsWith("0x") && pkEnv.length === 66);

  const rpcUrl = process.env.RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com";
  const { publicClient: pc } = makeClients({ rpcUrl, privateKey });
  const me = privateKeyToAccount(privateKey).address;

  const chainId = await pc.getChainId();
  const block = await pc.getBlockNumber();
  log.info(`RPC ${rpcUrl}`);
  log.info(`chainId ${chainId} (expected 4663) | head block ${block}`);
  if (chainId !== 4663) log.warn("chainId is not 4663 — wrong RPC?");

  const launchFee = (await pc.readContract({
    address: ADDRESSES.ponsFactory,
    abi: ponsFactoryAbi,
    functionName: "launchFee",
  })) as bigint;
  log.info(`factory.launchFee() = ${formatEther(launchFee)} ETH  ✓ factory reachable`);

  const weth = (await pc.readContract({
    address: ADDRESSES.swapRouter,
    abi: ponsSwapRouterAbi,
    functionName: "WETH9",
  })) as Address;
  log.info(`router.WETH9() = ${weth}  ✓ router reachable`);
  if (getAddress(weth) !== getAddress(ADDRESSES.weth)) {
    log.warn(`router WETH differs from hardcoded ${ADDRESSES.weth} — code prefers the router value`);
  }

  const protoShare = (await pc.readContract({
    address: ADDRESSES.ponsLocker,
    abi: ponsLockerAbi,
    functionName: "protocolFeeShare",
  })) as bigint;
  log.info(`locker.protocolFeeShare() = ${protoShare}  ✓ locker reachable`);

  // If the user supplied a real wallet (or asks about one), list its fee tokens.
  const target = process.env.CHECK_WALLET?.trim();
  const wallet: Address = target && isAddress(target) ? getAddress(target) : me;
  const tokens = await listFeeTokens(pc, wallet);
  log.info(
    `${ephemeral && wallet === me ? "(throwaway) " : ""}wallet ${wallet} earns fees on ${tokens.length} token(s)`,
  );
  for (const t of tokens.slice(0, 10)) log.info(`  • ${t}`);

  log.info("preflight OK ✓");
}

main().catch((e) => {
  log.error(`preflight FAILED: ${(e as Error).message}`);
  process.exit(1);
});
