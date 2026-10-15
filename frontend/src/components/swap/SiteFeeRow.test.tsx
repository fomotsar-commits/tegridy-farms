import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { SiteFeeRow } from './SiteFeeRow';

afterEach(cleanup);

describe('SiteFeeRow: the platform-fee line of the Solana swap', () => {
  it('a fee-bearing pair states the rate and the token it is taken in, and no waiver', () => {
    render(<SiteFeeRow feePct="0.50" feeMintSymbol="SOL" waived={false} />);
    expect(screen.getByTestId('site-fee-value')).toHaveTextContent('0.50% · in SOL');
    expect(screen.queryByTestId('site-fee-waived')).toBeNull();
    expect(screen.queryByText(/no site fee/i)).toBeNull();
  });

  it('a pair with no fee leg says so, and no waiver', () => {
    render(<SiteFeeRow feePct="0.50" feeMintSymbol={null} waived={false} />);
    expect(screen.getByTestId('site-fee-value')).toHaveTextContent('None on this pair');
    expect(screen.queryByTestId('site-fee-waived')).toBeNull();
  });

  it('a waived route says plainly that there is no site fee, and never shows the rate beside it', () => {
    render(<SiteFeeRow feePct="0.50" feeMintSymbol="SOL" waived />);
    expect(screen.getByTestId('site-fee-value')).toHaveTextContent('None on this route');
    expect(screen.getByRole('status')).toHaveTextContent('No site fee on this route: the fee cannot be taken on it yet.');
    expect(screen.queryByText(/0\.50%/)).toBeNull();
  });
});
