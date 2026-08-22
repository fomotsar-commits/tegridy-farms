// Trigger-order math. Pure, integer-exact, no wallet and no network.
//
// Every number a user sees on this surface and every number that ends up inside a
// signed struct comes from here, so the two cannot drift. All amounts are base
// units; no float touches a value that gets signed.
//
// Prices on this surface have ONE meaning throughout: buy-token base units per ONE
// WHOLE sell token. That is the same quantity the StopLoss handler compares against
// its strike (a ratio of two oracle prices is "how many buy tokens one sell token is
// worth"), which is why the strike derivation below is a rescale and not a model.
//
// Rounding is chosen so error always costs the venue and never the user: strikes
// floor, which makes a stop fire marginally later rather than marginally early, and
// a trail's derived stop floors, which widens the trail rather than tightening it.

import type { Address, Hex } from 'viem';
import { TRIGGER_APP_DATA, type StopLossData } from './stopLossHandler';

export type TriggerKind = 'stop-loss' | 'take-profit' | 'trailing-stop' | 'oco';

export const TRIGGER_KINDS: readonly TriggerKind[] = [
  'stop-loss',
  'take-profit',
  'trailing-stop',
  'oco',
] as const;

export const TRIGGER_KIND_LABELS: Record<TriggerKind, string> = {
  'stop-loss': 'Stop-loss',
  'take-profit': 'Take-profit',
  'trailing-stop': 'Trailing stop',
  oco: 'OCO (stop + target)',
};

// ─── Guard rails ─────────────────────────────────────────────────────────────
export const MIN_TRIGGER_SLIPPAGE_BPS = 10; // 0.1%
export const MAX_TRIGGER_SLIPPAGE_BPS = 1000; // 10%
export const MIN_TRAIL_BPS = 50; // 0.5%
export const MAX_TRAIL_BPS = 5000; // 50%
export const MIN_ORACLE_STALENESS_SECONDS = 60;
export const MAX_ORACLE_STALENESS_SECONDS = 24 * 60 * 60;
/**
 * Default staleness bound. Chosen at the mainnet ETH/USD heartbeat rather than at
 * something generous: a stop that is allowed to fire on day-old price data is not a
 * stop, and the user is told this number rather than inheriting it silently.
 */
export const DEFAULT_ORACLE_STALENESS_SECONDS = 3600;

/** Order-validity bucket. Coarse on purpose — a fresh UID every block is a fresh
 *  order for the watchtower to poll and nothing gained. */
export const VALIDITY_BUCKET_SECONDS = 900n;

const BPS = 10_000n;
const WAD = 10n ** 18n;

export type TriggerDirection = 'falls-to' | 'rises-to';

export interface TriggerLeg {
  /** Which way the price has to move for this leg to become tradeable. */
  direction: TriggerDirection;
  /** Buy-token base units per whole sell token, at which the leg arms. */
  triggerPrice: bigint;
  /** The handler's 18-decimal strike for `triggerPrice`. */
  strike18: bigint;
  /** Worst price the fill may take, after the user's slippage tolerance. */
  limitPrice: bigint;
  /** Minimum buy-token base units the fill must return. */
  buyAmount: bigint;
  /** Sell-token base units this leg disposes of. */
  sellAmount: bigint;
}

export interface TriggerPlanInput {
  kind: TriggerKind;
  sellAmount: bigint;
  /** 10 ** sellTokenDecimals. */
  sellScale: bigint;
  /** 10 ** buyTokenDecimals — the scale prices are quoted in. */
  buyScale: bigint;
  /** stop-loss, the stop leg of an OCO. */
  stopPrice?: bigint;
  /** take-profit, the target leg of an OCO. */
  targetPrice?: bigint;
  /** trailing-stop: the high the trail hangs from. */
  referencePrice?: bigint;
  trailBps?: number;
  slippageBps: number;
  stalenessSeconds?: number;
}

export interface TriggerPlan {
  valid: boolean;
  error: string | null;
  kind: TriggerKind;
  legs: TriggerLeg[];
  /**
   * True when more than one leg can be live simultaneously and nothing cancels the
   * loser when the winner fills. An OCO whose legs do not cancel each other is two
   * orders, not an OCO, and the surface has to say so.
   */
  doubleFillRisk: boolean;
  stalenessSeconds: number;
  validityBucketSeconds: bigint;
}

const INVALID = (kind: TriggerKind, error: string): TriggerPlan => ({
  valid: false,
  error,
  kind,
  legs: [],
  doubleFillRisk: false,
  stalenessSeconds: DEFAULT_ORACLE_STALENESS_SECONDS,
  validityBucketSeconds: VALIDITY_BUCKET_SECONDS,
});

function buildLeg(args: {
  direction: TriggerDirection;
  triggerPrice: bigint;
  sellAmount: bigint;
  sellScale: bigint;
  buyScale: bigint;
  slippageBps: number;
}): TriggerLeg | null {
  const { direction, triggerPrice, sellAmount, sellScale, buyScale, slippageBps } = args;
  const strike18 = (triggerPrice * WAD) / buyScale;
  if (strike18 <= 0n) return null;
  const limitPrice = (triggerPrice * (BPS - BigInt(slippageBps))) / BPS;
  if (limitPrice <= 0n) return null;
  const buyAmount = (sellAmount * limitPrice) / sellScale;
  if (buyAmount <= 0n) return null;
  return { direction, triggerPrice, strike18, limitPrice, buyAmount, sellAmount };
}

/**
 * Derive the legs of a trigger order. Returns `valid:false` with a human `error`
 * for anything out of range so the surface can refuse placement and say why —
 * never a silently clamped order the user did not describe.
 */
