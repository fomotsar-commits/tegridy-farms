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
//
// SUBJECTS ARE NOT ALL ADDRESSES. Six kinds watch an EVM address; three watch a
// POOL, which is a (network, pool-id) pair and on Solana is base58 — a
// CASE-SENSITIVE encoding. The lower-casing that is right for an EVM address is
// data corruption for a Solana pool id, so canonicalisation is per-kind and lives
// in `canonicalSubject`, which every write path goes through exactly once.

// The network vocabulary comes from the shared GeckoTerminal module rather than
// from a second copy here: two lists of networks is how a subject validates on
// one surface and is then refused by the reader on the next.
import { isGeckoNetwork, type GeckoNetwork } from '../geckoTerminal/pools';

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
  | 'heat-tier'
  /** A loan the connected wallet borrowed is within N hours of its deadline. */
  | 'loan-deadline'
  /** GeckoTerminal's quote for a pool crossed above a USD price. */
  | 'pool-price-above'
  /** GeckoTerminal's quote for a pool crossed below a USD price. */
  | 'pool-price-below'
  /** A swap on a pool worth at least a USD size landed in the recent-trades feed. */
  | 'pool-large-trade';

export const ALERT_RULE_KINDS: readonly AlertRuleKind[] = [
  'whale-move',
  'deployer-reputation',
  'lp-unlock',
  'launch-live',
  'heat-tier',
  'loan-deadline',
  'pool-price-above',
  'pool-price-below',
  'pool-large-trade',
];

export const RULE_KIND_LABELS: Record<AlertRuleKind, string> = {
  'whale-move': 'Whale move',
  'deployer-reputation': 'Deployer reputation change',
  'lp-unlock': 'LP unlock',
  'launch-live': 'Launch go-live',
  'heat-tier': 'Heat tier change',
  'loan-deadline': 'Loan deadline approaching',
  'pool-price-above': 'Pool price rises above',
  'pool-price-below': 'Pool price falls below',
  'pool-large-trade': 'Large swap on a pool',
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
  'loan-deadline':
    'Fires when a loan you borrowed on this lending contract comes within the hours you set of its deadline. It is evaluated on the lending page, where your loans are read — elsewhere it reports “cannot evaluate” rather than calm. The alert is a message: repaying is still a transaction you sign yourself.',
  'pool-price-above':
    'Fires once when GeckoTerminal’s quoted price for this pool crosses above the threshold between two readings, roughly a minute apart while this page is open. It is a quote, not a fill you could get, and GeckoTerminal publishes no as-of time for it.',
  'pool-price-below':
    'Fires once when GeckoTerminal’s quoted price for this pool crosses below the threshold between two readings, roughly a minute apart while this page is open. It is a quote, not a fill you could get, and GeckoTerminal publishes no as-of time for it.',
  'pool-large-trade':
    'Fires on a swap in this pool worth at least the threshold that lands after this rule’s first reading. It reads GeckoTerminal’s recent-trades feed for the pool — a swap on a pool, not a token movement, and only the trades that feed returns.',
};

/** Kinds that can only speak by comparing two readings. */
export const CHANGE_DETECTION_KINDS: readonly AlertRuleKind[] = ['deployer-reputation', 'heat-tier'];

export function isChangeDetectionKind(kind: AlertRuleKind): boolean {
  return CHANGE_DETECTION_KINDS.includes(kind);
}

/** Kinds whose `threshold` is meaningful. Everything else ignores it. */
export const THRESHOLD_KINDS: readonly AlertRuleKind[] = [
  'whale-move',
  'loan-deadline',
  'pool-price-above',
  'pool-price-below',
  'pool-large-trade',
];

export function usesThreshold(kind: AlertRuleKind): boolean {
  return THRESHOLD_KINDS.includes(kind);
}

