// venue-volume.mjs and its chain readers: what .github/workflows/venue-volume.yml runs hourly.
// The classifiers are checked against real mainnet transactions (fixtures/venue-volume,
// recorded 2026-10-19) and the figures of that day's hand read; the cursor and write
// rules against fakes. Each `it` names the broken reader it would catch.
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  EVM_CHAINS,
  ISLAND_COINS,
  JUPITER_FEE_ACCOUNTS,
  LOAN_EMITTED_TOPIC,
  NFT_LENDING,
  listPairs,
  loanEmitted,
  readNftLoans,
  SOLANA_BOTS,
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
  readJupiter,
  readSolanaPools,
  base58,
  unbase58,
} from "./lib/venue-volume-chain.mjs";
import { READERS, addUp, islandPrices, legUsd, main, readOrderBookFills, spotPrice } from "./venue-volume.mjs";
import { VOLUME_SOURCES, summarize } from "../api/_lib/venueVolumePolicy.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FX = JSON.parse(readFileSync(join(HERE, "fixtures", "venue-volume", "mainnet.json"), "utf-8"));
// Test runs of V2 builds (2026-10-23), shaped as transactions: no V2 swap of ours was on chain yet.
const V2 = JSON.parse(readFileSync(join(HERE, "fixtures", "venue-volume", "v2-simulation.json"), "utf-8"));
// Read 2026-11-10: a price keeper trip, and two swaps whose fee was paid in USDT.
const NOV = JSON.parse(readFileSync(join(HERE, "fixtures", "venue-volume", "mainnet-2026-11.json"), "utf-8"));
const [WSOL_FEE, USDC_FEE] = JUPITER_FEE_ACCOUNTS;
const USDT_FEE = "GT8LWC8xwwXGE9FatRyMDZccSYBqYNRMZkz2SCdgV6dj";
const USDT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const KEEPER = "9WAugU3g3YECwuEuoPy3NEH5Co475fHATGdjr2dy2Fcz";
// Each chain's factory that charges to open a pool: none of them had a pair when these were recorded.
const OPENING = new Set(Object.values(EVM_CHAINS).map((c) => c.factories[1].toLowerCase()));
const ETH_FACTORY = EVM_CHAINS.ethereum.factories[0].toLowerCase();
const TOWELI = "0x420698cfdeddea6bc78d59bc17798113ad278f9d";
// Read 2026-11-13: the first loan on NFT Lending, as its LoanEmitted log.
const LOANS = JSON.parse(readFileSync(join(HERE, "fixtures", "venue-volume", "gondi-loan-2026-11.json"), "utf-8"));
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

  // About $2.5k of the $34k shown on 2026-11-10 was the keeper's, counted as anyone's.
  it("counts the venue's own price keeper as a bot (its 0.055848246 SOL trip, 2026-11-09)", async () => {
    const pool = decodePool("3YRW6wJscukRaWutB6QgPwtK1EQM9KA7CXcXTtmN3GJK", NOV.pool_keeperCoin);
    const hit = poolSwap(NOV.keeperTrip, pool);
    expect(hit).toEqual({ leg: { mint: SOL_MINT, raw: 55_848_246n }, payer: KEEPER });
    const t = await addUp(null, [hit], async () => 100, SOLANA_BOTS);
    expect(t).toEqual({ swaps: 1, usd: 5.584825, unpriced: 0, bot_swaps: 1, bot_usd: 5.584825 });
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

// The site takes its fee in USDT since 2026-11-02 (#1105); the counter read only the WSOL and
// USDC accounts, so 9 swaps (about $625) by 2026-11-10 were never counted.
describe("Jupiter, fee paid in USDT: the vault's USDT account, USDT valued as dollars", () => {
  it("reads the vault's USDT fee account", () => {
    expect(JUPITER_FEE_ACCOUNTS).toContain(USDT_FEE);
  });

  it("fee taken from a USDT input: the full 20 USDT (2026-11-02)", () => {
    expect(jupiterSwap(NOV.jupUsdtInFeeIn, USDT_FEE).leg).toEqual({ mint: USDT, raw: 20_000_000n });
  });

  it("fee taken from the USDT output: the USDT out before the fee, 22.014648 (2026-11-08)", () => {
    expect(jupiterSwap(NOV.jupUsdtOutFeeOut, USDT_FEE).leg).toEqual({ mint: USDT, raw: 22_014_648n });
  });

  it("values USDT as dollars, like USDC", () => {
    expect(legUsd({ mint: USDT, raw: 1_000_000n }, {})).toBe(1);
  });

  it("reads a fee account the cursor has never seen from its first signature, the others from their cursor", async () => {
    const lists = {
      [WSOL_FEE]: ["w1"],
      [USDC_FEE]: ["c1"],
      [USDT_FEE]: ["u0", "u1", "u2"],
    };
    // u0 stands for the account's creation (2026-11-02): no swap, no fee.
    const created = { meta: { err: null, innerInstructions: [], preTokenBalances: [], postTokenBalances: [] }, transaction: { signatures: ["u0"], message: { accountKeys: [KEEPER, USDT_FEE] } } };
    const txs = { u0: created, u1: NOV.jupUsdtInFeeIn, u2: NOV.jupUsdtOutFeeOut };
    const asked = {};
    const call = async (method, params) => {
      if (method === "getSignaturesForAddress") {
        const [address, { until }] = params;
        asked[address] = until ?? null;
        const newestFirst = [...lists[address]].reverse().map((signature) => ({ signature, err: null }));
        const cut = until ? newestFirst.findIndex((s) => s.signature === until) : -1;
        return cut >= 0 ? newestFirst.slice(0, cut) : newestFirst;
      }
      if (method === "getTransaction") return txs[params[0]] ?? null;
      throw new Error(method);
    };
    const got = await readJupiter(call, { [WSOL_FEE]: "w1", [USDC_FEE]: "c1" });
    expect(asked).toEqual({ [WSOL_FEE]: "w1", [USDC_FEE]: "c1", [USDT_FEE]: null });
    expect(got.swaps.map((s) => [s.id, s.leg])).toEqual([
      ["u1", { mint: USDT, raw: 20_000_000n }],
      ["u2", { mint: USDT, raw: 22_014_648n }],
    ]);
    expect(got.cursor).toEqual({ [WSOL_FEE]: "w1", [USDC_FEE]: "c1", [USDT_FEE]: "u2" });
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
    if (method === "getTransaction") {
      const tx = txs[params[0]] ?? null;
      // Like a node: a transaction newer than the version asked for is refused, not returned.
      if (tx && typeof tx.version === "number" && !(tx.version <= params[1].maxSupportedTransactionVersion)) {
        throw new Error(`getTransaction: {"code":-32015,"message":"Transaction version (${tx.version}) is not supported by the requesting client."}`);
      }
      return tx;
    }
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

  it("reads a version 1 transaction (on mainnet in our pools since 2026-11-05) and counts its swap", async () => {
    const f = fakeSolana(sigs, { a: FX.poolDeposit, b: { ...FX.poolSolIn, version: 1 } });
    const got = await readSolanaPools(f.call, {});
    expect(got.swaps).toHaveLength(1);
    expect(got.cursor[SOL_BAYLA.address]).toBe("c");
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
      if (data === "0x574f2ba3") return "0x" + (OPENING.has(params[0].to.toLowerCase()) ? 0 : pairs).toString(16).padStart(64, "0");
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
    expect(first.cursor).toEqual({ block: head, pairs: [{ address: PAIR, factory: ETH_FACTORY, tokens: [TOWELI, WETH], wethSide: 1 }] });
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
      if (data === "0x574f2ba3") return "0x" + (OPENING.has(params[0].to.toLowerCase()) ? "0" : "1").padStart(64, "0");
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
    expect(r.cursor.pairs).toEqual([
      { address: PAIR, factory: EVM_CHAINS.base.factories[0].toLowerCase(), tokens: [TOWELI, EVM_CHAINS.base.weth.toLowerCase()], wethSide: 1 },
    ]);
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
    const used = [VENUE_PROGRAM, ...JUPITER_FEE_ACCOUNTS, ...Object.values(EVM_CHAINS).flatMap((c) => c.factories), EVM_CHAINS.ethereum.weth, NFT_LENDING.loan];
    for (const a of used) expect(registry, a).toContain(a.toLowerCase());
  });

  // The newest migration that sets the table's check decides which rows can be written.
  it("the newest migration that sets venue_volume_shape allows exactly the sources the total is made of", () => {
    const dir = join(HERE, "..", "supabase", "migrations");
    const newest = readdirSync(dir)
      .filter((f) => f.endsWith(".sql") && readFileSync(join(dir, f), "utf-8").includes("ADD CONSTRAINT venue_volume_shape"))
      .sort()
      .at(-1);
    expect(newest).toBe("031_venue_volume_nft_sources.sql");
    const sql = readFileSync(join(dir, newest), "utf-8");
    const list = sql.match(/source IN \(([^)]*)\)/)[1].match(/'([a-z-]+)'/g).map((s) => s.slice(1, -1));
    expect(list).toEqual([...VOLUME_SOURCES]);
  });
});

// 2026-11-13 audit: what the counter missed. Each `it` fails on the code before that day.
describe("every factory, every chain's WETH", () => {
  const PAIR = "0x55875887b43c2e23ae424af0fc8606fdb058a481";
  const evm = ({ head, made, tokens, logs = [] }) => {
    const calls = [];
    const call = async (method, params) => {
      calls.push([method, params[0]?.to ?? null, params[0]?.data ?? null]);
      if (method === "eth_getBlockByNumber") return { number: "0x" + head.toString(16), timestamp: "0x6a000000" };
      if (method === "eth_getLogs") {
        const from = Number(params[0].fromBlock);
        const to = Number(params[0].toBlock);
        return logs.filter((l) => params[0].address.includes(l.address) && Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
      }
      const { to, data } = params[0];
      const list = made[to.toLowerCase()] ?? [];
      if (data === "0x574f2ba3") return "0x" + list.length.toString(16).padStart(64, "0");
      if (data.startsWith("0x1e3dd18b")) return "0x" + list[Number("0x" + data.slice(10))].slice(2).padStart(64, "0");
      const t = tokens[to.toLowerCase()];
      if (t && data === "0x0dfe1681") return "0x" + t[0].slice(2).padStart(64, "0");
      if (t && data === "0xd21220a7") return "0x" + t[1].slice(2).padStart(64, "0");
      throw new Error("unexpected " + to + " " + data);
    };
    return { call, calls };
  };

  it("counts the swaps of a pair made by the factory that charges to open a pool", async () => {
    const [first, opening] = EVM_CHAINS.ethereum.factories.map((f) => f.toLowerCase());
    const WETH = EVM_CHAINS.ethereum.weth.toLowerCase();
    const head = 26_227_630;
    const f = evm({ head, made: { [first]: [], [opening]: [PAIR] }, tokens: { [PAIR]: [TOWELI, WETH] }, logs: FX.evmLogs });
    const r = await readEvmChain(f.call, EVM_CHAINS.ethereum, { block: 25_263_331, pairs: [] });
    expect(r.swaps).toHaveLength(29);
    expect(r.swaps.every((s) => s.leg?.mint === "WETH")).toBe(true);
    expect(r.cursor.pairs).toEqual([{ address: PAIR, factory: opening, tokens: [TOWELI, WETH], wethSide: 1 }]);
  });

  // Robinhood's WETH was unset: its WETH/DODO pair was saved with no WETH side, and its 381
  // swaps (0.49 WETH by 2026-11-13) were counted with no dollars.
  it("reads a saved pair with no WETH side again, so Robinhood's WETH/DODO swaps carry their WETH", async () => {
    const RH_PAIR = "0xfa04b2bbc847a322efaa3551bfc07b18f394c067";
    const DODO = "0x384b028739f8b2c5d187bca0bbe20bd04d72f00d";
    const WETH = EVM_CHAINS.robinhood.weth.toLowerCase();
    const [first] = EVM_CHAINS.robinhood.factories.map((x) => x.toLowerCase());
    const swap = { ...FX.evmLogs[0], address: RH_PAIR, blockNumber: "0x" + (113_000_001).toString(16) };
    const f = evm({ head: 113_000_010, made: { [first]: [RH_PAIR] }, tokens: { [RH_PAIR]: [WETH, DODO] }, logs: [swap] });
    const r = await readEvmChain(f.call, EVM_CHAINS.robinhood, { block: 113_000_000, pairs: [{ address: RH_PAIR, wethSide: null }] });
    expect(r.cursor.pairs).toEqual([{ address: RH_PAIR, factory: first, tokens: [WETH, DODO], wethSide: 0 }]);
    expect(r.swaps).toHaveLength(1);
    const raw = evmSwapLeg(swap, 0).raw;
    expect(raw > 0n).toBe(true);
    expect(r.swaps[0].leg).toEqual({ mint: "WETH", raw });
  });

  it("never reads a saved pair's coins again once its WETH side is known", async () => {
    const [first] = EVM_CHAINS.ethereum.factories.map((x) => x.toLowerCase());
    const f = evm({ head: 1, made: { [first]: [PAIR] }, tokens: {} });
    const pairs = await listPairs(f.call, EVM_CHAINS.ethereum, [{ address: PAIR, wethSide: 1 }]);
    expect(pairs).toEqual([{ address: PAIR, factory: first, wethSide: 1 }]);
    expect(f.calls.filter(([, to]) => to === PAIR)).toEqual([]);
  });
});

describe("NFT Lending: each new loan's WETH", () => {
  const head = 26_400_000;
  const loanCall = (logs) => {
    const ranges = [];
    const call = async (method, params) => {
      if (method === "eth_getBlockByNumber") return { number: "0x" + head.toString(16), timestamp: "0x6a000000" };
      if (method === "eth_getLogs") {
        const from = Number(params[0].fromBlock);
        const to = Number(params[0].toBlock);
        ranges.push([from, to, params[0].address, params[0].topics]);
        return logs.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
      }
      throw new Error(method);
    };
    return { call, ranges };
  };

  it("names LoanEmitted by the topic of the ABI the site uses", async () => {
    const { toEventSelector } = await import("viem");
    const mod = await import("../src/lib/gondi/abi.js");
    const abi = Object.values(mod).find(Array.isArray);
    const event = abi.find((e) => e.type === "event" && e.name === "LoanEmitted");
    expect(LOAN_EMITTED_TOPIC).toBe(toEventSelector(event));
    expect(event.inputs.some((i) => i.indexed)).toBe(false);
  });

  it("reads the first real loan: its borrower, WETH and 0.0174 principal", () => {
    expect(loanEmitted(LOANS.logs[0])).toEqual({
      borrower: "0xb88fdc6d47d9a19ba068c78fd5477f64cff283dc",
      coin: EVM_CHAINS.ethereum.weth.toLowerCase(),
      principal: 17_400_000_000_000_000n,
    });
  });

  it("counts each loan from the loan contract's birth block, then reads on from the head", async () => {
    const f = loanCall(LOANS.logs);
    const first = await readNftLoans(f.call, null);
    expect(f.ranges[0][0]).toBe(NFT_LENDING.startBlock);
    expect(f.ranges.every(([, , address, topics]) => address[0] === NFT_LENDING.loan.toLowerCase() && topics[0] === LOAN_EMITTED_TOPIC)).toBe(true);
    const log = LOANS.logs[0];
    expect(first.swaps).toEqual([{ leg: { mint: "WETH", raw: 17_400_000_000_000_000n }, payer: "0xb88fdc6d47d9a19ba068c78fd5477f64cff283dc", id: log.transactionHash + ":" + log.logIndex }]);
    expect(first.cursor).toEqual({ block: head });
    const totals = await addUp(null, first.swaps, async () => 2000, new Set());
    expect(totals).toMatchObject({ swaps: 1, usd: 34.8, unpriced: 0 });

    const g = loanCall(LOANS.logs);
    const second = await readNftLoans(g.call, first.cursor);
    expect(second.swaps).toEqual([]);
  });

  it("is a source of the total, read through Ethereum's RPCs", async () => {
    const f = loanCall(LOANS.logs);
    const got = await READERS["nft-lending"](null, { evm: (name) => (name === "ethereum" ? f.call : null) });
    expect(got.swaps).toHaveLength(1);
    expect(VOLUME_SOURCES).toContain("nft-lending");
  });
});

describe("island coins: a swap with no SOL, USDC or USDT leg is valued on its island coin", () => {
  const BRAINLET = ISLAND_COINS.find((c) => c.symbol === "BRAINLET").mint;
  const SOY = ISLAND_COINS.find((c) => c.symbol === "SOY").mint;
  const balance = (accountIndex, amount) => ({ accountIndex, uiTokenAmount: { amount: String(amount) } });
  // A BRAINLET/SOY pool (7JZ4Qnjh…, 15 transactions by 2026-11-13): 2 SOY in, 30 BRAINLET out.
  const tx = {
    meta: { err: null, preTokenBalances: [balance(1, 100_000_000), balance(2, 100_000_000)], postTokenBalances: [balance(1, 70_000_000), balance(2, 102_000_000)] },
    transaction: { message: { accountKeys: ["trader", "v0", "v1"] } },
  };

  it("names the same island coins as the pool index, in its order", async () => {
    const { QUOTE_COINS } = await import("../api/_lib/pool-index.js");
    expect(ISLAND_COINS.map((c) => c.mint)).toEqual(QUOTE_COINS.slice(2).map((c) => c.mint));
  });

  it("gives an island-coin pool's swap its higher-ranked coin as the leg, at that coin's market price", async () => {
    const hit = poolSwap(tx, { vault0: "v0", vault1: "v1", mint0: BRAINLET, mint1: SOY });
    expect(hit).toEqual({ leg: { mint: SOY, raw: 2_000_000n }, payer: "trader" });
    const asked = [];
    const totals = await addUp(null, [hit], async (sym) => (asked.push(sym), 0.5), new Set());
    expect(asked).toEqual([SOY]);
    expect(totals).toMatchObject({ swaps: 1, usd: 1, unpriced: 0 });
    expect(legUsd(hit.leg, { [SOY]: null })).toBeNull();
  });

  it("reads all five prices from Jupiter at once, the keyed host first when its key is set", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      seen.push([new URL(url).host, init.headers["x-api-key"] ?? null]);
      if (new URL(url).host === "api.jup.ag") return new Response("busy", { status: 429 });
      return new Response(JSON.stringify({ [SOY]: { usdPrice: 0.0002 } }));
    };
    const prices = await islandPrices(fetchImpl, "k");
    expect(seen).toEqual([["api.jup.ag", "k"], ["lite-api.jup.ag", null]]);
    expect(prices[SOY]).toBe(0.0002);
    expect(prices[BRAINLET]).toBeNull();
    await expect(islandPrices(async () => new Response("", { status: 503 }), "")).rejects.toThrow(/no island coin price/);
  });
});

describe("the NFT order book: each sale it marked filled, at its price", () => {
  const ETH0 = "0x0000000000000000000000000000000000000000";
  const fill = (hash, at, wei, currency = ETH0) => ({ order_hash: hash, price_wei: String(wei), currency, filled_at: at, filled_by: "0xbuyer" });
  const book = (rows) => {
    const asked = [];
    const db = async (path) => {
      asked.push(path);
      const u = new URL("https://db.test/rest/v1/" + path);
      const filter = u.searchParams.get("filled_at");
      const gte = filter?.startsWith("gte.") ? filter.slice(4) : null;
      const limit = Number(u.searchParams.get("limit"));
      const order = (a, b) => (a.filled_at < b.filled_at ? -1 : a.filled_at > b.filled_at ? 1 : a.order_hash < b.order_hash ? -1 : 1);
      const out = rows.filter((r) => !gte || r.filled_at >= gte).sort(order);
      return { status: 200, body: out.slice(0, limit) };
    };
    return { db, asked };
  };
  const T1 = "2026-11-12T10:00:00.123+00:00";
  const T2 = "2026-11-12T11:00:00+00:00";

  it("counts each filled sale once, ETH or WETH on Ethereum or Base, and a sale in another coin with no dollars", async () => {
    const b = book([
      fill("0xa", T1, 10n ** 17n),
      fill("0xb", T1, 2n * 10n ** 17n, EVM_CHAINS.base.weth),
      fill("0xc", T2, 5_000_000n, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
    ]);
    const r = await readOrderBookFills(b.db, null);
    expect(b.asked[0]).toContain("status=eq.filled");
    expect(r.swaps.map((s) => s.leg)).toEqual([{ mint: "WETH", raw: 10n ** 17n }, { mint: "WETH", raw: 2n * 10n ** 17n }, null]);
    expect(r.cursor).toEqual({ at: T2, orders: ["0xc"] });
    const totals = await addUp(null, r.swaps, async () => 2000, new Set());
    expect(totals).toMatchObject({ swaps: 3, usd: 600, unpriced: 1 });
  });

  it("reads on from the cursor: a sale filled in the same millisecond as the last one read is counted, the last one is not", async () => {
    const b = book([fill("0xa", T1, 1n), fill("0xb", T1, 2n), fill("0xc", T1, 3n)]);
    const r = await readOrderBookFills(b.db, { at: T1, orders: ["0xa", "0xb"] });
    expect(r.swaps.map((s) => s.id)).toEqual(["0xc"]);
    expect(r.cursor).toEqual({ at: T1, orders: ["0xa", "0xb", "0xc"] });
    const again = await readOrderBookFills(b.db, r.cursor);
    expect(again.swaps).toEqual([]);
  });

  it("refuses to count when the order book cannot be read, so nothing is skipped", async () => {
    await expect(readOrderBookFills(async () => ({ status: 503, body: null }), null)).rejects.toThrow(/could not be read/);
    await expect(readOrderBookFills(undefined, null)).rejects.toThrow(/needs the database/);
  });

  it("is handed the counter's own database by main", async () => {
    const db = fakeDb();
    let got = null;
    const readers = { "nft-orderbook": async (cursor, d) => ((got = d.db), reader([], null)()) };
    expect(await main({ env, fetchImpl: db.fetchImpl, deps: {}, sources: ["nft-orderbook"], readers, ...quiet })).toBe(0);
    expect(typeof got).toBe("function");
    expect(db.rows.get("nft-orderbook")).toMatchObject({ swaps: 0, usd: 0, version: 1 });
  });
});

// Robinhood's 381 swaps up to 2026-11-13 were counted with no dollars. They are priced once,
// in the write that saves the pair's WETH side, and never counted again.
describe("swaps counted with no dollars are priced once when their pair's WETH side is found", () => {
  const RH_PAIR = "0xfa04b2bbc847a322efaa3551bfc07b18f394c067";
  const DODO = "0x384b028739f8b2c5d187bca0bbe20bd04d72f00d";
  const WETH = EVM_CHAINS.robinhood.weth.toLowerCase();
  const FIRST = EVM_CHAINS.robinhood.factories[0].toLowerCase();
  const at = (n, i) => ({ ...FX.evmLogs[i], address: RH_PAIR, blockNumber: "0x" + n.toString(16), logIndex: "0x" + i.toString(16) });
  const OLD = [at(109_405_200, 0), at(110_000_000, 1)];
  const NEW = [at(113_000_005, 2)];
  const rh = () => {
    const ranges = [];
    const call = async (method, params) => {
      if (method === "eth_getBlockByNumber") return { number: "0x" + (113_000_010).toString(16), timestamp: "0x6a000000" };
      if (method === "eth_getLogs") {
        const from = Number(params[0].fromBlock);
        const to = Number(params[0].toBlock);
        ranges.push([from, to]);
        return [...OLD, ...NEW].filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to);
      }
      const { to, data } = params[0];
      if (data === "0x574f2ba3") return "0x" + (to.toLowerCase() === FIRST ? 1 : 0).toString(16).padStart(64, "0");
      if (data.startsWith("0x1e3dd18b")) return "0x" + RH_PAIR.slice(2).padStart(64, "0");
      if (data === "0x0dfe1681") return "0x" + WETH.slice(2).padStart(64, "0");
      if (data === "0xd21220a7") return "0x" + DODO.slice(2).padStart(64, "0");
      throw new Error(data);
    };
    return { call, ranges };
  };
  const savedCursor = { block: 113_000_000, pairs: [{ address: RH_PAIR, wethSide: null }] };

  it("reads the pair's old swaps from its birth to the cursor once, beside the new ones", async () => {
    const f = rh();
    const r = await readEvmChain(f.call, EVM_CHAINS.robinhood, savedCursor);
    expect(f.ranges[0][0]).toBe(EVM_CHAINS.robinhood.startBlock);
    expect(r.repriced.map((s) => s.id)).toEqual(OLD.map((l) => `${l.transactionHash}:${l.logIndex}`));
    expect(r.repriced.every((s) => s.leg?.mint === "WETH" && s.leg.raw > 0n)).toBe(true);
    expect(r.swaps.map((s) => s.id)).toEqual(NEW.map((l) => `${l.transactionHash}:${l.logIndex}`));
    // The saved pair now names its coins, so the next run reprices nothing.
    const again = await readEvmChain(rh().call, EVM_CHAINS.robinhood, r.cursor);
    expect(again.repriced).toBeUndefined();
  });

  it("adds their dollars and takes them off the unpriced count, without counting them as new swaps", async () => {
    const row = { swaps: 381, usd: 0, unpriced: 381, bot_swaps: 0, bot_usd: 0 };
    const repriced = [{ leg: { mint: "WETH", raw: 10n ** 17n }, payer: "x" }, { leg: { mint: "WETH", raw: 2n * 10n ** 17n }, payer: "x" }];
    const totals = await addUp(row, [{ leg: { mint: "WETH", raw: 10n ** 16n }, payer: "y" }], async () => 2000, new Set(), repriced);
    expect(totals).toEqual({ swaps: 382, usd: 620, unpriced: 379, bot_swaps: 0, bot_usd: 0 });
    await expect(addUp({ ...row, unpriced: 1 }, [], async () => 2000, new Set(), repriced)).rejects.toThrow(/only 1 were counted with no dollars/);
  });

  it("writes the repriced dollars in the same write as the cursor that ends the repricing", async () => {
    const db = fakeDb([{ source: "robinhood", swaps: 2, usd: 0, unpriced: 2, bot_swaps: 0, bot_usd: 0, cursor: savedCursor, version: 7 }]);
    const deps = { evm: () => rh().call };
    const quotes = async (url) => new Response(JSON.stringify(url.includes("coinbase") ? { data: { amount: "2000" } } : { ethereum: { usd: 2000 } }));
    const fetchImpl = async (url, init) => (new URL(String(url)).host === "db.test" ? db.fetchImpl(url, init) : quotes(String(url)));
    expect(await main({ env, fetchImpl, deps, sources: ["robinhood"], ...quiet })).toBe(0);
    const written = db.rows.get("robinhood");
    expect(written).toMatchObject({ swaps: 3, unpriced: 0, version: 8 });
    expect(written.usd).toBeGreaterThan(0);
    expect(written.cursor.pairs[0]).toMatchObject({ address: RH_PAIR, wethSide: 0, tokens: [WETH, DODO] });
  });
});
