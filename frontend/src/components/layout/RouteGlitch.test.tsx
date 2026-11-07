import { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, useNavigate, type NavigateFunction } from 'react-router-dom';
import { BUNGALOWS, bungalowLpDoor } from '../../lib/bungalows';
import { RouteGlitch } from './RouteGlitch';

/**
 * The glitch between pages (owner, 2026-10-25, from the island's answer twenty-two): never on a
 * phone, held either way, and never into or out of the LP road (a room with an Add door, the
 * Pools pages). Everywhere else on a computer or a tablet it stays, art and all.
 */

vi.mock('../GlitchTransition', () => ({ GlitchTransition: () => <div data-testid="glitch" /> }));

const doorRoom = BUNGALOWS.find((b) => bungalowLpDoor(b));
const plainRoom = BUNGALOWS.find((b) => !bungalowLpDoor(b));

function Steer({ onNavigate }: { onNavigate: (go: NavigateFunction) => void }) {
  const go = useNavigate();
  useEffect(() => { onNavigate(go); }, [go, onNavigate]);
  return null;
}

function screenAs(width: number, height: number, coarse: boolean) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  window.matchMedia = ((q: string) => ({
    matches: q.includes('pointer: coarse') ? coarse : false,
    media: q, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** Mount on `from`, go to `to`: did the glitch show? */
async function glitched(from: string, to: string): Promise<boolean> {
  let go: NavigateFunction = () => {};
  const view = render(<MemoryRouter initialEntries={[from]}><Steer onNavigate={(n) => { go = n; }} /><RouteGlitch /></MemoryRouter>);
  await act(async () => { go(to); });
  // The lazy chunk is mocked, so a glitch that shows does so at once.
  const shown = (await screen.findAllByTestId('glitch', {}, { timeout: 300 }).catch(() => [])).length > 0;
  view.unmount();
  return shown;
}

const realMatchMedia = window.matchMedia;
beforeEach(() => { screenAs(1280, 800, false); });
afterEach(() => { window.matchMedia = realMatchMedia; });

describe('on a computer', () => {
  it('the rooms and pools under test exist', () => {
    expect(doorRoom).toBeDefined();
    expect(plainRoom).toBeDefined();
  });

  it('keeps the glitch between pages off the LP road', async () => {
    expect(await glitched('/', '/earn')).toBe(true);
    expect(await glitched('/earn', '/gallery')).toBe(true);
    expect(await glitched('/', `/${plainRoom!.id}`)).toBe(true);
  });

  it('no glitch into a room with an Add door, or out of it', async () => {
    expect(await glitched('/', `/${doorRoom!.id}`)).toBe(false);
    expect(await glitched(`/${doorRoom!.id}`, '/earn')).toBe(false);
  });

  it('no glitch into or out of the Pools pages, under any of their paths', async () => {
    expect(await glitched(`/${doorRoom!.id}`, '/pools')).toBe(false);
    expect(await glitched('/pools', '/')).toBe(false);
    for (const path of ['/range-pools', '/liquidity', '/zap', '/solana-lp']) {
      expect(await glitched('/swap', path)).toBe(false);
    }
  });
});

describe('on a phone', () => {
  it('no glitch at all, held upright', async () => {
    screenAs(390, 844, true);
    expect(await glitched('/', '/earn')).toBe(false);
    expect(await glitched('/earn', '/gallery')).toBe(false);
  });

  it('no glitch at all, held sideways', async () => {
    screenAs(844, 390, true);
    expect(await glitched('/', '/earn')).toBe(false);
  });
});

describe('on a tablet', () => {
  it('keeps the glitch off the LP road, as on a computer', async () => {
    screenAs(1024, 1366, true);
    expect(await glitched('/', '/earn')).toBe(true);
    expect(await glitched('/', '/pools')).toBe(false);
  });
});
