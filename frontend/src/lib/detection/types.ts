// Token-distribution detection core — SHARED TYPE HUB.
//
// HONEST-FRAMING CONTRACT (see project memory / LAUNCHER_STRATEGY §8):
// This layer produces a DESCRIPTIVE MEASUREMENT of how a token's supply is
// distributed among real holders — never a fraud verdict or accusation. It
// discloses its method, its components, and every address it excluded, and it
// carries a separate data-confidence flag so a low-signal read is never dressed
// up as a strong one. Nothing here fabricates a number: a missing signal is
// `null` and is dropped from the blend, never defaulted to a flattering value.
//
// PURITY: this whole layer is pure. It takes a normalized holder array (plus
// optional out-of-band facts an adapter already fetched) and returns a plain
// result object. It performs NO network I/O, no clock reads except an optional
// `observedAt` the caller may pass for deterministic timestamps.

/** Chains the core knows structural exclusion rules for. */
export type ChainKind = 'ethereum' | 'solana';

/**
 * Classification of a holding address. Categories in `EXCLUDED_CATEGORIES` are
 * removed BEFORE any concentration math (they are not "people holding the
 * token"). `eoa` and `unclassified` are KEPT — `unclassified` is a large,
 * unlabeled wallet that we decline to assume is hostile; it merely lowers
 * data-confidence.
 */
export type HolderCategory =
  | 'eoa' // externally-owned wallet — a real holder, counted
  | 'unclassified' // large, unlabeled address — counted, but lowers confidence
  | 'lp' // AMM / liquidity-pool contract — excluded
  | 'cex' // centralized-exchange (custodial, many users) wallet — excluded
  | 'bridge' // cross-chain bridge — excluded
  | 'burn' // burn / dead / incinerator address — excluded
  | 'locker' // lock / vesting / treasury contract — excluded
  | 'contract' // plain smart contract (has code, no better label) — excluded
  | 'pda'; // Solana program-derived address (off-curve) — excluded

/** Categories that are removed from the holder set before concentration math. */
export const EXCLUDED_CATEGORIES: ReadonlySet<HolderCategory> = new Set<HolderCategory>([
  'lp',
  'cex',
  'bridge',
  'burn',
  'locker',
  'contract',
  'pda',
]);

/** One raw holder as an adapter normalizes it before handing off to the core. */
export interface RawHolder {
  /** EVM address (0x…, any case) or Solana base58. Used only as a grouping key. */
  address: string;
  /** Raw token balance in base units. Decimals cancel in every ratio, so no scaling is needed. */
  balance: bigint;
  /**
   * Solana only: the wallet that OWNS this token account (ATA). When present,
   * balances are grouped by owner so a single wallet's many ATAs count once.
   */
  ownerAddress?: string | null;
  /** Solana only: this address is off the ed25519 curve (a PDA). Excluded. */
  offCurve?: boolean;
  /** EVM only: this address has contract code. Absent a better label → `contract`. */
  isContract?: boolean;
  /** Explicit category from an adapter / label feed. Highest-priority signal. */
  label?: HolderCategory | null;
  /** Coordinated-cluster id (e.g. shared funder). Same id ⇒ same behavioral cluster. */
  clusterId?: string | null;
  /** This address received supply in a launch bundle. */
  bundled?: boolean;
  /**
   * Portion of `balance` attributable to bundle-acquired supply. If omitted and
   * `bundled` is true, the whole `balance` is treated as still-held bundle supply
   * (an UPPER bound — the address may have bought more since; disclosed as such).
   */
  bundledBalance?: bigint;
  /** This address bought inside the launch sniper window (first N blocks/slots). */
  sniper?: boolean;
}

/** Result of classifying a single address. */
export interface Classification {
  category: HolderCategory;
  /** True iff `category` is in `EXCLUDED_CATEGORIES`. */
  excluded: boolean;
  /** `high` = known registry / structural flag; `low` = heuristic / default. */
  confidence: 'high' | 'low';
  /** Where the category came from — for the audit trail / correction path. */
  source: 'input-label' | 'label-source' | 'registry' | 'structural' | 'heuristic' | 'default';
  /** Plain-language, factual reason. */
  reason: string;
}

/** A holder paired with its classification and its share of total supply. */
export interface ClassifiedHolder {
  holder: RawHolder;
  classification: Classification;
  /** `holder.balance` as a fraction of total supply (0..1). */
  shareOfTotal: number;
}

/**
 * Pluggable label source. Adapters register these to fold in Etherscan tags,
 * on-chain code checks, static allow-lists, etc. The core ships only a tiny
 * built-in registry (burn addresses); everything richer plugs in here later.
 * Return `null` when the source has no opinion.
 */
export interface LabelSource {
  name: string;
  classify(address: string, ctx: LabelContext): HolderCategory | null;
}

