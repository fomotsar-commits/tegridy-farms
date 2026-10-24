/**
 * A pool's OWN recent average price, from its observation account: the price anchor for
 * a launch pool, which usually has no outside price (this pool is the token's only
 * market, and Jupiter does not route through our program).
 *
 * WHY. A launch pool can only be OPENED by the launch program, but after that anyone can
 * trade it. Someone can push its price with one swap just before a person deposits; the
 * deposit then goes in at the pushed price and the push is undone at the depositor's
 * cost. The pool's own time-weighted average barely moves for a push that is seconds
 * old, so comparing the price now with the average over the last half hour catches it.
 *
 * HOW THE PROGRAM RECORDS IT (states/oracle.rs, the source of the deployed binary).
 * Every swap, before it trades, adds `price_before_the_swap × seconds since the last
 * update` to a running sum, per side, in Q32.32 (u128, wrapping). A new slot in a ring
 * of 100 is opened at most every 15 seconds; `last_update_timestamp` is when the sum was
 * last added to. Deposits and withdrawals keep the ratio and do not write here. So:
 *   - the price from the last update until now is the pool's price right now, and the
 *     sum up to NOW is `sum_latest + price_now × (now − last_update)`;
 *   - an older slot k holds the sum up to at most 15 s after its own timestamp; using
 *     its timestamp as its time is off by at most 15 s of price, under 1% of a 30-minute
 *     window;
 *   - before the first swap, nothing is recorded (`initialized` is false) and the price
 *     is still the one the pool was opened at.
 *
 * `price_x32` for a side is "the other side per this side", in base units, times 2^32,
 * from the reserves net of fees (pool.rs token_price_x32). For the token's own side that
 * is SOL base units per token base unit.
 */

export const OBSERVATION_STATE_LEN = 4075;
/** Anchor discriminator: sha256("account:ObservationState")[0..8]. */
export const ACCOUNT_OBSERVATION_STATE = Uint8Array.from([122, 174, 197, 53, 129, 9, 165, 132]);
export const OBSERVATION_NUM = 100;
const OBS_START = 43;
const OBS_LEN = 40;
const LAST_UPDATE_OFFSET = OBS_START + OBS_LEN * OBSERVATION_NUM;

/** How far back the average reaches, when the ring holds that much history. */
export const AVERAGE_WINDOW_SECS = 30n * 60n;
/** Less history than this since the first swap, and the average proves nothing yet. */
export const MIN_HISTORY_SECS = 10n * 60n;
/** That span in words ("10 minutes"), for every sentence that names it: the number is typed once, above. */
export const MIN_HISTORY_TEXT = `${(MIN_HISTORY_SECS / 60n).toString()} minutes`;
/**
 * Why a launch pool's price was compared with nothing when its record is that short
 * (poolHealth.ts `too-new`), as the clause every screen says it in: the pool card's
 * "Checked against" row, the review's "Price check" row and the Open-a-pool card. The
 * own average is only asked for when Jupiter ANSWERED "no route", and a launch pool is
 * always paired with SOL (poolFinder.ts), so the missing price is the token's.
 */
export const TOO_NEW_WHY = `this pool has traded for under ${MIN_HISTORY_TEXT} and Jupiter has no price for this token`;

const Q32 = 1n << 32n;
const U128 = 1n << 128n;

export interface Observation {
  blockTimestamp: bigint;
  cumulative0: bigint;
  cumulative1: bigint;
}

export interface ObservationStateView {
  initialized: boolean;
  index: number;
  poolId: Uint8Array;
  observations: Observation[];
  lastUpdate: bigint;
}

function u128At(v: DataView, o: number): bigint {
  return v.getBigUint64(o, true) | (v.getBigUint64(o + 8, true) << 64n);
}

/** Decode an ObservationState (`#[repr(C, packed)]`), or null when the bytes are not one. */
export function decodeObservationState(data: Uint8Array): ObservationStateView | null {
  if (data.length < OBSERVATION_STATE_LEN) return null;
  for (let i = 0; i < 8; i++) if (data[i] !== ACCOUNT_OBSERVATION_STATE[i]) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const index = v.getUint16(9, true);
  if (index >= OBSERVATION_NUM) return null;
  const observations: Observation[] = [];
  for (let k = 0; k < OBSERVATION_NUM; k++) {
    const o = OBS_START + k * OBS_LEN;
    observations.push({ blockTimestamp: v.getBigUint64(o, true), cumulative0: u128At(v, o + 8), cumulative1: u128At(v, o + 24) });
  }
  return {
    initialized: data[8] === 1,
    index,
    poolId: data.slice(11, 43),
    observations,
    lastUpdate: v.getBigUint64(LAST_UPDATE_OFFSET, true),
  };
}

