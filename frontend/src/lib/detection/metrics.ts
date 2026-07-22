// Distribution metrics — PURE MATH over a normalized holder list.
//
// No network, no clock, no side effects. Every function is deterministic and
// scale-free where the underlying statistic is. Share math is done through
// `ratio()` (fixed-point) so 18-decimal bigint balances never lose precision by
// being cast to `number` above 2^53.

import type { ClassifiedHolder, DistributionMetrics, RawHolder, TopNShares } from './types';

/** 1e12 fixed-point scale for bigint → fractional-number conversion. */
const RATIO_SCALE = 1_000_000_000_000n;

/**
 * `part / whole` as a fraction in [0,1] with ~1e-12 precision, computed in
 * bigint to avoid the precision loss of `Number(hugeBigint)`. Returns 0 when
 * `whole <= 0`.
 */
export function ratio(part: bigint, whole: bigint): number {
  if (whole <= 0n || part <= 0n) return 0;
  if (part >= whole) return 1;
  return Number((part * RATIO_SCALE) / whole) / 1e12;
}

/** Sum a list of bigints. */
export function sumBalances(holders: readonly RawHolder[]): bigint {
  let total = 0n;
  for (const h of holders) total += h.balance > 0n ? h.balance : 0n;
  return total;
}

/**
 * Herfindahl-Hirschman Index: Σ(sᵢ²) over shares that sum to 1. A single holder
 * ⇒ 1; N equal holders ⇒ 1/N. Returns 0 for an empty share vector.
 */
export function computeHHI(shares: readonly number[]): number {
  let hhi = 0;
  for (const s of shares) hhi += s * s;
  return hhi;
}

/**
 * Effective holder count = 1 / HHI (inverse-Simpson / "effective number of
 * parties"). The number of equally-sized holders that would produce the same
 * concentration. Returns 0 when HHI is 0 (no holders).
 */
export function effectiveHolders(hhi: number): number {
  if (hhi <= 0) return 0;
  return 1 / hhi;
}

/** Sum of the top `n` shares from a DESCENDING-sorted share vector. */
export function topNShare(sharesDesc: readonly number[], n: number): number {
  let acc = 0;
  const limit = Math.min(n, sharesDesc.length);
  for (let i = 0; i < limit; i++) acc += sharesDesc[i] ?? 0;
  return acc;
}

/**
 * Nakamoto coefficient: the FEWEST top holders whose combined share strictly
 * exceeds `threshold` (default 0.5). Over shares that sum to 1 this is always
 * reachable. Returns 0 for an empty vector.
 */
export function nakamotoCoefficient(sharesDesc: readonly number[], threshold = 0.5): number {
  let acc = 0;
  for (let i = 0; i < sharesDesc.length; i++) {
    acc += sharesDesc[i] ?? 0;
    if (acc > threshold) return i + 1;
  }
  return sharesDesc.length;
}

/**
 * Gini coefficient (0 = perfect equality, →1 = perfect inequality) via the
 * rank formula G = Σ(2i − n − 1)·xᵢ / (n · Σxᵢ) with xᵢ ASCENDING, 1-based i.
 * Scale-invariant, so shares or balances give the same result. n ≤ 1 ⇒ 0.
 *
 * CAVEAT (address ≠ person): on-chain Gini measures inequality across ADDRESSES,
 * not people. One entity can split across many addresses (deflating Gini) or one
 * custodial address can hold for thousands (inflating it). Secondary signal only.
 */
export function giniCoefficient(values: readonly number[]): number {
  const xs = values.filter((v) => v > 0).sort((a, b) => a - b);
  const n = xs.length;
  if (n <= 1) return 0;
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i] ?? 0;
    weighted += (2 * (i + 1) - n - 1) * x;
    total += x;
  }
  if (total <= 0) return 0;
  return weighted / (n * total);
}

/** Descending share vector of the INCLUDED holders over person-held supply. */
export function includedSharesDesc(included: readonly RawHolder[], includedSupply: bigint): number[] {
  return included
    .map((h) => ratio(h.balance, includedSupply))
    .sort((a, b) => b - a);
}

/** Build the top-N bundle (of person-held supply) from a descending share vector. */
export function topNShares(sharesDesc: readonly number[]): TopNShares {
  return {
    top1: topNShare(sharesDesc, 1),
    top5: topNShare(sharesDesc, 5),
    top10: topNShare(sharesDesc, 10),
    top20: topNShare(sharesDesc, 20),
    top50: topNShare(sharesDesc, 50),
  };
}

/**
 * Largest coordinated cluster and cluster count among INCLUDED holders, as a
 * share of TOTAL supply. Returns `{ largest: null }` when no holder carries a
 * `clusterId` (no cluster data available — reported as a gap, not as 0).
 */