/** Context handed to a `LabelSource` so it can reason about scale / chain. */
export interface LabelContext {
  chain: ChainKind;
  /** This address's share of total supply (0..1). */
  shareOfTotal: number;
  /** Whether the address has contract code (EVM) if the adapter knows. */
  isContract?: boolean;
}

/**
 * Out-of-band HARD facts an adapter fetched separately (authorities, LP lock).
 * These drive the weakest-link gate. `null`/absent means "unknown" and NEVER
 * fires a gate — unknown is not a red flag.
 */
export interface HardFacts {
  /** Mint authority still live (Solana) or an owner can still mint (EVM). */
  mintAuthorityLive?: boolean | null;
  /** Freeze authority still live (Solana) or transfers are pausable/freezable (EVM). */
  freezeAuthorityLive?: boolean | null;
  /** LP is not locked, or its lock has already elapsed. */
  lpUnlocked?: boolean | null;
}

/** Launch-time facts current balances cannot reconstruct on their own. */
export interface LaunchFacts {
  /** Token age in seconds. Below the freshness floor ⇒ lower confidence. */
  tokenAgeSeconds?: number | null;
  /**
   * Fraction of supply bundled AT LAUNCH (0..1), including since-sold. Cannot be
   * derived from current holders, so an adapter supplies it. `null` = unknown
   * (reported as a gap, never as 0).
   */
  bundledTotalSupplyShare?: number | null;
  /** True iff bundle detection actually ran (distinguishes "0%" from "not measured"). */
  bundlesResolved?: boolean;
  /** True iff sniper detection actually ran. */
  snipersResolved?: boolean;
}

/** The three-band descriptive verdict. Ordered worst-last by `BAND_RANK`. */
export type Band = 'well-distributed' | 'mixed' | 'concentrated';

/** Severity rank so bands can be compared (`worseBand`). Higher = worse. */
export const BAND_RANK: Record<Band, number> = {
  'well-distributed': 0,
  mixed: 1,
  concentrated: 2,
};

/** Top-N concentration shares (of person-held supply). Keys are N. */
export interface TopNShares {
  top1: number;
  top5: number;
  top10: number;
  top20: number;
  top50: number;
}

/**
 * Every distribution metric, computed over the INCLUDED (person-held) supply
 * unless a field name says `OfTotal`. Concentration metrics (hhi, effective
 * holders, topN, nakamoto, gini) share ONE normalized share vector so they are
 * mutually consistent. Behavioral shares (clustered/bundled/sniper) are `OfTotal`
 * because they are "% of supply" claims.
 */
export interface DistributionMetrics {
  /** Count of holders remaining after exclusion. */
  includedHolders: number;
  /** Herfindahl-Hirschman Index — Σ(share²) over included holders (0..1). */
  hhi: number;
  /** LEAD METRIC: effective holder count = 1 / HHI (inverse-Simpson). */
  effectiveHolders: number;
  /** Top-N shares of person-held supply. */
  topN: TopNShares;
  /** Largest single holder as a share of TOTAL supply (gate input). */
  top1ShareOfTotal: number;
  /** Nakamoto coefficient: fewest holders whose combined share exceeds 50%. */
  nakamotoCoefficient: number;
  /**
   * Gini coefficient (0..1). SECONDARY — reported with the "address ≠ person"
   * caveat and never headlined; wallets are not people.
   */
  gini: number;
  /** Largest coordinated cluster as a share of TOTAL supply, or `null` if no cluster data. */
  clusteredSupplyShareOfTotal: number | null;
  /** Number of distinct clusters observed among included holders. */
  clusterCount: number;
  /** Supply bundled at launch as a share of total, or `null` if not measured. */
  bundledTotalShareOfTotal: number | null;
  /** Bundle-acquired supply STILL held now, as a share of total, or `null` if not measured. */
  bundledCurrentHeldShareOfTotal: number | null;
  /** Sniper-held supply as a share of total, or `null` if not measured. */
  sniperHeldShareOfTotal: number | null;
}

/** One fired/observed hard-fact gate finding. */
export interface GateFinding {
  id: string;
  fired: boolean;
  /** Band this finding forces as a FLOOR when fired. */
  forcedBand: Band;
  detail: string;
}

/** Weakest-link gate outcome: a band FLOOR (minimum badness) + the findings. */
export interface GateResult {
  /** Worst `forcedBand` among fired findings; `well-distributed` if none fired. */
  floor: Band;
  findings: GateFinding[];
}

export type ConfidenceLevel = 'high' | 'medium' | 'low';

/** Data-confidence flag — SEPARATE from the band, never folded into it. */
export interface ConfidenceResult {
  level: ConfidenceLevel;
  reasons: string[];
}

