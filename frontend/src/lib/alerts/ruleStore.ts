// The rule store, in the browser.
//
// WHY IT IS NOT ON THE SERVER. The server store exists (api/_lib/alerts.js,
// lib/alerts/rulesClient.ts) and is kept for a later wallet-sync step, but it is
// unreachable for every visitor of this venue today: it needs a SIWE session and
// there is no sign-in control in the main nav, and even with one it answers 503
// until `016_alert_rules.sql` is applied by hand. A rule store nobody can write
// to is a rule store that does not exist, so this one is localStorage: no
// session, no table, no operator step, and it ships with every deployment.
//
// WHAT THAT COSTS, AND IS SAID EVERYWHERE THE RULES ARE SHOWN: rules live in ONE
// browser. They are not tied to a wallet, they do not follow the user to another
// device, and clearing site data clears them. That is a smaller promise than the
// server store made, and it is the one this build can keep.
//
// THIS MODULE MAKES NO NETWORK CALL, and navConfig.test.ts asserts that by
// reading this file's source: the /alerts nav entry is unpilled because the store
// is provably server-free, so the day someone adds a fetch here, the assertion
// that justifies the missing pill fails first.

import { safeGetItem, safeSetItem } from '../storage';
import { randomUuidV4 } from '../randomId';
import {
  ALERT_RULE_KINDS,
  SUBJECT_SHAPE,
  canonicalSubject,
  parsePoolSubject,
  usesThreshold,
  type AlertRule,
  type AlertRuleKind,
} from './rules';

/**
 * The `tegridy-` prefix is the storage sweeper's namespace (lib/storage.ts), not
 * copy: it is what makes this key visible to the quota sweeper at all, and it is
 * never rendered. The key belongs in EVICTION_PROTECTED_KEYS — a rule is a user's
 * choice, and a choice evicted to make room for a price cache is a watch that
 * silently stopped.
 */
export const RULES_STORAGE_KEY = 'tegridy-alert-rules-v1';

/**
 * How many rules one browser holds.
 *
 * Not a tier and not a paywall: it is the quota arithmetic. Each enabled pool
 * rule can cost one keyless GeckoTerminal request per pass, the loop runs once a
 * minute, and the public endpoint throttles at roughly 30 requests a minute per
 * IP — shared with the chart, the market strip and the protocol pulse on the same
 * origin. Ten rules over at most five pools keeps a pass inside that budget.
 */
export const MAX_LOCAL_RULES = 10;
export const MAX_POOL_SUBJECTS = 5;

/** `local` = what is on screen is what is stored. Nothing else is a good state. */
export type LocalStoreStatus = 'local' | 'local-unwritable';

export const LOCAL_UNWRITABLE_DETAIL =
  'These rules could not be written to this browser’s storage, so they will not survive a reload. Storage may be full or blocked.';

export const LOCAL_CEILING_DETAIL = `This browser holds up to ${MAX_LOCAL_RULES} rules. Delete one to add another.`;

export const POOL_CEILING_DETAIL = `This browser watches up to ${MAX_POOL_SUBJECTS} pools. Delete a pool rule to watch another.`;

/**
 * Ids are prefixed `local:` so one can never be mistaken for a server row.
 *
 * The server store validates ids against a bare UUID pattern (api/_lib/alerts.js).
 * If a future sync step ever posts these rows, the prefix guarantees a local id
 * is REJECTED rather than silently colliding with — or overwriting — a row the
 * server minted.
 */
export function newLocalRuleId(): string {
  return `local:${randomUuidV4()}`;
}


/**
 * Coerce one stored row into a rule, or drop it.
 *
 * Its OWN function, deliberately not `rulesClient.coerceRule`: that one lower-
 * cases every subject and demands `0x`, which is correct for the EVM-only server
 * table and would corrupt a base58 Solana pool id on the way back out of storage.
 * A rule that reads back pointing at a pool that does not exist is worse than a
 * dropped rule, because it looks armed.
 */
export function coerceLocalRule(raw: unknown): AlertRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  if (typeof r.id !== 'string' || !r.id) return null;
  if (typeof r.kind !== 'string') return null;
  const kind = r.kind as AlertRuleKind;
  if (!ALERT_RULE_KINDS.includes(kind)) return null;

  if (typeof r.subject !== 'string') return null;
  const subject = canonicalSubject(kind, r.subject);
  if (subject === null) return null;

  // A threshold kind with no usable threshold cannot fire correctly at any
  // number we might invent for it, so the row is dropped rather than defaulted.
  let threshold: number | null = null;
  if (usesThreshold(kind)) {
    const value = typeof r.threshold === 'number' ? r.threshold : Number(r.threshold);
    if (!Number.isFinite(value) || value <= 0) return null;
    threshold = value;
  }

  const createdAt = typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) ? r.createdAt : 0;

  return {
    id: r.id,
    kind,
    subject,
    threshold,
    // Absent means on: a rule whose `enabled` flag was lost must not go quiet
    // without saying so, and `off` is a verdict the inbox would never print.
    enabled: r.enabled !== false,
    createdAt,
  };
}

/**
 * Parse the stored blob. Garbage becomes an EMPTY list, and one bad row is
 * dropped without taking its siblings — the alternative, refusing the whole blob
 * because a single row drifted, would silently disarm every other rule.
 */
export function parseRuleStore(raw: string | null): AlertRule[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : (parsed as { rules?: unknown } | null)?.rules;
  if (!Array.isArray(list)) return [];

  const out: AlertRule[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const rule = coerceLocalRule(item);
    if (!rule || seen.has(rule.id)) continue;
    seen.add(rule.id);
    out.push(rule);
    if (out.length >= MAX_LOCAL_RULES) break;
  }
  return out;
}

export function serializeRuleStore(rules: readonly AlertRule[]): string {
  return JSON.stringify({ rules: rules.slice(0, MAX_LOCAL_RULES) });
}

export function loadLocalRules(): AlertRule[] {
  return parseRuleStore(safeGetItem(RULES_STORAGE_KEY));
}

/** False means the write did NOT land. The caller must say so rather than pretend. */
export function saveLocalRules(rules: readonly AlertRule[]): boolean {
  return safeSetItem(RULES_STORAGE_KEY, serializeRuleStore(rules));
}

/** The distinct pools a rule set watches — what MAX_POOL_SUBJECTS bounds. */
export function poolSubjectsOf(rules: readonly AlertRule[]): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (SUBJECT_SHAPE[rule.kind] !== 'pool') continue;
    if (parsePoolSubject(rule.subject)) out.add(rule.subject);
  }
  return out;
}
