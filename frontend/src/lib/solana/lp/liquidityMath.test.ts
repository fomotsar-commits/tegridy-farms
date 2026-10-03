// @vitest-environment node
//
// The numbers a deposit or a withdrawal carries. Every rule here is the pool program's
// (constant_product.rs, deposit.rs, withdraw.rs); each test names the mutant it kills.
import { describe, it, expect } from 'vitest';
import { lpTokensToTradingTokens } from '../cpswap/math';
import type { PoolStateView } from '../cpswap/program';
import type { PoolSnapshot } from '../cpswap/read';
import {
  LOCKED_LP,
  MAX_LOCK_BPS,
  U64_MAX,
  feeReserveFor,
  isPlanProblem,
  isqrt,
  openingProblem,
  planCreate,
  lpForMaxIn,
  maxInFor,
  minLpForBothSides,
  minOutFor,
  planDeposit,
  planWithdraw,
  spendableSol,
  type PlanProblem,
  type WithdrawPlan,
} from './liquidityMath';
// The write layer's own constants, in the test only: liquidityMath stays web3-free.
import { LAMPORTS_PER_SIGNATURE, MAX_OWN_PRIORITY_LAMPORTS } from '../../launcher/solana/write/budget';
import { LP_FEE_RESERVE } from '../../launcher/solana/write/liquidity';

/** A snapshot with only what the maths reads: `lpSupply` and the two reserves. */
function snap(S: bigint, R0: bigint, R1: bigint): PoolSnapshot {
  return { pool: { lpSupply: S } as PoolStateView, vault0Amount: R0, vault1Amount: R1, reserve0: R0, reserve1: R1 };
}

/** A small deterministic generator, so a failure names a case that can be run again. */
function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  /** A bigint in [1, 10^digits], spread over every size up to that. */
  const big = (digits: number) => {
    const d = 1 + Math.floor(next() * digits);
    let v = 0n;
    for (let i = 0; i < d; i++) v = v * 10n + BigInt(Math.floor(next() * 10));
    return v < 1n ? 1n : v;
  };
  return { next, big };
}

const ok = <T extends object>(p: T | PlanProblem): T => {
  if ('problem' in p) throw new Error(`expected a plan, got ${p.problem}`);
  return p;
};

