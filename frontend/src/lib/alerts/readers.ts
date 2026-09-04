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
import { readPoolTrades } from '../geckoTerminal/poolTrades';
import { geckoPoolsMultiUrl, readGeckoPools, type GeckoNetwork, type MarketRow } from '../geckoTerminal/pools';
import { sourceReadiness, RULE_SOURCE } from './sources';
import { parsePoolSubject, type AlertRule } from './rules';
import type { PoolSwapFact, RuleFacts, SourceReading } from './evaluate';

/** Same ceiling the deployer page uses, so the two surfaces read the same slice. */
const MAX_CREATIONS = 50;

function unavailable(detail: string): SourceReading<RuleFacts> {
  return { status: 'unavailable', detail };
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * One evaluation pass's shared reads.
 *
 * Created fresh per pass by the loop and thrown away with it, so it can never
 * serve a stale answer across a minute boundary. It exists for a quota reason
 * that is load-bearing rather than cosmetic: three deployer rules on one address
 * used to cost three explorer calls, two launch rules cost two market-wide radar
 * fetches of an identical body, and GeckoTerminal throttles a keyless browser at
 * roughly 30 requests a minute for the WHOLE origin — shared with the chart and
 * the market strip.
 */
export interface ReaderPass {
  cache: Map<string, Promise<unknown>>;
  /**
   * Every rule in this pass, so a reader can BATCH.
   *
   * The pool-quote endpoint takes up to 30 pools per request, and a reader that
   * only saw its own rule would ask once per pool — five requests where one
   * would do, against an upstream that throttles the whole origin. A reader may
   * read this list; it may never act on a rule that is not its own.
   */
  rules: readonly AlertRule[];
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
  /** Per-pass read sharing. Absent means every rule reads for itself. */
  pass?: ReaderPass;
}

export function newReaderPass(rules: readonly AlertRule[] = []): ReaderPass {
  return { cache: new Map(), rules };
}

/** Share one in-flight read across every rule in this pass that wants the same thing. */
function shared<T>(deps: ReaderDeps, key: string, make: () => Promise<T>): Promise<T> {
  const pass = deps.pass;
  if (!pass) return make();
  const hit = pass.cache.get(key) as Promise<T> | undefined;
  if (hit) return hit;
  const started = make();
  pass.cache.set(key, started as Promise<unknown>);
  return started;
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
    // The radar is MARKET-WIDE and ignores the rule entirely, so N launch rules
    // in one pass are N identical requests. Keyed on the resource, not the rule.
    const radar = await shared(deps, 'launch-radar', () =>
      fetchLaunchRadar({ signal: deps.signal, fetchImpl: deps.fetchImpl, limit: 50 }),
    );
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

/**
 * The one reason a reputation reading must be REFUSED even though discovery
 * succeeded — and the bug this replaced.
 *
 * The signature is built from classification counts, and a token with no market
 * reading classifies as `unobserved`. So when the pool-state enrichment was down
 * the old code swallowed it (`outcomes = {}`), every creation degraded to
 * unobserved, and the signature changed — from `c3/a2/t1/n0/u0` to
 * `c3/a0/t0/n0/u3`. evaluate.ts compared that against the previous reading, saw a
 * difference, and FIRED "Deployer reputation change" on an outage in our own
 * enrichment call. A notification that says a deployer's behaviour changed, when
 * what changed was our ability to look, is the worst output this engine has: it
 * is confident, specific, and about somebody's address.
 */
const ENRICHMENT_UNAVAILABLE_DETAIL =
  'The deployer’s creation history was read, but the pool-state enrichment could not be, so the band could not be recomputed on the same footing as the previous reading. No change was concluded.';

export async function readDeployerReputation(
  rule: AlertRule,
  deps: ReaderDeps = {},
): Promise<SourceReading<RuleFacts>> {
  // One explorer read per SUBJECT per pass: two rules watching the same deployer
  // ask the throttled explorer once.
  return shared(deps, `deployer:${rule.subject}`, () => readDeployerReputationUncached(rule, deps));
}

async function readDeployerReputationUncached(
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

  // Nothing to enrich is not an enrichment failure. A deployer with no creations
  // has a complete, comparable reading already, and calling out for zero
  // baselines would let a third-party outage refuse a reading that needed nothing
  // from it.
  let outcomes: Record<string, OutcomeRecord> = {};
  if (baselines.length > 0) {
    try {
      const resp = await fetchLauncherOutcomes({ baselines, signal: deps.signal });
      if (!resp || typeof resp.outcomes !== 'object' || resp.outcomes === null) {
        return unavailable(ENRICHMENT_UNAVAILABLE_DETAIL);
      }
      outcomes = resp.outcomes;
    } catch {
      return unavailable(ENRICHMENT_UNAVAILABLE_DETAIL);
    }
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

// ── GeckoTerminal pool kinds ─────────────────────────────────────────────────
//
// Two endpoints, each read only when a rule of the matching kind exists: the
// pools/multi QUOTE endpoint for the price kinds — batched across every price
// rule on a network, so five pools cost one request — and the recent-TRADES feed
// for the swap kind, shared per pool across the pass.
//
// Neither reader retries. The upstream is keyless and throttles by IP, and this
// loop runs unattended once a minute — a retry would spend the same scarce quota
// twice for a pass that can simply report that it could not read.

const BAD_POOL_SUBJECT_DETAIL =
  'This rule’s subject is not a network:pool pair, so no pool could be identified and nothing was read.';

/**
 * Every pool this pass wants a QUOTE for, on one network.
 *
 * Batching is why this reaches for the pass's whole rule list: GeckoTerminal's
 * `pools/multi` answers up to 30 pools in one request, so five price rules across
 * five pools on Base cost ONE call instead of five against an upstream that
 * throttles this browser's whole origin. The list is sorted so the cache key for
 * a given set of pools is stable however the rules were ordered.
 */
function poolsToQuote(deps: ReaderDeps, network: GeckoNetwork, fallback: string): string[] {
  const wanted = new Set<string>([fallback]);
  for (const rule of deps.pass?.rules ?? []) {
    if (!rule.enabled) continue;
    if (rule.kind !== 'pool-price-above' && rule.kind !== 'pool-price-below') continue;
    const parsed = parsePoolSubject(rule.subject);
    if (parsed && parsed.network === network) wanted.add(parsed.pool);
  }
  return [...wanted].sort();
}

export async function readPoolPrice(rule: AlertRule, deps: ReaderDeps = {}): Promise<SourceReading<RuleFacts>> {
  if (rule.kind !== 'pool-price-above' && rule.kind !== 'pool-price-below') {
    return unavailable(BAD_POOL_SUBJECT_DETAIL);
  }
  const parsed = parsePoolSubject(rule.subject);
  if (!parsed) return unavailable(BAD_POOL_SUBJECT_DETAIL);

  const pools = poolsToQuote(deps, parsed.network, parsed.pool);
  const url = geckoPoolsMultiUrl(parsed.network, pools);
  const read = await shared(deps, `gecko:quote:${parsed.network}:${pools.join(',')}`, () =>
    readGeckoPools(url, { signal: deps.signal, fetchImpl: deps.fetchImpl }),
  );
  if (read.status === 'unread') return unavailable(read.detail);

  // EVM pool ids are lower-cased on the way into a subject and come back lower-
  // cased from upstream; a Solana id is compared byte-for-byte, because case is
  // part of a base58 value rather than presentation.
  const wantedKey = `${parsed.network}:${parsed.pool}`;
  const row: MarketRow | undefined =
    read.rows.find((r) => r.key === wantedKey) ??
    (parsed.network === 'solana'
      ? undefined
      : read.rows.find((r) => r.key.toLowerCase() === wantedKey.toLowerCase()));

  if (!row) {
    // Asked about, not answered about. Saying "no price" here would be a claim
    // about the pool; the truth is that this pool was not in the answer.
    return unavailable(
      'GeckoTerminal answered without this pool in the response, so nothing was read for it and nothing was concluded.',
    );
  }
  if (row.priceUsd === null) {
    return unavailable(
      row.withheld
        ? 'GeckoTerminal quoted this pool with figures this app will not read — a negative or missing reserve makes the price untrustworthy — so nothing could be compared. That is an outage, not a zero.'
        : 'GeckoTerminal returned no price for this pool, so nothing could be compared — that is an outage, not a zero.',
    );
  }
  return {
    status: 'ok',
    // The READ clock, and evaluate.ts stamps the event `observedAtKind: 'read'`
    // for it: GeckoTerminal publishes no as-of time on a pool quote, so anything
    // else here would attribute our own clock to them.
    observedAt: Math.floor(read.fetchedAt / 1000),
    value: { kind: rule.kind, priceUsd: row.priceUsd, poolName: row.name },
  };
}

export async function readPoolLargeTrade(rule: AlertRule, deps: ReaderDeps = {}): Promise<SourceReading<RuleFacts>> {
  const parsed = parsePoolSubject(rule.subject);
  if (!parsed) return unavailable(BAD_POOL_SUBJECT_DETAIL);

  const read = await shared(deps, `gecko:trades:${parsed.network}:${parsed.pool}`, () =>
    readPoolTrades(parsed.network, parsed.pool, { signal: deps.signal, fetchImpl: deps.fetchImpl }),
  );
  if (read.status === 'unread') return unavailable(read.detail);

  const trades: PoolSwapFact[] = [];
  for (const t of read.trades) {
    const at = Math.floor(Date.parse(t.at) / 1000);
    // A trade whose block timestamp will not parse cannot be placed relative to
    // the watermark, so it is dropped rather than guessed at the read clock —
    // which would make an old trade look like a new one and fire on it.
    if (!Number.isFinite(at)) continue;
    trades.push({ txHash: t.txHash, at, usd: t.usd, kind: t.kind, wallet: t.wallet });
  }
  return {
    status: 'ok',
    observedAt: Math.floor(read.fetchedAt / 1000),
    value: { kind: 'pool-large-trade', trades },
  };
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
  'pool-price-above': readPoolPrice,
  'pool-price-below': readPoolPrice,
  'pool-large-trade': readPoolLargeTrade,
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
