// The alert-rule vocabulary: what a rule can watch, and what a rule may claim.
//
// Every kind here names a fact that some source can be READ for. There is no
// predictive kind and there will not be one — "this token looks like it is about
// to dump" is not a fact anybody read, and a notification is the worst possible
// place to put a guess, because it arrives with the authority of an event.
//
// A rule is a QUESTION, not a promise. Nothing in this module claims a rule is
// being watched; that claim belongs to evaluate.ts (did we get an answer?) and
// channels.ts (would a delivery reach anyone?), both of which can refuse it.

import type { Address } from 'viem';

export type AlertRuleKind =
  /** A transfer of the watched token above a USD threshold. */
  | 'whale-move'
  /** The watched deployer's reputation band changed since the last reading. */
  | 'deployer-reputation'
  /** A liquidity lock on the watched token reached its unlock time. */
  | 'lp-unlock'
  /** A new pool went live for the watched token. */
  | 'launch-live'
  /** The watched wallet's Jungle Bay Island Heat tier changed. */
  | 'heat-tier';

export const ALERT_RULE_KINDS: readonly AlertRuleKind[] = [
  'whale-move',
  'deployer-reputation',
  'lp-unlock',
  'launch-live',
  'heat-tier',
];

export const RULE_KIND_LABELS: Record<AlertRuleKind, string> = {
  'whale-move': 'Whale move',
  'deployer-reputation': 'Deployer reputation change',
  'lp-unlock': 'LP unlock',
  'launch-live': 'Launch go-live',
  'heat-tier': 'Heat tier change',
};

/**
 * One sentence per kind, stating the fact the rule fires on. Rendered next to the
 * kind in the builder so a user picking a rule reads what it can actually tell
 * them before they pick it, not after it fails to fire.
 */
export const RULE_KIND_MEANING: Record<AlertRuleKind, string> = {
  'whale-move':
    'Fires on a confirmed transfer of this token worth more than the threshold. Reads indexed transfers, so it can only see what the indexer has already ingested.',
  'deployer-reputation':
    'Fires when this deployer’s reputation band moves between readings. The band is recomputed from the deployer’s own contract creations and the current market state of each one.',
  'lp-unlock':
    'Fires when a liquidity lock on this token reaches its unlock timestamp. It reports the lock reaching its time — not what the holder then does with it.',
  'launch-live':
    'Fires when a new pool for this token first appears in the market-wide new-pool feed.',
  'heat-tier':
    'Fires when Jungle Bay Island’s held-time tier for this wallet changes. Heat is the island’s measurement, not this venue’s.',
};

/** Kinds that can only speak by comparing two readings. */
export const CHANGE_DETECTION_KINDS: readonly AlertRuleKind[] = ['deployer-reputation', 'heat-tier'];

export function isChangeDetectionKind(kind: AlertRuleKind): boolean {
  return CHANGE_DETECTION_KINDS.includes(kind);
}

/** Kinds whose `threshold` is meaningful. Everything else ignores it. */
export const THRESHOLD_KINDS: readonly AlertRuleKind[] = ['whale-move'];

export function usesThreshold(kind: AlertRuleKind): boolean {
  return THRESHOLD_KINDS.includes(kind);
}

/** What `subject` means for each kind, so the builder can label its own input. */
export const SUBJECT_LABEL: Record<AlertRuleKind, string> = {
  'whale-move': 'Token contract address',
  'deployer-reputation': 'Deployer address',
  'lp-unlock': 'Token contract address',
  'launch-live': 'Token contract address',
  'heat-tier': 'Wallet address',
};

export interface AlertRule {
  id: string;
  kind: AlertRuleKind;
  /** Lower-cased EVM address the rule watches. */
  subject: Address;
  /** USD threshold for `whale-move`; null for every other kind. */
  threshold: number | null;
  enabled: boolean;
  /** Unix seconds. */
  createdAt: number;
}

/**
 * Per-wallet rule ceiling for a user with no PremiumAccess subscription.
 *
 * A cap is not a paywall dressed as a limit: every kind is available to a free
 * user, only the COUNT is bounded. A surface that hid kinds behind the tier while
 * still listing them would be selling a rule the user cannot tell is missing.
 */
export const FREE_RULE_LIMIT = 3;
export const PREMIUM_RULE_LIMIT = 25;

export function ruleLimitFor(hasPremium: boolean): number {
  return hasPremium ? PREMIUM_RULE_LIMIT : FREE_RULE_LIMIT;
}

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

export interface RuleDraft {
  kind: AlertRuleKind;
  subject: string;
  /** Raw text from the form; parsed here so the caller never parses twice. */
  threshold?: string | number | null;
}

export type RuleValidation =
  | { ok: true; rule: Omit<AlertRule, 'id' | 'createdAt'> }
  | { ok: false; error: string };

/**
 * Shape-validate a draft. Rejects rather than repairs: a rule silently coerced
 * into a different rule than the one the user typed is a rule that fires on the
 * wrong thing, which is worse than one that refuses to be created.
 */
export function validateRuleDraft(draft: RuleDraft): RuleValidation {
  if (!ALERT_RULE_KINDS.includes(draft.kind)) {
    return { ok: false, error: 'Unknown rule type.' };
  }
  const subject = String(draft.subject ?? '').trim();
  if (!EVM_ADDRESS_RE.test(subject)) {
    return { ok: false, error: `${SUBJECT_LABEL[draft.kind]} must be a 0x-prefixed 40-character address.` };
  }

  let threshold: number | null = null;
  if (usesThreshold(draft.kind)) {
    const raw = typeof draft.threshold === 'string' ? Number(draft.threshold.trim()) : draft.threshold;
    if (raw == null || !Number.isFinite(raw) || Number(raw) <= 0) {
      return { ok: false, error: 'Enter a USD threshold greater than zero.' };
    }
    threshold = Number(raw);
  }

  return {
    ok: true,
    rule: {
      kind: draft.kind,
      subject: subject.toLowerCase() as Address,
      threshold,
      enabled: true,
    },
  };
}

/** Two rules collide when they ask the same question of the same subject. */
export function ruleKey(kind: AlertRuleKind, subject: string, threshold: number | null): string {
  const t = usesThreshold(kind) && threshold != null ? threshold.toString() : '-';
  return `${kind}:${subject.toLowerCase()}:${t}`;
}

export function isDuplicateRule(existing: readonly AlertRule[], candidate: Omit<AlertRule, 'id' | 'createdAt'>): boolean {
  const key = ruleKey(candidate.kind, candidate.subject, candidate.threshold);
  return existing.some((r) => ruleKey(r.kind, r.subject, r.threshold) === key);
}

/** Short human description of a rule, used in the inbox and the rule list. */
export function describeRule(rule: AlertRule): string {
  const short = `${rule.subject.slice(0, 6)}…${rule.subject.slice(-4)}`;
  if (rule.kind === 'whale-move') {
    return `Transfers of ${short} over $${rule.threshold?.toLocaleString() ?? '—'}`;
  }
  return `${RULE_KIND_LABELS[rule.kind]} — ${short}`;
}
