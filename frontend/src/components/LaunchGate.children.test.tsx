// What the door lets through. A form mounted inside <LaunchGate> renders only when the door
// is open: WARM and proved, or denial dialled off, where the door only informs. COLD and
// STALE keep it out. The launch call still reads the wallet again at submit.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { clearGateAudit } from '../lib/heat/gateAudit';
import { parseHeatReading } from '../lib/heat/heatOracle';

const ADDR = '0x71be63f3384f5fb98995898a86b02fb2426c5788';

const h = vi.hoisted(() => ({ address: undefined as string | undefined, fetchHeat: vi.fn() }));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.address }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...p }: { children?: React.ReactNode }) => <div {...p}>{children}</div> },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../lib/heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => h.fetchHeat(...args),
  isSupportedHeatAddress: () => true,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

// The COLD door draws the countdown, whose roster reads the island's board through the torches read.
vi.mock('../hooks/useIslandTorches', () => ({ useIslandTorches: () => null }));

const { LaunchGate } = await import('./LaunchGate');

function reading(degrees: number, tier: string) {
  const now = Math.floor(Date.now() / 1000);
  return parseHeatReading({
    address: ADDR,
    degrees,
    tier,
    is_cold: false,
    held_since_unix: now - 400 * 86_400,
    as_of_unix: now - 3_600,
    token_count: 1,
    breakdown: [],
  });
}

/** The door, inside the router every page that mounts it has. */
function mountDoor() {
  render(
    <MemoryRouter>
      <LaunchGate rail="ethereum">
        <div data-testid="behind-the-door" />
      </LaunchGate>
    </MemoryRouter>,
  );
}

const behind = () => screen.queryByTestId('behind-the-door');

beforeEach(() => {
  clearGateAudit();
  h.address = ADDR;
  h.fetchHeat.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the door keeps its children out until it opens', () => {
  it('COLD keeps them out', async () => {
    h.fetchHeat.mockResolvedValue(reading(12, 'Observer'));
    mountDoor();
    await screen.findByText('COLD');
    expect(behind()).not.toBeInTheDocument();
  });

  it('STALE keeps them out', async () => {
    h.fetchHeat.mockRejectedValue(new Error('unreachable'));
    mountDoor();
    await screen.findByText('STALE');
    expect(behind()).not.toBeInTheDocument();
  });

  it('WARM keeps them out until the wallet proves it is theirs, then lets them in', async () => {
    h.fetchHeat.mockResolvedValue(reading(195.54, 'Resident'));
    mountDoor();
    await screen.findByText('WARM');
    expect(behind()).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /prove this wallet is yours/i }));
    await screen.findByTestId('behind-the-door');
  });

  it('dialled off, the door only informs: a COLD reading still lets them in', async () => {
    vi.stubEnv('VITE_HEAT_GATE', 'off');
    h.fetchHeat.mockResolvedValue(reading(12, 'Observer'));
    mountDoor();
    await screen.findByText('COLD');
    expect(screen.getByText(/Denial is currently dialled off/)).toBeInTheDocument();
    expect(behind()).toBeInTheDocument();
  });
});
