// Wallet-exposure adapter — the seam between a connected wallet's holdings and
// the shared token-distribution detection core.
//
// HONEST-FRAMING CONTRACT (same as the detection core it wraps):
// This layer produces a DESCRIPTIVE MEASUREMENT of how exposed a wallet is to
// concentration / bundle / rug risk in the tokens it holds — never a verdict on
// intent. It NEVER fabricates a score: a token whose holder distribution we
// cannot fetch is reported as `unmeasured` (an honest gap), never defaulted to a
// flattering "well-distributed". Every measured read carries the core's method,
// components, exclusions, timestamp and correction path.
//
// PURITY: this module is pure. It does no network I/O of its own — the wallet
// hook fetches balances (wagmi multicall) and, when a token scanner adapter is
// available, hands its `DistributionAnalysis` here to be summarised. When the
// scanner is absent (the current default — no ERC-20 holder-list source is
// deployed yet), `deriveHoldingExposure(null, …)` self-gates to `unmeasured`.
//
// WHY A SCANNER SEAM: the detection core needs a token's HOLDER DISTRIBUTION
// (RawHolder[]) to compute concentration. Arbitrary ERC-20 holder lists are not
// fetchable with the currently-wired data sources (no Ponder index, no holder
// list API). `ScanTokenFn` is the injection point a token-scanner adapter
// satisfies; until one exists, exposure stays honestly `unmeasured` and this
// file's shape does not change when it lands.

import { analyzeDistribution } from './index';
import type {
  Band,
  ChainKind,
  ConfidenceLevel,
  DistributionAnalysis,
  HardFacts,
  LaunchFacts,
  RawHolder,
} from './index';

/** 1e12 fixed-point scale — mirrors the detection core's `ratio()` precision. */
const SHARE_SCALE = 1_000_000_000_000n;

/** One ERC-20 position a wallet holds, as the hook normalises it. */
export interface WalletHolding {
  /** Token contract address (as provided; compared case-insensitively). */
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  /** Raw wallet balance in base units. */
  balance: bigint;
  /** Human-readable balance (decimals applied), for display only. */
  balanceFormatted: string;
  /** Authoritative on-chain total supply, or `null` when it could not be read. */
  totalSupply: bigint | null;
  /**
   * The wallet's OWN balance as a share of total supply (0..1), or `null` when
   * total supply is unknown. This is a real, self-contained figure — it needs no
   * holder list — so it is shown even while distribution scoring is unmeasured.
   */
  positionShareOfTotal: number | null;
  logoURI?: string;
  /** True when the token came from the built-in curated list vs. a pasted address. */
  curated: boolean;
}

export type ExposureStatus = 'measured' | 'unmeasured';

/** Per-holding exposure read — a thin, display-ready projection of the core. */
export interface HoldingExposure {
  status: ExposureStatus;
  /** The full core result when measured; `null` otherwise. Kept for drill-down. */
  analysis: DistributionAnalysis | null;
  /** 3-band verdict, or `null` when unmeasured. Never invented. */
  band: Band | null;
  /** Inverse-Simpson lead sentence, or `null` when unmeasured. */
  headline: string | null;
  /** Data-confidence flag from the core, or `null` when unmeasured. */
  confidence: ConfidenceLevel | null;
  /** Plain-language reason shown when `unmeasured` (the honest gap). Empty when measured. */
  reason: string;
  /** Unix seconds this read reflects — facts are point-in-time. */
  observedAt: number;
}

/**
 * Token-scanner injection point. A scanner adapter resolves a token address to a
 * `DistributionAnalysis` (fetching its holder list + hard facts, then calling the
 * detection core). Returns `null` when it cannot resolve the token — which this
 * module surfaces as an honest `unmeasured`, never as a passing score.
 */
export type ScanTokenFn = (
  token: { address: string; chain: ChainKind; totalSupply?: bigint | null },
  signal?: AbortSignal,
) => Promise<DistributionAnalysis | null>;

// No forward-looking promise in here. This one string is reached by three paths
// the code cannot tell apart — a scan that threw (transient), a scanner that
// resolved `null` because its source does not cover the token (not transient),
// and the no-scanner default (nothing to retry at all). Nothing re-runs the scan
// either: the hook's effect is keyed on the holding SET (see useWalletExposure),
// so a failed read stays failed until the holdings change. Copy that says
// otherwise is a claim the code does not honour. See useWalletExposure.test.ts,
// which pins that no-retry behaviour alongside this wording.
export const UNMEASURED_REASON =
  'Concentration, bundle and sniper scoring needs this token’s holder distribution, which could not be read (the holder source was unavailable, rate-limited, or does not cover this token). Your position size below is exact; the distribution read is not available for this token right now.';

