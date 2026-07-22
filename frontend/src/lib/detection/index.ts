// Token-distribution detection core — public barrel.
//
// Import from here for the stable surface; the split files (types / metrics /
// exclusions / score) remain importable directly for tree-shaking or testing.
//
//   import { analyzeDistribution } from '@/lib/detection';
//   const result = analyzeDistribution({ holders, chain: 'ethereum', ... });
//
// This layer is PURE — it takes a normalized holder array (plus optional
// out-of-band facts an adapter fetched) and returns a JSON-safe result object.
// Data adapters (Alchemy / solrpc / GeckoTerminal / Etherscan reads) live per
// surface and feed `RawHolder[]` + `HardFacts` + `LaunchFacts` into this core.

export { analyzeDistribution, DEFAULT_CONFIG } from './score';
export type { DistributionInput } from './score';
export {
  resolveConfig,
  ramp,
  worseBand,
  blendSoftSignals,
  evaluateGate,
  assessConfidence,
  headlineSentence,
} from './score';

export {
  ratio,
  sumBalances,
  computeHHI,
  effectiveHolders,
  topNShare,
  topNShares,
  nakamotoCoefficient,
  giniCoefficient,
  computeMetrics,
  includedSharesDesc,
  clusterStats,
  bundledCurrentHeldShare,
  sniperHeldShare,
  unclassifiedShareOfTotal,
  largestUnclassifiedShareOfTotal,
} from './metrics';

export {
  BURN_ADDRESSES,
  isBurnAddress,
  normalizeHolders,
  classifyAddress,
  classifyHolders,
} from './exclusions';

export { EXCLUDED_CATEGORIES, BAND_RANK, METHOD_VERSION } from './types';
export type {
  ChainKind,
  HolderCategory,
  RawHolder,
  Classification,
  ClassifiedHolder,
  LabelSource,
  LabelContext,
  HardFacts,
  LaunchFacts,
  Band,
  TopNShares,
  DistributionMetrics,
  GateFinding,
  GateResult,
  ConfidenceLevel,
  ConfidenceResult,
  ExclusionBucket,
  ExclusionSummary,
  SoftSignal,
  SoftBlend,
  ScoringConfig,
  DistributionAnalysis,
} from './types';
