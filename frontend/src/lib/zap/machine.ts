// What actually happened to each leg of a zap, and what may be done about it.
//
// THE PROBLEM THIS FILE EXISTS FOR. A zap is several transactions on a wallet that offers
// no atomicity across them. It can therefore stop halfway and leave the user holding
// something they did not ask for — LP tokens that were never staked, TOWELI that was never
// locked. Two failure modes follow, and both of them are lies rather than crashes:
//
//   1. Reporting success because the last leg the tab watched went through.
//   2. Resuming by re-sending a leg that may already have landed, because the tab stopped
//      watching before the receipt arrived.
//
// The second is the expensive one. "I did not see it confirm" and "it did not confirm" are
// different facts, and a status vocabulary that collapses them into `failed` will
// double-swap somebody's money the first time a laptop lid closes. So `unknown` is a
// first-class status here, it is NOT resumable, and the only way out of it is an observed
// receipt.
//
// Every function below is pure. The interrupted paths are the ones worth testing and they
// are unreachable through a wallet, so nothing in this module touches one.

import type { ZapPlan, ZapStepId, ZapStepPlan } from './planner';
import { ZAP_INITIAL_HOLDING } from './planner';

export type ZapStepStatus =
  /** Never handed to the wallet. Nothing was signed, nothing can have landed. */
  | 'pending'
  /** Handed to the wallet; no hash yet. The user may still be looking at the prompt. */
  | 'signing'
  /** A hash exists. The chain has it; we have not read the receipt. */
  | 'submitted'
  /** Receipt read, status success. Final — nothing may move a leg out of this. */
  | 'confirmed'
  /** Receipt read, status failure. Definitively no effect; safe to send again. */
  | 'reverted'
  /** The wallet refused or the user rejected. Never reached a node; safe to send again. */
  | 'rejected'
  /**
   * Sent, outcome NOT observed. May or may not have landed. This is the only status that
   * blocks a resume, and it is the whole reason the resume is safe.
   */
  | 'unknown'
  /** There was nothing to do — an allowance already covered the leg. */
  | 'skipped';

/** Statuses from which nothing further is owed. */
const SETTLED: ReadonlySet<ZapStepStatus> = new Set<ZapStepStatus>(['confirmed', 'skipped']);
/** Statuses that prove the leg had no effect, so re-sending it cannot double-spend. */
const PROVEN_INERT: ReadonlySet<ZapStepStatus> = new Set<ZapStepStatus>(['pending', 'reverted', 'rejected']);

export interface ZapStepState {
  id: ZapStepId;
  status: ZapStepStatus;
  /** Set as soon as one exists — it is what makes an `unknown` leg resolvable. */
  txHash?: string;
  /** EIP-5792 batch this leg travelled in, when it travelled in one. */
  batchId?: string;
  /** Why the leg is where it is. Copied from the wallet/chain, never composed here. */
  detail?: string;
  updatedAt: number;
}

export interface ZapRunState {
  planId: string;
  steps: ZapStepState[];
  startedAt: number;
  updatedAt: number;
  /**
   * ERC20 balances read before the first leg was sent, as decimal strings.
   *
   * Measured amounts are deltas against these, so a user who already held TOWELI does not
   * have it swept into the position. Persisted with the run: a resume in a fresh tab that
   * re-read the baseline would measure the swap's output as if it had always been there.
   */
  baseline: Record<string, string>;
}

export type ZapEvent =
  | { type: 'signing'; steps: number[]; at: number }
  | { type: 'submitted'; steps: number[]; txHash?: string; batchId?: string; at: number }
  | { type: 'confirmed'; steps: number[]; txHash?: string; at: number }
  | { type: 'reverted'; steps: number[]; txHash?: string; detail: string; at: number }
  | { type: 'rejected'; steps: number[]; detail: string; at: number }
  /** Sent and then lost sight of: a closed tab, a dropped RPC, a wallet that went quiet. */
  | { type: 'lost'; steps: number[]; detail: string; at: number }
  | { type: 'skipped'; steps: number[]; detail: string; at: number }
  /** A receipt was finally read for a leg that was in flight or unknown. */
  | { type: 'observed'; step: number; outcome: 'confirmed' | 'reverted'; txHash?: string; at: number };

