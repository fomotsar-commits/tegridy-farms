// THE COLLAPSE THIS FILE EXISTS TO PREVENT.
//
// `unavailable` and `ok: []` are one character apart in the reader and render
// identically in every naive UI. Through the alert engine they are opposites:
// `unavailable` becomes `cannot-evaluate` ("nobody looked"), and an empty loan
// list becomes `quiet` ("your loans are fine"). On a deadline rule, `quiet` is
// the engine telling a borrower with four hours left that nothing needs their
// attention.
//
// So every non-ready snapshot, and every position whose deadline read failed,
// must come back `unavailable`. The tests below run the real `evaluateRule` on
// the reader's output rather than asserting on the reading alone, because the
// verdict is the thing a user sees.

import { describe, it, expect } from 'vitest';
import { snapshotLoanReader } from './alertReader';
import { evaluateRule, type RuleFacts, type SourceReading } from '../alerts/evaluate';
import type { AlertRule } from '../alerts/rules';
import { assessDeadlineHealth } from './health';
import {
  buildSnapshot,
  idleSnapshot,
  loadingSnapshot,
  unreadableSnapshot,
  type RawLoanRead,
  type ShieldPosition,
  type ShieldPositionsSnapshot,
} from './positions';

const NOW = 1_700_000_000;
const LENDING = '0x2222222222222222222222222222222222222222' as const;
const OTHER_CONTRACT = '0x3333333333333333333333333333333333333333' as const;

const RULE: AlertRule = {
  id: 'r1',
  kind: 'loan-deadline',
  subject: LENDING,
  threshold: 24,
  enabled: true,
  createdAt: NOW - 1000,
};

function rawLoan(over: Partial<RawLoanRead> = {}): RawLoanRead {
  return {
    loanId: 1,
    venue: 'tegridy-nft-lending',
    lendingContract: LENDING,
    collateralContract: '0x4444444444444444444444444444444444444444',
    tokenId: 9n,
    principal: 1_000_000_000_000_000_000n,
    borrower: '0x1111111111111111111111111111111111111111',
    repaid: false,
    defaultClaimed: false,
    effectiveDeadlineUnix: NOW + 100 * 3600,
    minGraceSeconds: 3600,
    defaultedOnChain: false,
    quotedRepayWei: 1_010_000_000_000_000_000n,
    ...over,
  };
}

async function readWith(snapshot: ShieldPositionsSnapshot, rule: AlertRule = RULE) {
  return snapshotLoanReader(snapshot)(rule);
}

function verdictOf(reading: SourceReading<RuleFacts>, rule: AlertRule = RULE) {
  return evaluateRule(rule, reading, null, NOW).evaluation;
}

describe('a snapshot that is not ready is never an empty loan list', () => {
  it.each([
    ['idle', idleSnapshot()],
    ['loading', loadingSnapshot()],
    ['unreadable', unreadableSnapshot()],
  ] as const)('%s → unavailable, carrying the snapshot’s own reason', async (_name, snapshot) => {
    const reading = await readWith(snapshot);
    expect(reading.status).toBe('unavailable');
    expect(reading.status === 'unavailable' && reading.detail).toBe(snapshot.detail);
  });

  it.each([
    ['idle', idleSnapshot()],
    ['loading', loadingSnapshot()],
    ['unreadable', unreadableSnapshot()],
  ] as const)('%s evaluates to cannot-evaluate, NOT quiet', async (_name, snapshot) => {
    const verdict = verdictOf(await readWith(snapshot));
    expect(verdict.verdict).toBe('cannot-evaluate');
    expect(verdict.verdict).not.toBe('quiet');
    expect(verdict.events).toEqual([]);
  });
});

