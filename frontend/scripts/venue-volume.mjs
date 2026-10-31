#!/usr/bin/env node
// Add the swaps that are new since the last run to the venue's all-time volume.
//
// Run every five minutes by Vercel (api/venue-volume-count.js), and every hour by
// .github/workflows/venue-volume.yml as the backup, with SUPABASE_URL and
// SUPABASE_SERVICE_KEY. By hand, from the repo root, with those two set:
//   node frontend/scripts/venue-volume.mjs
// `--dry-run` needs no secrets: it counts every source from zero and writes nothing.
//
// One venue_volume row per source (migration 028) holds its totals and its cursor, written
// together in one request, so a run that fails leaves the row as it was and the next run
// reads the same swaps again. Each new swap is valued in dollars here, once, at the price
// of the run that first sees it, and never revalued. Exit 1 when any source did not finish.

import { pathToFileURL } from "node:url";
import { VOLUME_SOURCES } from "../api/_lib/venueVolumePolicy.js";
import {
  EVM_CHAINS,
  SOLANA_BOTS,
  SOL_MINT,
  USDC_MINT,
  evmRpc,
  readEvmChain,
  readJupiter,
  readSolanaPools,
  solanaRpc,
} from "./lib/venue-volume-chain.mjs";

const REQUIRED = ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"];

/** Each source's reader: (cursor, deps) => { swaps, cursor, countedTo }. */
export const READERS = {
  "solana-pools": (cursor, d) => readSolanaPools(d.solana, cursor ?? {}),
  jupiter: (cursor, d) => readJupiter(d.solana, cursor ?? {}),
  ethereum: (cursor, d) => readEvmChain(d.evm("ethereum"), EVM_CHAINS.ethereum, cursor, d),
  base: (cursor, d) => readEvmChain(d.evm("base"), EVM_CHAINS.base, cursor, d),
  robinhood: (cursor, d) => readEvmChain(d.evm("robinhood"), EVM_CHAINS.robinhood, cursor, d),
};

const PRICE_SOURCES = {
  SOL: [
    ["https://api.coinbase.com/v2/prices/SOL-USD/spot", (j) => j?.data?.amount],
    ["https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd", (j) => j?.solana?.usd],
  ],
  ETH: [
    ["https://api.coinbase.com/v2/prices/ETH-USD/spot", (j) => j?.data?.amount],
    ["https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd", (j) => j?.ethereum?.usd],
  ],
};

/**
 * Today's USD price of SOL or ETH from two keyless quotes. One answer is enough; two that
 * differ by more than 3% are refused, because a wrong price would be stored for good.
 */
export async function spotPrice(symbol, fetchImpl) {
  const quotes = [];
  for (const [url, pick] of PRICE_SOURCES[symbol]) {
    try {
      const r = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
      const v = Number(pick(r.ok ? await r.json() : null));
      if (Number.isFinite(v) && v > 0) quotes.push(v);
    } catch {
      // the other quote may still answer
    }
  }
  if (!quotes.length) throw new Error(`no ${symbol} price could be read`);
  if (quotes.length === 2 && Math.abs(quotes[0] - quotes[1]) / Math.min(...quotes) > 0.03) {
    throw new Error(`${symbol} quotes disagree: ${quotes.join(" vs ")}`);
  }
  return quotes[0];
}

/** The dollars of one leg. USDC is dollars; SOL and WETH take today's price. */
export function legUsd(leg, prices) {
  if (!leg) return null;
  if (leg.mint === USDC_MINT) return Number(leg.raw) / 1e6;
  if (leg.mint === SOL_MINT) return (Number(leg.raw) / 1e9) * prices.SOL;
  if (leg.mint === "WETH") return (Number(leg.raw) / 1e18) * prices.ETH;
  return null;
}

