// Pins for the per-token page's pure pieces. The chain-resolution tie-break is
// lib-tested (pickResolvedCurveChain in curve.test.ts); here: the creator claim
// view's contract — amount rendering, the zero-claim disabled state, and that
// the button actually fires. The container's creator gate (only the on-chain
// creator ever sees this) is enforced against useAccount and exercised by the
// route-level a11y sweep with no wallet, where the section must simply be absent.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CurveCreatorClaimView } from './CurveTokenPage';

vi.mock('framer-motion', () => {
  const passthrough = new Proxy({}, { get: () => ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> });
  return { m: { ...passthrough, div: ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div> }, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>, LazyMotion: ({ children }: { children?: React.ReactNode }) => <>{children}</>, domAnimation: {} };
});

describe('CurveCreatorClaimView', () => {
  it('shows the claimable amount and fires the claim', () => {
    const onClaim = vi.fn();
    render(<CurveCreatorClaimView claimableWei={40000000000000000n} pending={false} onClaim={onClaim} />);
    expect(screen.getByText(/0\.04 ETH claimable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /claim/i }));
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it('zero claimable renders the surface but disables the button — visible, honest, inert', () => {
    const onClaim = vi.fn();
    render(<CurveCreatorClaimView claimableWei={0n} pending={false} onClaim={onClaim} />);
    const btn = screen.getByRole('button', { name: /claim/i });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClaim).not.toHaveBeenCalled();
  });

  it('pending blocks a double-submit', () => {
    render(<CurveCreatorClaimView claimableWei={1n} pending={true} onClaim={vi.fn()} />);
    expect(screen.getByRole('button', { name: /confirm in wallet/i })).toBeDisabled();
  });
});

describe('claim receipt window (2026-08-28 audit)', () => {
  it('holds the button through mining with a distinct label — no double-claim window', () => {
    render(<CurveCreatorClaimView claimableWei={1n} pending={true} mining={true} onClaim={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeDisabled();
    expect(btn.textContent).toMatch(/confirming on-chain/i);
  });
});
