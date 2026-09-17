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
import { MIN_BOOST_BPS, MAX_BOOST_BPS, CHAIN_ID } from '../lib/constants';
import { BUNGALOWS } from '../lib/bungalows';
import { AGGREGATOR_NAMES, SUPPORTED_CHAIN_ID } from '../lib/aggregator';
import { farmCardDesc } from '../lib/lpEmissions';
import { HOME_SWAP_CARD } from '../lib/copy';
import { ONBOARDING_SURFACES, onboardingSteps } from '../components/onboarding/onboardingSteps';
import { islandPools } from '../lib/terminal/islandPools';


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
import { POPULAR_TOKEN_SYMBOLS } from '../components/swap/TokenSelectModal';

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

/* ══════════════════════════════════════════════════════════════════════════
 * THE SAME RULING, ON THE SURFACES THE FarmPage GUARD CANNOT SEE.
 *
 * Everything above renders ONE page. The ruling in this file's header is not
 * about a page, though — it is about who the venue is — and three other
 * venue-voiced surfaces were still publishing the opposite claim with no guard
 * over them at all:
 *
 *   1. The first-run onboarding flow, which is the venue introducing itself to
 *      someone with no context. It told them /farm was where you "Stake and
 *      lock TOWELI" (at venue voice /farm is the island INDEX, so that was
 *      also just false), and its risk disclosure named TOWELI as the one token
 *      that could go to zero — reading as though the others could not.
 *   2. `lib/terminal/islandPools.ts`, whose row for the TOWELI/WETH pool was
 *      LABELLED "the venue's own pool". That label is prose: it is read back to
 *      the user by useIslandTape's ledger line when a pool does not answer.
 *      The file's own doc comment two lines above it says the venue's pool
 *      "carries NO static market claim" and is "one more row".
 *   3. The token picker's popular chips, where one resident sat permanently
 *      beside five chain-neutral majors (ETH/USDC/USDT/WBTC/WETH) and no other
 *      resident did.
 *
 * ⚠️ THE TICKER LIST IS READ FROM THE REGISTRY, not written here. A test that
 * banned the literal 'TOWELI' would pass the day a second resident got the same
 * favour, which is the actual property at stake. Two-letter and placeholder
 * symbols ('QR', '?') are excluded because they collide with ordinary prose and
 * with punctuation, not because they are allowed to be favoured.
 * ══════════════════════════════════════════════════════════════════════════ */
const RESIDENT_TICKERS = BUNGALOWS.map((b) => b.symbol).filter((s) => /^[A-Z]{3,}$/.test(s));

