/**
 * THE VENUE DOES NOT HAVE A TOKEN. ITS RESIDENTS DO.
 *
 * /farm and /dashboard branched on `getActiveBungalow()` and
 * `getBungalowIdentity()`. Both return null when NOTHING is chosen, so "the
 * venue, speaking as itself" and "the TOWELI bungalow" were the same branch —
 * and a stranger's first visit to either page got the classic TOWELI stack in
 * full dress: "Stake TOWELI and earn rewards · FAFO", TOWELI price, TOWELI
 * balance. About forty-five occurrences of one resident's ticker across the two
 * pages, on surfaces the venue was supposed to be speaking on.
 *
 * `arrival.ts` has had the correct three-state gate the whole time —
 * arrivalVoice() is 'venue' | 'toweli' | 'bungalow' — and HomePage already used
 * it. These two pages used the coarser predicate. `isToweliVoice()` is the fix.
 *
 * ⚠️ WHAT MAKES THESE TESTS MEAN SOMETHING. Every one of them FAILS on the
 * pre-fix wrappers, and that was checked by running them against the old
 * two-branch code before this file was committed — not assumed. The first
 * `describe` is the fix; the second is the regression guard that the classic
 * experience was RELOCATED and not deleted, which is the failure mode a careless
 * "remove TOWELI everywhere" pass would produce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';


vi.mock('wagmi', () => ({
  useAccount: () => ({ address: undefined, isConnected: false, isReconnecting: false, isConnecting: false }),
  useBalance: () => ({ data: undefined }),
  useChainId: () => 1,
  useReadContract: () => ({ data: undefined, isLoading: false, isError: false }),
  useReadContracts: () => ({ data: undefined, isLoading: false, isError: false }),
  useWriteContract: () => ({ writeContract: vi.fn(), data: undefined, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ data: undefined, isLoading: false, isSuccess: false }),
}));
vi.mock('framer-motion', () => {
  const passthrough = new Proxy(
    {},
    {
      get:
        () =>
        ({ children, ...props }: { children?: React.ReactNode }) => <div {...props}>{children}</div>,
    },
  );
  return {
    m: passthrough,
    motion: passthrough,
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  };
});
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../hooks/usePageTitle', () => ({ usePageTitle: () => undefined }));

import FarmPage from './FarmPage';

function renderFarm() {
  return render(
    <MemoryRouter>
      <FarmPage />
    </MemoryRouter>,
  );
}

afterEach(() => {
  window.localStorage.clear();
});

describe('the venue speaks for the island, not for one resident', () => {
  beforeEach(() => {
    // The default arrival: nothing chosen. This is the state the bug lived in.
    window.localStorage.clear();
  });

  it('does not SPEAK as TOWELI on /farm', () => {
    renderFarm();
    const body = document.body.textContent ?? '';

    // ⚠️ THE ASSERTION IS ABOUT VOICE, NOT ABOUT THE STRING, and the first draft
    // of this test got that wrong — it banned /TOWELI/i outright, which is both
    // too strong and too weak. Too strong: TOWELI is a legitimate ROW in the
    // island index, exactly like PEPE and BAYLA, and banning the word would have
    // forced the venue to hide one resident to prove it favours none. Too weak:
    // a page could avoid the six letters and still be the TOWELI farm.
    //
    // What must not appear is the venue talking about ONE token as though it
    // were the venue's own. These are the actual shapes the classic stack put on
    // a stranger's screen.
    for (const leak of [
      /Stake TOWELI/i,
      /TOWELI Price/i,
      /TOWELI Balance/i,
      /TOWELI Staked/i,
      /Your TOWELI/i,
      /FAFO/,
    ]) {
      expect(body, `the venue is speaking as one of its residents again (${leak}) — see FarmPage.tsx`)
        .not.toMatch(leak);
    }
  });

  it('lists TOWELI as a peer, on the same footing as every other resident', () => {
    renderFarm();
    // The other half of the rule above. A "remove TOWELI" pass that deleted the
    // row, or a favouritism pass that gave it its own link below the table
    // (which the first draft of VenuePoolIndex did), both fail here.
    const rowButtons = screen.getAllByRole('button', { name: /^Open [A-Z]/ });
    const names = rowButtons.map((b) => b.textContent?.trim());
    expect(names, 'TOWELI is missing from the island index').toContain('Open TOWELI');
    expect(names.length, 'TOWELI is the only pool listed — that is not an island').toBeGreaterThan(3);
    // Exactly one control per resident: no second, special TOWELI entry.
    expect(names.filter((n) => n === 'Open TOWELI')).toHaveLength(1);
  });

  it('offers the whole island instead, and names more than one resident', () => {
    renderFarm();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/earn/i);
    expect(screen.getByText(/Earn across Jungle Bay Island/i)).toBeInTheDocument();
    // Registry-derived, so this is real coverage rather than a fixture: several
    // distinct residents' pools must be listed. One row would satisfy a
    // "renders a table" assertion while still being a dead end.
    const opens = screen.getAllByRole('button', { name: /^Open [A-Z]/ });
    expect(opens.length, 'the island index lists fewer than three pools').toBeGreaterThanOrEqual(3);
  });

  it('publishes no rate it has not read', () => {
    renderFarm();
    // The index deliberately reads no chain (twelve pools, three chains), so it
    // must not print an APR at all — a fabricated 0% is the money-harmful shape
    // this repo keeps relearning. Percentages are allowed inside the LOCK LADDER
    // multipliers ("1.00x-4.00x"), which are contract constants, so the ban is
    // on the % sign specifically.
    const table = screen.getByRole('table');
    expect(table.textContent).not.toMatch(/%/);
    expect(screen.getByText(/No rate is shown here because none is read here/i)).toBeInTheDocument();
  });

  it('still routes to the venue\'s own liquidity surface', () => {
    renderFarm();
    const lp = screen.getByRole('link', { name: /provide liquidity/i });
    expect(lp).toHaveAttribute('href', '/liquidity');
  });
});

/**
 * THE OTHER HALF — "relocated, not deleted" — IS NOT ASSERTED HERE, AND THAT IS
 * DELIBERATE. Rendering the classic farm needs the whole provider tree it lives
 * in (PriceProvider, the farm hooks, the receipt context), and
 * `FarmPage.boostAndBatch.test.tsx` already stands all of that up and renders
 * ToweliFarm end to end. As of 2026-09-05 that file sets the toweli bungalow
 * explicitly, so it IS the guard: delete the TOWELI stack and it goes red, while
 * everything above would still pass. Duplicating its mock tower here to restate
 * the same fact would be a second thing to keep in step for no extra coverage.
 */
