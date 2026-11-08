// THE COLLAPSE THIS FILE EXISTS TO PREVENT.
//
// `unavailable` and `ok: []` are one character apart in the reader and render
// identically in every naive UI. Through the alert engine they are opposites:
// `unavailable` becomes `cannot-evaluate` ("nobody looked"), and an empty loan
// list becomes `quiet` ("your loans are fine"). On a deadline rule, `quiet` is
// the engine telling a borrower with four hours left that nothing needs their
// attention.
//
// So every non-ready snapshot must come back `unavailable`. A ready snapshot holds
// only loans whose hash `getLoanHash` confirmed (a record that did not check out
// makes the whole snapshot unreadable upstream, in useShieldPositions), so each
// one carries Gondi's own deadline: `startTime + duration`. The tests below run
// the real `evaluateRule` on the reader's output, because the verdict is the thing
// a user sees.

import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { snapshotLoanReader } from './alertReader';
import { evaluateRule, type RuleFacts, type SourceReading } from '../alerts/evaluate';
import type { AlertRule } from '../alerts/rules';
import type { Loan } from '../gondi/loanMath';
import {
  buildSnapshot,
  idleSnapshot,
  loadingSnapshot,
  unreadableSnapshot,
  type RawLoanRead,
  type ShieldPositionsSnapshot,
} from './positions';

const NOW = 1_700_000_000;
const LENDING = '0x2222222222222222222222222222222222222222' as const;
const OTHER_CONTRACT = '0x3333333333333333333333333333333333333333' as const;
const ONE = 1_000_000_000_000_000_000n;

const RULE: AlertRule = {
  id: 'r1',
  kind: 'loan-deadline',
  subject: LENDING,
  threshold: 24,
  enabled: true,
  createdAt: NOW - 1000,
};

/** A Gondi loan, started a day before NOW, due at `deadline`. */
function gondiLoan(deadline: number): Loan {
  const startTime = BigInt(NOW - 86_400);
  return {
    borrower: '0x1111111111111111111111111111111111111111' as Address,
    nftCollateralTokenId: 9n,
    nftCollateralAddress: '0x4444444444444444444444444444444444444444' as Address,
    principalAddress: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address,
    principalAmount: ONE,
    startTime,
    duration: BigInt(deadline) - startTime,
    tranche: [{
      loanId: 1n, floor: 0n, principalAmount: ONE, lender: '0x5555555555555555555555555555555555555555' as Address,
      accruedInterest: 0n, startTime, aprBps: 1000n,
    }],
    protocolFee: 500n,
    lenderRefinanceDisabled: false,
  };
}

function rawLoan(over: { loanId?: number; deadline?: number; lendingContract?: Address } = {}): RawLoanRead {
  return {
    loanId: over.loanId ?? 1,
    venue: 'tegridy-nft-lending',
    lendingContract: over.lendingContract ?? LENDING,
    loan: gondiLoan(over.deadline ?? NOW + 100 * 3600),
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

describe('a ready snapshot becomes Gondi deadline facts', () => {
  it('each loan’s deadlineAt is startTime + duration, with no grace field', async () => {
    const raw = rawLoan({ loanId: 4, deadline: NOW + 4 * 3600 });
    const reading = await readWith(buildSnapshot([raw], NOW));
    expect(reading.status).toBe('ok');
    if (reading.status !== 'ok' || reading.value.kind !== 'loan-deadline') throw new Error('expected loan facts');
    expect(reading.value.loans).toHaveLength(1);
    const fact = reading.value.loans[0]!;
    expect(fact.deadlineAt).toBe(Number(raw.loan.startTime + raw.loan.duration));
    expect(fact.deadlineAt).toBe(NOW + 4 * 3600);
    expect(fact.loanId).toBe(4);
    expect(fact.contract).toBe(LENDING.toLowerCase());
    expect(fact.band).toBe('urgent');
    expect(fact).not.toHaveProperty('graceEndsAt');
  });

  it('only this rule’s contract is judged', async () => {
    const reading = await readWith(
      buildSnapshot([rawLoan({ loanId: 1 }), rawLoan({ loanId: 2, lendingContract: OTHER_CONTRACT })], NOW),
    );
    if (reading.status !== 'ok' || reading.value.kind !== 'loan-deadline') throw new Error('expected loan facts');
    expect(reading.value.loans.map((l) => l.loanId)).toEqual([1]);
  });

  it('stamps the reading with the snapshot’s own second', async () => {
    const reading = await readWith(buildSnapshot([rawLoan()], NOW));
    expect(reading.status === 'ok' && reading.observedAt).toBe(NOW);
  });
});

describe('a ready snapshot answers the rule it was asked', () => {
  it('fires for a loan inside the lead time', async () => {
    const snapshot = buildSnapshot([rawLoan({ deadline: NOW + 4 * 3600 })], NOW);
    const verdict = verdictOf(await readWith(snapshot));
    expect(verdict.verdict).toBe('fired');
    expect(verdict.events).toHaveLength(1);
    expect(verdict.events[0]!.body).toMatch(/collateral NFT/i);
  });

  it('is quiet — a real negative — for a loan comfortably clear of the deadline', async () => {
    const snapshot = buildSnapshot([rawLoan({ deadline: NOW + 100 * 3600 })], NOW);
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
    const snapshot = buildSnapshot([rawLoan({ deadline: NOW + 3600 })], NOW);
    const otherRule: AlertRule = { ...RULE, subject: OTHER_CONTRACT };
    const verdict = verdictOf(await readWith(snapshot, otherRule), otherRule);
    expect(verdict.verdict).toBe('quiet');
  });

  it('fires for a loan already past its deadline, saying repayment is no longer accepted', async () => {
    const snapshot = buildSnapshot([rawLoan({ deadline: NOW - 600 })], NOW);
    const verdict = verdictOf(await readWith(snapshot));
    expect(verdict.verdict).toBe('fired');
    expect(verdict.events[0]!.body).toMatch(/no longer accepts repayment/i);
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

    const early = verdictOf(await readWith(buildSnapshot([rawLoan({ deadline })], NOW), wide), wide);
    expect(early.verdict).toBe('fired');

    const lateAt = NOW + 90 * 3600; // 10h left — urgent, not safe
    const late = evaluateRule(
      wide,
      await readWith(buildSnapshot([rawLoan({ deadline })], lateAt), wide),
      null,
      lateAt,
    ).evaluation;
    expect(late.verdict).toBe('fired');
    expect(late.events[0]!.idempotencyKey).not.toBe(early.events[0]!.idempotencyKey);
  });

  it('does not re-fire for the same loan in the same band across passes', async () => {
    const snapshot = buildSnapshot([rawLoan({ deadline: NOW + 4 * 3600 })], NOW);
    const a = verdictOf(await readWith(snapshot)).events[0]!.idempotencyKey;
    const later = buildSnapshot([rawLoan({ deadline: NOW + 4 * 3600 })], NOW + 60);
    const b = evaluateRule(RULE, await readWith(later), null, NOW + 60).evaluation.events[0]!.idempotencyKey;
    expect(a).toBe(b);
  });
});
