import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { CurveTradePanel, type CurveTradePanelProps } from './CurveTradePanel';
import {
  CREATOR,
  MINT,
  SOL,
  bondingCurve,
  buySummary,
  curveAccount,
  fakeApi,
  globalCfg,
  launchState,
  openGate,
  prepared,
} from './fakeWriteApi.fixture';
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
    actions: { create: true, buy: true, sell: true, migrate: false, poolSwap: false },
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
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.5' } });
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
      actions: { create: false, buy: false, sell: true, migrate: false, poolSwap: false },
    });
    expect(screen.getByText(/Buys are paused\. Selling is still open/)).toBeInTheDocument();
    expect(screen.getByLabelText('Spend at most (SOL)')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByLabelText('Sell (tokens)')).not.toBeDisabled();
  });

  it('awaiting migration: buy is refused with the right reason, sell works', () => {
    const c = bondingCurve({ realSolReserves: 26n * SOL });
    renderPanel({
      curve: curveAccount(c),
      launch: launchState(c),
      actions: { create: true, buy: false, sell: true, migrate: true, poolSwap: false },
    });
    expect(screen.getByText(/has NOT graduated yet/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByLabelText('Sell (tokens)')).not.toBeDisabled();
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
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '5' } });
    expect(screen.getByText(/This buy fills the curve: only/)).toBeInTheDocument();
    expect(screen.queryByText('5 SOL')).not.toBeInTheDocument();
  });

  it('a slippage above 5% is refused and blocks the review', () => {
    renderPanel();
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.5' } });
    fireEvent.change(screen.getByLabelText('Other slippage percent'), { target: { value: '9' } });
    expect(screen.getByText(/at most 5%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review buy' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Other slippage percent'), { target: { value: '4' } });
    expect(screen.getByText(/above 3% lets a bot/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review buy' })).not.toBeDisabled();
  });

  // UX-1: a phone set to a comma-decimal region has "," and no "." on this keypad.
  it('reads a comma typed in the amount as the decimal point, and builds from what the box shows', async () => {
    const { api } = renderPanel();
    const amount = screen.getByLabelText('Spend at most (SOL)') as HTMLInputElement;
    for (const k of '0,5') fireEvent.change(amount, { target: { value: amount.value + k } });
    expect(amount).toHaveValue('0.5');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review buy' }));
    });
    expect(api.prepareCurveBuy).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.objectContaining({ lamportsIn: SOL / 2n }));
  });

  it('a pasted "68,066" is refused, never read as 68.066', () => {
    renderPanel();
    const amount = screen.getByLabelText('Spend at most (SOL)');
    fireEvent.change(amount, { target: { value: '68,066' } });
    expect(amount).toHaveValue('68,066');
    expect(amount).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Review buy' })).toBeDisabled();
  });

  it('a wallet that cannot sign transactions is told to pick another, and nothing can be reviewed', () => {
    renderPanel({ signerState: { kind: 'cannot-sign', address: CREATOR.toBase58(), walletName: 'Some Wallet' } });
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.5' } });
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
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.5' } });
    const buy = quoteBuyOnCurve(c, SOL / 2n);
    if (!buy.ok) throw new Error('buy quote');
    expect(buy.value.lamportsToCurve).toBeLessThan(buy.value.lamportsIn);
    expect(api.priceImpactBps).toHaveBeenLastCalledWith(expect.anything(), 'buy', buy.value.lamportsToCurve, buy.value.tokensOut);

    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    fireEvent.change(screen.getByLabelText('Sell (tokens)'), { target: { value: '1000' } });
    const sold = quoteSellOnCurve(c, 1_000_000_000n, 0n, { curveAccountLamports: acct.lamports, rentExemptLamports: 2_000_000n });
    if (!sold.ok) throw new Error('sell quote');
    expect(sold.value.grossLamports).toBeGreaterThan(sold.value.lamportsOut);
    expect(api.priceImpactBps).toHaveBeenLastCalledWith(expect.anything(), 'sell', 1_000_000_000n, sold.value.grossLamports);
  });

  // F7/UX5: to sell everything a user had to type their exact balance from elsewhere.
  it('the sell side shows what the wallet holds, and 25% / 50% / Max fill the amount exactly', () => {
    renderPanel({ walletHolding: { kind: 'ok', value: 98_612_106_050_692n } });
    expect(screen.queryByTestId('your-holding')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByTestId('your-holding')).toHaveTextContent('You hold 98,612,106.050692');
    const amount = screen.getByLabelText('Sell (tokens)') as HTMLInputElement;
    fireEvent.click(screen.getByRole('button', { name: 'Max' }));
    expect(amount.value).toBe('98612106.050692');
    fireEvent.click(screen.getByRole('button', { name: '50%' }));
    expect(amount.value).toBe('49306053.025346');
    fireEvent.click(screen.getByRole('button', { name: '25%' }));
    expect(amount.value).toBe('24653026.512673');
  });

  it('an unread balance says "could not read" and offers no Max, never 0', () => {
    renderPanel({ walletHolding: { kind: 'unreadable', detail: 'HTTP 429' } });
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByText(/You hold: could not read \(HTTP 429\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Max' })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/You hold 0/);
  });

  // F8/UX4: the inputs carry an aria-label, which replaces the label's text, so the
  // hint and any error were never read out.
  it('a screen reader hears the amount hint, and a bad amount is marked invalid with its reason', () => {
    renderPanel();
    const input = screen.getByLabelText('Spend at most (SOL)');
    expect(input).toHaveAccessibleDescription(/The trade fee comes out of this amount/);
    expect(input).not.toHaveAttribute('aria-invalid');
    fireEvent.change(input, { target: { value: '1.2.3' } });
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(/That is not an amount this token can hold/);
  });

  // F3: an impact that could not be computed showed as "0.00%", and a large one had no warning.
  it('price impact: "could not compute" when unreadable, and a warning when large', () => {
    const api = fakeApi();
    vi.mocked(api.priceImpactBps).mockReturnValue(null);
    renderPanel({ api });
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.5' } });
    expect(screen.getByText('could not compute')).toBeInTheDocument();
    expect(screen.queryByText('0.00%')).not.toBeInTheDocument();
    vi.mocked(api.priceImpactBps).mockReturnValue(620n);
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.6' } });
    expect(screen.getByText(/This trade moves the price by 6\.20%\. You get noticeably less/)).toBeInTheDocument();
    vi.mocked(api.priceImpactBps).mockReturnValue(2_000n);
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.7' } });
    expect(screen.getByText(/moves the price by 20\.00%\. You get far less/)).toBeInTheDocument();
  });

  // UXR4 (WCAG 2.5.3): the name a voice-control user says is the one on screen.
  it('each amount field is named by its visible label, nothing else', () => {
    renderPanel();
    expect(screen.getByRole('textbox', { name: 'Spend at most (SOL)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'sell' }));
    expect(screen.getByRole('textbox', { name: 'Sell (tokens)' })).toBeInTheDocument();
  });

  // UXR5: the slippage input was left out of the hint/error wiring.
  it('the typed tolerance carries its hint and error, is marked invalid, and the error and warning are read out', () => {
    renderPanel();
    const other = screen.getByLabelText('Other slippage percent');
    expect(other).toHaveAccessibleDescription(/only the fees are spent/);
    fireEvent.change(other, { target: { value: '9' } });
    expect(other).toHaveAttribute('aria-invalid', 'true');
    expect(other).toHaveAccessibleDescription(/Enter a tolerance above 0% and at most 5%\./);
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a tolerance above 0% and at most 5%.');
    fireEvent.change(other, { target: { value: '4' } });
    expect(other).not.toHaveAttribute('aria-invalid');
    expect(other).toHaveAccessibleDescription(/A tolerance above 3% lets a bot trade in front of you/);
    expect(screen.getAllByRole('status').some((s) => /A tolerance above 3%/.test(s.textContent ?? ''))).toBe(true);
  });

  // UXR3: Cancel took the flow away and left focus on the page body.
  it('Cancel puts focus back on the Review button', async () => {
    const api = fakeApi();
    vi.mocked(api.prepareCurveBuy).mockResolvedValue({ ok: true, prepared: prepared(buySummary()) });
    renderPanel({ api });
    fireEvent.change(screen.getByLabelText('Spend at most (SOL)'), { target: { value: '0.5' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review buy' }));
    });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    cancel.focus();
    act(() => {
      fireEvent.click(cancel);
    });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Review buy' }));
  });

  it('a disconnected visitor gets a connect button inside the panel', () => {
    renderPanel({ signerState: { kind: 'disconnected', connecting: false } });
    expect(screen.getByRole('button', { name: 'Connect Solana Wallet' })).toBeInTheDocument();
  });
});
