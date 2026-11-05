/**
 * The arbitrage scanner's maths (scripts/arb-scanner.mjs, owner 2026-11-05: "a proper scanner
 * where you can actively see all of the arb across robinhood and solana tokens").
 *
 * Every pool GeckoTerminal lists among a chain's busiest is grouped by the token it trades. For
 * each token, every two pools are weighed as a round trip: buy where it is cheap, sell where it is
 * dear, after both pools' fees, and sized where it pays most.
 *
 * ESTIMATES, NOT QUOTES. Prices are GeckoTerminal's listed prices: seconds to minutes old, and
 * older for a pool nobody traded lately. Depth is each pool's listed reserve treated as x·y = k; a
 * concentrated pool is deeper than that near its price, so the size and profit err small. A row
 * is only real once a quote for each leg confirms it.
 */

/** The coins each chain prices everything in. A pool of two of them is compared as that pair. */
export const CHAINS = Object.freeze({
  solana: {
    network: 'solana',
    name: 'Solana',
    refs: {
      So11111111111111111111111111111111111111112: 'SOL',
      EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
      Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
    },
  },
  robinhood: {
    network: 'robinhood',
    name: 'Robinhood Chain',
    refs: {
      '0x0bd7d308f8e1639fab988df18a8011f41eacad73': 'WETH',
      '0x5fc5360d0400a0fd4f2af552add042d716f1d168': 'USDG',
    },
  },
});

/** A pool's fee when its listed name does not carry one (Uniswap v4's can change; Orca's is not named). */
export const ASSUMED_FEE = 0.003;
/** A trip whose two pools price the token in different coins also swaps between those coins. */
export const SWITCH_COST = 0.001;
/** Pools shallower than this are left out: their listed price moves with any trade. */
export const MIN_RESERVE_USD = 1_000;

