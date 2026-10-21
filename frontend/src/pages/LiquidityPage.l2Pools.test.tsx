// Owner, 2026-10-20: "someone created a base LP pool (BRB/ETH) but it's not showing". None had
// been created, but one would not have shown either: off Ethereum the page drew only the form.
// Base and Robinhood Chain now list the pools in their own factory, and Add / Remove open the
// form on the pool picked.
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { BASE, fake, oneBrbPool, resetFake } from '../test/fakeFactory';
import type { LiquidityPick } from '../components/swap/LiquidityTab';

vi.mock('wagmi', async () => {
  const f = await import('../test/fakeFactory');
  return {
    useAccount: () => ({ isConnected: false }),
    useChainId: () => 1,
    useReadContract: f.useReadContract,
    useReadContracts: f.useReadContracts,
  };
});
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => {} }));
vi.mock('../hooks/usePoolTVL', () => ({ usePoolTVL: () => ({}) }));
vi.mock('../components/swap/LiquidityTab', () => ({
  LiquidityTab: ({ chainId, pick }: { chainId?: number; pick?: LiquidityPick }) => (
    <div data-testid="form">{[chainId, pick?.chainId, pick?.a.symbol, pick?.b.symbol, pick?.b.address, pick?.mode].join('|')}</div>
  ),
}));
vi.mock('../components/farm/ILCalculator', () => ({ ILCalculator: () => null }));
vi.mock('../components/liquidity/LiquidityPrimer', () => ({ LiquidityPrimer: () => null }));
vi.mock('../components/liquidity/VenuePoolTable', () => ({ VenuePoolTable: () => <div data-testid="pool-table" /> }));

import LiquidityPage from './LiquidityPage';

const at = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <LiquidityPage />
    </MemoryRouter>,
  );

beforeEach(resetFake);

describe("/liquidity off Ethereum lists that chain's own pools", () => {
  it('shows a Base pool the factory holds, and Add / Remove open the form on it', () => {
    oneBrbPool();
    at('/liquidity?c=8453');
    const row = screen.getByRole('rowheader', { name: /BRB \/ ETH/ }).closest('tr')!;
    expect(row).toHaveTextContent('0.3% fee, all to providers');
    expect(row).toHaveTextContent('100,000.0000 BRB');
    expect(row).toHaveTextContent('0.0500 ETH');

    fireEvent.click(within(row).getByRole('link', { name: 'Add' }));
    expect(screen.getByTestId('form')).toHaveTextContent('8453|8453|ETH|BRB|0x0e86eFe5Ba52336c2173AD69EE726e054619e0d8|add');
    fireEvent.click(within(row).getByRole('link', { name: 'Remove' }));
    expect(screen.getByTestId('form')).toHaveTextContent(/\|remove$/);
  });

  it("reads Base's own factory, on Base", () => {
    oneBrbPool();
    at('/liquidity?c=8453');
    const lengthRead = fake.calls.find((c) => c.functionName === 'allPairsLength')!;
    expect(lengthRead.address).toBe(BASE.factory);
    expect(fake.calls.every((c) => c.chainId === 8453)).toBe(true);
  });

  it('keeps Ethereum on its own table and reads no L2 factory there', () => {
    oneBrbPool();
    at('/liquidity');
    expect(screen.getByTestId('pool-table')).toBeInTheDocument();
    expect(screen.queryByTestId('chain-pools')).toBeNull();
    expect(fake.calls).toEqual([]);
  });
});
