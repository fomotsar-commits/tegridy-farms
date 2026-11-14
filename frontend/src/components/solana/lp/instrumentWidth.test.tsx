// Every instrument draws one unit to one pixel: as wide as its box, as tall as its own height.
//
// They used to draw on a fixed 320-wide viewBox stretched to the card. On the owner's desktop
// (2026-11-12) the lending floor bar came out 1718 x 311 px with 56 px labels, the "best bid"
// label 175 px off the left edge, and the loan timeline about 400 px tall. jsdom lays nothing
// out, so the box's width is stubbed here; with nothing measured an instrument keeps the 320 it
// was designed at.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState, type ReactElement } from 'react';
import { parseEther } from 'viem';
import { PriceMoveDial } from './PriceMoveDial';
import { PoolTradeDial } from './PoolTradeDial';
import { RangeDrag } from '../range/RangeDrag';
import { RangeHoldingsDial } from '../range/RangeHoldingsDial';
import { LoanTimeline } from '../../nftfinance/LoanTimeline';
import { FloorBar } from '../../nftfinance/FloorBar';
import type { PoolView } from '../../../lib/solana/lp/poolFinder';
import { SOL_QUOTE } from '../../../lib/solana/lp/quotes';
import { BAYLA_MINT, WSOL_MINT } from '../../../lib/solana/lp/tokenSafety';
import { getTickAtSqrtPrice } from '../../../lib/solana/clmm/math';
import { depositFrom, pairOf, parsePrice, rangeFromPrices, sqrtAtPrice, type TickRange } from '../../../lib/solana/clmm/rangeMath';

const view = { config: { tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, creatorFeeRate: 0n }, quote: SOL_QUOTE, quoteReserve: 100_000_000_000n, tokenReserve: 1_000_000n } as unknown as PoolView;
const cost = () => ({ total: parseEther('1'), interest: 0n, toVenue: 0n, toLenders: parseEther('1') });

const pair = pairOf({ tokenMint0: BAYLA_MINT, tokenMint1: WSOL_MINT, mintDecimals0: 6, mintDecimals1: 9, tickSpacing: 120 })!;
const sqrt = sqrtAtPrice(pair, parsePrice('0.0003')!);
const range = rangeFromPrices(pair, parsePrice('0.00015')!, parsePrice('0.0006')!) as TickRange;
const liquidity = depositFrom(pair, { sqrtPriceX64: sqrt, tickCurrent: getTickAtSqrtPrice(sqrt) }, range, 'token', 1_000_000n * 10n ** 6n)!.liquidity;

const INSTRUMENTS: [string, ReactElement, number][] = [
  ['PriceMoveDial', <PriceMoveDial quoteSymbol="SOL" />, 96],
  ['PoolTradeDial', <PoolTradeDial view={view} creatorFeeRate={0n} />, 84],
  ['RangeDrag', <RangeDrag now={0.0004} lo={0.0002} hi={0.0008} at="this pool’s price" setMin={() => {}} setMax={() => {}} />, 64],
  ['RangeHoldingsDial', <RangeHoldingsDial pair={pair} r={range} liquidity={liquidity} now={0.0003} />, 78],
  ['LoanTimeline', <LoanTimeline side="borrower" start={1_800_000_000} duration={30 * 86_400} costAt={cost} nft="NAKA #1" />, 92],
  ['FloorBar', <FloorBar symbol="NAKA" principal={0.07} floor={0.08} bestBid={0.075} setPrincipal={() => {}} />, 58],
];

/** Every box measures `width` px wide, as a laid-out page would report it. */
function boxesAre(width: number) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, toJSON: () => ({}) } as DOMRect);
}
afterEach(() => vi.restoreAllMocks());

describe('instruments draw at their box’s width, never stretched', () => {
  it.each(INSTRUMENTS)('%s', (_name, element, height) => {
    boxesAre(1718);
    const { container } = render(element);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe(`0 0 1718 ${height}`);
    expect(svg.style.height).toBe(`${height}px`);
  });

  it.each(INSTRUMENTS)('%s, before anything is measured: the 320 it was designed at', (_name, element, height) => {
    const { container } = render(element);
    expect(container.querySelector('svg')!.getAttribute('viewBox')).toBe(`0 0 320 ${height}`);
  });
});

// A handle dragged to either end stays whole and off the edge: at least 3 px from every side of
// its picture, stroke and all. The floor bar's sat 2 px from the edge, and the range holdings
// dial's 2.5 px, on its border.
const ROOM = 3;

/** The least room any handle (a circle bigger than a reminder's dot) leaves to an edge. */
function handleRoom(svg: SVGSVGElement): number {
  const [, , w, h] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
  let room = Infinity;
  for (const c of svg.querySelectorAll('circle')) {
    const r = Number(c.getAttribute('r'));
    if (!(r > 3)) continue;
    const half = Number(c.getAttribute('stroke-width') ?? 0) / 2;
    const cx = Number(c.getAttribute('cx'));
    const cy = Number(c.getAttribute('cy'));
    room = Math.min(room, cx - r - half, w - cx - r - half, cy - r - half, h - cy - r - half);
  }
  return room;
}

function Floor({ principal }: { principal: number }) {
  const [v, setV] = useState<number | null>(principal);
  return <FloorBar symbol="NAKA" principal={v} floor={0.08} bestBid={0.075} setPrincipal={(t) => setV(Number(t))} />;
}
const now = 0.0004;
const SLID: [string, () => ReactElement][] = [
  ['PriceMoveDial', () => <PriceMoveDial quoteSymbol="SOL" />],
  ['PoolTradeDial', () => <PoolTradeDial view={view} creatorFeeRate={0n} />],
  ['RangeHoldingsDial', () => <RangeHoldingsDial pair={pair} r={range} liquidity={liquidity} now={0.0003} />],
  ['LoanTimeline', () => <LoanTimeline side="borrower" start={1_800_000_000} duration={30 * 86_400} costAt={cost} nft="NAKA #1" />],
  ['FloorBar', () => <Floor principal={0.07} />],
];

describe('a handle at either end stays clear of the edge', () => {
  it.each([320, 1718])('%s px: each dial, slid all the way down and all the way up', (width) => {
    for (const [name, make] of SLID) {
      boxesAre(width);
      const { container, unmount } = render(make());
      const input = container.querySelector('input[type=range]') as HTMLInputElement;
      for (const end of [input.min, input.max]) {
        fireEvent.change(input, { target: { value: end } });
        expect(handleRoom(container.querySelector('svg')!), `${name} at ${end}`).toBeGreaterThanOrEqual(ROOM);
      }
      unmount();
      vi.restoreAllMocks();
    }
  });

  it.each([320, 1718])('%s px: the floor bar at its least amount, one step', (width) => {
    boxesAre(width);
    const { container } = render(<Floor principal={0.0001} />);
    expect(handleRoom(container.querySelector('svg')!)).toBeGreaterThanOrEqual(ROOM);
  });

  it.each([320, 1718])('%s px: the range drag’s two handles at the axis’s two ends, held large by the keyboard', (width) => {
    boxesAre(width);
    const { container } = render(<RangeDrag now={now} lo={now / 16} hi={now * 16} at="this pool’s price" setMin={() => {}} setMax={() => {}} />);
    expect(handleRoom(container.querySelector('svg')!)).toBeGreaterThanOrEqual(ROOM);
    fireEvent.focus(screen.getByTestId('range-drag-lo'));
    expect(handleRoom(container.querySelector('svg')!)).toBeGreaterThanOrEqual(ROOM);
  });
});
