// Lock's Staking tab opens the room's own pool, as the Lock word does (owner, 2026-10-15:
// "only show the bungalow selected"); with no room it opens the list of every pool.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

vi.mock('./FarmPage', () => ({ default: () => <div>staking panel</div> }));
vi.mock('./LendingPage', () => ({ default: () => <div>nft panel</div> }));
vi.mock('./YieldPage', () => ({ default: () => null }));
vi.mock('./CopyTradingPage', () => ({ default: () => null }));
vi.mock('./CompetitionsPage', () => ({ default: () => null }));
vi.mock('./CheckoutPage', () => ({ default: () => null }));

import EarnPage from './EarnPage';
import { BUNGALOW_STORAGE_KEY } from '../lib/bungalows';

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

const at = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <EarnPage />
      <Where />
    </MemoryRouter>,
  );

beforeEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

describe("Lock's Staking tab", () => {
  it("opens BAYLA's pool in BAYLA's room", () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    at('/nft-finance');
    fireEvent.click(screen.getByRole('tab', { name: 'Staking' }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/earn\/bayla$/);
  });

  it('opens the list with no room chosen', () => {
    at('/nft-finance');
    fireEvent.click(screen.getByRole('tab', { name: 'Staking' }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/earn$/);
  });

  it("does nothing when pressed on the room's own pool", () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'bayla');
    at('/earn/bayla');
    fireEvent.click(screen.getByRole('tab', { name: 'Staking' }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/earn\/bayla$/);
  });
});
