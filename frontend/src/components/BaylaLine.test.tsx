// Island answer twenty-four, build 4: Bayla's line under the nav, mounted. The stranger's
// line with no reading; the wallet's line once the card has read one; the farm's own pages
// keep their voice; the intel line comes from a read and is left out when there is none.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BaylaLine } from './BaylaLine';
import { __resetFire } from '../lib/fire';
import { setLastReading } from '../lib/heat/heatStore';
import { clearLanded, markLanded } from '../lib/landed';
import type { HeatReading } from '../lib/heat/heatOracle';

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock('../lib/solanaSurface', () => ({ useSolanaSurface: () => ({ surface: null }) }));

const reading: HeatReading = {
  address: '0x1111111111111111111111111111111111111111',
  degrees: 12.34,
  tier: 'Observer',
  isCold: false,
  heldSinceUnix: 1_700_000_000,
  asOfUnix: 1_762_000_000,
  tokenCount: 2,
  breakdown: [],
  observedAt: 1_762_000_000,
  xHandle: null,
  daysToNextTier: null,
  daysToPlant: null,
};

function mount(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <BaylaLine />
    </MemoryRouter>,
  );
}

const fireAnswer = (body: unknown, ok = true) => vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 502 }));

beforeEach(() => {
  localStorage.clear();
  setLastReading(null);
  clearLanded();
  __resetFire();
  vi.stubGlobal('fetch', fireAnswer({ error: 'sealed' }, false));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BaylaLine', () => {
  it('a stranger reads the no-wallet line with Read heat, and no intel while the fire is unread', async () => {
    mount('/pools');
    expect(screen.getByTestId('bayla-line-text')).toHaveTextContent('Your held time already has a number. Paste any wallet.');
    expect(screen.getByRole('link', { name: 'Read heat' })).toHaveAttribute('href', '/');
    await act(async () => {});
    expect(screen.queryByTestId('bayla-intel')).toBeNull();
  });

  it('speaks from the reading the card made, on another route', () => {
    setLastReading(reading);
    mount('/solana');
    expect(screen.getByTestId('bayla-line-text')).toHaveTextContent('12.34° Observer. Pick a bungalow and add to its pool.');
    expect(screen.getByRole('link', { name: 'Pick' })).toHaveAttribute('href', '/#hall');
  });

  it('after an add it says Done for a minute, with Receipt', () => {
    setLastReading(reading);
    markLanded('add');
    mount('/pools');
    expect(screen.getByTestId('bayla-line-text')).toHaveTextContent('Done. Your fee went to the island. Read it.');
    expect(screen.getByRole('link', { name: 'Receipt' })).toHaveAttribute('href', '/dashboard');
  });

  it('the intel line is the fire’s week, read once, and never a zero', async () => {
    vi.stubGlobal('fetch', fireAnswer({ week: { burned: 339866 } }));
    mount('/');
    await act(async () => {});
    expect(screen.getByTestId('bayla-intel')).toHaveTextContent('The fire took 339,866 $BAYLA this week.');
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/aggregator?resource=fire');
    cleanup();
    __resetFire();
    vi.stubGlobal('fetch', fireAnswer({ week: { burned: 0 } }));
    mount('/');
    await act(async () => {});
    expect(screen.queryByTestId('bayla-intel')).toBeNull();
  });

  it('a door landing keeps its first screen: nothing on /pools with a task, the line on /pools itself', () => {
    mount('/pools?mint=7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump&task=add');
    expect(screen.queryByTestId('bayla-line')).toBeNull();
    cleanup();
    mount('/pools?mint=7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    expect(screen.getByTestId('bayla-line')).toBeInTheDocument();
  });

  it('the farm keeps its own voice: nothing on /toweli', () => {
    mount('/toweli');
    expect(screen.queryByTestId('bayla-line')).toBeNull();
  });
});
