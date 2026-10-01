// @vitest-environment node
//
// The launch pool's own recent average, from its observation account (oracle.rs).
import { describe, it, expect } from 'vitest';
import { AVERAGE_WINDOW_SECS, MIN_HISTORY_SECS, decodeObservationState, ownAveragePrice } from './ownPrice';
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

  it('never traded is its own answer; too little history, or a record from the future, is unread', () => {
    expect(ownAveragePrice({ ...base, obs: decodeObservationState(observationBytes({ pool, initialized: false }))!, now: 10n }).kind).toBe('no-trades');
    expect(ownAveragePrice({ ...base, obs: obs([1_000n, 0n], [1_010n, 10n * Q32 * 10n], 1_010n), now: 1_000n + MIN_HISTORY_SECS - 1n }).kind).toBe('unread');
    expect(ownAveragePrice({ ...base, obs: obs([1_000n, 0n], [4_600n, 10n * Q32 * 3_600n], 4_600n), now: 4_000n }).kind).toBe('unread');
  });
});
