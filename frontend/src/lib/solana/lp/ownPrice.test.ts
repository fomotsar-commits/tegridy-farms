// @vitest-environment node
//
// The launch pool's own recent average, from its observation account (oracle.rs).
import { describe, it, expect } from 'vitest';
import { AVERAGE_WINDOW_SECS, MIN_HISTORY_SECS, MIN_HISTORY_TEXT, TOO_NEW_WHY, decodeObservationState, ownAveragePrice } from './ownPrice';
import { key, observationBytes } from './testkit.fixture';

const Q32 = 1n << 32n;
const pool = key();

describe('decodeObservationState', () => {
  it('reads the packed layout, u128 sums included, and refuses anything else', () => {
    const big = (1n << 100n) + 12345n;
    const d = decodeObservationState(observationBytes({ pool, index: 7, lastUpdate: 99n, obs: [[7, 42n, big, 5n]] }))!;
    expect(d.initialized).toBe(true);
    expect(d.index).toBe(7);
    expect(d.lastUpdate).toBe(99n);
    expect(d.observations[7]).toEqual({ blockTimestamp: 42n, cumulative0: big, cumulative1: 5n });
    expect(Buffer.from(d.poolId).equals(Buffer.from(pool.toBytes()))).toBe(true);
    const wrong = observationBytes({ pool });
    wrong[0] = 0;
    expect(decodeObservationState(wrong)).toBeNull();
    expect(decodeObservationState(observationBytes({ pool }).subarray(0, 4000))).toBeNull();
  });
});

describe('ownAveragePrice', () => {
  // A token (6 decimals) as token1, SOL as token0: "own" is cumulative1, SOL base per token base.
  const base = { tokenIsToken0: false, solReserve: 10n * 10n ** 9n, tokenReserve: 1_000n * 10n ** 6n, tokenDecimals: 6 };
  const obs = (older: [bigint, bigint], latest: [bigint, bigint], lastUpdate: bigint) =>
    decodeObservationState(observationBytes({ pool, index: 1, lastUpdate, obs: [[0, older[0], 0n, older[1]], [1, latest[0], 0n, latest[1]]] }))!;

  it('averages the price since an old enough slot, carrying the current price from the last update to now', () => {
    // 10 SOL base units per token base unit for the hour before the last update, and since.
    const r = ownAveragePrice({ ...base, obs: obs([1_000n, 0n], [4_600n, 10n * Q32 * 3_600n], 4_600n), now: 6_000n });
    expect(r.kind).toBe('ok');
    expect(r.kind === 'ok' && r.solPerToken).toBeCloseTo(0.01, 9);
    expect(r.kind === 'ok' && r.windowSecs).toBe(5_000n);
  });

  it('survives the u128 sum wrapping around', () => {
    const start = (1n << 128n) - 5n * Q32;
    const end = (start + 10n * Q32 * 3_600n) % (1n << 128n);
    const r = ownAveragePrice({ ...base, obs: obs([1_000n, start], [4_600n, end], 4_600n), now: 4_600n });
    expect(r.kind === 'ok' && r.solPerToken).toBeCloseTo(0.01, 9);
  });

  it('prefers a slot at least the window old over an older one', () => {
    const now = 100_000n;
    const d = decodeObservationState(observationBytes({
      pool, index: 2, lastUpdate: now,
      // slot 0: long ago at price 1; slot 1: exactly one window back; slot 2: now.
      obs: [[0, 1_000n, 0n, 0n], [1, now - AVERAGE_WINDOW_SECS, 0n, 1n * Q32 * (now - AVERAGE_WINDOW_SECS - 1_000n)], [2, now, 0n, 1n * Q32 * (now - AVERAGE_WINDOW_SECS - 1_000n) + 10n * Q32 * AVERAGE_WINDOW_SECS]],
    }))!;
    const r = ownAveragePrice({ ...base, obs: d, now });
    expect(r.kind === 'ok' && [r.solPerToken, r.windowSecs]).toEqual([0.01, AVERAGE_WINDOW_SECS]);
  });

  it('never traded is its own answer; a record from the future is unread', () => {
    expect(ownAveragePrice({ ...base, obs: decodeObservationState(observationBytes({ pool, initialized: false }))!, now: 10n }).kind).toBe('no-trades');
    expect(ownAveragePrice({ ...base, obs: obs([1_000n, 0n], [4_600n, 10n * Q32 * 3_600n], 4_600n), now: 4_000n }).kind).toBe('unread');
  });

  // Owner ruling 2026-10-07. A record that was READ and is shorter than the minimum is an
  // ANSWER about the pool ("too new"), with how long it is. It was `unread`, which made a
  // brand-new launch pool refuse every deposit for its first ten minutes.
  /** A record whose first slot is at 1,000 and whose last update is ten seconds later. */
  const short = () => obs([1_000n, 0n], [1_010n, 10n * Q32 * 10n], 1_010n);

  it('a record that was read and spans less than the minimum is "too new", with its length: an answer, never unread', () => {
    expect(ownAveragePrice({ ...base, obs: short(), now: 1_000n + MIN_HISTORY_SECS - 1n })).toEqual({ kind: 'too-new', historySecs: MIN_HISTORY_SECS - 1n });
    // Ten seconds after its first trade: the length is the time since that trade, to the second.
    expect(ownAveragePrice({ ...base, obs: short(), now: 1_010n })).toEqual({ kind: 'too-new', historySecs: 10n });
    // Exactly the minimum is long enough: the average is worked out.
    expect(ownAveragePrice({ ...base, obs: short(), now: 1_000n + MIN_HISTORY_SECS }).kind).toBe('ok');
  });

  // The rule that must not move: ONLY the short record is an answer. Everything that could
  // not be read or used is still `unread`, and so never a pass, even on a short record.
  it('only the short record is "too new": an empty side, a record later than the clock, an empty record and an unusable price are all still unread', () => {
    const now = 1_000n + MIN_HISTORY_SECS - 1n;
    const unread = (r: ReturnType<typeof ownAveragePrice>) => (r.kind === 'unread' ? r.detail : `not unread: ${r.kind}`);
    // A side with nothing in it, on a record that is also short.
    expect(unread(ownAveragePrice({ ...base, solReserve: 0n, obs: short(), now }))).toBe('the pool is empty on one side');
    expect(unread(ownAveragePrice({ ...base, tokenReserve: 0n, obs: short(), now }))).toBe('the pool is empty on one side');
    // The short record's last update is later than the clock that was read.
    expect(unread(ownAveragePrice({ ...base, obs: short(), now: 1_005n }))).toBe('its price record is later than the network clock');
    // No slot at or before the last update: nothing to average from.
    expect(unread(ownAveragePrice({ ...base, obs: obs([1_000n, 0n], [1_010n, 0n], 5n), now }))).toBe('its price record is empty');
    // Long enough, but the sums give a price of zero.
    expect(unread(ownAveragePrice({ ...base, obs: obs([1_000n, 0n], [4_600n, 0n], 4_600n), now: 4_600n }))).toBe('its price record does not give a usable price');
  });

  it('the minimum is said in words from the number itself, once', () => {
    expect(MIN_HISTORY_SECS).toBe(600n);
    expect(MIN_HISTORY_TEXT).toBe('10 minutes');
    expect(MIN_HISTORY_TEXT).toBe(`${Number(MIN_HISTORY_SECS) / 60} minutes`);
    expect(TOO_NEW_WHY).toBe('this pool has traded for under 10 minutes and Jupiter has no price for this token');
  });
});
