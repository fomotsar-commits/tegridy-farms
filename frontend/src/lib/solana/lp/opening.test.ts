// @vitest-environment node
//
// May a new pool open at this price (SPEC_S2_CREATE N7, N16), and what must its opener be
// told? A price off the market, no market price at all, a copied name and a freezable
// token are warnings (owner ruling 2026-10-04); an unread input never opens. Plus the
// panel's helpers: match the market, the most both balances allow, and what arbitrage
// would take from a mispriced opening or deposit.
import { describe, it, expect } from 'vitest';
import { NATIVE_MINT_2022 } from '@solana/spl-token';
import { TOKEN_2022_NATIVE_MINT, arbitrageLoss, assessOpening, estimatedLoss, matchMarket, mostBothAtMarket, openingSolPerToken } from './opening';
import type { OutsidePrice } from './outsidePrice';
import type { TokenSafety } from './tokenSafety';
import { key } from './testkit.fixture';
import { BAYLA_QUOTE, SOL_QUOTE, USDC_QUOTE, type QuoteCoin } from './quotes';

const NO_MARKET =
  'Jupiter has no market price for this token, so there is nothing to compare your opening price with. You are setting the price yourself: if it is off, the first trades take the difference out of what you put in.';

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
  it('at the market: allowed, with the comparison, and nothing to warn of', () => {
    const c = at();
    expect(c).toEqual({ verdict: 'allowed', reasons: [], warnings: [], price: { state: 'agrees', against: 'outside', pool: 0.2, reference: 0.2, diff: 0 } });
  });

  it('2.9% off agrees; 3% (as near as a double gets) agrees; 3.1% is allowed with a warning that names the gap', () => {
    expect(at({ sol: 1_029_000_000n })).toMatchObject({ verdict: 'allowed', warnings: [] });
    // 0.206 against 0.2: 3%, to the last bit a double holds.
    expect(at({ sol: 206_000_000n, token: 1_000_000n })).toMatchObject({ verdict: 'allowed', price: { state: 'agrees' }, warnings: [] });
    const off = at({ sol: 1_031_000_000n });
    expect(off).toMatchObject({ verdict: 'allowed', reasons: [], price: { state: 'disagrees', against: 'outside' } });
    expect(off.warnings).toEqual(['Your opening price is 3.1% above the market price (Jupiter). The first trades would move it to the market price, at your cost.']);
    expect(at({ sol: 969_000_000n }).warnings).toEqual(['Your opening price is 3.1% below the market price (Jupiter). The first trades would move it to the market price, at your cost.']);
    // No sentence says this site refuses a price it now takes.
    expect(off.warnings.join(' ')).not.toMatch(/must start within|does not open/);
  });

  it('Jupiter answered "no route": allowed as "no market", and the opener is told they set the price themselves', () => {
    const c = at({ outside: { kind: 'no-route', detail: 'Jupiter has no route for this token' } });
    expect(c).toEqual({
      verdict: 'allowed',
      reasons: [],
      warnings: [NO_MARKET],
      price: { state: 'no-market', of: 'token', pool: 0.2, detail: 'Jupiter has no route for this token' },
    });
  });

  // With no route nothing is compared, so the pairing coin's own price is not needed.
  it('no route for the token in a USDC opening: the coin’s own price unread, missing or without a route does not make it unchecked', () => {
    const noRoute: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };
    for (const coinOutside of [undefined, null, { kind: 'unread', detail: 'HTTP 502' }, noRoute, jupiter(0.005)] as const) {
      const c = assessOpening({ tokenMint: mint, quote: USDC_QUOTE, quoteAmount: 200_000_000n, token: 100_000_000n, tokenDecimals: 6, outside: noRoute, coinOutside, safety: OK });
      // Said of the TOKEN, in the token's words, whatever the coin's own price says.
      expect(c).toMatchObject({ verdict: 'allowed', reasons: [], warnings: [NO_MARKET], price: { state: 'no-market', of: 'token', pool: 2 } });
    }
  });

  // Owner ruling 2026-10-07 ("no, we do what we want"): Jupiter ANSWERING that it has no
  // route for the PAIRING COIN does not switch opening off. There is no market price in
  // that coin, so the opener sets the price, and the warning names the coin. It was
  // `unchecked` before, and no pool priced in that coin could be opened.
  describe('a pairing coin Jupiter has no price for', () => {
    const noRoute: OutsidePrice = { kind: 'no-route', detail: 'Jupiter has no route for this token' };
    /** 200 of the coin against 100 tokens (6 decimals each): 2 of the coin a token. The token itself has a price. */
    const inCoin = (quote: QuoteCoin, coinOutside: OutsidePrice | null | undefined) =>
      assessOpening({ tokenMint: mint, quote, quoteAmount: 200_000_000n, token: 100_000_000n, tokenDecimals: 6, outside: jupiter(0.01), coinOutside, safety: OK });

    it.each([
      ['USDC', USDC_QUOTE],
      ['BAYLA', BAYLA_QUOTE],
    ] as const)('"no route" for %s: allowed, as "no market" of the COIN, with a warning that names the coin and ends as the token’s does', (symbol, quote) => {
      const c = inCoin(quote, noRoute);
      expect(c).toEqual({
        verdict: 'allowed',
        reasons: [],
        warnings: [
          `Jupiter has no price for ${symbol} right now, so there is nothing to compare your opening price in ${symbol} with. You are setting the price yourself: if it is off, the first trades take the difference out of what you put in.`,
        ],
        price: { state: 'no-market', of: 'coin', pool: 2, detail: `Jupiter has no route for ${symbol}` },
      });
      // The token HAS a price: nothing may say it has none.
      expect(c.warnings.join(' ')).not.toMatch(/this token/);
      // The same ending as the sentence for a token with no market.
      const ending = NO_MARKET.slice(NO_MARKET.indexOf('You are setting'));
      expect(c.warnings[0]!.endsWith(ending)).toBe(true);
    });

    // UNREAD IS STILL REFUSED. The mutation "treat every coin that is not ok as no-route"
    // fails here: a read of the coin's price that FAILED, or was never made, opens nothing.
    it.each([
      ['a failed read', { kind: 'unread', detail: 'HTTP 502' } as OutsidePrice, 'We could not get a market price from Jupiter (the price of USDC could not be read (HTTP 502)).'],
      ['not asked for', null, 'We could not get a market price from Jupiter (the price of USDC was not read).'],
      ['left out', undefined, 'We could not get a market price from Jupiter (the price of USDC was not read).'],
    ] as const)('the coin’s price %s: unchecked, never allowed and never a warning', (_n, coinOutside, reason) => {
      const c = inCoin(USDC_QUOTE, coinOutside);
      expect(c).toMatchObject({ verdict: 'unchecked', reasons: [reason], warnings: [], price: { state: 'unread' } });
    });

    it('a SOL opening never looks at a coin price: "no route" beside it changes nothing', () => {
      expect(assessOpening({ tokenMint: mint, quote: SOL_QUOTE, quoteAmount: 1_000_000_000n, token: 5_000_000n, tokenDecimals: 6, outside: jupiter(0.2), coinOutside: noRoute, safety: OK })).toMatchObject({
        verdict: 'allowed',
        warnings: [],
        price: { state: 'agrees' },
      });
    });

    it('it lifts nothing else: a token this site does not open pools for is still refused', () => {
      const blocked = { ...OK, verdict: 'blocked', blocks: [{ code: 'transfer-fee', text: 'x' }] } as TokenSafety;
      expect(assessOpening({ tokenMint: mint, quote: USDC_QUOTE, quoteAmount: 200_000_000n, token: 100_000_000n, tokenDecimals: 6, outside: jupiter(0.01), coinOutside: noRoute, safety: blocked }).verdict).toBe('refused');
    });
  });

  it('Jupiter could not be read, or was not asked: unchecked, never allowed and never a warning', () => {
    const down = at({ outside: { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' } });
    expect(down).toMatchObject({
      verdict: 'unchecked',
      reasons: ['We could not get a market price from Jupiter (Jupiter did not give a price (HTTP 502)).'],
      warnings: [],
      price: { state: 'unread' },
    });
    expect(at({ outside: null })).toMatchObject({ verdict: 'unchecked', warnings: [], price: { state: 'unread' } });
  });

  it('the decimals not read: unchecked', () => {
    expect(at({ decimals: null })).toMatchObject({ verdict: 'unchecked', price: { state: 'unread' }, warnings: [] });
  });

  it('nothing typed on one side: no price yet, and no reason given', () => {
    expect(at({ token: 0n })).toMatchObject({ price: { state: 'empty' }, reasons: [] });
    expect(at({ sol: 0n }).price).toEqual({ state: 'empty' });
  });
});

describe('assessOpening: the token', () => {
  it('blocked or absent: refused', () => {
    const blocked = { ...OK, verdict: 'blocked', blocks: [{ code: 'transfer-fee', text: 'x' }] } as TokenSafety;
    // In words about what this site does not do: the token is never called "blocked" (owner ruling 2026-10-07).
    expect(at({ safety: blocked })).toMatchObject({ verdict: 'refused', reasons: ['This site does not add to pools for this token (see why above).'] });
    expect(at({ safety: { kind: 'absent', mint } })).toMatchObject({ verdict: 'refused', reasons: ['The token does not exist.'] });
  });

  it('a copied name, a freezable token, and interest or scaled amounts: allowed, each said about the pool being opened', () => {
    const warned = (...codes: string[]) => ({ ...OK, verdict: 'warn', warnings: codes.map((code) => ({ code, text: 'x' })) }) as TokenSafety;
    const copy = at({ safety: warned('copies-known-name') });
    expect(copy).toMatchObject({ verdict: 'allowed', reasons: [] });
    expect(copy.warnings).toEqual([
      'It calls itself by a well-known token’s name but has a different mint, so it is not that token. If the copy turns out to be worth nothing, so is your share of the pool you open.',
    ]);
    const freezable = at({ safety: warned('freeze-authority') });
    expect(freezable).toMatchObject({ verdict: 'allowed', reasons: [] });
    expect(freezable.warnings).toEqual([
      'Its creator can freeze the vault of the pool you open, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.',
    ]);
    expect(at({ safety: warned('interest-bearing') }).warnings).toHaveLength(1);
    expect(at({ safety: warned('scaled-amount') }).warnings[0]).toMatch(/^The amount a wallet displays for this token changes over time\./);
    // The token's warnings come first, the price's last.
    const both = at({ safety: warned('copies-known-name', 'freeze-authority'), sol: 2_000_000_000n });
    expect(both.verdict).toBe('allowed');
    expect(both.warnings).toHaveLength(3);
    expect(both.warnings[2]).toMatch(/^Your opening price is 100\.0% above the market price/);
  });

  it('a live mint authority stays a warning on the token only: allowed, and nothing is added here', () => {
    expect(at({ safety: { ...OK, verdict: 'warn', warnings: [{ code: 'mint-authority', text: 'x' }] } as TokenSafety })).toMatchObject({ verdict: 'allowed', warnings: [] });
  });

  it('the token not read: unchecked, never a warning', () => {
    expect(at({ safety: { kind: 'unread', mint, detail: 'x' } })).toMatchObject({ verdict: 'unchecked', warnings: [] });
    expect(at({ safety: null })).toMatchObject({ verdict: 'unchecked', warnings: [] });
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

// The same sum as a whole number of the coin's base units, for the review of an opening
// and of a deposit. Display only, an upper bound, rounded UP, and never a made-up 0.
describe('estimatedLoss', () => {
  const sol = (quoteAmount: bigint, token: bigint, market: number) => estimatedLoss({ quoteAmount, token, tokenDecimals: 6, marketPricePerToken: market, quote: SOL_QUOTE });

  it('is arbitrageLoss rounded UP to the coin’s base unit, never down', () => {
    // 1 SOL against 5 tokens with the market at 0.4: (1 − √2)² SOL = 171,572,875.25… lamports.
    const exact = arbitrageLoss({ quoteAmount: 1_000_000_000n, token: 5_000_000n, tokenDecimals: 6, marketPricePerToken: 0.4, quote: SOL_QUOTE });
    expect(Number.isInteger(exact)).toBe(false);
    expect(sol(1_000_000_000n, 5_000_000n, 0.4)).toBe(BigInt(Math.floor(exact)) + 1n);
    expect(sol(1_000_000_000n, 5_000_000n, 0.4)).toBe(171_572_876n);
    // A loss far below one unit is still one unit, not nothing.
    const tiny = sol(1_000n, 5n, 0.21);
    expect(arbitrageLoss({ quoteAmount: 1_000n, token: 5n, tokenDecimals: 6, marketPricePerToken: 0.21, quote: SOL_QUOTE })).toBeLessThan(1);
    expect(tiny).toBe(1n);
  });

  it('is in the pool’s own coin: USDC’s six decimals, not SOL’s nine', () => {
    // (√200 − √800)² = 200 whole USDC.
    const usdc = estimatedLoss({ quoteAmount: 200_000_000n, token: 100_000_000n, tokenDecimals: 6, marketPricePerToken: 8, quote: USDC_QUOTE })!;
    expect(Number(usdc) / 1e6).toBeCloseTo(200, 5);
  });

  it('a deposit’s amounts go in at the pool’s price, so its loss scales with its size', () => {
    // A pool at 0.2 SOL a token against a reference of 0.25: a deposit ten times larger loses ten times more.
    const small = sol(100_000_000n, 500_000n, 0.25)!;
    const large = sol(1_000_000_000n, 5_000_000n, 0.25)!;
    // Ten times, but for the one unit each is rounded up by.
    expect(Number(large) / Number(small)).toBeCloseTo(10, 4);
    expect(small).toBeGreaterThan(0n);
  });

  it('what cannot be worked out is null, never 0: a price that is not a positive number, a sum too large for a number', () => {
    for (const m of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(sol(1_000_000_000n, 5_000_000n, m), String(m)).toBeNull();
    // 1 lamport against 10^19 whole tokens at 1e290 SOL each: the sum is not a finite number.
    expect(estimatedLoss({ quoteAmount: 1n, token: 10n ** 19n, tokenDecimals: 0, marketPricePerToken: 1e290, quote: SOL_QUOTE })).toBeNull();
    // The panel's own helper keeps its old answer for those: this one must not copy it.
    expect(arbitrageLoss({ quoteAmount: 1_000_000_000n, token: 5_000_000n, tokenDecimals: 6, marketPricePerToken: 0, quote: SOL_QUOTE })).toBe(0);
  });
});
