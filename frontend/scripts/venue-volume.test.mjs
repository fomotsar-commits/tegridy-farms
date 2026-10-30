// venue-volume.mjs and its chain readers: what .github/workflows/venue-volume.yml runs hourly.
// The classifiers are checked against real mainnet transactions (fixtures/venue-volume,
// recorded 2026-10-19) and the figures of that day's hand read; the cursor and write
// rules against fakes. Each `it` names the broken reader it would catch.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  EVM_CHAINS,
  JUPITER_FEE_ACCOUNTS,
  SOL_MINT,
  USDC_MINT,
  VENUE_PROGRAM,
  blockscoutLogs,
  evmRpc,
  decodePool,
  evmSwapLeg,
  jupiterSwap,
  poolSwap,
  readEvmChain,
  readSolanaPools,
  base58,
  unbase58,
} from "./lib/venue-volume-chain.mjs";
import { addUp, legUsd, main, spotPrice } from "./venue-volume.mjs";
import { VOLUME_SOURCES, summarize } from "../api/_lib/venueVolumePolicy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, "fixtures", "venue-volume", "mainnet.json"), "utf-8"));
// Test runs of V2 builds (2026-10-23), shaped as transactions: no V2 swap of ours was on chain yet.
const V2 = JSON.parse(readFileSync(join(HERE, "fixtures", "venue-volume", "v2-simulation.json"), "utf-8"));
const [WSOL_FEE, USDC_FEE] = JUPITER_FEE_ACCOUNTS;
const BAYLA = "7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump";
const SOL_BAYLA = decodePool("ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4", FX.pool_solBayla);
const BAYLA_USDC = decodePool("J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm", FX.pool_baylaUsdc);

describe("our pools: a swap is one vault up and the other down", () => {
  it("reads the pool layout (vaults at 72/104, mints at 168/200, decimals at 331/332)", () => {
    expect(SOL_BAYLA.mint0).toBe(SOL_MINT);
    expect(SOL_BAYLA.mint1).toBe(BAYLA);
    expect([SOL_BAYLA.decimals0, SOL_BAYLA.decimals1]).toEqual([9, 6]);
    expect(BAYLA_USDC.mint1).toBe(USDC_MINT);
  });

  it("values a SOL-in swap on its SOL leg (0.01 SOL in, 2026-10-08)", () => {
    const hit = poolSwap(FX.poolSolIn, SOL_BAYLA);
    expect(hit.leg).toEqual({ mint: SOL_MINT, raw: 10_000_000n });
    expect(hit.payer).toBe("Upmhw8i6RSLXoj4yGzq9ZYLXb4UzZMRm7BSX8BxCdEd");
  });

  it("values a BAYLA-in swap on the SOL it took out (0.12536479 SOL, 2026-10-18)", () => {
    const hit = poolSwap(FX.poolBaylaIn, SOL_BAYLA);
    expect(hit.leg).toEqual({ mint: SOL_MINT, raw: 125_364_790n });
    expect(hit.payer).toBe("CzacL7gUCr4HYz6a2TGJjnmAR3Uxc65WEkKy6rU8w5bf");
  });

  it("values a USDC pool's swap on USDC (20 USDC in, 2026-10-16)", () => {
    expect(poolSwap(FX.poolUsdcIn, BAYLA_USDC).leg).toEqual({ mint: USDC_MINT, raw: 20_000_000n });
  });

  it("does not count a deposit, or another pool's transaction", () => {
    expect(poolSwap(FX.poolDeposit, SOL_BAYLA)).toBeNull();
    expect(poolSwap(FX.poolUsdcIn, SOL_BAYLA)).toBeNull();
  });
});

