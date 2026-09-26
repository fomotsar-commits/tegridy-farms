import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SolanaLaunchView, type LaunchData, type SolanaLaunchViewProps } from './CurveLaunchDetailPage';
import { CurveLaunchView } from './CurveLaunchPage';
import {
  CREATOR,
  MINT,
  SIG,
  bondingCurve,
  fakeApi,
  globalCfg,
  launchState,
  openGate,
} from '../components/solana/curve/fakeWriteApi.fixture';
import type { CurveSignerState } from '../components/solana/curve/useCurveSigner';
import type { WriteApi, WriteGate, WriteRpc } from '../components/solana/curve/ports';

vi.mock('../components/solana/SolanaConnectButton', () => ({
  SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button>,
}));
// The read-only view mounts <LaunchGate>, which reads the EVM wallet.
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined }),
  useSignMessage: () => ({ signMessageAsync: async () => '0x' }),
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

const ready: CurveSignerState = {
  kind: 'ready',
  address: CREATOR.toBase58(),
  signer: { publicKey: CREATOR, signTransaction: async (t) => t },
  signMessage: null,
};

function data(over: Partial<LaunchData> = {}): LaunchData {
  return {
    launch: launchState(bondingCurve()),
    mintFacts: {
      kind: 'ok',
      value: { supply: 1_000_000_000_000_000n, decimals: 6, mintAuthority: null, freezeAuthority: null, isLegacySplToken: true },
    },
    rentFloor: 2_000_000n,
    metadata: { kind: 'absent' },
    json: null,
    openingBuy: { kind: 'ok', value: 50_000_000_000_000n },
    holding: { kind: 'unreadable', detail: 'HTTP 429' },
    pool: null,
    ...over,
  };
}

function renderView(over: Partial<SolanaLaunchViewProps> = {}, api: WriteApi = fakeApi(), gate: WriteGate = openGate()) {
  const props: SolanaLaunchViewProps = {
    gateState: { status: 'ready', api, cfg: openGate().cfg, gate },
    mint: MINT,
    data: data(),
    pending: null,
    signerState: ready,
    writeRpc: {} as WriteRpc,
    onSettled: vi.fn(),
    onRecheckPending: vi.fn(),
    recheckingPending: false,
    ...over,
  };
  render(
    <MemoryRouter>
      <SolanaLaunchView {...props} />
    </MemoryRouter>,
  );
  return props;
}

