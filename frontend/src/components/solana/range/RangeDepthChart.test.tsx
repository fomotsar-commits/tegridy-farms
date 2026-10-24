import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { BAYLA_MINT, WSOL_MINT } from '../../../lib/solana/lp/tokenSafety';
import { decodeAmmConfig, decodePoolState, decodeTickArray, sortMints } from '../../../lib/solana/clmm/program';
import { getSqrtPriceAtTick, getTickAtSqrtPrice } from '../../../lib/solana/clmm/math';
import { encodeAmmConfig, encodePool, encodeTickArray, type TickFields } from '../../../lib/solana/clmm/encode.fixture';
import { bandWindow, type BandsWindow } from '../../../lib/solana/clmm/depth';
import { pairOf, type TickRange } from '../../../lib/solana/clmm/rangeMath';
import type { RangePool, Read } from '../../../lib/solana/clmm/read';
import { RangeDepthChart } from './RangeDepthChart';

/**
 * Card 03 as a visitor meets it, on a window built from the program's own byte layout (the
 * views are decoded here: web3's address derivation cannot run under jsdom).
 */

const key = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const POOL = key(4);
const { token0: M0, token1: M1 } = sortMints(new PublicKey(BAYLA_MINT), new PublicKey(WSOL_MINT));
const BAYLA_IS_0 = M0.toBase58() === BAYLA_MINT;
const S = 120;
const SPAN = S * 60;

/** sqrt(price) as Q64.64 for `num/den` SOL per BAYLA, in the pool's own order. */
function sqrtAt(num: bigint, den: bigint): bigint {
  const [n0, d0] = BAYLA_IS_0 ? [num, den] : [den, num];
  const [dec0, dec1] = BAYLA_IS_0 ? [6, 9] : [9, 6];
  const n = (n0 * 10n ** BigInt(dec1)) << 128n;
  const d = d0 * 10n ** BigInt(dec0);
  let x = 1n << 100n;
  for (let i = 0; i < 200; i++) x = (x + n / d / x) >> 1n;
  while (x * x > n / d) x -= 1n;
  return x;
}
const TC = getTickAtSqrtPrice(sqrtAt(4n, 10_000n));
const BASE = Math.floor(TC / S) * S;
const startOf = (t: number) => Math.floor(t / SPAN) * SPAN;
const HERE = startOf(TC);

const L = 10n ** 12n;
// One position around the price, one a band above, one a band below; orders on both sides.
const POSITIONS: [number, number, bigint][] = [
  [BASE - 1_200, BASE + 1_200, L],
  [HERE + SPAN + 1_200, HERE + SPAN + 3_600, L / 2n],
  [HERE - SPAN + 1_200, HERE - SPAN + 3_600, L / 4n],
];
const ORDERS: TickFields[] = [
  { tick: BASE + 600, liquidityNet: 0n, liquidityGross: 0n, ordersAmount: 12_000_000_000n },
  { tick: BASE - 600, liquidityNet: 0n, liquidityGross: 0n, ordersAmount: 4_000_000_000n },
];

const tier = decodeAmmConfig(key(3).toBase58(), encodeAmmConfig({ index: 0, tradeFeeRate: 10_000, protocolFeeRate: 104_000, fundFeeRate: 56_000, tickSpacing: S }))!;

