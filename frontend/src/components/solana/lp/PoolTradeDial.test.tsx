import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { PoolTradeDial, PoolTradeDialWhenOpen } from './PoolTradeDial';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { FORECAST_WORDS } from '../../../lib/solana/lp/format';
import { SOL_QUOTE, USDC_QUOTE } from '../../../lib/solana/lp/quotes';
import { DEPTH_STOPS, depthPoint, moveText, sizeAtStop } from '../../../lib/solana/lp/tradeDepth';

// A 1% tier of which the venue takes 16%: the pool's providers keep 0.84% of a trade.
const TIER = { tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, creatorFeeRate: 5_000n };
const SOL = 1_000_000_000n;
const view = (over: Partial<PoolView> = {}): PoolView =>
  ({ config: TIER, quote: SOL_QUOTE, quoteReserve: 100n * SOL, tokenReserve: 1_000_000n, ...over }) as unknown as PoolView;

describe('one buy\'s arithmetic', () => {
  it('sizes run from 0.01% of the reserve to a quarter of it', () => {
    expect(sizeAtStop(100n * SOL, 0)).toBe(SOL / 100n);
    expect(sizeAtStop(100n * SOL, DEPTH_STOPS)).toBe(25n * SOL);
    expect(sizeAtStop(100n * SOL, 999)).toBe(25n * SOL);
    expect(sizeAtStop(0n, 50)).toBe(0n);
    // Log-spaced: the middle stop is the geometric mean, 0.5% of the reserve.
    expect(sizeAtStop(100n * SOL, 50)).toBe(SOL / 2n);
  });

  it('splits the trade fee as the pool does: 1% of the buy, 16% of that to the venue', () => {
    const p = depthPoint(100n * SOL, 10n * SOL, TIER, 0n)!;
    expect(p.lpKeeps + p.venueTakes).toBe(SOL / 10n); // 0.1 SOL trade fee
    expect(p.venueTakes).toBe(16_000_000n); // 0.016 SOL
    expect(p.lpKeeps).toBe(84_000_000n); // 0.084 SOL
    expect(p.creatorTakes).toBe(0n);
  });

  it('adds the creator fee only for a pool that charges one', () => {
    expect(depthPoint(100n * SOL, 10n * SOL, TIER, 5_000n)!.creatorTakes).toBe(50_000_000n); // 0.5%
  });

  it('moves the price by (1 + net/reserve)^2 - 1', () => {
    // 10 SOL in, 9.9 after the trade fee, against 100: 1.099^2 - 1 = 20.78%.
    expect(depthPoint(100n * SOL, 10n * SOL, TIER, 0n)!.move).toBeCloseTo(0.207801, 6);
    // The same buy against a pool ten times deeper moves it about a tenth as far.
    expect(depthPoint(1000n * SOL, 10n * SOL, TIER, 0n)!.move).toBeCloseTo(0.019898, 6);
  });

  it('has nothing to say of an empty pool or a buy of nothing', () => {
    expect(depthPoint(0n, SOL, TIER, 0n)).toBeNull();
    expect(depthPoint(SOL, 0n, TIER, 0n)).toBeNull();
  });

  it('writes a move to about two figures', () => {
    expect(moveText(0.00004)).toBe('under 0.01');
    expect(moveText(0.0041)).toBe('0.41');
    expect(moveText(0.041)).toBe('4.1');
    expect(moveText(0.5625)).toBe('56');
  });
});

describe('the dial on a pool\'s card', () => {
  const slider = () => screen.getByRole('slider') as HTMLInputElement;
  const text = (id: string) => screen.getByTestId(id).textContent ?? '';

  it('opens on a buy of 0.5% of the pool and says who that buy pays', () => {
    render(<PoolTradeDial view={view()} creatorFeeRate={0n} />);
    expect(text('lp-trade-dial-headline')).toBe('A 0.5 SOL buy moves the price up about 0.99%');
    expect(text('lp-trade-dial-paid')).toBe('Liquidity providers keep 0.0042 SOL of it, the venue 0.0008 SOL.');
  });

  it('dragged to the largest buy it shows how hard a quarter of the pool hits the price', () => {
    render(<PoolTradeDial view={view()} creatorFeeRate={0n} />);
    fireEvent.change(slider(), { target: { value: String(DEPTH_STOPS) } });
    expect(text('lp-trade-dial-headline')).toBe('A 25 SOL buy moves the price up about 56%');
    expect(text('lp-trade-dial-paid')).toBe('Liquidity providers keep 0.21 SOL of it, the venue 0.04 SOL.');
  });

  it('names the creator\'s cut on a pool that charges one, in the pool\'s own coin', () => {
    render(<PoolTradeDial view={view({ quote: USDC_QUOTE, quoteReserve: 100_000_000n })} creatorFeeRate={5_000n} />);
    fireEvent.change(slider(), { target: { value: String(DEPTH_STOPS) } });
    expect(text('lp-trade-dial-headline')).toBe('A 25 USDC buy moves the price up about 56%');
    expect(text('lp-trade-dial-paid')).toBe('Liquidity providers keep 0.21 USDC of it, the venue 0.04 USDC, the pool’s creator 0.125 USDC.');
    expect(slider().getAttribute('aria-label')).toBe('Size of one buy, in USDC');
  });

  it('never uses a forecast word, at any stop', () => {
    const { container } = render(<PoolTradeDial view={view()} creatorFeeRate={5_000n} />);
    for (let stop = 0; stop <= DEPTH_STOPS; stop += 10) {
      fireEvent.change(slider(), { target: { value: String(stop) } });
      expect(container.textContent).not.toMatch(FORECAST_WORDS);
      expect(slider().getAttribute('aria-valuetext')).not.toMatch(FORECAST_WORDS);
    }
  });

  it('draws nothing for a pool whose fee tier or reserves were not read', () => {
    for (const v of [view({ config: null }), view({ quoteReserve: 0n }), view({ tokenReserve: 0n })]) {
      const { container, unmount } = render(<PoolTradeDial view={v} creatorFeeRate={0n} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('inside a fold it is drawn only while the fold is open', () => {
    render(
      <details data-testid="fold">
        <summary>More</summary>
        <PoolTradeDialWhenOpen view={view()} creatorFeeRate={0n} />
      </details>,
    );
    expect(screen.queryByTestId('lp-trade-dial')).toBeNull();
    const fold = screen.getByTestId('fold') as HTMLDetailsElement;
    fold.open = true;
    fireEvent(fold, new Event('toggle'));
    expect(screen.getByTestId('lp-trade-dial')).toBeTruthy();
    fold.open = false;
    fireEvent(fold, new Event('toggle'));
    expect(screen.queryByTestId('lp-trade-dial')).toBeNull();
  });
});
