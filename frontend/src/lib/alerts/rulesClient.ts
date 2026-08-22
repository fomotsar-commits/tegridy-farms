// Typed client for the alert-rule store at `/api/aggregator?resource=alerts`.
//
// ZERO NEW SERVERLESS FUNCTIONS: the store is a `?resource=` branch on the
// aggregator catchall behind a lazy import, per api/SERVERLESS_BUDGET.md. The
// Vercel Hobby plan caps the deployment at 12 functions and the repo is at 11.
//
// DEGRADATION CONTRACT — the whole reason this file is not three lines:
//
//   An empty rule list and an unreachable rule store look identical once they
//   reach a component: both render "no rules". Only one of them means the user
//   has no rules. So every non-success path here carries its own status and an
//   explanation, and `rules` is EMPTY IN EVERY NON-READY STATE rather than
//   partially populated — a caller that ignores `status` shows nothing, which is
//   wrong but visibly wrong, instead of showing a confident lie.
//
//   `schema-missing` is called out separately from `not-configured` because the
//   fix differs: one is an env var, the other is a migration an operator has to
//   apply by hand. Collapsing them would send whoever is on call to the wrong
//   place.

import type { AlertRule, AlertRuleKind } from './rules';
import { ALERT_RULE_KINDS } from './rules';
import type { Address } from 'viem';

export const ALERTS_ENDPOINT = '/api/aggregator?resource=alerts';

export type RuleStoreStatus =
  /** Rules were read. `rules` is the answer. */
  | 'ready'
  /** No SIWE session. Rules are per-wallet, so there is nothing to read. */
  | 'signed-out'
  /** The deployment has no Supabase/JWT configuration for the store. */
  | 'not-configured'
  /** Configured, but the `alert_rules` table does not exist yet. */
  | 'schema-missing'
  /** Asked, no usable answer. */
  | 'unreachable';

/** What the SERVER knows about delivery. The client cannot see the private key. */
export interface DeliveryReport {
  /** True only when both VAPID halves are set server-side. */
  pushConfigured: boolean;
  /** Always false until a worker exists — Vercel functions cannot be one. */
  backgroundWorker: boolean;
  /** Rendered verbatim. Never empty. */
  detail: string;
}

export interface RuleStoreResult {
  status: RuleStoreStatus;
  /** Non-empty only when `status === 'ready'`. */
  rules: AlertRule[];
  /** Null only when `status === 'ready'`. */
  detail: string | null;
  /** What an operator must do, when anything. */
  operatorStep: string | null;
  /** Server-side delivery facts, when the server got far enough to report them. */
  delivery: DeliveryReport | null;
}

function fail(
  status: Exclude<RuleStoreStatus, 'ready'>,
  detail: string,
  operatorStep: string | null = null,
  delivery: DeliveryReport | null = null,
): RuleStoreResult {
  return { status, rules: [], detail, operatorStep, delivery };
}

const EVM_ADDRESS_RE = /^0x[a-f0-9]{40}$/;

/** Coerce one server row. Rejects rather than repairs — a half-parsed rule would watch the wrong thing. */
export function coerceRule(raw: unknown): AlertRule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id : null;
  const kind = typeof r.kind === 'string' ? (r.kind as AlertRuleKind) : null;
  const subject = typeof r.subject === 'string' ? r.subject.toLowerCase() : null;
  if (!id || !kind || !subject) return null;
  if (!ALERT_RULE_KINDS.includes(kind)) return null;
  if (!EVM_ADDRESS_RE.test(subject)) return null;
  const threshold =
    typeof r.threshold === 'number' && Number.isFinite(r.threshold)
      ? r.threshold
      : typeof r.threshold === 'string' && r.threshold.trim() !== '' && Number.isFinite(Number(r.threshold))
        ? Number(r.threshold)
        : null;
  const createdAtRaw = r.created_at ?? r.createdAt;
  let createdAt = 0;
  if (typeof createdAtRaw === 'number' && Number.isFinite(createdAtRaw)) createdAt = Math.floor(createdAtRaw);
  else if (typeof createdAtRaw === 'string') {
    const parsed = Date.parse(createdAtRaw);
    if (Number.isFinite(parsed)) createdAt = Math.floor(parsed / 1000);
  }
  return {
    id,
    kind,
    subject: subject as Address,
    threshold,
    enabled: r.enabled !== false,
    createdAt,
  };
}

function coerceDelivery(raw: unknown): DeliveryReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.detail !== 'string' || !d.detail) return null;
  return {
    pushConfigured: d.pushConfigured === true,
    backgroundWorker: d.backgroundWorker === true,
    detail: d.detail,
  };
}

interface RequestOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}

async function call(
  init: RequestInit,
  opts: RequestOptions,
): Promise<RuleStoreResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(opts.endpoint ?? ALERTS_ENDPOINT, {
      credentials: 'include',
      headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: opts.signal,
      ...init,
    });
  } catch {
    return fail(
      'unreachable',
      'The rule store could not be reached, so your rules were not read. Nothing here says you have no rules.',
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    // A body we cannot read is not a body that said "no rules".
    payload = null;
  }
  const body = (payload ?? {}) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code : null;
  const operatorStep = typeof body.operatorStep === 'string' ? body.operatorStep : null;
  const serverDetail = typeof body.error === 'string' ? body.error : null;

  if (res.status === 401) {
    return fail(
      'signed-out',
      'Alert rules are stored against your wallet, so they cannot be read until you sign in.',
    );
  }
  if (code === 'schema-missing') {
    return fail(
      'schema-missing',
      serverDetail ??
        'The alert-rule table does not exist on this deployment, so no rules could be read or saved.',
      operatorStep,
      coerceDelivery(body.delivery),
    );
  }
  if (code === 'not-configured') {
    return fail(
      'not-configured',
      serverDetail ?? 'This deployment has no rule store configured, so rules cannot be saved.',
      operatorStep,
      coerceDelivery(body.delivery),
    );
  }
  if (!res.ok) {
    return fail(
      'unreachable',
      serverDetail ?? `The rule store answered ${res.status}, so your rules were not read.`,
      operatorStep,
    );
  }

  const rawRules = Array.isArray(body.rules) ? body.rules : [];
  const rules: AlertRule[] = [];
  for (const item of rawRules) {
    const rule = coerceRule(item);
    if (rule) rules.push(rule);
  }
  rules.sort((a, b) => b.createdAt - a.createdAt);
  return { status: 'ready', rules, detail: null, operatorStep: null, delivery: coerceDelivery(body.delivery) };
}

export function listRules(opts: RequestOptions = {}): Promise<RuleStoreResult> {
  return call({ method: 'GET' }, opts);
}

export function createRule(
  rule: Pick<AlertRule, 'kind' | 'subject' | 'threshold'>,
  opts: RequestOptions = {},
): Promise<RuleStoreResult> {
  return call(
    {
      method: 'POST',
      body: JSON.stringify({
        action: 'create',
        kind: rule.kind,
        subject: rule.subject,
        threshold: rule.threshold,
      }),
    },
    opts,
  );
}

export function deleteRule(id: string, opts: RequestOptions = {}): Promise<RuleStoreResult> {
  return call({ method: 'POST', body: JSON.stringify({ action: 'delete', id }) }, opts);
}

export function toggleRule(id: string, enabled: boolean, opts: RequestOptions = {}): Promise<RuleStoreResult> {
  return call({ method: 'POST', body: JSON.stringify({ action: 'toggle', id, enabled }) }, opts);
}
