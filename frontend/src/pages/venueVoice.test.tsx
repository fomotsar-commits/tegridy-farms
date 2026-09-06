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
 * ⚠️ WHAT MAKES THESE TESTS MEAN SOMETHING. Every one of them was RUN against
 * the defective code and observed to fail — the five voice cases against the old
 * two-branch wrapper, the two index cases against the wrong ladder floor — not
 * assumed to. A test nobody has watched fail is a test that pins nothing.
 *
 * The other half of the rule — that the classic TOWELI experience was RELOCATED
 * and not DELETED, which is what a careless "remove TOWELI everywhere" pass
 * would produce — is `FarmPage.boostAndBatch.test.tsx`. It stands up the whole
 * provider tree and renders ToweliFarm end to end, and as of 2026-09-05 it sets
 * the toweli bungalow explicitly, so it goes red if the stack is deleted while
 * everything below still passes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MIN_BOOST_BPS, MAX_BOOST_BPS } from '../lib/constants';


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
    // this repo keeps relearning. The ban is on the % SIGN specifically: the lock
    // ladder's own multipliers are written "0.40×–4.00×" rather than as
    // percentages, so a contract constant cannot be mistaken for a rate here.
    const table = screen.getByRole('table');
    expect(table.textContent).not.toMatch(/%/);
    expect(screen.getByText(/No rate is shown here because none is read here/i)).toBeInTheDocument();
  });

  it('still routes to the venue\'s own liquidity surface', () => {
    renderFarm();
    const lp = screen.getByRole('link', { name: /provide liquidity/i });
    expect(lp).toHaveAttribute('href', '/liquidity');
  });

  it('states the lock ladder\'s REAL floor, which is 0.4x and not 1x', () => {
    // ⚠️ THIS SHIPPED WRONG. The index advertised "1.00×–4.00×" while
    // LighthouseLadder.sol:98 sets MIN_BOOST_BPS = 4_000 — 0.4x at seven days,
    // mirrored in constants.ts and called "TOWELI parity" in lighthouseLadder.ts.
    // A 1.00× floor tells a short-lock staker they get a full share of the
    // rewards when the contract gives them four tenths of one: the worst case
    // overstated by 2.5x, on the page the venue shows a stranger first.
    //
    // Asserted against the CONSTANTS rather than the literal "0.40×", so a
    // genuine re-tune of the ladder moves the test and the UI together and only
    // a DRIFT between them fails.
    renderFarm();
    const table = screen.getByRole('table').textContent ?? '';
    const floor = `${(MIN_BOOST_BPS / 10_000).toFixed(2)}×`;
    const ceiling = `${(MAX_BOOST_BPS / 10_000).toFixed(2)}×`;
    expect(MIN_BOOST_BPS, 'precondition: the ladder floor is a fraction of a full share').toBeLessThan(10_000);
    expect(table, `the ladder rows never state the ${floor} floor`).toContain(floor);
    expect(table).toContain(ceiling);
    expect(table, 'the 1.00x floor came back').not.toContain('1.00×');
  });

  it('claims no lock terms for the Solana pools, because the registry records none', () => {
    // These rows said "Streamflow · locked" from `chain === 'solana'` alone.
    // The registry has no lock field — it records the PROGRAM — and the retired
    // BAYLA pool ran flat weights, so "locked" was a property nothing was read
    // to establish, on five rows at once.
    renderFarm();
    const table = screen.getByRole('table').textContent ?? '';
    expect(table, 'a Solana pool must still name its staking program').toContain('Streamflow');
    expect(table, 'lock terms asserted for a pool whose terms are not in the registry')
      .not.toContain('Streamflow · locked');
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
