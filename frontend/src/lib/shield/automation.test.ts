// THE WORDING IS THE PRODUCT.
//
// This feature's whole risk is one sentence away from being harmful. "Liquidation
// shield" sounds like something that saves you; the venue runs no keeper, so
// nothing does. A user who believes they are protected stops watching, and if
// nothing fires they lose the whole collateral NFT AND the hours in which they
// would have acted. They are strictly worse off than a user who was told plainly
// that execution is theirs.
//
// So the copy is pinned here, not reviewed. The banned-phrase sweep runs over
// EVERY exported user-facing string in the shield — including the ones health.ts
// and preparedAction.ts generate at runtime — so a future surface cannot
// introduce "we'll repay for you" in a file nobody thought to add to a list.

import { describe, it, expect } from 'vitest';
import {
  ALERT_IS_NOT_AN_ACTION,
  EXECUTION_IS_YOURS,
  F4_REQUIREMENTS,
  MONITORING_SCOPE,
  ONLY_FULL_REPAYMENT,
  SHIELD_AUTOMATION_AVAILABLE,
  SHIELD_COPY,
  shieldAutomationState,
} from './automation';
import { NO_HEALTH_FACTOR_DETAIL, assessDeadlineHealth } from './health';
import { prepareRepay, type PreparedRepayInput } from './preparedAction';
import { SHIELD_VENUES, shieldVenueReadiness } from './venues';
import { IDLE_DETAIL, LOADING_DETAIL, READ_FAILED_DETAIL } from './positions';
import type { Loan } from '../gondi/loanMath';

const BORROWER = '0x1111111111111111111111111111111111111111' as const;
const LENDING = '0x2222222222222222222222222222222222222222' as const;
const NOW = 1_700_000_000;
const ONE = 1_000_000_000_000_000_000n;

const startTime = BigInt(NOW - 86_400);
const LOAN: Loan = {
  borrower: BORROWER,
  nftCollateralTokenId: 3n,
  nftCollateralAddress: '0x4444444444444444444444444444444444444444',
  principalAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  principalAmount: ONE,
  startTime,
  duration: BigInt(86_400 + 3600),
  tranche: [{ loanId: 3n, floor: 0n, principalAmount: ONE, lender: '0x3333333333333333333333333333333333333333', accruedInterest: 0n, startTime, aprBps: 1000n }],
  protocolFee: 500n,
  lenderRefinanceDisabled: false,
};

/**
 * Phrases that promise an execution nobody performs. Matched case-insensitively
 * against the whole shield surface.
 */
const BANNED_PROMISES: RegExp[] = [
  /\bwe(?:'|’)?ll\s+(?:repay|save|protect|top\s*up|deleverage)/i,
  /\bautomatically\s+(?:repay|repaid|save[sd]?|protect|top\s*up|deleverage)/i,
  /\bauto[-\s]?(?:repay|rescue|save)/i,
  /\bliquidation[-\s]?proof/i,
  /\bnever\s+(?:be\s+)?liquidated/i,
  /\bkeeps?\s+you\s+safe/i,
  /\bwe\s+(?:will\s+)?(?:monitor|watch)\s+(?:your|this)\s+position\s+(?:24\/7|around the clock|continuously)/i,
  /\bon\s+your\s+behalf/i,
  /\bhands[-\s]?free/i,
  /\bset\s+(?:it\s+)?and\s+forget/i,
  /\byour\s+position\s+is\s+protected/i,
];

/** Every user-facing sentence the shield can render, gathered from the real code. */
function everyShieldSentence(): string[] {
  const out: string[] = [
    // signButton is one label per repayment step; every label is swept.
    ...Object.values(SHIELD_COPY).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v))),
    ...F4_REQUIREMENTS,
    NO_HEALTH_FACTOR_DETAIL,
    IDLE_DETAIL,
    LOADING_DETAIL,
    READ_FAILED_DETAIL,
    shieldAutomationState().statusDetail,
  ];

  for (const venue of Object.values(SHIELD_VENUES)) {
    out.push(venue.label, venue.lossOnTrigger, venue.operatorStep);
  }
  for (const readiness of Object.values(shieldVenueReadiness())) {
    if (readiness.detail) out.push(readiness.detail);
  }

  // Health copy is generated, so it is generated here rather than transcribed,
  // at every band: past the deadline, at it, urgent, watch and safe.
  const offsets = [-100_000, -5_000, -60, 0, 3600, 40 * 3600, 100 * 3600];
  for (const offset of offsets) {
    const health = assessDeadlineHealth({ deadlineUnix: NOW + offset, nowUnix: NOW });
    out.push(health.headline, health.consequence, health.healthFactorDetail);
  }

  // Prepared-action copy: the disclosure of every step and every refusal.
  const base: PreparedRepayInput = {
    loanId: 3,
    loan: LOAN,
    lendingContract: LENDING,
    chainId: 1,
    expectedChainId: 1,
    account: BORROWER,
    health: assessDeadlineHealth({ deadlineUnix: NOW + 3600, nowUnix: NOW }),
    nowUnix: NOW,
    wethBalance: 2n * ONE,
    wethAllowance: 2n * ONE,
  };

  const variants: PreparedRepayInput[] = [
    base,
    { ...base, wethBalance: 0n },
    { ...base, wethAllowance: 0n },
    { ...base, lendingContract: null },
    { ...base, account: null },
    { ...base, chainId: 8453 },
    { ...base, account: '0x9999999999999999999999999999999999999999' },
    { ...base, wethBalance: null },
    { ...base, health: assessDeadlineHealth({ deadlineUnix: NOW - 100_000, nowUnix: NOW }) },
  ];
  for (const v of variants) {
    const result = prepareRepay(v);
    out.push(result.ok ? result.action.disclosure : result.reason);
  }

  return out.filter((s) => typeof s === 'string' && s.length > 0);
}

