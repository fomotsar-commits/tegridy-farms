// The bridge between what the shield read and what the alert engine judges.
//
// The alert engine is deliberately incapable of fetching (see alerts/evaluate.ts):
// it decides over facts. This module turns the shield's position snapshot into
// those facts, and its entire job is the branch at the top — a snapshot that is
// still loading, or that failed to read, becomes `unavailable`, never an empty
// loan list.
//
// That distinction is the whole feature. An empty list evaluates to `quiet`,
// which is the engine saying "your loans are fine". Saying that on the strength
// of a failed RPC read is the exact bug this repo keeps finding, and here it
// would tell a borrower with hours left that nothing needs their attention.

import type { AlertRule } from '../alerts/rules';
import type { LoanDeadlineFact, RuleFacts, SourceReading } from '../alerts/evaluate';
import type { ShieldPositionsSnapshot } from './positions';

/**
 * Build a reader over an already-read snapshot. Pure: the RPC work happened in
 * the hook that produced the snapshot, so evaluation spends no quota and cannot
 * disagree with what the panel is showing.
 */
export function snapshotLoanReader(snapshot: ShieldPositionsSnapshot) {
  return async function readLoanDeadlineFromSnapshot(
    rule: AlertRule,
  ): Promise<SourceReading<RuleFacts>> {
    if (snapshot.status !== 'ready') {
      return {
        status: 'unavailable',
        detail:
          snapshot.detail ??
          'The shield has not finished reading this wallet’s loans, so no deadline was judged. This is a pending read, not a loan with time to spare.',
      };
    }

    const loans: LoanDeadlineFact[] = [];
    for (const p of snapshot.positions) {
      if (p.lendingContract.toLowerCase() !== rule.subject.toLowerCase()) continue;
      // A position whose deadline could not be read carries no deadline to
      // compare. Dropping it silently would shrink the list the rule judges, so
      // the whole reading is refused instead — one unreadable loan makes the
      // answer for this contract unknown, not smaller.
      if (p.health.status !== 'read') {
        return {
          status: 'unavailable',
          detail: `Loan #${p.loanId} could not be read: ${p.health.detail} No deadline verdict was reached for this lending contract.`,
        };
      }
      loans.push({
        loanId: p.loanId,
        contract: p.lendingContract.toLowerCase(),
        deadlineAt: p.health.deadlineUnix,
        graceEndsAt: p.health.graceEndsUnix,
        band: p.health.band,
        consequence: p.health.consequence,
      });
    }

    return {
      status: 'ok',
      observedAt: snapshot.observedAt,
      value: { kind: 'loan-deadline', loans },
    };
  };
}