describe("Jupiter: the swap's own SOL or USDC leg, from Jupiter's events", () => {
  it("fee taken from a SOL input: the full input, 0.07 SOL (fee added back)", () => {
    expect(jupiterSwap(FX.jupSolInFeeIn, WSOL_FEE).leg).toEqual({ mint: SOL_MINT, raw: 70_000_000n });
  });

  it("fee taken from a USDC input: the full input, 6.167447 USDC", () => {
    expect(jupiterSwap(FX.jupUsdcToSolFeeIn, USDC_FEE).leg).toEqual({ mint: USDC_MINT, raw: 6_167_447n });
  });

  it("fee taken from the SOL output: the SOL out before the fee", () => {
    expect(jupiterSwap(FX.jupBaylaToSolFeeOut, WSOL_FEE).leg).toEqual({ mint: SOL_MINT, raw: 322_277_263n });
  });

  it("SOL to USDC values on USDC, the dollars themselves", () => {
    expect(jupiterSwap(FX.jupSolToUsdcFeeOut, USDC_FEE).leg).toEqual({ mint: USDC_MINT, raw: 26_298_941n });
  });

  it("counts a swap only under the fee account its fee went to", () => {
    expect(jupiterSwap(FX.jupSolInFeeIn, USDC_FEE)).toBeNull();
  });

  it("leaves a Jupiter route through our own pool to the pool reader, so it counts once", () => {
    const viaOurPool = structuredClone(FX.jupSolInFeeIn);
    viaOurPool.transaction.message.accountKeys.push(VENUE_PROGRAM);
    expect(jupiterSwap(viaOurPool, WSOL_FEE)).toBeNull();
  });

  it("does not count a pool-opening fee (no Jupiter, our program)", () => {
    expect(FX.poolOpeningFee.transaction.message.accountKeys).toContain(VENUE_PROGRAM);
    expect(jupiterSwap(FX.poolOpeningFee, WSOL_FEE)).toBeNull();
  });

  it("refuses a fee with no SwapEvent instead of counting it as nothing", () => {
    const stripped = structuredClone(FX.jupSolInFeeIn);
    for (const g of stripped.meta.innerInstructions) {
      g.instructions = g.instructions.filter((ix) => !ix.data || jupiterKind(ix.data) !== "swap");
    }
    expect(() => jupiterSwap(stripped, WSOL_FEE)).toThrow(/no SwapEvent/);
  });
});

describe("Jupiter V2 builds: one SwapsEvent, no FeeEvent, the fee read from the fee account", () => {
  it("SOL to BAYLA, fee taken from the SOL input: the full 0.097 SOL", () => {
    expect(jupiterSwap(V2.v2SolToBaylaFeeIn, WSOL_FEE).leg).toEqual({ mint: SOL_MINT, raw: 97_000_000n });
  });

  it("USDC to BAYLA through SOL, two hops, fee taken from the USDC input: the full 10 USDC", () => {
    expect(jupiterSwap(V2.v2UsdcToBaylaFeeIn, USDC_FEE).leg).toEqual({ mint: USDC_MINT, raw: 10_000_000n });
  });

  it("BAYLA to SOL, fee taken from the SOL output: the SOL out before the fee", () => {
    expect(jupiterSwap(V2.v2BaylaToSolFeeOut, WSOL_FEE).leg).toEqual({ mint: SOL_MINT, raw: 368_788_466n });
  });

  it("counts a V2 swap only under the fee account that grew", () => {
    expect(jupiterSwap(V2.v2SolToBaylaFeeIn, USDC_FEE)).toBeNull();
  });

  it("refuses a SwapsEvent cut short instead of counting fewer hops", () => {
    const cut = structuredClone(V2.v2UsdcToBaylaFeeIn);
    for (const g of cut.meta.innerInstructions) {
      for (const ix of g.instructions) {
        if (typeof ix.data !== "string" || ix.programId !== "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4") continue;
        const d = unbase58(ix.data);
        if (d.subarray(8, 16).toString("hex") === "982f4eebc0606e6a") ix.data = base58(d.subarray(0, d.length - 1));
      }
    }
    expect(() => jupiterSwap(cut, USDC_FEE)).toThrow(/shorter than its 2 hops/);
  });
});

function jupiterKind(data) {
  const d = unbase58(data);
  return d.subarray(8, 16).toString("hex") === "40c6cde8260871e2" ? "swap" : "other";
}

describe("Ethereum pair: the WETH leg of each Swap log", () => {
  it("adds up to the hand read: 29 swaps, 0.47798520913451736 WETH, 4 by the bot", () => {
    const pair = EVM_CHAINS.ethereum;
    let wei = 0n;
    let bot = 0;
    for (const log of FX.evmLogs) {
      const { raw, sender } = evmSwapLeg(log, 1);
      wei += raw;
      if (pair.bots.has(sender)) bot++;
    }
    expect(FX.evmLogs).toHaveLength(29);
    expect(wei).toBe(477_985_209_134_517_365n);
    expect(bot).toBe(4);
  });

  it("has no WETH leg on a pair without WETH", () => {
    expect(evmSwapLeg(FX.evmLogs[0], null).raw).toBeNull();
  });
});

