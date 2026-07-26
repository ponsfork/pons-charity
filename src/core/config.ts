import "dotenv/config";
import { type Address, getAddress, isAddress } from "viem";

function req(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") throw new Error(`env ${name} is required`);
  return v.trim();
}

function optAddress(name: string): Address | undefined {
  const v = process.env[name]?.trim();
  if (!v || v === "" || /^0x0{40}$/i.test(v)) return undefined;
  if (!isAddress(v)) throw new Error(`env ${name}=${v} is not a valid address`);
  return getAddress(v);
}

function num(name: string, def: number): number {
  const v = process.env[name]?.trim();
  if (!v) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`env ${name}=${v} is not a number`);
  return n;
}

function big(name: string, def: bigint): bigint {
  const v = process.env[name]?.trim();
  if (!v) return def;
  try {
    return BigInt(v);
  } catch {
    throw new Error(`env ${name}=${v} is not an integer`);
  }
}

function bool(name: string, def: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  if (v === undefined || v === "") return def;
  return v === "1" || v === "true" || v === "yes";
}

function privateKey(): `0x${string}` {
  const v = req("PRIVATE_KEY");
  const hex = v.startsWith("0x") ? v : `0x${v}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("PRIVATE_KEY must be a 32-byte hex string");
  }
  return hex as `0x${string}`;
}

export interface BaseConfig {
  rpcUrl: string;
  wsUrl?: string;
  privateKey: `0x${string}`;
  dryRun: boolean;
  treasury?: Address;
}

function baseConfig(): BaseConfig {
  return {
    rpcUrl: process.env.RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com",
    wsUrl: process.env.WS_URL?.trim() || undefined,
    privateKey: privateKey(),
    dryRun: bool("DRY_RUN", true),
    treasury: optAddress("TREASURY"),
  };
}

export interface FeeDistributorConfig extends BaseConfig {
  minFee: bigint;
  minFeeInitial: bigint;
  serviceFeeBps: number;
  minHolderBps: number;
  collectIntervalSecs: number;
  dbPath: string;
  disperse?: Address;
  distributeNative: boolean;
}

export function loadFeeDistributorConfig(): FeeDistributorConfig {
  return {
    ...baseConfig(),
    minFee: big("FD_MIN_FEE", 50_000_000_000_000_000n), // 0.05 ETH
    minFeeInitial: big("FD_MIN_FEE_INITIAL", 100_000_000_000_000_000n), // 0.1 ETH
    serviceFeeBps: num("FD_SERVICE_FEE_BPS", 1000), // 10% — taken from both the WETH and the token side
    minHolderBps: num("FD_MIN_HOLDER_BPS", 1), // 0.01%
    collectIntervalSecs: num("FD_COLLECT_INTERVAL", 120),
    dbPath: process.env.FD_DB?.trim() || "fee_distributor.db",
    disperse: optAddress("FD_DISPERSE"),
    distributeNative: bool("FD_DISTRIBUTE_NATIVE", true),
  };
}
