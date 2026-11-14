// Island answer thirty-two: THE FLASH's head on the receipt card, for an add of liquidity (any token).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FloorHead } from './FloorHead';
// The engine needs a canvas context (jsdom has none): the head is proven here, the engine by the island's WebKit harness.
const engine = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), setLps: vi.fn() }));
vi.mock('../lib/floorMoment', async () => {
  const real = await vi.importActual<typeof import('../lib/floorMoment')>('../lib/floorMoment');
  return {
    ...real,
    startFloorMoment: (o: unknown) => {
      engine.start(o);
      return { stop: engine.stop, setLps: engine.setLps };
    },
  };
});
const WALLET = '8SxYtKrtPZoEwtgpkXmn7TrS7VGa1qSiGPHnYjfFWQuv';
beforeEach(() => {
  engine.start.mockClear();
  engine.stop.mockClear();
  engine.setLps.mockClear();
});
afterEach(cleanup);
describe('the floor head', () => {
  it('starts the moment once, on the head canvas, the ring and a fx canvas on the body, with the token and the wallet', () => {
    render(<FloorHead state="playing" wallet={WALLET} symbol="BAYLA" lps={11} />);
    expect(engine.start).toHaveBeenCalledTimes(1);
    const o = engine.start.mock.calls[0]?.[0] as { head: unknown; fx: unknown; ring: unknown; state: string; wallet: string; symbol: string; lps: number | null; reduced: boolean };
    expect(o.head).toBe(screen.getByTestId('floor-canvas'));
    expect(o.ring).toBe(screen.getByTestId('floor-ring'));
    expect(o.fx).toBe(screen.getByTestId('floor-fx'));
    expect(o).toMatchObject({ state: 'playing', wallet: WALLET, symbol: 'BAYLA', lps: 11 });
    // jsdom cannot say whether motion is wanted: the engine is told reduced (lib/heat/ticks.ts reducedMotion).
    expect(o.reduced).toBe(true);
    // The fx canvas is over the whole screen, outside the card: on the body, not in the head.
    expect(screen.getByTestId('floor-fx').parentElement).toBe(document.body);
    expect(screen.getByTestId('floor-head').contains(screen.getByTestId('floor-fx'))).toBe(false);
    // The ring holds the drop until the engine lights it (data-floor is the engine's to set).
    expect(screen.getByTestId('floor-ring').dataset.floor).toBeUndefined();
  });
  it("colors the ring and the card's lit edge from the token's hue: Bayla's green for $BAYLA, its own for any other", () => {
    const { rerender } = render(<FloorHead state="playing" wallet={WALLET} symbol="BAYLA" lps={null} />);
    expect(screen.getByTestId('floor-head').style.getPropertyValue('--floor-hue')).toBe('130,255,120');
    rerender(<FloorHead state="playing" wallet={WALLET} symbol="WIF" lps={null} />);
    const wif = screen.getByTestId('floor-head').style.getPropertyValue('--floor-hue');
    expect(wif).toMatch(/^\d+,\d+,\d+$/);
    expect(wif).not.toBe('130,255,120');
  });
  it('hands a later LP count to the running moment instead of starting it again', () => {
    const { rerender } = render(<FloorHead state="playing" wallet={WALLET} symbol="PEPE" lps={null} />);
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect((engine.start.mock.calls[0]?.[0] as { lps: number | null }).lps).toBeNull();
    expect(engine.setLps).not.toHaveBeenCalled();
    rerender(<FloorHead state="playing" wallet={WALLET} symbol="PEPE" lps={16} />);
    expect(engine.start).toHaveBeenCalledTimes(1);
    expect(engine.setLps).toHaveBeenCalledTimes(1);
    expect(engine.setLps).toHaveBeenLastCalledWith(16);
    expect(engine.stop).not.toHaveBeenCalled();
  });
  it('lets the callbacks change without restarting, and the newest ones are the ones called', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<FloorHead state="playing" wallet={WALLET} symbol="BAYLA" lps={3} onLanded={first} />);
    rerender(<FloorHead state="playing" wallet={WALLET} symbol="BAYLA" lps={3} onLanded={second} />);
    expect(engine.start).toHaveBeenCalledTimes(1);
    const o = engine.start.mock.calls[0]?.[0] as { onLanded: () => void; onBeat: (n: number) => void };
    o.onLanded();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
  it('opens at rest for a card raised again (lit), and stops the moment and takes the fx canvas off the body when it goes', () => {
    const { unmount } = render(<FloorHead state="lit" wallet={WALLET} symbol="BAYLA" lps={11} />);
    expect((engine.start.mock.calls[0]?.[0] as { state: string }).state).toBe('lit');
    expect(document.body.querySelector('[data-testid="floor-fx"]')).not.toBeNull();
    unmount();
    expect(engine.stop).toHaveBeenCalledTimes(1);
    expect(document.body.querySelector('[data-testid="floor-fx"]')).toBeNull();
  });
});

