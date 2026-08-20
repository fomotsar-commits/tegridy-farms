// The shape of what the shield read, and the rules for turning raw contract reads
// into it. Pure — the RPC lives in useShieldPositions.ts.
//
// The snapshot is four-valued for the same reason useIndexedQuery's and
// useAlerts' state machines are: a two-state (loading / positions) shape cannot
// say "the reads failed", and that failure renders as an empty list, which on
// this surface means "you have no debt at risk". `positions` is empty in every
// non-`ready` state so a consumer that ignores `status` shows nothing rather than
// something false.

import type { Address } from 'viem';
import { assessDeadlineHealth, healthSeverity, type ShieldHealth } from './health';
import type { ShieldVenueId } from './venues';

export interface ShieldPosition {
  loanId: number;
  venue: ShieldVenueId;
  lendingContract: Address;
  collateralContract: string | null;
  tokenId: bigint;
  principal: bigint;
  borrower: string;
  repaid: boolean;
  defaultClaimed: boolean;
  health: ShieldHealth;
  /** `getRepaymentAmount(loanId)` in wei. Null when that read failed. */
  quotedRepayWei: bigint | null;
  /** Non-null exactly when `quotedRepayWei` is null. Says which read went missing. */
  quoteDetail: string | null;
}

export type ShieldSnapshotStatus = 'idle' | 'loading' | 'ready' | 'unreadable';

export interface ShieldPositionsSnapshot {
  status: ShieldSnapshotStatus;
  /** Empty unless `status === 'ready'`. */
  positions: ShieldPosition[];
  /** Null only when `status === 'ready'`. Rendered verbatim. */
  detail: string | null;
  /** Unix seconds the reads were made. Zero when nothing was read. */
  observedAt: number;
}

export const QUOTE_UNREADABLE_DETAIL =
  'The repayment amount could not be read from the lending contract for this loan.';

export const IDLE_DETAIL =
  'Connect the borrowing wallet on Ethereum Mainnet to read its loans. Nothing is being watched until then.';

export const LOADING_DETAIL = 'Reading this wallet’s loans from the lending contract.';

export const READ_FAILED_DETAIL =
  'This wallet’s loans could not be read from the lending contract, so it is not known whether any deadline is close. This is a failed read, not an absence of debt.';

export interface RawLoanRead {
  loanId: number;
  venue: ShieldVenueId;
  lendingContract: Address;
  collateralContract: string | null;
  tokenId: bigint;
  principal: bigint;
  borrower: string;
  repaid: boolean;
  defaultClaimed: boolean;
  /** `effectiveDeadline(loanId)`, or null when the read failed. */
  effectiveDeadlineUnix: number | null;
  /** `GRACE_PERIOD()`, or null when the read failed. */
  graceSeconds: number | null;
  /** `getRepaymentAmount(loanId)`, or null when the read failed. */
  quotedRepayWei: bigint | null;
}

/**
 * Assemble the ready snapshot. Sorted worst-first, with unreadable positions
 * ahead of every readable one — see healthSeverity for why.
 */
export function buildSnapshot(reads: readonly RawLoanRead[], nowUnix: number): ShieldPositionsSnapshot {
  const positions = reads.map<ShieldPosition>((r) => ({
    loanId: r.loanId,
    venue: r.venue,
    lendingContract: r.lendingContract,
    collateralContract: r.collateralContract,
    tokenId: r.tokenId,
    principal: r.principal,
    borrower: r.borrower,
    repaid: r.repaid,
    defaultClaimed: r.defaultClaimed,
    health: assessDeadlineHealth({
      effectiveDeadlineUnix: r.effectiveDeadlineUnix,
      graceSeconds: r.graceSeconds,
      nowUnix,
      unreadableDetail: `Loan #${r.loanId}’s deadline could not be read from the lending contract, so its health is unknown. This is a failed read, not a loan that is fine.`,
    }),
    quotedRepayWei: r.quotedRepayWei,
    quoteDetail: r.quotedRepayWei == null ? QUOTE_UNREADABLE_DETAIL : null,
  }));

  positions.sort((a, b) => {
    const bySeverity = healthSeverity(b.health) - healthSeverity(a.health);
    if (bySeverity !== 0) return bySeverity;
    return a.loanId - b.loanId;
  });

  return { status: 'ready', positions, detail: null, observedAt: nowUnix };
}

export function idleSnapshot(detail: string = IDLE_DETAIL): ShieldPositionsSnapshot {
  return { status: 'idle', positions: [], detail, observedAt: 0 };
}

export function loadingSnapshot(): ShieldPositionsSnapshot {
  return { status: 'loading', positions: [], detail: LOADING_DETAIL, observedAt: 0 };
}

export function unreadableSnapshot(detail: string = READ_FAILED_DETAIL): ShieldPositionsSnapshot {
  return { status: 'unreadable', positions: [], detail, observedAt: 0 };
}

/** The most urgent position, or null when there is none to be urgent about. */
export function worstPosition(snapshot: ShieldPositionsSnapshot): ShieldPosition | null {
  return snapshot.status === 'ready' ? (snapshot.positions[0] ?? null) : null;
}
