// Island answer twenty-five, screen 1, row 8: her line inside the sheet, with no button.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SheetBaylaRow } from './SheetBaylaRow';
import { setLastReading } from '../../lib/heat/heatStore';
import { clearLanded } from '../../lib/landed';
import type { HeatReading } from '../../lib/heat/heatOracle';

vi.mock('../../lib/solana/lp/roomPrice', () => ({ useRoomSlow: () => null }));

const warm: HeatReading = {
  address: '0x1111111111111111111111111111111111111111',
  degrees: 41.2,
  tier: 'Observer',
  isCold: false,
  heldSinceUnix: 1_700_000_000,
  asOfUnix: 1_762_000_000,
  tokenCount: 2,
  breakdown: [],
  observedAt: 1_762_000_000,
  xHandle: null,
  daysToNextTier: null,
  daysToPlant: null,
};

const mount = () =>
  render(
    <MemoryRouter initialEntries={['/bayla?sheet=add']}>
      <SheetBaylaRow />
    </MemoryRouter>,
  );

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('tegridy-bungalow', 'bayla');
  setLastReading(null);
  clearLanded();
});
afterEach(cleanup);

describe('her line inside the sheet', () => {
  it('says the room’s state in her words, with no button: the sheet’s own button is her move', () => {
    setLastReading(warm);
    mount();
    const row = screen.getByTestId('sheet-bayla');
    expect(row).toHaveTextContent('41.20° Observer. Every day in this pool counts double.');
    expect(row.querySelector('a, button')).toBeNull();
  });

  it('is left out while no wallet is read: "Paste any wallet." has nowhere to paste in the sheet', () => {
    mount();
    expect(screen.queryByTestId('sheet-bayla')).toBeNull();
  });
});
