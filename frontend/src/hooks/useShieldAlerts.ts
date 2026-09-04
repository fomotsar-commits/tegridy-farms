import { useMemo } from 'react';
import { useAlerts } from './useAlerts';
import { useAlertsEvaluation } from './useAlertsEvaluation';
import { snapshotLoanReader } from '../lib/shield/alertReader';
import type { ShieldPositionsSnapshot } from '../lib/shield/positions';
import type { Evaluation } from '../lib/alerts/evaluate';
import type { AlertRule } from '../lib/alerts/rules';

// Deadline rules, evaluated against what the shield already read.
//
// This is the "reuse the alerts engine" half of the slice: there is no second
// rules engine here. The rules come from the same store the notifications
// surface writes, the verdicts come from the same four-valued `evaluateAll`, and
// the reader is a pure adapter over the shield's snapshot — so a rule can never
// report calm on data the panel is showing as unreadable.
//
// The engine's coverage sentence is passed straight through and must be rendered
// wherever these verdicts are: rules evaluate in this tab, on a timer, while the
// page is open. Nothing evaluates them otherwise, and an alert engine that only
// runs when you are already looking is worth saying out loud on a surface about
// missing a deadline in your sleep.

export interface UseShieldAlertsState {
  /** The wallet's deadline rules. Empty is a real answer: no rules exist. */
  rules: AlertRule[];
  evaluations: Evaluation[];
  counts: { fired: number; quiet: number; cannotEvaluate: number; off: number };
  lastRunAt: number | null;
  running: boolean;
  /** The honest scope of the loop, from the engine. Rendered verbatim. */
  coverage: string;
  /** Non-null when the rule store itself could not be read. */
  storeProblem: string | null;
  runNow: () => void;
}

export function useShieldAlerts(snapshot: ShieldPositionsSnapshot): UseShieldAlertsState {
  const { rules, status, detail } = useAlerts();

  const deadlineRules = useMemo(() => rules.filter((r) => r.kind === 'loan-deadline'), [rules]);

  const readerDeps = useMemo(
    () => ({ loanDeadlineReader: snapshotLoanReader(snapshot) }),
    [snapshot],
  );

  const evaluation = useAlertsEvaluation(deadlineRules, { readerDeps });

  return {
    rules: deadlineRules,
    evaluations: evaluation.evaluations,
    counts: evaluation.counts,
    lastRunAt: evaluation.lastRunAt,
    running: evaluation.running,
    coverage: evaluation.coverage,
    // `local` is the good state: the rules on screen are the rules in storage.
    // Only `local-unwritable` is a problem worth putting in front of somebody
    // watching a loan deadline, and it is a real one — a rule added here will not
    // survive the reload.
    storeProblem: status === 'local' ? null : detail,
    runNow: evaluation.runNow,
  };
}
