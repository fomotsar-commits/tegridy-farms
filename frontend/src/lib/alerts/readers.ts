// The network boundary of the alert engine: one reader per rule kind.
//
// Every reader returns a `SourceReading` and NEVER an empty-but-successful shape
// it did not earn. A timeout, a 502, an off-schema body and an unconfigured
// source all become `{ status: 'unavailable', detail }`, which evaluate.ts turns
// into `cannot-evaluate`. The one thing no reader may do is return
// `{ status: 'ok', value: <empty list> }` when it did not actually read an empty
// list — that is the single mistake that makes an outage look like a calm market.
//
// Two kinds are DARK on this deployment and say so rather than pretending:
// whale-move and lp-unlock both need indexed history, and the indexer (F1) is not
// deployed. Their readers do not fabricate a fallback: there is no substitute for
// indexed transfers, and reading "recent transfers" from a price API would be a
// different fact wearing this one's name.
//
// Readers take an injectable `fetchImpl`/dependency set so the honesty contract is
// testable without a network, mirroring outcomesClient.ts and radarClient.ts.

import type { Address } from 'viem';
import { fetchHeat, HeatUnavailableError } from '../heat/heatClient';
import { GATE_MAX_AGE_DAYS, isStale } from '../heat/heatOracle';
import { fetchLaunchRadar } from '../launcher/radarClient';
import { fetchLauncherOutcomes } from '../launcher/outcomesClient';
import type { OutcomeRecord } from '../launcher/outcomes';
import { parseCreatedContracts, toBaselines } from '../detection/deployerLaunches';
import { classifyLaunch, summarizeDeployer, type LaunchInput } from '../detection/deployerReputation';
import { explorerEnvelopeFailure, marketFor, txListUrl } from '../../hooks/useDeployerReputation';
import { sourceReadiness, RULE_SOURCE } from './sources';
import type { AlertRule } from './rules';
import type { RuleFacts, SourceReading } from './evaluate';

/** Same ceiling the deployer page uses, so the two surfaces read the same slice. */
const MAX_CREATIONS = 50;

