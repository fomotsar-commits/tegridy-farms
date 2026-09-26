import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { WriteGateBanner } from './WriteGateBanner';
import { GraduationPanel, type GraduationPanelProps } from './GraduationPanel';
import { PoolSwapPanel, type PoolSwapPanelProps } from './PoolSwapPanel';
import { useWriteGate } from './useWriteGate';
import { CREATOR, KEY, MINT, SOL, ammConfig, bondingCurve, curveAccount, fakeApi, launchState, openGate } from './fakeWriteApi.fixture';
import type { CurveSignerState } from './useCurveSigner';
import type { GateRpc, LaunchPool, WriteApi, WriteRpc } from './ports';
import type { PoolStateView } from '../../../lib/solana/cpswap/program';
import { WSOL_MINT } from '../../../lib/launcher/solana/curve';

vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const ready: CurveSignerState = {
  kind: 'ready',
  address: CREATOR.toBase58(),
  signer: { publicKey: CREATOR, signTransaction: async (t) => t },
  signMessage: null,
};
const NONE = { create: false, buy: false, sell: false, migrate: false, release: false, poolSwap: false };

// ---------------------------------------------------------------------------
// The banner and the hook behind it
// ---------------------------------------------------------------------------

describe('write gate banner', () => {
  it('renders nothing while writes are off, so the read-only page is unchanged', () => {
    const { container } = render(<WriteGateBanner state={{ status: 'disabled' }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('a failed read says the read failed, and never that the program is missing', () => {
    render(<WriteGateBanner state={{ status: 'ready', api: fakeApi(), cfg: null, gate: { kind: 'blocked', reason: 'unreadable', detail: 'HTTP 503' } }} />);
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/could not read the network/i);
    expect(text).toMatch(/says nothing about the program itself/);
    expect(text).not.toMatch(/is not on this network/);
  });

  it('names the wrong cluster plainly', () => {
    render(<WriteGateBanner state={{ status: 'ready', api: fakeApi(), cfg: null, gate: { kind: 'blocked', reason: 'wrong-cluster', detail: '' } }} />);
    expect(screen.getByText(/not the one it is set up for/)).toBeInTheDocument();
  });

  it('open: prints the programs it read, and says what a pause stops and what it does not', () => {
    const gate = openGate({ paused: true });
    render(<WriteGateBanner state={{ status: 'ready', api: fakeApi(), cfg: gate.cfg, gate }} />);
    expect(screen.getByText(gate.cfg.programId.toBase58())).toBeInTheDocument();
    expect(screen.getByText(/Selling and pool swaps still work/)).toBeInTheDocument();
    expect(screen.getByText(/test network/)).toBeInTheDocument();
  });
});

describe('useWriteGate', () => {
  const rpc = {} as GateRpc;

  it('writes off: never loads the write code', () => {
    const load = vi.fn();
    const { result } = renderHook(() => useWriteGate(rpc, { enabled: false, load }));
    expect(result.current.status).toBe('disabled');
    expect(load).not.toHaveBeenCalled();
  });

  it('a chunk that does not load is load-failed, not open', async () => {
    const load = vi.fn(async () => Promise.reject(new Error('chunk 404')));
    const { result } = renderHook(() => useWriteGate(rpc, { enabled: true, load }));
    await waitFor(() => expect(result.current.status).toBe('load-failed'));
  });

  it('a gate reader that throws closes the gate', async () => {
    const api = fakeApi({ readWriteGate: vi.fn(async () => Promise.reject(new Error('boom'))) });
    const load = vi.fn(async () => api);
    const { result } = renderHook(() => useWriteGate(rpc, { enabled: true, load }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.status === 'ready' && result.current.gate).toMatchObject({ kind: 'blocked', reason: 'unreadable' });
  });

  it('reads the gate with the configured program pair', async () => {
    const api = fakeApi();
    const load = vi.fn(async () => api);
    const { result } = renderHook(() => useWriteGate(rpc, { enabled: true, load }));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(api.readWriteGate).toHaveBeenCalledWith(rpc, openGate().cfg);
  });
});

// ---------------------------------------------------------------------------
// Graduation
// ---------------------------------------------------------------------------

function renderGrad(over: Partial<GraduationPanelProps> = {}) {
  const c = bondingCurve({ realSolReserves: 26n * SOL });
  const props: GraduationPanelProps = {
    api: fakeApi(),
    rpc: {} as WriteRpc,
    gate: openGate(),
    launch: launchState(c),
    curve: curveAccount(c, 26n * SOL + 5_000_000n),
    mint: MINT,
    decimals: 6,
    rentFloor: 2_000_000n,
    actions: { ...NONE, sell: true, migrate: true },
    signerState: ready,
    onSettled: vi.fn(),
    ...over,
  };
  render(<GraduationPanel {...props} />);
  return props;
}

describe('graduation panel', () => {
  it('ready: anyone can finish it, and it builds migrate for the connected payer', async () => {
    const p = renderGrad();
    expect(screen.getByText('Ready to finish now.')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review: finish graduation' }));
    });
    expect(p.api.prepareMigrate).toHaveBeenCalledWith(p.rpc, p.gate, expect.objectContaining({ payer: CREATOR, mint: MINT }));
  });

  it('pool side not set up: says so, and the button stays off', () => {
    renderGrad({ gate: openGate({ graduation: { permission: null, createPoolFeeReceiver: false } }), actions: { ...NONE, sell: true } });
    expect(screen.getByText('could not read')).toBeInTheDocument();
    expect(screen.getByText(/cannot succeed until the pool program side is set up/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review: finish graduation' })).toBeDisabled();
  });

  it('a reserve a lamport short is a pause, not a break', () => {
    const c = bondingCurve({ realSolReserves: 26n * SOL });
    renderGrad({ curve: curveAccount(c, 26n * SOL + 2_000_000n - 1n), actions: { ...NONE, sell: true } });
    expect(screen.getByText(/It is a pause, not a break/)).toBeInTheDocument();
  });

  it('graduated: offers the reserve release until it is released, then says it was', () => {
    const c = bondingCurve({ complete: true, pool: KEY(40) });
    const { unmount } = render(
      <GraduationPanel
        api={fakeApi()}
        rpc={{} as WriteRpc}
        gate={openGate()}
        launch={launchState(c)}
        curve={curveAccount(c)}
        mint={MINT}
        decimals={6}
        rentFloor={2_000_000n}
        actions={{ ...NONE, release: true, poolSwap: true }}
        signerState={ready}
        onSettled={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Review: release platform reserve' })).not.toBeDisabled();
    unmount();
    const r = bondingCurve({ complete: true, pool: KEY(40), platformReserveReleased: true });
    render(
      <GraduationPanel
        api={fakeApi()}
        rpc={{} as WriteRpc}
        gate={openGate()}
        launch={launchState(r)}
        curve={curveAccount(r)}
        mint={MINT}
        decimals={6}
        rentFloor={2_000_000n}
        actions={{ ...NONE, poolSwap: true }}
        signerState={ready}
        onSettled={vi.fn()}
      />,
    );
    expect(screen.getByText(/has been released to the treasury/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /release platform reserve/ })).not.toBeInTheDocument();
  });

  it('renders nothing while the curve is still bonding', () => {
    const c = bondingCurve();
    const { container } = render(
      <GraduationPanel
        api={fakeApi()}
        rpc={{} as WriteRpc}
        gate={openGate()}
        launch={launchState(c)}
        curve={curveAccount(c)}
        mint={MINT}
        decimals={6}
        rentFloor={2_000_000n}
        actions={NONE}
        signerState={ready}
        onSettled={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------
// Pool swaps
// ---------------------------------------------------------------------------

function pool(): LaunchPool {
  const [t0, t1] = [WSOL_MINT, MINT].sort((a, b) => Buffer.compare(a.toBuffer(), b.toBuffer()));
  const view = {
    address: KEY(40).toBase58(),
    ammConfig: KEY(6).toBase58(),
    token0Mint: t0!.toBase58(),
    token1Mint: t1!.toBase58(),
    status: 0,
    openTime: 0n,
    enableCreatorFee: false,
    creatorFeeOn: 0,
  } as unknown as PoolStateView;
  return {
    address: KEY(40),
    ammConfigAddress: KEY(6),
    ammConfig,
    snapshot: { pool: view, vault0Amount: 1_000_000_000_000n, vault1Amount: 1_000_000_000_000n, reserve0: 1_000_000_000_000n, reserve1: 1_000_000_000_000n },
  };
}

function renderPool(over: Partial<PoolSwapPanelProps> = {}) {
  const api: WriteApi = over.api ?? fakeApi();
  const props: PoolSwapPanelProps = {
    api,
    rpc: {} as WriteRpc,
    gate: openGate(),
    mint: MINT,
    pool: { kind: 'ok', value: pool() },
    decimals: 6,
    actions: { ...NONE, poolSwap: true },
    signerState: ready,
    onSettled: vi.fn(),
    ...over,
  };
  render(<PoolSwapPanel {...props} />);
  return props;
}

describe('pool swap panel', () => {
  it('quotes against the launch pool and builds a swap with a non-zero floor', async () => {
    const p = renderPool();
    fireEvent.change(screen.getByLabelText('Amount of SOL to pay in the pool'), { target: { value: '1' } });
    expect(screen.getByText('You receive at least')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review pool buy' }));
    });
    expect(p.api.preparePoolSwap).toHaveBeenCalledWith(
      p.rpc,
      p.gate,
      expect.objectContaining({ owner: CREATOR, mint: MINT, side: 'buy', amountIn: SOL, slippageBps: 100n }),
    );
  });

  it('a pool that does not match graduation is refused, with its reason', () => {
    renderPool({ pool: { kind: 'mismatch', detail: 'the pool uses different fee settings from graduation' } });
    expect(screen.getByText(/does not match what graduation creates \(the pool uses different fee settings/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Review pool/ })).not.toBeInTheDocument();
  });

  it('a pool closed to swaps says so and offers nothing', () => {
    renderPool({ pool: { kind: 'closed-to-swaps', detail: 'not open yet', value: pool() } });
    expect(screen.getByText(/not taking swaps right now: not open yet/)).toBeInTheDocument();
  });

  it('an unreadable pool is a read failure, not an empty pool', () => {
    renderPool({ pool: { kind: 'unreadable', detail: 'HTTP 502' } });
    expect(screen.getByText(/could not be read, so no swap is offered: HTTP 502/)).toBeInTheDocument();
  });

  // F5: the pool opens by the chain's clock. A viewer whose clock is behind the chain
  // right after graduation must still get a quote the chain would honour.
  it("quotes by the chain's clock, not the viewer's, right after the pool opens", () => {
    const openTime = BigInt(Math.floor(Date.now() / 1000) + 3_600); // the viewer's clock is an hour behind
    const p = pool();
    const opened: LaunchPool = {
      ...p,
      chainTime: openTime,
      snapshot: { ...p.snapshot, pool: { ...p.snapshot.pool, openTime } as PoolStateView },
    };
    renderPool({ pool: { kind: 'ok', value: opened } });
    fireEvent.change(screen.getByLabelText('Amount of SOL to pay in the pool'), { target: { value: '1' } });
    expect(screen.queryByText(/would refuse this swap/)).not.toBeInTheDocument();
    expect(screen.getByText('You receive at least')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review pool buy' })).not.toBeDisabled();
  });

  // UX2: the pool fee is shown as an amount, not only a rate.
  it('shows the pool fee amount inside what you pay', () => {
    renderPool();
    fireEvent.change(screen.getByLabelText('Amount of SOL to pay in the pool'), { target: { value: '1' } });
    // 0.25% of 1 SOL, rounded up by the program's ceil_div.
    expect(screen.getByText('Pool fee (inside what you pay)').parentElement).toHaveTextContent('0.0025 SOL');
  });
});