// A fake Solana RPC over the fixtures: one pool with three transactions.
function fakeSolana(sigs, txs) {
  const calls = [];
  const call = async (method, params) => {
    calls.push([method, params]);
    if (method === "getProgramAccounts") return [{ pubkey: SOL_BAYLA.address, account: { data: [FX.pool_solBayla, "base64"] } }];
    if (method === "getSignaturesForAddress") {
      const until = params[1].until;
      const newestFirst = [...sigs].reverse();
      const cut = until ? newestFirst.findIndex((s) => s.signature === until) : -1;
      return cut >= 0 ? newestFirst.slice(0, cut) : newestFirst;
    }
    if (method === "getTransaction") return txs[params[0]] ?? null;
    throw new Error(method);
  };
  return { call, calls };
}

describe("the Solana cursor: each run reads only what is new", () => {
  const sigs = [
    { signature: "a", err: null },
    { signature: "b", err: null },
    { signature: "c", err: { InstructionError: [0, "x"] } },
  ];
  const txs = { a: FX.poolDeposit, b: FX.poolSolIn };

  it("counts the swap once across two runs, starting the second at the first's last signature", async () => {
    const f = fakeSolana(sigs, txs);
    const first = await readSolanaPools(f.call, {});
    expect(first.swaps).toHaveLength(1);
    expect(first.cursor[SOL_BAYLA.address]).toBe("c");
    const second = await readSolanaPools(f.call, first.cursor);
    expect(second.swaps).toHaveLength(0);
    const lastList = f.calls.filter(([m]) => m === "getSignaturesForAddress").at(-1);
    expect(lastList[1][1].until).toBe("c");
  });

  it("throws when a transaction does not come back, so the cursor is not moved past it", async () => {
    const f = fakeSolana(sigs, { a: FX.poolDeposit });
    await expect(readSolanaPools(f.call, {})).rejects.toThrow(/did not come back/);
  });
});

describe("the EVM cursor: finalized blocks, each read once, in windows", () => {
  const PAIR = "0x55875887b43c2e23ae424af0fc8606fdb058a481";
  const WETH = EVM_CHAINS.ethereum.weth.toLowerCase();
  function fakeEvm({ head, pairs }) {
    const ranges = [];
    const call = async (method, params) => {
      if (method === "eth_getBlockByNumber") return { number: "0x" + head.toString(16), timestamp: "0x6a000000" };
      if (method === "eth_getLogs") {
        const from = Number(params[0].fromBlock);
        const to = Number(params[0].toBlock);
        ranges.push([from, to]);
        return FX.evmLogs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
      }
      const data = params[0].data;
      if (data === "0x574f2ba3") return "0x" + pairs.toString(16).padStart(64, "0");
      if (data.startsWith("0x1e3dd18b")) return "0x" + PAIR.slice(2).padStart(64, "0");
      if (data === "0x0dfe1681") return "0x" + "420698cfdeddea6bc78d59bc17798113ad278f9d".padStart(64, "0");
      if (data === "0xd21220a7") return "0x" + WETH.slice(2).padStart(64, "0");
      throw new Error(data);
    };
    return { call, ranges };
  }

  it("reads from the start block to the finalized head with no gap and no overlap, then from head + 1", async () => {
    const head = 26_227_630;
    const f = fakeEvm({ head, pairs: 1 });
    const first = await readEvmChain(f.call, EVM_CHAINS.ethereum, null);
    expect(first.swaps).toHaveLength(29);
    expect(first.cursor).toEqual({ block: head, pairs: [{ address: PAIR, wethSide: 1 }] });
    expect(f.ranges[0][0]).toBe(EVM_CHAINS.ethereum.startBlock);
    for (let i = 1; i < f.ranges.length; i++) expect(f.ranges[i][0]).toBe(f.ranges[i - 1][1] + 1);
    expect(f.ranges.at(-1)[1]).toBe(head);
    expect(Math.max(...f.ranges.map(([a, b]) => b - a + 1))).toBeLessThanOrEqual(5000);

    const g = fakeEvm({ head: head + 10, pairs: 1 });
    const second = await readEvmChain(g.call, EVM_CHAINS.ethereum, first.cursor);
    expect(g.ranges).toEqual([[head + 1, head + 10]]);
    expect(second.swaps).toHaveLength(0);
  });

  it("with no pairs, reads no logs and moves to the head", async () => {
    const f = fakeEvm({ head: 900, pairs: 0 });
    const r = await readEvmChain(f.call, EVM_CHAINS.base, null);
    expect(f.ranges).toEqual([]);
    expect(r.cursor).toEqual({ block: 900, pairs: [] });
  });
});

