// The owner's word, 2026-11-11: nothing at the top prompts a launch while no launch is live. Her line,
// mounted, for a wallet at the launch floor and over it, on the screens that are not the launch door.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BaylaLine } from './BaylaLine';
import { __resetFire } from '../lib/fire';
import { setLastReading } from '../lib/heat/heatStore';
import { clearLanded } from '../lib/landed';
import { isLaunchDoorOpen } from '../lib/launcher/door';
import { clearScreenMoves } from '../lib/screenMove';
import type { HeatReading } from '../lib/heat/heatOracle';

vi.mock('wagmi', () => ({ useAccount: () => ({ address: undefined }) }));
vi.mock('../lib/solanaSurface', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/solanaSurface')>()),
  useSolanaSurface: () => ({ surface: null }),
}));

const elder: HeatReading = {
  address: '4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw',
  degrees: 1862.42,
  tier: 'Elder',
  isCold: false,
  heldSinceUnix: 1_642_281_378,
  asOfUnix: 1_762_000_000,
  tokenCount: 14,
  breakdown: [],
  observedAt: 1_762_000_000,
  xHandle: null,
  daysToNextTier: null,
  daysToPlant: 0,
};

beforeEach(() => {
  localStorage.clear();
  // The venue's own skin: no room is entered.
  localStorage.setItem('tegridy-bungalow', 'venue');
  setLastReading(null);
  clearLanded();
  clearScreenMoves();
  __resetFire();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"sealed"}', { status: 502 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Bayla’s line while the launch door is closed', () => {
  it('the door is closed on the venue today: this file is about that state', () => {
    expect(isLaunchDoorOpen()).toBe(false);
  });

  it.each(['/', '/pools', '/solana', '/dashboard', '/yield'])('an Elder on %s reads the move that is live, and no Launch', (path) => {
    setLastReading(elder);
    render(
      <MemoryRouter initialEntries={[path]}>
        <BaylaLine />
      </MemoryRouter>,
    );
    const text = screen.getByTestId('bayla-line-text');
    expect(text).toHaveTextContent('1862.42° Elder. Pick a bungalow and add to its pool.');
    expect(text).not.toHaveTextContent(/door|launch/i);
    const button = screen.getByTestId('bayla-line-button');
    expect(button).toHaveTextContent('Pick');
    expect(button).toHaveAttribute('href', '/#hall');
    expect(screen.queryByRole('link', { name: 'Launch' })).toBeNull();
  });

  it('a Resident right at the floor reads the same line', () => {
    setLastReading({ ...elder, degrees: 80, tier: 'Resident' });
    render(
      <MemoryRouter initialEntries={['/']}>
        <BaylaLine />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('bayla-line-text')).toHaveTextContent('80.00° Resident. Pick a bungalow and add to its pool.');
    expect(screen.queryByRole('link', { name: 'Launch' })).toBeNull();
  });
});
