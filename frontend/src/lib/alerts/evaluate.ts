// The honesty core of the alert engine.
//
// This module answers one question per rule — "did the thing happen?" — and it is
// allowed four answers, not two:
//
//   fired            a fact was read and it matches the rule. Carries provenance.
//   quiet            a fact was read and it does NOT match. A real negative.
//   cannot-evaluate  no fact was read, or none that may be judged on. NOT a negative.
//   off              the user turned the rule off. Nothing was asked.
//
// The collapse this file exists to prevent is `cannot-evaluate` → `quiet`. They
// render identically in every naive UI — an empty inbox — and only one of them is
// a statement about the world. A user who watches a token for a whale move and
// sees silence must be able to tell "nothing moved" from "nothing was read",
// because the second one means they are unprotected and do not know it.
//
// Two cases are less obvious and are treated the same way on purpose:
//
//   NO BASELINE. A change rule (heat tier, deployer reputation) compares two
//     readings. On the first reading there is no second one, so there is no
//     change to report AND no way to know whether one happened before we looked.
//     That is `cannot-evaluate`, not `quiet`. The baseline is recorded so the
//     next pass is a real comparison.
//
//   STALE READING. A reading old enough that the source itself would not certify
//     it cannot pass or fail anyone. Same rule as the Heat launch gate: an old
//     ruler certifies nothing.
//
// Nothing here fetches. Facts arrive as `SourceReading`s from readers.ts so the
// whole decision surface is a pure function over data, and a refactor that loses
// one of the four answers fails a test rather than a review.

import { ALERT_SOURCES, RULE_SOURCE } from './sources';
import { RULE_KIND_LABELS, describeRule, type AlertRule, type AlertRuleKind } from './rules';

/** A fact that was read, or the reason there is no fact. Never both, never neither. */
export type SourceReading<T> =
  | {
      status: 'ok';
      value: T;
      /** Unix seconds the SOURCE says the fact is as-of (not when we fetched). */
      observedAt: number;
    }
  | {
      status: 'unavailable';
      /** Plain language, rendered verbatim. Never empty. */
      detail: string;
    };

export interface WhaleTransfer {
  txHash: string;
  logIndex: number;
  valueUsd: number;
  blockNumber: number;
  /** Unix seconds. */
  at: number;
}

export interface LpUnlockFact {
  /** Stable identifier for this lock — the idempotency anchor. */
  ref: string;
  unlockAt: number;
  locker: string;
  txHash: string | null;
}

export interface LaunchFact {
  token: string;
  pool: string | null;
  launchedAt: number;
  name?: string;
}

/**
 * One borrowed loan, as the lending contract reports it.
 *
 * `band` is supplied by the reader rather than derived here, and it is what the
 * idempotency key hangs on. Keying on the loan alone would deliver ONE warning —
 * the first time the loan crossed the threshold, possibly days out — and then
 * silence as it ran down to the wire, which is the failure mode a deadline alert
 * exists to prevent. Keying on the band means each escalation is its own fact.
 */
export interface LoanDeadlineFact {
  loanId: number;
  /** Lending contract the loan lives on, lower-cased. */
  contract: string;
  /** Pause-adjusted deadline, unix seconds, as read from the contract. */
  deadlineAt: number;
  /** Unix seconds after which repayment is refused and the collateral is claimable. */
  graceEndsAt: number;
  /** Coarse urgency label from the shield's health model. Compared, not parsed. */
  band: string;
  /** One sentence naming what is lost if nothing is signed. Rendered verbatim. */
  consequence: string;
}

/** A change-detection fact reduced to something comparable plus something readable. */
export interface ChangeFact {
  /** Compared between readings. Equal signatures mean nothing changed. */
  signature: string;
  /** Shown to the user. May move without the signature moving; never compared. */
  label: string;
  /**
   * Non-null when the reading is too old for the source to stand behind. A stale
   * reading is refused, not judged — see the header.
   */
  staleDetail?: string | null;
}