export type OwnPrice =
  /** No swap has ever happened: the price is still the one the pool was opened at. */
  | { kind: 'no-trades' }
  | { kind: 'ok'; solPerToken: number; windowSecs: bigint }
  /**
   * The record was READ, and it spans less than `MIN_HISTORY_SECS` since the pool's first
   * trade: too short for an average to prove anything. An ANSWER about the pool, not a
   * failed read (owner ruling 2026-10-07: such a pool takes deposits, with a warning).
   * Only that one branch gives it. Everything that could not be read or used stays `unread`.
   */
  | { kind: 'too-new'; historySecs: bigint }
  | { kind: 'unread'; detail: string };

/**
 * The pool's average price (SOL per whole token) over up to the last 30 minutes, ending
 * now. `tokenIsToken0` says which side is the token; reserves are net of fees.
 */
export function ownAveragePrice(input: {
  obs: ObservationStateView;
  tokenIsToken0: boolean;
  solReserve: bigint;
  tokenReserve: bigint;
  tokenDecimals: number;
  now: bigint;
}): OwnPrice {
  const { obs, tokenIsToken0, solReserve, tokenReserve, tokenDecimals, now } = input;
  if (!obs.initialized) return { kind: 'no-trades' };
  if (solReserve <= 0n || tokenReserve <= 0n) return { kind: 'unread', detail: 'the pool is empty on one side' };
  const latest = obs.observations[obs.index]!;
  const lastUpdate = obs.lastUpdate > 0n ? obs.lastUpdate : latest.blockTimestamp;
  if (latest.blockTimestamp === 0n || lastUpdate > now) return { kind: 'unread', detail: 'its price record is later than the network clock' };

  // Pick the newest slot at least AVERAGE_WINDOW old; failing that, the oldest one there is.
  const valid = obs.observations.filter((o) => o.blockTimestamp > 0n && o.blockTimestamp <= lastUpdate);
  let from: Observation | null = null;
  for (const o of valid) if (o.blockTimestamp <= now - AVERAGE_WINDOW_SECS && (!from || o.blockTimestamp > from.blockTimestamp)) from = o;
  if (!from) for (const o of valid) if (!from || o.blockTimestamp < from.blockTimestamp) from = o;
  if (!from) return { kind: 'unread', detail: 'its price record is empty' };
  const window = now - from.blockTimestamp;
  // Read, and too short: an answer, with how long the record is. Never `unread`.
  if (window < MIN_HISTORY_SECS) return { kind: 'too-new', historySecs: window };

  // Both sides, and use the one with more precision (a very cheap token's own price in
  // Q32.32 can round to a handful of units; its inverse does not).
  const ownNow = (solReserve * Q32) / tokenReserve;
  const otherNow = (tokenReserve * Q32) / solReserve;
  const own = tokenIsToken0 ? [latest.cumulative0, from.cumulative0] : [latest.cumulative1, from.cumulative1];
  const other = tokenIsToken0 ? [latest.cumulative1, from.cumulative1] : [latest.cumulative0, from.cumulative0];
  const elapsed = now - lastUpdate;
  const avgOwn = ((((own[0]! - own[1]!) % U128) + U128) % U128 + ownNow * elapsed) / window;
  const avgOther = ((((other[0]! - other[1]!) % U128) + U128) % U128 + otherNow * elapsed) / window;
  const scale = 10 ** tokenDecimals / 1e9;
  let solPerToken: number;
  if (avgOwn >= avgOther) solPerToken = (Number(avgOwn) / Number(Q32)) * scale;
  else solPerToken = avgOther > 0n ? (Number(Q32) / Number(avgOther)) * scale : NaN;
  if (!Number.isFinite(solPerToken) || solPerToken <= 0) return { kind: 'unread', detail: 'its price record does not give a usable price' };
  return { kind: 'ok', solPerToken, windowSecs: window };
}
