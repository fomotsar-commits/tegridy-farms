import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import type { PublicKey } from '@solana/web3.js';
import type { LpReaders } from '../components/solana/lp/readers';

// /solana-lp?mint=<mint> opens the REAL pool finder on that token, as /pools?mint= does.
// Only the reads, the wallet stack and LP's mode (reads-only, so no write code) are faked.
const readVenue = vi.fn();
vi.mock('../lib/solana/cpswap/read', () => ({ readVenue: (...a: unknown[]) => readVenue(...a) }));
vi.mock('../lib/launcher/solana/curve/rpc', () => ({ browserCurveRpc: () => ({}) }));
vi.mock('../lib/analytics', () => ({ trackPageView: vi.fn() }));
vi.mock('../components/solana/SolanaProviders', () => ({ SolanaProviders: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('@solana/wallet-adapter-react', () => ({ useWallet: () => ({ publicKey: null }) }));
vi.mock('../components/solana/SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));
const reads = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../components/solana/lp/readers', () => ({ browserLpReaders: () => reads.current }));
vi.mock('../lib/launcher/solana/lpWriteFlag', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/launcher/solana/lpWriteFlag')>()),
  lpWriteMode: () => 'off',
}));

const PROGRAM = 'EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT';
// A real mint (32 bytes of base58), not SOL, which the finder refuses.
const M = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const LIVE = {
  kind: 'live',
  programId: PROGRAM,
  config: {
    address: 'CfG1111111111111111111111111111111111111111',
    index: 0, disableCreatePool: false,
    tradeFeeRate: 2500n, protocolFeeRate: 120_000n, fundFeeRate: 0n,
    createPoolFee: 0n, creatorFeeRate: 0n,
    protocolOwner: 'Own1', fundOwner: 'Own2',
  },
} as const;

function fakeReaders() {
  const unread = { kind: 'unread' as const, detail: 'not read in this test' };
  const r = {
    programId: PROGRAM,
    safety: vi.fn(async (mints: string[]) => new Map(mints.map((m) => [m, { kind: 'unread' as const, mint: m, detail: 'not read' }]))),
    findPools: vi.fn(async (_mint: PublicKey) => ({ ...unread, index: unread })),
    outsidePrice: vi.fn(async () => ({ kind: 'unread' as const, detail: 'not read' })),
    positions: vi.fn(async () => unread),
    feeTiers: vi.fn(async () => unread),
    wallet: vi.fn(async () => { throw new Error('not read in this test'); }),
    placeShareOnChain: vi.fn(async () => { throw new Error('not read in this test'); }),
  };
  reads.current = r as unknown as LpReaders;
  return r;
}

async function mount(path: string) {
  vi.resetModules();
  const { default: SolanaLpPage } = await import('./SolanaLpPage');
  return render(<MemoryRouter initialEntries={[path]}><SolanaLpPage /></MemoryRouter>);
}

beforeEach(() => { vi.clearAllMocks(); readVenue.mockResolvedValue(LIVE); });

describe('the ?mint= link on /solana-lp', () => {
  it('opens the finder on that token: the field holds it and its pools are searched', async () => {
    const r = fakeReaders();
    await mount(`/solana-lp?mint=${M}`);
    expect(await screen.findByTestId('lp-finder')).toBeInTheDocument();
    expect(screen.getByLabelText(/Token mint address/)).toHaveValue(M);
    await waitFor(() => expect(r.findPools).toHaveBeenCalled());
    expect(r.findPools.mock.calls[0]![0].toBase58()).toBe(M);
  });

  it('with no ?mint=, the finder waits for a token and searches nothing', async () => {
    const r = fakeReaders();
    await mount('/solana-lp');
    expect(await screen.findByTestId('lp-finder')).toBeInTheDocument();
    expect(screen.getByLabelText(/Token mint address/)).toHaveValue('');
    expect(r.findPools).not.toHaveBeenCalled();
  });
});

describe('the disclosure on /solana-lp', () => {
  it('points to "The program" on the Venue AMM tab, since it is not below on this page', async () => {
    fakeReaders();
    await mount('/solana-lp');
    const d = await screen.findByTestId('lp-disclosure');
    expect(within(d).getByRole('link', { name: 'on the Venue AMM tab' })).toHaveAttribute('href', '/pools');
    expect(d).not.toHaveTextContent('“The program” below');
    expect(d).toHaveTextContent(/have not had their own independent review yet/);
  });
});
