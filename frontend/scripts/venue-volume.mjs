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
  ISLAND_COINS,
  ISLAND_DECIMALS,
  SOLANA_BOTS,
  SOL_MINT,
  USDC_MINT,
  USDT_MINT,
  evmRpc,
  readEvmChain,
  readJupiter,
  readNftLoans,
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
  "nft-lending": (cursor, d) => readNftLoans(d.evm("ethereum"), cursor, d),
  "nft-orderbook": (cursor, d) => readOrderBookFills(d.db, cursor),
};

// Native ETH, or each chain's WETH: an order-book sale paid in either is ETH-priced.
const ETH_CURRENCIES = new Set([
  "0x0000000000000000000000000000000000000000",
  EVM_CHAINS.ethereum.weth.toLowerCase(),
  EVM_CHAINS.base.weth.toLowerCase(),
]);
const FILL_PAGE = 1000;

/**
 * Sales on our own NFT order book (native_orders, migration 002) since the cursor: each row
 * the order book marked filled, which it does only after reading the sale's OrderFulfilled
 * on chain (api/orderbook.js "fill"). The sale's price is the leg. The cursor is the last
 * fill time read and the orders filled at that very time, so a fill landing in the same
 * millisecond as the last one read is neither skipped nor counted twice. Buying an OpenSea
 * listing here is not on this book and leaves no mark on chain that says it was bought
 * here, so it is not counted.
 */
export async function readOrderBookFills(db, cursor) {
  if (!db) throw new Error("the order book needs the database");
  const countedTo = new Date().toISOString();
  let at = cursor?.at ?? null;
  let seen = new Set(cursor?.orders ?? []);
  const swaps = [];
  for (;;) {
    const where = at ? `filled_at=gte.${encodeURIComponent(at)}` : "filled_at=not.is.null";
    const r = await db(
      `native_orders?select=order_hash,price_wei,currency,filled_at,filled_by&status=eq.filled&${where}&order=filled_at.asc,order_hash.asc&limit=${FILL_PAGE}`,
    );
    if (r.status !== 200 || !Array.isArray(r.body)) throw new Error(`the order book could not be read (HTTP ${r.status})`);
    let fresh = 0;
    for (const row of r.body) {
      if (row.filled_at === at && seen.has(row.order_hash)) continue;
      fresh++;
      if (row.filled_at !== at) {
        at = row.filled_at;
        seen = new Set();
      }
      seen.add(row.order_hash);
      const raw = /^[0-9]+$/.test(String(row.price_wei ?? "")) ? BigInt(row.price_wei) : null;
      const eth = ETH_CURRENCIES.has(String(row.currency ?? "").toLowerCase());
      swaps.push({ leg: raw !== null && eth ? { mint: "WETH", raw } : null, payer: String(row.filled_by ?? ""), id: row.order_hash });
    }
    // A full page that was all seen before means more than a page filled in one millisecond.
    if (r.body.length === FILL_PAGE && fresh === 0) throw new Error(`more than ${FILL_PAGE} sales filled at ${at}`);
    if (r.body.length < FILL_PAGE) break;
  }
  // No sale yet: an empty cursor, never null (venue_volume.cursor is NOT NULL; a null made
  // Postgres refuse the first write, and the home page showed no volume, 2026-11-14).
  return { swaps, cursor: at ? { at, orders: [...seen] } : {}, countedTo };
}

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

const ISLAND_MINTS = new Set(ISLAND_COINS.map((c) => c.mint));

/**
 * The island coins' market prices from Jupiter (the keyed host when its server-only key is
 * set), one read for all five: `{ mint: usd | null }`, null for a coin Jupiter has no price
 * for. Throws when Jupiter cannot be read, so the source is counted on the next run instead.
 */