function windowOf(o: { unread?: number[]; each?: number; positions?: [number, number, bigint][]; orders?: TickFields[] } = {}): { w: BandsWindow; pool: RangePool } {
  const positions = o.positions ?? POSITIONS;
  const m = new Map<number, TickFields>();
  for (const [lo, hi, l] of positions) {
    for (const [t, net] of [[lo, l], [hi, -l]] as const) {
      const x = m.get(t) ?? { tick: t, liquidityNet: 0n, liquidityGross: 0n };
      x.liquidityNet += net;
      x.liquidityGross += l;
      m.set(t, x);
    }
  }
  const ticks = [...m.values(), ...(o.orders ?? ORDERS)];
  const starts = [...new Set(ticks.map((t) => startOf(t.tick)))].sort((a, b) => a - b);
  const liquidity = positions.filter(([lo, hi]) => lo <= TC && TC < hi).reduce((a, [, , l]) => a + l, 0n);
  const view = decodePoolState(POOL.toBase58(), encodePool({
    ammConfig: key(3), mint0: M0, mint1: M1, vault0: key(5), vault1: key(6), observation: key(7),
    decimals0: BAYLA_IS_0 ? 6 : 9, decimals1: BAYLA_IS_0 ? 9 : 6, tickSpacing: S, liquidity,
    sqrtPriceX64: getSqrtPriceAtTick(TC) + 1n, tickCurrent: TC, bitmapBits: starts.map((s) => s / SPAN + 512),
  }))!;
  const picked = bandWindow(view, null, o.each);
  const band = (s: number) => decodeTickArray(key(100).toBase58(), encodeTickArray(POOL, s, S, ticks.filter((t) => startOf(t.tick) === s)))!;
  return {
    pool: { pool: view, config: tier },
    w: {
      pool: view,
      extension: null,
      bands: picked.starts.map((start) => (o.unread?.includes(start) ? { start, band: null, detail: 'did not read' } : { start, band: band(start) })),
      beyondBelow: picked.beyondBelow,
      beyondAbove: picked.beyondAbove,
      at: Date.UTC(2026, 9, 24, 14, 2, 11),
    },
  };
}

const RANGE: TickRange = { tickLower: BASE - 1_200, tickUpper: BASE + 1_200 };

function show(o: { read?: Read<BandsWindow> | null; range?: TickRange | null; locked?: boolean; window?: ReturnType<typeof windowOf> } = {}) {
  const x = o.window ?? windowOf();
  const onRange = vi.fn();
  const onStart = vi.fn();
  const onReadAgain = vi.fn();
  render(
    <RangeDepthChart
      pool={x.pool}
      pair={pairOf(x.pool.pool)!}
      read={o.read === undefined ? { kind: 'ok', value: x.w } : o.read}
      onReadAgain={onReadAgain}
      range={o.range === undefined ? RANGE : o.range}
      onRange={onRange}
      onStart={onStart}
      locked={o.locked ?? false}
      market={0.00041}
      positions={[{ tickLower: BASE - 2_400, tickUpper: BASE + 2_400 }]}
    />,
  );
  return { onRange, onStart, onReadAgain, card: screen.getByTestId('range-depth') };
}

