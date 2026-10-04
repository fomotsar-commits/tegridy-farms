// @vitest-environment node
//
// A pool paired with USDC or BAYLA is judged in ITS OWN coin: its price is coins per
// token, and its reference is the token's SOL price over the coin's own SOL price.
// What could not be read is unchecked, never a pass.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import { coinPriceDetail, priceInQuote, type OutsidePrice } from './outsidePrice';
import { PRICE_TOLERANCE, assessPool, poolPricePerToken, vaultFreezer } from './poolHealth';
import type { PoolView } from './poolFinder';
import { BAYLA_QUOTE, QUOTE_COINS, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from './quotes';
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
    // Jupiter's own words for "no route" say "this token". Here they are about the COIN,
    // and beside a pool "this token" means the token on the other side, which is allowed
    // to have no route. So the detail names the coin (whole-change review, 2026-10-04).
    for (const quote of [USDC_QUOTE, BAYLA_QUOTE]) {
      const r = priceInQuote(ok(0.004), quote, NO_ROUTE);
      expect(r).toEqual({ kind: 'unread', detail: `the price of ${quote.symbol} could not be read (Jupiter has no route for ${quote.symbol})` });
      expect(r.kind === 'unread' && r.detail).not.toMatch(/this token/);
    }
    // A failed read keeps its own detail, word for word.
    expect(coinPriceDetail(USDC_QUOTE, DOWN)).toBe('HTTP 502');
    expect(coinPriceDetail(USDC_QUOTE, NO_ROUTE)).toBe('Jupiter has no route for USDC');
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
    expect(h.deposits).toEqual({ verdict: 'allowed', reasons: [], warnings: [] });
    expect(h.price).toMatchObject({ state: 'agrees', against: 'outside' });
    expect(h.price.state === 'agrees' && h.price.pool).toBeCloseTo(0.025, 12);
    expect(h.price.state === 'agrees' && h.price.reference).toBeCloseTo(0.025, 12);
  });

  it('more than 3% off in USDC, either way: allowed, with the gap as a warning', () => {
    for (const tokenSol of [FAIR / (1 + PRICE_TOLERANCE + 0.001), FAIR / (1 - PRICE_TOLERANCE - 0.001)]) {
      const h = assessPool({ ...base, view: usdcPool(), outside: ok(tokenSol), coinOutside: USDC_IN_SOL });
      expect(h.price.state).toBe('disagrees');
      expect(h.deposits.verdict).toBe('allowed');
      expect(h.deposits.warnings).toHaveLength(1);
      expect(h.deposits.warnings[0]).toMatch(/^Its price is 3\.1% (above|below) the outside price\./);
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
    // 0.025 USDC a token against a market of 5 USDC a token: said, in the pool's own coin.
    expect(h.price.state === 'disagrees' && h.price.reference).toBeCloseTo(5, 9);
    expect(h.deposits.warnings).toEqual(['Its price is 99.5% below the outside price. A deposit here would hand that gap to the first arbitrage trade.']);
  });

  it.each([
    ['not read at all', undefined],
    ['null', null],
    ['a failed read', DOWN],
    ['"no route" for the coin', NO_ROUTE],
  ] as const)('the coin’s price %s, with a token price to compare: unchecked, never allowed and never a warning', (_n, coinOutside) => {
    const h = assessPool({ ...base, view: usdcPool(), outside: ok(FAIR), coinOutside });
    expect(h.price.state).toBe('unread');
    expect(h.deposits.verdict).toBe('unchecked');
    expect(h.deposits.reasons.join(' ')).toMatch(/the price of USDC/);
    // What the card says of this pool never says "this token" of the coin.
    expect(h.deposits.reasons.join(' ')).not.toMatch(/this token/);
    expect(h.deposits.warnings).toEqual([]);
  });

  it('the token’s price unread or not asked for: unchecked, never a warning', () => {
    for (const outside of [DOWN, null]) {
      const h = assessPool({ ...base, view: usdcPool(), outside, coinOutside: USDC_IN_SOL });
      expect(h.price.state).toBe('unread');
      expect(h.deposits.verdict).toBe('unchecked');
      expect(h.deposits.warnings).toEqual([]);
    }
  });

  // With no route for the TOKEN nothing is compared, so the coin's own price is not
  // needed: whatever it says, even unread, the pool is "no market" and says so.
  it.each([
    ['read', USDC_IN_SOL],
    ['not read at all', undefined],
    ['null', null],
    ['a failed read', DOWN],
    ['"no route" for the coin', NO_ROUTE],
  ] as const)('no route for the token, the coin’s price %s: allowed as "no market", with the warning', (_n, coinOutside) => {
    const h = assessPool({ ...base, view: usdcPool(), outside: NO_ROUTE, coinOutside });
    expect(h.price).toMatchObject({ state: 'no-market' });
    expect(h.price.state === 'no-market' && h.price.pool).toBeCloseTo(0.025, 12);
    expect(h.deposits.verdict).toBe('allowed');
    expect(h.deposits.reasons).toEqual([]);
    expect(h.deposits.warnings).toEqual([
      'Jupiter has no market price for this token, so this pool’s price was not checked against anything. If it is off, a deposit here hands the difference to whoever trades it back.',
    ]);
  });

  it('a BAYLA pool is judged in BAYLA per token', () => {
    // 60,000 BAYLA against 300 tokens: 200 BAYLA a token. BAYLA at 0.00002 SOL: the token at 0.004 SOL.
    const v = view(BAYLA_QUOTE, 60_000, 300);
    const fair = assessPool({ ...base, view: v, outside: ok(0.004), coinOutside: ok(0.00002) });
    expect(fair.price.state === 'agrees' && fair.price.pool).toBeCloseTo(200, 9);
    expect(fair.deposits).toEqual({ verdict: 'allowed', reasons: [], warnings: [] });
    // The token at 0.0045 SOL is 225 BAYLA: the pool's 200 is 11.1% below, and that is said.
    const off = assessPool({ ...base, view: v, outside: ok(0.0045), coinOutside: ok(0.00002) });
    expect(off.deposits.verdict).toBe('allowed');
    expect(off.deposits.warnings).toEqual(['Its price is 11.1% below the outside price. A deposit here would hand that gap to the first arbitrage trade.']);
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

// Review 2026-10-04 (UA-9). `vaultsFrozen` is true for EITHER vault, and the read does not
// say which one. The token's issuer can always be the one who froze it. The pairing coin's
// issuer can be only when that coin has an issuer who can freeze: USDC's. SOL has none,
// and BAYLA's mint has no freeze authority. So only a USDC pool names its coin.
describe('a frozen vault: who can have frozen it', () => {
  const TOKEN_ONLY = 'the token’s issuer';

  it('SOL and BAYLA: the token’s issuer. USDC: the token’s issuer or USDC’s', () => {
    expect(vaultFreezer(SOL_QUOTE)).toBe(TOKEN_ONLY);
    expect(vaultFreezer(USDC_QUOTE)).toBe('the token’s issuer or USDC’s');
    expect(vaultFreezer(BAYLA_QUOTE)).toBe(TOKEN_ONLY);
  });

  // A coin says that its issuer can freeze a pool's account in its own risk line
  // (quotes.ts). It is named here exactly when that line says so: a new coin with a freeze
  // authority cannot be listed without being named, and a coin without one is never blamed.
  it('a coin is named exactly when its own risk line says its issuer can freeze', () => {
    for (const q of QUOTE_COINS) {
      const named = vaultFreezer(q) !== TOKEN_ONLY;
      expect(named, q.symbol).toBe(/can freeze/.test(q.risk ?? ''));
      if (named) expect(vaultFreezer(q)).toBe(`the token’s issuer or ${q.symbol}’s`);
    }
  });

  it.each([
    ['SOL', TOKEN_ONLY, SOL_QUOTE],
    ['USDC', 'the token’s issuer or USDC’s', USDC_QUOTE],
    ['BAYLA', TOKEN_ONLY, BAYLA_QUOTE],
  ] as const)('a %s pool with a frozen vault is refused, and the reason says "%s"', (_n, who, quote) => {
    const v: PoolView = { ...view(quote, 50, 2_000), vaultsFrozen: true };
    // No market price for the token: the price check adds no reason of its own.
    const h = assessPool({ ...base, view: v, outside: NO_ROUTE });
    expect(h.withdrawals).toBe('vault-frozen');
    expect(h.deposits.verdict).toBe('refused');
    expect(h.deposits.reasons).toEqual([`One of this pool’s vaults is frozen by ${who}, so nothing can move in or out of it.`]);
  });
});
