import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { parseEther } from 'viem';
import { CurveTradeView } from './CurveTradePanel';
import { previewBuy, withSlippage, saleSupplyForReserveBps, type CurveLaunch } from '../../lib/launcher/curve';

// framer-motion passthrough so <m.div> renders as a plain <div> under jsdom.
vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> });
  return { m: { ...passthrough, div: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> }, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>, LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>, domAnimation: {} };
});

const LAUNCH: CurveLaunch = {
  creator: '0x1111111111111111111111111111111111111111',
  virtualEth: parseEther('0.2'),
  graduationEth: parseEther('3.8'),
  feeBps: 100,
  creatorFeeShareBps: 4000,
  treasuryFeeShareBps: 2500,
  reserveRecipient: '0x2222222222222222222222222222222222222222',
  saleSupply: saleSupplyForReserveBps(500),
  reserveAmount: 0n,
  ethReserve: 0n,
  tokenReserve: saleSupplyForReserveBps(500),
  graduated: false,
};

function view(overrides: Partial<React.ComponentProps<typeof CurveTradeView>> = {}) {
  const onBuy = vi.fn();
  const onSell = vi.fn();
  const onApprove = vi.fn();
  render(<CurveTradeView launch={LAUNCH} tokenSymbol="TWL" needsApproval={false} pending={false} onBuy={onBuy} onSell={onSell} onApprove={onApprove} {...overrides} />);
  return { onBuy, onSell, onApprove };
}

describe('CurveTradeView', () => {
  it('shows a graduation progress bar', () => {
    view({ launch: { ...LAUNCH, ethReserve: parseEther('1.9') } });
    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('5000'); // 1.9 / 3.8
  });

  it('disables the buy button until a valid amount is entered', () => {
    view();
    const btn = screen.getByRole('button', { name: /buy twl/i });
    expect(btn).toBeDisabled();
  });

  it('quotes a buy with the exact contract math and calls onBuy with the slippage floor', () => {
    const { onBuy } = view();
    fireEvent.change(screen.getByLabelText(/amount to spend/i), { target: { value: '1' } });

    // The quote must be the contract's exact output; the fee-split rows render.
    const q = previewBuy(LAUNCH, parseEther('1'));
    expect(screen.getByText(/Jungle Bay treasury/i)).toBeInTheDocument();

    const btn = screen.getByRole('button', { name: /buy twl/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onBuy).toHaveBeenCalledWith(parseEther('1'), withSlippage(q.tokensOut, 100));
  });

  it('flags the completing buy as a graduation', () => {
    view();
    fireEvent.change(screen.getByLabelText(/amount to spend/i), { target: { value: '4' } });
    expect(screen.getByText(/completes the curve/i)).toBeInTheDocument();
  });

  it('renders a terminal state for a graduated launch and offers no trade UI', () => {
    view({ launch: { ...LAUNCH, graduated: true } });
    expect(screen.getByText(/has graduated/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /buy/i })).toBeNull();
  });

  it('on the sell side, offers Approve first when approval is needed', () => {
    const { onSell, onApprove } = view({ needsApproval: true, tokenBalance: parseEther('1000') });
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i })); // switch to sell tab
    fireEvent.change(screen.getByLabelText(/amount of twl to sell/i), { target: { value: '100' } });
    const btn = screen.getByRole('button', { name: /approve twl/i });
    fireEvent.click(btn);
    expect(onApprove).toHaveBeenCalled();
    expect(onSell).not.toHaveBeenCalled();
  });
});

describe('deferred graduation + receipt-window states (2026-08-28 audit)', () => {
  const DEFERRED = { ...LAUNCH, ethReserve: LAUNCH.graduationEth, graduated: false };

  it('closes Buy with an explanation when the curve is at target but not finalized', () => {
    const { onBuy } = view({ deferredGraduation: true, launch: DEFERRED });
    expect(screen.getByText(/graduation hasn't been finalized yet/i)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /buys closed/i });
    expect(btn).toBeDisabled();
    // typing an amount must NOT re-enable the guaranteed-revert buy
    fireEvent.change(screen.getByLabelText(/amount to spend/i), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: /buys closed/i })).toBeDisabled();
    expect(onBuy).not.toHaveBeenCalled();
  });

  it('keeps Sell open in the deferred window and offers the permissionless finalize', () => {
    const onFinalizeGraduation = vi.fn();
    view({ deferredGraduation: true, launch: DEFERRED, onFinalizeGraduation });
    fireEvent.click(screen.getByRole('button', { name: /finalize graduation/i }));
    expect(onFinalizeGraduation).toHaveBeenCalledTimes(1);
    // sell tab still trades
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));
    expect(screen.getByLabelText(/amount of twl to sell/i)).toBeInTheDocument();
  });

  it('labels the submission→receipt window distinctly from the wallet prompt', () => {
    view({ pending: true, mining: true });
    expect(screen.getByText(/confirming on-chain/i)).toBeInTheDocument();
  });

  it('discloses the unlimited allowance next to the Approve action', () => {
    view({ needsApproval: true, tokenBalance: parseEther('5') });
    fireEvent.click(screen.getByRole('button', { name: /^sell$/i }));
    expect(screen.getByText(/unlimited TWL allowance/i)).toBeInTheDocument();
  });
});