// The first live run (2026-10-22): Blockscout was 9 blocks behind the finalized head, and
// Base's first pair had no start block. An RPC here refuses what `refuses(from, to)` says.
describe("old ranges: Blockscout up to what it has indexed, else smaller RPC windows", () => {
  const PAIR = "0x55875887b43c2e23ae424af0fc8606fdb058a481";
  const lastLog = Math.max(...FX.evmLogs.map((l) => Number(l.blockNumber)));
  const inRange = (from, to) => FX.evmLogs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
  function rpc({ head, refuses, weth = EVM_CHAINS.ethereum.weth }) {
    const ranges = [];
    const call = async (method, params) => {
      if (method === "eth_getBlockByNumber") return { number: "0x" + head.toString(16), timestamp: "0x6a000000" };
      if (method === "eth_getLogs") {
        const from = Number(params[0].fromBlock);
        const to = Number(params[0].toBlock);
        if (refuses(from, to)) throw new Error("refused");
        ranges.push([from, to]);
        return inRange(from, to);
      }
      const data = params[0].data;
      if (data === "0x574f2ba3") return "0x" + "1".padStart(64, "0");
      if (data.startsWith("0x1e3dd18b")) return "0x" + PAIR.slice(2).padStart(64, "0");
      if (data === "0x0dfe1681") return "0x" + "420698cfdeddea6bc78d59bc17798113ad278f9d".padStart(64, "0");
      return "0x" + weth.slice(2).toLowerCase().padStart(64, "0");
    };
    return { call, ranges };
  }
  const blockscout = (indexed) => {
    const asked = [];
    const fetchImpl = async (url) => {
      if (url.includes("/api/v2/")) return new Response(JSON.stringify([{ height: indexed }]));
      const u = new URL(url);
      const from = Number(u.searchParams.get("fromBlock"));
      const to = Number(u.searchParams.get("toBlock"));
      asked.push([from, to]);
      const result = inRange(from, to);
      return new Response(JSON.stringify(result.length ? { status: "1", message: "OK", result } : { status: "0", message: "No logs found", result: [] }));
    };
    return { fetchImpl, asked };
  };

  it("reads Blockscout only up to the block it has indexed, and the newest blocks from the RPC", async () => {
    const head = lastLog + 50;
    const f = rpc({ head, refuses: (from) => from < head - 20_000 });
    const bs = blockscout(head - 9);
    const r = await readEvmChain(f.call, EVM_CHAINS.ethereum, null, { fetchImpl: bs.fetchImpl });
    expect(r.swaps).toHaveLength(29);
    expect(new Set(r.swaps.map((s) => s.id)).size).toBe(29);
    expect(bs.asked).toEqual([[EVM_CHAINS.ethereum.startBlock, head - 9]]);
    expect(f.ranges).toEqual([[head - 8, head]]);
    expect(r.cursor.block).toBe(head);
  });

  it("without Blockscout, shrinks the window to 100 blocks instead of giving up", async () => {
    const head = lastLog + 50;
    const from = head - 999;
    const f = rpc({ head, refuses: (a, b) => b - a + 1 > 100 });
    const down = async () => new Response("<html>Just a moment...</html>", { status: 403 });
    const r = await readEvmChain(f.call, EVM_CHAINS.ethereum, { block: from - 1, pairs: [{ address: PAIR, wethSide: 1 }] }, { fetchImpl: down });
    expect(r.swaps).toHaveLength(inRange(from, head).length);
    expect(r.swaps.length).toBeGreaterThan(0);
    expect(f.ranges[0][0]).toBe(from);
    expect(f.ranges.at(-1)[1]).toBe(head);
    expect(Math.max(...f.ranges.map(([a, b]) => b - a + 1))).toBe(100);
  });

  it("starts Base at the block its first pair was created", async () => {
    const f = rpc({ head: 52_884_800, refuses: () => false, weth: EVM_CHAINS.base.weth });
    const r = await readEvmChain(f.call, EVM_CHAINS.base, null, { fetchImpl: async () => new Response("", { status: 403 }) });
    expect(f.ranges[0][0]).toBe(52_884_793);
    expect(r.cursor.pairs).toEqual([{ address: PAIR, wethSide: 1 }]);
  });
});

