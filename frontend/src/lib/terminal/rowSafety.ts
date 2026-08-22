// Per-row safety read for the terminal feed — the module that decides whether a
// row is allowed to make a safety CLAIM at all.
//
// THE FAILURE THIS EXISTS TO PREVENT. On a page built for fast decisions, a
// green row is read as a recommendation. So the two ways a row can end up
// without a red mark are NOT the same fact and must never render the same way:
//
//   scanned-and-clean  — the concentration read and the deployer read both came
//                        back, and neither showed anything. A claim.
//   could-not-scan     — one of them did not come back. Not a claim, not a
//                        smaller claim, not a claim with an asterisk. There is
//                        no measurement to state.
//
// A row in the second state that sorted or filtered alongside the first would
// launder an upstream outage into a buy signal. That is why `safetyRank` returns
// `null` for anything short of a complete read (an unranked row leaves the axis
// entirely rather than taking a flattering position on it), and why
// `isKnownSafe` — the single predicate the "safe only" filter and the green
// badge tone both go through — requires `coverage === 'complete'`.
//
// ASYMMETRY, deliberate: a gap can raise the observed risk but can never lower
// it. So a partly-read row that ALREADY showed high risk still renders as high
// risk (the finding is real; the missing component could only add to it), while
// a partly-read row that showed nothing renders as unread, not as clean.
//
// PURE. No network, no clock. The two adapters at the bottom are the only places
// that know the shape of the upstream reads, so a change to either core type
// fails to compile here rather than silently changing what a badge means.

import type { Band, ConfidenceLevel, DistributionAnalysis } from '../detection';
import type { DeployerReputation } from '../detection/deployerReputation';
import type { HeatReading } from '../heat/heatOracle';

/** The three reads a row displays. Only the first two are allowed to score it. */
export type SafetyComponentId = 'distribution' | 'deployer' | 'heat';

/**
 * One upstream read, or the stated absence of one.
 *
 * `unread` carries a reason in words a trader can act on, because the reason is
 * the entire content of the state — "unavailable" with no cause is how an
 * outage gets mistaken for a property of the token.
 */
export type ComponentRead<T> =
  | { state: 'read'; value: T }
  | { state: 'unread'; reason: string };

export function componentRead<T>(value: T): ComponentRead<T> {
  return { state: 'read', value };
}

export function componentUnread<T>(reason: string): ComponentRead<T> {
  return { state: 'unread', reason };
}

/** Concentration facts the scanner produced, narrowed to what scoring uses. */
export interface DistributionRead {
  band: Band;
  /** The core's data-confidence flag. Degrades COVERAGE here, never the band. */
  confidence: ConfidenceLevel;
  /** Ids of hard-fact gates that actually fired (mint authority live, LP unlocked, …). */
  firedGateIds: string[];
}

/** Deployer-history facts, narrowed. Counts only — never a verdict about a person. */
export interface DeployerRead {
  created: number;
  noMarket: number;
  /** Created tokens whose CURRENT market could not be read. A gap, not a zero. */
  unobserved: number;
  confidence: ConfidenceLevel;
}

/** Heat standing. Displayed, never scored — see HEAT_IS_NOT_A_RISK_SIGNAL. */
export interface HeatRead {
  tier: string;
  degrees: number;
  isCold: boolean;
}

export interface SafetyInputs {
  distribution: ComponentRead<DistributionRead>;
  deployer: ComponentRead<DeployerRead>;
  heat: ComponentRead<HeatRead>;
}

/**
 * What was OBSERVED. Not a recommendation and not a completeness statement —
 * `coverage` carries that, separately, for the same reason the detection core
 * keeps its confidence flag out of its band.
 */
export type SafetyVerdict = 'clean' | 'caution' | 'high-risk';

const VERDICT_RANK: Record<SafetyVerdict, number> = {
  clean: 0,
  caution: 1,
  'high-risk': 2,
};

const BAND_VERDICT: Record<Band, SafetyVerdict> = {
  'well-distributed': 'clean',
  mixed: 'caution',
  concentrated: 'high-risk',
};

/** One factual observation behind a verdict. Never an accusation. */
export interface SafetyFlag {
  id: string;
  note: string;
}

