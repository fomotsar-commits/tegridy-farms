// DashboardPage — the POL Accumulator card was a dead branch.
//
// THE BUG THIS PINS. The card was written as
//
//     {!isDeployed(POL_ACCUMULATOR_ADDRESS) && ( … "Coming Soon" … )}
//
// so it rendered a promise ONLY while the accumulator address was 0x0. When the
// contract deployed and its real address landed in constants.ts, `isDeployed()`
// flipped, the negation went false, and the card silently disappeared. The
// promise was never kept and never withdrawn — the dashboard simply stopped
// mentioning a feature it had advertised and that has still delivered nothing.
//
// GROUND TRUTH, read from mainnet 2026-08-12 before this copy was written:
//   POLAccumulator 0x2A5f65f4C74b1e49e77aE9A57e20fBDb0cED11D2
//     unpaused · totalETHReceived() = 0 · totalLPCreated() = 0 · balance 0
//   SwapFeeRouter  0x6d5791A660e79175F74C6D639584C98422d5956E
//     polShareBps() = 0 · polAccumulator() = 0x0
//
// A NOTE ON THE CLAIM. "Structurally cannot receive a wei" is FALSE of the
// contract: POLAccumulator.sol:282 has an unguarded `receive() external
// payable`, so anyone can send it ETH. What is true is narrower and is what the
// card says: it cannot be funded FROM PROTOCOL FEES as wired today, because the
// router's POL share is 0 bps and its accumulator slot is unset — the POL leg
// in SwapFeeRouter.sol:1392-1404 is dead code either way. This test pins the
// narrow claim and would fail on the broad one.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { POL_ACCUMULATOR_ADDRESS } from '../lib/constants';

const reads = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('wagmi', () => ({
  useAccount: () => ({ isConnected: false, address: undefined, isReconnecting: false, isConnecting: false }),
  useBalance: () => ({ data: undefined }),
  useChainId: () => 1,
  useReadContract: ({ functionName }: { functionName: string }) => ({ data: reads.current[functionName] }),
  useReadContracts: () => ({ data: [], refetch: () => {} }),
  useWriteContract: () => ({ writeContract: () => {}, data: undefined, isPending: false, error: null }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false }),
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
  return { m: passthrough, motion: passthrough, AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</> };
});
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));

import { POLAccumulatorCard } from './DashboardPage';
import { BUNGALOW_STORAGE_KEY } from '../lib/bungalows';

/** The wiring state actually on mainnet today: deployed, unfunded, unwired. */
function unwired(overrides: Record<string, unknown> = {}) {
  reads.current = {
    polShareBps: 0n,
    polAccumulator: '0x0000000000000000000000000000000000000000',
    totalETHReceived: 0n,
    totalLPCreated: 0n,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  unwired();
});


/**
 * ⚠️ THIS FILE STANDS INSIDE THE TOWELI BUNGALOW, EXPLICITLY, AS OF 2026-09-05.
 *
 * It renders the CLASSIC TOWELI surface, and until now it got there by
 * accident: the page's wrapper branched on `getActiveBungalow()` /
 * `getBungalowIdentity()`, both of which are null when NOTHING is chosen, so
 * "no bungalow" and "the TOWELI bungalow" fell into the same branch. A test that
 * set nothing therefore rendered the TOWELI page — and so did a stranger
 * arriving at the venue, which was the bug (one resident's ticker, ~30 times,
 * on a page the venue was supposed to be speaking on).
 *
 * The wrapper now uses `isToweliVoice()` (arrival.ts), which separates the two.
 * So this file says where it is standing instead of relying on a collapsed
 * state. Real storage, not a mocked gate — that keeps the assertions pointed at
 * the SAME predicate the app runs, so if the gate changes shape again these
 * fail rather than quietly testing a stub.
 */

// The venue speaks for the whole island; the classic TOWELI stack lives in its
// own room. Stand in that room before rendering.
beforeEach(() => {
  window.localStorage.setItem(BUNGALOW_STORAGE_KEY, 'toweli');
});
afterEach(() => {
  window.localStorage.removeItem(BUNGALOW_STORAGE_KEY);
});