describe('the launch page', () => {
  it('writes off: says so, and offers nothing', () => {
    renderView({ gateState: { status: 'disabled' } });
    expect(screen.getByText(/not switched on here yet/)).toBeInTheDocument();
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
  });

  it('always carries the not-endorsed line and the full mint', () => {
    renderView();
    expect(screen.getByText(/Not endorsed by Tegridy\. Anyone can launch here\./)).toBeInTheDocument();
    expect(screen.getAllByText(MINT.toBase58()).length).toBeGreaterThan(0);
  });

  it("shows the creator's opening buy as a share of supply, and an unread holding as 'could not read', never 0", () => {
    renderView();
    const stake = screen.getByTestId('creator-stake');
    expect(stake.textContent).toMatch(/5\.00% of supply/);
    expect(stake.textContent).toMatch(/Creator holds now \(main token account\)could not read/);
  });

  it('a launch that was just sent and is not on chain yet says "not found yet", never "no launch"', () => {
    const p = renderView({
      data: data({ launch: launchState(null) }),
      pending: { signature: SIG, sentAt: Date.now(), lastValidBlockHeight: 99 },
    });
    expect(screen.getByText(/Not found yet\. Your launch may still be landing/)).toBeInTheDocument();
    expect(screen.queryByText('No launch at this address')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(p.onRecheckPending).toHaveBeenCalled();
  });

  it('no curve and nothing pending: says there is no launch at this address', () => {
    renderView({ data: data({ launch: launchState(null) }) });
    expect(screen.getByText('No launch at this address')).toBeInTheDocument();
  });

  it('bonding: the trade panel is there and graduation is not', () => {
    renderView();
    expect(screen.getByTestId('curve-trade-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('graduation-panel')).not.toBeInTheDocument();
  });

  it('paused: selling stays available on the page', () => {
    const g = globalCfg({ paused: true });
    const api = fakeApi({ writeActions: vi.fn(() => ({ create: false, buy: false, sell: true, migrate: false, release: false, poolSwap: false })) });
    renderView({ data: data({ launch: launchState(bondingCurve(), g) }) }, api, openGate({ paused: true, global: g }));
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByLabelText('Amount of tokens to sell')).not.toBeDisabled();
  });

  it('graduated: pool panel and reserve release, no curve trading', () => {
    const c = bondingCurve({ complete: true });
    const api = fakeApi({ writeActions: vi.fn(() => ({ create: true, buy: false, sell: false, migrate: false, release: true, poolSwap: true })) });
    renderView({ data: data({ launch: launchState(c), pool: { kind: 'unreadable', detail: 'HTTP 500' } }) }, api);
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('pool-swap-panel')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review: release platform reserve' })).toBeInTheDocument();
    // Graduation empties the curve's real reserves: its progress, "SOL raised" and
    // spot would read as a confident 0% / 0 SOL / stale price next to the live pool.
    expect(screen.getByTestId('curve-closed')).toHaveTextContent(/The curve closed at graduation/);
    expect(screen.queryByText('Spot price')).not.toBeInTheDocument();
    expect(screen.queryByText('SOL raised (curve reserves)')).not.toBeInTheDocument();
    expect(screen.queryByText('Raised toward graduation')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  });

  // L1: a trade this browser sent and could not confirm survives a reload. Until the
  // chain answers, no trade form is shown for the mint.
  it('a trade still landing from before a reload: shows it, and no buy, sell, graduation or pool form', () => {
    const recheck = vi.fn();
    const dismiss = vi.fn();
    const note = { kind: 'buy' as const, signature: SIG, lastValidBlockHeight: 99, sentAt: Date.now() };
    renderView({ pendingTrade: { notes: [note], checking: false, message: 'The network has no record of it yet.', recheck, dismiss } });
    expect(screen.getByTestId('pending-trade')).toHaveTextContent(/Sent, not confirmed yet\. Trading here stays off/);
    expect(screen.getByTestId('pending-trade')).toHaveTextContent(SIG);
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('graduation-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pool-swap-panel')).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/fail/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(recheck).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'I checked my wallet: start over' }));
    expect(dismiss).toHaveBeenCalled();
  });

  it('while the first check is running, still no trade form', () => {
    const note = { kind: 'sell' as const, signature: SIG, lastValidBlockHeight: null, sentAt: Date.now() };
    renderView({ pendingTrade: { notes: [note], checking: true, message: null, recheck: vi.fn(), dismiss: vi.fn() } });
    expect(screen.getByText('Checking it on the network…')).toBeInTheDocument();
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
  });

  // UX2: the page people trade on carries the venue, fee and loss facts, from the chain.
  it('shows "before you trade": venue, curve and pool fees, LP burn, the reserve, total loss', () => {
    renderView();
    const card = screen.getByTestId('before-you-trade');
    expect(card).toHaveTextContent(/only on this site/);
    expect(card).toHaveTextContent(/not on Jupiter/);
    expect(card).toHaveTextContent('1.00% fee: 50.00% of it goes to the creator and 50.00% to the platform');
    expect(card).toHaveTextContent('the pool charges 0.25% per trade; 12.00% of that goes to the platform');
    expect(card).toHaveTextContent(/creator gets nothing from pool trades/);
    expect(card).toHaveTextContent(/3\.69% of the supply is held back as the platform reserve.*may sell it/);
    expect(card).toHaveTextContent(/You can lose everything/);
  });

  it('a blocked gate shows the reason and no action panels', () => {
    renderView({}, fakeApi(), { kind: 'blocked', reason: 'launch-program-missing', detail: '' });
    expect(screen.getByText(/launch program is not on this network/)).toBeInTheDocument();
    expect(screen.queryByTestId('curve-trade-panel')).not.toBeInTheDocument();
    // The state is still read and shown.
    expect(screen.getByText('Curve state')).toBeInTheDocument();
  });
});

describe('/curve-launch with the write section', () => {
  const base = {
    probe: { kind: 'deployed', executable: true } as const,
    snapshot: null,
    mint: null,
    mintInput: '',
    onMintInput: vi.fn(),
    onLookup: vi.fn(),
    loading: false,
  };

  it('open gate: the write section replaces the read-only cards and the EVM heat gate', () => {
    render(
      <MemoryRouter>
        <CurveLaunchView {...base} gateBanner={<p>gate banner</p>} write={<p>write section</p>} />
      </MemoryRouter>,
    );
    expect(screen.getByText('write section')).toBeInTheDocument();
    expect(screen.getByText('gate banner')).toBeInTheDocument();
    expect(screen.queryByText(/cannot be listed/)).not.toBeInTheDocument();
    expect(screen.queryByText(/no signing path on this page/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Open a launch')).not.toBeInTheDocument();
  });

  it('no write section: today\'s read-only page, unchanged', () => {
    render(
      <MemoryRouter>
        <CurveLaunchView {...base} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/no signing path on this page/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be listed/)).toBeInTheDocument();
  });
});
