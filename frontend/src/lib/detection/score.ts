// Scoring: soft-signal blend + weakest-link gate + 3-band verdict + a SEPARATE
// data-confidence flag, and the `analyzeDistribution` orchestrator that ties the
// exclusion registry and the pure metrics together.
//
// DESIGN (per completed detection research):
//  - Weakest-link GATE over hard facts (mint/freeze authority live, LP unlocked,
//    top-1 cluster / single holder over threshold). A fired hard fact raises a
//    band FLOOR — soft evidence can never argue a token BACK below it.
//  - Weighted BLEND of soft signals for the finer read between the floors.
//  - Confidence is reported ALONGSIDE, never folded into the band: a strong band
//    on thin data must still read as low-confidence.
//  - Honest framing: this is a descriptive measurement with a disclosed method,
//    components, exclusions, timestamp, and a correction path — not a verdict on
//    intent. Missing signals are dropped from the blend, never defaulted.

import type {
  Band,
  ConfidenceResult,
  DistributionAnalysis,
  DistributionMetrics,
  ExclusionBucket,
  ExclusionSummary,
  GateFinding,
  GateResult,
  HardFacts,
  HolderCategory,
  RawHolder,
  ScoringConfig,
  SoftBlend,
  SoftSignal,
  ChainKind,
  ClassifiedHolder,
  LabelSource,
  LaunchFacts,
} from './types';
import { BAND_RANK, METHOD_VERSION } from './types';
import {
  computeMetrics,
  largestHeuristicExcludedShareOfTotal, // AUDIT FIX TF-025
  largestUnclassifiedShareOfTotal,
  ratio,
  sumBalances,
  unclassifiedShareOfTotal,
} from './metrics';
import { classifyHolders } from './exclusions';

/** Battle-tested defaults. Every field is overridable per call. */
export const DEFAULT_CONFIG: ScoringConfig = {
  weights: {
    effectiveHolders: 0.18,
    top1: 0.12,
    top10: 0.1,
    nakamoto: 0.1,
    gini: 0.05, // SECONDARY — deliberately small (address ≠ person)
    clustered: 0.2,
    bundledHeld: 0.12,
    sniper: 0.13,
  },
  ramps: {
    // "higher is better" ⇒ atGood > atBad (ramp handles the descending case)
    effectiveHolders: [150, 15],
    nakamoto: [20, 2],
    // "higher is worse" ⇒ atGood < atBad
    top1: [0.05, 0.5],
    top10: [0.15, 0.6],
    gini: [0.7, 0.99],
    clustered: [0.05, 0.4],
    bundledHeld: [0.05, 0.35],
    sniper: [0.05, 0.35],
  },
  bands: { wellMax: 0.25, mixedMax: 0.55 },
  gate: {
    hardClusterThreshold: 0.5,
    hardTop1Threshold: 0.5,
    mintLiveFloor: 'concentrated',
    freezeLiveFloor: 'mixed',
    lpUnlockedFloor: 'concentrated',
    clusterFloor: 'concentrated',
    top1Floor: 'concentrated',
  },
  confidence: {
    minHolders: 50,
    maxUnclassifiedShareOfTotal: 0.2, // diffuse unlabeled base ⇒ medium
    minTokenAgeSeconds: 60 * 60 * 24 * 3, // 3 days
    singleUnclassifiedShareOfTotal: 0.1, // one wallet ≥10% unlabeled ⇒ medium
    dominantUnclassifiedShareOfTotal: 0.25, // one wallet ≥25% unlabeled ⇒ low
  },
  unclassifiedThreshold: 0.01, // ≥1% of supply, unlabeled ⇒ `unclassified`
};

/** Deep-merge a partial config over the defaults. */
export function resolveConfig(partial?: Partial<ScoringConfig>): ScoringConfig {
  if (!partial) return DEFAULT_CONFIG;
  return {
    weights: { ...DEFAULT_CONFIG.weights, ...partial.weights },
    ramps: { ...DEFAULT_CONFIG.ramps, ...partial.ramps },
    bands: { ...DEFAULT_CONFIG.bands, ...partial.bands },
    gate: { ...DEFAULT_CONFIG.gate, ...partial.gate },
    confidence: { ...DEFAULT_CONFIG.confidence, ...partial.confidence },
    unclassifiedThreshold: partial.unclassifiedThreshold ?? DEFAULT_CONFIG.unclassifiedThreshold,
  };
}

/**
 * Linear risk ramp in [0,1]. `atGood` maps to 0 risk, `atBad` to 1, clamped
 * outside. Works in both directions: for "higher is better" metrics pass
 * `atGood > atBad`.
 */