/** New totals for one source: its old row plus the new swaps, each valued once. */
export async function addUp(row, swaps, priceOf, bots) {
  const prices = {};
  for (const s of swaps) {
    const sym = s.leg?.mint === SOL_MINT ? "SOL" : s.leg?.mint === "WETH" ? "ETH" : null;
    if (sym && prices[sym] === undefined) prices[sym] = await priceOf(sym);
  }
  let usd = Number(row?.usd ?? 0);
  let botUsd = Number(row?.bot_usd ?? 0);
  let n = Number(row?.swaps ?? 0);
  let unpriced = Number(row?.unpriced ?? 0);
  let botSwaps = Number(row?.bot_swaps ?? 0);
  for (const s of swaps) {
    const v = legUsd(s.leg, prices);
    n++;
    if (v === null) unpriced++;
    else usd += v;
    if (bots.has(s.payer)) {
      botSwaps++;
      if (v !== null) botUsd += v;
    }
  }
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return { swaps: n, usd: round(usd), unpriced, bot_swaps: botSwaps, bot_usd: round(botUsd) };
}

function botsOf(source) {
  if (source === "solana-pools" || source === "jupiter") return SOLANA_BOTS;
  return EVM_CHAINS[source]?.bots ?? new Set();
}

export function postgrest(env, fetchImpl) {
  return async (path, init = {}) => {
    const r = await fetchImpl(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // a non-JSON answer is reported by its status below
    }
    return { status: r.status, body };
  };
}

/**
 * Write one source's new row. An existing row is replaced only at the version this run
 * read, so two runs at once cannot both add the same swaps; the loser is refused. A refusal
 * that matched no row is that lost race (`lostRace`): the other run read these swaps too.
 */
async function writeRow(db, row, next) {
  if (row) {
    const r = await db(`venue_volume?source=eq.${encodeURIComponent(row.source)}&version=eq.${row.version}`, {
      method: "PATCH",
      body: JSON.stringify({ ...next, version: row.version + 1 }),
    });
    if (r.status === 200 && Array.isArray(r.body) && r.body.length === 0) {
      throw Object.assign(new Error("another run counted first"), { lostRace: true });
    }
    if (r.status !== 200 || !Array.isArray(r.body) || r.body.length !== 1) {
      throw new Error(`write refused (HTTP ${r.status})`);
    }
    return;
  }
  const r = await db("venue_volume", { method: "POST", body: JSON.stringify({ ...next, version: 1 }) });
  if (r.status !== 201) throw new Error(`first write refused (HTTP ${r.status})`);
}

// Each source stops reading after this long and saves what it read, so a long backfill
// spreads over hourly runs instead of hitting the job's 30-minute timeout. The Vercel run
// passes a shorter `budgetMs` (api/venue-volume-count.js).
const SOURCE_BUDGET_MS = 8 * 60 * 1000;

function defaultDeps(fetchImpl) {
  return {
    solana: solanaRpc({ fetchImpl }),
    evm: (name) => evmRpc({ fetchImpl, rpcs: EVM_CHAINS[name].rpcs, pauseMs: 200 }),
    fetchImpl,
  };
}