const ADDRESS = /^(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/;

/** The fee in a pool's listed name ("USDG / WETH 0.01%"), as a fraction; null when it names none. */
export function feeOf(name) {
  const m = /(\d+(?:\.\d+)?)%\s*$/.exec(String(name));
  if (!m) return null;
  const fee = Number(m[1]) / 100;
  return fee >= 0 && fee < 0.2 ? fee : null;
}

/** The ticker on one side of a listed name, as the pool lists it (untrusted). */
function sideName(name, side) {
  const parts = String(name).replace(/\s+\d+(?:\.\d+)?%\s*$/, '').split(' / ');
  return (parts[side] ?? '?').trim().slice(0, 24) || '?';
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One GeckoTerminal pool, or null when it lacks a figure the scanner needs. */
export function parsePool(raw, network) {
  const a = raw?.attributes;
  const r = raw?.relationships;
  if (!a || !r) return null;
  const id = (rel) => String(rel?.data?.id ?? '').replace(`${network}_`, '');
  const base = id(r.base_token);
  const quote = id(r.quote_token);
  const address = String(a.address ?? '');
  if (![base, quote, address].every((x) => ADDRESS.test(x))) return null;
  const pool = {
    address,
    dex: String(r.dex?.data?.id ?? '?').replace(/[^\w.-]/g, '').slice(0, 40),
    name: String(a.name ?? ''),
    base,
    quote,
    baseSymbol: sideName(a.name, 0),
    quoteSymbol: sideName(a.name, 1),
    baseUsd: num(a.base_token_price_usd),
    quoteUsd: num(a.quote_token_price_usd),
    baseInQuote: num(a.base_token_price_quote_token),
    reserveUsd: num(a.reserve_in_usd),
    volume24Usd: num(a.volume_usd?.h24) ?? 0,
    tradesHour: (num(a.transactions?.h1?.buys) ?? 0) + (num(a.transactions?.h1?.sells) ?? 0),
  };
  const fee = feeOf(pool.name);
  pool.fee = fee ?? ASSUMED_FEE;
  pool.feeKnown = fee !== null;
  if (!(pool.baseUsd > 0 && pool.quoteUsd > 0 && pool.baseInQuote > 0 && pool.reserveUsd > 0)) return null;
  return pool;
}

/** An address as a map key: EVM addresses in any case are one address; Solana's are case-exact. */
export const addrKey = (a) => (String(a).startsWith('0x') ? String(a).toLowerCase() : String(a));

/**
 * One DexScreener pair in the same shape. DexScreener names no fee: it is taken from `fees`
 * (addrKey → fee, read off GeckoTerminal's names) when known, and assumed otherwise.
 */
export function parseDexPair(raw, fees = new Map()) {
  const address = String(raw?.pairAddress ?? '');
  const base = String(raw?.baseToken?.address ?? '');
  const quote = String(raw?.quoteToken?.address ?? '');
  if (![base, quote, address].every((x) => ADDRESS.test(x))) return null;
  const ticker = (t) => String(t?.symbol ?? '?').trim().slice(0, 24) || '?';
  const baseInQuote = num(raw.priceNative);
  const baseUsd = num(raw.priceUsd);
  const fee = fees.get(addrKey(address)) ?? null;
  const pool = {
    address,
    dex: [raw.dexId, ...(Array.isArray(raw.labels) ? raw.labels.slice(0, 1) : [])].map((x) => String(x ?? '').replace(/[^\w.-]/g, '').slice(0, 30)).filter(Boolean).join('-') || '?',
    name: `${ticker(raw.baseToken)} / ${ticker(raw.quoteToken)}`,
    base,
    quote,
    baseSymbol: ticker(raw.baseToken),
    quoteSymbol: ticker(raw.quoteToken),
    baseUsd,
    quoteUsd: baseUsd && baseInQuote ? baseUsd / baseInQuote : null,
    baseInQuote,
    reserveUsd: num(raw.liquidity?.usd),
    volume24Usd: num(raw.volume?.h24) ?? 0,
    tradesHour: (num(raw.txns?.h1?.buys) ?? 0) + (num(raw.txns?.h1?.sells) ?? 0),
    fee: fee ?? ASSUMED_FEE,
    feeKnown: fee !== null,
  };
  if (!(pool.baseUsd > 0 && pool.quoteUsd > 0 && pool.baseInQuote > 0 && pool.reserveUsd > 0)) return null;
  return pool;
}

const sameAddress = (a, b) => addrKey(a) === addrKey(b);
const refOf = (refs, addr) => Object.keys(refs).find((r) => sameAddress(r, addr)) ?? null;

/**
 * Where a pool sits in the comparison: the token it trades and its price there. A pool of a
 * token against one of the chain's coins prices the token in USD, so pools in different coins
 * compare. A pool of two of the chain's coins, or of two other tokens, compares as that pair.
 */
export function placeOf(pool, refs) {
  const baseRef = refOf(refs, pool.base);
  const quoteRef = refOf(refs, pool.quote);
  if (!baseRef !== !quoteRef) {
    const tokenIsBase = !baseRef;
    return {
      key: `token:${tokenIsBase ? pool.base : pool.quote}`,
      token: tokenIsBase ? pool.base : pool.quote,
      label: tokenIsBase ? pool.baseSymbol : pool.quoteSymbol,
      price: tokenIsBase ? pool.baseUsd : pool.quoteUsd,
      unit: 'USD',
      coin: tokenIsBase ? pool.quote : pool.base,
    };
  }
  const [a, b] = [pool.base, pool.quote].sort();
  const aIsBase = a === pool.base;
  return {
    key: `pair:${a}/${b}`,
    token: a,
    label: `${aIsBase ? pool.baseSymbol : pool.quoteSymbol} / ${aIsBase ? pool.quoteSymbol : pool.baseSymbol}`,
    price: aIsBase ? pool.baseInQuote : 1 / pool.baseInQuote,
    unit: aIsBase ? pool.quoteSymbol : pool.baseSymbol,
    coin: b,
  };
}

/**
 * The best round trip from `cheap` to `dear`: buy the token in `cheap`, sell it in `dear`. Each
 * pool is x·y = k with half its listed reserve on each side, both sides counted at the cheap pool's
 * price; `extra` is charged on what comes back. Returns the size (USD in) that pays most, and what
 * it pays; the profit is 0 or less when no size pays.
 */
export function bestTrip(cheap, dear, extra = 0) {
  const q1 = cheap.reserveUsd / 2;
  const t1 = q1;
  const ratio = dear.price / cheap.price;
  const q2 = dear.reserveUsd / 2;
  const t2 = q2 / ratio;
  const back = (x) => {
    const xin = x * (1 - cheap.fee);
    const tokens = (t1 * xin) / (q1 + xin);
    const tin = tokens * (1 - dear.fee);
    return ((q2 * tin) / (t2 + tin)) * (1 - extra);
  };
  const profit = (x) => back(x) - x;
  // Profit is concave in the size: narrow in on its top.
  let lo = 0;
  let hi = Math.min(q1, q2);
  for (let i = 0; i < 100; i++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (profit(m1) < profit(m2)) lo = m1;
    else hi = m2;
  }
  const sizeUsd = (lo + hi) / 2;
  return { sizeUsd, profitUsd: profit(sizeUsd) };
}

/**
 * Every token traded in two or more of `pools`, with its best round trip, most profitable first.
 * Each row names both pools in full and how sure it is: a pool nobody traded in an hour may be
 * showing an old price; a gap over 50% is nearly always that or a token that cannot be sold.
 */
export function scan(pools, refs, opts = {}) {
  const minReserve = opts.minReserveUsd ?? MIN_RESERVE_USD;
  const groups = new Map();
  for (const pool of pools) {
    if (!(pool.reserveUsd >= minReserve)) continue;
    const place = placeOf(pool, refs);
    if (!(place.price > 0) || !Number.isFinite(place.price)) continue;
    const g = groups.get(place.key) ?? [];
    if (!g.some((x) => x.pool.address === pool.address)) g.push({ ...place, pool });
    groups.set(place.key, g);
  }
  const rows = [];
  for (const [key, g] of groups) {
    if (g.length < 2) continue;
    let best = null;
    for (const a of g) {
      for (const b of g) {
        if (a === b || !(b.price > a.price)) continue;
        const extra = sameAddress(a.coin, b.coin) ? 0 : SWITCH_COST;
        const trip = bestTrip({ price: a.price, fee: a.pool.fee, reserveUsd: a.pool.reserveUsd }, { price: b.price, fee: b.pool.fee, reserveUsd: b.pool.reserveUsd }, extra);
        if (!best || trip.profitUsd > best.trip.profitUsd) best = { buy: a, sell: b, extra, trip };
      }
    }
    if (!best) continue;
    const { buy, sell, extra, trip } = best;
    const gap = sell.price / buy.price - 1;
    rows.push({
      key,
      token: buy.token,
      label: buy.label,
      unit: buy.unit,
      pools: g.length,
      buy: leg(buy),
      sell: leg(sell),
      gapPct: gap * 100,
      costPct: (buy.pool.fee + sell.pool.fee + extra) * 100,
      sizeUsd: trip.profitUsd > 0 ? trip.sizeUsd : 0,
      profitUsd: Math.max(0, trip.profitUsd),
      quiet: buy.pool.tradesHour === 0 || sell.pool.tradesHour === 0,
      suspect: gap > 0.5,
      feeAssumed: !buy.pool.feeKnown || !sell.pool.feeKnown,
    });
  }
  // A ticker more than one token claims: say so beside each of them.
  const claims = new Map();
  for (const r of rows) {
    if (!r.key.startsWith('token:')) continue;
    const t = r.label.toLowerCase();
    claims.set(t, (claims.get(t) ?? 0) + 1);
  }
  for (const r of rows) r.sameTicker = r.key.startsWith('token:') ? (claims.get(r.label.toLowerCase()) ?? 1) - 1 : 0;
  return rows.sort((a, b) => b.profitUsd - a.profitUsd || b.gapPct - a.gapPct);
}

function leg(place) {
  const p = place.pool;
  return { pool: p.address, dex: p.dex, fee: p.fee, feeKnown: p.feeKnown, price: place.price, reserveUsd: p.reserveUsd, volume24Usd: p.volume24Usd, tradesHour: p.tradesHour, coin: place.coin };
}
