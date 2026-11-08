// The snapshot's four states, and the one collapse that matters.
//
// `ready with zero positions` means "this wallet has no debt at risk". Every
// other state means "we did not find that out". A snapshot shape that let those
// share a rendering would put the calmest possible screen in front of the user
// during an RPC outage, which is the same bug as an unhosted indexer rendering an
// empty result set.
//
// A ready snapshot is built from loans whose hash `getLoanHash` confirmed, so the
// deadline is the loan's own `startTime + duration` and what is owed is Gondi's
// own arithmetic (`owedAt`).

import { describe, it, expect } from 'vitest';
import type { Address } from 'viem';
import { owedAt, type Loan } from '../gondi/loanMath';
import {
  IDLE_DETAIL,
  READ_FAILED_DETAIL,
  buildSnapshot,
  idleSnapshot,
  loadingSnapshot,
  unreadableSnapshot,
  worstPosition,
  type RawLoanRead,
} from './positions';

const NOW = 1_700_000_000;
const LENDING = '0x2222222222222222222222222222222222222222' as const;
const BORROWER = '0x1111111111111111111111111111111111111111' as Address;
const LENDER = '0x3333333333333333333333333333333333333333' as Address;
const COLLECTION = '0x4444444444444444444444444444444444444444' as Address;
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2' as Address;
const ONE = 1_000_000_000_000_000_000n;

/** A one-lender Gondi loan due `dueIn` seconds after NOW, started a day before NOW. */
function gondiLoan(dueIn: number, over: Partial<Loan> = {}): Loan {
  const startTime = BigInt(NOW - 86_400);
  return {
    borrower: BORROWER,
    nftCollateralTokenId: 7n,
    nftCollateralAddress: COLLECTION,
    principalAddress: WETH,
    principalAmount: ONE,
    startTime,
    duration: BigInt(86_400 + dueIn),
    tranche: [{ loanId: 1n, floor: 0n, principalAmount: ONE, lender: LENDER, accruedInterest: 0n, startTime, aprBps: 1000n }],
    protocolFee: 500n,
    lenderRefinanceDisabled: false,
    ...over,
  };
}

function raw(loanId: number, dueIn = 100 * 3600, over: Partial<Loan> = {}): RawLoanRead {
  return { loanId, venue: 'tegridy-nft-lending', lendingContract: LENDING, loan: gondiLoan(dueIn, over) };
}

describe('only `ready` may be read as an answer', () => {
  it.each([
    ['idle', idleSnapshot()],
    ['loading', loadingSnapshot()],
    ['unreadable', unreadableSnapshot()],
  ] as const)('%s carries no positions and a non-empty reason', (_name, snapshot) => {
    expect(snapshot.positions).toEqual([]);
    expect(snapshot.detail).toBeTruthy();
    expect((snapshot.detail ?? '').length).toBeGreaterThan(20);
    expect(worstPosition(snapshot)).toBeNull();
  });

  it('a ready snapshot has no detail — there is nothing to excuse', () => {
    expect(buildSnapshot([], NOW).detail).toBeNull();
  });

  it('the failure sentence says it is a failed read, not an absence of debt', () => {
    expect(READ_FAILED_DETAIL).toMatch(/failed read, not an absence of debt/i);
  });

  it('the idle sentence says nothing is being watched yet', () => {
    expect(IDLE_DETAIL).toMatch(/nothing is watched until then/i);
  });
});

describe('a position is the hash-checked loan, read as Gondi reads it', () => {
  it('takes the deadline from startTime + duration of the loan', () => {
    const r = raw(4, 7200);
    const p = buildSnapshot([r], NOW).positions[0]!;
    expect(p.health.deadlineUnix).toBe(Number(r.loan.startTime + r.loan.duration));
    expect(p.health.deadlineUnix).toBe(NOW + 7200);
    expect(p.health.secondsToDeadline).toBe(7200);
  });

  it('quotes what is owed now with owedAt, the same math My Loans shows', () => {
    const r = raw(4, 7200);
    const p = buildSnapshot([r], NOW).positions[0]!;
    expect(p.owedNowWei).toBe(owedAt(r.loan, BigInt(NOW)).total);
    // A day of 10% APR on 1 WETH is real interest, so the quote is above the principal.
    expect(p.owedNowWei).toBeGreaterThan(ONE);
  });

  it('carries the collateral, the borrower and the loan itself from the struct', () => {
    const r = raw(4);
    const p = buildSnapshot([r], NOW).positions[0]!;
    expect(p.collateralContract).toBe(COLLECTION);
    expect(p.tokenId).toBe(7n);
    expect(p.principal).toBe(ONE);
    expect(p.borrower).toBe(BORROWER);
    expect(p.loan).toBe(r.loan);
    expect(p.lendingContract).toBe(LENDING);
  });

  it('a loan at its deadline second is already past repaying', () => {
    const p = buildSnapshot([raw(4, 0)], NOW).positions[0]!;
    expect(p.health.band).toBe('defaulted');
    expect(p.health.repayable).toBe(false);
  });
});

describe('the worst position surfaces first', () => {
  it('sorts defaulted above urgent above safe', () => {
    const snapshot = buildSnapshot([raw(1, 500 * 3600), raw(2, -100_000), raw(3, 2 * 3600)], NOW);
    expect(snapshot.positions.map((p) => p.loanId)).toEqual([2, 3, 1]);
    expect(worstPosition(snapshot)!.loanId).toBe(2);
  });

  it('breaks ties by loan id so the order does not shuffle between passes', () => {
    const snapshot = buildSnapshot([raw(9), raw(3), raw(6)], NOW);
    expect(snapshot.positions.map((p) => p.loanId)).toEqual([3, 6, 9]);
  });

  it('stamps the snapshot with the second it was judged', () => {
    expect(buildSnapshot([raw(1)], NOW).observedAt).toBe(NOW);
  });
});
