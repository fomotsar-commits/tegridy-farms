// fill-scoreboard.mjs and its chain reader: what .github/workflows/fill-scoreboard.yml runs
// hourly. The reader is checked against real mainnet swaps (fixtures/fill-scoreboard,
// recorded 2026-10-22); the write rules against fakes. Each `it` names the broken reader it
// would catch.
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { base58, unbase58, JUPITER_FEE_ACCOUNTS, SOL_MINT } from "./lib/venue-volume-chain.mjs";
import { EXACT_IN_ROUTES, jupiterFill, rowOf, readFills } from "./lib/fill-scoreboard-chain.mjs";
import { main } from "./fill-scoreboard.mjs";
import { summarize, STALE_AFTER_MS } from "../api/_lib/fillScoreboardPolicy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, "fixtures", "fill-scoreboard", "mainnet.json"), "utf-8"));
const [SOL_FEE, USDC_FEE] = JUPITER_FEE_ACCOUNTS;
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BAYLA = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
const tx = (name) => structuredClone(FX.txs[name]);
const sigOf = (t) => ({ signature: t.transaction.signatures[0], blockTime: t.blockTime });

describe("the route instructions it reads", () => {
  it("are Anchor's discriminators for Jupiter's four ExactIn routes (a typo would score nothing)", () => {
    for (const [hex, name] of Object.entries(EXACT_IN_ROUTES)) {
      expect(createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex")).toBe(hex);
    }
  });
  it("match the fee accounts the volume counter reads (one list, not two)", () => {
    expect(FX.feeAccounts).toEqual({ sol: SOL_FEE, usdc: USDC_FEE });
  });
});

describe("jupiterFill: real swaps through the site", () => {
  it("a buy with our fee taken from the SOL in: quote from the route, fill from the trader's token account", () => {
    const hit = jupiterFill(tx("buyFeeOnInput"), SOL_FEE);
    expect(hit).toMatchObject({
      inMint: SOL_MINT,
      inAmount: 189708800n,
      quotedOut: 421454241541n,
      deliveredOut: 421457973863n,
      slippageBps: 50,
      platformFeeBps: 50,
    });
    // It opened the trader's account for the token bought: any venue does, so no deposit.
    expect(hit.depositLamports).toBe(0n);
    expect(rowOf(hit, sigOf(FX.txs.buyFeeOnInput)).fill_bps).toBe(0.08);
  });

  it("a sell into SOL with our fee taken from the SOL out: the quote is after the fee, and met exactly", () => {
    const hit = jupiterFill(tx("sellToSolFeeOnOutput"), SOL_FEE);
    expect(hit).toMatchObject({ inMint: BAYLA, outMint: SOL_MINT, quotedOut: 691104595n, deliveredOut: 691104595n });
  });

  it("a sell into SOL reads the route's SOL, not the wallet's lamports (rent and the network fee are not price)", () => {
    const t = tx("sellToSolRouteDeposit");
    const hit = jupiterFill(t, SOL_FEE);
    expect(hit.deliveredOut).toBe(290746417n);
    const lamports = BigInt(t.meta.postBalances[0] - t.meta.preBalances[0] + t.meta.fee);
    expect(lamports).toBe(289400217n); // what a lamport reader would have called the fill
    expect(rowOf(hit, sigOf(t)).fill_bps).toBe(-2.32);
  });

  it("counts the SOL the route left in accounts it opened, and not the ones it closed", () => {
    // pump's AMM opened an account for this trader (1,346,200); the wrapped-SOL account was closed.
    expect(jupiterFill(tx("sellToSolRouteDeposit"), SOL_FEE).depositLamports).toBe(1346200n);
    // A Token-2022 account for the route's middle token, left open with nothing in it.
    expect(jupiterFill(tx("usdcToSolToken2022Deposit"), USDC_FEE)).toMatchObject({
      inMint: USDC,
      outMint: SOL_MINT,
      quotedOut: 87303111n,
      deliveredOut: 87283532n,
      depositLamports: 1600200n,
    });
  });

  it("a sell into USDC with our fee taken from the USDC out", () => {
    const hit = jupiterFill(tx("sellToUsdcFeeOnOutput"), USDC_FEE);
    expect(hit).toMatchObject({ inMint: BAYLA, outMint: USDC, quotedOut: 35954282n, deliveredOut: 35962545n });
  });

  it("is null for a swap in our own pools, a transaction that is not a swap, and the other fee account", () => {
    for (const a of JUPITER_FEE_ACCOUNTS) {
      expect(jupiterFill(tx("ourPoolTrade"), a)).toBeNull();
      expect(jupiterFill(tx("notASwap"), a)).toBeNull();
    }
    expect(jupiterFill(tx("buyFeeOnInput"), USDC_FEE)).toBeNull();
  });

  it("is null for a failed swap", () => {
    const t = tx("buyFeeOnInput");
    t.meta.err = { InstructionError: [3, { Custom: 6001 }] };
    expect(jupiterFill(t, SOL_FEE)).toBeNull();
  });
});

describe("jupiterFill: a swap that paid our fee but cannot be scored is said, never dropped", () => {
  const jupIx = (t) => t.transaction.message.instructions.find((ix) => ix.programId === "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

  it("an ExactOut or unknown route", () => {
    const t = tx("buyFeeOnInput");
    const ix = jupIx(t);
    const d = Buffer.from(unbase58(ix.data));
    createHash("sha256").update("global:exact_out_route").digest().copy(d, 0, 0, 8);
    ix.data = base58(d);
    expect(jupiterFill(t, SOL_FEE)).toMatchObject({ unread: expect.stringMatching(/not an ExactIn route/) });
  });

  it("a route Jupiter was called into by another program (no route instruction at the top)", () => {
    const t = tx("buyFeeOnInput");
    t.transaction.message.instructions = t.transaction.message.instructions.filter((ix) => ix !== jupIx(t));
    expect(jupiterFill(t, SOL_FEE)).toMatchObject({ unread: "0 Jupiter instructions at the top level" });
  });

  it("an output the trader's balances do not show", () => {
    const t = tx("buyFeeOnInput");
    t.meta.postTokenBalances = t.meta.postTokenBalances.filter((b) => b.mint === SOL_MINT);
    expect(jupiterFill(t, SOL_FEE)).toMatchObject({ unread: expect.stringMatching(/output is not in the transaction/) });
  });

  it("and its row carries the reason with no figures", () => {
    const t = tx("buyFeeOnInput");
    t.transaction.message.instructions = t.transaction.message.instructions.filter((ix) => ix !== jupIx(t));
    const row = rowOf(jupiterFill(t, SOL_FEE), sigOf(t));
    expect(row).toEqual({
      signature: t.transaction.signatures[0],
      block_time: new Date(t.blockTime * 1000).toISOString(),
      bot: false,
      unread_reason: "0 Jupiter instructions at the top level",
    });
  });
});

// ── the summary ──────────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-22T12:00:00Z");
const CURSOR = { counted_to: "2026-10-22T11:41:00Z", last_ok_at: "2026-10-22T11:42:00Z", last_error_at: null };
const fill = (quoted, delivered, over = {}) => ({
  block_time: "2026-10-21T00:00:00Z",
  bot: false,
  quoted_out: String(quoted),
  delivered_out: String(delivered),
  slippage_bps: 50,
  deposit_lamports: "0",
  unread_reason: null,
  ...over,
});

describe("summarize", () => {
  it("medians the fills and counts those at or above the quote and those near the floor", () => {
    const rows = [
      fill(1_000_000, 1_000_100), // +1.00
      fill(1_000_000, 1_000_000), // 0
      fill(1_000_000, 999_000), // -10.00
      fill(1_000_000, 995_500, { deposit_lamports: "1346200" }), // -45: used 90% of the 0.5% allowed
    ];
    expect(summarize(rows, CURSOR, NOW)).toEqual({
      state: "current",
      asOf: "2026-10-22T11:41:00.000Z",
      staleAt: new Date(Date.parse(CURSOR.counted_to) + STALE_AFTER_MS).toISOString(),
      windowDays: 30,
      trades: 4,
      unscored: 0,
      medianFillBps: -5,
      worstFillBps: -45,
      atOrAboveQuote: 2,
      nearFloor: 1,
      deposits: { trades: 1, lamports: "1346200" },
    });
  });

  it("leaves out bots and swaps older than the window, and counts the unscored apart", () => {
    const rows = [
      fill(1_000_000, 1_000_000),
      fill(1_000_000, 900_000, { bot: true }),
      fill(1_000_000, 900_000, { block_time: "2026-09-01T00:00:00Z" }),
      { block_time: "2026-10-21T00:00:00Z", bot: false, unread_reason: "0 Jupiter instructions at the top level" },
      fill(1_000_000, "1e6"), // a figure that does not parse is not a fill
    ];
    expect(summarize(rows, CURSOR, NOW)).toMatchObject({ trades: 1, unscored: 2, worstFillBps: 0 });
  });

  it("is unread with no figures until a run has finished", () => {
    expect(summarize([fill(1, 1)], null, NOW)).toEqual({ state: "unread" });
    expect(summarize([fill(1, 1)], { ...CURSOR, last_ok_at: null }, NOW)).toEqual({ state: "unread" });
  });

  it("is behind after a failed run, or three hours without one", () => {
    expect(summarize([], { ...CURSOR, last_error_at: "2026-10-22T11:50:00Z" }, NOW).state).toBe("behind");
    expect(summarize([], CURSOR, Date.parse(CURSOR.counted_to) + STALE_AFTER_MS + 1).state).toBe("behind");
    expect(summarize([], CURSOR, NOW)).toMatchObject({ state: "current", trades: 0, medianFillBps: null, worstFillBps: null });
  });
});

// ── the job ──────────────────────────────────────────────────────────────────

/** A chain with the recorded swaps on the SOL fee account and nothing on the USDC one. */
function fakeChain() {
  const onSol = ["buyFeeOnInput", "sellToSolFeeOnOutput", "ourPoolTrade"].map((n) => FX.txs[n]);
  return async (method, params) => {
    if (method === "getSignaturesForAddress") {
      if (params[0] !== SOL_FEE || params[1].until) return [];
      return onSol.map((t) => ({ signature: t.transaction.signatures[0], blockTime: t.blockTime, err: null })).reverse();
    }
    if (method === "getTransaction") return structuredClone(onSol.find((t) => t.transaction.signatures[0] === params[0]));
    throw new Error(`unexpected ${method}`);
  };
}

function fakeDb({ cursorRow = null, tableMissing = false, refuseRows = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = url.replace("https://db.test/rest/v1/", "");
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null, prefer: init.headers?.Prefer });
    const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
    if (tableMissing) return json(404, { code: "PGRST205" });
    if (path.startsWith("fill_scoreboard_cursor?select")) return json(200, cursorRow ? [cursorRow] : []);
    if (path.startsWith("fill_scoreboard?on_conflict")) return refuseRows ? json(400, { message: "no" }) : json(201, null);
    if (path === "fill_scoreboard_cursor" && init.method === "POST") return json(201, [{}]);
    if (path.startsWith("fill_scoreboard_cursor?source") && init.method === "PATCH") return json(200, [{}]);
    return json(500, { message: `unexpected ${path}` });
  };
  return { calls, fetchImpl };
}
const ENV = { SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_KEY: "k" };
const quiet = { log: () => {}, error: () => {} };