describe('card 03, Liquidity', () => {
  it('draws the depth read from the chain with its time, the orders on both sides, and its line', () => {
    const { card } = show();
    expect(card.textContent).toContain('Where the pool’s money sits, by price. Your range is the green band.');
    expect(screen.getByTestId('range-depth-caption').textContent).toBe('SOL per BAYLA · log scale · 3 bands read 14:02:11 UTC');
    expect(screen.getAllByTestId('range-depth-bar').length).toBeGreaterThan(0);
    const orders = screen.getAllByTestId('range-depth-order');
    expect(orders.map((o) => o.getAttribute('data-sells')).sort()).toEqual(['0', '1']);
    expect(screen.getAllByTestId('range-depth-position')).toHaveLength(1);
    expect(screen.queryByTestId('range-depth-beyond')).toBeNull();
  });

  it('an unread band is a hatched gap and the other side still draws', () => {
    const { card } = show({ window: windowOf({ unread: [HERE + SPAN] }) });
    // Off the view at first, and named at its edge; zoomed out, drawn hatched.
    expect(screen.getByTestId(BAYLA_IS_0 ? 'range-depth-off-right' : 'range-depth-off-left').textContent).toContain('a band could not be read');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(card.querySelector('[data-gap="unread"]')).not.toBeNull();
    expect(screen.getByTestId('range-depth-gap-unread').textContent).toBe('could not be read');
    expect(screen.getByTestId('range-depth-caption').textContent).toContain('2 bands read 14:02:11 UTC · 1 could not be read');
    // The band at the price and the one below still draw their bars.
    expect(screen.getAllByTestId('range-depth-bar').length).toBeGreaterThan(0);
    expect(screen.getByTestId('range-depth-picture').getAttribute('aria-label')).toContain('1 band could not be read.');
    expect(screen.getByTestId('range-depth-picture').getAttribute('aria-label')).toContain('Most liquidity sits between');
  });

  it('past the window, the caption says not read and nothing there is drawn as empty', () => {
    const { card } = show({ window: windowOf({ each: 0 }) });
    expect(screen.getByTestId('range-depth-beyond').textContent).toBe('Bands beyond this window were not read.');
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    fireEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(card.querySelectorAll('[data-gap="not-read"]').length).toBeGreaterThan(0);
    // No bar is drawn where nothing was read.
    const bars = screen.getAllByTestId('range-depth-bar');
    expect(bars.length).toBeGreaterThan(0);
    const num = (e: Element, a: string) => Number(e.getAttribute(a));
    for (const g of card.querySelectorAll('[data-gap="not-read"]')) {
      for (const bar of bars) {
        const clear = num(bar, 'x') + num(bar, 'width') <= num(g, 'x') + 0.01 || num(bar, 'x') >= num(g, 'x') + num(g, 'width') - 0.01;
        expect(clear).toBe(true);
      }
    }
  });

  it('a read that failed says so and offers to read again; it never shows an empty pool', () => {
    const { card, onReadAgain } = show({ read: { kind: 'unread', detail: 'the pool did not read' } });
    expect(card.textContent).toContain('The pool’s liquidity could not be read just now (the pool did not read). This does not mean it is empty.');
    expect(card.textContent).not.toContain('Nothing is in this pool yet.');
    fireEvent.click(within(card).getByRole('button', { name: 'Read again' }));
    expect(onReadAgain).toHaveBeenCalled();
  });

  it('a pool with nothing in it says so', () => {
    const { card } = show({ window: windowOf({ positions: [], orders: [] }) });
    expect(card.textContent).toContain('Nothing is in this pool yet.');
  });

  it('says what moves the price 2% each way, from the swap maths', () => {
    show();
    expect(screen.getByTestId('range-depth-move').textContent).toMatch(/^Moves the price 2% up: [\d.,]+ SOL in\. 2% down: [\d.,]+ BAYLA in\.$/);
  });

  it('a tapped bar says what would trade there and the orders resting on it', () => {
    show();
    const pic = screen.getByTestId('range-depth-picture');
    // jsdom lays nothing out: the chart is 343px wide from x = 0; the middle of the view.
    fireEvent.click(pic, { clientX: 171 });
    expect(screen.getByTestId('range-depth-inspect').textContent).toMatch(/^Between [\d.]+ and [\d.]+ SOL per BAYLA: [\d.,]+ BAYLA and [\d.,]+ SOL of liquidity would trade here\.$/);
  });

  it('the chart itself takes no drag: a press and move on it never moves the range', () => {
    const { onRange } = show();
    const pic = screen.getByTestId('range-depth-picture');
    fireEvent.pointerDown(pic, { clientX: 100, pointerType: 'touch' });
    fireEvent.pointerMove(pic, { clientX: 200, pointerType: 'touch' });
    fireEvent.pointerUp(pic, { clientX: 200, pointerType: 'touch' });
    expect(onRange).not.toHaveBeenCalled();
    // Handles show from 768px only; the steps and sliders under 768px only.
    expect(screen.getByTestId('range-depth-handle-lo').className).toMatch(/(^| )hidden( |$)/);
    expect(screen.getByTestId('range-depth-handle-lo').className).toContain('md:block');
    expect(screen.getByTestId('range-depth-steps').className).toContain('md:hidden');
  });

  it('one step up on the lowest price moves that edge one price step, as shown', () => {
    const { onRange } = show();
    fireEvent.click(screen.getByRole('button', { name: 'Lowest price, one step higher' }));
    expect(onRange).toHaveBeenLastCalledWith(BAYLA_IS_0 ? { tickLower: RANGE.tickLower + S, tickUpper: RANGE.tickUpper } : { tickLower: RANGE.tickLower, tickUpper: RANGE.tickUpper - S });
  });

  it('a slider moves its edge, and never past the other one', () => {
    const { onRange } = show();
    const slider = screen.getByRole('slider', { name: 'Highest price' });
    fireEvent.change(slider, { target: { value: String(Number((slider as HTMLInputElement).min)) } });
    const r = onRange.mock.calls.at(-1)![0] as TickRange;
    expect(r.tickUpper - r.tickLower).toBe(S);
  });

  it('a handle moves one step with an arrow key and ten with Shift', () => {
    const { onRange } = show();
    const hi = screen.getByRole('slider', { name: 'Highest price of your range' });
    expect(hi.getAttribute('aria-valuetext')).toMatch(/^[\d.]+ SOL per BAYLA$/);
    fireEvent.keyDown(hi, { key: 'ArrowRight' });
    expect(onRange).toHaveBeenLastCalledWith(BAYLA_IS_0 ? { tickLower: RANGE.tickLower, tickUpper: RANGE.tickUpper + S } : { tickLower: RANGE.tickLower - S, tickUpper: RANGE.tickUpper });
    fireEvent.keyDown(hi, { key: 'ArrowRight', shiftKey: true });
    expect(onRange).toHaveBeenLastCalledWith(BAYLA_IS_0 ? { tickLower: RANGE.tickLower, tickUpper: RANGE.tickUpper + 10 * S } : { tickLower: RANGE.tickLower - 10 * S, tickUpper: RANGE.tickUpper });
  });

  it('while a deposit is under review the edges stay put', () => {
    const { onRange } = show({ locked: true });
    fireEvent.keyDown(screen.getByRole('slider', { name: 'Highest price of your range' }), { key: 'ArrowRight' });
    expect((screen.getByRole('button', { name: 'Lowest price, one step higher' }) as HTMLButtonElement).disabled).toBe(true);
    expect(onRange).not.toHaveBeenCalled();
  });

  it('flips the price, and the readout follows', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Flip to BAYLA per SOL' }));
    expect(screen.getByTestId('range-depth-caption').textContent).toMatch(/^BAYLA per SOL · log scale/);
    expect(screen.getByTestId('range-depth-move').textContent).toMatch(/^Moves the price 2% up: [\d.,]+ BAYLA in\. 2% down: [\d.,]+ SOL in\.$/);
    expect(screen.getByRole('button', { name: 'Flip to SOL per BAYLA' })).toBeInTheDocument();
  });

  it('shows the same bars as a table, the orders in their rows', () => {
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Show as a table' }));
    const table = screen.getByTestId('range-depth-table');
    expect(within(table).getAllByRole('row').length).toBeGreaterThanOrEqual(2);
    expect(table.textContent).toContain('BAYLA to sell at');
    expect(table.textContent).toContain('SOL to buy BAYLA at');
  });

  it('the range is drawn as a green band over the bars', () => {
    const { card } = show();
    const band = screen.getByTestId('range-depth-band');
    const bars = card.querySelectorAll('[data-testid="range-depth-bar"]');
    // Drawn after the bars, so the liquidity inside it reads green.
    expect(bars[bars.length - 1]!.compareDocumentPosition(band) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('with no range picked, one press starts one near the price', () => {
    const { onStart } = show({ range: null });
    fireEvent.click(screen.getByRole('button', { name: 'Start a range near this pool’s price' }));
    expect(onStart).toHaveBeenCalled();
    expect(screen.queryByTestId('range-depth-handle-lo')).toBeNull();
  });
});