// GitHub's runners, 2026-10-22: Base's backfill (about 450 windows of 100 blocks) got HTTP 429
// partway through, every run, and a run that stopped saved nothing, so it never caught up.
describe("a backfill that is throttled partway keeps what it read and resumes", () => {
  const PAIR = "0x55875887b43c2e23ae424af0fc8606fdb058a481";
  const lastLog = Math.max(...FX.evmLogs.map((l) => Number(l.blockNumber)));
  const inRange = (from, to) => FX.evmLogs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
  const cursorAt = (block) => ({ block, pairs: [{ address: PAIR, wethSide: 1 }] });
  function rpc({ head, refuses }) {
    const ranges = [];
    const call = async (method, params) => {
      if (method === "eth_getBlockByNumber") return { number: "0x" + head.toString(16), timestamp: "0x6a000000" };
      if (method === "eth_getLogs") {
        const from = Number(params[0].fromBlock);
        const to = Number(params[0].toBlock);
        if (refuses(from, to)) throw new Error("eth_getLogs: https://mainnet.base.org HTTP 429");
        ranges.push([from, to]);
        return inRange(from, to);
      }
      return "0x" + "1".padStart(64, "0");
    };
    return { call, ranges };
  }
  const noBlockscout = async () => new Response("", { status: 403 });

  it("returns the swaps it read and a cursor at the last block read, with no countedTo", async () => {
    const head = lastLog + 50;
    const start = head - 999;
    const throttledFrom = head - 499;
    const f = rpc({ head, refuses: (a, b) => b - a + 1 > 100 || b >= throttledFrom });
    const r = await readEvmChain(f.call, EVM_CHAINS.ethereum, cursorAt(start - 1), { fetchImpl: noBlockscout });
    expect(r.incomplete).toMatch(/429/);
    expect(r.countedTo).toBeNull();
    expect(r.cursor.block).toBe(throttledFrom - 1);
    expect(r.swaps).toHaveLength(inRange(start, throttledFrom - 1).length);

    const g = rpc({ head, refuses: (a, b) => b - a + 1 > 100 });
    const next = await readEvmChain(g.call, EVM_CHAINS.ethereum, r.cursor, { fetchImpl: noBlockscout });
    expect(g.ranges[0][0]).toBe(throttledFrom);
    expect(next.incomplete).toBeUndefined();
    expect(next.cursor.block).toBe(head);
    expect(r.swaps.length + next.swaps.length).toBe(inRange(start, head).length);
  });

  it("stops when the run's time is up, and says so", async () => {
    const head = lastLog + 50;
    const f = rpc({ head, refuses: (a, b) => b - a + 1 > 100 });
    let clock = 0;
    const r = await readEvmChain(f.call, EVM_CHAINS.ethereum, cursorAt(head - 1000), {
      fetchImpl: noBlockscout,
      deadline: 3,
      now: () => clock++,
    });
    expect(r.incomplete).toMatch(/out of time/);
    expect(r.cursor.block).toBe(f.ranges.at(-1)[1]);
    expect(r.cursor.block).toBeLessThan(head);
  });

  it("saves a partial first read, and the source still counts as never counted", async () => {
    const db = fakeDb();
    const readers = { base: async () => ({ swaps: oneUsdcSwap, cursor: { block: 9, pairs: [] }, countedTo: null, incomplete: "HTTP 429" }) };
    expect(await main({ env, fetchImpl: db.fetchImpl, deps: {}, sources: ["base"], readers, ...quiet })).toBe(1);
    const row = db.rows.get("base");
    expect(row).toMatchObject({ swaps: 1, usd: 3, cursor: { block: 9, pairs: [] }, counted_to: null, last_ok_at: null });
    expect(row.last_error).toMatch(/resumes next run/);
    const others = VOLUME_SOURCES.filter((x) => x !== "base").map((source) => ({
      source, swaps: 1, usd: 1, counted_to: "2026-10-22T05:00:00Z", last_ok_at: "2026-10-22T05:00:00Z",
    }));
    expect(summarize([...others, row], Date.parse("2026-10-22T05:10:00Z"))).toEqual({ state: "unread" });
  });

  it("after the first full count, a partial read keeps when it was last complete", async () => {
    const db = fakeDb([{ source: "base", swaps: 5, usd: 50, cursor: { block: 1, pairs: [] }, counted_to: "2026-10-22T04:00:00Z", last_ok_at: "2026-10-22T04:05:00Z", version: 3 }]);
    const readers = { base: async () => ({ swaps: oneUsdcSwap, cursor: { block: 7, pairs: [] }, countedTo: null, incomplete: "HTTP 429" }) };
    await main({ env, fetchImpl: db.fetchImpl, deps: {}, sources: ["base"], readers, ...quiet });
    expect(db.rows.get("base")).toMatchObject({ swaps: 6, cursor: { block: 7 }, counted_to: "2026-10-22T04:00:00Z", last_ok_at: "2026-10-22T04:05:00Z", version: 4 });
  });
});

