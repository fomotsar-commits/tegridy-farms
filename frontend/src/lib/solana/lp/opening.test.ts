// @vitest-environment node
//
// May a new pool open at this price (SPEC_S2_CREATE N7, N16)? Within the deposit check's
// own 3% of a fresh Jupiter price, for a token deposits would take, and never on an
// unread input. Plus the panel's helpers: match the market, the most both balances
// allow, and what arbitrage would take from a mispriced opening.
import { describe, it, expect } from 'vitest';
import { NATIVE_MINT_2022 } from '@solana/spl-token';
import { TOKEN_2022_NATIVE_MINT, arbitrageLoss, assessOpening, matchMarket, mostBothAtMarket, openingSolPerToken } from './opening';
import type { OutsidePrice } from './outsidePrice';
import type { TokenSafety } from './tokenSafety';
import { key } from './testkit.fixture';
import { SOL_QUOTE } from './quotes';

const mint = key().toBase58();
const OK: TokenSafety = { kind: 'read', mint, verdict: 'ok', blocks: [], warnings: [], facts: null, name: null, symbol: null, metadataSource: 'none' };
const jupiter = (p: number): OutsidePrice => ({ kind: 'ok', solPerToken: p, source: 'Jupiter' });

/** 1 SOL against `tokens` whole tokens (6 decimals): a price of 1/tokens SOL per token. */
const at = (o: { sol?: bigint; token?: bigint; outside?: OutsidePrice | null; safety?: TokenSafety | null; decimals?: number | null; tokenMint?: string } = {}) =>
  assessOpening({
    tokenMint: o.tokenMint ?? mint,
    quote: SOL_QUOTE,
    quoteAmount: o.sol ?? 1_000_000_000n,
    token: o.token ?? 5_000_000n,
    tokenDecimals: o.decimals === undefined ? 6 : o.decimals,
    outside: o.outside === undefined ? jupiter(0.2) : o.outside,
    safety: o.safety === undefined ? OK : o.safety,
  });