export function initialRunState(plan: ZapPlan, baseline: Record<string, bigint>, at: number): ZapRunState {
  return {
    planId: plan.id,
    steps: plan.steps.map((s) => ({ id: s.id, status: 'pending' as ZapStepStatus, updatedAt: at })),
    startedAt: at,
    updatedAt: at,
    baseline: Object.fromEntries(Object.entries(baseline).map(([k, v]) => [k, v.toString()])),
  };
}

/**
 * Fold one event into the run.
 *
 * Two guards carry the safety of the whole module, and both are refusals rather than
 * throws — an event that cannot be honoured leaves the run exactly as it was, because a
 * reducer that half-applies is worse than one that ignores:
 *
 *   - A settled leg never changes. `confirmed` is a claim about the chain, and the chain
 *     does not take things back; letting a late error event overwrite it would erase a
 *     deposit the user really made.
 *   - `lost` only reaches a leg that was actually in flight. Marking a pending leg unknown
 *     would block a resume that has nothing to fear.
 */
export function applyZapEvent(state: ZapRunState, event: ZapEvent): ZapRunState {
  const targets = event.type === 'observed' ? [event.step] : event.steps;
  const indexes = targets.filter((i) => Number.isInteger(i) && i >= 0 && i < state.steps.length);
  if (indexes.length === 0) return state;

  let changed = false;
  const steps = state.steps.map((step, i) => {
    if (!indexes.includes(i)) return step;
    const next = transition(step, event);
    if (next === step) return step;
    changed = true;
    return next;
  });
  if (!changed) return state;
  return { ...state, steps, updatedAt: event.at };
}

function transition(step: ZapStepState, event: ZapEvent): ZapStepState {
  if (SETTLED.has(step.status)) return step;

  switch (event.type) {
    case 'signing':
      if (step.status !== 'pending') return step;
      return { ...step, status: 'signing', updatedAt: event.at };
    case 'submitted':
      if (step.status !== 'pending' && step.status !== 'signing') return step;
      return {
        ...step,
        status: 'submitted',
        txHash: event.txHash ?? step.txHash,
        batchId: event.batchId ?? step.batchId,
        updatedAt: event.at,
      };
    case 'confirmed':
      return { ...step, status: 'confirmed', txHash: event.txHash ?? step.txHash, detail: undefined, updatedAt: event.at };
    case 'reverted':
      return { ...step, status: 'reverted', txHash: event.txHash ?? step.txHash, detail: event.detail, updatedAt: event.at };
    case 'rejected':
      // A rejection is only meaningful before a hash exists. Once one does, the wallet's
      // "rejected" is about a follow-up prompt, not about the transaction already on-chain.
      if (step.txHash) return step;
      return { ...step, status: 'rejected', detail: event.detail, updatedAt: event.at };
    case 'lost':
      if (step.status !== 'signing' && step.status !== 'submitted') return step;
      return { ...step, status: 'unknown', detail: event.detail, updatedAt: event.at };
    case 'skipped':
      if (step.status !== 'pending') return step;
      return { ...step, status: 'skipped', detail: event.detail, updatedAt: event.at };
    case 'observed':
      if (step.status !== 'unknown' && step.status !== 'submitted' && step.status !== 'signing') return step;
      return {
        ...step,
        status: event.outcome,
        txHash: event.txHash ?? step.txHash,
        detail: event.outcome === 'confirmed' ? undefined : step.detail,
        updatedAt: event.at,
      };
  }
}

// ─── Reading the run ────────────────────────────────────────────────────────

export type ZapProgress =
  | { kind: 'not-started' }
  | { kind: 'in-flight'; step: number }
  | { kind: 'complete' }
  /** A leg stopped for a reason we can prove had no effect. Resumable. */
  | { kind: 'stopped'; step: number; reason: 'reverted' | 'rejected' | 'not-sent' }
  /** A leg's outcome is unread. NOT resumable until it is read. */
  | { kind: 'needs-verification'; step: number }
  /** The record disagrees with itself. Never resumed, always reported. */
  | { kind: 'inconsistent'; step: number; detail: string };

/**
 * Where the run stands.
 *
 * `complete` is the only value the UI is allowed to call success, and it is defined
 * negatively on purpose: every leg settled. Anything else — including a run whose last
 * watched leg confirmed while an earlier one is unread — is not success.
 */