export type RowSafety =
  | {
      kind: 'unscored';
      /** Which scoring components did not come back. Never empty. */
      missing: SafetyComponentId[];
      /** One sentence per missing component, in the upstream's own words. */
      reasons: string[];
      heat: ComponentRead<HeatRead>;
    }
  | {
      kind: 'scored';
      observed: SafetyVerdict;
      /**
       * `complete` — every scoring component came back and each was confident
       * enough to stand behind. `partial` — something is missing or too weak to
       * carry a claim, so this row is off the safety axis (see `safetyRank`).
       */
      coverage: 'complete' | 'partial';
      /** Non-empty exactly when `coverage === 'partial'`. */
      gaps: string[];
      flags: SafetyFlag[];
      heat: ComponentRead<HeatRead>;
    };

/**
 * HEAT_IS_NOT_A_RISK_SIGNAL.
 *
 * The Heat tier measures how long a wallet has held island tokens. A cold wallet
 * is a new wallet, which is not a hazard, and a hot wallet is a tenured holder,
 * which is not a safety guarantee — scoring on either direction would mislabel
 * the whole population of honest new deployers. So heat rides along the row for
 * display and is excluded from both the verdict and the coverage test: a heat
 * outage must not make a fully-read row unrated.
 */
const SCORING_COMPONENTS: readonly SafetyComponentId[] = ['distribution', 'deployer'];

function worse(a: SafetyVerdict, b: SafetyVerdict): SafetyVerdict {
  return VERDICT_RANK[a] >= VERDICT_RANK[b] ? a : b;
}

export function assessRowSafety(inputs: SafetyInputs): RowSafety {
  const missing: SafetyComponentId[] = [];
  const reasons: string[] = [];
  for (const id of SCORING_COMPONENTS) {
    const read = inputs[id];
    if (read.state === 'unread') {
      missing.push(id);
      reasons.push(read.reason);
    }
  }
  if (missing.length > 0) {
    return { kind: 'unscored', missing, reasons, heat: inputs.heat };
  }

  // Both scoring components are `read` past this point; the narrowing is by hand
  // because TypeScript cannot follow the loop above.
  const dist = (inputs.distribution as { state: 'read'; value: DistributionRead }).value;
  const dep = (inputs.deployer as { state: 'read'; value: DeployerRead }).value;

  const flags: SafetyFlag[] = [];
  let observed = BAND_VERDICT[dist.band];

  for (const gateId of dist.firedGateIds) {
    flags.push({ id: `gate:${gateId}`, note: GATE_NOTES[gateId] ?? DEFAULT_GATE_NOTE });
    // The detection core already folds a fired gate into the band as a floor, so
    // this cannot lower `observed`; taking the worse of the two anyway means a
    // future gate that stops forcing a band still cannot pass as clean here.
    observed = worse(observed, 'caution');
  }

  // Deployer history escalates to CAUTION and stops there, on purpose. The
  // reputation core's own law is that a missing pool is "no live market found",
  // never a rug — it cannot tell a withdrawn pool from one that never existed
  // from one on a venue we do not index. Caution is what that supports; anything
  // above it would be this module inventing the verdict that core refuses to.
  if (dep.noMarket > 0) {
    observed = worse(observed, 'caution');
    flags.push({
      id: 'deployer:no-live-market',
      note:
        `${dep.noMarket} of ${dep.created} contract${dep.created === 1 ? '' : 's'} this address deployed has no live ` +
        'trading pool right now. That is a current-state observation, not evidence of a rug.',
    });
  }

  // ── Coverage ───────────────────────────────────────────────────────────────
  // A read that came back but cannot be trusted is not a smaller read. Low
  // confidence on either core means the measurement could invert under a label
  // it did not have, so the row loses its place on the axis rather than keeping
  // a position it did not earn.
  const gaps: string[] = [];
  if (dist.confidence === 'low') {
    gaps.push(
      'The holder read came back with low data confidence, so it cannot support a claim about this token either way.',
    );
  }
  if (dep.confidence === 'low') {
    gaps.push(
      'The deployer read came back with low data confidence, so its history is not a basis for a claim.',
    );
  }
  if (dep.unobserved > 0) {
    gaps.push(
      `${dep.unobserved} of ${dep.created} contract${dep.created === 1 ? '' : 's'} this address deployed had an ` +
        'unreadable market at this observation — those are gaps, not clean results.',
    );
  }

  return {
    kind: 'scored',
    observed,
    coverage: gaps.length === 0 ? 'complete' : 'partial',
    gaps,
    flags,
    heat: inputs.heat,
  };
}

