/**
 * EARN ALWAYS LEADS BACK TO THE LIST (owner, 2026-09-30).
 *
 * "When you are in Staking of an asset there is no way to go back to the main
 * Earn page to choose another asset. When I click on Earn on the top bar it
 * stays on the same page." The Earn word pointed at /farm, and /farm rendered
 * whatever pool the STORED room named — so from inside a pool, the word, the
 * Staking tab and a reload all drew that same pool again.
 *
 * Now /earn is the list whatever room is stored, and /earn/<id> is one pool
 * with a link back. Both halves were seen to fail against the /farm wrapper.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { BUNGALOW_STORAGE_KEY, BUNGALOWS, DEFAULT_BUNGALOW_ID } from '../lib/bungalows';

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false, isReconnecting: false, isConnecting: false }),
  useBalance: () => ({ data: undefined }),
  useChainId: () => 1,
  useReadContract: () => ({ data: undefined, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: undefined, isLoading: false, isError: false }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false }),
}));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));
// The pool cards themselves are out of scope: they are lazy, and each has its own tests.
vi.mock('../components/bungalow/HeatCard', () => ({ HeatCard: () => null }));
vi.mock('../components/solana/SolanaProviders', () => ({
  SolanaProviders: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import FarmPage from './FarmPage';

/** A resident with its own pool page, other than TOWELI's classic farm. */
const room = BUNGALOWS.find((b) => b.live && b.id !== DEFAULT_BUNGALOW_ID && (b.stakePool || b.ladderPool))!;

function at(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/earn" element={<FarmPage />} />
        <Route path="/earn/:poolId" element={<FarmPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe('Earn always leads back to the list', () => {
  it.each([
    ['a resident pool', () => room.id],
    ["TOWELI's room", () => DEFAULT_BUNGALOW_ID],
  ])('/earn lists every pool while %s is the stored room', (_, id) => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, id());
    at('/earn');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Earn$/);
    const opens = screen.getAllByRole('link', { name: /^Open [A-Z]/ });
    expect(opens.length, 'the list is a dead end with fewer than three pools').toBeGreaterThanOrEqual(3);
    expect(opens.map((a) => a.getAttribute('href'))).toContain(`/earn/${room.id}`);
  });

  it('a pool page names its pool and links back to the list', async () => {
    at(`/earn/${room.id}`);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(`Stake ${room.symbol}.`);
    expect(screen.getByRole('link', { name: /back to earn/i })).toHaveAttribute('href', '/earn');
  });

  it('an unknown pool id renders the list, not some other pool', () => {
    window.localStorage.setItem(BUNGALOW_STORAGE_KEY, room.id);
    at('/earn/not-a-resident');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Earn$/);
  });
});