export function zapProgress(state: ZapRunState): ZapProgress {
  const first = state.steps.findIndex((s) => !SETTLED.has(s.status));
  if (first === -1) return { kind: 'complete' };

  // Ordered execution means nothing after the first unsettled leg may have been SENT.
  // A record that says otherwise was written by two tabs, or restored across a plan
  // change, and guessing which half is true is exactly the guess this module refuses.
  //
  // `skipped` is exempt, and not as a convenience: a stage's approvals are evaluated
  // before its action is signed, so an approval an allowance already covered legitimately
  // settles while the leg in front of it is still pending. Treating that as corruption
  // would flash "this record cannot be trusted" during an ordinary run.
  const strayed = state.steps.findIndex(
    (s, i) => i > first && s.status !== 'pending' && s.status !== 'skipped',
  );
  if (strayed !== -1) {
    return {
      kind: 'inconsistent',
      step: strayed,
      detail: `Step ${strayed + 1} has moved while step ${first + 1} has not settled. This run cannot be resumed safely.`,
    };
  }

  const status = state.steps[first]!.status;
  if (status === 'unknown') return { kind: 'needs-verification', step: first };
  if (status === 'signing' || status === 'submitted') return { kind: 'in-flight', step: first };
  if (status === 'reverted' || status === 'rejected') return { kind: 'stopped', step: first, reason: status };
  // Pending, with settled legs behind it: the run was interrupted between stages without
  // anything failing — a closed tab, a reload. Distinct from a revert, and reported as
  // such: telling someone their step failed when it was never sent is its own small lie.
  return first === 0 ? { kind: 'not-started' } : { kind: 'stopped', step: first, reason: 'not-sent' };
}

export type ZapResume =
  | { kind: 'nothing-to-resume' }
  /** Start again at `fromStep`. Every leg before it is settled, so none is redone. */
  | { kind: 'resume'; fromStep: number }
  /** A leg must be observed first. `step` is the one to look up. */
  | { kind: 'blocked'; step: number; reason: string; txHash?: string };

/**
 * The only sanctioned way to continue an interrupted zap.
 *
 * It never returns an index whose leg is settled, and it never returns at all while a leg
 * is unresolved — those two properties together are "does not redo a completed leg" and
 * "does not silently retry a leg that may already have landed".
 */
export function zapResume(state: ZapRunState): ZapResume {
  const progress = zapProgress(state);
  switch (progress.kind) {
    case 'complete':
      return { kind: 'nothing-to-resume' };
    case 'needs-verification':
      return {
        kind: 'blocked',
        step: progress.step,
        reason:
          'This step was sent but its outcome was never read, so it may already have gone through. ' +
          'Check the transaction before continuing — sending it again could repeat it.',
        txHash: state.steps[progress.step]?.txHash,
      };
    case 'in-flight':
      return {
        kind: 'blocked',
        step: progress.step,
        reason: 'This step is still with the wallet or waiting for its receipt.',
        txHash: state.steps[progress.step]?.txHash,
      };
    case 'inconsistent':
      return { kind: 'blocked', step: progress.step, reason: progress.detail };
    case 'not-started':
      return { kind: 'resume', fromStep: 0 };
    case 'stopped': {
      const step = state.steps[progress.step]!;
      if (!PROVEN_INERT.has(step.status)) {
        return {
          kind: 'blocked',
          step: progress.step,
          reason: 'This step cannot be proven to have had no effect, so it will not be sent again automatically.',
          txHash: step.txHash,
        };
      }
      return { kind: 'resume', fromStep: progress.step };
    }
  }
}

/** Legs that have definitively landed. What a receipt may claim, and nothing more. */
export function confirmedSteps(state: ZapRunState): number[] {
  return state.steps.map((s, i) => (s.status === 'confirmed' ? i : -1)).filter((i) => i !== -1);
}

/**
 * What the user is holding right now, as far as the chain has been read.
 *
 * Taken from the last CONFIRMED leg that moves value — approvals are skipped because an
 * allowance is not a holding, and a leg whose receipt was never read cannot contribute,
 * because its holding is exactly the thing in question.
 */
