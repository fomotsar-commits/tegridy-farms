// What ONE buy of a given size does to a constant-product pool, and who is paid from it.
//
// For the pool card's dial (components/solana/lp/PoolTradeDial.tsx). It answers the two
// things a liquidity provider wants to know about a pool before adding to it: how deep it is
// (how far a trade moves the price) and how a trade pays (what the trade fee leaves with the
// pool's providers, what the venue takes, what the pool's creator takes). It is arithmetic on
// the reserves and the fee tier the chain returned. It says nothing of how often anyone
// trades: no volume, no rate over time, no forecast.
import { FEE_RATE_DENOMINATOR } from '../cpswap/math';

/** The smallest and largest buy the dial offers, as a share of the pairing coin's reserve. */
export const DEPTH_MIN_SHARE = 0.0001; // 0.01%
export const DEPTH_MAX_SHARE = 0.25; // 25%
export const DEPTH_STOPS = 100;

const SCALE = 1_000_000_000n;

/** The buy at a stop, in the pairing coin's base units: log-spaced, 0.01% of the reserve at
 *  stop 0 to 25% at the last. */
export function sizeAtStop(quoteReserve: bigint, stop: number): bigint {
  if (quoteReserve <= 0n) return 0n;
  const s = Math.max(0, Math.min(DEPTH_STOPS, stop));
  const share = DEPTH_MIN_SHARE * (DEPTH_MAX_SHARE / DEPTH_MIN_SHARE) ** (s / DEPTH_STOPS);
  return (quoteReserve * BigInt(Math.round(share * Number(SCALE)))) / SCALE;
}

export interface DepthPoint {
  size: bigint;
  /** The trade fee, split as cp-swap splits it: the venue's part rounded down, the rest stays in the pool. */
  lpKeeps: bigint;
  venueTakes: bigint;
  /** The creator fee the pool charges on top; 0n when its switch is off. */
  creatorTakes: bigint;
  /**
   * How far the buy moves the pool's price, as a fraction (0.04 = 4% up), from the input
   * net of the trade fee: (1 + net/reserve)^2 - 1. "About": the fee the providers keep stays
   * in the pool and a creator fee can come off either side, both of which shift it slightly.
   */
  move: number;
}

const ceilDiv = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;

/** Null when the pool has no reserve to trade against or the size is nothing. */
export function depthPoint(
  quoteReserve: bigint,
  size: bigint,
  config: { tradeFeeRate: bigint; protocolFeeRate: bigint; fundFeeRate: bigint },
  creatorFeeRate: bigint,
): DepthPoint | null {
  if (quoteReserve <= 0n || size <= 0n) return null;
  const tradeFee = ceilDiv(size, config.tradeFeeRate, FEE_RATE_DENOMINATOR);
  const venueTakes = (tradeFee * (config.protocolFeeRate + config.fundFeeRate)) / FEE_RATE_DENOMINATOR;
  const creatorTakes = creatorFeeRate > 0n ? ceilDiv(size, creatorFeeRate, FEE_RATE_DENOMINATOR) : 0n;
  const net = size - tradeFee;
  const grow = 1 + Number(net) / Number(quoteReserve);
  return { size, lpKeeps: tradeFee - venueTakes, venueTakes, creatorTakes, move: grow * grow - 1 };
}

/** "0.41", "4.1", "56": a price move in percent, to about two figures; "under 0.01" below that. */
export function moveText(move: number): string {
  const pct = move * 100;
  if (!(pct >= 0.01)) return 'under 0.01';
  if (pct < 1) return pct.toFixed(2);
  if (pct < 10) return pct.toFixed(1);
  return pct.toFixed(0);
}
