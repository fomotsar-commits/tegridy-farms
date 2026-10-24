// @vitest-environment node
// Reads the program's own vectors off disk.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ClmmMathError, Q64, U64_MAX, mulDivFloor, U128_MAX } from './math';
import type { RewardInfoView } from './program';
import { REWARD_STATE, getRewardGrowthsInside, positionRewardsAt, rewardInfosAt, rewardsOwedAfter } from './rewards';

/**
 * A position's rewards owed, held three ways: to the range program's own Rust, run on 500
 * drawn cases (scripts/clmm-vectors, section "rewards"); to the program's own unit tests in
 * states/pool.rs, ported; and to the local chain's reward checks R7A, R7 and R8
 * (solana/clmm-localnet/RESULTS.md) on a stream of the same shape.
 */

const MINT = 'RewardMint1111111111111111111111111111111111';
const DEFAULT = '11111111111111111111111111111111';

function reward(o: Partial<RewardInfoView> = {}): RewardInfoView {
  return {
    rewardState: 0, openTime: 0n, endTime: 0n, lastUpdateTime: 0n, emissionsPerSecondX64: 0n, rewardTotalEmitted: 0n, rewardClaimed: 0n,
    tokenMint: MINT, tokenVault: DEFAULT, authority: DEFAULT, rewardGrowthGlobalX64: 0n, initialized: true, ...o,
  };
}
const EMPTY = reward({ tokenMint: DEFAULT, initialized: false });
const tick = (t: number, g: bigint[] = [0n, 0n, 0n]) => ({ tick: t, rewardGrowthsOutsideX64: g });
const pos = (liquidity: bigint, last: bigint[] = [0n, 0n, 0n], owed: bigint[] = [0n, 0n, 0n], lower = -1000, upper = 1000) => ({
  liquidity,
  tickLowerIndex: lower,
  tickUpperIndex: upper,
  rewardInfos: last.map((g, i) => ({ growthInsideLastX64: g, rewardAmountOwed: owed[i]! })),
});

type Outcome = { ok: unknown } | { err: string };
interface Row {
  liquidity: string;
  tick: number;
  now: number;
  rewards: [boolean, number, number, number, number, string, string, string][];
  lower: [number, string[]];
  upper: [number, string[]];
  position: [string, [string, string][]];
  after: [number, number, string, string][];
  inside: string[];
  owed: Outcome;
}
const V = JSON.parse(readFileSync(resolve(__dirname, '__fixtures__', 'program-vectors.json'), 'utf8')) as { rewards: Row[] };

describe('the program’s own Rust, run (scripts/clmm-vectors, "rewards")', () => {
  const rows = V.rewards;
  const poolOf = (r: Row) => ({
    liquidity: BigInt(r.liquidity),
    tickCurrent: r.tick,
    rewardInfos: r.rewards.map(([init, state, open, end, last, eps, emitted, growth]) =>
      reward({ initialized: init, tokenMint: init ? MINT : DEFAULT, rewardState: state, openTime: BigInt(open), endTime: BigInt(end), lastUpdateTime: BigInt(last), emissionsPerSecondX64: BigInt(eps), rewardTotalEmitted: BigInt(emitted), rewardGrowthGlobalX64: BigInt(growth) }),
    ),
  });
  const positionOf = (r: Row) => pos(BigInt(r.position[0]), r.position[1].map((x) => BigInt(x[0])), r.position[1].map((x) => BigInt(x[1])), r.lower[0], r.upper[0]);
  const ticksOf = (r: Row) => [tick(r.lower[0], r.lower[1].map(BigInt)), tick(r.upper[0], r.upper[1].map(BigInt))] as const;

  it('covers every branch: no liquidity, before the start, past the end, emitted at its cap, an owed total past u64', () => {
    expect(rows.length).toBe(500);
    expect(rows.some((r) => r.liquidity === '0')).toBe(true);
    expect(rows.some((r) => r.rewards.some((x) => x[0] && BigInt(r.now) <= BigInt(x[2])))).toBe(true);
    expect(rows.some((r) => r.rewards.some((x) => x[0] && BigInt(r.now) > BigInt(x[3])))).toBe(true);
    expect(rows.some((r) => r.rewards.some((x) => x[0] && BigInt(x[6]) === U64_MAX))).toBe(true);
    expect(rows.some((r) => r.rewards.some((x) => !x[0]))).toBe(true);
    expect(rows.some((r) => 'err' in r.owed && r.owed.err === 'CalculateOverflow')).toBe(true);
    expect(rows.filter((r) => 'ok' in r.owed).length).toBeGreaterThan(300);
  });

  it('update_reward_infos to the clock: state, last update, emitted and growth, for every slot', () => {
    for (const r of rows) {
      const after = rewardInfosAt(poolOf(r), BigInt(r.now));
      expect(after.map((a) => [a.rewardState, Number(a.lastUpdateTime), a.rewardTotalEmitted.toString(), a.rewardGrowthGlobalX64.toString()]), JSON.stringify(r)).toEqual(r.after);
    }
  });

  it('get_reward_growths_inside from the two ticks', () => {
    for (const r of rows) {
      const [lo, hi] = ticksOf(r);
      const inside = getRewardGrowthsInside(lo, hi, r.tick, rewardInfosAt(poolOf(r), BigInt(r.now)));
      expect(inside.map(String), JSON.stringify(r)).toEqual(r.inside);
    }
  });

  it('update_rewards on a change: the owed amounts, or the same CalculateOverflow', () => {
    for (const r of rows) {
      let got: Outcome;
      try {
        got = { ok: rewardsOwedAfter(positionOf(r), r.inside.map(BigInt)).map(String) };
      } catch (e) {
        if (!(e instanceof ClmmMathError)) throw e;
        got = { err: e.code };
      }
      expect(got, JSON.stringify(r)).toEqual(r.owed);
    }
  });

  it('the whole sum, as the positions card works it out: each running reward’s owed, or null where the program refuses', () => {
    for (const r of rows) {
      const [lo, hi] = ticksOf(r);
      const got = positionRewardsAt(poolOf(r), positionOf(r), lo, hi, BigInt(r.now));
      const live = r.rewards.map((x, i) => ({ init: x[0], i })).filter((x) => x.init);
      // An empty position is owed what its record says: the program adds a delta times zero.
      const want = 'ok' in r.owed ? live.map(({ i }) => ({ index: i, mint: MINT, owed: BigInt((r.owed as { ok: string[] }).ok[i]!) })) : null;
      expect(got, JSON.stringify(r)).toEqual(live.length === 0 ? [] : want);
    }
  });
});

