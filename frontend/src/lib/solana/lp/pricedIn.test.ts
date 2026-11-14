// @vitest-environment node
//
// "Priced in X" (spec 2026-11-14, phase 1): which ?mint= opens the view, which pools it lists
// and in what order, and the link back to every pool.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { BAYLA_QUOTE, BOBO_QUOTE, QUOTE_COINS, RIZZ_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from './quotes';
import { everyPoolSearch, pricedInCoin, pricedInPools } from './pricedIn';
import { buildPool, key, viewOf } from './testkit.fixture';
import type { PoolView } from './poolFinder';

function pool(mint: PublicKey | string, quote: QuoteCoin, openTime: bigint, address?: PublicKey): PoolView {
  const m = typeof mint === 'string' ? new PublicKey(mint) : mint;
  return viewOf(buildPool({ plain: true, mint: m, quote, configIndex: 1, quoteReserve: 10n ** 9n, tokenReserve: 10n ** 9n, openTime, address }), { sol: 10n ** 9n, tok: 10n ** 9n });
}

describe('pricedInCoin: which ?mint= opens a "Priced in" list', () => {
  it('every pairing coin but SOL', () => {
    expect(QUOTE_COINS.filter((q) => pricedInCoin(q.mint) !== null).map((q) => q.symbol)).toEqual(['USDC', 'BAYLA', 'BOBO', 'SOY', 'BRAINLET', 'RIZZ']);
    expect(pricedInCoin(BAYLA_QUOTE.mint)).toBe(BAYLA_QUOTE);
  });

  it('none for SOL, for any other token, and for no token', () => {
    expect(pricedInCoin(SOL_QUOTE.mint)).toBeNull();
    expect(pricedInCoin(key().toBase58())).toBeNull();
    expect(pricedInCoin(null)).toBeNull();
  });
});

describe('pricedInPools: the pools whose quote side is the coin, the oldest first', () => {
  it('keeps only the pools priced in the coin, as each pool reads (quotes.ts readPair)', () => {
    const tokenInBayla = pool(key(), BAYLA_QUOTE, 300n);
    // BOBO ranks below BAYLA: a BOBO and BAYLA pool is BOBO priced in BAYLA.
    const boboInBayla = pool(BOBO_QUOTE.mint, BAYLA_QUOTE, 200n);
    // BAYLA's own pools are priced in the coins above it, never in BAYLA.
    const baylaInSol = pool(BAYLA_QUOTE.mint, SOL_QUOTE, 100n);
    const baylaInUsdc = pool(BAYLA_QUOTE.mint, USDC_QUOTE, 100n);
    const tokenInSol = pool(key(), SOL_QUOTE, 50n);
    // RIZZ ranks below BAYLA: RIZZ's pool with an outside token is priced in RIZZ.
    const tokenInRizz = pool(key(), RIZZ_QUOTE, 10n);
    const list = pricedInPools([baylaInSol, tokenInBayla, tokenInSol, boboInBayla, baylaInUsdc, tokenInRizz], BAYLA_QUOTE);
    expect(list.map((v) => v.address)).toEqual([boboInBayla.address, tokenInBayla.address]);
    expect(pricedInPools([baylaInSol, tokenInSol], BAYLA_QUOTE)).toEqual([]);
    expect(pricedInPools([baylaInUsdc, tokenInSol], USDC_QUOTE).map((v) => v.address)).toEqual([baylaInUsdc.address]);
  });

  it('the oldest pool first, by its open time, then by address; the list given is left as it was', () => {
    const [lo, hi] = [new PublicKey(new Uint8Array(32).fill(1)), new PublicKey(new Uint8Array(32).fill(9))].sort((a, b) => (a.toBase58() < b.toBase58() ? -1 : 1));
    const newest = pool(key(), BAYLA_QUOTE, 3_000n);
    const oldest = pool(key(), BAYLA_QUOTE, 1_000n);
    const twinHi = pool(key(), BAYLA_QUOTE, 2_000n, hi);
    const twinLo = pool(key(), BAYLA_QUOTE, 2_000n, lo);
    const given = [newest, twinHi, oldest, twinLo];
    expect(pricedInPools(given, BAYLA_QUOTE).map((v) => v.address)).toEqual([oldest.address, lo!.toBase58(), hi!.toBase58(), newest.address]);
    expect(given.map((v) => v.address)).toEqual([newest.address, hi!.toBase58(), oldest.address, lo!.toBase58()]);
  });
});

describe('everyPoolSearch: the same page with no token', () => {
  it('drops the token, and the LP door that names its pool, and keeps the rest', () => {
    expect(everyPoolSearch(`?mint=${BAYLA_QUOTE.mint}`)).toBe('');
    expect(everyPoolSearch(`?mint=${BAYLA_QUOTE.mint}&task=add&pool=abc`)).toBe('');
    expect(everyPoolSearch(`?net=solana&mint=${BAYLA_QUOTE.mint}`)).toBe('?net=solana');
    expect(everyPoolSearch('')).toBe('');
  });
});