/**
 * What the threshold IS, per kind. Null for kinds that ignore it.
 *
 * A shared numeric field across kinds that measure different things is how a
 * form ends up labelled "USD threshold" over a box the user is meant to type
 * hours into — and a rule created against the wrong unit fires at the wrong time
 * or never, which on a deadline rule is the whole product failing silently.
 */
export const THRESHOLD_LABEL: Record<AlertRuleKind, string | null> = {
  'whale-move': 'USD threshold',
  'deployer-reputation': null,
  'lp-unlock': null,
  'launch-live': null,
  'heat-tier': null,
  'loan-deadline': 'Hours of warning before the deadline',
  'pool-price-above': 'USD price',
  'pool-price-below': 'USD price',
  'pool-large-trade': 'USD swap size',
};

/** What `subject` means for each kind, so the builder can label its own input. */
export const SUBJECT_LABEL: Record<AlertRuleKind, string> = {
  'whale-move': 'Token contract address',
  'deployer-reputation': 'Deployer address',
  'lp-unlock': 'Token contract address',
  'launch-live': 'Token contract address',
  'heat-tier': 'Wallet address',
  'loan-deadline': 'Lending contract address',
  'pool-price-above': 'Pool, as network:address',
  'pool-price-below': 'Pool, as network:address',
  'pool-large-trade': 'Pool, as network:address',
};

/**
 * The SHAPE of a subject, which decides how it is canonicalised.
 *
 * This exists because "lower-case it" is not a universal rule. It is right for a
 * hex EVM address (case is checksum, not identity) and WRONG for a base58 Solana
 * pool id, where case is part of the value — `8z52phbct…` and `8Z52PHBCT…` are
 * different strings and only one of them is a pool.
 */
export type SubjectShape = 'evm-address' | 'pool';

export const SUBJECT_SHAPE: Record<AlertRuleKind, SubjectShape> = {
  'whale-move': 'evm-address',
  'deployer-reputation': 'evm-address',
  'lp-unlock': 'evm-address',
  'launch-live': 'evm-address',
  'heat-tier': 'evm-address',
  'loan-deadline': 'evm-address',
  'pool-price-above': 'pool',
  'pool-price-below': 'pool',
  'pool-large-trade': 'pool',
};

const EVM_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
/** Same alphabet the Heat proxy validates against (heatClient.ts) — no 0, O, I, l. */
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface PoolSubject {
  network: GeckoNetwork;
  /** Lower-cased on eth/base; byte-preserved on solana. */
  pool: string;
}

/**
 * Parse `network:pool` into its parts, or null.
 *
 * A bare address is REFUSED rather than defaulted to a network. GeckoTerminal
 * pool ids are not globally unique across chains, so guessing the network here
 * would silently point a rule at a different pool with the same id — which fires
 * on somebody else's market and looks exactly like a working alert.
 */
export function parsePoolSubject(raw: string): PoolSubject | null {
  const value = String(raw ?? '').trim();
  const cut = value.indexOf(':');
  if (cut <= 0) return null;
  const network = value.slice(0, cut).trim().toLowerCase();
  const pool = value.slice(cut + 1).trim();
  if (!isGeckoNetwork(network)) return null;
  if (network === 'solana') {
    return SOLANA_ADDRESS_RE.test(pool) ? { network, pool } : null;
  }
  return EVM_ADDRESS_RE.test(pool) ? { network, pool: pool.toLowerCase() } : null;
}

/**
 * The one canonical form of a subject, per kind. Null when the input is not a
 * subject of that shape at all.
 *
 * EVERY write path goes through this exactly once — validation, the rule key, the
 * duplicate check and the local store's row coercion — so a subject cannot be
 * canonicalised twice with two different rules, which is how a Solana id ends up
 * lower-cased by the step nobody remembered.
 */
export function canonicalSubject(kind: AlertRuleKind, raw: string): string | null {
  const value = String(raw ?? '').trim();
  if (SUBJECT_SHAPE[kind] === 'pool') {
    const parsed = parsePoolSubject(value);
    return parsed ? `${parsed.network}:${parsed.pool}` : null;
  }
  return EVM_ADDRESS_RE.test(value) ? value.toLowerCase() : null;
}