/** One category's footprint (for "show the exclusions"). */
export interface ExclusionBucket {
  category: HolderCategory;
  excluded: boolean;
  count: number;
  shareOfTotal: number;
}

export interface ExclusionSummary {
  buckets: ExclusionBucket[];
  totalExcludedShareOfTotal: number;
  /** Share of TOTAL supply held by `unclassified` (unlabeled large) wallets. */
  unclassifiedShareOfTotal: number;
}

/** Per-signal risk contribution (0 = well distributed, 1 = concentrated). */
export interface SoftSignal {
  id: string;
  /** Raw metric value that produced the risk. `null` when the signal is absent. */
  value: number | null;
  /** 0..1 risk, or `null` when unavailable (dropped from the blend). */
  risk: number | null;
  weight: number;
}

export interface SoftBlend {
  /** Weighted mean risk over AVAILABLE signals (0..1), renormalized. */
  risk: number;
  /** Band implied by `risk` alone, before the gate floor is applied. */
  band: Band;
  signals: SoftSignal[];
}

/** Tunable scoring configuration. All fields have battle-tested defaults. */
export interface ScoringConfig {
  /** Blend weights per soft signal. Renormalized over whichever are available. */
  weights: {
    effectiveHolders: number;
    top1: number;
    top10: number;
    nakamoto: number;
    gini: number;
    clustered: number;
    bundledHeld: number;
    sniper: number;
  };
  /** Risk ramps: [atGood, atBad]. `atGood` may exceed `atBad` for "higher is better". */
  ramps: {
    effectiveHolders: [number, number];
    top1: [number, number];
    top10: [number, number];
    nakamoto: [number, number];
    gini: [number, number];
    clustered: [number, number];
    bundledHeld: [number, number];
    sniper: [number, number];
  };
  /** Blended-risk cutoffs: risk ≤ wellMax ⇒ well; ≤ mixedMax ⇒ mixed; else concentrated. */
  bands: { wellMax: number; mixedMax: number };
  gate: {
    /** Top-1 cluster share of TOTAL at/above which the band floor is forced. */
    hardClusterThreshold: number;
    /** Single holder share of TOTAL at/above which the band floor is forced. */
    hardTop1Threshold: number;
    mintLiveFloor: Band;
    freezeLiveFloor: Band;
    lpUnlockedFloor: Band;
    clusterFloor: Band;
    top1Floor: Band;
  };
  confidence: {
    /** Below this many included holders ⇒ low confidence. */
    minHolders: number;
    /**
     * Above this DIFFUSE unclassified share of total ⇒ MEDIUM confidence. A broad
     * base of unlabeled wallets (the normal EVM case without a label feed) is not
     * itself a red flag — no single wallet has leverage to flip the read — so it
     * only softens, never floors, confidence.
     */
    maxUnclassifiedShareOfTotal: number;
    /** Below this token age (seconds) ⇒ "very fresh" ⇒ low confidence. */
    minTokenAgeSeconds: number;
    /** At/above this share of total held by any ONE unclassified wallet ⇒ MEDIUM confidence. */
    singleUnclassifiedShareOfTotal: number;
    /**
     * At/above this share of total held by any ONE unclassified wallet ⇒ LOW
     * confidence: a dominant opaque wallet could be a mislabeled pool/CEX that
     * would invert the whole measurement, so the read genuinely can't be trusted.
     */
    dominantUnclassifiedShareOfTotal: number;
  };
  /**
   * Share-of-total at/above which an UNLABELED, non-excluded address is marked
   * `unclassified` (kept, but lowers confidence) rather than a plain `eoa`.
   */
  unclassifiedThreshold: number;
}

/** The full descriptive measurement returned by `analyzeDistribution`. */
export interface DistributionAnalysis {
  method: { version: string; description: string };
  /** Unix seconds when this snapshot was measured. Facts are point-in-time. */
  observedAt: number;
  chain: ChainKind;
  /** Stringified bigints (JSON-safe). */
  totalSupply: string;
  includedSupply: string;
  includedSupplyShareOfTotal: number;
  excludedSupplyShareOfTotal: number;
  holderCounts: { total: number; included: number; excluded: number; unclassified: number };
  exclusions: ExclusionSummary;
  metrics: DistributionMetrics;
  /** Final band = worse of (soft band, gate floor). */
  band: Band;
  bandReason: string;
  gate: GateResult;
  soft: SoftBlend;
  confidence: ConfidenceResult;
  /** Plain-sentence lead (inverse-Simpson), self-gating to unknown when data is thin. */
  headline: string;
  /** Neutral, factual caveats always shown alongside the result. */
  caveats: string[];
  /** How to dispute a label / cluster — the disclosed correction path. */
  correctionPath: string;
}

export const METHOD_VERSION = 'detection-core/1.0.0';