describe('states/pool.rs unit tests, ported', () => {
  it('reward_info_test: nothing before the start, no growth with no liquidity, 10 per unit after 100 s at 10 a second over 100, stops at the end', () => {
    const start = reward({ openTime: 1665982800n, endTime: 1666069200n, lastUpdateTime: 1665982800n, emissionsPerSecondX64: 10n });
    const p0 = { liquidity: 0n, rewardInfos: [start, EMPTY, EMPTY] };
    expect(rewardInfosAt(p0, 1665982700n)[0]).toEqual(start);
    const a = rewardInfosAt(p0, 1665982900n);
    expect(a[0]!.rewardGrowthGlobalX64).toBe(0n);
    const b = rewardInfosAt({ liquidity: 100n, rewardInfos: a }, 1665983000n);
    expect(b[0]!.lastUpdateTime).toBe(1665983000n);
    expect(b[0]!.rewardGrowthGlobalX64).toBe(10n);
    const c = rewardInfosAt({ liquidity: 100n, rewardInfos: b }, 1666069300n);
    expect(c[0]!.lastUpdateTime).toBe(1666069200n);
    expect(c[0]!.rewardState).toBe(REWARD_STATE.ended);
  });

  it('reward_total_emitted_uses_ceil_to_stay_solvent: ten 1 s steps of half a coin keep emitted at or above what can be claimed', () => {
    const liquidity = 1_000_000_000_000n;
    const startAt = 1_700_000_000n;
    let infos = [reward({ openTime: startAt, endTime: startAt + 1000n, lastUpdateTime: startAt, emissionsPerSecondX64: Q64 / 2n }), EMPTY, EMPTY];
    let floorEmitted = 0n;
    for (let s = 1n; s <= 10n; s++) {
      infos = rewardInfosAt({ liquidity, rewardInfos: infos }, startAt + s);
      floorEmitted += mulDivFloor(1n, Q64 / 2n, Q64, U128_MAX)!;
    }
    const claimable = mulDivFloor(infos[0]!.rewardGrowthGlobalX64, liquidity, Q64, U128_MAX)!;
    expect(claimable > 0n).toBe(true);
    expect(infos[0]!.rewardTotalEmitted >= claimable).toBe(true);
    expect(floorEmitted < claimable).toBe(true);
  });
});

