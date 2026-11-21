// @vitest-environment node
// The fixture report (BUILD-SPEC 3.4.6): S, L and F for both collections as OpenSea and the chain
// stood on 2026-11-15 at about 21:30 UTC, and how many 90-day sales each tape filter dropped. The
// insider set is the EXAMPLE list in __fixtures__/insiders-example.json. Each pinned number is also
// re-derived here a simpler way, so a change that moves one has to be explained, not re-pinned.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { normalizeListing, normalizeSale } from './opensea.mjs';
import { buildTape, dropCounts } from './tape.mjs';
import { fairValue } from './fairValue.mjs';

const fx = (name) => JSON.parse(readFileSync(fileURLToPath(new URL(`../__fixtures__/${name}`, import.meta.url)), 'utf8'));
const insiders = fx('insiders-example.json');
const insiderSet = new Set([...insiders.wallets.map((w) => w.address), ...insiders.contracts].map((a) => a.toLowerCase()));

function day(slug) {
  const book = fx(`opensea-listings-${slug}.json`);
  const now = Date.parse(book.read_utc);
  const rawSales = fx(`opensea-sales-${slug}.json`).asset_events;
  const tape = buildTape(rawSales.map((e) => normalizeSale(e, 'fixture')), { houseWallets: [], insiderWallets: insiders, now });
  const listings = book.listings.map((l) => normalizeListing(l, 'fixture'));
  const fillable = new Map(Object.entries(fx(`listings-fillable-${slug}.json`).fillable));
  return { book, now, rawSales, tape, listings, fillable, fv: fairValue({ tape, listings, fillable, now }) };
}

/** L the plain way: each seller's cheapest fillable listing at least 30 minutes old, third cheapest. */
function plainL({ book, fillable, now }) {
  const t = Math.floor(now / 1000);
  const best = new Map();
  for (const l of book.listings) {
    const p = l.protocol_data.parameters;
    if (!fillable.get(l.order_hash)?.fillable || t - Math.max(Number(p.startTime), l.order_created_at) < 1800 || Number(p.endTime) <= t) continue;
    const price = BigInt(l.price.current.value);
    const cur = best.get(p.offerer);
    if (cur === undefined || price < cur) best.set(p.offerer, price);
  }
  return [...best.values()].sort((a, b) => (a < b ? -1 : 1))[2] ?? null;
}

describe('fixture report: Jungle Bay Ape Club, 2026-11-15 21:30 UTC', () => {
  const d = day('junglebay');

  it('drops 42 of 184 sales, all as tails of a market that fell from ~0.09 to ~0.03 ETH', () => {
    expect(d.rawSales).toHaveLength(184);
    expect(d.tape.kept).toHaveLength(142);
    expect(dropCounts(d.tape)).toEqual({ currency: 0, house: 0, insider: 0, 'self-trade': 0, 'round-trip-30d': 0, 'tail-low': 27, 'tail-high': 15 });
    expect(d.rawSales.filter((e) => insiderSet.has(e.seller) || insiderSet.has(e.buyer))).toHaveLength(0);
    expect(d.rawSales.filter((e) => e.seller === e.buyer)).toHaveLength(0);
  });

  it('prices S = 0.032781 ETH from 46 sales by 22 sellers; L = 0.0739; F = S', () => {
    expect(d.fv).toMatchObject({ n: 46, sellers: 22, method: 'vwap', S: 32780648391559672n, L: 73900000000000000n, F: 32780648391559672n, reason: null });
    expect(d.fv.L).toBe(plainL(d));
    // S is an average of real prices: inside the window's range.
    const t = Math.floor(d.now / 1000);
    const win = d.tape.kept.filter((s) => s.time > t - 14 * 86_400).map((s) => s.priceWei);
    expect(d.fv.S > win.reduce((a, b) => (a < b ? a : b))).toBe(true);
    expect(d.fv.S < win.reduce((a, b) => (a > b ? a : b))).toBe(true);
  });

  it('puts the arbitrage line at the cheapest listing anyone could buy, 0.049976, and the breaker floor at L', () => {
    expect(d.fv.cheapestFillable).toBe(49976000000000000n);
    expect(d.fv.cheapestFillable).toBe(d.listings.reduce((m, l) => (l.priceWei < m ? l.priceWei : m), d.listings[0].priceWei));
    expect(d.fv.floorProxy).toBe(73900000000000000n);
  });
});

describe('fixture report: GNSS Art, 2026-11-15 21:30 UTC', () => {
  const d = day('gnssart');

  it('drops 23 insider sales (a treasury Safe signer buying) and 13 high tails of 117', () => {
    expect(d.rawSales).toHaveLength(117);
    expect(d.tape.kept).toHaveLength(81);
    expect(dropCounts(d.tape)).toEqual({ currency: 0, house: 0, insider: 23, 'self-trade': 0, 'round-trip-30d': 0, 'tail-low': 0, 'tail-high': 13 });
    expect(d.rawSales.filter((e) => insiderSet.has(e.seller) || insiderSet.has(e.buyer))).toHaveLength(23);
  });

  it('has no fair value: 4 sales by 4 sellers in 14 days is thin, though the listing check stands at 0.0222', () => {
    expect(d.fv).toMatchObject({ n: 4, sellers: 4, S: null, F: null, reason: 'thin', L: 22200000000000000n });
    expect(d.fv.L).toBe(plainL(d));
    expect(d.fv.cheapestFillable).toBe(17699200000000000n);
    expect(d.fv.floorProxy).toBe(22200000000000000n);
  });

  it('needed listings past the cheapest 165: those were all bot relists too young to count', () => {
    const t = Math.floor(d.now / 1000);
    const firstAged = d.listings.findIndex((l) => t - Math.max(l.startTime, l.createdAt ?? 0) >= 1800);
    expect(firstAged).toBeGreaterThanOrEqual(100);
    expect(fairValue({ tape: d.tape, listings: d.listings.slice(0, 100), fillable: d.fillable, now: d.now }).L).toBe(null);
  });
});
