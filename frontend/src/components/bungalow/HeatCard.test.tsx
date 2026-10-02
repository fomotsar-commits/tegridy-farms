// The bungalow heat card prints the tier word the island served, never one read off the bands.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { parseHeatReading } from '../../lib/heat/heatOracle';

const h = vi.hoisted(() => ({ fetchHeat: vi.fn() }));

vi.mock('../../lib/heat/heatClient', () => ({
  fetchHeat: (...args: unknown[]) => h.fetchHeat(...args),
  isSupportedHeatAddress: () => true,
}));

const { HeatCard } = await import('./HeatCard');

const ADDR = '0x279e7cff2dbc93ff1f5cae6cbd072f98d75987ca';

describe('the bungalow heat card', () => {
  it('names the wallet by its served tier, even where the bands would name another', async () => {
    // 95° sits in the Resident band (80); the island served Observer, so the card says Observer.
    h.fetchHeat.mockResolvedValue(
      parseHeatReading({
        address: ADDR,
        degrees: 95,
        tier: 'Observer',
        is_cold: false,
        held_since_unix: 1_700_000_000,
        as_of_unix: 1_788_700_000,
        token_count: 2,
        breakdown: [],
      }),
    );
    render(<HeatCard defaultAddress={ADDR} />);
    fireEvent.click(screen.getByRole('button', { name: 'Check heat' }));
    const standing = await screen.findByText('Standing:');
    expect(standing.parentElement?.textContent).toBe('Standing: Observer');
    expect(screen.queryByText('Resident')).toBeNull();
  });

  it('speaks without a prose em dash, before a read and on a cold one', async () => {
    h.fetchHeat.mockResolvedValue(
      parseHeatReading({
        address: ADDR,
        degrees: 0,
        tier: 'Drifter',
        is_cold: true,
        held_since_unix: null,
        as_of_unix: null,
        token_count: 0,
        breakdown: [],
      }),
    );
    const { container } = render(<HeatCard defaultAddress={ADDR} />);
    expect(container.textContent).toContain('Give the Island an address');
    expect(container.textContent).not.toContain('—');
    fireEvent.click(screen.getByRole('button', { name: 'Check heat' }));
    await screen.findByText(/no held-time rows for this wallet yet/);
    expect(container.textContent).not.toContain('—');
  });
});