export function ramp(value: number, atGood: number, atBad: number): number {
  if (atGood === atBad) return value >= atBad ? 1 : 0;
  const t = (value - atGood) / (atBad - atGood);
  return Math.max(0, Math.min(1, t));
}

/** The worse (higher-ranked) of two bands. */
export function worseBand(a: Band, b: Band): Band {
  return BAND_RANK[a] >= BAND_RANK[b] ? a : b;
}

function bandFromRisk(risk: number, cfg: ScoringConfig): Band {
  if (risk <= cfg.bands.wellMax) return 'well-distributed';
  if (risk <= cfg.bands.mixedMax) return 'mixed';
  return 'concentrated';
}

/**
 * Blend the soft signals into a single risk in [0,1]. Signals whose value is
 * `null` (not measured) are dropped and the remaining weights are renormalized,
 * so an absent bundle/sniper/cluster reading never silently counts as 0 risk.
 */
export function blendSoftSignals(metrics: DistributionMetrics, cfg: ScoringConfig): SoftBlend {
  const r = cfg.ramps;
  const w = cfg.weights;
  const raw: SoftSignal[] = [
    {
      id: 'effectiveHolders',
      value: metrics.includedHolders > 0 ? metrics.effectiveHolders : null,
      risk: metrics.includedHolders > 0 ? ramp(metrics.effectiveHolders, r.effectiveHolders[0], r.effectiveHolders[1]) : null,
      weight: w.effectiveHolders,
    },
    {
      id: 'top1',
      value: metrics.includedHolders > 0 ? metrics.topN.top1 : null,
      risk: metrics.includedHolders > 0 ? ramp(metrics.topN.top1, r.top1[0], r.top1[1]) : null,
      weight: w.top1,
    },
    {
      id: 'top10',
      value: metrics.includedHolders > 0 ? metrics.topN.top10 : null,
      risk: metrics.includedHolders > 0 ? ramp(metrics.topN.top10, r.top10[0], r.top10[1]) : null,
      weight: w.top10,
    },
    {
      id: 'nakamoto',
      value: metrics.includedHolders > 0 ? metrics.nakamotoCoefficient : null,
      risk: metrics.includedHolders > 0 ? ramp(metrics.nakamotoCoefficient, r.nakamoto[0], r.nakamoto[1]) : null,
      weight: w.nakamoto,
    },
    {
      id: 'gini',
      value: metrics.includedHolders > 1 ? metrics.gini : null,
      risk: metrics.includedHolders > 1 ? ramp(metrics.gini, r.gini[0], r.gini[1]) : null,
      weight: w.gini,
    },
    {
      id: 'clustered',
      value: metrics.clusteredSupplyShareOfTotal,
      risk:
        metrics.clusteredSupplyShareOfTotal == null
          ? null
          : ramp(metrics.clusteredSupplyShareOfTotal, r.clustered[0], r.clustered[1]),
      weight: w.clustered,
    },
    {
      id: 'bundledHeld',
      value: metrics.bundledCurrentHeldShareOfTotal,
      risk:
        metrics.bundledCurrentHeldShareOfTotal == null
          ? null
          : ramp(metrics.bundledCurrentHeldShareOfTotal, r.bundledHeld[0], r.bundledHeld[1]),
      weight: w.bundledHeld,
    },
    {
      id: 'sniper',
      value: metrics.sniperHeldShareOfTotal,
      risk:
        metrics.sniperHeldShareOfTotal == null
          ? null
          : ramp(metrics.sniperHeldShareOfTotal, r.sniper[0], r.sniper[1]),
      weight: w.sniper,
    },
  ];

  let weightedSum = 0;
  let weightTotal = 0;
  for (const s of raw) {
    if (s.risk == null) continue;
    weightedSum += s.risk * s.weight;
    weightTotal += s.weight;
  }
  const risk = weightTotal > 0 ? weightedSum / weightTotal : 0;
  return { risk, band: bandFromRisk(risk, cfg), signals: raw };
}

/**
 * Weakest-link gate over HARD facts. Each fired fact raises the band FLOOR.
 * Unknown facts (`null`/absent) never fire — unknown is not a red flag.
 */
