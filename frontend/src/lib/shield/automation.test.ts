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
import { prepareRepay } from './preparedAction';
import { SHIELD_VENUES, shieldVenueReadiness } from './venues';
import {
  IDLE_DETAIL,
  LOADING_DETAIL,
  QUOTE_UNREADABLE_DETAIL,
  READ_FAILED_DETAIL,
} from './positions';

const BORROWER = '0x1111111111111111111111111111111111111111' as const;
const LENDING = '0x2222222222222222222222222222222222222222' as const;
const NOW = 1_700_000_000;

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
    ...Object.values(SHIELD_COPY),
    ...F4_REQUIREMENTS,
    NO_HEALTH_FACTOR_DETAIL,
    IDLE_DETAIL,
    LOADING_DETAIL,
    QUOTE_UNREADABLE_DETAIL,
    READ_FAILED_DETAIL,
    shieldAutomationState().statusDetail,
  ];

  for (const venue of Object.values(SHIELD_VENUES)) {
    out.push(venue.label, venue.lossOnTrigger, venue.operatorStep);
  }
  for (const readiness of Object.values(shieldVenueReadiness())) {
    if (readiness.detail) out.push(readiness.detail);
  }

  // Health copy is generated, so it is generated here rather than transcribed.
  // Both verdicts are swept at every offset, so the pause-extended-grace copy —
  // past the constant, contract still accepting — is covered like the rest.
  const offsets = [-100_000, -5_000, -60, 0, 3600, 40 * 3600, 100 * 3600];
  for (const offset of offsets) {
    for (const defaultedOnChain of [false, true]) {
      const health = assessDeadlineHealth({
        effectiveDeadlineUnix: NOW + offset,
        minGraceSeconds: 3600,
        defaultedOnChain,
        nowUnix: NOW,
      });
      if (health.status === 'read') {
        out.push(health.headline, health.consequence, health.healthFactorDetail);
      } else {
        out.push(health.detail);
      }
    }
  }
  out.push(
    (assessDeadlineHealth({
      effectiveDeadlineUnix: null,
      minGraceSeconds: null,
      defaultedOnChain: null,
      nowUnix: NOW,
    }) as { detail: string })
      .detail,
  );

  // Prepared-action copy: the disclosure on the happy path and every refusal.
  const base = {
    loanId: 3,
    lendingContract: LENDING,
    chainId: 1,
    expectedChainId: 1,
    account: BORROWER,
    borrower: BORROWER,
    repaid: false,
    defaultClaimed: false,
    quotedRepayWei: 1_000_000_000_000_000_000n,
    health: assessDeadlineHealth({
      effectiveDeadlineUnix: NOW + 3600,
      minGraceSeconds: 3600,
      defaultedOnChain: false,
      nowUnix: NOW,
    }),
  } as const;

  const variants = [
    base,
    { ...base, lendingContract: null },
    { ...base, account: null },
    { ...base, chainId: 8453 },
    { ...base, account: '0x9999999999999999999999999999999999999999' as const },
    { ...base, repaid: true },
    { ...base, defaultClaimed: true },
    { ...base, quotedRepayWei: null },
    {
      ...base,
      health: assessDeadlineHealth({
        effectiveDeadlineUnix: null,
        minGraceSeconds: null,
        defaultedOnChain: null,
        nowUnix: NOW,
      }),
    },
    {
      ...base,
      health: assessDeadlineHealth({
        effectiveDeadlineUnix: NOW - 100_000,
        minGraceSeconds: 3600,
        defaultedOnChain: true,
        nowUnix: NOW,
      }),
    },
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
    expect(EXECUTION_IS_YOURS).toMatch(/you execute this yourself/i);
    expect(EXECUTION_IS_YOURS).toMatch(/nothing signs for you/i);
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
    // `repayLoan` is the only debt-side function and reverts under the full
    // amount. A user hunting for a partial repay or a deleverage is hunting for
    // something that is not there, with a deadline running.
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
});
