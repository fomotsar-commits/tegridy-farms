/**
 * THE HEADING DOES NOT FADE IN OVER ITSELF. Opened on /pools itself, the static frame and
 * React's fallback already show "Liquidity pools." (components/PoolsFrame.test.tsx), so the
 * page's own heading starts drawn. Only that first mount: any later one is a navigation, and
 * it keeps its entrance. Read through framer's own first render, with no motion mock.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The venue is still being read for the whole test: the page's first render is what is pinned.
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: () => new Promise(() => undefined) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}), browserRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../components/solana/lp/SolanaLpSection', () => ({ default: () => <div data-testid="lp-section" /> }));

beforeAll(async () => { await import('./PoolsPage'); }, 60_000);

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-first-frame');
  window.history.replaceState(null, '', '/');
});

/** The page, loaded as on a fresh document that opened on `address`. */
async function opened(address: string, framePainted: boolean) {
  vi.resetModules();
  window.history.replaceState(null, '', address);
  if (framePainted) document.documentElement.setAttribute('data-first-frame', 'venue');
  const { default: PoolsPage } = await import('./PoolsPage');
  return () => render(<MemoryRouter initialEntries={['/pools']}><PoolsPage /></MemoryRouter>);
}

/** Does the heading's block start hidden, as an entrance does? */
const startsHidden = () => (screen.getByRole('heading', { level: 1, name: 'Liquidity pools.' }).parentElement as HTMLElement).style.opacity === '0';

describe("the pools page's heading, over a frame that already shows it", () => {
  it('starts drawn when the document opened on /pools with its frame painted', async () => {
    const mount = await opened('/pools', true);
    mount();
    expect(startsHidden()).toBe(false);
  });

  it('keeps its entrance on the next mount in the same document: that one is a navigation', async () => {
    const mount = await opened('/pools', true);
    mount();
    expect(startsHidden()).toBe(false);
    cleanup();
    mount();
    expect(startsHidden()).toBe(true);
  });

  it.each([
    ['/pools', false, 'the stock shell painted no frame'],
    ['/swap', true, 'the document opened on another page'],
  ])('keeps its entrance when the document opened on %s (frame painted: %s): %s', async (address, painted) => {
    const mount = await opened(address, painted);
    mount();
    expect(startsHidden()).toBe(true);
  });
});
