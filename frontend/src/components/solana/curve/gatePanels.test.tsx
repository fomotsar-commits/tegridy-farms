import { describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { WriteGateBanner } from './WriteGateBanner';
import { GraduationPanel, type GraduationPanelProps } from './GraduationPanel';
import { PoolSwapPanel, type PoolSwapPanelProps } from './PoolSwapPanel';
import { useWriteGate } from './useWriteGate';
import {
  CREATOR,
  KEY,
  MINT,
  SIG,
  SOL,
  ammConfig,
  bondingCurve,
  curveAccount,
  fakeApi,
  launchState,
  openGate,
  prepared,
} from './fakeWriteApi.fixture';
import type { CurveSignerState } from './useCurveSigner';
import type { GateRpc, LaunchPool, WriteApi, WriteRpc } from './ports';
import type { PoolStateView } from '../../../lib/solana/cpswap/program';
import {
  PLATFORM_TREASURY_VAULT,
  WSOL_MINT,
  describeReserveRecipient,
  type BondingCurve,
  type TreasuryDescription,
} from '../../../lib/launcher/solana/curve';

vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const ready: CurveSignerState = {
  kind: 'ready',
  address: CREATOR.toBase58(),
  signer: { publicKey: CREATOR, signTransaction: async (t) => t },
  signMessage: null,
};
const NONE = { create: false, buy: false, sell: false, migrate: false, poolSwap: false };

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
    expect(screen.getByText(/cannot succeed until the pool side is set up/)).toBeInTheDocument();
    // F13: the readiness rows are pool-program detail, kept behind "Technical details".
    expect(screen.getByText('could not read').closest('details')).toHaveTextContent(/^Technical details/);
    expect(screen.getByRole('button', { name: 'Review: finish graduation' })).toBeDisabled();
  });

  it('a reserve a lamport short is a pause, not a break', () => {
    const c = bondingCurve({ realSolReserves: 26n * SOL });
    renderGrad({ curve: curveAccount(c, 26n * SOL + 2_000_000n - 1n), actions: { ...NONE, sell: true } });
    expect(screen.getByText(/It is a pause, not a break/)).toBeInTheDocument();
  });

  it('graduated: the reserve reads as paid at creation, and there is nothing to release', () => {
    const c = bondingCurve({ complete: true, pool: KEY(40) });
    const grad = (curve: BondingCurve, gate = openGate(), treasury?: TreasuryDescription) =>
      render(
        <GraduationPanel
          api={fakeApi()}
          rpc={{} as WriteRpc}
          gate={gate}
          treasury={treasury}
          launch={launchState(curve)}
          curve={curveAccount(curve)}
          mint={MINT}
          decimals={6}
          rentFloor={2_000_000n}
          actions={{ ...NONE, poolSwap: true }}
          signerState={ready}
          onSettled={vi.fn()}
        />,
      );
    // Who was paid comes from the launch's own create transaction, never from today's
    // config: here today's config names the vault, and the launch paid KEY(7).
    const vaultToday = openGate({ global: { ...openGate().global, feeRecipient: PLATFORM_TREASURY_VAULT } });
    grad(c, vaultToday, describeReserveRecipient(KEY(7)));
    const card = screen.getByTestId('graduation-panel');
    expect(card).toHaveTextContent(
      `Paid when this token was created, to the platform treasury (${KEY(7).toBase58()}). Graduation did not touch it.`,
    );
    expect(card.textContent ?? '').not.toMatch(/multisig|release/i);
    expect(screen.queryByRole('button', { name: /release/i })).not.toBeInTheDocument();
    cleanup();
    // The known vault is the only recipient called a multisig, when THAT is who was paid.
    grad(c, openGate(), describeReserveRecipient(PLATFORM_TREASURY_VAULT));
    expect(screen.getByTestId('graduation-panel')).toHaveTextContent('Paid when this token was created, to the platform treasury (a multisig).');
    cleanup();
    // Not read: no address and no claim, even though today's config is the vault.
    grad(c, vaultToday);
    expect(screen.getByTestId('graduation-panel')).toHaveTextContent('Paid when this token was created, to the platform treasury at the time.');
    expect(screen.getByTestId('graduation-panel').textContent ?? '').not.toMatch(/multisig/);
    cleanup();
    // An account that does not record the payment is described as exactly that.
    grad(bondingCurve({ complete: true, pool: KEY(40), platformReserveReleased: false }));
    expect(screen.getByTestId('graduation-panel')).toHaveTextContent(/does not record the platform reserve as paid/);
    expect(screen.getByTestId('graduation-panel').textContent ?? '').not.toMatch(/Paid when/);
  });

  // UXR7: a finished graduation flips the phase to 'graduated' while its result is
  // still on screen; the card must not then be titled "Platform reserve".
  it('a graduation that just finished keeps its own title over its result', async () => {
    const api = fakeApi({
      prepareMigrate: vi.fn(async () => ({ ok: true as const, prepared: prepared({ kind: 'migrate', mint: MINT, pool: KEY(40) }) })),
      submitPrepared: vi.fn(async () => ({ status: 'confirmed' as const, signature: SIG, slot: 1 })),
    });
    const c = bondingCurve({ realSolReserves: 26n * SOL });
    const props: GraduationPanelProps = {
      api,
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
    };
    const view = render(<GraduationPanel {...props} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review: finish graduation' }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in wallet' }));
    });
    expect(screen.getByText(/Done\. The network confirmed it\./)).toBeInTheDocument();
    // The page reads the chain again: the launch is now graduated.
    const g = bondingCurve({ complete: true, pool: KEY(40) });
    view.rerender(
      <GraduationPanel {...props} launch={launchState(g)} curve={curveAccount(g)} actions={{ ...NONE, poolSwap: true }} />,
    );
    expect(screen.getByText(/Done\. The network confirmed it\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Finish graduation');
    expect(screen.queryByText('Platform reserve')).not.toBeInTheDocument();
    // Closing it shows the graduated card, with focus on its heading: it has no button now.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2, name: 'Graduated' }));
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
    fireEvent.change(screen.getByLabelText('Pay (SOL)'), { target: { value: '1' } });
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

  // UX-1: a phone set to a comma-decimal region has "," and no "." on this keypad.
  it('reads a comma typed in the amount as the decimal point; a pasted "68,066" is refused, never 68.066', async () => {
    const p = renderPool();
    const amount = screen.getByLabelText('Pay (SOL)') as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '68,066' } });
    expect(amount).toHaveValue('68,066');
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Review pool buy' })).toBeDisabled();
    fireEvent.change(amount, { target: { value: '' } });
    for (const k of '0,5') fireEvent.change(amount, { target: { value: amount.value + k } });
    expect(amount).toHaveValue('0.5');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review pool buy' }));
    });
    expect(p.api.preparePoolSwap).toHaveBeenCalledWith(p.rpc, p.gate, expect.objectContaining({ side: 'buy', amountIn: SOL / 2n }));
  });

  // F7/UX5: the pool's sell side had no balance and no Max either.
  it('the sell side shows what the wallet holds and Max fills it exactly; an unread balance offers no Max', () => {
    renderPool({ walletHolding: { kind: 'ok', value: 1_234_500_000n } });
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByTestId('your-holding')).toHaveTextContent('You hold 1,234.5');
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    expect(screen.getByLabelText('Sell (tokens)')).toHaveValue('1234.5');
  });

  it('an unread pool-side balance says so and offers no Max', () => {
    renderPool({ walletHolding: { kind: 'unreadable', detail: 'HTTP 500' } });
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByText(/You hold: could not read/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Max' })).not.toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText('Pay (SOL)'), { target: { value: '1' } });
    expect(screen.queryByText(/would refuse this swap/)).not.toBeInTheDocument();
    expect(screen.getByText('You receive at least')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review pool buy' })).not.toBeDisabled();
  });

  // UXR8: a tiny amount turned Review off with no reason given.
  it('an amount too small to receive anything says so', () => {
    renderPool();
    fireEvent.change(screen.getByLabelText('Pay (SOL)'), { target: { value: '0.000000001' } });
    expect(screen.getByText(/This amount is too small/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review pool buy' })).toBeDisabled();
  });

  // UXR8: with pool swaps off, the form's controls stayed usable, unlike the curve panel.
  it('pool swaps off: the amount, the sides, Max and the tolerance are all off too', () => {
    renderPool({ actions: { ...NONE }, walletHolding: { kind: 'ok', value: 5_000_000n } });
    expect(screen.getByText('Pool swaps are not available right now.')).toBeInTheDocument();
    expect(screen.getByLabelText('Pay (SOL)')).toBeDisabled();
    expect(screen.getByLabelText('Other slippage percent')).toBeDisabled();
    for (const b of screen.getAllByRole('button', { name: /^(0\.5|1|3)%$/ })) expect(b).toBeDisabled();
    expect(screen.getByRole('button', { name: 'sell' })).toBeDisabled();
  });

  // R6-2: graduation opens the pool with the creator fee allowed; once a rate is set
  // it is charged on top, and the panel must show it rather than hide it.
  it('a pool with a creator fee shows its rate and the amount, on top of the pool fee', () => {
    const p = pool();
    const withCreator: LaunchPool = {
      ...p,
      ammConfig: { ...ammConfig, creatorFeeRate: 1_000n },
      snapshot: { ...p.snapshot, pool: { ...p.snapshot.pool, enableCreatorFee: true, creatorFeeOn: 0 } as PoolStateView },
    };
    renderPool({ pool: { kind: 'ok', value: withCreator } });
    expect(screen.getByText('Creator fee (on top of the pool fee)').parentElement).toHaveTextContent('0.10%');
    fireEvent.change(screen.getByLabelText('Pay (SOL)'), { target: { value: '1' } });
    expect(screen.getByText('Creator fee (on top, from what you pay)').parentElement).toHaveTextContent('0.001 SOL');
  });

  it('a pool whose creator fee is switched off shows none, whatever its settings say', () => {
    const p = pool();
    renderPool({ pool: { kind: 'ok', value: { ...p, ammConfig: { ...ammConfig, creatorFeeRate: 1_000n } } } });
    expect(screen.queryByText(/Creator fee/)).not.toBeInTheDocument();
  });

  // UX2: the pool fee is shown as an amount, not only a rate.
  it('shows the pool fee amount inside what you pay', () => {
    renderPool();
    fireEvent.change(screen.getByLabelText('Pay (SOL)'), { target: { value: '1' } });
    // 0.25% of 1 SOL, rounded up by the program's ceil_div.
    expect(screen.getByText('Pool fee (inside what you pay)').parentElement).toHaveTextContent('0.0025 SOL');
  });
});
