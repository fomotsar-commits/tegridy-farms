// @vitest-environment node
//
// A pool paired with USDC or BAYLA is judged in ITS OWN coin: its price is coins per
// token, and its reference is the token's SOL price over the coin's own SOL price.
// What could not be read is unchecked, never a pass.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { priceInQuote, type OutsidePrice } from './outsidePrice';
import { PRICE_TOLERANCE, assessPool, poolPricePerToken } from './poolHealth';
import type { PoolView } from './poolFinder';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from './quotes';
import type { TokenSafety } from './tokenSafety';
import { buildPool, key, viewOf } from './testkit.fixture';

const mint = key();
const OK_TOKEN: TokenSafety = { kind: 'read', mint: mint.toBase58(), verdict: 'ok', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };
const base = { tokenDecimals: 9, chainNow: 1_000n, safety: OK_TOKEN };
const ok = (solPerToken: number): OutsidePrice => ({ kind: 'ok', solPerToken, source: 'Jupiter' });
const NO_ROUTE: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };
const DOWN: OutsidePrice = { kind: 'unread', detail: 'HTTP 502' };

/** `coins` whole coins of `quote` against `tokens` whole tokens (9 decimals, unlike USDC's and BAYLA's 6). */
function view(quote: QuoteCoin, coins: number, tokens: number, o: { token?: PublicKey; origin?: PoolView['origin'] } = {}): PoolView {
  const q = BigInt(coins) * 10n ** BigInt(quote.decimals);
  const t = BigInt(tokens) * 10n ** 9n;
  const b = buildPool({ mint: o.token ?? mint, quote, quoteReserve: q, tokenReserve: t, tokenDecimals: 9, openTime: 100n });
  return viewOf(b, { sol: q, tok: t, origin: o.origin });
}

describe('poolPricePerToken: whole coins per whole token, in the pool’s own coin', () => {
  it.each([
    ['SOL', SOL_QUOTE],
    ['USDC', USDC_QUOTE],
    ['BAYLA', BAYLA_QUOTE],
  ] as const)('a %s pool: 50 coins against 2,000 tokens is 0.025, whatever each side’s decimals', (_n, quote) => {
    expect(poolPricePerToken(view(quote, 50, 2_000).snapshot, mint.toBase58(), 9)).toBeCloseTo(0.025, 12);
  });

  it('a pool is only ever priced as its TOKEN’s pool: BAYLA/USDC has no price as "USDC’s pool"', () => {
    const bayla = new PublicKey(BAYLA_QUOTE.mint);
    const v = view(USDC_QUOTE, 50, 2_000, { token: bayla });
    expect(v.tokenMint).toBe(BAYLA_QUOTE.mint);
    expect(poolPricePerToken(v.snapshot, BAYLA_QUOTE.mint, 9)).toBeCloseTo(0.025, 12);
    expect(poolPricePerToken(v.snapshot, USDC_QUOTE.mint, 6)).toBeNull();
    expect(poolPricePerToken(v.snapshot, key().toBase58(), 9)).toBeNull();
  });
});

describe('priceInQuote', () => {
  it('SOL: the token’s own price, and the coin’s price is never looked at', () => {
    expect(priceInQuote(ok(0.004), SOL_QUOTE, null)).toEqual({ kind: 'ok', perToken: 0.004, source: 'Jupiter' });
    expect(priceInQuote(ok(0.004), SOL_QUOTE, DOWN)).toEqual({ kind: 'ok', perToken: 0.004, source: 'Jupiter' });
  });

  it('USDC and BAYLA: the token’s SOL price over the coin’s SOL price', () => {
    // A token at 0.004 SOL with USDC at 0.005 SOL (SOL at 200 USDC): 0.8 USDC a token.
    const r = priceInQuote(ok(0.004), USDC_QUOTE, ok(0.005));
    expect(r.kind === 'ok' && r.perToken).toBeCloseTo(0.8, 12);
    const b = priceInQuote(ok(0.004), BAYLA_QUOTE, ok(0.00002));
    expect(b.kind === 'ok' && b.perToken).toBeCloseTo(200, 9);
  });

  it('the token’s own answer comes first: no route and unread pass straight through', () => {
    for (const quote of [SOL_QUOTE, USDC_QUOTE, BAYLA_QUOTE]) {
      expect(priceInQuote(NO_ROUTE, quote, ok(0.005))).toBe(NO_ROUTE);
      expect(priceInQuote(DOWN, quote, ok(0.005))).toBe(DOWN);
    }
  });

  it('a coin that could not be priced is unread, never "no route" and never a price', () => {
    expect(priceInQuote(ok(0.004), USDC_QUOTE, null)).toEqual({ kind: 'unread', detail: 'the price of USDC was not read' });
    expect(priceInQuote(ok(0.004), USDC_QUOTE, DOWN)).toEqual({ kind: 'unread', detail: 'the price of USDC could not be read (HTTP 502)' });
    expect(priceInQuote(ok(0.004), BAYLA_QUOTE, NO_ROUTE)).toEqual({ kind: 'unread', detail: 'the price of BAYLA could not be read (Jupiter has no route for this token)' });
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(priceInQuote(ok(0.004), USDC_QUOTE, ok(bad)).kind, String(bad)).toBe('unread');
    }
  });
});

