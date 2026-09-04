/**
 * A11Y-R11 — every gauge weight slider is named, and reads out percent.
 *
 * Each `<input type="range">` shipped with no <label>, no aria-label and no
 * aria-labelledby: a screen reader announced "slider, 0 to 10000" once per
 * gauge, identically, with no way to tell which pool it controlled — and 10000
 * is basis points while the number on screen is a percentage. Both assertions
 * fail on the pre-change component (no accessible name; no aria-valuetext).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { wagmiMock } from '../test-utils/wagmi-mocks';
import { renderWithProviders } from '../test-utils/render';

const GAUGE_A = '0x1111111111111111111111111111111111111111';
const GAUGE_B = '0x2222222222222222222222222222222222222222';

// The controller address is zero in constants (a frontend wiring gate), and the
// component early-returns on that — so the vote form, and the sliders with it,
// is unreachable without pointing it at an address.
vi.mock('../lib/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/constants')>();
  return {
    ...actual,
    GAUGE_CONTROLLER_ADDRESS: '0x3333333333333333333333333333333333333333',
    isDeployed: () => true,
  };
});
vi.mock('./ArtImg', () => ({ ArtImg: () => null }));

import { GaugeVoting } from './GaugeVoting';

describe('GaugeVoting — weight sliders', () => {
  beforeEach(() => {
    wagmiMock.reset();
    wagmiMock.setAccount({ address: '0x9999999999999999999999999999999999999999', isConnected: true });
    wagmiMock.setReadResult({ functionName: 'getGauges', result: [GAUGE_A, GAUGE_B] });
    // The vote form is gated on holding a staking position — without a tokenId
    // the page says "Stake TOWELI first" and no slider is rendered at all.
    wagmiMock.setReadResult({ functionName: 'userTokenId', result: 1n });
  });

  it('names every slider and announces its value as a percentage', () => {
    renderWithProviders(<GaugeVoting />);
    const sliders = screen.getAllByRole('slider');
    expect(sliders.length).toBe(2);
    for (const slider of sliders) {
      // A non-empty accessible name, and it is the gauge's own label.
      expect(slider).toHaveAccessibleName(/\S/);
      // Basis points are the wire format, never the announced one.
      expect(slider.getAttribute('aria-valuetext')).toMatch(/percent$/);
    }
    // Two gauges, two DIFFERENT names — the defect was that they were
    // indistinguishable, which one nameless slider would not have caught.
    const names = sliders.map((s) => s.getAttribute('aria-labelledby'));
    expect(new Set(names).size).toBe(2);
  });
});