export function clusterStats(
  included: readonly RawHolder[],
  totalSupply: bigint,
): { largestShareOfTotal: number | null; clusterCount: number } {
  const byCluster = new Map<string, bigint>();
  let anyCluster = false;
  for (const h of included) {
    if (h.clusterId == null || h.clusterId === '') continue;
    anyCluster = true;
    byCluster.set(h.clusterId, (byCluster.get(h.clusterId) ?? 0n) + (h.balance > 0n ? h.balance : 0n));
  }
  if (!anyCluster) return { largestShareOfTotal: null, clusterCount: 0 };
  let largest = 0n;
  for (const bal of byCluster.values()) if (bal > largest) largest = bal;
  return { largestShareOfTotal: ratio(largest, totalSupply), clusterCount: byCluster.size };
}

/**
 * Bundle-acquired supply that is STILL held now, as a share of TOTAL. Uses each
 * holder's `bundledBalance` when supplied, otherwise the full `balance` of a
 * `bundled` address (an upper bound). Returns `null` when detection did not run.
 */
export function bundledCurrentHeldShare(
  holders: readonly RawHolder[],
  totalSupply: bigint,
  resolved: boolean,
): number | null {
  if (!resolved) return null;
  let held = 0n;
  for (const h of holders) {
    if (!h.bundled) continue;
    const attributable = h.bundledBalance ?? (h.balance > 0n ? h.balance : 0n);
    held += attributable > 0n ? attributable : 0n;
  }
  return ratio(held, totalSupply);
}

/**
 * Sniper-held supply as a share of TOTAL. Returns `null` when sniper detection
 * did not run (distinguishes a measured 0% from "not measured").
 */
export function sniperHeldShare(
  holders: readonly RawHolder[],
  totalSupply: bigint,
  resolved: boolean,
): number | null {
  if (!resolved) return null;
  let held = 0n;
  for (const h of holders) {
    if (!h.sniper) continue;
    held += h.balance > 0n ? h.balance : 0n;
  }
  return ratio(held, totalSupply);
}

/**
 * Assemble every metric from the classified holder set. `included` are the
 * post-exclusion holders; `allHolders` is every holder (bundled/sniper supply
 * can sit on addresses that were themselves excluded, so those two shares scan
 * the full set). Concentration metrics use the included share vector so they are
 * mutually consistent (same denominator as HHI / effectiveHolders).
 */
export function computeMetrics(params: {
  included: readonly RawHolder[];
  allHolders: readonly RawHolder[];
  includedSupply: bigint;
  totalSupply: bigint;
  bundledTotalShareOfTotal: number | null;
  bundlesResolved: boolean;
  snipersResolved: boolean;
}): DistributionMetrics {
  const { included, allHolders, includedSupply, totalSupply } = params;
  const sharesDesc = includedSharesDesc(included, includedSupply);
  const hhi = computeHHI(sharesDesc);
  const cluster = clusterStats(included, totalSupply);
  return {
    includedHolders: included.length,
    hhi,
    effectiveHolders: effectiveHolders(hhi),
    topN: topNShares(sharesDesc),
    top1ShareOfTotal: ratio(largestBalance(included), totalSupply),
    nakamotoCoefficient: nakamotoCoefficient(sharesDesc, 0.5),
    gini: giniCoefficient(sharesDesc),
    clusteredSupplyShareOfTotal: cluster.largestShareOfTotal,
    clusterCount: cluster.clusterCount,
    bundledTotalShareOfTotal: params.bundledTotalShareOfTotal,
    bundledCurrentHeldShareOfTotal: bundledCurrentHeldShare(allHolders, totalSupply, params.bundlesResolved),
    sniperHeldShareOfTotal: sniperHeldShare(allHolders, totalSupply, params.snipersResolved),
  };
}

/** Largest single balance in a holder list (0n when empty). */
function largestBalance(holders: readonly RawHolder[]): bigint {
  let largest = 0n;
  for (const h of holders) if (h.balance > largest) largest = h.balance;
  return largest;
}

/** Share of total supply held by the `unclassified` (unlabeled large) bucket. */
export function unclassifiedShareOfTotal(classified: readonly ClassifiedHolder[]): number {
  let sum = 0;
  for (const c of classified) if (c.classification.category === 'unclassified') sum += c.shareOfTotal;
  return sum;
}

/** Largest single share of total held by any one `unclassified` wallet. */
export function largestUnclassifiedShareOfTotal(classified: readonly ClassifiedHolder[]): number {
  let largest = 0;
  for (const c of classified) {
    if (c.classification.category === 'unclassified' && c.shareOfTotal > largest) largest = c.shareOfTotal;
  }
  return largest;
}