describe('one unreadable loan makes the answer unknown, not smaller', () => {
  it('refuses the whole reading rather than dropping the loan it could not read', async () => {
    const snapshot = buildSnapshot(
      [rawLoan({ loanId: 1 }), rawLoan({ loanId: 2, effectiveDeadlineUnix: null })],
      NOW,
    );
    const reading = await readWith(snapshot);
    expect(reading.status).toBe('unavailable');
    expect(reading.status === 'unavailable' && reading.detail).toMatch(/Loan #2 could not be read/);
  });

  it('that refusal becomes cannot-evaluate, so the good loan does not certify the bad one', async () => {
    const snapshot = buildSnapshot(
      [rawLoan({ loanId: 1 }), rawLoan({ loanId: 2, effectiveDeadlineUnix: null })],
      NOW,
    );
    expect(verdictOf(await readWith(snapshot)).verdict).toBe('cannot-evaluate');
  });

  it('a loan on ANOTHER contract being unreadable does not poison this rule', async () => {
    const snapshot: ShieldPositionsSnapshot = buildSnapshot([rawLoan({ loanId: 1 })], NOW);
    const stranger: ShieldPosition = {
      ...snapshot.positions[0]!,
      loanId: 55,
      lendingContract: OTHER_CONTRACT,
      health: assessDeadlineHealth({
        effectiveDeadlineUnix: null,
        minGraceSeconds: null,
        defaultedOnChain: null,
        nowUnix: NOW,
      }),
    };
    const reading = await readWith({ ...snapshot, positions: [...snapshot.positions, stranger] });
    expect(reading.status).toBe('ok');
  });
});

describe('a ready snapshot answers the rule it was asked', () => {
  it('fires for a loan inside the lead time', async () => {
    const snapshot = buildSnapshot([rawLoan({ effectiveDeadlineUnix: NOW + 4 * 3600 })], NOW);
    const verdict = verdictOf(await readWith(snapshot));
    expect(verdict.verdict).toBe('fired');
    expect(verdict.events).toHaveLength(1);
    expect(verdict.events[0]!.body).toMatch(/collateral NFT/i);
  });

  it('is quiet — a real negative — for a loan comfortably clear of the deadline', async () => {
    const snapshot = buildSnapshot([rawLoan({ effectiveDeadlineUnix: NOW + 100 * 3600 })], NOW);
    const verdict = verdictOf(await readWith(snapshot));
    expect(verdict.verdict).toBe('quiet');
    expect(verdict.detail).toMatch(/none within 24h/i);
  });

  it('is quiet with the right sentence when the wallet simply has no loans there', async () => {
    const verdict = verdictOf(await readWith(buildSnapshot([], NOW)));
    expect(verdict.verdict).toBe('quiet');
    expect(verdict.detail).toMatch(/no open borrow/i);
  });

  it('ignores loans on a different lending contract', async () => {
    const snapshot = buildSnapshot([rawLoan({ effectiveDeadlineUnix: NOW + 3600 })], NOW);
    const otherRule: AlertRule = { ...RULE, subject: OTHER_CONTRACT };
    const verdict = verdictOf(await readWith(snapshot, otherRule), otherRule);
    expect(verdict.verdict).toBe('quiet');
  });

  it('fires for a loan already past its deadline', async () => {
    const snapshot = buildSnapshot([rawLoan({ effectiveDeadlineUnix: NOW - 600 })], NOW);
    expect(verdictOf(await readWith(snapshot)).verdict).toBe('fired');
  });
});

describe('escalation is a new fact, so the wire is not silent', () => {
  it('keys on the band, so a loan that escalates alerts again', async () => {
    // A wide lead time so the first fire lands well before the wire; the point is
    // that the SAME loan, unchanged, produces a second alert as it escalates.
    // Keying on the loan alone would deliver one warning days out and silence
    // afterwards, which is the failure a deadline alert exists to prevent.
    const wide: AlertRule = { ...RULE, threshold: 200 };
    const deadline = NOW + 100 * 3600;

    const early = verdictOf(await readWith(buildSnapshot([rawLoan({ effectiveDeadlineUnix: deadline })], NOW), wide), wide);
    expect(early.verdict).toBe('fired');

    const lateAt = NOW + 90 * 3600; // 10h left — urgent, not safe
    const late = evaluateRule(
      wide,
      await readWith(buildSnapshot([rawLoan({ effectiveDeadlineUnix: deadline })], lateAt), wide),
      null,
      lateAt,
    ).evaluation;
    expect(late.verdict).toBe('fired');
    expect(late.events[0]!.idempotencyKey).not.toBe(early.events[0]!.idempotencyKey);
  });

  it('does not re-fire for the same loan in the same band across passes', async () => {
    const snapshot = buildSnapshot([rawLoan({ effectiveDeadlineUnix: NOW + 4 * 3600 })], NOW);
    const a = verdictOf(await readWith(snapshot)).events[0]!.idempotencyKey;
    const later = buildSnapshot([rawLoan({ effectiveDeadlineUnix: NOW + 4 * 3600 })], NOW + 60);
    const b = evaluateRule(RULE, await readWith(later), null, NOW + 60).evaluation.events[0]!.idempotencyKey;
    expect(a).toBe(b);
  });
});