const NO_HOLDERS_REASON =
  'No holders remained to measure after structural exclusions (pools, CEX, bridges, burns, contracts) — not enough real-holder data for a distribution read.';

/**
 * The wallet's own balance as a share of total supply (0..1). Returns `null`
 * when total supply is unknown so a missing supply never reads as "0% exposure".
 * Computed in bigint (1e12 fixed point) to avoid Number() precision loss on
 * 18-decimal balances.
 */
export function positionShareOfTotal(balance: bigint, totalSupply: bigint | null): number | null {
  if (totalSupply == null || totalSupply <= 0n) return null;
  if (balance <= 0n) return 0;
  if (balance >= totalSupply) return 1;
  return Number((balance * SHARE_SCALE) / totalSupply) / 1e12;
}

/**
 * Run the shared detection core over a token's holder set. A thin pass-through so
 * callers that already have `RawHolder[]` (a scanner, a test, TOWELI's own known
 * holders) get a `DistributionAnalysis` WITHOUT reimplementing any metric here.
 */
export function analyzeHolding(input: {
  holders: readonly RawHolder[];
  totalSupply?: bigint;
  chain?: ChainKind;
  hardFacts?: HardFacts;
  launch?: LaunchFacts;
  observedAt?: number;
}): DistributionAnalysis {
  return analyzeDistribution({
    holders: input.holders,
    totalSupply: input.totalSupply,
    chain: input.chain ?? 'ethereum',
    hardFacts: input.hardFacts,
    launch: input.launch,
    observedAt: input.observedAt,
  });
}

/**
 * Project a core `DistributionAnalysis` (or its absence) into a display-ready
 * `HoldingExposure`. The single honest-framing gate lives here:
 *  - `analysis == null`         ⇒ `unmeasured` (scanner had no data).
 *  - `includedHolders === 0`    ⇒ `unmeasured` (a band over zero real holders is
 *                                 not a measurement — never show a fabricated
 *                                 "well-distributed" from an empty set).
 *  - otherwise                  ⇒ `measured`, carrying the core's band verbatim.
 */
export function deriveHoldingExposure(
  analysis: DistributionAnalysis | null,
  opts?: { reason?: string; observedAt?: number },
): HoldingExposure {
  const observedAt = analysis?.observedAt ?? opts?.observedAt ?? Math.floor(Date.now() / 1000);

  if (!analysis) {
    return {
      status: 'unmeasured',
      analysis: null,
      band: null,
      headline: null,
      confidence: null,
      reason: opts?.reason ?? UNMEASURED_REASON,
      observedAt,
    };
  }

  if (analysis.metrics.includedHolders === 0) {
    return {
      status: 'unmeasured',
      analysis,
      band: null,
      headline: analysis.headline,
      confidence: analysis.confidence.level,
      reason: NO_HOLDERS_REASON,
      observedAt,
    };
  }

  return {
    status: 'measured',
    analysis,
    band: analysis.band,
    headline: analysis.headline,
    confidence: analysis.confidence.level,
    reason: '',
    observedAt,
  };
}

/** Human labels + neutral, descriptive (non-accusatory) tone for each band. */
export const BAND_LABEL: Record<Band, string> = {
  'well-distributed': 'Well-distributed',
  mixed: 'Mixed',
  concentrated: 'Concentrated',
};

/**
 * Portfolio-level roll-up of a set of exposures — how many measured, and the
 * WORST band observed among measured holdings. Never counts `unmeasured` toward
 * a verdict (an unknown is not a risk). Returns `worstBand: null` when nothing
 * was measurable, so the UI shows an honest "pending" summary, not a fake "safe".
 */
export function summarizeExposures(exposures: readonly HoldingExposure[]): {
  measured: number;
  unmeasured: number;
  worstBand: Band | null;
} {
  const rank: Record<Band, number> = { 'well-distributed': 0, mixed: 1, concentrated: 2 };
  let measured = 0;
  let unmeasured = 0;
  let worst: Band | null = null;
  for (const e of exposures) {
    if (e.status === 'measured' && e.band) {
      measured += 1;
      if (worst == null || rank[e.band] > rank[worst]) worst = e.band;
    } else {
      unmeasured += 1;
    }
  }
  return { measured, unmeasured, worstBand: worst };
}

/** Etherscan token holders tab — the self-serve fallback shown for unmeasured tokens. */
export function etherscanHoldersUrl(tokenAddress: string): string {
  return `https://etherscan.io/token/${tokenAddress}#balances`;
}
