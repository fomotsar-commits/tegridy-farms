// THE WORDING, PINNED WHERE THE USER READS IT.
//
// automation.test.ts pins the strings. This pins that they reach the screen —
// including on the screen a user is most likely to be looking at when it matters,
// the one with a red row and a big button on it. A constant nobody renders proves
// nothing about what a borrower was told.
//
// The two states asserted hardest are the ones that decide whether this feature
// helps or harms:
//
//   unreadable  — the RPC could not answer. This must NOT render as "no positions
//                 at risk". A calm screen during an outage is the failure mode.
//   at-risk     — a loan hours from its deadline. The "you execute this yourself"
//                 sentence must be on screen alongside the button, not a tab away.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  buildSnapshot,
  idleSnapshot,
  loadingSnapshot,
  unreadableSnapshot,
  type RawLoanRead,
  type ShieldPositionsSnapshot,
} from '../../lib/shield/positions';

const NOW = Math.floor(Date.now() / 1000);
const BORROWER = '0x1111111111111111111111111111111111111111';
const LENDING = '0x89BeB6cc0255B7465c01aA38a6f937efd345f14F';

const state = vi.hoisted(() => ({
  snapshot: null as unknown,
  alerts: {
    rules: [] as unknown[],
    evaluations: [] as unknown[],
    counts: { fired: 0, quiet: 0, cannotEvaluate: 0, off: 0 },
    lastRunAt: null as number | null,
    running: false,
    coverage: 'Rules are evaluated in this browser tab, only while this page is open.',
    storeProblem: null as string | null,
    runNow: vi.fn(),
  },
}));

// The hooks are stubbed because they are the RPC boundary; everything below them
// — the health model, the prepared-action builder, the copy — is REAL, so this
// test proves the shipped sentences rather than a mock's.
vi.mock('../../hooks/useShieldPositions', () => ({
  useShieldPositions: () => state.snapshot,
}));
vi.mock('../../hooks/useShieldAlerts', () => ({
  useShieldAlerts: () => state.alerts,
}));
vi.mock('wagmi', () => ({
  useAccount: () => ({ address: BORROWER }),
  useChainId: () => 1,
  useSendTransaction: () => ({ sendTransaction: vi.fn(), data: undefined, isPending: false, error: null }),
  useWaitForTransactionReceipt: () => ({ isLoading: false, isSuccess: false, isError: false }),
}));

import { ShieldPanel } from './ShieldPanel';

function raw(over: Partial<RawLoanRead> = {}): RawLoanRead {
  return {
    loanId: 4,
    venue: 'tegridy-nft-lending',
    lendingContract: LENDING as `0x${string}`,
    collateralContract: '0x4444444444444444444444444444444444444444',
    tokenId: 77n,
    principal: 1_000_000_000_000_000_000n,
    borrower: BORROWER,
    repaid: false,
    defaultClaimed: false,
    effectiveDeadlineUnix: NOW + 3 * 3600,
    minGraceSeconds: 3600,
    defaultedOnChain: false,
    quotedRepayWei: 1_010_000_000_000_000_000n,
    ...over,
  };
}

function mount(snapshot: ShieldPositionsSnapshot) {
  state.snapshot = snapshot;
  return render(<ShieldPanel />);
}

beforeEach(() => {
  state.alerts.rules = [];
  state.alerts.evaluations = [];
  state.alerts.storeProblem = null;
});

describe('the automation claim is on screen before anything else', () => {
  it.each([
    ['idle', () => idleSnapshot()],
    ['loading', () => loadingSnapshot()],
    ['unreadable', () => unreadableSnapshot()],
    ['empty', () => buildSnapshot([], NOW)],
    ['at risk', () => buildSnapshot([raw()], NOW)],
  ])('in the %s state it says execution is the user’s', (_name, make) => {
    mount(make() as ShieldPositionsSnapshot);
    expect(screen.getAllByText(/You execute this yourself/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Not automated/i).length).toBeGreaterThan(0);
  });

  it('states that monitoring stops with the tab', () => {
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/Close the tab and nothing is being read/i)).toBeTruthy();
  });

  it('states that an alert does not repay anything', () => {
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/It does not repay anything/i)).toBeTruthy();
  });

  it('states that no partial repay, top-up or deleverage exists on these loans', () => {
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/no partial repayment, no collateral top-up and no deleverage/i)).toBeTruthy();
  });

  it('renders the sentence alongside the signing button, not on another screen', () => {
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByRole('button', { name: /Review and sign repayment/i })).toBeTruthy();
    expect(screen.getAllByText(/You execute this yourself/i).length).toBeGreaterThanOrEqual(2);
  });
});

