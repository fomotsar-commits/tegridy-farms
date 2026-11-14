// The shape of what the shield read, and the rules for turning it into positions. Pure: the
// reads live in useMyLoans (the offer book's records, each checked against `getLoanHash`).
//
// The snapshot is four-valued for the same reason useIndexedQuery's and
// useAlerts' state machines are: a two-state (loading / positions) shape cannot
// say "the reads failed", and that failure renders as an empty list, which on
// this surface means "you have no debt at risk". `positions` is empty in every
// non-`ready` state so a consumer that ignores `status` shows nothing rather than
// something false.

import type { Address } from 'viem';
import { loanEnd, owedAt, type Loan } from '../gondi/loanMath';
import { assessDeadlineHealth, healthSeverity, type ShieldHealth } from './health';
import type { ShieldVenueId } from './venues';

export interface ShieldPosition {
  loanId: number;
  venue: ShieldVenueId;
  lendingContract: Address;
  collateralContract: string;
  tokenId: bigint;
  principal: bigint;
  borrower: string;
  /** The loan as `getLoanHash` confirmed it. Repaying sends it back whole. */
  loan: Loan;
  health: ShieldHealth;
  /** What repaying at `observedAt` costs, in WETH wei (`owedAt`, Gondi's own repayment math). */
  owedNowWei: bigint;
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

export const IDLE_DETAIL =
  'Connect the borrowing wallet on Ethereum to read its loans. Nothing is watched until then.';

export const LOADING_DETAIL = 'Reading this wallet’s loans from the lending contract.';

export const READ_FAILED_DETAIL =
  'This wallet’s loans could not be read from the lending contract, so it is not known whether any deadline is close. This is a failed read, not an absence of debt.';

/** One borrowed loan whose hash the chain confirmed. */
export interface RawLoanRead {
  loanId: number;
  venue: ShieldVenueId;
  lendingContract: Address;
  loan: Loan;
}

/** Assemble the ready snapshot, sorted worst-first. */
export function buildSnapshot(reads: readonly RawLoanRead[], nowUnix: number): ShieldPositionsSnapshot {
  const positions = reads.map<ShieldPosition>((r) => ({
    loanId: r.loanId,
    venue: r.venue,
    lendingContract: r.lendingContract,
    collateralContract: r.loan.nftCollateralAddress,
    tokenId: r.loan.nftCollateralTokenId,
    principal: r.loan.principalAmount,
    borrower: r.loan.borrower,
    loan: r.loan,
    health: assessDeadlineHealth({ deadlineUnix: Number(loanEnd(r.loan)), nowUnix }),
    owedNowWei: owedAt(r.loan, BigInt(nowUnix)).total,
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
