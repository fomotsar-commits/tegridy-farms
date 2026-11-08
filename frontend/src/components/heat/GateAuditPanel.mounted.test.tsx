// Is the panel on screen? The panel's own suite cannot see a surface nothing mounts, so
// these assert the door shows it to a turned-away wallet and keeps it out of the two
// states with no denial to explain.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { clearGateAudit } from '../../lib/heat/gateAudit';
import { parseHeatReading } from '../../lib/heat/heatOracle';

const ADDR = '0x71be63f3384f5fb98995898a86b02fb2426c5788';

const h = vi.hoisted(() => ({ address: undefined as string | undefined, fetchHeat: vi.fn() }));

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: h.address }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
}));

vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});

// The whole network boundary, in one place: the gate and the embedded card both read
// through it, so one stub drives both halves of the COLD state.
vi.mock('../../lib/heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => h.fetchHeat(...args),
  isSupportedHeatAddress: () => true,
  clearHeatCache: () => {},
  HeatUnavailableError: class HeatUnavailableError extends Error {},
}));

// The countdown's roster reads the island's board through the torches read.
vi.mock('../../hooks/useIslandTorches', () => ({ useIslandTorches: () => null }));

const { LaunchGate } = await import('../LaunchGate');

/** The door, inside the router every page that mounts it has. */
const door = () => render(<MemoryRouter><LaunchGate /></MemoryRouter>);

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

const toggle = () => screen.queryByRole('button', { name: /why did the door answer this way\?/i });

beforeEach(() => {
  clearGateAudit();
  h.address = ADDR;
  h.fetchHeat.mockReset();
});

describe('the door mounts the audit panel where a denied wallet is standing', () => {
  it('COLD carries the panel, collapsed', async () => {
    h.fetchHeat.mockResolvedValue(reading(62.4, 'Observer'));
    door();
    await screen.findByText('COLD');
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('STALE carries the panel too — an unreadable door still owes its record', async () => {
    h.fetchHeat.mockRejectedValue(new Error('unreachable'));
    door();
    await screen.findByText('STALE');
    await waitFor(() => expect(toggle()).toBeInTheDocument());
  });

  it('WARM does not — there is no refusal to account for', async () => {
    h.fetchHeat.mockResolvedValue(reading(195.54, 'Builder'));
    door();
    await screen.findByText('WARM');
    expect(toggle()).not.toBeInTheDocument();
  });

  it('no wallet, no panel — nothing has been decided about anybody', async () => {
    h.address = undefined;
    door();
    await screen.findByText(/Connect the Ethereum wallet/i);
    expect(toggle()).not.toBeInTheDocument();
  });
});

// The countdown's words (island answer twenty-four, build 5): a wallet under 80° is never
// told "Cannot". The door says its reading and the island's line, and the note under the
// card keeps what held time is, with no prose em dash.
describe('the COLD door speaks the countdown’s words', () => {
  it('says the reading and the line, and never cannot', async () => {
    h.fetchHeat.mockResolvedValue(reading(73.89, 'Observer'));
    door();
    await screen.findByText('COLD');
    expect(screen.getByText('This wallet reads 73.89° (Observer). Residents launch here. Nobody can buy last year.')).toBeInTheDocument();
    const why = screen.getByText(/^Warmth is held time\./);
    expect(why.textContent).toContain('Nobody approves this by hand and there is nobody to ask');
    expect(why.textContent).not.toMatch(/larger bag|—|\bcannot\b/i);
  });
});