describe("the EVM RPC: patient with a rate limit, quick with a refusal", () => {
  const ok = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }));
  it("waits longer after a 429 than the old 2, 4 and 6 seconds, then succeeds", async () => {
    let n = 0;
    const waits = [];
    const fetchImpl = async () => (++n <= 2 ? new Response("Too Many Requests", { status: 429 }) : ok());
    const call = evmRpc({ fetchImpl, rpcs: ["https://a"], wait: async (ms) => waits.push(ms) });
    expect(await call("eth_blockNumber", [])).toBe("0x1");
    expect(waits).toEqual([5000, 15000]);
  });

  it("does not wait on a range every endpoint refuses", async () => {
    const waits = [];
    const refuse = async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 35, message: "ranges over 10000 blocks are not supported on free plan" } }), { status: 400 });
    const call = evmRpc({ fetchImpl: refuse, rpcs: ["https://a", "https://b"], wait: async (ms) => waits.push(ms) });
    await expect(call("eth_getLogs", [{}])).rejects.toThrow(/ranges over/);
    expect(waits).toEqual([]);
  });
});

describe("Blockscout, for ranges the RPCs no longer serve", () => {
  const PAIR = "0x55875887b43c2e23ae424af0fc8606fdb058a481";
  const answer = (indexed, logs) => async (url) =>
    new Response(JSON.stringify(url.includes("/api/v2/") ? [{ height: indexed }] : logs));

  it("takes its OK answer and its exact 'No logs found' answer", async () => {
    const ok = await blockscoutLogs("https://bs", PAIR, 1, 100, answer(200, { status: "1", message: "OK", result: FX.evmLogs }));
    expect(ok).toHaveLength(29);
    const none = await blockscoutLogs("https://bs", PAIR, 1, 100, answer(200, { status: "0", message: "No logs found", result: [] }));
    expect(none).toEqual([]);
  });

  it("refuses any other empty answer, so a rate limit never reads as no swaps", async () => {
    const limited = answer(200, { status: "0", message: "Too many requests", result: [] });
    await expect(blockscoutLogs("https://bs", PAIR, 1, 100, limited)).rejects.toThrow(/getLogs/);
  });

  it("refuses a range past the block it has indexed", async () => {
    const lagging = answer(99, { status: "0", message: "No logs found", result: [] });
    await expect(blockscoutLogs("https://bs", PAIR, 1, 100, lagging)).rejects.toThrow(/indexed to 99/);
  });
});

