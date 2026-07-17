// Deterministic flagship-surface ordering (docs/LAUNCHER_STRATEGY.md §2.7).
//
// Red-team dispositions A/B/Q killed any purchasable or vote-bought placement:
// featuring was the whole reason the v1 centerpiece got cut. The replacement is
// THIS — an ordering that is deterministic, published, and STRUCTURALLY unable to
// take payment for rank. The proof is at the type level: `LaunchSummary` has no
// "boost"/"promoted"/"paid" field, so no amount of money can enter the score.
//
// The formula is intended to be published verbatim next to the surface:
//   score = tierWeight + recency + activity
// where activity is LOG-scaled (dampens whales/wash) and recency decays over a
// fixed window. Ties break on token address (fully deterministic render order).

import type { Address } from 'viem';
import type { LaunchTier } from './factSheet';

/** Everything the ordering is allowed to see. Note the ABSENCE of any pay-to-rank field. */
export interface LaunchSummary {
  token: Address;
  tier: LaunchTier;
  /** Unix seconds the launch graduated / went live. */
  launchedAt: number;
  /** On-chain activity signals (observed, not self-reported). */
  uniqueBuyers24h: number;
  liquidityEth: number;
  feeRevenueEth24h: number;
  holderCount: number;
}

export interface OrderingConfig {
  now: number;
  /** Recency decays linearly to zero over this window (seconds). Default 14 days. */
  recencyWindowSeconds: number;
  /** Flagship tier always outranks listable — a published structural rule, not payment. */
  tierWeight: Record<LaunchTier, number>;
  /** Cap on the activity term so no single metric can dominate (anti-wash). */
  activityCap: number;
}

const DAY = 86_400;

export function defaultOrderingConfig(now: number): OrderingConfig {
  return {
    now,
    recencyWindowSeconds: 14 * DAY,
    tierWeight: { flagship: 100, listable: 50, none: 0 },
    activityCap: 30,
  };
}

export interface RankedLaunch {
  summary: LaunchSummary;
  score: number;
  breakdown: { tier: number; recency: number; activity: number };
}

function log10p(x: number): number {
  return Math.log10(1 + Math.max(0, x));
}

/** Compute the transparent, published score for one launch. Pure. */
export function scoreLaunch(s: LaunchSummary, cfg: OrderingConfig): RankedLaunch {
  const tier = cfg.tierWeight[s.tier] ?? 0;

  const age = Math.max(0, cfg.now - s.launchedAt);
  const recency = 10 * Math.max(0, 1 - age / cfg.recencyWindowSeconds); // 0..10

  // Log-scaled so a whale/wash-trade can't buy rank; capped so activity never
  // dominates the structural tier ordering.
  const rawActivity = log10p(s.uniqueBuyers24h) * 3 + log10p(s.liquidityEth) * 2 + log10p(s.feeRevenueEth24h) * 2 + log10p(s.holderCount);
  const activity = Math.min(cfg.activityCap, rawActivity);

  return { summary: s, score: tier + recency + activity, breakdown: { tier, recency, activity } };
}

/**
 * Order launches for the flagship surface. Deterministic: descending score,
 * ties broken by token address ascending (stable regardless of input order).
 * `tier: 'none'` launches are excluded from the flagship surface entirely.
 */
export function orderLaunches(
  summaries: readonly LaunchSummary[],
  cfg: OrderingConfig,
): RankedLaunch[] {
  return summaries
    .filter((s) => s.tier !== 'none')
    .map((s) => scoreLaunch(s, cfg))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.summary.token.toLowerCase() < b.summary.token.toLowerCase() ? -1 : 1;
    });
}
