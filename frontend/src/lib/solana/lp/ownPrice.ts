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
  | { kind: 'unread'; detail: string };

/** Where the average starts: the newest slot at least AVERAGE_WINDOW old; failing that, the oldest one there is. */
function windowStart(obs: ObservationStateView, lastUpdate: bigint, now: bigint): Observation | null {
  const valid = obs.observations.filter((o) => o.blockTimestamp > 0n && o.blockTimestamp <= lastUpdate);
  let from: Observation | null = null;
  for (const o of valid) if (o.blockTimestamp <= now - AVERAGE_WINDOW_SECS && (!from || o.blockTimestamp > from.blockTimestamp)) from = o;
  if (!from) for (const o of valid) if (!from || o.blockTimestamp < from.blockTimestamp) from = o;
  return from;
}

/**
 * The longest stretch inside the average's window in which the pool recorded NOTHING,
 * and the window's length, both in seconds; null when the record cannot say (never
 * traded, empty, or later than the clock).
 *
 * WHY IT MATTERS. The record is written only by swaps, and each swap credits the price
 * it finds to the WHOLE stretch since the last update. The pool's reserves are its
 * vaults' live balances, so tokens or SOL sent straight into a vault move the price and
 * write nothing here. After a quiet stretch the average therefore proves nothing about
 * that stretch: with no swap since, `ownAveragePrice` fills it with the price right now
 * (it compares the price with itself), and a dust swap after the transfer writes the
 * moved price over the whole stretch. A caller that lets MONEY rest on "the price agrees
 * with its average" must also bound this number against the window (ownRoute.ts does).
 *
 * The stretches measured: between one recorded slot and the next (from the window's
 * start), from the newest slot to the last update, and from the last update to now.
 */
export function recordSilence(obs: ObservationStateView, now: bigint): { windowSecs: bigint; longestSecs: bigint } | null {
  if (!obs.initialized) return null;
  const latest = obs.observations[obs.index];
  if (!latest || latest.blockTimestamp === 0n) return null;
  const lastUpdate = obs.lastUpdate > 0n ? obs.lastUpdate : latest.blockTimestamp;
  if (lastUpdate > now) return null;
  const from = windowStart(obs, lastUpdate, now);
  if (!from) return null;
  const times = obs.observations
    .map((o) => o.blockTimestamp)
    .filter((t) => t >= from.blockTimestamp && t <= lastUpdate)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  times.push(lastUpdate, now);
  let longestSecs = 0n;
  for (let i = 1; i < times.length; i++) {
    const gap = times[i]! - times[i - 1]!;
    if (gap > longestSecs) longestSecs = gap;
  }
  return { windowSecs: now - from.blockTimestamp, longestSecs };
}

/**
 * The pool's average price (SOL per whole token) over up to the last 30 minutes, ending
 * now. `tokenIsToken0` says which side is the token; reserves are net of fees.
 *
 * It counts the time since the last recorded swap at the price right now, so it catches
 * a price pushed by a SWAP moments ago. It does not catch a price moved by sending
 * tokens straight into a vault during a quiet stretch: see `recordSilence`.
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

  const from = windowStart(obs, lastUpdate, now);
  if (!from) return { kind: 'unread', detail: 'its price record is empty' };
  const window = now - from.blockTimestamp;
  if (window < MIN_HISTORY_SECS) {
    return { kind: 'unread', detail: `it has only ${window.toString()} seconds of price history since its first trade` };
  }

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