export async function main({
  env = process.env,
  fetchImpl = globalThis.fetch,
  deps = null,
  sources = VOLUME_SOURCES,
  readers = READERS,
  log = console.log,
  error = console.error,
  dryRun = false,
  budgetMs = SOURCE_BUDGET_MS,
} = {}) {
  const missing = REQUIRED.filter((k) => !env[k]);
  if (dryRun) return dryRunAll({ fetchImpl, deps, sources, readers, log, error });
  if (missing.length) {
    error(`::error title=Volume counter not configured::Missing repo secrets: ${missing.join(" ")}. Nothing was counted.`);
    return 1;
  }
  const db = postgrest(env, fetchImpl);
  const read = await db("venue_volume?select=*").catch((e) => ({ status: 0, body: { message: e.message } }));
  if (read.status === 404 || read.body?.code === "PGRST205" || read.body?.code === "42P01") {
    log("::notice title=venue_volume does not exist yet::Migration 028 has not been applied, so there is nowhere to count into.");
    return 0;
  }
  if (read.status !== 200 || !Array.isArray(read.body)) {
    error(`::error title=Volume counter could not read its table::HTTP ${read.status}. Nothing was counted.`);
    return 1;
  }
  const rows = new Map(read.body.map((r) => [r.source, r]));
  const d = deps ?? defaultDeps(fetchImpl);
  const priceCache = {};
  const priceOf = async (sym) => (priceCache[sym] ??= await spotPrice(sym, fetchImpl));

  let failed = 0;
  for (const source of sources) {
    const row = rows.get(source) ?? null;
    try {
      const got = await readers[source](row?.cursor ?? null, { ...d, deadline: Date.now() + budgetMs });
      const totals = await addUp(row, got.swaps, priceOf, botsOf(source));
      const now = new Date().toISOString();
      if (got.incomplete) {
        // Keep what was read and resume from it next run; the source stays as counted as it
        // was (never, on a first backfill), so the site shows no figure for a partial read.
        const msg = `partly read, resumes next run: ${got.incomplete}`.slice(0, 300);
        await writeRow(db, row, {
          source,
          ...totals,
          cursor: got.cursor,
          counted_to: row?.counted_to ?? null,
          last_ok_at: row?.last_ok_at ?? null,
          last_error: msg,
          last_error_at: now,
        });
        failed++;
        error(`::error title=Volume source ${source} not finished::+${got.swaps.length} swap(s) saved; ${msg}`);
        continue;
      }
      await writeRow(db, row, {
        source,
        ...totals,
        cursor: got.cursor,
        counted_to: got.countedTo,
        last_ok_at: now,
        last_error: null,
      });
      log(`${source}: +${got.swaps.length} swap(s), now ${totals.swaps} swaps, $${totals.usd.toFixed(2)}`);
    } catch (e) {
      if (e?.lostRace) {
        // The other counter (Vercel every five minutes, this job hourly) wrote first, from
        // the same cursor: these swaps are counted, once. Nothing failed, so nothing is red.
        log(`${source}: another run counted first; nothing written`);
        continue;
      }
      failed++;
      const msg = String(e?.message ?? e).slice(0, 300);
      error(`::error title=Volume source ${source} not counted::${msg}`);
      if (row) {
        // Only the error columns: the totals and cursor stay as the last good run left them.
        await db(`venue_volume?source=eq.${encodeURIComponent(source)}`, {
          method: "PATCH",
          body: JSON.stringify({ last_error: msg, last_error_at: new Date().toISOString() }),
        }).catch(() => {});
      }
    }
  }
  return failed ? 1 : 0;
}

async function dryRunAll({ fetchImpl, deps, sources, readers, log, error }) {
  const d = deps ?? defaultDeps(fetchImpl);
  const priceCache = {};
  const priceOf = async (sym) => (priceCache[sym] ??= await spotPrice(sym, fetchImpl));
  let failed = 0;
  for (const source of sources) {
    try {
      const got = await readers[source](null, { ...d, deadline: Date.now() + SOURCE_BUDGET_MS });
      const t = await addUp(null, got.swaps, priceOf, botsOf(source));
      log(`${source}: ${t.swaps} swaps, $${t.usd.toFixed(2)} (bots ${t.bot_swaps} / $${t.bot_usd.toFixed(2)}, unpriced ${t.unpriced}) to ${got.countedTo}`);
      if (got.incomplete) {
        failed++;
        error(`${source}: stopped at block ${got.cursor.block}: ${got.incomplete}`);
      }
    } catch (e) {
      failed++;
      error(`${source}: not counted: ${e?.message ?? e}`);
    }
  }
  log(`prices used: ${JSON.stringify(priceCache)}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main({ dryRun: process.argv.includes("--dry-run") });
}