describe('POL Accumulator card', () => {
  it('renders at all now that the contract is deployed', () => {
    // The whole bug in one assertion: pre-fix this card was gated on
    // NOT-deployed, so with a real address in constants.ts nothing rendered.
    expect(POL_ACCUMULATOR_ADDRESS).not.toBe('0x0000000000000000000000000000000000000000');
    render(<POLAccumulatorCard />);
    expect(screen.getByText('POL Accumulator')).toBeTruthy();
  });

  it('keeps the original promise copy instead of quietly dropping it', () => {
    // HARD RULE: additive only. The "will automatically accumulate LP positions"
    // paragraph is the promise being measured — it stays, and the status is
    // added beside it.
    render(<POLAccumulatorCard />);
    expect(screen.getByText(/automatically accumulate LP positions from a share of swap fees/i)).toBeTruthy();
  });

  it('states the true status: deployed, never funded, unfundable from fees as wired', () => {
    render(<POLAccumulatorCard />);
    const text = document.body.textContent ?? '';
    expect(/deployed\s+and unpaused on mainnet/i.test(text)).toBe(true);
    expect(/never received a wei/i.test(text)).toBe(true);
    expect(/cannot be funded from swap fees as wired today/i.test(text)).toBe(true);
    // The badge must not still read "Coming Soon" for a contract that shipped.
    expect(screen.queryByText(/Coming Soon/i)).toBeNull();
    expect(screen.getByText(/Deployed · Unfunded/i)).toBeTruthy();
  });

  it('does NOT overclaim that the contract is incapable of receiving ETH', () => {
    // POLAccumulator.receive() is unguarded — anyone can send it ETH. Saying it
    // "cannot receive" would be a new false claim replacing the old one, so the
    // correction is pinned in both directions.
    render(<POLAccumulatorCard />);
    const text = document.body.textContent ?? '';
    expect(/cannot receive/i.test(text), 'the contract CAN receive ETH; only the fee path is dead').toBe(false);
    expect(/unable to receive/i.test(text)).toBe(false);
  });

  it('links the address so the status can be checked, untruncated', () => {
    render(<POLAccumulatorCard />);
    expect(document.body.textContent).toContain(POL_ACCUMULATOR_ADDRESS);
    const link = Array.from(document.querySelectorAll('a[href]')).find((a) =>
      (a.getAttribute('href') ?? '').toLowerCase().includes(POL_ACCUMULATOR_ADDRESS.toLowerCase()),
    );
    expect(link).toBeTruthy();
  });

  it('reads its status from the chain — wire the router and it stops apologising', () => {
    // BREADTH, the other way. The point of reading rather than hardcoding is
    // that this card cannot rot the way the last one did. Both wiring
    // conditions have to hold: a non-zero share AND the router pointing here.
    unwired({ polShareBps: 1_000n, polAccumulator: POL_ACCUMULATOR_ADDRESS, totalETHReceived: 5n, totalLPCreated: 10n ** 18n });
    render(<POLAccumulatorCard />);
    const text = document.body.textContent ?? '';
    expect(/Wired and earning/i.test(text)).toBe(true);
    expect(/10\.00%/.test(text)).toBe(true);
    expect(/never received a wei/i.test(text)).toBe(false);
    expect(screen.getByText(/^Live$/)).toBeTruthy();
  });

  it('still reports unfunded when the share is set but the router points elsewhere', () => {
    // DEEP-R-M04 lets governance set one half without the other; a non-zero
    // share with an unset target folds into treasury, so "wired" needs both.
    unwired({ polShareBps: 1_000n, polAccumulator: '0x000000000000000000000000000000000000dEaD' });
    render(<POLAccumulatorCard />);
    const text = document.body.textContent ?? '';
    expect(/accumulator target is not set to this contract/i.test(text)).toBe(true);
    expect(screen.getByText(/Deployed · Unfunded/i)).toBeTruthy();
  });
});

// THE GAP THIS CLOSES. Everything above pins what the card SAYS. None of it pins
// that the card is on the page at all — and "silently vanished from the dashboard"
// is the entire original bug. Mutating DashboardPage's render site to
// `{false && <POLAccumulatorCard />}` leaves every test above green, because they
// import the component directly and never render the page.
//
// Rendering DashboardPage itself would need the whole wagmi/provider tree, so this
// asserts on the SOURCE instead. That is the right altitude here: the invariant is
// structural — the card is mounted unconditionally — not behavioural.
describe('the POL card is actually mounted on the dashboard', () => {
  // process.cwd() is frontend/ under vitest — same convention as
  // artStudioCoverage.test.ts:18. import.meta.url is NOT a file: URL here.
  const source = readFileSync(join(process.cwd(), 'src/pages/DashboardPage.tsx'), 'utf8');

  it('imports and renders POLAccumulatorCard', () => {
    expect(source).toMatch(/POLAccumulatorCard/);
    expect(source).toMatch(/<POLAccumulatorCard\s*\/>/);
  });

  it('mounts it UNCONDITIONALLY — no && guard, no ternary', () => {
    // The regression was a conditional that silently stopped matching. Any guard on
    // the render line reintroduces exactly that class, so the line must be bare.
    const line = source
      .split('\n')
      .find((l) => l.includes('<POLAccumulatorCard'));
    expect(line, 'render site must exist').toBeTruthy();
    expect(line, 'render site must not be behind && or ?:').not.toMatch(/&&|\?/);
  });
});