export function planTrigger(input: TriggerPlanInput): TriggerPlan {
  const { kind, sellAmount, sellScale, buyScale, slippageBps } = input;
  const staleness = input.stalenessSeconds ?? DEFAULT_ORACLE_STALENESS_SECONDS;

  if (sellAmount <= 0n) return INVALID(kind, 'Enter an amount to sell.');
  if (sellScale <= 0n || buyScale <= 0n) return INVALID(kind, 'Token decimals are unknown.');
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < MIN_TRIGGER_SLIPPAGE_BPS ||
    slippageBps > MAX_TRIGGER_SLIPPAGE_BPS
  ) {
    return INVALID(
      kind,
      `Slippage must be between ${MIN_TRIGGER_SLIPPAGE_BPS / 100}% and ${MAX_TRIGGER_SLIPPAGE_BPS / 100}%.`,
    );
  }
  if (
    !Number.isInteger(staleness) ||
    staleness < MIN_ORACLE_STALENESS_SECONDS ||
    staleness > MAX_ORACLE_STALENESS_SECONDS
  ) {
    return INVALID(kind, 'Price-staleness bound is out of range.');
  }

  const common = { sellAmount, sellScale, buyScale, slippageBps };
  const legs: TriggerLeg[] = [];

  if (kind === 'stop-loss' || kind === 'oco') {
    const stopPrice = input.stopPrice ?? 0n;
    if (stopPrice <= 0n) return INVALID(kind, 'Enter a stop price.');
    const leg = buildLeg({ direction: 'falls-to', triggerPrice: stopPrice, ...common });
    if (!leg) return INVALID(kind, 'Stop price is too small for this amount.');
    legs.push(leg);
  }

  if (kind === 'take-profit' || kind === 'oco') {
    const targetPrice = input.targetPrice ?? 0n;
    if (targetPrice <= 0n) return INVALID(kind, 'Enter a target price.');
    const leg = buildLeg({ direction: 'rises-to', triggerPrice: targetPrice, ...common });
    if (!leg) return INVALID(kind, 'Target price is too small for this amount.');
    legs.push(leg);
  }

  if (kind === 'trailing-stop') {
    const reference = input.referencePrice ?? 0n;
    const trailBps = input.trailBps ?? 0;
    if (reference <= 0n) return INVALID(kind, 'Enter the price the trail starts from.');
    if (!Number.isInteger(trailBps) || trailBps < MIN_TRAIL_BPS || trailBps > MAX_TRAIL_BPS) {
      return INVALID(
        kind,
        `Trail must be between ${MIN_TRAIL_BPS / 100}% and ${MAX_TRAIL_BPS / 100}%.`,
      );
    }
    const derivedStop = (reference * (BPS - BigInt(trailBps))) / BPS;
    if (derivedStop <= 0n) return INVALID(kind, 'Trail is too wide for this price.');
    const leg = buildLeg({ direction: 'falls-to', triggerPrice: derivedStop, ...common });
    if (!leg) return INVALID(kind, 'Trail is too wide for this amount.');
    legs.push(leg);
  }

  if (kind === 'oco') {
    const [stop, target] = legs as [TriggerLeg, TriggerLeg];
    if (stop.triggerPrice >= target.triggerPrice) {
      return INVALID(kind, 'The stop must sit below the target — otherwise both legs are the same trade.');
    }
  }

  return {
    valid: true,
    error: null,
    kind,
    legs,
    doubleFillRisk: legs.length > 1,
    stalenessSeconds: staleness,
    validityBucketSeconds: VALIDITY_BUCKET_SECONDS,
  };
}

/**
 * The stop price a trail currently sits at, for display beside the reference high.
 * Returns null for inputs `planTrigger` would reject, so the two never disagree.
 */
export function trailingStopPrice(referencePrice: bigint, trailBps: number): bigint | null {
  if (referencePrice <= 0n) return null;
  if (!Number.isInteger(trailBps) || trailBps < MIN_TRAIL_BPS || trailBps > MAX_TRAIL_BPS) return null;
  const stop = (referencePrice * (BPS - BigInt(trailBps))) / BPS;
  return stop > 0n ? stop : null;
}

/**
 * Assemble the handler struct for one leg.
 *
 * `isSellOrder` is fixed true and `isPartiallyFillable` fixed false: this surface
 * sells an exact position at a price floor. A partially fillable stop leaves a
 * remainder still exposed to the move the user was trying to exit, which is not
 * what "stop-loss" means to anyone typing it.
 */
export function stopLossDataFromLeg(
  leg: TriggerLeg,
  plan: TriggerPlan,
  ctx: {
    sellToken: Address;
    buyToken: Address;
    receiver: Address;
    sellTokenPriceOracle: Address;
    buyTokenPriceOracle: Address;
    appData?: Hex;
  },
): StopLossData {
  return {
    sellToken: ctx.sellToken,
    buyToken: ctx.buyToken,
    sellAmount: leg.sellAmount,
    buyAmount: leg.buyAmount,
    appData: ctx.appData ?? TRIGGER_APP_DATA,
    receiver: ctx.receiver,
    isSellOrder: true,
    isPartiallyFillable: false,
    validityBucketSeconds: plan.validityBucketSeconds,
    sellTokenPriceOracle: ctx.sellTokenPriceOracle,
    buyTokenPriceOracle: ctx.buyTokenPriceOracle,
    strike: leg.strike18,
    maxTimeSinceLastOracleUpdate: BigInt(plan.stalenessSeconds),
  };
}
