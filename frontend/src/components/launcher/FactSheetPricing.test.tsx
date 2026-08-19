// The pricing block is the reader's only view of what set the venue's line, so the two
// things pinned hardest are the two that would mislead a buyer:
//   1. An absent disclosure renders as "standard rate", never as a blank the reader has to
//      interpret, and never as a discount.
//   2. A tier word appears ONLY when the island gave one. `tierReadable: false` is an
//      outage, and an outage that renders a tier is the whole defect this repo keeps
//      re-fixing in other surfaces.

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import FactSheetPricing from './FactSheetPricing';
import type { LaunchPricingDisclosure } from '../../lib/launcher/factSheet';
import { HEAT_TIER_VENUE_LINE_BPS, resolveLaunchPricing, toPricingDisclosure } from '../../lib/launcher/launchPricing';

/** Priced from the real resolver, so the component can never be tested against a shape
 *  the resolver would not actually produce. */
const ON = { tierPricingEnabled: true as const, table: { ...HEAT_TIER_VENUE_LINE_BPS, Elder: 600, Builder: 900 } };
const disclosure = (reading: Parameters<typeof resolveLaunchPricing>[0]): LaunchPricingDisclosure =>
  toPricingDisclosure(resolveLaunchPricing(reading, { ...ON, creatorShareEnabled: true, creatorShareOfVenueBps: 5000 }))!;

describe('FactSheetPricing', () => {
  it('says "standard rate" rather than rendering nothing when no feature was in force', () => {
    render(<FactSheetPricing />);
    expect(screen.getByText(/standard rate/i)).toBeTruthy();
    expect(screen.queryByText(/discount/i)).toBeNull();
  });

  it('names the tier and the discount when the island gave a reading', () => {
    render(<FactSheetPricing pricing={disclosure({ tier: 'Elder', state: 'WARM' })} />);
    expect(screen.getByText('Elder')).toBeTruthy();
    expect(screen.getByText('Heat-tier discount')).toBeTruthy();
    expect(screen.getByText('Creator revenue share')).toBeTruthy();
    expect(screen.getByText('9.00% to the creator')).toBeTruthy(); // 1500 -> 600 tier discount
    expect(screen.getByText('3.00% to the creator')).toBeTruthy(); // 50% of the TIERED 600
    expect(screen.getAllByText(/3\.00% of the pool trade fee/).length).toBeGreaterThan(0); // venue keeps
  });

  it('names NO tier and claims NO discount when the reading was missing', () => {
    const unread = disclosure({ tier: null, state: 'STALE' });
    expect(unread.tierReadable).toBe(false);
    const { container } = render(<FactSheetPricing pricing={unread} />);

    expect(screen.getAllByText(/No fresh Heat reading/i).length).toBeGreaterThan(0);
    for (const tier of ['Elder', 'Builder', 'Resident', 'Observer', 'Drifter']) {
      expect(container.textContent).not.toContain(tier);
    }
    // No discount ROW at all, and the only sentence containing the word denies one.
    expect(screen.queryByText('Heat-tier discount')).toBeNull();
    expect(container.textContent).toMatch(/No tier discount was applied/i);
    // The venue's line was reduced by the creator share alone (50% of the STANDARD 1500,
    // not of a tier price) — the standard rate is still shown beside it, unmoved.
    expect(unread.tierDiscountBps).toBe(0);
    expect(screen.getByText('7.50% of the pool trade fee')).toBeTruthy();
    expect(screen.getByText('15.00%')).toBeTruthy();
  });

  it('always carries the immutability sentence, whatever the price', () => {
    for (const reading of [{ tier: 'Elder', state: 'WARM' } as const, { tier: null, state: 'STALE' } as const]) {
      const { container, unmount } = render(<FactSheetPricing pricing={disclosure(reading)} />);
      expect(container.textContent).toMatch(/cannot be changed afterwards/i);
      unmount();
    }
  });
});