describe('the shield never claims an execution nobody performs', () => {
  it('has no automated executor', () => {
    expect(SHIELD_AUTOMATION_AVAILABLE).toBe(false);
  });

  it('reports "Not automated", with no optimistic middle state', () => {
    const state = shieldAutomationState();
    expect(state.automated).toBe(false);
    expect(state.statusLabel).toBe('Not automated');
    expect(state.statusLabel).not.toMatch(/pending|starting|queued|soon/i);
  });

  it('names the user as the executor, in those words', () => {
    expect(EXECUTION_IS_YOURS).toMatch(/you repay it yourself/i);
    expect(EXECUTION_IS_YOURS).toMatch(/nothing watches or signs for you/i);
  });

  it('states that monitoring stops when the tab does', () => {
    expect(MONITORING_SCOPE).toMatch(/while the page is open/i);
    expect(MONITORING_SCOPE).toMatch(/close the tab and nothing is being read/i);
  });

  it('separates an alert from an intervention', () => {
    expect(ALERT_IS_NOT_AN_ACTION).toMatch(/does not repay/i);
    expect(ALERT_IS_NOT_AN_ACTION).toMatch(/you still have to sign/i);
  });

  it('describes itself as monitoring and preparation, not rescue', () => {
    expect(SHIELD_COPY.subtitle).toMatch(/not automated/i);
  });

  it('says the smaller moves a borrower would look for do not exist here', () => {
    // A borrower's `repayLoan` on Gondi's loan contract repays every tranche whole.
    // A user hunting for a partial repay or a deleverage is hunting for something
    // that is not there, with a deadline running.
    expect(ONLY_FULL_REPAYMENT).toMatch(/no partial repayment/i);
    expect(ONLY_FULL_REPAYMENT).toMatch(/no collateral top-up/i);
    expect(ONLY_FULL_REPAYMENT).toMatch(/no deleverage/i);
  });

  it.each(BANNED_PROMISES.map((re) => [re.source, re] as const))(
    'no shield sentence matches /%s/',
    (_label, pattern) => {
      const offenders = everyShieldSentence().filter((s) => pattern.test(s));
      expect(offenders).toEqual([]);
    },
  );

  it('gathered a real surface — a zero-length sweep would pass vacuously', () => {
    expect(everyShieldSentence().length).toBeGreaterThan(40);
  });
});

describe('what F4 must supply is stated, not implied', () => {
  it('lists requirements while automation is unavailable', () => {
    expect(shieldAutomationState().requirements.length).toBe(F4_REQUIREMENTS.length);
    expect(F4_REQUIREMENTS.length).toBeGreaterThanOrEqual(6);
  });

  it('names the funding problem — monitoring is free and a repay is not', () => {
    expect(F4_REQUIREMENTS.join(' ')).toMatch(/may not front capital it has not earned/i);
  });

  it('names revocation as an on-chain fact, not a database row', () => {
    expect(F4_REQUIREMENTS.join(' ')).toMatch(/not a row deleted from a table/i);
  });

  it('names receipts for failures, so a save that did not happen is visible', () => {
    expect(F4_REQUIREMENTS.join(' ')).toMatch(/including failures/i);
  });

  it('names Gondi’s deadline rule: a save must land BEFORE it, since there is no grace period', () => {
    const all = F4_REQUIREMENTS.join(' ');
    expect(all).toMatch(/no grace period/i);
    expect(all).toMatch(/before the deadline/i);
    expect(all).not.toMatch(/isDefaulted|effectiveDeadline|GRACE_PERIOD/);
  });
});