export function evaluateGate(
  metrics: DistributionMetrics,
  hardFacts: HardFacts | undefined,
  cfg: ScoringConfig,
): GateResult {
  const hf = hardFacts ?? {};
  const clusterShare = metrics.clusteredSupplyShareOfTotal;
  const findings: GateFinding[] = [
    {
      id: 'mint-authority-live',
      fired: hf.mintAuthorityLive === true,
      forcedBand: cfg.gate.mintLiveFloor,
      detail:
        hf.mintAuthorityLive === true
          ? 'Mint authority is live — supply can be inflated, so any current distribution can be diluted at will.'
          : hf.mintAuthorityLive == null
            ? 'Mint authority status unknown (not measured).'
            : 'Mint authority is renounced / not present.',
    },
    {
      id: 'freeze-authority-live',
      fired: hf.freezeAuthorityLive === true,
      forcedBand: cfg.gate.freezeLiveFloor,
      detail:
        hf.freezeAuthorityLive === true
          ? 'Freeze authority is live — holdings can be frozen by the authority.'
          : hf.freezeAuthorityLive == null
            ? 'Freeze authority status unknown (not measured).'
            : 'Freeze authority is renounced / not present.',
    },
    {
      id: 'lp-unlocked',
      fired: hf.lpUnlocked === true,
      forcedBand: cfg.gate.lpUnlockedFloor,
      detail:
        hf.lpUnlocked === true
          ? 'Liquidity is unlocked — it can be withdrawn, so holder distribution is not the binding risk.'
          : hf.lpUnlocked == null
            ? 'Liquidity-lock status unknown (not measured).'
            : 'Liquidity is locked.',
    },
    {
      id: 'top1-cluster-over-threshold',
      fired: clusterShare != null && clusterShare >= cfg.gate.hardClusterThreshold,
      forcedBand: cfg.gate.clusterFloor,
      detail:
        clusterShare == null
          ? 'Coordinated-cluster share not measured.'
          : `Largest coordinated cluster holds ${(clusterShare * 100).toFixed(1)}% of total supply (threshold ${(cfg.gate.hardClusterThreshold * 100).toFixed(0)}%).`,
    },
    {
      id: 'single-holder-majority',
      fired: metrics.top1ShareOfTotal >= cfg.gate.hardTop1Threshold,
      forcedBand: cfg.gate.top1Floor,
      detail: `Largest single holder holds ${(metrics.top1ShareOfTotal * 100).toFixed(1)}% of total supply (threshold ${(cfg.gate.hardTop1Threshold * 100).toFixed(0)}%).`,
    },
  ];

  let floor: Band = 'well-distributed';
  for (const f of findings) if (f.fired) floor = worseBand(floor, f.forcedBand);
  return { floor, findings };
}

/**
 * Data-confidence flag — computed SEPARATELY from the band. Low confidence never
 * changes the verdict; it tells the surface to present the verdict cautiously.
 */
