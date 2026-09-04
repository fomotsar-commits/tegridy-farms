// Deployer Reputation core — a DESCRIPTIVE read of what became of the tokens an
// address deployed. Pairs a discovered launch list (deployerLaunches.ts) with a
// CURRENT market read (from the launcher-outcomes enrichment path) and projects
// each into a neutral, non-accusatory status.
//
// HONEST-FRAMING CONTRACT (same as the detection core it lives beside):
// This is a MEASUREMENT of current on-chain state, never a fraud verdict. It never
// labels a token "rugged" or a person a scammer. Absence of a live pool is reported
// as "no live market found" — a factual current-state observation — with an explicit
// note that it is NOT evidence of a rug. Nothing here fabricates a number: a market
// we could not read is `unobserved`, never defaulted to a flattering (or a damning)
// value. The method, its components, the timestamp and a correction path travel with
// every result.
//
// WHY IT CANNOT SAY "survived / dumped / rugged" OUTRIGHT (the disclosed gap):
//   - No launch-time baseline. The wired data sources return CURRENT price/liquidity
//     but not price/liquidity AT graduation, so a per-token price return or a
//     liquidity-drain % (the signals behind "dumped"/"rugged") cannot be computed.
//   - No event index. Only tokens this address created DIRECTLY (its own
//     contract-creation transactions) are visible; factory-launched tokens are
//     created by the factory, not this address, and need a deployed indexer to map
//     back — see `blockers`. So this is a floor on activity, not a full track record.
//   - Holder counts are Etherscan-Pro-gated → read as unavailable, never as zero.
//
// PURITY: this module is pure. It performs no network I/O and reads no clock except
// an `observedAt` the caller passes for deterministic timestamps.

import { METHOD_VERSION, type ConfidenceLevel } from './index';

/**
 * Per-token current-state status. Deliberately NOT "survived/dumped/rugged":
 *  - active-market  → a live trading pool with non-trivial liquidity right now.
 *  - thin-market    → a live pool, but liquidity below the floor (fragile / faded).
 *  - no-market      → no live pool found now. NOT a rug verdict (see file header).
 *  - unobserved     → current market could not be read (upstream unavailable).
 */
export type LaunchStatus = 'active-market' | 'thin-market' | 'no-market' | 'unobserved';

/** A current market read for one token, as the enrichment path returned it. */
export interface MarketRead {
  /**
   * True iff a live pool's price+liquidity were actually observed
   * (OutcomeRecord.marketObserved). False = created contract with no discoverable
   * live pool — which is a factual state, not an accusation.
   */
  observed: boolean;
  /** Current pooled liquidity in ETH (0 when unobserved). */
  liquidityEth: number;
  /** Current token price in ETH (0 when unobserved). */
  priceEth: number;
}

/** One launched token handed to the classifier. */
export interface LaunchInput {
  /** Token contract address (any case; lowercased for keys). */
  token: string;
  /** Unix seconds the contract was created, or 0 when unknown. */
  createdAt: number;
  /** Creation transaction hash, for the audit trail. */
  txHash?: string | null;
  /**
   * The current market read, or `null` when enrichment returned NOTHING for this
   * token (a network/outage gap) — surfaced as `unobserved`, never as `no-market`.
   * `observed:false` (a returned record that found no pool) is distinct and maps to
   * `no-market`.
   */
  market: MarketRead | null;
}

/** A per-token descriptive trajectory — display-ready projection of the core. */
export interface LaunchTrajectory {
  token: string;
  createdAt: number;
  txHash: string | null;
  status: LaunchStatus;
  /** Current liquidity in ETH, or `null` when unobserved / no market. Never invented. */
  liquidityEth: number | null;
  /** Current price in ETH, or `null` when unobserved / no market. */
  priceEth: number | null;
  /** Neutral, factual, non-accusatory one-line description of the status. */
  note: string;
}

/** Aggregate reputation read for a deployer. */
export interface DeployerReputation {
  method: { version: string; description: string };
  /** The deployer address measured (lowercased). */
  deployer: string;
  /** Unix seconds this snapshot reflects. */
  observedAt: number;
  counts: {
    /** Tokens shown (candidate direct-creations after the discovery cap). */
    created: number;
    activeMarket: number;
    thinMarket: number;
    noMarket: number;
    unobserved: number;
  };
  /** Most recent creation among the shown set (unix seconds), or null. */
  latestCreationAt: number | null;
  /** Deployer's most recent on-chain activity (unix seconds), or null when unknown. */
  lastActivityAt: number | null;
  /** Per-token trajectories, sorted newest-created first. */
  trajectories: LaunchTrajectory[];
  /** Data-confidence flag — SEPARATE from any per-token status, never folded in. */
  confidence: { level: ConfidenceLevel; reasons: string[] };
  /** Plain-sentence lead, self-gating to an honest empty when there is nothing to show. */
  headline: string;
  /** Loud, always-shown gap disclosures (factory-invisibility, no baselines, …). */
  disclosures: string[];
  /** How to dispute an address→token mapping — the disclosed correction path. */
  correctionPath: string;
}

