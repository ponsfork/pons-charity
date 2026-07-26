import Database from "better-sqlite3";
import type { Address } from "viem";

/**
 * Local state store (SQLite). Same base schema as the other Pons Fork bots, plus
 * charity-specific accounting: per-token totals of what was collected vs what was
 * already forwarded, so fees accrued BEFORE the dev picks a cause are never lost —
 * the first cycle after a choice sends the whole accumulated balance.
 */
export class Db {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tokens (
        mint          TEXT PRIMARY KEY,
        first_seen    INTEGER NOT NULL,
        claim_count   INTEGER NOT NULL DEFAULT 0,
        last_claim_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS collections (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        mint          TEXT NOT NULL,
        weth_amount   TEXT NOT NULL,
        token_amount  TEXT NOT NULL,
        tx_hash       TEXT NOT NULL,
        ts            INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS distributions (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        mint          TEXT NOT NULL,
        recipient     TEXT NOT NULL,
        amount        TEXT NOT NULL,
        tx_hash       TEXT NOT NULL,
        ts            INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS token_sends (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        mint          TEXT NOT NULL,
        recipient     TEXT NOT NULL,
        amount        TEXT NOT NULL,
        tx_hash       TEXT NOT NULL,
        ts            INTEGER NOT NULL
      );
    `);
  }

  /** Insert a token if new. Returns true if it was newly inserted. */
  upsertToken(mint: Address): boolean {
    const info = this.db
      .prepare("INSERT OR IGNORE INTO tokens (mint, first_seen) VALUES (?, ?)")
      .run(mint.toLowerCase(), Math.floor(Date.now() / 1000));
    return info.changes > 0;
  }

  allTokens(): Address[] {
    const rows = this.db
      .prepare("SELECT mint FROM tokens ORDER BY first_seen ASC")
      .all() as { mint: string }[];
    return rows.map((r) => r.mint as Address);
  }

  claimCount(mint: Address): number {
    const row = this.db
      .prepare("SELECT claim_count FROM tokens WHERE mint = ?")
      .get(mint.toLowerCase()) as { claim_count: number } | undefined;
    return row?.claim_count ?? 0;
  }

  bumpClaim(mint: Address) {
    this.db
      .prepare("UPDATE tokens SET claim_count = claim_count + 1, last_claim_at = ? WHERE mint = ?")
      .run(Math.floor(Date.now() / 1000), mint.toLowerCase());
  }

  recordCollection(mint: Address, weth: bigint, token: bigint, txHash: string) {
    this.db
      .prepare("INSERT INTO collections (mint, weth_amount, token_amount, tx_hash, ts) VALUES (?, ?, ?, ?, ?)")
      .run(mint.toLowerCase(), weth.toString(), token.toString(), txHash, Math.floor(Date.now() / 1000));
  }

  recordDistribution(mint: Address, recipient: Address, amount: bigint, txHash: string) {
    this.db
      .prepare("INSERT INTO distributions (mint, recipient, amount, tx_hash, ts) VALUES (?, ?, ?, ?, ?)")
      .run(mint.toLowerCase(), recipient.toLowerCase(), amount.toString(), txHash, Math.floor(Date.now() / 1000));
  }

  recordTokenSend(mint: Address, recipient: Address, amount: bigint, txHash: string) {
    this.db
      .prepare("INSERT INTO token_sends (mint, recipient, amount, tx_hash, ts) VALUES (?, ?, ?, ?, ?)")
      .run(mint.toLowerCase(), recipient.toLowerCase(), amount.toString(), txHash, Math.floor(Date.now() / 1000));
  }

  // BigInt sums are done in JS — SQLite SUM() on TEXT loses precision on wei values.
  private sumCol(table: string, col: string, mint: Address): bigint {
    const rows = this.db
      .prepare(`SELECT ${col} AS v FROM ${table} WHERE mint = ?`)
      .all(mint.toLowerCase()) as { v: string }[];
    let s = 0n;
    for (const r of rows) { try { s += BigInt(r.v || "0"); } catch {} }
    return s;
  }
  sumCollectedWeth(mint: Address): bigint { return this.sumCol("collections", "weth_amount", mint); }
  sumCollectedToken(mint: Address): bigint { return this.sumCol("collections", "token_amount", mint); }
  sumDonatedWeth(mint: Address): bigint { return this.sumCol("distributions", "amount", mint); }
  sumTokenSent(mint: Address): bigint { return this.sumCol("token_sends", "amount", mint); }
}
