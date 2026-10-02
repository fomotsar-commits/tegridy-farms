// The dark Garden lane on /launch. The island's blueprint gives every launch its own fee
// table ("Not the venue's split, not the flagship's, not anyone's defaults. Yours.") and
// uses the covenant to split the venue's fees on a certified pool. So the lane does not say
// a certified launch runs under the covenant instead of the venue's split.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../lib/heat/certification', () => ({
  isCertified: async () => ({ status: 'not-published', detail: 'The island publishes no certification state yet.' }),
  isCertifiedState: (s: { status: string }) => s.status === 'certified',
}));

const { GardenLane } = await import('./GardenLane');

describe('the Garden lane', () => {
  it('says what the lane is, and never that the covenant replaces a launch fee table', async () => {
    render(<GardenLane community="TEST" />);
    await screen.findByText('The island publishes no certification state yet.');
    const lead = screen.getByText(/The island.s own lane\./);
    expect(lead.textContent?.replace(/\s+/g, ' ').trim()).toBe(
      'The island’s own lane. A certified community launches on certified soil.',
    );
    expect(document.body.textContent).not.toMatch(/covenant rather than|venue.s split/);
  });
});
