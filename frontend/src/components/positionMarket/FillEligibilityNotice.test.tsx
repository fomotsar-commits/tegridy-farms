import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FillEligibilityNotice, FillButton } from './FillEligibilityNotice';
import { BLOCKER, toFillVerdict } from '../../hooks/usePositionMarketFillability';

const OK = { deployed: true, onExpectedChain: true, isError: false, isLoading: false };
const AT = 1_800_000_000n;

const CLEAR = toFillVerdict([BLOCKER.None, true, AT], OK);
const UNVERIFIED = toFillVerdict([BLOCKER.None, false, AT], OK);
const BLOCKED = toFillVerdict([BLOCKER.RecipientAlreadyHoldsPosition, true, AT], OK);
const UNAVAILABLE = toFillVerdict(undefined, { ...OK, isError: true });

describe('FillEligibilityNotice', () => {
  it('marks each verdict distinctly so an outage cannot be read as a pass', () => {
    const { rerender } = render(<FillEligibilityNotice verdict={CLEAR} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-verdict', 'clear');

    rerender(<FillEligibilityNotice verdict={UNVERIFIED} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-verdict', 'unverified');

    rerender(<FillEligibilityNotice verdict={BLOCKED} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-verdict', 'blocked');

    rerender(<FillEligibilityNotice verdict={UNAVAILABLE} />);
    expect(screen.getByRole('status')).toHaveAttribute('data-verdict', 'unavailable');
  });

  it('says the check did not finish rather than that it passed', () => {
    render(<FillEligibilityNotice verdict={UNVERIFIED} />);
    expect(screen.getByText(/could not finish checking/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Checked/)).not.toBeInTheDocument();
  });

  it('says eligibility is unknown when nothing was read', () => {
    render(<FillEligibilityNotice verdict={UNAVAILABLE} />);
    expect(screen.getByText(/eligibility unknown/i)).toBeInTheDocument();
  });

  it('gives a blocked buyer the route out, not just a refusal', () => {
    render(<FillEligibilityNotice verdict={BLOCKED} />);
    expect(screen.getByText(/wallet with no position/i)).toBeInTheDocument();
  });

  it('counts down to the rate-limit deadline on a rate-limited listing', () => {
    const rateLimited = toFillVerdict([BLOCKER.RateLimited, true, 1_000n], OK);
    render(<FillEligibilityNotice verdict={rateLimited} nowSeconds={400} />);
    expect(screen.getByText(/buyable in about 10 minutes/i)).toBeInTheDocument();
  });
});

describe('FillButton', () => {
  it('offers an unqualified buy only on a completed check', () => {
    render(<FillButton verdict={CLEAR} priceLabel="3 ETH" onFill={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent('Buy for 3 ETH');
    expect(btn).not.toHaveTextContent(/unchecked/i);
  });

  it('labels an unverified buy as unchecked rather than blocking it outright', () => {
    // Refusing here would itself be a claim we cannot support — the fill may well
    // succeed. The honest position is to let the buyer act and say what we know.
    render(<FillButton verdict={UNVERIFIED} priceLabel="3 ETH" onFill={vi.fn()} />);
    const btn = screen.getByRole('button');
    expect(btn).toBeEnabled();
    expect(btn).toHaveTextContent(/unchecked/i);
  });

  it('is disabled when the chain says the fill would fail', () => {
    render(<FillButton verdict={BLOCKED} priceLabel="3 ETH" onFill={vi.fn()} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });

  it('is disabled when eligibility was never read', () => {
    render(<FillButton verdict={UNAVAILABLE} priceLabel="3 ETH" onFill={vi.fn()} />);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