describe('assessOpening: the price', () => {
  it('at the market: allowed, with the comparison', () => {
    const c = at();
    expect(c).toMatchObject({ verdict: 'allowed', reasons: [], price: { state: 'agrees', against: 'outside', pool: 0.2, reference: 0.2 } });
  });

  it('2.9% off agrees; 3% (as near as a double gets) agrees; 3.1% is refused, naming the gap', () => {
    expect(at({ sol: 1_029_000_000n }).verdict).toBe('allowed');
    // 0.206 against 0.2: 3%, to the last bit a double holds.
    expect(at({ sol: 206_000_000n, token: 1_000_000n })).toMatchObject({ verdict: 'allowed', price: { state: 'agrees' } });
    const off = at({ sol: 1_031_000_000n });
    expect(off.verdict).toBe('refused');
    expect(off.reasons).toEqual(['Your opening price is 3.1% above the market price (Jupiter). Pools opened from this site must start within 3% of it.']);
    expect(at({ sol: 969_000_000n }).reasons[0]).toMatch(/3\.1% below the market price/);
  });

  it('Jupiter answered "no route": refused, never allowed', () => {
    const c = at({ outside: { kind: 'no-route', detail: 'Jupiter has no route for this token' } });
    expect(c.verdict).toBe('refused');
    expect(c.reasons).toEqual(['Jupiter has no market price for this token, so this site does not open a pool for it.']);
  });

  it('Jupiter could not be read, or was not asked: unchecked, never allowed', () => {
    const down = at({ outside: { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' } });
    expect(down).toMatchObject({ verdict: 'unchecked', reasons: ['We could not get a market price from Jupiter (Jupiter did not give a price (HTTP 502)).'] });
    expect(at({ outside: null }).verdict).toBe('unchecked');
  });

  it('the decimals not read: unchecked', () => {
    expect(at({ decimals: null })).toMatchObject({ verdict: 'unchecked', price: { state: 'unread' } });
  });

  it('nothing typed on one side: no price yet, and no reason given', () => {
    expect(at({ token: 0n })).toMatchObject({ price: { state: 'empty' }, reasons: [] });
    expect(at({ sol: 0n }).price).toEqual({ state: 'empty' });
  });
});

describe('assessOpening: the token', () => {
  it('blocked, absent or copying a well-known name: refused', () => {
    const blocked = { ...OK, verdict: 'blocked', blocks: [{ code: 'freeze-authority', text: 'x' }] } as TokenSafety;
    const copy = { ...OK, verdict: 'warn', warnings: [{ code: 'copies-known-name', text: 'x' }] } as TokenSafety;
    expect(at({ safety: blocked }).verdict).toBe('refused');
    expect(at({ safety: { kind: 'absent', mint } }).reasons).toContain('The token does not exist.');
    expect(at({ safety: copy }).reasons).toContain('It calls itself by a well-known token’s name but has a different mint. This site does not open pools for copies.');
  });

  it('a live mint authority stays a warning: allowed', () => {
    expect(at({ safety: { ...OK, verdict: 'warn', warnings: [{ code: 'mint-authority', text: 'x' }] } as TokenSafety }).verdict).toBe('allowed');
  });

  it('the token not read: unchecked', () => {
    expect(at({ safety: { kind: 'unread', mint, detail: 'x' } }).verdict).toBe('unchecked');
    expect(at({ safety: null }).verdict).toBe('unchecked');
  });

  it('SOL under the newer token program is refused by name', () => {
    expect(TOKEN_2022_NATIVE_MINT).toBe(NATIVE_MINT_2022.toBase58());
    const c = at({ tokenMint: TOKEN_2022_NATIVE_MINT, safety: { ...OK, mint: TOKEN_2022_NATIVE_MINT } });
    expect(c.verdict).toBe('refused');
    expect(c.reasons).toContain('This is SOL under the newer token program. Pools here pair a token with SOL, USDC or BAYLA.');
  });
});

/** A small deterministic generator, so a failure names a case that can be run again. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('matchMarket', () => {
  it('the matched opening is within 0.01% of the market, for 5,000 random amounts and decimals 0 to 9', () => {
    const r = rng(3);
    let checked = 0;
    for (let i = 0; i < 5_000; i++) {
      const decimals = Math.floor(r() * 10);
      const price = 10 ** (r() * 8 - 6); // 1e-6 to 100 SOL per token
      const keep = r() < 0.5 ? 'quote' : 'token';
      // Amounts large enough that the matched side is at least 10,000 units, so rounding
      // to the nearest unit stays inside the 0.01%.
      const solLamports = BigInt(Math.floor(10 ** (6 + r() * 6)));
      const tokenUnits = BigInt(Math.max(1, Math.round((Number(solLamports) / 1e9 / price) * 10 ** decimals)));
      const amount = keep === 'quote' ? solLamports : tokenUnits;
      const other = matchMarket({ keep, amount, pricePerToken: price, tokenDecimals: decimals, quote: SOL_QUOTE });
      // Below 10,000 units, rounding to the nearest unit alone can exceed 0.01%.
      if (other === null || other < 10_000n || amount < 10_000n) continue;
      const [sol, token] = keep === 'quote' ? [amount, other] : [other, amount];
      const got = openingSolPerToken(sol, token, decimals)!;
      if (Math.abs(got / price - 1) > 1e-4) throw new Error(`${keep} ${amount}: ${got} vs ${price}`);
      checked++;
    }
    // Not a vacuous pass: most draws are checked.
    expect(checked).toBeGreaterThan(2_500);
  });

  it('keeps the side given and sets the other, rounded to the nearest unit', () => {
    expect(matchMarket({ keep: 'quote', amount: 1_000_000_000n, pricePerToken: 0.2, tokenDecimals: 6, quote: SOL_QUOTE })).toBe(5_000_000n);
    expect(matchMarket({ keep: 'token', amount: 5_000_000n, pricePerToken: 0.2, tokenDecimals: 6, quote: SOL_QUOTE })).toBe(1_000_000_000n);
  });

  it('below one unit: null', () => {
    expect(matchMarket({ keep: 'quote', amount: 1n, pricePerToken: 1_000, tokenDecimals: 0, quote: SOL_QUOTE })).toBeNull();
    expect(matchMarket({ keep: 'quote', amount: 0n, pricePerToken: 0.2, tokenDecimals: 6, quote: SOL_QUOTE })).toBeNull();
    expect(matchMarket({ keep: 'quote', amount: 5n, pricePerToken: 0, tokenDecimals: 6, quote: SOL_QUOTE })).toBeNull();
  });
});

describe('mostBothAtMarket', () => {
  it('never above either balance, and within one unit of the market', () => {
    const r = rng(5);
    for (let i = 0; i < 2_000; i++) {
      const decimals = Math.floor(r() * 10);
      const price = 10 ** (r() * 6 - 4);
      const spendable = BigInt(Math.floor(10 ** (7 + r() * 4)));
      const balance = BigInt(Math.floor(10 ** (3 + r() * 10)));
      const m = mostBothAtMarket({ spendableQuote: spendable, tokenBalance: balance, pricePerToken: price, tokenDecimals: decimals, quote: SOL_QUOTE });
      if (m === null) continue;
      expect(m.quote <= spendable && m.token <= balance).toBe(true);
      // One side is the whole of what can go in, and the other matches it to the unit.
      const fromSol = matchMarket({ keep: 'quote', amount: m.quote, pricePerToken: price, tokenDecimals: decimals, quote: SOL_QUOTE });
      const fromToken = matchMarket({ keep: 'token', amount: m.token, pricePerToken: price, tokenDecimals: decimals, quote: SOL_QUOTE });
      const near = (x: bigint | null, y: bigint) => x !== null && (x - y <= 1n && y - x <= 1n);
      expect(near(fromSol, m.token) || near(fromToken, m.quote), `${spendable} ${balance} ${price} ${decimals}`).toBe(true);
    }
  });

  it('all the SOL when the tokens cover it; all the tokens when they do not', () => {
    expect(mostBothAtMarket({ spendableQuote: 1_000_000_000n, tokenBalance: 9_000_000n, pricePerToken: 0.2, tokenDecimals: 6, quote: SOL_QUOTE })).toEqual({ quote: 1_000_000_000n, token: 5_000_000n });
    expect(mostBothAtMarket({ spendableQuote: 1_000_000_000n, tokenBalance: 2_000_000n, pricePerToken: 0.2, tokenDecimals: 6, quote: SOL_QUOTE })).toEqual({ quote: 400_000_000n, token: 2_000_000n });
    expect(mostBothAtMarket({ spendableQuote: 0n, tokenBalance: 2_000_000n, pricePerToken: 0.2, tokenDecimals: 6, quote: SOL_QUOTE })).toBeNull();
  });
});

describe('arbitrageLoss', () => {
  const loss = (sol: bigint, market: number) => arbitrageLoss({ quoteAmount: sol, token: 5_000_000n, tokenDecimals: 6, marketPricePerToken: market, quote: SOL_QUOTE });

  it('nothing at the market price, and never negative', () => {
    expect(loss(1_000_000_000n, 0.2)).toBeCloseTo(0, 3);
    for (const m of [0.0001, 0.05, 0.19, 0.21, 3, 900]) expect(loss(1_000_000_000n, m)).toBeGreaterThanOrEqual(0);
  });

  it('grows with the gap, either way', () => {
    expect(loss(1_000_000_000n, 0.25)).toBeGreaterThan(loss(1_000_000_000n, 0.21));
    expect(loss(1_000_000_000n, 0.1)).toBeGreaterThan(loss(1_000_000_000n, 0.19));
  });

  it('equals x + y·m − 2·√(x·y·m) when the market is twice the opening price', () => {
    const x = 1;
    const y = 5;
    const m = 0.4;
    expect(loss(1_000_000_000n, m)).toBeCloseTo((x + y * m - 2 * Math.sqrt(x * y * m)) * 1e9, 0);
  });
});