describe('an outage never renders as calm', () => {
  it('says the loans could not be read', () => {
    mount(unreadableSnapshot());
    expect(screen.getByText(/failed read, not an absence of debt/i)).toBeTruthy();
  });

  it('does not render the "no open borrow" line during an outage', () => {
    mount(unreadableSnapshot());
    expect(screen.queryByText(/no open borrow on the venue/i)).toBeNull();
  });

  it('renders the "no open borrow" line only when the read succeeded and found none', () => {
    mount(buildSnapshot([], NOW));
    expect(screen.getByText(/no open borrow on the venue/i)).toBeTruthy();
  });

  it('shows a loan whose deadline could not be read as unknown, not as safe', () => {
    mount(buildSnapshot([raw({ effectiveDeadlineUnix: null })], NOW));
    expect(screen.getByText('Unknown')).toBeTruthy();
    // Twice on purpose: once as the row's health, once as the reason no
    // transaction was prepared. Neither may be dropped for tidiness.
    expect(screen.getAllByText(/failed read, not a loan that is fine/i).length).toBe(2);
    expect(screen.queryByRole('button', { name: /Review and sign repayment/i })).toBeNull();
  });
});

describe('the prepared transaction is shown before it is signed', () => {
  it('names the call, the target and the amount that will leave the wallet', () => {
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText('repayLoan(4)')).toBeTruthy();
    expect(screen.getByText(LENDING)).toBeTruthy();
    expect(screen.getByText(/Accrual buffer/i)).toBeTruthy();
  });

  it('refuses to offer a signature once the contract reports the loan defaulted', () => {
    mount(buildSnapshot([raw({ effectiveDeadlineUnix: NOW - 100_000, defaultedOnChain: true })], NOW));
    expect(screen.getAllByText(/repayment window has closed/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /Review and sign repayment/i })).toBeNull();
  });

  // The screen a borrower sees during the pause-extended grace. Before the fix
  // this rendered the "collateral is the lender's" refusal and no button, on a
  // loan the contract would still have accepted a repayment for.
  it('still offers the signature past the minimum grace while the contract reports no default', () => {
    mount(buildSnapshot([raw({ effectiveDeadlineUnix: NOW - 100_000, defaultedOnChain: false })], NOW));
    expect(screen.getByRole('button', { name: /Review and sign repayment/i })).toBeTruthy();
    expect(screen.queryByText(/repayment window has closed/i)).toBeNull();
    expect(screen.getByText(/how much longer is unknown/i)).toBeTruthy();
  });

  it('never claims a health factor for these loans', () => {
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/This loan has no health factor/i)).toBeTruthy();
  });
});

describe('venues this page cannot read are named', () => {
  it('says an external position is not being watched', () => {
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/Not covered by this page/i)).toBeTruthy();
    expect(screen.getByText('Aave v3')).toBeTruthy();
    expect(screen.getByText('Morpho Blue')).toBeTruthy();
  });

  it('says the absence of a row means nothing was asked', () => {
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/means nothing was asked/i)).toBeTruthy();
  });
});

describe('having no alert rule is stated, not implied by an absent section', () => {
  it('says nothing will notify you when a position is at risk and no rule exists', () => {
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/Nothing will notify you/i)).toBeTruthy();
  });

  it('drops that line once a rule exists', () => {
    state.alerts.rules = [{ id: 'r1' }];
    mount(buildSnapshot([raw()], NOW));
    expect(screen.queryByText(/Nothing will notify you/i)).toBeNull();
  });

  it('frames a rule-store failure for this surface instead of orphaning the operator sentence', () => {
    state.alerts.storeProblem = 'The alert_rules table has not been created.';
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/Deadline alerts cannot be read or created right now/i)).toBeTruthy();
  });
});

describe('alert gaps are shown as gaps', () => {
  it('renders a cannot-evaluate verdict rather than dropping it', () => {
    state.alerts.rules = [{ id: 'r1' }];
    state.alerts.evaluations = [
      {
        ruleId: 'r1',
        kind: 'loan-deadline',
        verdict: 'cannot-evaluate',
        events: [],
        detail: 'The shield has not finished reading this wallet’s loans, so no deadline was judged.',
        evaluatedAt: NOW,
      },
    ];
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/so no deadline was judged/i)).toBeTruthy();
  });

  it('carries the engine’s coverage sentence wherever verdicts are shown', () => {
    state.alerts.rules = [{ id: 'r1' }];
    mount(buildSnapshot([raw()], NOW));
    expect(screen.getByText(/only while this page is open/i)).toBeTruthy();
  });
});