/**
 * The state every row starts in.
 *
 * Scoring a row costs three upstream reads, so the feed cannot score all of them
 * at once (see useTerminalSafety). The resting state is therefore UNSCORED, not
 * "presumed fine" — a page that defaulted to clean and then downgraded would
 * spend its first seconds showing green rows nobody has looked at, which is the
 * failure this module exists to prevent, merely delayed.
 */
export const SAFETY_NOT_REQUESTED: RowSafety = {
  kind: 'unscored',
  missing: ['distribution', 'deployer'],
  reasons: [
    'This row has not been scored yet. Select it to run the holder and deployer reads.',
  ],
  heat: { state: 'unread', reason: 'No Heat reading has been requested for this row.' },
};

const DEFAULT_GATE_NOTE = 'A hard-fact check fired on this token.';

const GATE_NOTES: Record<string, string> = {
  'mint-authority-live': 'The mint authority is still live, so supply can still be increased.',
  'freeze-authority-live': 'The freeze authority is still live, so transfers can still be frozen.',
  'lp-unlocked': 'Pool liquidity is not locked, or its lock has already elapsed.',
  'cluster-share': 'One coordinated cluster of wallets holds a large share of total supply.',
  'top1-share': 'A single wallet holds a large share of total supply.',
};

/**
 * The one predicate a positive safety claim may go through.
 *
 * The green badge tone and the "safe only" filter both call this and nothing
 * else, so there is exactly one place where "this row is safe" is decided, and
 * a change to it moves both surfaces together.
 */
export function isKnownSafe(safety: RowSafety): boolean {
  return safety.kind === 'scored' && safety.coverage === 'complete' && safety.observed === 'clean';
}

/**
 * Position on the safety axis, or `null` for a row that has none.
 *
 * `null` is not "worst" and not "best" — `compareBySafety` sends it to the end
 * in BOTH directions, because a row whose read did not complete is not a
 * measured risk any more than it is a measured safety. Sorting it as either one
 * would be the fabricated zero with a direction attached.
 */
export function safetyRank(safety: RowSafety): number | null {
  if (safety.kind !== 'scored') return null;
  if (safety.coverage !== 'complete') return null;
  return VERDICT_RANK[safety.observed];
}

export type SafetySortDirection = 'safest-first' | 'riskiest-first';

/**
 * Ordering WITHIN the unrated block, and it is deliberately the SAME under both
 * directions.
 *
 * Leaving the block unordered would bury the rows that most need a look: a row
 * that was partly read and showed high risk is unrated (its position is not
 * known) but its finding is real, and under "riskiest first" it would otherwise
 * sit below every clean row on the page. So the block is ordered worst-observed
 * first, with the never-read rows last. This cannot promote an unrated row past
 * a rated one — that comparison is settled before this is consulted.
 */
function unratedOrder(safety: RowSafety): number {
  if (safety.kind === 'unscored') return 3;
  return 2 - VERDICT_RANK[safety.observed];
}

/** Stable comparator. Unranked rows trail ranked ones under either direction. */
export function compareBySafety(
  a: RowSafety,
  b: RowSafety,
  direction: SafetySortDirection,
): number {
  const ra = safetyRank(a);
  const rb = safetyRank(b);
  if (ra === null && rb === null) return unratedOrder(a) - unratedOrder(b);
  if (ra === null) return 1;
  if (rb === null) return -1;
  return direction === 'safest-first' ? ra - rb : rb - ra;
}

/** Sort a row list without mutating it. Ties keep input order. */
export function sortBySafety<T>(
  rows: readonly T[],
  safetyOf: (row: T) => RowSafety,
  direction: SafetySortDirection,
): T[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((x, y) => {
      const c = compareBySafety(safetyOf(x.row), safetyOf(y.row), direction);
      return c !== 0 ? c : x.index - y.index;
    })
    .map((e) => e.row);
}

/**
 * `unrated` is a first-class choice, not a leftover bucket.
 *
 * It is what turns an upstream outage into a visible worklist instead of a
 * quiet absence — the operator can see exactly how much of the feed could not
 * be read, on the page where it matters.
 */
