// /launch says under its door, in every state of it, that this is a venue launch, and
// says nothing of a plant: the Ethereum rail's plant waits (island answer 16, ruling 4).
// The real page and door are mounted; the network and the heavy panels are stubbed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PLANT_LINE, VENUE_LINE } from '../components/launcher/venueLaunchCopy';
import { clearGateAudit } from '../lib/heat/gateAudit';
import { parseHeatReading } from '../lib/heat/heatOracle';

const EVM = '0x71be63f3384f5fb98995898a86b02fb2426c5788';
const h = vi.hoisted(() => ({ address: undefined as string | undefined, fetchHeat: vi.fn() }));

vi.mock('wagmi', async (orig) => ({
  ...(await orig<typeof import('wagmi')>()),
  useAccount: () => ({ address: h.address, isConnected: !!h.address }),
  useChainId: () => 1,
  usePublicClient: () => undefined,
  useWalletClient: () => ({ data: undefined }),
  useReadContract: () => ({ data: undefined }),
  useReadContracts: () => ({ data: [] }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../lib/analytics', () => ({ trackPageView: () => {} }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));
vi.mock('../components/launcher/LaunchExplorer', () => ({ LaunchExplorer: () => null }));
vi.mock('../components/launcher/GardenLane', () => ({ GardenLane: () => null }));
vi.mock('../components/launcher/LaunchAfterlife', () => ({ LaunchAfterlife: () => null }));
vi.mock('../components/launcher/LaunchRadar', () => ({ LaunchRadar: () => null }));
vi.mock('../components/launcher/GraduationVenuePanel', () => ({ GraduationVenuePanel: () => null }));
vi.mock('../components/launcher/LaunchBuyPanel', () => ({ LaunchBuyPanel: () => null }));
vi.mock('../lib/heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => h.fetchHeat(...args),
  isSupportedHeatAddress: () => true,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

const { default: LaunchPage } = await import('./LaunchPage');

function reading(degrees: number, tier: string) {
  const now = Math.floor(Date.now() / 1000);
  return parseHeatReading({
    address: EVM,
    degrees,
    tier,
    is_cold: false,
    held_since_unix: now - 400 * 86_400,
    as_of_unix: now - 3_600,
    token_count: 1,
    breakdown: [],
  });
}

function expectVenueLineUnderTheDoor() {
  const door = screen.getByRole('region', { name: 'Who may plant' });
  const lines = screen.getByTestId('venue-launch-lines');
  expect(door.nextElementSibling).toBe(lines);
  expect(Array.from(lines.querySelectorAll('p')).map((p) => p.textContent)).toEqual([VENUE_LINE]);
  const text = document.body.textContent ?? '';
  expect(text).not.toContain(PLANT_LINE);
  expect(text).not.toMatch(/island coin|born in \$?BAYLA/i);
}

beforeEach(() => {
  clearGateAudit();
  h.address = undefined;
  h.fetchHeat.mockReset();
});

const mount = () => render(<MemoryRouter><LaunchPage /></MemoryRouter>);

describe('/launch: the venue line under the door, and no plant line', () => {
  it('no wallet', () => {
    mount();
    expectVenueLineUnderTheDoor();
  });

  it('reading', async () => {
    h.address = EVM;
    h.fetchHeat.mockReturnValue(new Promise(() => {}));
    mount();
    await screen.findByText(/against the island.s instrument/);
    expectVenueLineUnderTheDoor();
  });

  for (const [state, degrees, tier] of [
    ['COLD', 12, 'Observer'],
    ['WARM', 195.54, 'Resident'],
  ] as const) {
    it(state, async () => {
      h.address = EVM;
      h.fetchHeat.mockResolvedValue(reading(degrees, tier));
      mount();
      await screen.findByText(state);
      expectVenueLineUnderTheDoor();
    });
  }

  it('STALE', async () => {
    h.address = EVM;
    h.fetchHeat.mockRejectedValue(new Error('unreachable'));
    mount();
    await screen.findByText('STALE');
    expectVenueLineUnderTheDoor();
  });
});