export interface AlertRule {
  id: string;
  kind: AlertRuleKind;
  /**
   * The canonical subject for this kind: a lower-cased EVM address, or
   * `network:pool` for the pool kinds. Always the output of `canonicalSubject`.
   */
  subject: string;
  /** USD / hours threshold for the kinds that use one; null for the rest. */
  threshold: number | null;
  enabled: boolean;
  /** Unix seconds. */
  createdAt: number;
}

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
  const subject = canonicalSubject(draft.kind, String(draft.subject ?? ''));
  if (subject === null) {
    return {
      ok: false,
      error:
        SUBJECT_SHAPE[draft.kind] === 'pool'
          ? `${SUBJECT_LABEL[draft.kind]} — for example eth:0x… , base:0x… or solana:<pool id>. A bare address is not enough: the same id can exist on more than one network.`
          : `${SUBJECT_LABEL[draft.kind]} must be a 0x-prefixed 40-character address.`,
    };
  }

  let threshold: number | null = null;
  if (usesThreshold(draft.kind)) {
    const raw = typeof draft.threshold === 'string' ? Number(draft.threshold.trim()) : draft.threshold;
    if (raw == null || !Number.isFinite(raw) || Number(raw) <= 0) {
      return {
        ok: false,
        error: `Enter a value greater than zero for “${THRESHOLD_LABEL[draft.kind]}”.`,
      };
    }
    threshold = Number(raw);
  }

  return {
    ok: true,
    rule: {
      kind: draft.kind,
      subject,
      threshold,
      enabled: true,
    },
  };
}

/**
 * Two rules collide when they ask the same question of the same subject.
 *
 * Canonicalises through `canonicalSubject` rather than lower-casing, so two
 * Solana pools that differ only by case stay two different questions. A blanket
 * `.toLowerCase()` here would merge them and silently drop the second rule.
 */
export function ruleKey(kind: AlertRuleKind, subject: string, threshold: number | null): string {
  const t = usesThreshold(kind) && threshold != null ? threshold.toString() : '-';
  return `${kind}:${canonicalSubject(kind, subject) ?? subject}:${t}`;
}

export function isDuplicateRule(existing: readonly AlertRule[], candidate: Omit<AlertRule, 'id' | 'createdAt'>): boolean {
  const key = ruleKey(candidate.kind, candidate.subject, candidate.threshold);
  return existing.some((r) => ruleKey(r.kind, r.subject, r.threshold) === key);
}

function short(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/**
 * How a subject reads in a sentence. Registry-free on purpose: this module knows
 * nothing about which pools belong to island residents, and a name it cannot
 * verify is a name it should not print. The surfaces that DO have that registry
 * add the friendly name themselves.
 */
export function describeSubject(rule: AlertRule): string {
  if (SUBJECT_SHAPE[rule.kind] === 'pool') {
    const parsed = parsePoolSubject(rule.subject);
    if (parsed) return `${parsed.network} pool ${short(parsed.pool)}`;
  }
  return short(rule.subject);
}

/** Short human description of a rule, used in the inbox and the rule list. */
export function describeRule(rule: AlertRule): string {
  const subject = describeSubject(rule);
  const amount = rule.threshold?.toLocaleString() ?? '—';
  switch (rule.kind) {
    case 'whale-move':
      return `Transfers of ${subject} over $${amount}`;
    case 'loan-deadline':
      return `Your loans on ${subject} within ${amount}h of their deadline`;
    case 'pool-price-above':
      return `Quoted price of ${subject} above $${amount}`;
    case 'pool-price-below':
      return `Quoted price of ${subject} below $${amount}`;
    case 'pool-large-trade':
      return `Swaps in ${subject} of at least $${amount}`;
    default:
      return `${RULE_KIND_LABELS[rule.kind]} — ${subject}`;
  }
}
