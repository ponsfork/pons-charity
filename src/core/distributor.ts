import { type Address, type PublicClient, type WalletClient } from "viem";
import { disperseAbi, wethAbi } from "./abis.js";
import { ensureAllowance, transfer } from "./erc20.js";

const DISPERSE_BATCH = 200;

export interface Share {
  address: Address;
  amount: bigint;
}

export interface PaidEntry {
  recipient: Address;
  amount: bigint;
  tx: `0x${string}`;
}

/**
 * Split `distributable` across holders pro-rata to their balance. The last
 * eligible holder absorbs the rounding remainder, so the full amount is paid out
 * (mirrors the Rust distributor's allocation).
 */
export function buildShares(
  distributable: bigint,
  holders: { address: Address; balance: bigint }[],
  totalEligible: bigint,
): Share[] {
  const shares: Share[] = [];
  let allocated = 0n;
  for (let i = 0; i < holders.length; i++) {
    const h = holders[i]!;
    const amount =
      i === holders.length - 1
        ? distributable - allocated
        : (distributable * h.balance) / totalEligible;
    if (amount <= 0n) continue;
    shares.push({ address: h.address, amount });
    allocated += amount;
  }
  return shares;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

/** Unwrap WETH -> native ETH. */
async function unwrapWeth(pc: PublicClient, wc: WalletClient, weth: Address, amount: bigint) {
  const { request } = await pc.simulateContract({
    account: wc.account,
    address: weth,
    abi: wethAbi,
    functionName: "withdraw",
    args: [amount],
  });
  const hash = await wc.writeContract(request);
  await pc.waitForTransactionReceipt({ hash });
}

/**
 * Pay `shares` to holders. Four modes:
 *   native + disperse  -> one disperseEther per batch
 *   native + no contract-> one ETH transfer per holder
 *   WETH  + disperse   -> one disperseToken per batch
 *   WETH  + no contract -> one WETH transfer per holder
 *
 * Per-holder sends are individually guarded: a recipient that rejects the transfer
 * (e.g. a contract with no payable receive) is skipped and logged, so ONE bad
 * holder never blocks everyone else from getting paid.
 */
export async function payout(
  pc: PublicClient,
  wc: WalletClient,
  shares: Share[],
  opts: { weth: Address; distributeNative: boolean; disperse?: Address },
): Promise<PaidEntry[]> {
  if (shares.length === 0) return [];
  const paid: PaidEntry[] = [];
  const total = sum(shares.map((s) => s.amount));

  if (opts.distributeNative) {
    await unwrapWeth(pc, wc, opts.weth, total);

    if (opts.disperse) {
      for (const batch of chunk(shares, DISPERSE_BATCH)) {
        const value = sum(batch.map((s) => s.amount));
        const { request } = await pc.simulateContract({
          account: wc.account,
          address: opts.disperse,
          abi: disperseAbi,
          functionName: "disperseEther",
          args: [batch.map((s) => s.address), batch.map((s) => s.amount)],
          value,
        });
        const tx = await wc.writeContract(request);
        await pc.waitForTransactionReceipt({ hash: tx });
        for (const s of batch) paid.push({ recipient: s.address, amount: s.amount, tx });
      }
    } else {
      let skipped = 0;
      for (const s of shares) {
        try {
          const tx = await wc.sendTransaction({
            account: wc.account!,
            chain: wc.chain,
            to: s.address,
            value: s.amount,
          });
          const r = await pc.waitForTransactionReceipt({ hash: tx });
          if (r.status === "success") paid.push({ recipient: s.address, amount: s.amount, tx });
          else skipped++;
        } catch {
          skipped++; // recipient rejects ETH (contract without payable receive) — skip, keep paying the rest
        }
      }
      if (skipped) console.warn(`payout: skipped ${skipped} recipient(s) that rejected ETH`);
    }
    return paid;
  }

  // WETH (ERC-20) payouts
  if (opts.disperse) {
    await ensureAllowance(pc, wc, opts.weth, opts.disperse, total);
    for (const batch of chunk(shares, DISPERSE_BATCH)) {
      const { request } = await pc.simulateContract({
        account: wc.account,
        address: opts.disperse,
        abi: disperseAbi,
        functionName: "disperseToken",
        args: [opts.weth, batch.map((s) => s.address), batch.map((s) => s.amount)],
      });
      const tx = await wc.writeContract(request);
      await pc.waitForTransactionReceipt({ hash: tx });
      for (const s of batch) paid.push({ recipient: s.address, amount: s.amount, tx });
    }
  } else {
    let skipped = 0;
    for (const s of shares) {
      try {
        const tx = await transfer(pc, wc, opts.weth, s.address, s.amount);
        const r = await pc.waitForTransactionReceipt({ hash: tx });
        if (r.status === "success") paid.push({ recipient: s.address, amount: s.amount, tx });
        else skipped++;
      } catch {
        skipped++;
      }
    }
    if (skipped) console.warn(`payout: skipped ${skipped} recipient(s) on token transfer`);
  }
  return paid;
}
