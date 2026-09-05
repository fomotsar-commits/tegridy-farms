// Outcomes tracking data model (docs/LAUNCHER_STRATEGY.md §2.5).
//
// The honest-tracking credibility asset: nobody in the launcher category keeps
// public, permanent post-launch statistics. We do — INCLUDING our failures.
//
// Red-team disposition J: these are DISCLOSED market-risk outcomes, never safety
// claims. A team dumping per its disclosed vesting, or abandoning a project, is a
// tracked outcome and a disclosed risk — NOT a "safety incident" (which is
// reserved for a rug through a power the gate failed to detect). Wording here is
// factual and non-editorial throughout.

import type { Address } from 'viem';
import type { LaunchTier } from './factSheet';

/** A scheduled token unlock and whether it was honored (not dumped into the pool). */
export interface UnlockEvent {
  at: number; // unix seconds
  amountBps: number; // bps of supply unlocking
  /** Observed: was the unlocked supply held/used, or sold into the pool within the window? */
  soldWithinWindow: boolean;
}

/** A point-in-time snapshot of a launched token's trajectory. Append-only history. */
export interface OutcomeRecord {
  token: Address;
  tier: LaunchTier;
  launchedAt: number;
  observedAt: number;
  priceEth: number;
  launchPriceEth: number;
  liquidityEth: number;
  launchLiquidityEth: number;
  /**
   * Distinct holder count at `observedAt`, or null when the read did not land.
   * Null, never 0: `tokenholdercount` is an Etherscan PRO stat and a free-tier key is
   * refused for it on every token, so "0 holders" was published about live tokens as a
   * matter of routine. Read `holderCountObserved` before rendering or scoring it.
   */
  holderCount: number | null;
  /**
   * Whether a holder count was actually read at `observedAt`. Render and score the
   * number only when this is `true`: undefined (a record written before this field
   * existed) means we cannot tell whether its `holderCount` was read or defaulted, so it
   * degrades to "unavailable" rather than inheriting a false zero.
   */
  holderCountObserved?: boolean;
  /**
   * The holder-count read FAILED — 429, non-2xx, unparseable, or Etherscan's Pro-gate
   * refusal envelope — as opposed to answering with a number. Undefined = the read did
   * not fail (back-compat with records written before this field existed). Distinct from
   * `holderCountsAvailable` on the deployer surface, which says a holder-count source is
   * not wired AT ALL on this deployment; this says we asked and got nothing back.
   */
  holderCountReadFailed?: boolean;
  unlocks: UnlockEvent[];
  /** Last on-chain activity from the creator/team address (unix seconds). */
  lastTeamActivityAt: number | null;
  /**
   * Whether live market data was actually observed at `observedAt`. When false
   * (upstream outage/rate-limit), price/liquidity mirror the baseline so no false
   * crash/drain signal is derived — consumers should render "unavailable" rather
   * than "no adverse signals". Undefined = observed (back-compat with existing records).
   */
  marketObserved?: boolean;
  /**
   * The market read FAILED — the upstream 429'd, errored, or returned something we
   * could not parse — as opposed to answering "there is no pool".
   *
   * `marketObserved:false` alone cannot tell those apart, and collapsing them made
   * a throttled read render as a "No live market" verdict with a note speculating
   * the pool "may have been withdrawn". Consumers should map this to the reader's
   * `unobserved` status, never to `no-market`. Undefined = the read succeeded
   * (back-compat with records written before this field existed).
   */
  marketReadFailed?: boolean;
}

export interface OutcomeFlags {
  /** Liquidity is materially below what graduated (possible soft-rug / decline). */
  liquidityDrained: boolean;
  /** Any scheduled unlock was sold into the pool within its window. */
  unlockDumped: boolean;
  /** No creator/team on-chain activity for a long stretch (possible abandonment). */
  likelyAbandoned: boolean;
  /** Plain-language, non-editorial summary lines for the dashboard. */
  disclosures: string[];
}

export interface OutcomeConfig {
  /** Fraction of graduated liquidity below which we flag a drain. Default 0.5. */
  liquidityDrainRatio: number;
  /** Silence beyond this (seconds) flags likely abandonment. Default 30 days. */
  abandonmentSeconds: number;
}

const DAY = 86_400;

export function defaultOutcomeConfig(): OutcomeConfig {
  return { liquidityDrainRatio: 0.5, abandonmentSeconds: 30 * DAY };
}

/** Derive disclosed-risk outcome flags from a snapshot. Pure; factual wording only. */
export function deriveOutcomeFlags(r: OutcomeRecord, cfg: OutcomeConfig = defaultOutcomeConfig()): OutcomeFlags {
  const disclosures: string[] = [];

  const liquidityDrained =
    r.launchLiquidityEth > 0 && r.liquidityEth < r.launchLiquidityEth * cfg.liquidityDrainRatio;
  if (liquidityDrained) {
    const pct = Math.round((1 - r.liquidityEth / r.launchLiquidityEth) * 100);
    disclosures.push(`Pool liquidity is ${pct}% below its level at graduation.`);
  }

  const unlockDumped = r.unlocks.some((u) => u.soldWithinWindow);
  if (unlockDumped) {
    disclosures.push('At least one scheduled unlock was sold into the pool within its release window.');
  }

  const likelyAbandoned =
    r.lastTeamActivityAt != null && r.observedAt - r.lastTeamActivityAt > cfg.abandonmentSeconds;
  if (likelyAbandoned) {
    const days = Math.floor((r.observedAt - (r.lastTeamActivityAt ?? r.observedAt)) / DAY);
    disclosures.push(`No creator on-chain activity for ${days} days.`);
  }

  if (disclosures.length === 0) {
    disclosures.push('No adverse outcome signals recorded at this observation.');
  }

  return { liquidityDrained, unlockDumped, likelyAbandoned, disclosures };
}

/** Price change vs launch, as a signed ratio (e.g. -0.8 = down 80%). Factual, no judgement. */
export function priceReturn(r: OutcomeRecord): number {
  if (r.launchPriceEth <= 0) return 0;
  return r.priceEth / r.launchPriceEth - 1;
}
