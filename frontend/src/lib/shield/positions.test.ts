// The snapshot's four states, and the one collapse that matters.
//
// `ready with zero positions` means "this wallet has no debt at risk". Every
// other state means "we did not find that out". A snapshot shape that let those
// share a rendering would put the calmest possible screen in front of the user
// during an RPC outage, which is the same bug as an unhosted indexer rendering an
// empty result set.

import { describe, it, expect } from 'vitest';
import {
  IDLE_DETAIL,
  QUOTE_UNREADABLE_DETAIL,
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

function raw(over: Partial<RawLoanRead> = {}): RawLoanRead {
  return {
    loanId: 1,
    venue: 'tegridy-nft-lending',
    lendingContract: LENDING,
    collateralContract: '0x4444444444444444444444444444444444444444',
    tokenId: 1n,
    principal: 1_000_000_000_000_000_000n,
    borrower: '0x1111111111111111111111111111111111111111',
    repaid: false,
    defaultClaimed: false,
    effectiveDeadlineUnix: NOW + 100 * 3600,
    graceSeconds: 3600,
    quotedRepayWei: 1_010_000_000_000_000_000n,
    ...over,
  };
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
    expect(IDLE_DETAIL).toMatch(/nothing is being watched/i);
  });
});

describe('a loan whose reads failed keeps its row', () => {
  it('reports unreadable health rather than disappearing from the list', () => {
    const snapshot = buildSnapshot([raw({ effectiveDeadlineUnix: null })], NOW);
    expect(snapshot.positions).toHaveLength(1);
    expect(snapshot.positions[0]!.health.status).toBe('unreadable');
  });

  it('names the loan in the reason, so the user knows which one is unknown', () => {
    const snapshot = buildSnapshot([raw({ loanId: 12, effectiveDeadlineUnix: null })], NOW);
    const health = snapshot.positions[0]!.health;
    expect(health.status === 'unreadable' && health.detail).toMatch(/Loan #12/);
  });

  it('flags a missing repayment quote separately from a missing deadline', () => {
    const snapshot = buildSnapshot([raw({ quotedRepayWei: null })], NOW);
    expect(snapshot.positions[0]!.quotedRepayWei).toBeNull();
    expect(snapshot.positions[0]!.quoteDetail).toBe(QUOTE_UNREADABLE_DETAIL);
    expect(snapshot.positions[0]!.health.status).toBe('read');
  });

  it('leaves quoteDetail null when the quote was read', () => {
    expect(buildSnapshot([raw()], NOW).positions[0]!.quoteDetail).toBeNull();
  });
});

describe('the worst position surfaces first', () => {
  it('sorts defaulted above urgent above safe', () => {
    const snapshot = buildSnapshot(
      [
        raw({ loanId: 1, effectiveDeadlineUnix: NOW + 500 * 3600 }),
        raw({ loanId: 2, effectiveDeadlineUnix: NOW - 100_000 }),
        raw({ loanId: 3, effectiveDeadlineUnix: NOW + 2 * 3600 }),
      ],
      NOW,
    );
    expect(snapshot.positions.map((p) => p.loanId)).toEqual([2, 3, 1]);
  });

  it('puts an unreadable loan above every readable one, including a defaulted one', () => {
    const snapshot = buildSnapshot(
      [raw({ loanId: 1, effectiveDeadlineUnix: NOW - 100_000 }), raw({ loanId: 2, effectiveDeadlineUnix: null })],
      NOW,
    );
    expect(worstPosition(snapshot)!.loanId).toBe(2);
  });

  it('breaks ties by loan id so the order does not shuffle between passes', () => {
    const snapshot = buildSnapshot(
      [raw({ loanId: 9 }), raw({ loanId: 3 }), raw({ loanId: 6 })],
      NOW,
    );
    expect(snapshot.positions.map((p) => p.loanId)).toEqual([3, 6, 9]);
  });
});