export type SafetyFilter = 'all' | 'known-safe' | 'unrated';

export const SAFETY_FILTER_LABELS: Record<SafetyFilter, string> = {
  all: 'All rows',
  'known-safe': 'Fully read, nothing found',
  unrated: 'Could not be scored',
};

export function passesSafetyFilter(safety: RowSafety, filter: SafetyFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'known-safe':
      return isKnownSafe(safety);
    case 'unrated':
      return safetyRank(safety) === null;
  }
}

export type SafetyTone = 'good' | 'warn' | 'bad' | 'unknown';

export interface SafetyBadge {
  label: string;
  tone: SafetyTone;
  /** Always populated. The `unknown` tones need it most — it names what failed. */
  detail: string;
}

/**
 * Badge text and tone.
 *
 * INVARIANT, pinned in the tests: `tone === 'good'` if and only if
 * `isKnownSafe` — the colour a trader scans for cannot come apart from the
 * predicate the filter uses.
 */
export function safetyBadge(safety: RowSafety): SafetyBadge {
  if (safety.kind === 'unscored') {
    return {
      label: 'Not scored',
      tone: 'unknown',
      detail: safety.reasons.join(' '),
    };
  }

  const partly = safety.coverage === 'partial';
  const gapNote = partly ? ` ${safety.gaps.join(' ')}` : '';
  const flagNote = safety.flags.length > 0 ? ` ${safety.flags.map((f) => f.note).join(' ')}` : '';

  if (safety.observed === 'clean') {
    return partly
      ? {
          label: 'Partly unread',
          tone: 'unknown',
          // Deliberately says nothing about the token. What the completed part of
          // the read found is not stated here, because stating it beside the word
          // "unread" is how a partial result gets read as a clean one.
          detail: `This row was not fully read, so it carries no safety result.${gapNote}`,
        }
      : {
          label: 'Read, nothing found',
          tone: 'good',
          detail:
            'Holder concentration and deployer history were both read and neither showed a flag. This describes what was measured at this observation; it is not a guarantee about the token.',
        };
  }

  const suffix = partly ? ' (partly unread)' : '';
  if (safety.observed === 'caution') {
    return {
      label: `Caution${suffix}`,
      tone: 'warn',
      detail: `${flagNote.trim()}${gapNote}`.trim(),
    };
  }
  return {
    label: `High risk${suffix}`,
    tone: 'bad',
    // A gap can only add to an observed risk, never subtract, so this stays `bad`.
    detail: `${flagNote.trim()}${gapNote}`.trim(),
  };
}

// ─── Adapters from the upstream cores ────────────────────────────────────────

/**
 * A returned analysis IS a read — `analyzeDistribution` is total and never
 * fabricates. Whether that read is strong enough to carry a claim is the
 * confidence flag's job, downstream, and it is deliberately not decided here.
 */
export function distributionReadFrom(analysis: DistributionAnalysis): ComponentRead<DistributionRead> {
  return componentRead({
    band: analysis.band,
    confidence: analysis.confidence.level,
    firedGateIds: analysis.gate.findings.filter((f) => f.fired).map((f) => f.id),
  });
}

/**
 * `created === 0` maps to UNREAD, not to a clean history.
 *
 * The reputation core only sees contracts an address deployed DIRECTLY;
 * factory-launched tokens — the norm for launchers — are created by the factory
 * and are structurally invisible without an event indexer. So an empty result is
 * "we found nothing to measure", and rendering it as a spotless record would
 * make every factory deployer look proven.
 */
export function deployerReadFrom(rep: DeployerReputation): ComponentRead<DeployerRead> {
  const c = rep.counts;
  if (c.created === 0) {
    return componentUnread(
      'No contracts deployed directly by this address were found, and tokens launched through a factory are invisible without an event indexer — so there is no deployer history to read.',
    );
  }
  if (c.unobserved === c.created) {
    return componentUnread(
      'The current market state of every contract this address deployed was unreadable at this observation.',
    );
  }
  return componentRead({
    created: c.created,
    noMarket: c.noMarket,
    unobserved: c.unobserved,
    confidence: rep.confidence.level,
  });
}

export function heatReadFrom(reading: HeatReading): ComponentRead<HeatRead> {
  return componentRead({
    tier: reading.tier,
    degrees: reading.degrees,
    isCold: reading.isCold,
  });
}
