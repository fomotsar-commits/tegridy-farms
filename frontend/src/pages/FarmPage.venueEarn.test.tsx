// The venue's own /farm header. "Held time" is the island's word for heat, and the island
// reads only two of the pools listed here, so the header speaks of lock length alone.
// Real storage with nothing chosen: the same predicate the app runs puts us in the venue.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../components/farm/VenuePoolIndex', () => ({ VenuePoolIndex: () => <div data-testid="pool-index" /> }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));

import FarmPage from './FarmPage';
import { BUNGALOW_STORAGE_KEY } from '../lib/bungalows';

beforeEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

describe("the venue's Earn header", () => {
  it('says what a lock earns, without calling it held time', () => {
    render(
      <MemoryRouter>
        <FarmPage />
      </MemoryRouter>,
    );
    const header = screen.getByRole('heading', { level: 1, name: 'Earn' }).closest('header')!;
    expect(header.textContent).toContain('The longer you lock, the larger your share of the same rewards.');
    expect(header.textContent).not.toMatch(/held time/i);
    expect(screen.getByTestId('pool-index')).toBeTruthy();
  });
});