export async function islandPrices(fetchImpl, key = (process.env.JUPITER_API_KEY || "").trim()) {
  const ids = ISLAND_COINS.map((c) => c.mint).join(",");
  const hosts = key ? [["https://api.jup.ag", { "x-api-key": key }], ["https://lite-api.jup.ag", {}]] : [["https://lite-api.jup.ag", {}]];
  let last = "";
  for (const [host, headers] of hosts) {
    try {
      const r = await fetchImpl(`${host}/price/v3?ids=${ids}`, { headers: { Accept: "application/json", ...headers }, signal: AbortSignal.timeout(10_000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return Object.fromEntries(ISLAND_COINS.map((c) => [c.mint, Number(j?.[c.mint]?.usdPrice) > 0 ? Number(j[c.mint].usdPrice) : null]));
    } catch (e) {
      last = `${new URL(host).host} ${e?.message ?? e}`;
    }
  }
  throw new Error(`no island coin price could be read (${last})`);
}

/**
 * The dollars of one leg. USDC and USDT are dollars; SOL and WETH take today's price, an
 * island coin its market price (null when it has none).
 */
export function legUsd(leg, prices) {
  if (!leg) return null;
  if (leg.mint === USDC_MINT || leg.mint === USDT_MINT) return Number(leg.raw) / 1e6;
  if (leg.mint === SOL_MINT) return (Number(leg.raw) / 1e9) * prices.SOL;
  if (leg.mint === "WETH") return (Number(leg.raw) / 1e18) * prices.ETH;
  if (ISLAND_MINTS.has(leg.mint)) return prices[leg.mint] > 0 ? (Number(leg.raw) / 10 ** ISLAND_DECIMALS) * prices[leg.mint] : null;
  return null;
}

/** The price `priceOf` is asked for to value a leg: SOL, ETH or an island coin's mint. */
const priceKey = (leg) => (leg?.mint === SOL_MINT ? "SOL" : leg?.mint === "WETH" ? "ETH" : ISLAND_MINTS.has(leg?.mint) ? leg.mint : null);

/**
 * New totals for one source: its old row plus the new swaps, each valued once. `repriced`
 * are swaps already in the row with no dollars (readEvmChain): each one that now has a
 * price adds its dollars and leaves the unpriced count, and none is counted again.
 */
export async function addUp(row, swaps, priceOf, bots, repriced = []) {
  const prices = {};
  for (const s of [...swaps, ...repriced]) {
    const sym = priceKey(s.leg);
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
  let found = 0;
  for (const s of repriced) {
    const v = legUsd(s.leg, prices);
    if (v === null) continue;
    found++;
    usd += v;
    if (bots.has(s.payer)) botUsd += v;
  }
  // More than were counted with no dollars would be counting some twice.
  if (found > Number(row?.unpriced ?? 0)) throw new Error(`${found} swaps to reprice, but only ${Number(row?.unpriced ?? 0)} were counted with no dollars`);
  unpriced -= found;
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return { swaps: n, usd: round(usd), unpriced, bot_swaps: botSwaps, bot_usd: round(botUsd) };
}

function botsOf(source) {
  if (source === "solana-pools" || source === "jupiter") return SOLANA_BOTS;
  return EVM_CHAINS[source]?.bots ?? new Set();
}

function postgrest(env, fetchImpl) {
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

/**
 * One run's prices, each read at most once: SOL and ETH from two quotes, the island coins
 * from Jupiter in one read. `used` is what was read, for the dry run's log.
 */
function pricer(fetchImpl) {
  const used = {};
  let island = null;
  const priceOf = async (sym) => {
    if (sym in used) return used[sym];
    if (ISLAND_MINTS.has(sym)) {
      island ??= islandPrices(fetchImpl);
      used[sym] = (await island)[sym];
    } else {
      used[sym] = await spotPrice(sym, fetchImpl);
    }
    return used[sym];
  };
  priceOf.used = used;
  return priceOf;
}

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
  const d = { ...(deps ?? defaultDeps(fetchImpl)), db };
  const priceOf = pricer(fetchImpl);

  let failed = 0;
  for (const source of sources) {
    const row = rows.get(source) ?? null;
    try {
      const got = await readers[source](row?.cursor ?? null, { ...d, deadline: Date.now() + budgetMs });
      const totals = await addUp(row, got.swaps, priceOf, botsOf(source), got.repriced);
      if (got.repriced?.length) log(`${source}: ${got.repriced.length} swap(s) counted earlier with no dollars now priced`);
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
  const priceOf = pricer(fetchImpl);
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
  log(`prices used: ${JSON.stringify(priceOf.used)}`);
  return failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main({ dryRun: process.argv.includes("--dry-run") });
}
