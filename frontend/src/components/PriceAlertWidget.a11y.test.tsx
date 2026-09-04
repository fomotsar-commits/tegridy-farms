/**
 * A11Y-R15 — the only way to delete a price alert is reachable.
 *
 * The per-alert remove control was a bare `x` at text-[14px] / text-white/30:
 * roughly a 14x14 target at about 2.6:1 contrast, well under both floors, and
 * there is no other route to deleting an alert. Both assertions fail on the
 * pre-change component.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('../contexts/PriceContext', () => ({
  useTOWELIPrice: () => ({ priceInUsd: 1, isLoading: false, isError: false }),
}));

import { PriceAlertWidget } from './PriceAlertWidget';

beforeEach(() => localStorage.clear());

describe('PriceAlertWidget — remove control', () => {
  it('is a 44px target at a readable resting colour', () => {
    render(<PriceAlertWidget />);
    // Open the panel, then add one alert so a row exists to delete.
    fireEvent.click(screen.getByRole('button', { name: /price alerts/i }));
    fireEvent.change(screen.getByLabelText('Alert price in USD'), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    const remove = screen.getByRole('button', { name: 'Remove alert' });
    expect(remove.className).toContain('min-w-[44px]');
    expect(remove.className).toContain('min-h-[44px]');
    // text-white/30 on this row measured ~2.6:1 — under the 4.5:1 floor.
    expect(remove.className).not.toContain('text-white/30');
    expect(remove.className).toContain('text-white/60');
  });
});