describe("valuation: once, at the price of the run that first sees the swap", () => {
  it("adds new swaps to the old totals without revaluing them", async () => {
    const row = { swaps: 5, usd: 100, unpriced: 0, bot_swaps: 1, bot_usd: 10 };
    const swaps = [
      { leg: { mint: SOL_MINT, raw: 500_000_000n }, payer: "bot" },
      { leg: { mint: USDC_MINT, raw: 2_500_000n }, payer: "x" },
      { leg: null, payer: "x" },
    ];
    const t = await addUp(row, swaps, async () => 200, new Set(["bot"]));
    expect(t).toEqual({ swaps: 8, usd: 202.5, unpriced: 1, bot_swaps: 2, bot_usd: 110 });
  });

  it("values WETH at the ETH price and USDC as dollars", () => {
    expect(legUsd({ mint: "WETH", raw: 10n ** 18n }, { ETH: 2400 })).toBe(2400);
    expect(legUsd({ mint: USDC_MINT, raw: 1_000_000n }, {})).toBe(1);
  });

  it("refuses two price quotes that disagree by more than 3%", async () => {
    const reply = (a, b) => async (url) =>
      new Response(JSON.stringify(url.includes("coinbase") ? { data: { amount: String(a) } } : { solana: { usd: b } }));
    await expect(spotPrice("SOL", reply(100, 110))).rejects.toThrow(/disagree/);
    await expect(spotPrice("SOL", reply(100, 101))).resolves.toBe(100);
  });
});

// A fake PostgREST that keeps rows by source and honours `version=eq.N`.
function fakeDb(initial = []) {
  const rows = new Map(initial.map((r) => [r.source, { ...r }]));
  const writes = [];
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? "GET";
    if (method === "GET") return new Response(JSON.stringify([...rows.values()]), { status: 200 });
    const body = JSON.parse(init.body);
    writes.push({ method, url: u.pathname + u.search, body });
    if (method === "POST") {
      if (rows.has(body.source)) return new Response("{}", { status: 409 });
      rows.set(body.source, body);
      return new Response(JSON.stringify([body]), { status: 201 });
    }
    const source = u.searchParams.get("source").replace("eq.", "");
    const version = u.searchParams.get("version");
    const row = rows.get(source);
    if (!row || (version && `eq.${row.version}` !== version)) return new Response("[]", { status: 200 });
    Object.assign(row, body);
    return new Response(JSON.stringify([row]), { status: 200 });
  });
  return { rows, writes, fetchImpl };
}
const env = { SUPABASE_URL: "https://db.test", SUPABASE_SERVICE_KEY: "service" };
const quiet = { log: () => {}, error: () => {} };
const reader = (swaps, cursor) => async () => ({ swaps, cursor, countedTo: "2026-10-19T16:00:00.000Z" });
const oneUsdcSwap = [{ leg: { mint: USDC_MINT, raw: 3_000_000n }, payer: "x" }];