describe('the local chain’s reward checks (solana/clmm-localnet/RESULTS.md), on a stream of the same shape', () => {
  // R5: the vault set BAYLA (6 decimals) to 1 a second over a 90 s window. The price sits at
  // tick 0 the whole time, and every tick was made before the stream began (outside growth 0).
  const BAYLA = 1_000_000n;
  const OPEN = 1_792_552_707n;
  const END = OPEN + 90n;
  const lps = {
    alice: pos(6_000_000_000_000n, undefined, undefined, -1200, 1200),
    erin: pos(10_000_000_000n, undefined, undefined, -600, 600),
    opener: pos(3_900_000_000_000n, undefined, undefined, -240, 240),
    bob: pos(2_000_000_000_000n, undefined, undefined, 1200, 3600),
    carol: pos(2_000_000_000_000n, undefined, undefined, -3600, -1200),
    dave: pos(1_000_000_000_000n, undefined, undefined, 24000, 36000),
  };
  type Lp = keyof typeof lps;
  const inRangeLiquidity = lps.alice.liquidity + lps.erin.liquidity + lps.opener.liquidity;
  let pool = { liquidity: inRangeLiquidity, tickCurrent: 0, rewardInfos: [reward({ openTime: OPEN, endTime: END, lastUpdateTime: OPEN, emissionsPerSecondX64: BAYLA << 64n, rewardState: REWARD_STATE.initialized }), EMPTY, EMPTY] };
  const owedAt = (who: Lp, t: bigint) => {
    const p = lps[who];
    return positionRewardsAt(pool, p, tick(p.tickLowerIndex), tick(p.tickUpperIndex), t)![0]!.owed;
  };
  /** A take-out at `t`: the pool's counters move to `t`, the position is paid and its growth mark moves. */
  const collect = (who: Lp, t: bigint) => {
    const paid = owedAt(who, t);
    pool = { ...pool, rewardInfos: rewardInfosAt(pool, t) };
    const p = lps[who];
    const inside = getRewardGrowthsInside(tick(p.tickLowerIndex), tick(p.tickUpperIndex), pool.tickCurrent, pool.rewardInfos);
    lps[who] = { ...p, rewardInfos: inside.map((g) => ({ growthInsideLastX64: g, rewardAmountOwed: 0n })) };
    return paid;
  };

  it('R6, R7A, R7, R8: in range collects no more than the stream paid so far; out of range earns 0; together, what was emitted and never more', () => {
    // R6: anyone brings the counters up to date at 30 s; it moves no coin.
    pool = { ...pool, rewardInfos: rewardInfosAt(pool, OPEN + 30n) };
    // R7A: alice, in range, at 31 s.
    const alice1 = collect('alice', OPEN + 31n);
    expect(alice1 > 0n && alice1 <= 31n * BAYLA).toBe(true);
    // R7: dave's far range, and the two on either side of the price, earn nothing.
    for (const k of ['dave', 'bob', 'carol'] as const) expect(owedAt(k, OPEN + 31n)).toBe(0n);
    // R8: everyone collects after the end; the counters stop at the end.
    expect(owedAt('alice', END + 3n)).toBe(owedAt('alice', END + 1_000n));
    let claimed = alice1;
    for (const k of Object.keys(lps) as Lp[]) claimed += collect(k, END + 3n);
    const emitted = pool.rewardInfos[0]!.rewardTotalEmitted;
    expect(emitted).toBe(90n * BAYLA);
    expect(claimed <= emitted).toBe(true);
    expect(Number(claimed) >= 0.999 * Number(emitted)).toBe(true);
    expect(pool.rewardInfos[0]!.rewardState).toBe(REWARD_STATE.ended);
  });
});

describe('a figure that could not be worked out is null, never 0', () => {
  const running = { liquidity: 10n ** 12n, tickCurrent: 0, rewardInfos: [reward({ openTime: 100n, endTime: 1_000n, lastUpdateTime: 100n, emissionsPerSecondX64: 5n << 64n }), EMPTY, EMPTY] };
  it('no clock, a tick that did not read, or a tick that is not the position’s own', () => {
    const p = pos(10n ** 9n);
    expect(positionRewardsAt(running, p, tick(-1000), tick(1000), null)).toBeNull();
    expect(positionRewardsAt(running, p, null, tick(1000), 500n)).toBeNull();
    expect(positionRewardsAt(running, p, tick(-1000), tick(990), 500n)).toBeNull();
    expect(positionRewardsAt(running, p, tick(-1000), tick(1000), 500n)![0]!.owed > 0n).toBe(true);
  });
  it('a pool with no reward owes none, read or not; an empty position is owed what its record says, clock or not', () => {
    expect(positionRewardsAt({ ...running, rewardInfos: [EMPTY, EMPTY, EMPTY] }, pos(10n ** 9n), null, null, null)).toEqual([]);
    expect(positionRewardsAt(running, pos(0n, undefined, [42n, 0n, 0n]), null, null, null)).toEqual([{ index: 0, mint: MINT, owed: 42n }]);
  });
  it('an owed total past u64, which the program refuses, is null', () => {
    expect(positionRewardsAt(running, pos(10n ** 9n, undefined, [U64_MAX, 0n, 0n]), tick(-1000), tick(1000), 500n)).toBeNull();
  });
});
