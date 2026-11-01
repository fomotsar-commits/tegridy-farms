// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { quoteOwnPool } from '../cpswap/read';
import { ARB_FLOOR_USD, arbitrage, type Opportunity } from './poolList';
import { checkedOrder, legKey, otherLeg, rowCheck, type RowCheck } from './arbCheck';
import type { LegQuote } from './outsidePrice';
import { buildPool, key, viewOf } from './testkit.fixture';
import { WSOL_MINT } from './tokenSafety';

const NOW = 10_000_000n;
const SOL_USD = 200;
const SOL_UNIT = SOL_USD / 1e9;

/** 50 SOL and 1,000 tokens (6 decimals): $10 a token here, at $200 a SOL, in the test tier's 1% pool. */
function opportunity(tokenUsd: number): { o: Opportunity; usd: Map<string, number> } {
  const b = buildPool({ mint: key(), address: key(), quoteReserve: 50n * 10n ** 9n, tokenReserve: 10n ** 9n });
  const view = viewOf(b, { sol: 50n * 10n ** 9n, tok: 10n ** 9n });
  const usd = new Map([[WSOL_MINT, SOL_USD], [view.tokenMint, tokenUsd]]);
  const arb = arbitrage(view, usd, NOW)!;
  return { o: { view, safety: null, arb }, usd };
}
const quoted = (out: bigint, pools: string[] = [key().toBase58()]): LegQuote => ({ kind: 'ok', out, pools });
/** Base units of the coin at Jupiter's listed price for `tokens` of the token, times `haircut`. */
const listedCoin = (tokens: bigint, tokenUsd: number, haircut: number) => BigInt(Math.floor(((Number(tokens) * tokenUsd) / 1e6 / SOL_USD) * 1e9 * haircut));
const listedTokens = (lamports: bigint, tokenUsd: number, haircut: number) => BigInt(Math.floor(((Number(lamports) * SOL_UNIT) / tokenUsd) * 1e6 * haircut));

describe('otherLeg: the half of the round trip that is asked of Jupiter', () => {
  it('a token cheap here is bought here, and what comes out is sold on Jupiter for the pool’s coin', () => {
    const { o, usd } = opportunity(10 / 0.91);
    expect(o.arb.side).toBe('buy');
    expect(otherLeg(o, usd)).toEqual({ inputMint: o.view.tokenMint, outputMint: WSOL_MINT, amount: o.arb.outAmount });
  });

  it('a token dear here is bought on Jupiter first, with the coin the trade’s tokens are worth at the listed price', () => {
    const { o, usd } = opportunity(10 / 1.1);
    expect(o.arb.side).toBe('sell');
    const leg = otherLeg(o, usd)!;
    expect([leg.inputMint, leg.outputMint]).toEqual([WSOL_MINT, o.view.tokenMint]);
    expect(Number(leg.amount) * SOL_UNIT).toBeCloseTo(o.arb.tradeUsd, 6);
    // No price for the pool's coin: nothing to size that buy with.
    expect(otherLeg(o, new Map([[o.view.tokenMint, 10 / 1.1]]))).toBeNull();
  });

  it('one key per pool, direction and amount', () => {
    const { o, usd } = opportunity(10 / 0.91);
    const leg = otherLeg(o, usd)!;
    expect(legKey(o.view.address, leg)).toBe(legKey(o.view.address, { ...leg }));
    expect(legKey(o.view.address, leg)).not.toBe(legKey(o.view.address, { ...leg, amount: leg.amount + 1n }));
  });
});