export function assessConfidence(params: {
  includedHolders: number;
  unclassifiedShareOfTotal: number;
  largestUnclassifiedShareOfTotal: number;
  /** AUDIT FIX TF-025 — largest holder removed on a low-confidence guess. */
  largestHeuristicExcludedShareOfTotal: number;
  tokenAgeSeconds: number | null | undefined;
  bundlesResolved: boolean;
  snipersResolved: boolean;
  cfg: ScoringConfig;
}): ConfidenceResult {
  const c = params.cfg.confidence;
  const reasons: string[] = [];
  let low = false;
  let medium = false;

  if (params.includedHolders > 0 && params.includedHolders < c.minHolders) {
    low = true;
    reasons.push(`Only ${params.includedHolders} holders after exclusions — too few for a stable distribution estimate.`);
  }
  if (params.includedHolders === 0) {
    low = true;
    reasons.push('No holders remained after exclusions — nothing to measure.');
  }
  // Label confidence is LEVERAGE-based: only a wallet large enough to flip the
  // read if mislabeled should floor confidence. A diffuse unlabeled base (many
  // similar wallets, none dominant) is the normal no-label-feed case and only
  // softens to medium.
  if (params.largestUnclassifiedShareOfTotal >= c.dominantUnclassifiedShareOfTotal) {
    low = true;
    reasons.push(
      `A single unlabeled wallet holds ${(params.largestUnclassifiedShareOfTotal * 100).toFixed(1)}% of supply — if it is a mislabeled pool/CEX it would invert this read.`,
    );
  } else if (params.largestUnclassifiedShareOfTotal >= c.singleUnclassifiedShareOfTotal) {
    medium = true;
    reasons.push(
      `A single unlabeled wallet holds ${(params.largestUnclassifiedShareOfTotal * 100).toFixed(1)}% of supply — it could be infra or a whale.`,
    );
  }
  // AUDIT FIX TF-025: the same leverage rule, applied to holders removed on a
  // GUESS. Every branch above reasons about wallets that were KEPT, so a large
  // holder excluded by the low-confidence `contract` heuristic was invisible
  // here and the read still came back High. The exclusion is the thing most
  // likely to be wrong — it is the only excluded category this codebase marks
  // `confidence: 'low'` — and it removes supply from the denominator every
  // other number is computed against. Same thresholds as the unlabeled-wallet
  // rule, because it is the same question: could ONE address, if we have it
  // wrong, invert this read?
  if (params.largestHeuristicExcludedShareOfTotal >= c.dominantUnclassifiedShareOfTotal) {
    low = true;
    reasons.push(
      `${(params.largestHeuristicExcludedShareOfTotal * 100).toFixed(1)}% of supply was set aside as a contract on a heuristic, not a label — if that guess is wrong this read inverts.`,
    );
  } else if (params.largestHeuristicExcludedShareOfTotal >= c.singleUnclassifiedShareOfTotal) {
    medium = true;
    reasons.push(
      `${(params.largestHeuristicExcludedShareOfTotal * 100).toFixed(1)}% of supply was set aside as a contract on a heuristic, not a label.`,
    );
  }
  if (params.unclassifiedShareOfTotal > c.maxUnclassifiedShareOfTotal) {
    medium = true;
    reasons.push(
      `${(params.unclassifiedShareOfTotal * 100).toFixed(1)}% of supply sits on unlabeled wallets — their nature is unresolved, though none dominates.`,
    );
  }
  if (params.tokenAgeSeconds != null && params.tokenAgeSeconds < c.minTokenAgeSeconds) {
    low = true;
    const days = (params.tokenAgeSeconds / 86400).toFixed(1);
    reasons.push(`Token is very fresh (~${days}d) — distribution is still forming.`);
  }
  if (!params.bundlesResolved) {
    medium = true;
    reasons.push('Bundle detection did not run — bundled-supply signal is a gap.');
  }
  if (!params.snipersResolved) {
    medium = true;
    reasons.push('Sniper detection did not run — sniper-held signal is a gap.');
  }

  const level = low ? 'low' : medium ? 'medium' : 'high';
  if (reasons.length === 0) reasons.push('Holder count, labels and freshness are all within confident ranges.');
  return { level, reasons };
}

/** Summarize each category's footprint for the "show the exclusions" panel. */
function buildExclusionSummary(classified: readonly ClassifiedHolder[]): ExclusionSummary {
  const buckets = new Map<HolderCategory, ExclusionBucket>();
  let totalExcluded = 0;
  for (const c of classified) {
    const cat = c.classification.category;
    const b = buckets.get(cat) ?? { category: cat, excluded: c.classification.excluded, count: 0, shareOfTotal: 0 };
    b.count += 1;
    b.shareOfTotal += c.shareOfTotal;
    buckets.set(cat, b);
    if (c.classification.excluded) totalExcluded += c.shareOfTotal;
  }
  return {
    buckets: [...buckets.values()].sort((a, b) => b.shareOfTotal - a.shareOfTotal),
    totalExcludedShareOfTotal: totalExcluded,
    unclassifiedShareOfTotal: unclassifiedShareOfTotal(classified),
  };
}

/** Plain-sentence lead line for the inverse-Simpson effective holder count. */
export function headlineSentence(metrics: DistributionMetrics): string {
  if (metrics.includedHolders === 0) {
    return 'Not enough holder data to estimate an effective holder count.';
  }
  const n = metrics.effectiveHolders;
  const rounded = n >= 10 ? Math.round(n) : Math.round(n * 10) / 10;
  return `Concentration is equivalent to about ${rounded} equally-sized holders controlling the person-held supply (inverse-Simpson over ${metrics.includedHolders} holders).`;
}

function bandReasonText(band: Band, softBand: Band, gate: GateResult): string {
  const gateHits = gate.findings.filter((f) => f.fired);
  if (gate.floor !== 'well-distributed' && BAND_RANK[gate.floor] >= BAND_RANK[softBand]) {
    return `Band floored at "${band}" by a hard fact: ${gateHits.map((f) => f.id).join(', ')}.`;
  }
  return `Band "${band}" from the weighted blend of soft distribution signals.`;
}

const CORRECTION_PATH =
  'Labels, cluster assignments and bundle/sniper flags are heuristic and point-in-time. If an address is mislabeled, submit a label correction so the classification can be revised and this measurement recomputed.';

const BASE_CAVEATS: readonly string[] = [
  'This is a descriptive measurement of on-chain distribution, not a verdict on intent or a safety guarantee.',
  'Address ≠ person: one entity can split across many wallets and one wallet can custody for many people (Gini especially).',
  'Facts are point-in-time as of the observed timestamp and can change block to block.',
];