describe('assessPool: a pool paired with USDC or BAYLA', () => {
  // 50 USDC against 2,000 tokens: 0.025 USDC a token. USDC at 0.005 SOL, so the token's
  // matching SOL price is 0.000125.
  const usdcPool = () => view(USDC_QUOTE, 50, 2_000);
  const USDC_IN_SOL = ok(0.005);
  const FAIR = 0.000125;

  it('a price within 3% of the outside price, in USDC: deposits allowed, and the check is said in USDC per token', () => {
    const h = assessPool({ ...base, view: usdcPool(), outside: ok(FAIR), coinOutside: USDC_IN_SOL });
    expect(h.deposits).toEqual({ verdict: 'allowed', reasons: [] });
    expect(h.price).toMatchObject({ state: 'agrees', against: 'outside' });
    expect(h.price.state === 'agrees' && h.price.pool).toBeCloseTo(0.025, 12);
    expect(h.price.state === 'agrees' && h.price.reference).toBeCloseTo(0.025, 12);
  });

  it('more than 3% off in USDC, either way: refused', () => {
    for (const tokenSol of [FAIR / (1 + PRICE_TOLERANCE + 0.001), FAIR / (1 - PRICE_TOLERANCE - 0.001)]) {
      const h = assessPool({ ...base, view: usdcPool(), outside: ok(tokenSol), coinOutside: USDC_IN_SOL });
      expect(h.price.state).toBe('disagrees');
      expect(h.deposits.verdict).toBe('refused');
    }
  });

  it('a move in the COIN’s own price moves the reference: the same token price can agree or disagree', () => {
    expect(assessPool({ ...base, view: usdcPool(), outside: ok(FAIR), coinOutside: ok(0.005) }).price.state).toBe('agrees');
    expect(assessPool({ ...base, view: usdcPool(), outside: ok(FAIR), coinOutside: ok(0.0055) }).price.state).toBe('disagrees');
  });

  it('the token’s SOL price is never compared with a USDC price as if they were the same unit', () => {
    // 0.025 "SOL a token" would agree with the pool's 0.025 USDC a token if the units were mixed up.
    const h = assessPool({ ...base, view: usdcPool(), outside: ok(0.025), coinOutside: USDC_IN_SOL });
    expect(h.price.state).toBe('disagrees');
    expect(h.deposits.verdict).toBe('refused');
  });

  it.each([
    ['not read at all', undefined],
    ['null', null],
    ['a failed read', DOWN],
    ['"no route" for the coin', NO_ROUTE],
  ] as const)('the coin’s price %s: unchecked, never allowed', (_n, coinOutside) => {
    const h = assessPool({ ...base, view: usdcPool(), outside: ok(FAIR), coinOutside });
    expect(h.price.state).toBe('unread');
    expect(h.deposits.verdict).toBe('unchecked');
    expect(h.deposits.reasons.join(' ')).toMatch(/the price of USDC/);
  });

  it('the token’s price unread, or no route: unchecked (a pool anyone could open has no fallback)', () => {
    for (const outside of [DOWN, NO_ROUTE, null]) {
      const h = assessPool({ ...base, view: usdcPool(), outside, coinOutside: USDC_IN_SOL });
      expect(h.price.state).toBe('unread');
      expect(h.deposits.verdict).toBe('unchecked');
    }
  });

  it('a BAYLA pool is judged in BAYLA per token', () => {
    // 60,000 BAYLA against 300 tokens: 200 BAYLA a token. BAYLA at 0.00002 SOL: the token at 0.004 SOL.
    const v = view(BAYLA_QUOTE, 60_000, 300);
    const fair = assessPool({ ...base, view: v, outside: ok(0.004), coinOutside: ok(0.00002) });
    expect(fair.price.state === 'agrees' && fair.price.pool).toBeCloseTo(200, 9);
    expect(fair.deposits.verdict).toBe('allowed');
    expect(assessPool({ ...base, view: v, outside: ok(0.0045), coinOutside: ok(0.00002) }).deposits.verdict).toBe('refused');
  });

  it('a SOL pool ignores the coin’s price entirely, whatever it says', () => {
    const v = view(SOL_QUOTE, 50, 2_000);
    for (const coinOutside of [undefined, null, DOWN, NO_ROUTE, ok(123)]) {
      const h = assessPool({ ...base, view: v, outside: ok(0.025), coinOutside });
      expect(h.price).toMatchObject({ state: 'agrees', against: 'outside' });
      expect(h.deposits.verdict).toBe('allowed');
    }
  });
});
