// IS IT ACTUALLY ON SCREEN?
//
// GateAuditPanel's own suite renders the component directly and therefore cannot see
// the failure that matters most here: a fully-built, fully-tested surface that nothing
// mounts. `readGateAudit` sat in this repo with zero consumers precisely that way, and
// CurveChart shipped the same defect (see CurveLaunchPage.test.tsx, "curve chart is
// mounted"). So these assert the DOOR puts the panel in front of the wallet that was
// turned away — and keeps it out of the two states where there is no denial to explain.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const { LaunchGate } = await import('../LaunchGate');

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
    render(<LaunchGate />);
    await screen.findByText('COLD');
    await waitFor(() => expect(toggle()).toBeInTheDocument());
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
  });

  it('STALE carries the panel too — an unreadable door still owes its record', async () => {
    h.fetchHeat.mockRejectedValue(new Error('unreachable'));
    render(<LaunchGate />);
    await screen.findByText('STALE');
    await waitFor(() => expect(toggle()).toBeInTheDocument());
  });

  it('WARM does not — there is no refusal to account for', async () => {
    h.fetchHeat.mockResolvedValue(reading(195.54, 'Builder'));
    render(<LaunchGate />);
    await screen.findByText('WARM');
    expect(toggle()).not.toBeInTheDocument();
  });

  it('no wallet, no panel — nothing has been decided about anybody', async () => {
    h.address = undefined;
    render(<LaunchGate />);
    await screen.findByText(/Connect the Ethereum wallet/i);
    expect(toggle()).not.toBeInTheDocument();
  });
});
