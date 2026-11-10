import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RangeHoldingsDial } from './RangeHoldingsDial';
import { BAYLA_MINT, WSOL_MINT } from '../../../lib/solana/lp/tokenSafety';
import { FORECAST_WORDS } from '../../../lib/solana/lp/format';
import { getTickAtSqrtPrice } from '../../../lib/solana/clmm/math';
import { HOLDINGS_STOPS, holdingsAt, holdingsPrice, holdingsStop } from '../../../lib/solana/clmm/rangeHoldings';
import { depositFrom, pairOf, parsePrice, priceNumber, rangeFromPrices, rangePrices, sqrtAtPrice, type Pair, type TickRange } from '../../../lib/solana/clmm/rangeMath';

// BAYLA (6 decimals) against SOL (9), with the token as the pool's token 0 and again as its
// token 1: the pool keeps its price the other way round then, and every end swaps over.
const PAIRS: [string, Pair][] = [
  ['token is token 0', pairOf({ tokenMint0: BAYLA_MINT, tokenMint1: WSOL_MINT, mintDecimals0: 6, mintDecimals1: 9, tickSpacing: 120 })!],
  ['token is token 1', pairOf({ tokenMint0: WSOL_MINT, tokenMint1: BAYLA_MINT, mintDecimals0: 9, mintDecimals1: 6, tickSpacing: 120 })!],
];
const NOW = 0.0003; // SOL per BAYLA

describe.each(PAIRS)('%s', (_, pair) => {
  const sqrt = sqrtAtPrice(pair, parsePrice('0.0003')!);
  const pool = { sqrtPriceX64: sqrt, tickCurrent: getTickAtSqrtPrice(sqrt) };
  const r = rangeFromPrices(pair, parsePrice('0.00015')!, parsePrice('0.0006')!) as TickRange;
  // 1,000,000 BAYLA typed: the form's own plan.
  const plan = depositFrom(pair, pool, r, 'token', 1_000_000n * 10n ** 6n)!;
  const [planToken, planCoin] = pair.tokenIsToken0 ? [plan.amount0, plan.amount1] : [plan.amount1, plan.amount0];
  const min = priceNumber(rangePrices(pair, r).min);
  const max = priceNumber(rangePrices(pair, r).max);

  describe('what the same liquidity is at another price', () => {
    it('at the price it was planned at, it holds what the deposit puts in (a withdrawal rounds down)', () => {
      const h = holdingsAt(pair, r, plan.liquidity, NOW)!;
      expect(h.where).toBe('inside');
      // Within a millionth of the plan: the plan rounds up, a withdrawal down, and the price
      // goes through a decimal string on the way.
      expect(Number(h.token) / Number(planToken)).toBeCloseTo(1, 5);
      expect(Number(h.coin) / Number(planCoin)).toBeCloseTo(1, 5);
      expect(h.token).toBeLessThanOrEqual(planToken);
    });

    it('under the range it is all token, and more of it than at the start', () => {
      const h = holdingsAt(pair, r, plan.liquidity, min / 1.5)!;
      expect(h.where).toBe('below');
      expect(h.coin).toBe(0n);
      expect(h.token).toBeGreaterThan(planToken);
      expect(h.tokenShare).toBe(1);
      // Further under changes nothing: the position stopped trading at the edge.
      expect(holdingsAt(pair, r, plan.liquidity, min / 3)!.token).toBe(h.token);
    });

    it('over the range it is all of the pairing coin', () => {
      const h = holdingsAt(pair, r, plan.liquidity, max * 1.5)!;
      expect(h.where).toBe('above');
      expect(h.token).toBe(0n);
      expect(h.coin).toBeGreaterThan(planCoin);
      expect(h.tokenShare).toBe(0);
    });

    it('as the price rises through the range it sells token for coin, all the way', () => {
      let lastToken: bigint | null = null;
      let lastCoin: bigint | null = null;
      for (let s = 0; s <= HOLDINGS_STOPS; s += 10) {
        const h = holdingsAt(pair, r, plan.liquidity, holdingsPrice(min, max, s))!;
        if (lastToken !== null) expect(h.token).toBeLessThanOrEqual(lastToken);
        if (lastCoin !== null) expect(h.coin).toBeGreaterThanOrEqual(lastCoin);
        lastToken = h.token;
        lastCoin = h.coin;
      }
    });

    it('has nothing to say without liquidity or a real price', () => {
      expect(holdingsAt(pair, r, 0n, NOW)).toBeNull();
      for (const bad of [0, -1, NaN, Infinity]) expect(holdingsAt(pair, r, plan.liquidity, bad)).toBeNull();
    });
  });

  describe('the dial on the range form', () => {
    const slider = () => screen.getByRole('slider') as HTMLInputElement;
    const text = (id: string) => screen.getByTestId(id).textContent ?? '';

    it('opens at the price now, inside the range, holding both', () => {
      render(<RangeHoldingsDial pair={pair} r={r} liquidity={plan.liquidity} now={NOW} />);
      expect(screen.getByTestId('range-holdings').dataset.where).toBe('inside');
      expect(slider().value).toBe(String(holdingsStop(min, max, NOW)));
      // The phone guard's 16px rule for every input (see lp/sliderFont.test.tsx).
      expect(slider().style.fontSize).toBe('16px');
      expect(text('range-holdings-headline')).toMatch(/BAYLA and .* SOL$/);
      expect(text('range-holdings-at')).toMatch(/^at 0\.000\d+ SOL per BAYLA$/);
      expect(text('range-holdings-line')).toBe('Inside your range it holds both, and earns from swaps.');
    });

    it('dragged under the range: all BAYLA, earning nothing', () => {
      render(<RangeHoldingsDial pair={pair} r={r} liquidity={plan.liquidity} now={NOW} />);
      fireEvent.change(slider(), { target: { value: '0' } });
      expect(screen.getByTestId('range-holdings').dataset.where).toBe('below');
      expect(text('range-holdings-headline')).toMatch(/BAYLA and 0 SOL$/);
      expect(text('range-holdings-line')).toBe('Under your range it is all BAYLA, and earns nothing until the price comes back.');
    });

    it('dragged over the range: all SOL, earning nothing', () => {
      render(<RangeHoldingsDial pair={pair} r={r} liquidity={plan.liquidity} now={NOW} />);
      fireEvent.change(slider(), { target: { value: String(HOLDINGS_STOPS) } });
      expect(screen.getByTestId('range-holdings').dataset.where).toBe('above');
      expect(text('range-holdings-headline')).toMatch(/^0 BAYLA and /);
      expect(text('range-holdings-line')).toBe('Over your range it is all SOL, and earns nothing until the price comes back.');
    });

    it('never uses a forecast word, at any stop', () => {
      const { container } = render(<RangeHoldingsDial pair={pair} r={r} liquidity={plan.liquidity} now={NOW} />);
      for (let s = 0; s <= HOLDINGS_STOPS; s += 20) {
        fireEvent.change(slider(), { target: { value: String(s) } });
        expect(container.textContent).not.toMatch(FORECAST_WORDS);
        expect(slider().getAttribute('aria-valuetext')).not.toMatch(FORECAST_WORDS);
      }
    });

    it('draws nothing until the form has a plan', () => {
      const { container } = render(<RangeHoldingsDial pair={pair} r={r} liquidity={null} now={NOW} />);
      expect(container).toBeEmptyDOMElement();
    });
  });
});
