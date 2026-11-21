// A tracked pool's card prints its spot price and its delta: prices, not amounts anyone gets
// or pays, so each rounds to the nearest digit shown. A cut reads one digit low.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { screen, fireEvent, within } from '@testing-library/react';
import { parseEther } from 'viem';
import { renderWithProviders } from '../../test-utils/render';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    { get: () => ({ children }: { children?: React.ReactNode }) => <div>{children}</div> },
  );
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});

const POOL = '0xAAaAAAaaAaAAAaAAaAAAaaaAaaaAaaAAaaAAaaAA';
const COLLECTION = '0xBBbBBBbbBbBBBbBBbBBBbbbBbbbBbbBBbbBBbbBB';
// Another wallet owns the pool, so the card shows no owner panel beside its stats.
const OWNER = '0x2222222222222222222222222222222222222222';
// 0.12345678 ETH is 0.1235 at the nearest (a cut is 0.1234); 0.01237 is 0.0124 (a cut is 0.0123).
const POOL_INFO = [COLLECTION, 0, parseEther('0.12345678'), parseEther('0.01237'), 0n, 0n, OWNER, 0n, 0n];

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0x1111111111111111111111111111111111111111', isConnected: true, isDisconnected: false, chain: { id: 1 } }),
  useChainId: () => 1,
  useBlockNumber: () => ({ data: 1n }),
  usePublicClient: () => ({ readContract: vi.fn(), getLogs: vi.fn(async () => []) }),
  useReadContract: (o: { functionName?: string }) => ({
    data: o.functionName === 'getPoolInfo' ? POOL_INFO : undefined,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  }),
  useReadContracts: () => ({ data: [], isError: false, isLoading: false, refetch: vi.fn() }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false }),
  useWatchContractEvent: () => undefined,
}));

import { AMMSection } from './AMMSection';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('tegridy-amm-tracked-pools', JSON.stringify([POOL]));
});

describe('a tracked pool’s card: spot price and delta', () => {
  it('round to the nearest digit shown, as the owner panel’s do', async () => {
    renderWithProviders(<AMMSection />);
    fireEvent.click(screen.getByRole('tab', { name: 'My Pools' }));
    const label = await screen.findByText('Spot Price');
    const card = within(label.closest('.grid') as HTMLElement);
    expect(card.getByText('Spot Price').nextElementSibling).toHaveTextContent(/^0\.1235 ETH$/);
    expect(card.getByText('Delta').nextElementSibling).toHaveTextContent(/^0\.0124 ETH$/);
  });
});