describe('rowCheck: a row’s profit held to Jupiter’s live quote', () => {
  it('GRR, 2026-11-01: 9% cheaper here against the listed price, but Jupiter pays 6% under it at every size, so the trip loses', () => {
    const tokenUsd = 10 / 0.91;
    const { o, usd } = opportunity(tokenUsd);
    expect(o.arb.gap).toBeCloseTo(-0.09, 9);
    expect(o.arb.profitUsd).toBeGreaterThan(ARB_FLOOR_USD);
    const leg = otherLeg(o, usd)!;
    const back = listedCoin(leg.amount, tokenUsd, 0.94);
    const check = rowCheck(o, leg, quoted(back), usd, NOW, new Set());
    expect(check.kind).toBe('loss');
    expect((check as { usd: number }).usd).toBeCloseTo(Number(back - o.arb.amountIn) * SOL_UNIT, 9);
    expect((check as { usd: number }).usd).toBeLessThan(0);
  });

  it('a real gap: Jupiter pays near its listed price, and the round trip’s profit is what its quote gives back over what went in', () => {
    const tokenUsd = 10 / 0.91;
    const { o, usd } = opportunity(tokenUsd);
    const leg = otherLeg(o, usd)!;
    const back = listedCoin(leg.amount, tokenUsd, 0.995);
    const check = rowCheck(o, leg, quoted(back), usd, NOW, new Set());
    expect(check).toEqual({ kind: 'profit', usd: (Number(back - o.arb.amountIn) * SOL_USD) / 1e9 });
    expect((check as { usd: number }).usd).toBeLessThan(o.arb.profitUsd);
  });

  for (const [what, haircut, kind] of [['near its listed price', 0.995, 'profit'], ['9% under it', 0.91, 'loss']] as const) {
    it(`dear here, Jupiter selling the token ${what}: what it delivers is sold here, by the pool’s own maths (${kind})`, () => {
      const tokenUsd = 10 / 1.1;
      const { o, usd } = opportunity(tokenUsd);
      const leg = otherLeg(o, usd)!;
      const tokens = listedTokens(leg.amount, tokenUsd, haircut);
      const sold = quoteOwnPool(o.view.snapshot, o.view.config!, o.view.tokenMint, tokens, Number(NOW))!;
      const check = rowCheck(o, leg, quoted(tokens), usd, NOW, new Set());
      expect(check.kind).toBe(kind);
      expect((check as { usd: number }).usd).toBeCloseTo((Number(sold.outAmount - leg.amount) * SOL_USD) / 1e9, 9);
    });
  }

  it('asking, not asked, not read, no route, and a quote through our own pool', () => {
    const { o, usd } = opportunity(10 / 0.91);
    const leg = otherLeg(o, usd)!;
    const rich = quoted(10n ** 12n);
    expect(rowCheck(o, leg, 'checking', usd, NOW, new Set())).toEqual({ kind: 'checking' });
    expect(rowCheck(o, leg, null, usd, NOW, new Set())).toEqual({ kind: 'unchecked' });
    expect(rowCheck(o, null, rich, usd, NOW, new Set())).toEqual({ kind: 'unchecked' });
    expect(rowCheck(o, leg, { kind: 'unread', detail: 'Jupiter did not give a price (HTTP 429)' }, usd, NOW, new Set())).toEqual({ kind: 'unchecked' });
    expect(rowCheck(o, leg, { kind: 'no-route' }, usd, NOW, new Set())).toEqual({ kind: 'no-route' });
    // Jupiter routing through one of our pools would price the trip against itself: not an outside quote.
    const mine = quoted(10n ** 12n, [key().toBase58(), o.view.address]);
    expect(rowCheck(o, leg, mine, usd, NOW, new Set([o.view.address]))).toEqual({ kind: 'unchecked' });
    expect(rowCheck(o, leg, rich, usd, NOW, new Set([o.view.address])).kind).toBe('profit');
  });

  it('selling here needs the chain’s clock and the pool’s fees to price the second half', () => {
    const { o, usd } = opportunity(10 / 1.1);
    const leg = otherLeg(o, usd)!;
    expect(rowCheck(o, leg, quoted(leg.amount), usd, null, new Set())).toEqual({ kind: 'unchecked' });
    expect(rowCheck({ ...o, view: { ...o.view, config: null } }, leg, quoted(leg.amount), usd, NOW, new Set())).toEqual({ kind: 'unchecked' });
  });
});

describe('checkedOrder: real profit first, then rows not checked, then trips that do not pay', () => {
  it('orders by the checked figure where there is one, and by the listed figure otherwise', () => {
    const rows = [0.95, 0.9, 0.85, 0.8, 0.75].map((d) => opportunity(10 / d).o);
    const [a, b, c, d, e] = rows as [Opportunity, Opportunity, Opportunity, Opportunity, Opportunity];
    const at = (o: Opportunity, check: RowCheck) => ({ o, check });
    const ordered = checkedOrder([
      at(a, { kind: 'loss', usd: -1 }),
      at(b, { kind: 'profit', usd: 0.5 }),
      at(c, { kind: 'unchecked' }),
      at(d, { kind: 'profit', usd: 2 }),
      at(e, { kind: 'no-route' }),
    ]);
    // e lists the most and a the least: listed figures order the groups' insides where nothing was checked.
    expect(e.arb.profitUsd).toBeGreaterThan(a.arb.profitUsd);
    expect(ordered.map((r) => r.o)).toEqual([d, b, c, e, a]);
  });
});
