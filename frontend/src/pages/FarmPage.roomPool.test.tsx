// Lock shows the bungalow selected (owner, 2026-10-15): inside a room, /earn opens that room's
// pool at its own address. With no room, and at /earn?pools=all, it is the list of every pool.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';

vi.mock('../components/farm/VenuePoolIndex', () => ({ VenuePoolIndex: () => <div data-testid="pool-index" /> }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));

import FarmPage from './FarmPage';
import { BUNGALOW_STORAGE_KEY } from '../lib/bungalows';

function OnePool() {
  const { poolId } = useParams();
  const { search } = useLocation();
  return <div data-testid="one-pool">{poolId + search}</div>;
}

const at = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/earn" element={<FarmPage />} />
        <Route path="/earn/:poolId" element={<OnePool />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

describe('Lock in a room', () => {
  it("opens the room's pool, not the list of every pool", () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    at('/earn');
    expect(screen.getByTestId('one-pool')).toHaveTextContent('bayla');
    expect(screen.queryByTestId('pool-index')).toBeNull();
  });

  it('keeps a query on the way to the pool', () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'pepe');
    at('/earn?ref=x');
    expect(screen.getByTestId('one-pool')).toHaveTextContent('pepe?ref=x');
  });

  it('is the list of every pool at /earn?pools=all, whatever the room', () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    at('/earn?pools=all');
    expect(screen.getByTestId('pool-index')).toBeTruthy();
  });

  it('is the list with no room chosen, and for the venue sentinel', () => {
    at('/earn');
    expect(screen.getByTestId('pool-index')).toBeTruthy();
  });

  it('is the list for the venue sentinel a dismissed picker stores', () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'venue');
    at('/earn');
    expect(screen.getByTestId('pool-index')).toBeTruthy();
  });
});