/** Input to the top-level analysis. */
export interface DistributionInput {
  holders: readonly RawHolder[];
  chain?: ChainKind;
  /** Authoritative on-chain total supply. Defaults to the sum of holder balances. */
  totalSupply?: bigint;
  hardFacts?: HardFacts;
  launch?: LaunchFacts;
  labelSources?: readonly LabelSource[];
  config?: Partial<ScoringConfig>;
  /** Unix seconds for a deterministic timestamp. Defaults to now. */
  observedAt?: number;
}

/**
 * THE ENTRY POINT. Pure: classify → exclude → measure → gate → blend → band →
 * confidence, returning one JSON-safe descriptive-measurement object. No network,
 * no mutation of the input.
 */
export function analyzeDistribution(input: DistributionInput): DistributionAnalysis {
  const cfg = resolveConfig(input.config);
  const chain: ChainKind = input.chain ?? 'ethereum';
  const observedAt = input.observedAt ?? Math.floor(Date.now() / 1000);
  const launch = input.launch ?? {};
  const bundlesResolved = launch.bundlesResolved ?? false;
  const snipersResolved = launch.snipersResolved ?? false;

  const { totalSupply, classified, included } = classifyHolders({
    holders: input.holders,
    totalSupply: input.totalSupply ?? 0n,
    chain,
    labelSources: input.labelSources ?? [],
    unclassifiedThreshold: cfg.unclassifiedThreshold,
    // AUDIT FIX TF-024: the same line the hard top-1 gate uses. A heuristic
    // exclusion must not be able to remove a holder that would, if kept, trip
    // `top1-over-threshold` on its own.
    heuristicExclusionCap: cfg.gate.hardTop1Threshold,
  });

  const allHolders: RawHolder[] = classified.map((c) => c.holder);
  const includedSupply = sumBalances(included);

  const metrics = computeMetrics({
    included,
    allHolders,
    includedSupply,
    totalSupply,
    bundledTotalShareOfTotal: launch.bundledTotalSupplyShare ?? null,
    bundlesResolved,
    snipersResolved,
  });

  const gate = evaluateGate(metrics, input.hardFacts, cfg);
  const soft = blendSoftSignals(metrics, cfg);
  const band = worseBand(soft.band, gate.floor);

  const exclusions = buildExclusionSummary(classified);
  const confidence = assessConfidence({
    includedHolders: metrics.includedHolders,
    unclassifiedShareOfTotal: exclusions.unclassifiedShareOfTotal,
    largestUnclassifiedShareOfTotal: largestUnclassifiedShareOfTotal(classified),
    largestHeuristicExcludedShareOfTotal: largestHeuristicExcludedShareOfTotal(classified), // AUDIT FIX TF-025
    tokenAgeSeconds: launch.tokenAgeSeconds,
    bundlesResolved,
    snipersResolved,
    cfg,
  });

  const caveats = [...BASE_CAVEATS];
  if (chain === 'solana') {
    caveats.push('Solana: ATAs are resolved to their owner and off-curve (PDA) accounts are excluded; unresolved ATAs may skew grouping.');
  }
  if (metrics.bundledTotalShareOfTotal == null) {
    caveats.push('Bundled-at-launch total was not supplied — only currently-held bundle supply (if measured) is shown.');
  }

  return {
    method: {
      version: METHOD_VERSION,
      description:
        'Effective-holder (inverse-Simpson) lead with HHI, top-N, Nakamoto and (secondary) Gini over post-exclusion holders; behavioral cluster/bundle/sniper shares of total supply; 3-band verdict via a weakest-link hard-fact gate plus a weighted soft-signal blend, with a separate data-confidence flag.',
    },
    observedAt,
    chain,
    totalSupply: totalSupply.toString(),
    includedSupply: includedSupply.toString(),
    includedSupplyShareOfTotal: ratio(includedSupply, totalSupply),
    excludedSupplyShareOfTotal: exclusions.totalExcludedShareOfTotal,
    holderCounts: {
      total: classified.length,
      included: included.length,
      excluded: classified.length - included.length,
      unclassified: classified.filter((c) => c.classification.category === 'unclassified').length,
    },
    exclusions,
    metrics,
    band,
    bandReason: bandReasonText(band, soft.band, gate),
    gate,
    soft,
    confidence,
    headline: headlineSentence(metrics),
    caveats,
    correctionPath: CORRECTION_PATH,
  };
}
