// The Liquidity Room's numbers: what the scene draws, worked out with no drawing code near it.
//
// The room's floor runs left to right by price on a log axis (a tick is one step of 0.01%, so
// ticks are already a log axis), the lowest price on the left. Everything here is a fraction
// of that floor, 0 at the left edge and 1 at the right, or a height from 0 to 1 against the
// deepest stretch in view.
//
// A pool's ticks count its token 1 against its token 0. When the token this site prices is
// token 1 (BAYLA in a SOL/BAYLA pool), a higher tick is a LOWER price of it, so the floor is
// turned round (`priceFallsWithTicks`): left is always the cheaper end, as every price on the
// page reads.
import { liquidityAt, type DepthProfile } from './depthProfile';
import type { RoomSwap } from './roomSwaps';

/** Columns the landscape is sampled into. */
export const ROOM_COLUMNS = 120;
/** The floor never reaches further than about 32 times the price each way (ln 32 / ln 1.0001 ticks). */
export const ROOM_REACH_TICKS = 34_660;
/** Empty floor kept either side of the liquidity, as a share of its width. */
const MARGIN = 0.08;

export interface RoomBlock {
  /** The position's two edges on the floor, clipped to it. */
  from: number;
  to: number;
  /** An edge that lies off the floor: the block runs on past what is drawn. */
  openLeft: boolean;
  openRight: boolean;
  inRange: boolean;
}

export interface RoomLayout {
  /** The lowest and highest ticks on the floor (which is left and which right: `priceFallsWithTicks`). */
  tickFrom: number;
  tickTo: number;
  /** One height per column, 0 to 1 against the deepest column; all 0 when nothing is in view. */
  heights: number[];
  /** Where the pool's price stands on the floor. */
  now: number;
  /** The height at the pool's price. */
  nowHeight: number;
  blocks: RoomBlock[];
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * The floor for a pool at `tickCurrent` with this depth and these positions (lower, upper ticks).
 * `priceFallsWithTicks`: the priced token is the pool's token 1 (`!pair.tokenIsToken0`).
 */
export function roomLayout(profile: DepthProfile, tickCurrent: number, positions: { lower: number; upper: number }[] = [], priceFallsWithTicks = false): RoomLayout {
  // Start from what was read, no further than the reach.
  let lo = Math.max(profile.from, tickCurrent - ROOM_REACH_TICKS);
  let hi = Math.min(profile.to, tickCurrent + ROOM_REACH_TICKS);
  // Close in on where the liquidity is, so one narrow position is not a sliver on an empty floor.
  const live = profile.steps.filter((s) => s.liquidity > 0n && s.to > lo && s.from < hi);
  if (live.length > 0) {
    const a = Math.max(lo, Math.min(tickCurrent, ...live.map((s) => s.from)));
    const b = Math.min(hi, Math.max(tickCurrent + 1, ...live.map((s) => s.to)));
    const pad = Math.max(1, Math.round((b - a) * MARGIN));
    lo = Math.max(lo, a - pad);
    hi = Math.min(hi, b + pad);
  }
  const width = Math.max(1, hi - lo);
  const at = (tick: number) => (tick - lo) / width;

  const raw: bigint[] = [];
  for (let i = 0; i < ROOM_COLUMNS; i++) {
    const tick = Math.floor(lo + ((i + 0.5) / ROOM_COLUMNS) * width);
    raw.push(liquidityAt(profile, tick) ?? 0n);
  }
  const hereL = liquidityAt(profile, tickCurrent) ?? 0n;
  const max = raw.reduce((m, v) => (v > m ? v : m), hereL);
  // Ten thousand steps of height is finer than a pixel and keeps the division in whole numbers.
  const height = (v: bigint) => (max === 0n ? 0 : Number((v * 10_000n) / max) / 10_000);

  const byTick: RoomLayout = {
    tickFrom: lo,
    tickTo: hi,
    heights: raw.map(height),
    now: clamp01(at(tickCurrent)),
    nowHeight: height(hereL),
    blocks: positions
      .filter((p) => p.upper > lo && p.lower < hi)
      .map((p) => ({
        from: clamp01(at(p.lower)),
        to: clamp01(at(p.upper)),
        openLeft: p.lower < lo,
        openRight: p.upper > hi,
        inRange: tickCurrent >= p.lower && tickCurrent < p.upper,
      })),
  };
  if (!priceFallsWithTicks) return byTick;
  // The same floor seen from the other side: the highest tick, the lowest price, on the left.
  return {
    ...byTick,
    heights: [...byTick.heights].reverse(),
    now: 1 - byTick.now,
    blocks: byTick.blocks.map((b) => ({ from: 1 - b.to, to: 1 - b.from, openLeft: b.openRight, openRight: b.openLeft, inRange: b.inRange })),
  };
}

export interface RoomSpark {
  signature: string;
  /** A buy pushes the price up (the spark flies in from the left); a sell pushes it down. */
  side: 'buy' | 'sell';
  /** 0.35 to 1: this swap's size against the largest swap of the same side shown. */
  size: number;
}

/** The sparks for these swaps, oldest first, so a replay runs in the order they happened. */
export function roomSparks(swaps: RoomSwap[]): RoomSpark[] {
  const largest = { token: 0n, coin: 0n };
  for (const s of swaps) if (s.inAmount > largest[s.inSide]) largest[s.inSide] = s.inAmount;
  return [...swaps]
    .sort((a, b) => a.slot - b.slot)
    .map((s) => {
      const top = largest[s.inSide];
      const share = top === 0n ? 0 : Number((s.inAmount * 10_000n) / top) / 10_000;
      // The square root, so a swap a hundredth the size is still a spark you can see.
      return { signature: s.signature, side: s.inSide === 'coin' ? 'buy' : 'sell', size: 0.35 + 0.65 * Math.sqrt(share) };
    });
}
