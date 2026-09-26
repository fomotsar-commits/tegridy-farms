import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CurveTradePanel, type CurveTradePanelProps } from './CurveTradePanel';
import { CREATOR, MINT, SOL, bondingCurve, curveAccount, fakeApi, globalCfg, launchState, openGate } from './fakeWriteApi.fixture';
import { quoteBuyOnCurve, quoteSellOnCurve } from '../../../lib/launcher/solana/curve';
import type { CurveSignerState } from './useCurveSigner';
import type { WriteRpc } from './ports';

vi.mock('../SolanaConnectButton', () => ({ SolanaConnectButton: () => <button type="button">Connect Solana Wallet</button> }));

const ready: CurveSignerState = {
  kind: 'ready',
  address: CREATOR.toBase58(),
  signer: { publicKey: CREATOR, signTransaction: async (t) => t },
  signMessage: null,
};

function renderPanel(over: Partial<CurveTradePanelProps> = {}) {
  const api = over.api ?? fakeApi();
  const curve = curveAccount(bondingCurve());
  const props: CurveTradePanelProps = {
    api,
    rpc: {} as WriteRpc,
    gate: openGate(),
    launch: launchState(curve.curve),
    curve,
    mint: MINT,
    decimals: 6,
    rentFloor: 2_000_000n,
    actions: { create: true, buy: true, sell: true, migrate: false, release: false, poolSwap: false },
    signerState: ready,
    onSettled: vi.fn(),
    ...over,
  };
  render(<CurveTradePanel {...props} />);
  return { api, props };
}

describe('curve trade panel', () => {
  it('quotes a buy from the program arithmetic and builds it with the chosen tolerance', async () => {
    const { api } = renderPanel();
    fireEvent.change(screen.getByLabelText('Amount of SOL to spend'), { target: { value: '0.5' } });
    expect(screen.getByText('You pay (at most)')).toBeInTheDocument();
    expect(screen.getByText('You receive at least')).toBeInTheDocument();
    expect(screen.getByText('creator 50.00% · protocol 50.00% of the fee')).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review buy' }));
    });
    expect(api.prepareCurveBuy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'open' }),
      expect.objectContaining({ trader: CREATOR, mint: MINT, lamportsIn: SOL / 2n, slippageBps: 100n }),
    );
  });

  it('paused: buying says why and is off, selling stays on', () => {
    const g = globalCfg({ paused: true });
    const curve = curveAccount(bondingCurve());
    renderPanel({
      gate: openGate({ paused: true, global: g }),
      launch: launchState(curve.curve, g),
      actions: { create: false, buy: false, sell: true, migrate: false, release: false, poolSwap: false },
    });
    expect(screen.getByText(/Buys are paused\. Selling is still open/)).toBeInTheDocument();
    expect(screen.getByLabelText('Amount of SOL to spend')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByLabelText('Amount of tokens to sell')).not.toBeDisabled();
  });

  it('awaiting migration: buy is refused with the right reason, sell works', () => {
    const c = bondingCurve({ realSolReserves: 26n * SOL });
    renderPanel({
      curve: curveAccount(c),
      launch: launchState(c),
      actions: { create: true, buy: false, sell: true, migrate: true, release: false, poolSwap: false },
    });
    expect(screen.getByText(/has NOT graduated yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByLabelText('Amount of tokens to sell')).not.toBeDisabled();
  });

  it('refuses to offer a sell when the rent floor could not be read, rather than guessing it', () => {
    renderPanel({ rentFloor: null });
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByText(/rent floor could not be read/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review sell' })).toBeDisabled();
  });

  it('shows "fills the curve" when the buy would cross the graduation line', () => {
    const c = bondingCurve({ realSolReserves: 26n * SOL - SOL / 10n });
    renderPanel({ curve: curveAccount(c), launch: launchState(c) });
    fireEvent.change(screen.getByLabelText('Amount of SOL to spend'), { target: { value: '5' } });
    expect(screen.getByText(/This buy fills the curve: only/)).toBeInTheDocument();
    expect(screen.queryByText('5 SOL')).not.toBeInTheDocument();
  });

  it('a slippage above 5% is refused and blocks the review', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Amount of SOL to spend'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Other slippage percent'), { target: { value: '9' } });
    expect(screen.getByText(/at most 5%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review buy' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Other slippage percent'), { target: { value: '4' } });
    expect(screen.getByText(/above 3% lets a bot/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review buy' })).not.toBeDisabled();
  });

  it('a wallet that cannot sign transactions is told to pick another, and nothing can be reviewed', () => {
    renderPanel({ signerState: { kind: 'cannot-sign', address: CREATOR.toBase58(), walletName: 'Some Wallet' } });
    fireEvent.change(screen.getByLabelText('Amount of SOL to spend'), { target: { value: '0.5' } });
    expect(screen.getByText(/Some Wallet cannot sign transactions here\. Pick another wallet\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review buy' })).toBeDisabled();
  });

  // F1: the panel's price impact must leave the 1% fee out, exactly as the review does
  // (trade.ts): a buy is measured on the SOL that reaches the curve, a sell on the
  // SOL before the fee.
  it('price impact leaves the trade fee out, on a buy and on a sell', () => {
    const c = bondingCurve({ realSolReserves: 5n * SOL });
    const acct = curveAccount(c);
    const { api } = renderPanel({ curve: acct, launch: launchState(c) });
    fireEvent.change(screen.getByLabelText('Amount of SOL to spend'), { target: { value: '0.5' } });
    const buy = quoteBuyOnCurve(c, SOL / 2n);
    if (!buy.ok) throw new Error('buy quote');
    expect(buy.value.lamportsToCurve).toBeLessThan(buy.value.lamportsIn);
    expect(api.priceImpactBps).toHaveBeenLastCalledWith(expect.anything(), 'buy', buy.value.lamportsToCurve, buy.value.tokensOut);

    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    fireEvent.change(screen.getByLabelText('Amount of tokens to sell'), { target: { value: '1000' } });
    const sold = quoteSellOnCurve(c, 1_000_000_000n, 0n, { curveAccountLamports: acct.lamports, rentExemptLamports: 2_000_000n });
    if (!sold.ok) throw new Error('sell quote');
    expect(sold.value.grossLamports).toBeGreaterThan(sold.value.lamportsOut);
    expect(api.priceImpactBps).toHaveBeenLastCalledWith(expect.anything(), 'sell', 1_000_000_000n, sold.value.grossLamports);
  });

  it('a disconnected visitor gets a connect button inside the panel', () => {
    renderPanel({ signerState: { kind: 'disconnected', connecting: false } });
    expect(screen.getByRole('button', { name: 'Connect Solana Wallet' })).toBeInTheDocument();
  });
});
