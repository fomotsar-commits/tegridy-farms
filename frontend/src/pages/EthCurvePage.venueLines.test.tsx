// /eth-curve says under its door, in every state of it, that this is a venue launch, and
// says nothing of a plant: the Ethereum rail's plant waits (island answer 16, ruling 4).
// The real door is mounted here; only the network and the heavy panels are stubbed.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PLANT_LINE, VENUE_LINE } from '../components/launcher/venueLaunchCopy';
import { clearGateAudit } from '../lib/heat/gateAudit';
import { parseHeatReading } from '../lib/heat/heatOracle';

const EVM = '0x71be63f3384f5fb98995898a86b02fb2426c5788';
const h = vi.hoisted(() => ({ address: undefined as string | undefined, fetchHeat: vi.fn() }));

vi.mock('wagmi', () => ({
  useChainId: () => 1,
  useReadContracts: () => ({ data: [] }),
  useAccount: () => ({ address: h.address }),
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
vi.mock('../components/ui/FeatureNotDeployed', () => ({ FeatureNotDeployed: () => null }));
vi.mock('../components/ui/WrongChainGuard', () => ({ WrongChainBanner: () => null }));
vi.mock('../components/launcher/CurveCreatePanel', () => ({ CurveCreatePanel: () => <div data-testid="create-form" /> }));
vi.mock('../components/launcher/CurveTradePanel', () => ({ CurveTradePanel: () => null }));
vi.mock('../components/launcher/CurveLaunchesGrid', () => ({ CurveLaunchesGrid: () => null }));
vi.mock('../lib/heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => h.fetchHeat(...args),
  isSupportedHeatAddress: () => true,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

const { default: EthCurvePage } = await import('./EthCurvePage');

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
  expect(document.body.textContent ?? '').not.toContain(PLANT_LINE);
  return lines;
}

beforeEach(() => {
  clearGateAudit();
  h.address = undefined;
  h.fetchHeat.mockReset();
});

const mount = () => render(<MemoryRouter><EthCurvePage /></MemoryRouter>);

describe('/eth-curve: the venue line under the door, and no plant line', () => {
  it('no wallet', () => {
    mount();
    expectVenueLineUnderTheDoor();
    expect(screen.queryByTestId('create-form')).not.toBeInTheDocument();
  });

  it('reading', async () => {
    h.address = EVM;
    h.fetchHeat.mockReturnValue(new Promise(() => {}));
    mount();
    await screen.findByText(/against the island.s instrument/);
    expectVenueLineUnderTheDoor();
  });

  it('COLD', async () => {
    h.address = EVM;
    h.fetchHeat.mockResolvedValue(reading(12, 'Observer'));
    mount();
    await screen.findByText('COLD');
    expectVenueLineUnderTheDoor();
    expect(screen.queryByTestId('create-form')).not.toBeInTheDocument();
  });

  it('STALE', async () => {
    h.address = EVM;
    h.fetchHeat.mockRejectedValue(new Error('unreachable'));
    mount();
    await screen.findByText('STALE');
    expectVenueLineUnderTheDoor();
    expect(screen.queryByTestId('create-form')).not.toBeInTheDocument();
  });

  it('WARM: once the wallet proves itself, the form follows the line, outside the door', async () => {
    h.address = EVM;
    h.fetchHeat.mockResolvedValue(reading(195.54, 'Resident'));
    mount();
    await screen.findByText('WARM');
    expectVenueLineUnderTheDoor();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Prove this wallet is yours' }));
    });
    const lines = expectVenueLineUnderTheDoor();
    expect(lines.nextElementSibling).toBe(screen.getByTestId('create-form'));
  });
});