export function strandedHolding(state: ZapRunState, plan: ZapPlan): string {
  let holding = ZAP_INITIAL_HOLDING;
  for (let i = 0; i < state.steps.length && i < plan.steps.length; i++) {
    const status = state.steps[i]!.status;
    // A skipped leg is settled and moved nothing, so the walk continues through it —
    // stopping there would report an earlier holding than the user actually has.
    if (status === 'skipped') continue;
    if (status !== 'confirmed') break;
    const after = plan.steps[i]!.holdingAfter;
    if (after) holding = after;
  }
  return holding;
}

export interface ZapReadout {
  /** Never `success` unless every leg settled. */
  tone: 'neutral' | 'progress' | 'warning' | 'danger' | 'success';
  headline: string;
  detail: string;
  /** Rendered as-is; the sentence a partially-zapped user most needs. */
  holding: string;
  /** True only for `complete`. Gates any "done" affordance. */
  isComplete: boolean;
  /** True while a resume would be unsafe. Gates the resume button. */
  isBlocked: boolean;
}

/**
 * The sentences the UI renders. Centralised so no surface can compose its own "success".
 *
 * The stopped case deliberately leads with what the user HAS rather than with what failed:
 * a person whose LP never got staked needs to know they are holding LP before they need to
 * know which call reverted.
 */
export function zapReadout(state: ZapRunState, plan: ZapPlan): ZapReadout {
  const progress = zapProgress(state);
  const holding = strandedHolding(state, plan);
  const done = confirmedSteps(state).length;
  const total = state.steps.length;
  const nameOf = (i: number): string => plan.steps[i]?.label ?? `step ${i + 1}`;

  switch (progress.kind) {
    case 'not-started':
      return {
        tone: 'neutral',
        headline: 'Not started',
        detail: `${total} steps, ${plan.stageCount} confirmation${plan.stageCount === 1 ? '' : 's'} on a wallet that batches.`,
        holding,
        isComplete: false,
        isBlocked: false,
      };
    case 'in-flight':
      return {
        tone: 'progress',
        headline: `Step ${progress.step + 1} of ${total} in progress`,
        detail: `${nameOf(progress.step)} — waiting on the wallet or the receipt. Nothing after it has been sent.`,
        holding,
        isComplete: false,
        isBlocked: true,
      };
    case 'complete':
      return {
        tone: 'success',
        headline: 'Zap complete',
        detail: `All ${total} steps confirmed on-chain.`,
        holding,
        isComplete: true,
        isBlocked: false,
      };
    case 'stopped': {
      const why =
        progress.reason === 'rejected'
          ? 'was not signed'
          : progress.reason === 'not-sent'
            ? 'was never sent'
            : 'reverted on-chain';
      return {
        tone: 'warning',
        headline: `Zap stopped part-way — ${done} of ${total} steps confirmed`,
        detail:
          `${nameOf(progress.step)} ${why}, so it had no effect. Resuming picks up from there and ` +
          'does not repeat anything already confirmed.',
        holding,
        isComplete: false,
        isBlocked: false,
      };
    }
    case 'needs-verification':
      return {
        tone: 'danger',
        headline: `Zap outcome unconfirmed at step ${progress.step + 1} of ${total}`,
        detail:
          `${nameOf(progress.step)} was sent, but its result was never read. It may have gone through. ` +
          'Check it on the explorer before continuing — this zap will not send it again on its own.',
        holding,
        isComplete: false,
        isBlocked: true,
      };
    case 'inconsistent':
      return {
        tone: 'danger',
        headline: 'This zap record cannot be trusted',
        detail: `${progress.detail} Check your balances and finish the remaining steps by hand.`,
        holding,
        isComplete: false,
        isBlocked: true,
      };
  }
}

/** The legs of `stage` that still need sending, in order. Settled legs are never returned. */
export function pendingStepsOfStage(state: ZapRunState, plan: ZapPlan, stage: number): number[] {
  const out: number[] = [];
  plan.steps.forEach((step: ZapStepPlan, i: number) => {
    if (step.stage !== stage) return;
    if (SETTLED.has(state.steps[i]?.status ?? 'pending')) return;
    out.push(i);
  });
  return out;
}

/** Baseline balance for a measured amount, or 0n when the run recorded none. */
export function baselineOf(state: ZapRunState, key: string): bigint {
  const raw = state.baseline[key];
  if (typeof raw !== 'string') return 0n;
  try {
    return BigInt(raw);
  } catch {
    return 0n;
  }
}
