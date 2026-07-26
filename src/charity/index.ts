/**
 * pons-charity — the third Pons Fork protocol.
 *
 * Devs point their token's fee wallet at the Charity wallet. This engine:
 *   1. discovers those tokens (locker reverse-index, same as the other bots)
 *   2. claims their creator fees and HOLDS them (0% service fee — nothing skimmed)
 *   3. reads the dev's cause selection from on-chain memos: a 0-ETH tx from the
 *      token's DEPLOYER to the charity wallet with calldata `PONS|<orgId>|<token>`
 *      (the /charity page on ponsfork.com crafts this tx; latest memo wins)
 *   4. once a cause is chosen, forwards the FULL accumulated balance and every
 *      future claim automatically: WETH is unwrapped and sent as native ETH,
 *      the token-side fees are transferred as-is to the org's address.
 *
 * Per-token accounting lives in SQLite (collected vs donated), so fees accrued
 * before the dev picks a cause are never lost. Every step is guarded — one bad
 * token or a launch-window transfer restriction never blocks the others.
 */
import "dotenv/config";
import { formatEther, formatUnits, erc20Abi, parseEther, getAddress, type Address } from "viem";
import { ponsSwapRouterAbi, wethAbi } from "../core/abis.js";
import { ADDRESSES } from "../core/addresses.js";
import { makeClients } from "../core/chain.js";
import { Db } from "../core/db.js";
import { discoverAndStore } from "../core/discovery.js";
import { balanceOf, transfer } from "../core/erc20.js";
import { claimFees, getLaunchedToken, previewFees } from "../core/fees.js";
import { makeLogger } from "../core/logger.js";

const log = makeLogger("charity");
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const eth = (v: bigint) => `${formatEther(v)} ETH`;

const EXPLORER_API = "https://robinhoodchain.blockscout.com/api";

/** Verified crypto-donation addresses (checked against each org's official page). */
const CHARITIES: Record<string, { name: string; address: Address }> = {
  stjude:   { name: "St. Jude Children's Research Hospital", address: "0x92EE2370b56DC32794A6CD72585dC01d4288D314" },
  givewell: { name: "GiveWell",                               address: "0x4647c3b4c5ba4efa6d8197331de00c26ce36e8e6" },
  eff:      { name: "Electronic Frontier Foundation",         address: "0x1ca9EB2a5C213d417269134b80111F57e1644105" },
  fpf:      { name: "Freedom of the Press Foundation",        address: "0xC423F8aEDf1753Bc0ab58e455B0b5421CafE949e" },
  // archive: Internet Archive — EXCLUDED until its ETH address is re-verified (conflicting sources).
};

