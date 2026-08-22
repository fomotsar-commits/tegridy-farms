// The disclosure half of F3.
//
// The row is allowed to be dull, but it is not allowed to be flattering. Two failures
// are pinned here because both have shipped in this repo before, in other surfaces:
// claiming a charge that was never sent, and letting a zero read as "there are no
// costs" when every route still pays a pool, an aggregator and gas.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VenueFeeLine, venueFeeDisclosure } from './VenueFeeLine';

const PARASWAP = { source: 'paraswap' as const, venueFeeBps: 25 };
const FREE = { source: 'lifi' as const, venueFeeBps: 0 };

describe('the zero state never claims there are no costs', () => {
  it('renders "None", not "0 fees"', () => {
    const d = venueFeeDisclosure(FREE, true);
    expect(d.value).toBe('None');
    expect(d.value).not.toMatch(/0\s*fee/i);
  });

  it('says whose costs the figure does NOT cover', () => {
    const { note } = venueFeeDisclosure(FREE, true);
    expect(note).toMatch(/pool/i);
    expect(note).toMatch(/aggregator/i);
    expect(note).toMatch(/gas/i);
  });

  it('carries the same disclaimer when no aggregator route is in play at all', () => {
    expect(venueFeeDisclosure(null, false).note).toBe(venueFeeDisclosure(FREE, true).note);
  });
});

describe('a non-zero fee is a distinct, legible line', () => {
  it('shows the rate as a percentage of the trade', () => {
    expect(venueFeeDisclosure(PARASWAP, true).value).toBe('0.25%');
  });

  it('names the provider the fee rides on', () => {
    expect(venueFeeDisclosure(PARASWAP, true).note).toContain('ParaSwap');
  });

  it('formats a whole-percent rate without trailing zeros', () => {
    expect(venueFeeDisclosure({ source: 'paraswap', venueFeeBps: 100 }, true).value).toBe('1%');
  });

  it('renders as its own row rather than folded into another figure', () => {
    render(<VenueFeeLine quote={PARASWAP} executes />);
    expect(screen.getByText('Venue fee')).toBeInTheDocument();
    expect(screen.getByText('0.25%')).toBeInTheDocument();
  });
});

describe('a quote that will not be submitted cannot claim a charge', () => {
  it('marks the fee as not charged when the route only exists for comparison', () => {
    const d = venueFeeDisclosure(PARASWAP, false);
    expect(d.value).toBe('0.25% (not charged)');
    expect(d.note).toMatch(/not submitted in-app/i);
  });

  it('renders that state instead of a bare percentage', () => {
    render(<VenueFeeLine quote={PARASWAP} executes={false} />);
    expect(screen.getByText('0.25% (not charged)')).toBeInTheDocument();
    expect(screen.queryByText('0.25%')).toBeNull();
  });
});

describe('the row reads the quote, never the policy', () => {
  it('discloses zero for a quote stamped zero, whatever the venue rate is set to', () => {
    // The stamp is the fee the provider's own request carried; a provider whose leg is
    // withheld arrives here as 0 while the policy is enabled.
    expect(venueFeeDisclosure({ source: 'kyberswap', venueFeeBps: 0 }, true).value).toBe('None');
  });
});