describe("main: totals and cursor are written together, or not at all", () => {
  it("first run inserts each row with its totals, cursor and counted_to in one request", async () => {
    const db = fakeDb();
    const code = await main({ env, fetchImpl: db.fetchImpl, deps: {}, sources: ["jupiter"], readers: { jupiter: reader(oneUsdcSwap, { k: "sig" }) }, ...quiet });
    expect(code).toBe(0);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].body).toMatchObject({ source: "jupiter", swaps: 1, usd: 3, cursor: { k: "sig" }, counted_to: "2026-10-19T16:00:00.000Z", version: 1, last_error: null });
  });

  it("a later run writes only at the version it read, and bumps it", async () => {
    const db = fakeDb([{ source: "jupiter", swaps: 1, usd: 3, unpriced: 0, bot_swaps: 0, bot_usd: 0, cursor: { k: "sig" }, version: 4 }]);
    let seen;
    const readers = { jupiter: async (cursor) => ((seen = cursor), reader(oneUsdcSwap, { k: "sig2" })()) };
    expect(await main({ env, fetchImpl: db.fetchImpl, deps: {}, sources: ["jupiter"], readers, ...quiet })).toBe(0);
    expect(seen).toEqual({ k: "sig" });
    expect(db.writes[0].url).toContain("version=eq.4");
    expect(db.rows.get("jupiter")).toMatchObject({ swaps: 2, usd: 6, version: 5, cursor: { k: "sig2" } });
  });

  // Two counters run (Vercel every five minutes, GitHub hourly), so losing this race is
  // ordinary: the winner read the same swaps from the same cursor and counted them.
  it("writes nothing when another run moved the version first, and stays green with no error recorded", async () => {
    const db = fakeDb([{ source: "jupiter", swaps: 1, usd: 3, cursor: {}, version: 4 }]);
    const readers = {
      jupiter: async () => {
        db.rows.get("jupiter").version = 5; // a second run wrote meanwhile
        return reader(oneUsdcSwap, { k: "x" })();
      },
    };
    expect(await main({ env, fetchImpl: db.fetchImpl, deps: {}, sources: ["jupiter"], readers, ...quiet })).toBe(0);
    expect(db.rows.get("jupiter")).toMatchObject({ swaps: 1, usd: 3, version: 5 });
    expect(db.rows.get("jupiter").last_error_at).toBeUndefined();
    expect(db.writes).toHaveLength(1);
  });

  it("a write the database refuses for any other reason still goes red", async () => {
    const db = fakeDb([{ source: "jupiter", swaps: 1, usd: 3, cursor: {}, version: 4 }]);
    const inner = db.fetchImpl;
    const fetchImpl = vi.fn(async (url, init = {}) =>
      init.method === "PATCH" && String(url).includes("version=eq.") ? new Response("{}", { status: 401 }) : inner(url, init),
    );
    const readers = { jupiter: reader(oneUsdcSwap, { k: "x" }) };
    expect(await main({ env, fetchImpl, deps: {}, sources: ["jupiter"], readers, ...quiet })).toBe(1);
    expect(db.rows.get("jupiter")).toMatchObject({ swaps: 1, usd: 3 });
    expect(db.rows.get("jupiter").last_error_at).toBeTruthy();
  });

  it("gives each source the run's budget: a short one for the five-minute Vercel run", async () => {
    const db = fakeDb([]);
    let deadline;
    const readers = { jupiter: async (_c, d) => ((deadline = d.deadline), reader([], { k: "s" })()) };
    const before = Date.now();
    await main({ env, fetchImpl: db.fetchImpl, deps: {}, sources: ["jupiter"], readers, budgetMs: 20_000, ...quiet });
    expect(deadline - before).toBeGreaterThanOrEqual(20_000);
    expect(deadline - before).toBeLessThan(25_000);
  });

  it("a source that fails keeps its totals and cursor, records the error, and the rest still count", async () => {
    const db = fakeDb([{ source: "jupiter", swaps: 1, usd: 3, cursor: { k: "old" }, version: 2 }]);
    const readers = {
      jupiter: async () => {
        throw new Error("rpc down");
      },
      ethereum: reader([], { block: 9, pairs: [] }),
    };
    const code = await main({ env, fetchImpl: db.fetchImpl, deps: {}, sources: ["jupiter", "ethereum"], readers, ...quiet });
    expect(code).toBe(1);
    expect(db.rows.get("jupiter")).toMatchObject({ swaps: 1, usd: 3, cursor: { k: "old" }, version: 2, last_error: "rpc down" });
    expect(db.rows.get("ethereum")).toMatchObject({ swaps: 0, cursor: { block: 9, pairs: [] } });
  });

  it("before migration 028 it counts nothing and stays green; without secrets it is red", async () => {
    const missing = vi.fn(async () => new Response(JSON.stringify({ code: "PGRST205" }), { status: 404 }));
    expect(await main({ env, fetchImpl: missing, ...quiet })).toBe(0);
    expect(missing).toHaveBeenCalledTimes(1);
    expect(await main({ env: {}, fetchImpl: missing, ...quiet })).toBe(1);
  });
});

describe("pins", () => {
  it("Base reads through every keyless RPC that serves its old blocks", () => {
    expect(EVM_CHAINS.base.rpcs).toEqual(expect.arrayContaining(["https://base.drpc.org", "https://base.gateway.tenderly.co"]));
  });

  it("every venue address the reader uses is in scripts/addresses.json", () => {
    const registry = readFileSync(join(HERE, "addresses.json"), "utf-8").toLowerCase();
    const used = [VENUE_PROGRAM, ...JUPITER_FEE_ACCOUNTS, ...Object.values(EVM_CHAINS).map((c) => c.factory), EVM_CHAINS.ethereum.weth];
    for (const a of used) expect(registry, a).toContain(a.toLowerCase());
  });

  it("migration 028 allows exactly the sources the total is made of", () => {
    const sql = readFileSync(join(HERE, "..", "supabase", "migrations", "028_venue_volume.sql"), "utf-8");
    const list = sql.match(/source IN \(([^)]*)\)/)[1].match(/'([a-z-]+)'/g).map((s) => s.slice(1, -1));
    expect(list).toEqual([...VOLUME_SOURCES]);
  });
});
