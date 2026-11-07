/**
 * The arbitrage map (owner 2026-11-06: "figure out where all the hidden arb is… think like a big
 * brain"): every pool of the pair venues, read from the chain program by program and grouped by
 * coin, so the coins with two or more pools are found from the chain itself, not from a listing's
 * busiest page (where every gap is closed in under a second by bots faster than ours).
 *
 * A whole program in one read is refused for size (PumpSwap holds 630,000 pools), so each program
 * is read in 256 slices: the pools whose coin's address starts with each byte (a memcmp on one
 * byte), each answer holding only the front of every account (`dataSlice`), the part decodePool
 * reads. Padded back to the account's length, the scanner's own decoder (arb-chain.mjs) reads
 * them unchanged. The vault reads that follow go to a second host (plain account reads), so the
 * map never shares the robot's RPC limit.
 */
import bs58 from 'bs58';
import { COINS, DEXES, decodePool, tripsFor } from './arb-chain.mjs';

/**
 * The venues mapped: pair pools only (a band or bin pool's depth needs its ticks, and that is
 * where the false gaps came from). `prefix`: how much of the account decodePool reads; `at`:
 * where the coin's address sits, whose first byte picks the slice.
 */
export const MAPPED = Object.freeze({
  ours: { sizes: [637], prefix: 413, at: 168 },
  cpmm: { sizes: [637], prefix: 413, at: 168 },
  ammV4: { sizes: [752], prefix: 464, at: 400 },
  // 211-byte PumpSwap pools (before the coin creator field) are not decoded: 37,000 old ones, skipped.
  pumpswap: { sizes: [243, 261, 300], prefix: 261, at: 43 },
});

/** Every (venue, account size, first byte) slice, in the order they are read. */
export function slices() {
  const out = [];
  for (const [dex, m] of Object.entries(MAPPED)) for (const size of m.sizes) for (let byte = 0; byte < 256; byte++) out.push({ dex, size, byte });
  return out;
}

/** getProgramAccounts params for one slice: `dex`'s pools of `size` bytes whose coin's address starts with `byte`. */
export function sliceParams(dex, size, byte) {
  const m = MAPPED[dex];
  if (!m || !m.sizes.includes(size) || !(byte >= 0 && byte < 256)) throw new Error(`no slice ${dex}/${size}/${byte}`);
  return [
    DEXES[dex].program,
    { encoding: 'base64', commitment: 'confirmed', dataSlice: { offset: 0, length: Math.min(m.prefix, size) }, filters: [{ dataSize: size }, { memcmp: { offset: m.at, bytes: bs58.encode(Buffer.from([byte])) } }] },
  ];
}

/** One pool from a slice answer, decoded as the whole account would be (the rest zero), or null. */
export function poolFromSlice(dex, size, pubkey, base64) {
  const b = Buffer.alloc(size);
  Buffer.from(base64, 'base64').copy(b, 0);
  return decodePool(dex, pubkey, b);
}

/** The pool's coin and the coin it is priced in (SOL or USDC), or null when it is neither kind (SOL/USDC itself, or two tokens). */
export function sidesOf(pool) {
  const q = [pool.mintA, pool.mintB].filter((m) => COINS[m]);
  if (q.length !== 1) return null;
  return { coin: pool.mintA === q[0] ? pool.mintB : pool.mintA, quote: q[0] };
}

/** Coins with at least `least` pools that can trade, each with its pools. */
export function candidates(pools, least = 2) {
  const by = new Map();
  for (const p of pools) {
    if (p.stopped) continue;
    const s = sidesOf(p);
    if (!s) continue;
    const l = by.get(s.coin) ?? [];
    l.push(p);
    by.set(s.coin, l);
  }
  for (const [c, l] of by) if (l.length < least) by.delete(c);
  return by;
}

/** A pool's depth in USD, both sides at its price (twice the quote side), or null when unread. */
export function depthUsd(pool, depths, usd) {
  const s = sidesOf(pool);
  const d = depths.get(pool.address);
  const price = s && usd.get(s.quote);
  if (!s || !d || !(price > 0)) return null;
  return ((s.quote === pool.mintA ? d.a : d.b) / 10 ** COINS[s.quote].decimals) * price * 2;
}

/**
 * Each coin's best round trip among its pools, judged by the robot's own rule (tripsFor), best first
 * by what the open gap holds after the network fee (the gap closed at any size, not the robot's cap).
 * `ctx`: decimals (coin → its decimals), depths (pool → depthOf), usd (SOL, USDC), settings, bridge.
 */
export function rankCoins(byCoin, ctx) {
  const rows = [];
  for (const [coin, pools] of byCoin) {
    const decimals = ctx.decimals.get(coin);
    if (decimals === undefined || decimals === null) continue;
    const trips = tripsFor(pools, { token: coin, decimals, depths: ctx.depths, usd: ctx.usd, holds: undefined, quotes: new Map(), bridge: ctx.bridge ?? null, settings: ctx.settings });
    const best = trips[0];
    if (!best) continue;
    rows.push({
      mint: coin,
      decimals,
      pools: pools.map((p) => ({ address: p.address, dex: p.dex, fee: p.fee, depthUsd: depthUsd(p, ctx.depths, ctx.usd) })),
      buy: best.legs[0].pool,
      sell: best.legs[best.legs.length - 1].pool,
      gapPct: best.gapPct,
      costPct: best.costPct,
      gapInUsd: best.gapInUsd,
      gapNetUsd: best.gapNetUsd,
      inUsd: best.inUsd,
      netUsd: best.netUsd,
      pays: best.pays,
      why: best.why,
    });
  }
  return rows.sort((a, b) => b.gapNetUsd - a.gapNetUsd);
}

/** JSON that keeps a pool's 64-bit figures (owed fees, the PumpSwap adjustment) exact: `123n`. */
export const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : x));
export const fromJson = (s) => JSON.parse(s, (_, x) => (typeof x === 'string' && /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));