async function main() {
  const pk = (process.env.PRIVATE_KEY || "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) { log.error("PRIVATE_KEY missing/invalid in .env"); process.exit(1); }
  const cfg = {
    rpcUrl: process.env.RPC_URL?.trim() || "https://rpc.mainnet.chain.robinhood.com",
    privateKey: pk as `0x${string}`,
    dryRun: (process.env.DRY_RUN ?? "true").toLowerCase() !== "false",
    minFee: BigInt(process.env.CH_MIN_FEE || parseEther("0.0002").toString()),
    intervalSecs: Number(process.env.CH_COLLECT_INTERVAL || 60),
    dbPath: process.env.CH_DB || "charity.db",
  };
  const { publicClient: pc, walletClient: wc, account } = makeClients(cfg);
  const db = new Db(cfg.dbPath);
  const me = account.address;

  const weth = (await pc
    .readContract({ address: ADDRESSES.swapRouter, abi: ponsSwapRouterAbi, functionName: "WETH9" })
    .catch(() => ADDRESSES.weth)) as Address;

  log.info(`wallet:   ${me}`);
  log.info(`weth:     ${weth}`);
  log.info(`min fee:  ${eth(cfg.minFee)} | service fee 0% — everything goes to the cause`);
  log.info(`causes:   ${Object.entries(CHARITIES).map(([k, v]) => `${k}=${v.name}`).join(" | ")}`);
  log.info(cfg.dryRun ? "🟡 DRY_RUN — no transactions will be sent" : "🔴 LIVE — sending real transactions");

  process.on("SIGINT", () => { log.info("shutting down"); process.exit(0); });

  // token(lower) -> percentage allocation across causes, from on-chain memos;
  // deployer-verified, latest memo wins. Memo: PONS|<token>|stjude:40,givewell:60 (pcts sum to 100)
  const selections = new Map<string, { id: string; pct: number }[]>();
  const deployerCache = new Map<string, string>();
  const symCache = new Map<string, string>();

  async function deployerOf(token: Address): Promise<string> {
    const k = token.toLowerCase();
    if (!deployerCache.has(k)) {
      const info = await getLaunchedToken(pc, token).catch(() => null);
      deployerCache.set(k, info?.exists ? info.deployer.toLowerCase() : "");
    }
    return deployerCache.get(k)!;
  }
  async function symOf(token: Address): Promise<string> {
    const k = token.toLowerCase();
    if (!symCache.has(k)) {
      symCache.set(k, (await pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?")) as string);
    }
    return symCache.get(k)!;
  }

  async function refreshSelections() {
    try {
      const r = (await (await fetch(`${EXPLORER_API}?module=account&action=txlist&address=${me}&sort=asc`)).json()) as any;
      if (!Array.isArray(r.result)) return;
      for (const t of r.result) {
        if (!t.to || t.to.toLowerCase() !== me.toLowerCase()) continue;
        if (t.isError === "1" || !t.input || t.input === "0x") continue;
        let txt = "";
        try { txt = Buffer.from(t.input.slice(2), "hex").toString("utf8"); } catch { continue; }
        const m = txt.match(/^PONS\|(0x[0-9a-fA-F]{40})\|([a-z]+:\d+(?:,[a-z]+:\d+)*)$/);
        if (!m) continue;
        const tokenRaw = m[1] ?? "";
        const allocRaw = m[2] ?? "";
        if (!tokenRaw || !allocRaw) continue;
        const parts = allocRaw.split(",").map((p) => {
          const [id, pctS] = p.split(":");
          return { id: id ?? "", pct: Number(pctS ?? "0") };
        });
        const valid =
          parts.length > 0 &&
          parts.every((p) => CHARITIES[p.id] && Number.isInteger(p.pct) && p.pct > 0) &&
          parts.reduce((a, b) => a + b.pct, 0) === 100 &&
          new Set(parts.map((p) => p.id)).size === parts.length;
        if (!valid) continue;
        const token = getAddress(tokenRaw as Address);
        const dep = await deployerOf(token);
        if (!dep || dep !== t.from.toLowerCase()) { log.warn(`memo ignored: ${t.from} is not deployer of ${token}`); continue; }
        const prev = JSON.stringify(selections.get(token.toLowerCase()) ?? null);
        selections.set(token.toLowerCase(), parts); // asc order → latest memo wins
        if (prev !== JSON.stringify(parts))
          log.info(`allocation set: ${token} → ${parts.map((p) => `${p.pct}% ${CHARITIES[p.id]!.name}`).join(", ")} (by deployer ${t.from})`);
      }
    } catch (e) {
      log.warn(`selection refresh failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  let cycle = 0;
  for (;;) {
    try {
      await discoverAndStore(pc, db, me, log);
      await refreshSelections();
      const tokens = db.allTokens();
      if (cycle++ % 10 === 0) {
        const head = await pc.getBlockNumber().catch(() => 0n);
        log.info(`heartbeat: cycle ${cycle} | tracking ${tokens.length} token(s), ${selections.size} cause(s) chosen | head block ${head}`);
      }
      for (const token of tokens) {
        await processToken(token).catch((e) => log.error(`token ${token} failed: ${(e as Error).message.split("\n")[0]}`));
      }
    } catch (e) {
      log.error(`cycle error: ${(e as Error).message}`);
    }
    await sleep(cfg.intervalSecs);
  }

  async function processToken(token: Address) {
    const info = await getLaunchedToken(pc, token);
    if (!info.exists) return;

    // 1. Claim when worthwhile — regardless of whether a cause is chosen yet (we hold).
    const preview = await previewFees(pc, info, me);
    let claimTx: string | null = null;
    if (preview.weth >= cfg.minFee) {
      if (cfg.dryRun) {
        log.info(`${token}: [dry-run] would claim ${eth(preview.weth)} + ${preview.token} tok`);
      } else {
        try {
          const claimed = await claimFees(pc, wc, info, weth);
          claimTx = claimed.hash;
          log.info(`${token}: claimed ${eth(claimed.weth)} + ${claimed.token} tokens — tx ${claimed.hash}`);
          db.recordCollection(token, claimed.weth, claimed.token, claimed.hash);
          db.bumpClaim(token);
        } catch (e) {
          log.error(`${token}: claim failed: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    }

    // 2. Forward everything once (and only once) an allocation is chosen.
    //    WETH is DB-attributed (claims can belong to different tokens sharing one WETH
    //    balance). The TOKEN side is BALANCE-based: forward everything the wallet holds
    //    of this token — claimed fees AND supply sent to the charity wallet out-of-band
    //    (e.g. a dev donating bought-back supply directly).
    const alloc = selections.get(token.toLowerCase());
    const owedWeth = db.sumCollectedWeth(token) - db.sumDonatedWeth(token);
    const tokBal = await balanceOf(pc, token, me).catch(() => 0n);
    if (!alloc) {
      if (owedWeth > 0n || tokBal > 0n)
        log.info(`${token}: holding ${eth(owedWeth)} + ${tokBal} tok — awaiting the dev's allocation`);
      return;
    }
    if (cfg.dryRun) {
      if (owedWeth > 0n || tokBal > 0n)
        log.info(`${token}: [dry-run] would donate ${eth(owedWeth)} + ${tokBal} tok split ${alloc.map((a) => `${a.pct}% ${a.id}`).join(", ")}`);
      return;
    }
    if (owedWeth <= 0n && tokBal <= 0n) return;

    const sym = await symOf(token);
    const dec = Number((await pc.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }).catch(() => 18)) as number);

    // Cap at real balances (never touch gas), unwrap the WETH part once up-front.
    let wAmt = 0n;
    if (owedWeth > 0n) {
      try {
        const wbal = (await pc.readContract({ address: weth, abi: erc20Abi, functionName: "balanceOf", args: [me] })) as bigint;
        wAmt = owedWeth <= wbal ? owedWeth : wbal;
        if (wAmt > 0n) {
          const { request } = await pc.simulateContract({ account, address: weth, abi: wethAbi, functionName: "withdraw", args: [wAmt] });
          const uh = await wc.writeContract(request);
          await pc.waitForTransactionReceipt({ hash: uh });
        }
      } catch (e) {
        log.error(`${token}: WETH unwrap failed: ${(e as Error).message.split("\n")[0]}`);
        wAmt = 0n;
      }
    }
    const tAmt = tokBal;
    if (wAmt <= 0n && tAmt <= 0n) return;

    // Per-org shares: floor by pct, the last org absorbs rounding dust.
    let wUsed = 0n, tUsed = 0n;
    for (let i = 0; i < alloc.length; i++) {
      const a = alloc[i]!;
      const org = CHARITIES[a.id]!;
      const last = i === alloc.length - 1;
      const wShare = last ? wAmt - wUsed : (wAmt * BigInt(a.pct)) / 100n;
      const tShare = last ? tAmt - tUsed : (tAmt * BigInt(a.pct)) / 100n;
      wUsed += wShare; tUsed += tShare;

      let donateTx: string | null = null;
      let donatedWeth = 0n;
      if (wShare > 0n) {
        try {
          donateTx = await wc.sendTransaction({ account, chain: wc.chain, to: org.address, value: wShare });
          await pc.waitForTransactionReceipt({ hash: donateTx as `0x${string}` });
          donatedWeth = wShare;
          db.recordDistribution(token, org.address, wShare, donateTx);
          log.info(`${token}: donated ${eth(wShare)} (${a.pct}%) → ${org.name} — tx ${donateTx}`);
        } catch (e) {
          log.error(`${token}: donation to ${org.name} failed: ${(e as Error).message.split("\n")[0]}`);
        }
      }

      let tokTx: string | null = null;
      let sentTok = 0n;
      if (tShare > 0n) {
        try {
          tokTx = await transfer(pc, wc, token, org.address, tShare);
          await pc.waitForTransactionReceipt({ hash: tokTx as `0x${string}` });
          sentTok = tShare;
          db.recordTokenSend(token, org.address, tShare, tokTx);
          log.info(`${token}: sent ${tShare} tokens (${a.pct}%) → ${org.name} — tx ${tokTx}`);
        } catch (e) {
          // launch-window transfer restrictions can revert plain transfers — retry next cycle
          log.warn(`${token}: token send to ${org.name} skipped (${(e as Error).message.split("\n")[0]}) — will retry`);
        }
      }

      if (donatedWeth > 0n || sentTok > 0n)
        log.info(`SUMMARY|charity|${token}|${sym}|${formatEther(donatedWeth)}|${a.id}|${claimTx ?? ""}|${donateTx ?? ""}|${formatUnits(sentTok, dec)}|${tokTx ?? ""}`);
    }
  }
}

main().catch((e) => {
  log.error(`fatal: ${(e as Error).stack ?? e}`);
  process.exit(1);
});