function unavailable(detail: string): SourceReading<RuleFacts> {
  return { status: 'unavailable', detail };
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

export interface ReaderDeps {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  /**
   * Supplies borrowed-loan facts for `loan-deadline` rules.
   *
   * Injected rather than implemented here because the read is an RPC call needing
   * a connected wallet and a viem client, neither of which this module has or
   * should acquire. Absent, the rule reports that nothing read it — which is the
   * honest state for a rule evaluated outside the shield surface, and is not the
   * same as a loan with time to spare.
   */
  loanDeadlineReader?: RuleReader;
}

// ── heat-tier ────────────────────────────────────────────────────────────────

const HEAT_STALE_DETAIL = `Jungle Bay Island last recalculated this wallet more than ${GATE_MAX_AGE_DAYS} days ago. A reading the island would not stand behind cannot be compared against, so no tier change was concluded.`;

export async function readHeatTier(rule: AlertRule, deps: ReaderDeps = {}): Promise<SourceReading<RuleFacts>> {
  try {
    // `fresh` because a change rule comparing two cached copies of the same read
    // would report "unchanged" without having asked anything.
    const reading = await fetchHeat(rule.subject, { signal: deps.signal, fresh: true });
    const observedAt = reading.asOfUnix ?? nowUnix();
    return {
      status: 'ok',
      observedAt,
      value: {
        kind: 'heat-tier',
        change: {
          signature: reading.tier,
          label: `${reading.tier} (${reading.degrees.toFixed(2)}°)`,
          staleDetail: isStale(reading, nowUnix()) ? HEAT_STALE_DETAIL : null,
        },
      },
    };
  } catch (err) {
    return unavailable(
      err instanceof HeatUnavailableError
        ? `Heat could not be read: ${err.message}`
        : 'Jungle Bay Island’s held-time oracle could not be read, so no tier change was concluded.',
    );
  }
}

// ── launch-live ──────────────────────────────────────────────────────────────

export async function readLaunchLive(_rule: AlertRule, deps: ReaderDeps = {}): Promise<SourceReading<RuleFacts>> {
  try {
    const radar = await fetchLaunchRadar({ signal: deps.signal, fetchImpl: deps.fetchImpl, limit: 50 });
    return {
      status: 'ok',
      observedAt: radar.observedAt || nowUnix(),
      value: {
        kind: 'launch-live',
        launches: radar.entries.map((e) => ({
          token: e.token,
          pool: e.pool ?? null,
          launchedAt: e.launchedAt,
          name: e.name,
        })),
      },
    };
  } catch {
    return unavailable(
      'The market-wide new-pool feed could not be read, so it is not known whether a pool went live. This is an outage, not an absence of launches.',
    );
  }
}

// ── deployer-reputation ──────────────────────────────────────────────────────
//
// Reuses the pure cores the /deployer page runs on (parseCreatedContracts →
// toBaselines → fetchLauncherOutcomes → classifyLaunch → summarizeDeployer) so a
// band shown here and a band shown there can never disagree.

/**
 * The comparable signature for a reputation reading.
 *
 * Deliberately built from the CLASSIFICATION COUNTS plus the confidence level,
 * not from a single score: the reputation core does not publish a score, and
 * inventing one here so a rule could compare it would be exactly the fabricated
 * number the core refuses to produce. `created` is included so a new deployment
 * by a watched address is itself a change worth reporting.
 */
export function reputationSignature(counts: {
  created: number;
  activeMarket: number;
  thinMarket: number;
  noMarket: number;
  unobserved: number;
}, confidence: string): string {
  return `c${counts.created}/a${counts.activeMarket}/t${counts.thinMarket}/n${counts.noMarket}/u${counts.unobserved}@${confidence}`;
}

export async function readDeployerReputation(
  rule: AlertRule,
  deps: ReaderDeps = {},
): Promise<SourceReading<RuleFacts>> {
  const doFetch = deps.fetchImpl ?? fetch;
  let envelope: { status?: string; message?: string; result?: unknown };
  try {
    const res = await doFetch(txListUrl(rule.subject), {
      headers: { accept: 'application/json' },
      signal: deps.signal,
    });
    if (!res.ok) {
      return unavailable(
        `The transaction explorer answered ${res.status}, so this deployer’s creation history was not read and no reputation change was concluded.`,
      );
    }
    envelope = (await res.json()) as { status?: string; message?: string; result?: unknown };
  } catch {
    return unavailable(
      'The transaction explorer could not be reached, so this deployer’s creation history was not read and no reputation change was concluded.',
    );
  }

  // Etherscan reports failure inside a 200 body. Treating that as an empty
  // history would turn our own missing/throttled API key into a claim about
  // somebody's address — see explorerEnvelopeFailure's own header.
  const failure = explorerEnvelopeFailure(envelope);
  if (failure) return unavailable(failure);

  const discovery = parseCreatedContracts(envelope.result, { maxCreations: MAX_CREATIONS });
  const baselines = toBaselines(discovery.created, rule.subject);

  let outcomes: Record<string, OutcomeRecord> = {};
  try {
    const resp = await fetchLauncherOutcomes({ baselines, signal: deps.signal });
    outcomes = resp.outcomes ?? {};
  } catch {
    // Enrichment failing does not invalidate discovery: every token degrades to
    // `unobserved`, which is a status the core ships precisely for this.
    outcomes = {};
  }

  const observedAt = nowUnix();
  const trajectories = discovery.created.map((c) => {
    const input: LaunchInput = {
      token: c.address,
      createdAt: c.createdAt,
      txHash: c.txHash,
      market: marketFor(c.address, outcomes),
    };
    return classifyLaunch(input, observedAt);
  });
  const reputation = summarizeDeployer(trajectories, {
    deployer: rule.subject,
    observedAt,
    truncated: discovery.truncated,
  });

  return {
    status: 'ok',
    observedAt,
    value: {
      kind: 'deployer-reputation',
      change: {
        signature: reputationSignature(reputation.counts, reputation.confidence.level),
        label: `${reputation.counts.created} created · ${reputation.counts.activeMarket} active · ${reputation.counts.thinMarket} thin · ${reputation.counts.noMarket} no market (confidence: ${reputation.confidence.level})`,
        staleDetail: null,
      },
    },
  };
}

// ── indexed kinds ────────────────────────────────────────────────────────────

/**
 * Whale moves and LP unlocks both need indexed history. There is no
 * best-effort substitute — a transfer list assembled from a price API is a
 * different fact — so when the indexer is absent this returns the reason, and the
 * rule surfaces as "cannot evaluate" rather than as a quiet token.
 */
export function readIndexedKind(rule: AlertRule): SourceReading<RuleFacts> {
  const readiness = sourceReadiness()[RULE_SOURCE[rule.kind]];
  if (!readiness.readable) return unavailable(readiness.detail ?? 'The indexer is not readable on this deployment.');
  // The indexer IS configured but this engine has no query wired for these kinds
  // yet. Saying so is the honest state; returning an empty transfer list would
  // claim the chain was read.
  return unavailable(
    'An indexer is configured, but this engine has no indexed query wired for this rule type yet, so nothing was read. This is a missing implementation, not a quiet market.',
  );
}

// ── loan-deadline ────────────────────────────────────────────────────────────

/**
 * Two gates, in order, and neither may be answered with an empty loan list.
 *
 * A deadline rule that reports "quiet" because nothing was wired to read it is
 * the worst outcome this engine can produce: the user is told their loans are
 * fine by a pass that never looked at a loan.
 */
export async function readLoanDeadline(rule: AlertRule, deps: ReaderDeps = {}): Promise<SourceReading<RuleFacts>> {
  const readiness = sourceReadiness()[RULE_SOURCE[rule.kind]];
  if (!readiness.readable) {
    return unavailable(readiness.detail ?? 'The venue’s lending contract is not readable on this deployment.');
  }
  if (!deps.loanDeadlineReader) {
    return unavailable(
      'No on-chain loan reader was supplied to this evaluation pass, so no loan was read. Deadline rules are only evaluated on the shield surface, where a connected wallet and an RPC client exist.',
    );
  }
  return deps.loanDeadlineReader(rule, deps);
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export type RuleReader = (rule: AlertRule, deps: ReaderDeps) => Promise<SourceReading<RuleFacts>>;

export const READERS: Record<AlertRule['kind'], RuleReader> = {
  'heat-tier': readHeatTier,
  'launch-live': readLaunchLive,
  'deployer-reputation': readDeployerReputation,
  'whale-move': async (rule) => readIndexedKind(rule),
  'lp-unlock': async (rule) => readIndexedKind(rule),
  'loan-deadline': readLoanDeadline,
};

/**
 * Read every rule. Failures are values, not exceptions: one unreachable source
 * must not stop the other rules from being evaluated, and it must not be able to
 * empty the whole pass either.
 */
export async function readAll(
  rules: readonly AlertRule[],
  deps: ReaderDeps = {},
): Promise<Record<string, SourceReading<RuleFacts>>> {
  const out: Record<string, SourceReading<RuleFacts>> = {};
  const settled = await Promise.allSettled(
    rules.map(async (rule) => ({ id: rule.id, reading: await READERS[rule.kind](rule, deps) })),
  );
  settled.forEach((result, i) => {
    const rule = rules[i]!;
    out[rule.id] =
      result.status === 'fulfilled'
        ? result.value.reading
        : unavailable('This rule’s source threw while being read, so nothing was concluded from it.');
  });
  return out;
}

/** Narrow re-export so callers do not reach into viem for the one type they need. */
export type ReaderSubject = Address;