describe('the venue-voiced PROSE speaks for the island, not for one resident', () => {
  it('precondition: the registry holds several residents to be even-handed between', () => {
    expect(RESIDENT_TICKERS, 'TOWELI is not in the registry — this guard is pinning nothing')
      .toContain('TOWELI');
    expect(RESIDENT_TICKERS.length, 'one resident is not an island').toBeGreaterThan(3);
  });

  it('names no single resident anywhere in the first-run onboarding copy', () => {
    // Both halves: the surface table (whose blurbs survive gate changes) and the
    // assembled steps (whose bodies carry the risk disclosure).
    const copy = [
      ...ONBOARDING_SURFACES.map((s) => `${s.label} ${s.blurb}`),
      ...onboardingSteps().flatMap((s) => [
        s.title,
        ...s.body,
        ...s.actions.map((a) => `${a.label} ${a.blurb}`),
      ]),
    ].join('\n');

    for (const ticker of RESIDENT_TICKERS) {
      expect(
        copy,
        `the venue's own welcome singles out ${ticker} — see components/onboarding/onboardingSteps.ts`,
      ).not.toContain(ticker);
    }
  });

  it('still WARNS in the risk step after that de-naming — the fix is a reword, not a deletion', () => {
    // The paragraph that named TOWELI is a real disclosure. Broadening who it
    // covers must not quietly drop what it says, so the warning itself is pinned
    // here as well as in onboardingSteps.test.ts.
    const risks = onboardingSteps().find((s) => s.id === 'risks');
    expect(risks, 'the risk step is gone').toBeTruthy();
    const body = (risks?.body ?? []).join('\n').toLowerCase();
    expect(body, 'the "can go to zero" warning was lost in the reword').toContain('zero');
    expect(body, 'the early-exit penalty warning was lost in the reword').toContain('penalty');
    expect(body, 'the permanence warning was lost in the reword').toContain('permanent');
  });

  it('labels no island pool as the venue\'s own', () => {
    // The venue does not have a pool, because it does not have a token. Every
    // row here is a resident's. Asserted over the whole list rather than over
    // one constant, so a second favoured row fails too.
    for (const pool of islandPools()) {
      expect(
        pool.label,
        `island pool label claims venue ownership: "${pool.label}" — see lib/terminal/islandPools.ts`,
      ).not.toMatch(/\b(venue|our|its)\b[^.]*\bown\b/i);
      expect(pool.label, 'an island pool label makes a market claim').not.toMatch(/deepest|best|largest|\$/i);
    }
  });

  it('gives no resident a permanent front-row chip in the token picker', () => {
    // The chips are the picker's "everyone needs these" row. Chain-neutral
    // majors qualify; a resident does not, and there is no even-handed version
    // of this list that includes one resident and not the other eleven.
    expect(POPULAR_TOKEN_SYMBOLS.length, 'the chip row was emptied rather than de-favoured')
      .toBeGreaterThan(3);
    for (const ticker of RESIDENT_TICKERS) {
      expect(
        POPULAR_TOKEN_SYMBOLS,
        `${ticker} holds a front-row chip no other resident holds — see components/swap/TokenSelectModal.tsx`,
      ).not.toContain(ticker);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HOME SURFACE CARDS, WHICH DESCRIBE ROOMS THEY DO NOT OWN.
 *
 * ⚠️ READ THE GATE BEFORE READING THE COPY. This grid renders behind
 * `IS_TOWELI_ARRIVAL && !bungalowIdentity` (HomePage.tsx) — it is inside TOWELI's
 * own bungalow, and the ruling at the top of this file does NOT reach it. The
 * venue is not speaking here; a resident is, in his own house. The card beside
 * this one says "Stake TOWELI to earn now" (lpEmissions.farmCardDesc) and is
 * meant to. Anyone arriving at this file to "finish the sweep" by stripping
 * tickers out of this grid would be deleting a resident's furniture to prove the
 * venue owns none, which is the exact over-correction the header above warns
 * about — so both halves are pinned below.
 *
 * WHAT WAS ACTUALLY WRONG, and it is not a voice fault: the /swap card described
 * a SHARED surface as one pair on one route. "Trade ETH ↔ TOWELI via Uniswap V2"
 * over `stat: 'Uniswap V2'` named one of the NINE sources useSwapQuote races —
 * the venue's own pool, Uniswap V2, and the seven aggregators in
 * AGGREGATOR_NAMES — and dropped the venue's own DEX from the description of the
 * venue's own swap surface. Same family as the "2 pools" stat contradicting its
 * own body two cards over: a string that was true when it was typed and was
 * never re-read against the thing it describes.
 *
 * The pair ban is REGISTRY-DERIVED, like every other ticker rule in this file. A
 * test pinned to the literal "ETH ↔ TOWELI" would pass the day the card read
 * "ETH ↔ BAYLA", which is the property actually at stake.
 * ══════════════════════════════════════════════════════════════════════════ */
describe('the Home surface cards describe the surface they link to', () => {
  const residentTickers = BUNGALOWS.map((b) => b.symbol).filter((s) => /^[A-Z]{3,}$/.test(s));

  it('precondition: the registry holds several residents to be even-handed between', () => {
    expect(residentTickers, 'TOWELI is not in the registry — the pair rule below pins nothing')
      .toContain('TOWELI');
    expect(residentTickers.length, 'one resident is not an island').toBeGreaterThan(3);
  });

  it('does not pin the shared swap surface to one resident PAIR', () => {
    // /swap quotes every token in the list, not a pair. Banning the adjacency
    // rather than the ticker is what lets TOWELI keep the mention he is entitled
    // to in his own bungalow while "ETH ↔ <anyone>" stays out.
    for (const ticker of residentTickers) {
      const pair = new RegExp(
        String.raw`\b(?:W?ETH)\b\s*[↔<>/–—-]+\s*${ticker}\b` +
        String.raw`|\b${ticker}\b\s*[↔<>/–—-]+\s*(?:W?ETH)\b`,
        'i',
      );
      expect(
        HOME_SWAP_CARD.desc,
        `the Home /swap card sells a whole token list as the ${ticker} pair — see lib/copy.ts HOME_SWAP_CARD`,
      ).not.toMatch(pair);
    }
  });

  it('names the venue\'s own DEX and the aggregators, not one source of the nine', () => {
    expect(HOME_SWAP_CARD.desc, 'the venue\'s own DEX is missing from the description of the venue\'s own swap surface')
      .toMatch(/\b(?:venue|native)\b[^.]{0,16}\bDEX\b/i);
    expect(HOME_SWAP_CARD.desc, 'the routed aggregators are missing — seven of the nine sources')
      .toMatch(/aggregator/i);
    // Constant-derived: a genuine change to what /swap races moves this list and
    // the copy together, and only a DRIFT between them fails.
    const oneSourceOfNine = [...Object.values(AGGREGATOR_NAMES), 'Uniswap V2', 'Venue DEX'];
    expect(
      oneSourceOfNine,
      `the stat prints "${HOME_SWAP_CARD.stat}" as though one source were the route`,
    ).not.toContain(HOME_SWAP_CARD.stat);
  });

  it('claims exactly the chain that surface runs on, and no more', () => {
    // A FORWARD guard, not a regression pin: 'Ethereum' was already correct. It
    // is correct BECAUSE both legs are mainnet — the on-chain routes read at
    // CHAIN_ID and the aggregator leg short-circuits off SUPPORTED_CHAIN_ID — so
    // the day either moves, a single-chain label on this card needs re-reading.
    expect(
      SUPPORTED_CHAIN_ID,
      'the aggregator leg no longer follows CHAIN_ID — re-read the /swap card\'s single chain label',
    ).toBe(CHAIN_ID);
    expect(HOME_SWAP_CARD.label).toBe('Ethereum');
  });

  it('leaves the resident\'s own furniture standing — a reword, not a de-naming', () => {
    // The other half, and the reason this block is not a ticker ban. Both cards
    // render ONLY in TOWELI's bungalow. A sweep that strips his name out of his
    // own house to satisfy the header above has broken something, not fixed it.
    expect(farmCardDesc('ended'), 'the /farm card was de-named in TOWELI\'s own bungalow')
      .toContain('TOWELI');
    expect(HOME_SWAP_CARD.desc, 'the /swap card was de-named in TOWELI\'s own bungalow')
      .toContain('TOWELI');
  });
});
