// Authorization pinning for AdminPage's two-role gate.
//
// This page used to admit exactly one identity: TegridyStaking's owner. Launcher fee
// withdrawal had to widen that, because the Airlock debits msg.sender and the integrator
// is a DIFFERENT wallet from the owner (verified on-chain: owner 0x1489…456E vs
// integrator 0xD355…1051) — gating on `isOwner` alone would have shown "Not Authorized"
// to the only wallet that can move the money.
//
// Widening an admin gate is the kind of change that silently over-grants, so the
// asymmetry is pinned in both directions: the integrator gets the fees panel and NOTHING
// else, and a stranger still gets nothing at all.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Address } from 'viem';

const OWNER = '0x14898258122c0740106391e6e8e4f17F3b6D456E' as Address;
const INTEGRATOR = '0xD355A072d6bBbA275DBD83A3149f6347b06d1051' as Address;
const STRANGER = '0x00000000000000000000000000000000000000bb' as Address;

const account = { address: undefined as Address | undefined, isConnected: true };

vi.mock('wagmi', () => ({
  useAccount: () => account,
  useChainId: () => 1,
  useChains: () => [{ id: 1, name: 'Ethereum', blockExplorers: { default: { url: 'https://etherscan.io' } } }],
  // owner() — the page's existing role source.
  useReadContract: () => ({ data: OWNER, isLoading: false, refetch: vi.fn() }),
  useReadContracts: () => ({ data: [], error: null, refetch: vi.fn() }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, error: null }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
}));

vi.mock('@rainbow-me/rainbowkit', () => ({
  ConnectButton: { Custom: () => null },
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));

// Stubbed so this spec is about the GATE, not the panel's internals (covered by
// IntegratorFeesPanel.test.tsx).
vi.mock('../components/launcher/IntegratorFeesPanel', () => ({
  IntegratorFeesPanel: () => <div data-testid="fees-panel" />,
}));

import AdminPage from './AdminPage';

beforeEach(() => {
  vi.clearAllMocks();
  account.address = undefined;
  account.isConnected = true;
});

describe('AdminPage role gate', () => {
  it('refuses a wallet that is neither owner nor integrator', () => {
    account.address = STRANGER;
    render(<AdminPage />);

    expect(screen.getByText(/Not Authorized/i)).toBeInTheDocument();
    expect(screen.queryByTestId('fees-panel')).not.toBeInTheDocument();
  });

  it('admits the integrator, and shows it ONLY the fees panel', () => {
    account.address = INTEGRATOR;
    render(<AdminPage />);

    expect(screen.queryByText(/Not Authorized/i)).not.toBeInTheDocument();
    expect(screen.getByTestId('fees-panel')).toBeInTheDocument();
    // The widened gate must not leak owner surfaces.
    expect(screen.queryByText(/Emergency Controls/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Swap Fee Router/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Tegridy Staking/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/OWNER/)).not.toBeInTheDocument();
    expect(screen.getByText(/INTEGRATOR/)).toBeInTheDocument();
  });

  it('still gives the owner every existing surface, plus the panel', () => {
    account.address = OWNER;
    render(<AdminPage />);

    expect(screen.getByText(/Emergency Controls/i)).toBeInTheDocument();
    expect(screen.getByText(/Swap Fee Router/i)).toBeInTheDocument();
    expect(screen.getByTestId('fees-panel')).toBeInTheDocument();
    expect(screen.getByText(/OWNER/)).toBeInTheDocument();
  });

  it('matches roles case-insensitively', () => {
    account.address = INTEGRATOR.toLowerCase() as Address;
    render(<AdminPage />);
    expect(screen.queryByText(/Not Authorized/i)).not.toBeInTheDocument();
  });
});