export interface DeployerReputationConfig {
  /** A live pool with liquidity below this (ETH) is classified `thin-market`. */
  activeLiquidityFloorEth: number;
}

export const DEFAULT_DEPLOYER_CONFIG: DeployerReputationConfig = {
  // ~0.25 ETH: below roughly this, a pool is too shallow to exit into without
  // heavy slippage — a "faded/fragile" market rather than an active one. Tunable.
  activeLiquidityFloorEth: 0.25,
};

const METHOD_DESCRIPTION =
  'Direct contract-creation transactions of the address (Etherscan) paired with each created token’s CURRENT live-pool state (GeckoTerminal). Descriptive current-state only — not a launch-time track record, not a fraud verdict.';

export const DEPLOYER_CORRECTION_PATH =
  'A contract shown here was created directly by this address on-chain. If a token is mislabelled, was created for an unrelated purpose, or you can supply launch-time baselines to enable an outcome read, contact the team with the token address to have the record annotated.';

function finite(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Classify one launched token into a current-state trajectory. Pure and total —
 * a missing or partial market read degrades to `unobserved`/`no-market`, never to
 * a fabricated active pool.
 */
export function classifyLaunch(
  input: LaunchInput,
  _observedAt: number,
  cfg: DeployerReputationConfig = DEFAULT_DEPLOYER_CONFIG,
): LaunchTrajectory {
  const token = String(input.token).toLowerCase();
  const createdAt = finite(input.createdAt) && input.createdAt > 0 ? Math.floor(input.createdAt) : 0;
  const txHash = typeof input.txHash === 'string' ? input.txHash : null;
  const floor = cfg.activeLiquidityFloorEth;

  // No record returned at all → we genuinely could not read the market. Unknown.
  if (input.market == null) {
    return {
      token,
      createdAt,
      txHash,
      status: 'unobserved',
      liquidityEth: null,
      priceEth: null,
      note: 'Current market state could not be read (upstream unavailable). State unknown — this is not a signal about the token.',
    };
  }

  const liq = finite(input.market.liquidityEth) && input.market.liquidityEth > 0 ? input.market.liquidityEth : 0;
  const price = finite(input.market.priceEth) && input.market.priceEth > 0 ? input.market.priceEth : 0;

  // A record came back but no live pool was found. Factual, never a rug verdict.
  if (!input.market.observed) {
    return {
      token,
      createdAt,
      txHash,
      status: 'no-market',
      liquidityEth: null,
      priceEth: null,
      note: 'No live trading pool found on GeckoTerminal at this observation. This is not evidence of a rug — the pool may never have existed, may trade on a venue we do not index, or may have been withdrawn; these cannot be told apart without launch-time baselines.',
    };
  }

  if (liq < floor) {
    return {
      token,
      createdAt,
      txHash,
      status: 'thin-market',
      liquidityEth: liq,
      priceEth: price,
      note: `Live pool found, but liquidity is thin (~${formatEth(liq)} ETH) — an exit of any size would move the price sharply.`,
    };
  }

  return {
    token,
    createdAt,
    txHash,
    status: 'active-market',
    liquidityEth: liq,
    priceEth: price,
    note: `Live trading pool with ~${formatEth(liq)} ETH liquidity at this observation.`,
  };
}

function formatEth(n: number): string {
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.001) return n.toFixed(3);
  return n.toExponential(1);
}

export interface SummarizeDeployerOptions {
  deployer: string;
  observedAt: number;
  /** True when discovery could not read the full history (row cap or > creation cap hit). */
  truncated?: boolean;
  /** Deployer's most recent on-chain activity (unix seconds), when known. */
  lastActivityAt?: number | null;
  /** True only if a holder-count source is actually wired (Pro Etherscan). Default false. */
  holderCountsAvailable?: boolean;
}

/**
 * Roll a set of trajectories into a `DeployerReputation`. Never invents a verdict:
 * an empty or all-unobserved set produces an honest low-confidence summary rather
 * than a flattering "clean track record". The always-on `disclosures` name the
 * structural gaps (factory-invisibility, no launch baselines, Pro-gated holders).
 */
