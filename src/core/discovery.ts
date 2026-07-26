import { type Address, getAddress, type PublicClient } from "viem";
import { ponsFactoryAbi, ponsLockerAbi } from "./abis.js";
import { ADDRESSES, FACTORY_DEPLOY_BLOCK } from "./addresses.js";
import type { Db } from "./db.js";
import type { Logger } from "./logger.js";

/**
 * Enumerate every token whose creator fees are currently directed to `recipient`,
 * straight from the locker's reverse index. This is the EVM analog of the Rust
 * services' Geyser discovery — but authoritative and pull-based, no log scanning.
 */
export async function listFeeTokens(
  pc: PublicClient,
  recipient: Address,
): Promise<Address[]> {
  const count = (await pc.readContract({
    address: ADDRESSES.ponsLocker,
    abi: ponsLockerAbi,
    functionName: "feeRecipientTokenCount",
    args: [recipient],
  })) as bigint;

  if (count === 0n) return [];

  const n = Number(count);
  const calls = Array.from({ length: n }, (_, i) => ({
    address: ADDRESSES.ponsLocker,
    abi: ponsLockerAbi,
    functionName: "feeRecipientTokens" as const,
    args: [recipient, BigInt(i)],
  }));

  const results = await pc.multicall({ contracts: calls, allowFailure: true });
  const tokens: Address[] = [];
  for (const r of results) {
    if (r.status === "success" && r.result) tokens.push(getAddress(r.result as Address));
  }
  return tokens;
}

/**
 * Backfill: scan TokenLaunched logs for tokens we deployed (in case a token was
 * launched with us as deployer but fees not yet routed / indexed).
 */
export async function scanLaunchedByDeployer(
  pc: PublicClient,
  deployer: Address,
  fromBlock = FACTORY_DEPLOY_BLOCK.active,
): Promise<Address[]> {
  const latest = await pc.getBlockNumber();
  const tokens = new Set<Address>();
  const STEP = 50_000n;

  for (let start = fromBlock; start <= latest; start += STEP) {
    const end = start + STEP - 1n > latest ? latest : start + STEP - 1n;
    const logs = await pc.getContractEvents({
      address: ADDRESSES.ponsFactory,
      abi: ponsFactoryAbi,
      eventName: "TokenLaunched",
      args: { deployer },
      fromBlock: start,
      toBlock: end,
    });
    for (const log of logs) {
      const token = (log as unknown as { args: { token?: Address } }).args.token;
      if (token) tokens.add(getAddress(token));
    }
  }
  return [...tokens];
}

/** Refresh the DB with all tokens we currently earn fees on. Returns newly-seen tokens. */
export async function discoverAndStore(
  pc: PublicClient,
  db: Db,
  recipient: Address,
  log: Logger,
  opts: { scanLogs?: boolean } = {},
): Promise<Address[]> {
  const fromIndex = await listFeeTokens(pc, recipient);
  let all = fromIndex;

  if (opts.scanLogs) {
    try {
      const fromLogs = await scanLaunchedByDeployer(pc, recipient);
      all = [...new Set([...fromIndex, ...fromLogs])];
    } catch (e) {
      log.warn(`log scan failed, using locker index only: ${(e as Error).message}`);
    }
  }

  const fresh: Address[] = [];
  for (const token of all) {
    if (db.upsertToken(token)) {
      fresh.push(token);
      log.info(`discovered token ${token}`);
    }
  }
  return fresh;
}