describe("main", () => {
  it("upserts the scored swaps by signature, then moves the cursor", async () => {
    const db = fakeDb();
    expect(await main({ env: ENV, fetchImpl: db.fetchImpl, call: fakeChain(), ...quiet })).toBe(0);
    const [read, rows, cursor] = db.calls;
    expect(read.path).toBe("fill_scoreboard_cursor?select=*");
    expect(rows.prefer).toBe("resolution=merge-duplicates,return=minimal");
    expect(rows.body.map((r) => r.quoted_out)).toEqual(["421454241541", "691104595"]);
    expect(cursor).toMatchObject({ path: "fill_scoreboard_cursor", method: "POST" });
    // The newest signature read, our-pool swap included: the next run starts after it.
    expect(cursor.body.cursor[SOL_FEE]).toBe(FX.txs.ourPoolTrade.transaction.signatures[0]);
    expect(cursor.body.last_error).toBeNull();
  });

  it("writes the cursor only at the version it read", async () => {
    const db = fakeDb({ cursorRow: { source: "jupiter", cursor: {}, version: 7 } });
    await main({ env: ENV, fetchImpl: db.fetchImpl, call: fakeChain(), ...quiet });
    expect(db.calls.at(-1)).toMatchObject({ path: "fill_scoreboard_cursor?source=eq.jupiter&version=eq.7", method: "PATCH" });
    expect(db.calls.at(-1).body.version).toBe(8);
  });

  it("does not move the cursor when the rows were refused, and says so", async () => {
    const db = fakeDb({ cursorRow: { source: "jupiter", cursor: {}, version: 7 }, refuseRows: true });
    expect(await main({ env: ENV, fetchImpl: db.fetchImpl, call: fakeChain(), ...quiet })).toBe(1);
    const last = db.calls.at(-1);
    expect(last.path).toBe("fill_scoreboard_cursor?source=eq.jupiter");
    expect(Object.keys(last.body).sort()).toEqual(["last_error", "last_error_at"]);
  });

  it("writes nothing and passes while migration 029 is not applied", async () => {
    const db = fakeDb({ tableMissing: true });
    expect(await main({ env: ENV, fetchImpl: db.fetchImpl, call: fakeChain(), ...quiet })).toBe(0);
    expect(db.calls).toHaveLength(1);
  });

  it("fails without its secrets, and a dry run needs none and writes nothing", async () => {
    expect(await main({ env: {}, call: fakeChain(), ...quiet })).toBe(1);
    const lines = [];
    expect(await main({ env: {}, dryRun: true, call: fakeChain(), log: (l) => lines.push(l), error: () => {} })).toBe(0);
    expect(JSON.parse(lines[0])).toMatchObject({ trades: 2 });
  });

  it("readFills resumes each fee account from its own cursor", async () => {
    const got = await readFills(fakeChain(), { [SOL_FEE]: "already-read" });
    expect(got.rows).toEqual([]);
    expect(got.cursor[SOL_FEE]).toBe("already-read");
  });
});