export function summarizeDeployer(
  trajectories: readonly LaunchTrajectory[],
  opts: SummarizeDeployerOptions,
): DeployerReputation {
  const deployer = String(opts.deployer).toLowerCase();
  const observedAt = finite(opts.observedAt) ? Math.floor(opts.observedAt) : Math.floor(Date.now() / 1000);

  const sorted = [...trajectories].sort((a, b) => b.createdAt - a.createdAt);

  const counts = {
    created: sorted.length,
    activeMarket: sorted.filter((t) => t.status === 'active-market').length,
    thinMarket: sorted.filter((t) => t.status === 'thin-market').length,
    noMarket: sorted.filter((t) => t.status === 'no-market').length,
    unobserved: sorted.filter((t) => t.status === 'unobserved').length,
  };

  const first = sorted[0];
  const latestCreationAt = first && first.createdAt > 0 ? first.createdAt : null;
  const lastActivityAt =
    opts.lastActivityAt != null && finite(opts.lastActivityAt) && opts.lastActivityAt > 0
      ? Math.floor(opts.lastActivityAt)
      : null;

  // ── Data-confidence flag ──────────────────────────────────────────────────
  const reasons: string[] = [];
  let level: ConfidenceLevel;
  if (counts.created === 0) {
    level = 'low';
    reasons.push('No direct contract-creations were found for this address, so there is nothing to measure.');
  } else if (counts.unobserved === counts.created) {
    level = 'low';
    reasons.push('The current market state of every created token was unreadable at this observation.');
  } else if (opts.truncated) {
    level = 'low';
    reasons.push('This address has more history than could be read in one pass, so the set shown is incomplete.');
  } else {
    // Even a clean read is only ever MEDIUM here: outcomes lack launch baselines and
    // factory-launched tokens are structurally invisible without an indexer.
    level = 'medium';
  }
  if (counts.created > 0 && counts.unobserved > 0 && counts.unobserved < counts.created) {
    reasons.push(`${counts.unobserved} of ${counts.created} tokens had an unreadable current market at this observation.`);
  }
  if (!opts.holderCountsAvailable) {
    reasons.push('Holder counts are Etherscan-Pro-gated on this deployment and are shown as unavailable, not as zero.');
  }

  // ── Plain-sentence headline (self-gating) ─────────────────────────────────
  const headline =
    counts.created === 0
      ? 'No contracts were created directly by this address in the transaction history read. Tokens launched through a factory contract would not appear here.'
      : `This address directly deployed ${counts.created} contract${counts.created === 1 ? '' : 's'}. Right now ${counts.activeMarket} ${counts.activeMarket === 1 ? 'has' : 'have'} an active trading pool, ${counts.thinMarket} a thin pool, and ${counts.noMarket} no live market found${counts.unobserved > 0 ? `; ${counts.unobserved} could not be read` : ''}.`;

  // ── Loud, always-shown gap disclosures ────────────────────────────────────
  const disclosures: string[] = [
    'Only tokens this address deployed DIRECTLY (its own contract-creation transactions) are shown. Tokens launched through a factory contract — the norm for most token launchers — are created by the factory, not this address, and do not appear here without a deployed event indexer.',
    'Launch-time price and liquidity are not available from the wired data sources, so per-token price return and liquidity-drain — the signals behind “survived / dumped / rugged” — cannot be computed. Each token shows its CURRENT market state only.',
    'Absence of a live pool is reported as “no live market found”, never as a rug. It is a factual current-state observation, not an accusation of wrongdoing.',
    // Our OWN curve is one of those factories, and unlike a stranger's it is one we
    // could index today: TegridyCurveLauncher.create() deploys the token itself
    // (contracts/src/curve/TegridyCurveLauncher.sol:333), so the creator's txlist row
    // carries the launcher as `to` and no `contractAddress`, and creationAddress() in
    // deployerLaunches.ts drops it before discovery ever reaches enrichment. The
    // launcher records the creator on-chain (getLaunch().creator; topic2 of
    // LaunchCreated), and CurveLaunchesGrid.tsx already reads that index in this same
    // app -- so this gap is WIRABLE, not structural, and the disclosure above would
    // otherwise tell a reader the only cure is an indexer we do not have. Naming it is
    // the honest interim: nobody should take this list as a whole record while the one
    // launcher we control is missing from it.
    'Coins launched on our own bonding curve at /eth-curve are absent from the list above for the same reason: TegridyCurveLauncher deploys each launch token itself, so the contract creation belongs to the launcher and not to this address, even though the launcher records the creator on-chain. Read the /eth-curve list alongside this page until that source is wired in.',
  ];
  if (!opts.holderCountsAvailable) {
    disclosures.push('Holder counts require the Etherscan Pro tier and are unavailable here — they are omitted rather than shown as zero.');
  }
  if (opts.truncated) {
    disclosures.push('This address has more transaction history or more created contracts than could be read in a single pass — the set below is the most recent slice, not the complete record.');
  }

  return {
    method: { version: METHOD_VERSION, description: METHOD_DESCRIPTION },
    deployer,
    observedAt,
    counts,
    latestCreationAt,
    lastActivityAt,
    trajectories: sorted,
    confidence: { level, reasons },
    headline,
    disclosures,
    correctionPath: DEPLOYER_CORRECTION_PATH,
  };
}

/** Human labels + neutral tone per status. */
export const STATUS_LABEL: Record<LaunchStatus, string> = {
  'active-market': 'Active market',
  'thin-market': 'Thin market',
  'no-market': 'No live market',
  unobserved: 'Unread',
};

/** GeckoTerminal token page — the self-serve verification link for a token. */
export function geckoTerminalTokenUrl(tokenAddress: string): string {
  return `https://www.geckoterminal.com/eth/tokens/${tokenAddress}`;
}