describe('lpForMaxIn: the typed number is the most that can leave', () => {
  it('over 20,000 random pools: the cost never exceeds the typed amount, and the headroom is the tolerance less at most one unit', () => {
    const r = rng(20260930);
    let checked = 0;
    for (let i = 0; i < 20_000; i++) {
      const S = r.big(18);
      const R = r.big(18);
      const maxIn = r.big(16);
      const bps = BigInt(1 + Math.floor(r.next() * 500));
      const lp = lpForMaxIn(maxIn, R, S, bps)!;
      if (lp === 0n) continue;
      // The program's own ceiling (a side at 0 stays 0, so give the other side the same reserve).
      const cost = lpTokensToTradingTokens(lp, S, R, R, 'ceiling')!.token0Amount;
      expect(cost <= maxIn, `S=${S} R=${R} maxIn=${maxIn} bps=${bps}`).toBe(true);
      expect(maxIn - cost >= (cost * bps) / 10_000n - 1n, `headroom S=${S} R=${R} maxIn=${maxIn} bps=${bps}`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(10_000);
  });

  it('no price on that side is null, never 0', () => {
    expect(lpForMaxIn(10n, 0n, 1_000n, 100n)).toBeNull();
    expect(lpForMaxIn(10n, 5n, 0n, 100n)).toBeNull();
  });
});

describe('maxInFor and minOutFor: the bounds round the safe way', () => {
  it('maxInFor rounds UP: 101 at 1% is 103, never 102, and is never below the cost', () => {
    expect(maxInFor(101n, 100n)).toBe(103n);
    const r = rng(7);
    for (let i = 0; i < 2_000; i++) {
      const cost = r.big(15);
      const bps = BigInt(Math.floor(r.next() * 501));
      expect(maxInFor(cost, bps) >= cost).toBe(true);
      expect(maxInFor(cost, bps) * 10_000n >= cost * (10_000n + bps)).toBe(true);
    }
  });

  it('minOutFor is never 0 while the payout is at least 1, and never above the payout', () => {
    expect(minOutFor(1n, 500n)).toBe(1n);
    expect(minOutFor(10n, 500n)).toBe(9n);
    const r = rng(11);
    for (let i = 0; i < 2_000; i++) {
      const out = r.big(15);
      const bps = BigInt(Math.floor(r.next() * 501));
      const m = minOutFor(out, bps);
      expect(m >= 1n && m <= out).toBe(true);
    }
  });
});

describe('minLpForBothSides: the program’s 6006 boundary, both directions', () => {
  it('one share below the threshold gives a zero side on a deposit and a withdrawal; the threshold itself gives both sides', () => {
    const s = snap(1_000_000n, 3_000n, 70_000n);
    const t = minLpForBothSides(s)!;
    expect(t).toBe(334n); // ceil(1e6 / 3000)
    for (const dir of ['ceiling', 'floor'] as const) {
      const below = lpTokensToTradingTokens(t - 1n, 1_000_000n, 3_000n, 70_000n, dir)!;
      expect(below.token0Amount === 0n || below.token1Amount === 0n).toBe(true);
      const at = lpTokensToTradingTokens(t, 1_000_000n, 3_000n, 70_000n, dir)!;
      expect(at.token0Amount > 0n && at.token1Amount > 0n).toBe(true);
    }
  });

  it('a pool with an empty side has no minimum', () => {
    expect(minLpForBothSides(snap(1_000n, 0n, 5n))).toBeNull();
    expect(minLpForBothSides(snap(0n, 5n, 5n))).toBeNull();
  });
});

describe('planDeposit', () => {
  const base = { solIsToken0: true, bps: 100n, availableSol: null, availableToken: null } as const;

  it('refuses a deposit with a zero side (r1: S=1000, R0=5 and one share costs {0, 5})', () => {
    const s = snap(1_000n, 5n, 5_000n);
    // SOL is token0 here; typing 6 tokens buys exactly one share.
    const p = planDeposit(s, { ...base, driving: 'token', maxIn: 6n });
    expect(p).toEqual({ problem: 'too-small', minLp: 200n });
  });

  it('refuses a typed amount too small to buy one share', () => {
    expect(planDeposit(snap(1_000n, 5_000n, 5_000n), { ...base, driving: 'sol', maxIn: 1n })).toMatchObject({ problem: 'too-small' });
  });

  it('refuses past u64: a value, a maximum of u64::MAX, and a supply after the deposit', () => {
    // A value past u64: the share count itself.
    expect(planDeposit(snap(U64_MAX, 1n, 1n), { ...base, driving: 'sol', maxIn: 1n << 70n })).toEqual({ problem: 'overflow' });
    // A maximum of u64::MAX means "no limit"; it is never carried.
    expect(planDeposit(snap(1_000n, 10n ** 18n, 10n ** 18n), { ...base, driving: 'sol', maxIn: U64_MAX })).toEqual({ problem: 'overflow' });
    // The pool's supply after the deposit must still fit a u64.
    const nearFull = snap(U64_MAX - 10n, 10n ** 9n, 10n ** 9n);
    expect(planDeposit(nearFull, { ...base, driving: 'sol', maxIn: 10n ** 9n })).toEqual({ problem: 'overflow' });
  });

  it('refuses a pool with no price', () => {
    expect(planDeposit(snap(0n, 5n, 5n), { ...base, driving: 'sol', maxIn: 100n })).toEqual({ problem: 'no-price' });
    expect(planDeposit(snap(10n, 0n, 5n), { ...base, driving: 'sol', maxIn: 100n })).toEqual({ problem: 'no-price' });
    // The empty side is not the one typed in: still no price, never "too small".
    expect(planDeposit(snap(10n, 0n, 5n), { ...base, driving: 'token', maxIn: 100n })).toEqual({ problem: 'no-price' });
  });

  it('the driving side’s maximum is exactly the typed number; the other side’s is the cost plus the tolerance, rounded up', () => {
    const s = snap(1_000_000n, 10n ** 9n, 10n ** 12n); // SOL = token0
    const p = ok(planDeposit(s, { ...base, driving: 'sol', maxIn: 1_000_000n }));
    expect(p.max0).toBe(1_000_000n);
    expect(p.cost0 <= p.max0).toBe(true);
    expect(p.max1).toBe(maxInFor(p.cost1, 100n));
    expect(p.limitedByBalance).toBe('none');
    // Driving from the token side puts the typed number on token1.
    const q = ok(planDeposit(s, { ...base, driving: 'token', maxIn: 5_000_000n }));
    expect(q.max1).toBe(5_000_000n);
    expect(q.max0).toBe(maxInFor(q.cost0, 100n));
  });

  it('works against the pool’s lp_supply, not the share mint’s supply (a launch pool burned its own shares)', () => {
    // lp_supply 10^12 while the mint might hold only a sliver of that: the share is S-based.
    const S = 10n ** 12n;
    const s = snap(S, 10n ** 9n, 10n ** 15n);
    const p = ok(planDeposit(s, { ...base, driving: 'sol', maxIn: 10n ** 7n }));
    expect(p.lp).toBe((10n ** 7n * S * 10_000n) / (10n ** 9n * 10_100n));
    expect(p.lp).toBeGreaterThan(9_000_000_000n);
  });

  it('lowers the other side’s maximum to the balance when the cost still fits, and refuses when it does not', () => {
    const s = snap(1_000_000n, 10n ** 9n, 10n ** 12n); // SOL = token0, 1,000 tokens per lamport
    const want = ok(planDeposit(s, { ...base, driving: 'sol', maxIn: 1_000_000n }));
    // A token balance between the cost and the maximum: the maximum becomes the balance.
    const between = want.cost1 + (want.max1 - want.cost1) / 2n;
    const limited = ok(planDeposit(s, { ...base, driving: 'sol', maxIn: 1_000_000n, availableToken: between }));
    expect(limited.max1).toBe(between);
    expect(limited.limitedByBalance).toBe('token');
    // A balance below the cost: refused, with the most both balances allow.
    const short = planDeposit(s, { ...base, driving: 'sol', maxIn: 1_000_000n, availableToken: want.cost1 - 1n, availableSol: 5_000_000n });
    expect(short).toMatchObject({ problem: 'over-balance', side: 'token', need: want.cost1, have: want.cost1 - 1n });
    if (!isPlanProblem(short) || short.problem !== 'over-balance') throw new Error('expected over-balance');
    // That most-both amount plans without a problem.
    expect(short.mostBoth).not.toBeNull();
    const again = planDeposit(s, { ...base, driving: 'sol', maxIn: short.mostBoth!, availableToken: want.cost1 - 1n, availableSol: 5_000_000n });
    expect(isPlanProblem(again)).toBe(false);
  });

  it('refuses a typed amount above the driving side’s own balance', () => {
    const s = snap(1_000_000n, 10n ** 9n, 10n ** 12n);
    expect(planDeposit(s, { ...base, driving: 'sol', maxIn: 2_000_000n, availableSol: 1_999_999n })).toMatchObject({
      problem: 'over-balance', side: 'sol', need: 2_000_000n, have: 1_999_999n,
    });
  });
});

describe('planWithdraw', () => {
  const s = snap(1_000_000n, 10n ** 9n, 10n ** 12n);

  it('All is exactly the balance held, and the payout is the program’s floor', () => {
    const p = ok<WithdrawPlan>(planWithdraw(s, { held: 123_457n, pctBps: 10_000n, bps: 100n }));
    expect(p).toMatchObject({ lp: 123_457n, all: true, keep: 0n });
    const out = lpTokensToTradingTokens(123_457n, 1_000_000n, 10n ** 9n, 10n ** 12n, 'floor')!;
    expect([p.out0, p.out1]).toEqual([out.token0Amount, out.token1Amount]);
  });

  it('refuses a remainder too small to ever take out, and allows taking it all', () => {
    // At this pool one side needs ceil(1e6/3000) = 334 shares; 1,000 held, 70% leaves 300.
    const thin = snap(1_000_000n, 3_000n, 10n ** 12n);
    expect(planWithdraw(thin, { held: 1_000n, pctBps: 7_000n, bps: 100n })).toEqual({ problem: 'dust-remainder', keep: 300n, minLp: 334n });
    expect(isPlanProblem(planWithdraw(thin, { held: 1_000n, pctBps: 10_000n, bps: 100n }))).toBe(false);
    // Half leaves 500, which can still come out later.
    expect(isPlanProblem(planWithdraw(thin, { held: 1_000n, pctBps: 5_000n, bps: 100n }))).toBe(false);
  });

  it('refuses a share with a zero side, a bad percent and an empty account', () => {
    const thin = snap(1_000_000n, 3_000n, 10n ** 12n);
    expect(planWithdraw(thin, { held: 300n, pctBps: 10_000n, bps: 100n })).toEqual({ problem: 'too-small', minLp: 334n });
    for (const pctBps of [0n, 10_001n]) expect(planWithdraw(s, { held: 5n, pctBps, bps: 100n })).toEqual({ problem: 'bad-percent' });
    expect(planWithdraw(s, { held: 0n, pctBps: 5_000n, bps: 100n })).toEqual({ problem: 'nothing-held' });
  });

  it('the minima are at least 1 on each side, and never above the payout', () => {
    const tiny = snap(1_000n, 1_000n, 10n ** 9n);
    const p = ok<WithdrawPlan>(planWithdraw(tiny, { held: 1n, pctBps: 10_000n, bps: 500n }));
    expect(p.out0).toBe(1n);
    expect(p.min0).toBe(1n);
    expect(p.min1 <= p.out1 && p.min1 >= 1n).toBe(true);
  });
});

describe('spendableSol: the rent band, one term at a time', () => {
  const a = { lamports: 10_000_000n, walletFloor: 890_880n, feeReserve: 1_005_000n, lpAccountRent: 2_039_280n, wsolCreateRent: 2_039_280n };

  it('holds back the fee reserve, the LP account’s rent, and the larger of the WSOL rent and the wallet’s floor', () => {
    expect(spendableSol(a)).toBe(10_000_000n - 1_005_000n - 2_039_280n - 2_039_280n);
    // Each term on its own, so dropping any one of them fails here.
    expect(spendableSol({ ...a, feeReserve: 0n }) - spendableSol(a)).toBe(1_005_000n);
    expect(spendableSol({ ...a, lpAccountRent: 0n }) - spendableSol(a)).toBe(2_039_280n);
    // With the WSOL account already there, the wallet's own floor is what stays.
    expect(spendableSol({ ...a, wsolCreateRent: 0n })).toBe(10_000_000n - 1_005_000n - 2_039_280n - 890_880n);
    // The floor and the WSOL rent are not added: the WSOL rent is paid during, the floor kept at the end.
    expect(spendableSol({ ...a, walletFloor: 3_000_000n })).toBe(10_000_000n - 1_005_000n - 2_039_280n - 3_000_000n);
  });

  it('is never negative', () => {
    expect(spendableSol({ ...a, lamports: 1_000n })).toBe(0n);
  });
});

// ── opening a pool (SPEC_S2_CREATE N8) ───────────────────────────────────────

describe('isqrt: the exact floor square root the program takes of init0·init1', () => {
  const isFloorRoot = (n: bigint, r: bigint) => r * r <= n && n < (r + 1n) * (r + 1n);

  it('is exact on 20,000 random products up to (2^64 − 1)², far past where a float root drifts', () => {
    const r = rng(7);
    const u64 = () => {
      // A random size, then random bits: every magnitude up to u64::MAX is reached.
      const bits = 1 + Math.floor(r.next() * 64);
      let v = 0n;
      for (let i = 0; i < bits; i++) v = (v << 1n) | (r.next() < 0.5 ? 0n : 1n);
      return v | (1n << BigInt(bits - 1));
    };
    for (let i = 0; i < 20_000; i++) {
      const n = u64() * u64();
      const root = isqrt(n);
      if (!isFloorRoot(n, root)) throw new Error(`isqrt(${n}) = ${root}`);
    }
  });

  it('at the edges: 0 to 4, around 100, and around k² for k = 2^32 and 2^64 − 1', () => {
    expect([0n, 1n, 2n, 3n, 4n].map(isqrt)).toEqual([0n, 1n, 1n, 1n, 2n]);
    expect([99n, 100n, 101n].map(isqrt)).toEqual([9n, 10n, 10n]);
    for (const k of [1n << 32n, U64_MAX]) {
      expect(isqrt(k * k - 1n)).toBe(k - 1n);
      expect(isqrt(k * k)).toBe(k);
      expect(isqrt(k * k + 1n)).toBe(k);
    }
  });

  it('refuses a negative number', () => {
    expect(() => isqrt(-1n)).toThrow(RangeError);
  });
});

describe('openingProblem: the site’s share rule for a new pool', () => {
  it('the locked part is the program’s 100 shares, at most 0.1% of the pool', () => {
    expect(LOCKED_LP).toBe(100n);
    expect(MAX_LOCK_BPS).toBe(10n);
  });

  it('an empty side', () => {
    expect(openingProblem(0n, 5n)).toEqual({ problem: 'empty-side' });
    expect(openingProblem(5n, 0n)).toEqual({ problem: 'empty-side' });
  });

  it('a side past u64', () => {
    expect(openingProblem(U64_MAX + 1n, 5n)).toEqual({ problem: 'overflow' });
    expect(openingProblem(5n, U64_MAX + 1n)).toEqual({ problem: 'overflow' });
  });

  it('isqrt exactly 100 is too small: the program would LAND it and give the opener 0 shares', () => {
    expect(openingProblem(100n, 100n)).toEqual({ problem: 'too-small', supply: 100n });
    expect(openingProblem(99n, 100n)).toEqual({ problem: 'too-small', supply: 99n });
  });

  it('above 100 but under 100,000 locks more than 0.1%', () => {
    expect(openingProblem(101n, 101n)).toEqual({ problem: 'lock-too-large', supply: 101n });
    expect(openingProblem(99_999n, 99_999n)).toEqual({ problem: 'lock-too-large', supply: 99_999n });
  });

  it('100,000 shares exactly is allowed, and so is any real opening', () => {
    expect(openingProblem(100_000n, 100_000n)).toBeNull();
    // 0.1 SOL against 10^12 token units: 10^10 shares.
    expect(openingProblem(100_000_000n, 1_000_000_000_000n)).toBeNull();
    expect(openingProblem(U64_MAX, U64_MAX)).toBeNull();
  });
});

describe('planCreate: an opening of exactly what was typed', () => {
  const base = { solIsToken0: true, sol: 1_000_000_000n, token: 5_000_000n, availableSol: 2_000_000_000n, availableToken: 9_000_000n };

  it('puts SOL on the SOL side, the shares are isqrt, the opener gets supply − 100, and the locked part floors', () => {
    const p = planCreate(base);
    if ('problem' in p) throw new Error(p.problem);
    const supply = isqrt(1_000_000_000n * 5_000_000n);
    expect(p).toEqual({
      init0: 1_000_000_000n,
      init1: 5_000_000n,
      supply,
      lp: supply - 100n,
      locked: { sol: (100n * 1_000_000_000n) / supply, token: (100n * 5_000_000n) / supply },
    });
    // 100·5,000,000 / 70,710,678 = 7.07…: floored, never rounded up.
    expect(p.locked.token).toBe(7n);
  });

  it('with SOL as token1 the sides swap, and only then', () => {
    const p = planCreate({ ...base, solIsToken0: false });
    if ('problem' in p) throw new Error(p.problem);
    expect([p.init0, p.init1]).toEqual([5_000_000n, 1_000_000_000n]);
  });

  it('each side over what the wallet can put in, naming it', () => {
    expect(planCreate({ ...base, availableSol: 999_999_999n })).toEqual({ problem: 'over-balance', side: 'sol', need: 1_000_000_000n, have: 999_999_999n });
    expect(planCreate({ ...base, availableToken: 4_999_999n })).toEqual({ problem: 'over-balance', side: 'token', need: 5_000_000n, have: 4_999_999n });
    // Exactly the balance is fine.
    expect('problem' in planCreate({ ...base, availableSol: 1_000_000_000n, availableToken: 5_000_000n })).toBe(false);
  });

  it('a balance that was not read runs no rule, and is never taken as 0', () => {
    expect('problem' in planCreate({ ...base, availableSol: null, availableToken: null })).toBe(false);
  });

  it('the share rule comes first', () => {
    expect(planCreate({ ...base, sol: 100n, token: 100n, availableSol: 1n })).toEqual({ problem: 'too-small', supply: 100n });
    expect(planCreate({ ...base, sol: 0n })).toEqual({ problem: 'empty-side' });
  });
});

describe('spendableSol with what an opening also pays', () => {
  const a = { lamports: 400_000_000n, walletFloor: 890_880n, feeReserve: 1_010_000n, lpAccountRent: 2_039_280n, wsolCreateRent: 2_039_280n };

  it('without alsoPaid, the answer is the deposit one, for 1,000 random wallets', () => {
    const r = rng(11);
    for (let i = 0; i < 1_000; i++) {
      const w = { lamports: r.big(12), walletFloor: r.big(7), feeReserve: r.big(7), lpAccountRent: r.big(7), wsolCreateRent: r.next() < 0.5 ? 0n : r.big(7) };
      const hold = w.wsolCreateRent > w.walletFloor ? w.wsolCreateRent : w.walletFloor;
      const left = w.lamports - w.feeReserve - w.lpAccountRent - hold;
      expect(spendableSol(w)).toBe(left > 0n ? left : 0n);
      expect(spendableSol({ ...w, alsoPaid: 0n })).toBe(spendableSol(w));
    }
  });

  it('holds back the fee to open and the deposits that never come back, once, beside every other term', () => {
    const paid = 150_000_000n + 40_000_000n;
    expect(spendableSol({ ...a, alsoPaid: paid })).toBe(400_000_000n - 1_010_000n - 2_039_280n - paid - 2_039_280n);
    expect(spendableSol(a) - spendableSol({ ...a, alsoPaid: paid })).toBe(paid);
    expect(spendableSol({ ...a, alsoPaid: paid, feeReserve: 0n }) - spendableSol({ ...a, alsoPaid: paid })).toBe(1_010_000n);
    expect(spendableSol({ ...a, alsoPaid: paid, lpAccountRent: 0n }) - spendableSol({ ...a, alsoPaid: paid })).toBe(2_039_280n);
    expect(spendableSol({ ...a, alsoPaid: paid, wsolCreateRent: 0n }) - spendableSol({ ...a, alsoPaid: paid })).toBe(2_039_280n - 890_880n);
    expect(spendableSol({ ...a, alsoPaid: 10n ** 12n })).toBe(0n);
  });
});

describe('feeReserveFor', () => {
  it('one signature is the deposit reserve; two add exactly one more signature', () => {
    expect(feeReserveFor(1)).toBe(LP_FEE_RESERVE);
    expect(feeReserveFor(1)).toBe(LAMPORTS_PER_SIGNATURE + MAX_OWN_PRIORITY_LAMPORTS);
    expect(feeReserveFor(2)).toBe(2n * LAMPORTS_PER_SIGNATURE + MAX_OWN_PRIORITY_LAMPORTS);
  });
});
