import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Abi, erc20Abi, parseAbi } from "viem";

/**
 * Load the verified contract ABIs vendored under <projectRoot>/abis/.
 * These were fetched directly from Robinhood Chain Blockscout (getabi) so the
 * signatures used to sign real transactions are exactly the on-chain ones.
 */
function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      readFileSync(join(dir, "package.json"));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error("could not locate project root (package.json) to load abis/");
}

function loadAbi(name: string): Abi {
  const path = join(projectRoot(), "abis", `${name}.json`);
  let raw = readFileSync(path, "utf8");
  // Strip a UTF-8 BOM if present — some editors/shells prepend one and JSON.parse rejects it.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  return JSON.parse(raw) as Abi;
}

export const ponsFactoryAbi = loadAbi("PonsLaunchFactory");
export const ponsLockerAbi = loadAbi("PonsLocker");
export const ponsSwapRouterAbi = loadAbi("PonsSwapRouter");

export { erc20Abi };

/** WETH (wrap/unwrap) — standard WETH9 surface beyond the ERC-20 methods. */
export const wethAbi = parseAbi([
  "function deposit() payable",
  "function withdraw(uint256 wad)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value) returns (bool)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

/** Minimal Disperse surface (optional batch payout contract). */
export const disperseAbi = parseAbi([
  "function disperseEther(address[] recipients, uint256[] values) payable",
  "function disperseToken(address token, address[] recipients, uint256[] values)",
]);