export type RuleFacts =
  | { kind: 'whale-move'; transfers: WhaleTransfer[] }
  | { kind: 'lp-unlock'; unlocks: LpUnlockFact[] }
  | { kind: 'launch-live'; launches: LaunchFact[] }
  | { kind: 'heat-tier'; change: ChangeFact }
  | { kind: 'deployer-reputation'; change: ChangeFact }
  | { kind: 'loan-deadline'; loans: LoanDeadlineFact[] };

export interface AlertEvent {
  /**
   * Stable across re-evaluations of the same underlying fact, so a polling loop
   * (or a restart) can never deliver the same event twice.
   */
  idempotencyKey: string;
  ruleId: string;
  kind: AlertRuleKind;
  title: string;
  body: string;
  /** Who supplied the fact. An alert without this is not shippable. */
  provenance: string;
  /** Unix seconds the source says the fact is as-of. */
  observedAt: number;
  /** The on-chain anchor, when the source gave one. Null when it did not. */
  anchor: { chain: string; ref: string } | null;
}

export type EvaluationVerdict = 'fired' | 'quiet' | 'cannot-evaluate' | 'off';

export interface Evaluation {
  ruleId: string;
  kind: AlertRuleKind;
  verdict: EvaluationVerdict;
  /** Non-empty only when `verdict === 'fired'`. */
  events: AlertEvent[];
  /** One sentence. Never empty — every verdict says why it is what it is. */
  detail: string;
  /** Unix seconds this decision was made. */
  evaluatedAt: number;
}

/** The last comparable reading per rule, for the change-detection kinds. */
export interface PriorSnapshot {
  signature: string;
  label: string;
  /** Unix seconds. */
  at: number;
}

export type PriorState = Record<string, PriorSnapshot>;

export interface EvaluateResult {
  evaluation: Evaluation;
  /** The snapshot to persist for this rule, or null when the kind keeps none. */
  nextPrior: PriorSnapshot | null;
}

const NO_BASELINE_DETAIL =
  'This is the first reading for this rule, so there is nothing to compare it against. The baseline is recorded — a change can only be reported once a second reading exists.';

