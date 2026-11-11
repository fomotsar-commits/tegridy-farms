/**
 * BETWEEN THE HOST'S CHUNK AND THE PAGE'S. /pools loads in two steps: this host, then
 * PoolsPage. The host's fallback for a panel was the page skeleton, the word "Loading..." over a
 * heading the visitor was already reading. Opened on /pools itself, that panel keeps the frame
 * (components/PoolsFrame.tsx); every other tab, and every later visit, keeps the skeleton.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false }),
  useChainId: () => 1,
  useSwitchChain: () => ({ switchChain: vi.fn() }),
}));
// A chunk that has not arrived: the panel suspends for the whole test.
const pending = new Promise<never>(() => undefined);
const Arriving = () => { throw pending; };
vi.mock('./PoolsPage', () => ({ default: Arriving }));
vi.mock('./LiquidityPage', () => ({ default: Arriving }));
vi.mock('../components/zap/ZapPage', () => ({ default: Arriving }));

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-first-frame');
  window.history.replaceState(null, '', '/');
});

/** The host, loaded as on a fresh document that opened on `address`, then drawn at `at`. */
async function hostOpenedOn(address: string, framePainted: boolean, at = address) {
  vi.resetModules();
  window.history.replaceState(null, '', address);
  if (framePainted) document.documentElement.setAttribute('data-first-frame', 'venue');
  const { default: PoolsHostPage } = await import('./PoolsHostPage');
  render(<MemoryRouter initialEntries={[at]}><PoolsHostPage /></MemoryRouter>);
  return screen.findByRole('tabpanel');
}

describe("the pools host, while the page's chunk arrives", () => {
  it('keeps the heading on screen under the strip, and never says Loading, when the document opened on /pools', async () => {
    const panel = await hostOpenedOn('/pools', true);
    expect(panel.querySelector('[aria-busy="true"] h1')?.textContent).toBe('Liquidity pools.');
    expect(panel.textContent).not.toMatch(/loading/i);
    expect(screen.getByRole('tab', { name: 'Venue AMM' })).toHaveAttribute('aria-selected', 'true');
  });

  it('keeps the page skeleton on /pools when no frame was painted', async () => {
    const panel = await hostOpenedOn('/pools', false);
    expect(panel.querySelector('h1')).toBeNull();
    expect(panel.querySelector('[aria-label="Loading page"]')).not.toBeNull();
  });

  it('keeps the page skeleton on another tab, whatever the document opened on', async () => {
    const panel = await hostOpenedOn('/pools', true, '/zap');
    expect(panel.querySelector('h1')).toBeNull();
    expect(panel.querySelector('[aria-label="Loading page"]')).not.toBeNull();
  });
});