function chainForKind(kind: AlertRuleKind): string {
  return kind === 'heat-tier' ? 'multi' : 'ethereum';
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * Decide one rule against one reading.
 *
 * `prior` is only consulted for change-detection kinds; passing it for the others
 * is harmless and is how the caller stays loop-shaped.
 */
export function evaluateRule(
  rule: AlertRule,
  reading: SourceReading<RuleFacts>,
  prior: PriorSnapshot | null,
  nowUnix: number,
): EvaluateResult {
  const provenance = ALERT_SOURCES[RULE_SOURCE[rule.kind]].attribution;
  const base = { ruleId: rule.id, kind: rule.kind, evaluatedAt: nowUnix };

  if (!rule.enabled) {
    return {
      evaluation: {
        ...base,
        verdict: 'off',
        events: [],
        detail: 'This rule is turned off, so nothing was read for it.',
      },
      // Keep whatever baseline already existed: turning a rule back on should not
      // silently re-arm it as if it had never been read.
      nextPrior: prior,
    };
  }

  if (reading.status === 'unavailable') {
    return {
      evaluation: {
        ...base,
        verdict: 'cannot-evaluate',
        events: [],
        detail: reading.detail,
      },
      nextPrior: prior,
    };
  }

  const facts = reading.value;

  // A reading for the wrong kind is a wiring bug, and wiring bugs must not be
  // reported as "nothing happened".
  if (facts.kind !== rule.kind) {
    return {
      evaluation: {
        ...base,
        verdict: 'cannot-evaluate',
        events: [],
        detail: `The reading returned for this rule described ${RULE_KIND_LABELS[facts.kind].toLowerCase()}, not ${RULE_KIND_LABELS[rule.kind].toLowerCase()}, so it was not judged.`,
      },
      nextPrior: prior,
    };
  }

  switch (facts.kind) {
    case 'whale-move': {
      const threshold = rule.threshold ?? 0;
      const hits = facts.transfers.filter((t) => Number.isFinite(t.valueUsd) && t.valueUsd >= threshold);
      const events: AlertEvent[] = hits.map((t) => ({
        idempotencyKey: `whale-move:${rule.id}:${t.txHash}:${t.logIndex}`,
        ruleId: rule.id,
        kind: rule.kind,
        title: `Whale move — ${shortAddr(rule.subject)}`,
        body: `A transfer worth $${Math.round(t.valueUsd).toLocaleString()} settled in block ${t.blockNumber}.`,
        provenance,
        observedAt: t.at,
        anchor: { chain: chainForKind(rule.kind), ref: t.txHash },
      }));
      return {
        evaluation: {
          ...base,
          verdict: events.length ? 'fired' : 'quiet',
          events,
          detail: events.length
            ? `${events.length} transfer${events.length === 1 ? '' : 's'} at or above $${threshold.toLocaleString()}.`
            : `No indexed transfer of ${shortAddr(rule.subject)} reached $${threshold.toLocaleString()} in the window read.`,
        },
        nextPrior: null,
      };
    }

    case 'lp-unlock': {
      const due = facts.unlocks.filter((u) => u.unlockAt <= nowUnix);
      const events: AlertEvent[] = due.map((u) => ({
        idempotencyKey: `lp-unlock:${rule.id}:${u.ref}`,
        ruleId: rule.id,
        kind: rule.kind,
        title: `LP unlock reached — ${shortAddr(rule.subject)}`,
        body: `A lock held by ${shortAddr(u.locker)} reached its unlock time. This reports the lock reaching its time, not what the holder does next.`,
        provenance,
        observedAt: u.unlockAt,
        anchor: u.txHash ? { chain: chainForKind(rule.kind), ref: u.txHash } : null,
      }));
      return {
        evaluation: {
          ...base,
          verdict: events.length ? 'fired' : 'quiet',
          events,
          detail: events.length
            ? `${events.length} lock${events.length === 1 ? '' : 's'} reached its unlock time.`
            : `No lock on ${shortAddr(rule.subject)} known to the indexer has reached its unlock time.`,
        },
        nextPrior: null,
      };
    }

    case 'launch-live': {
      const mine = facts.launches.filter((l) => l.token.toLowerCase() === rule.subject.toLowerCase());
      const events: AlertEvent[] = mine.map((l) => ({
        idempotencyKey: `launch-live:${rule.id}:${(l.pool ?? l.token).toLowerCase()}:${l.launchedAt}`,
        ruleId: rule.id,
        kind: rule.kind,
        title: `Launch live — ${l.name ?? shortAddr(rule.subject)}`,
        body: l.pool
          ? `A pool for this token is live at ${shortAddr(l.pool)}.`
          : 'A pool for this token appeared in the market-wide new-pool feed.',
        provenance,
        observedAt: l.launchedAt,
        anchor: l.pool ? { chain: chainForKind(rule.kind), ref: l.pool } : null,
      }));
      return {
        evaluation: {
          ...base,
          verdict: events.length ? 'fired' : 'quiet',
          events,
          detail: events.length
            ? 'A new pool for this token is in the feed.'
            : `No pool for ${shortAddr(rule.subject)} appeared in the new-pool feed that was read.`,
        },
        nextPrior: null,
      };
    }

    case 'loan-deadline': {
      const leadSeconds = (rule.threshold ?? 0) * 3600;
      const mine = facts.loans.filter((l) => l.contract.toLowerCase() === rule.subject.toLowerCase());
      const due = mine.filter((l) => l.deadlineAt - nowUnix <= leadSeconds);
      const events: AlertEvent[] = due.map((l) => ({
        idempotencyKey: `loan-deadline:${rule.id}:${l.contract.toLowerCase()}:${l.loanId}:${l.deadlineAt}:${l.band}`,
        ruleId: rule.id,
        kind: rule.kind,
        title: `Loan #${l.loanId} — ${shortAddr(rule.subject)}`,
        body: l.consequence,
        provenance,
        observedAt: reading.observedAt,
        anchor: { chain: chainForKind(rule.kind), ref: l.contract },
      }));
      return {
        evaluation: {
          ...base,
          verdict: events.length ? 'fired' : 'quiet',
          events,
          detail: events.length
            ? `${events.length} loan${events.length === 1 ? ' is' : 's are'} within ${rule.threshold ?? 0}h of the deadline.`
            : mine.length
              ? `${mine.length} open loan${mine.length === 1 ? '' : 's'} on ${shortAddr(rule.subject)}, none within ${rule.threshold ?? 0}h of its deadline.`
              : `This wallet has no open borrow on ${shortAddr(rule.subject)}.`,
        },
        nextPrior: null,
      };
    }

    case 'heat-tier':
    case 'deployer-reputation': {
      const change = facts.change;
      if (change.staleDetail) {
        return {
          evaluation: { ...base, verdict: 'cannot-evaluate', events: [], detail: change.staleDetail },
          // A stale reading may not become the baseline either — comparing the next
          // reading against something the source would not certify would manufacture
          // a change out of a measurement nobody stands behind.
          nextPrior: prior,
        };
      }
      const snapshot: PriorSnapshot = { signature: change.signature, label: change.label, at: reading.observedAt };
      if (!prior) {
        return {
          evaluation: { ...base, verdict: 'cannot-evaluate', events: [], detail: NO_BASELINE_DETAIL },
          nextPrior: snapshot,
        };
      }
      if (prior.signature === change.signature) {
        return {
          evaluation: {
            ...base,
            verdict: 'quiet',
            events: [],
            detail: `Unchanged since the previous reading: ${prior.label}.`,
          },
          nextPrior: snapshot,
        };
      }
      const event: AlertEvent = {
        idempotencyKey: `${rule.kind}:${rule.id}:${prior.signature}->${change.signature}`,
        ruleId: rule.id,
        kind: rule.kind,
        title: `${RULE_KIND_LABELS[rule.kind]} — ${shortAddr(rule.subject)}`,
        body: `${prior.label} → ${change.label}.`,
        provenance,
        observedAt: reading.observedAt,
        anchor: null,
      };
      return {
        evaluation: {
          ...base,
          verdict: 'fired',
          events: [event],
          detail: `Changed since the previous reading: ${prior.label} → ${change.label}.`,
        },
        nextPrior: snapshot,
      };
    }
  }
}

export interface EvaluateAllResult {
  evaluations: Evaluation[];
  nextPriors: PriorState;
}

/**
 * Evaluate a rule set. `readings` is keyed by rule id; a rule with no entry is
 * `cannot-evaluate` rather than `quiet` — a rule nobody read is not a rule that
 * found nothing.
 */
export function evaluateAll(
  rules: readonly AlertRule[],
  readings: Record<string, SourceReading<RuleFacts>>,
  priors: PriorState,
  nowUnix: number,
): EvaluateAllResult {
  const evaluations: Evaluation[] = [];
  const nextPriors: PriorState = { ...priors };
  for (const rule of rules) {
    const reading: SourceReading<RuleFacts> = readings[rule.id] ?? {
      status: 'unavailable',
      detail: `Nothing was read for “${describeRule(rule)}” in this pass, so it could not be evaluated.`,
    };
    const { evaluation, nextPrior } = evaluateRule(rule, reading, priors[rule.id] ?? null, nowUnix);
    evaluations.push(evaluation);
    if (nextPrior) nextPriors[rule.id] = nextPrior;
    else delete nextPriors[rule.id];
  }
  return { evaluations, nextPriors };
}

/** Counts for a one-line summary. `cannotEvaluate` is deliberately not folded into `quiet`. */
export function summarizeEvaluations(evaluations: readonly Evaluation[]): {
  fired: number;
  quiet: number;
  cannotEvaluate: number;
  off: number;
} {
  return {
    fired: evaluations.filter((e) => e.verdict === 'fired').length,
    quiet: evaluations.filter((e) => e.verdict === 'quiet').length,
    cannotEvaluate: evaluations.filter((e) => e.verdict === 'cannot-evaluate').length,
    off: evaluations.filter((e) => e.verdict === 'off').length,
  };
}
