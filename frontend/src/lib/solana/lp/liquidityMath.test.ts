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
  const base = { quoteIsToken0: true, bps: 100n, availableQuote: null, availableToken: null } as const;

  it('refuses a deposit with a zero side (r1: S=1000, R0=5 and one share costs {0, 5})', () => {
    const s = snap(1_000n, 5n, 5_000n);
    // SOL is token0 here; typing 6 tokens buys exactly one share.
    const p = planDeposit(s, { ...base, driving: 'token', maxIn: 6n });
    expect(p).toEqual({ problem: 'too-small', minLp: 200n });
  });

  it('refuses a typed amount too small to buy one share', () => {
    expect(planDeposit(snap(1_000n, 5_000n, 5_000n), { ...base, driving: 'quote', maxIn: 1n })).toMatchObject({ problem: 'too-small' });
  });

  it('refuses past u64: a value, a maximum of u64::MAX, and a supply after the deposit', () => {
    // A value past u64: the share count itself.
    expect(planDeposit(snap(U64_MAX, 1n, 1n), { ...base, driving: 'quote', maxIn: 1n << 70n })).toEqual({ problem: 'overflow' });
    // A maximum of u64::MAX means "no limit"; it is never carried.
    expect(planDeposit(snap(1_000n, 10n ** 18n, 10n ** 18n), { ...base, driving: 'quote', maxIn: U64_MAX })).toEqual({ problem: 'overflow' });
    // The pool's supply after the deposit must still fit a u64.
    const nearFull = snap(U64_MAX - 10n, 10n ** 9n, 10n ** 9n);
    expect(planDeposit(nearFull, { ...base, driving: 'quote', maxIn: 10n ** 9n })).toEqual({ problem: 'overflow' });
  });

  it('refuses a pool with no price', () => {
    expect(planDeposit(snap(0n, 5n, 5n), { ...base, driving: 'quote', maxIn: 100n })).toEqual({ problem: 'no-price' });
    expect(planDeposit(snap(10n, 0n, 5n), { ...base, driving: 'quote', maxIn: 100n })).toEqual({ problem: 'no-price' });
    // The empty side is not the one typed in: still no price, never "too small".
    expect(planDeposit(snap(10n, 0n, 5n), { ...base, driving: 'token', maxIn: 100n })).toEqual({ problem: 'no-price' });
  });

  it('the driving side’s maximum is exactly the typed number; the other side’s is the cost plus the tolerance, rounded up', () => {
    const s = snap(1_000_000n, 10n ** 9n, 10n ** 12n); // SOL = token0
    const p = ok(planDeposit(s, { ...base, driving: 'quote', maxIn: 1_000_000n }));
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
    const p = ok(planDeposit(s, { ...base, driving: 'quote', maxIn: 10n ** 7n }));
    expect(p.lp).toBe((10n ** 7n * S * 10_000n) / (10n ** 9n * 10_100n));
    expect(p.lp).toBeGreaterThan(9_000_000_000n);
  });

  it('lowers the other side’s maximum to the balance when the cost still fits, and refuses when it does not', () => {
    const s = snap(1_000_000n, 10n ** 9n, 10n ** 12n); // SOL = token0, 1,000 tokens per lamport
    const want = ok(planDeposit(s, { ...base, driving: 'quote', maxIn: 1_000_000n }));
    // A token balance between the cost and the maximum: the maximum becomes the balance.
    const between = want.cost1 + (want.max1 - want.cost1) / 2n;
    const limited = ok(planDeposit(s, { ...base, driving: 'quote', maxIn: 1_000_000n, availableToken: between }));
    expect(limited.max1).toBe(between);
    expect(limited.limitedByBalance).toBe('token');
    // A balance below the cost: refused, with the most both balances allow.
    const short = planDeposit(s, { ...base, driving: 'quote', maxIn: 1_000_000n, availableToken: want.cost1 - 1n, availableQuote: 5_000_000n });
    expect(short).toMatchObject({ problem: 'over-balance', side: 'token', need: want.cost1, have: want.cost1 - 1n });
    if (!isPlanProblem(short) || short.problem !== 'over-balance') throw new Error('expected over-balance');
    // That most-both amount plans without a problem.
    expect(short.mostBoth).not.toBeNull();
    const again = planDeposit(s, { ...base, driving: 'quote', maxIn: short.mostBoth!, availableToken: want.cost1 - 1n, availableQuote: 5_000_000n });
    expect(isPlanProblem(again)).toBe(false);
  });

  it('refuses a typed amount above the driving side’s own balance', () => {
    const s = snap(1_000_000n, 10n ** 9n, 10n ** 12n);
    expect(planDeposit(s, { ...base, driving: 'quote', maxIn: 2_000_000n, availableQuote: 1_999_999n })).toMatchObject({
      problem: 'over-balance', side: 'quote', need: 2_000_000n, have: 1_999_999n,
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

// THE LEAVE RULE for an opening: nobody is let in who cannot be let out. The pool program
// refuses a withdrawal that pays 0 on a side (withdraw.rs 116-126), and it works the
// payout out as floor(shares · reserve / supply). An opening with ONE base unit on a side
// (1 of a token with no decimals, against 10,000 BAYLA) passed every other rule, and the
// opener's 99.9% of the shares then paid floor(0.999) = 0 of that side: locked for good.
describe('openingProblem: the opener’s own shares must be able to leave', () => {
  /** What the pool program pays for `lp` shares of a pool of `S` shares holding `r`: floor, as withdraw.rs. */
  const pays = (lp: bigint, S: bigint, r: bigint) => (lp * r) / S;
  const BIG = 10_000_000_000n; // 10,000 USDC or BAYLA, or 10 SOL, in base units

  it('one unit on a side against 10,000 coins: refused, naming which amount is short', () => {
    // isqrt(1e10) = 100,000 shares: the lock is exactly 0.1%, so no other rule stops it.
    expect(isqrt(BIG)).toBe(100_000n);
    expect(openingProblem(BIG, 1n)).toEqual({ problem: 'cannot-leave', supply: 100_000n, short: 1 });
    expect(openingProblem(1n, BIG)).toEqual({ problem: 'cannot-leave', supply: 100_000n, short: 0 });
    // And however much is on the other side.
    expect(openingProblem(U64_MAX, 1n)).toMatchObject({ problem: 'cannot-leave', short: 1 });
  });

  it('two units on that side can leave (one of the two comes back), so it is not refused', () => {
    expect(openingProblem(BIG, 2n)).toBeNull();
    expect(openingProblem(2n, BIG)).toBeNull();
    const S = isqrt(BIG * 2n);
    expect(pays(S - LOCKED_LP, S, 2n)).toBe(1n);
  });

  it('planCreate names the side: the coin’s or the token’s', () => {
    const a = { quoteIsToken0: true, availableQuote: null, availableToken: null };
    expect(planCreate({ ...a, quote: BIG, token: 1n })).toEqual({ problem: 'cannot-leave', supply: 100_000n, side: 'token' });
    expect(planCreate({ ...a, quote: 1n, token: BIG })).toEqual({ problem: 'cannot-leave', supply: 100_000n, side: 'quote' });
    // Whichever side of the pool the coin sits on: the name follows the coin, not the slot.
    expect(planCreate({ ...a, quoteIsToken0: false, quote: BIG, token: 1n })).toMatchObject({ problem: 'cannot-leave', side: 'token' });
    expect(planCreate({ ...a, quoteIsToken0: false, quote: 1n, token: BIG })).toMatchObject({ problem: 'cannot-leave', side: 'quote' });
  });

  it('every small opening the rule lets through can be taken out whole, and every one it refuses for this could not', () => {
    let through = 0;
    let stopped = 0;
    for (const big of [BIG, 10n ** 12n, 10n ** 15n, U64_MAX]) {
      for (let small = 1n; small <= 50n; small++) {
        for (const [a0, a1] of [[small, big], [big, small]] as const) {
          const p = openingProblem(a0, a1);
          const S = isqrt(a0 * a1);
          const mine = S - LOCKED_LP;
          const fresh = snap(S, a0, a1);
          if (p === null) {
            through++;
            // The pool exactly as the opening leaves it, and the opener's whole share.
            const w = planWithdraw(fresh, { held: mine, pctBps: 10_000n, bps: 0n });
            expect(isPlanProblem(w), `${a0} x ${a1}`).toBe(false);
            expect(pays(mine, S, a0) >= 1n && pays(mine, S, a1) >= 1n, `${a0} x ${a1}`).toBe(true);
          } else if (p.problem === 'cannot-leave') {
            stopped++;
            // Not a refusal of something that could have left: no share of it ever could.
            for (const pct of [10_000n, 5_000n, 1n]) expect(planWithdraw(fresh, { held: mine, pctBps: pct, bps: 0n })).toMatchObject({ problem: 'too-small' });
            expect(pays(mine, S, p.short === 0 ? a0 : a1)).toBe(0n);
          }
        }
      }
    }
    // Not a vacuous pass: both happen, and only a side of exactly one unit is stopped.
    expect(stopped).toBe(8);
    expect(through).toBeGreaterThan(300);
  });

  it('for 3,000 random openings: let through means the whole share pays at least 1 on each side', () => {
    const r = rng(23);
    let through = 0;
    for (let i = 0; i < 3_000; i++) {
      // Up to 19 digits: every size a side can have (u64 holds 1.8 × 10^19).
      const a0 = r.big(19);
      const a1 = r.big(19);
      const p = openingProblem(a0, a1);
      const S = isqrt(a0 * a1);
      if (p === null) {
        through++;
        expect(pays(S - LOCKED_LP, S, a0) >= 1n && pays(S - LOCKED_LP, S, a1) >= 1n, `${a0} x ${a1}`).toBe(true);
      } else if (p.problem === 'cannot-leave') {
        expect(pays(S - LOCKED_LP, S, a0) === 0n || pays(S - LOCKED_LP, S, a1) === 0n, `${a0} x ${a1}`).toBe(true);
      }
    }
    expect(through).toBeGreaterThan(1_000);
  });
});

// The same question for ADDING: can a deposit be built whose shares could never be taken
// out? No. The pool program refuses a deposit whose cost floors to 0 on a side
// (deposit.rs 103-112; `planDeposit` step 3), so a deposit that is built has
// floor(lp·R/S) ≥ 1 on both sides. It then pays in ceil(lp·R/S) ≥ lp·R/S on each side, so
// in the pool as the deposit leaves it those same shares pay floor(lp·R'/S') ≥ floor(lp·R/S) ≥ 1.
describe('planDeposit: the shares a deposit buys can always be taken out again', () => {
  it('for 4,000 random pools and deposits, tiny reserves included: the new shares leave whole from the pool the deposit leaves', () => {
    const r = rng(31);
    let built = 0;
    for (let i = 0; i < 4_000; i++) {
      // Reserves from 1 base unit up: a side of 1 is where an opening got stuck.
      const R0 = i % 4 === 0 ? BigInt(1 + Math.floor(r.next() * 5)) : r.big(15);
      const R1 = i % 4 === 1 ? BigInt(1 + Math.floor(r.next() * 5)) : r.big(15);
      const S = r.big(15);
      const quoteIsToken0 = r.next() < 0.5;
      const driving = r.next() < 0.5 ? ('quote' as const) : ('token' as const);
      const p = planDeposit(snap(S, R0, R1), { quoteIsToken0, driving, maxIn: r.big(16), bps: BigInt(Math.floor(r.next() * 500)), availableQuote: null, availableToken: null });
      if (isPlanProblem(p)) continue;
      built++;
      const after = snap(S + p.lp, R0 + p.cost0, R1 + p.cost1);
      const w = planWithdraw(after, { held: p.lp, pctBps: 10_000n, bps: 0n });
      expect(isPlanProblem(w), `S=${S} R0=${R0} R1=${R1} lp=${p.lp}`).toBe(false);
    }
    expect(built).toBeGreaterThan(1_000);
  });
});

describe('planCreate: an opening of exactly what was typed', () => {
  const base = { quoteIsToken0: true, quote: 1_000_000_000n, token: 5_000_000n, availableQuote: 2_000_000_000n, availableToken: 9_000_000n };

  it('puts SOL on the SOL side, the shares are isqrt, the opener gets supply − 100, and the locked part is what stays behind, rounded up', () => {
    const p = planCreate(base);
    if ('problem' in p) throw new Error(p.problem);
    const supply = isqrt(1_000_000_000n * 5_000_000n);
    expect(p).toEqual({
      init0: 1_000_000_000n,
      init1: 5_000_000n,
      supply,
      lp: supply - 100n,
      locked: { quote: 1_415n, token: 8n },
    });
    // 100·5,000,000 / 70,710,678 = 7.07…: the opener's own shares pay out 4,999,992 (floor), so 8 stay
    // behind. What can never come back is rounded UP, never down.
    expect(p.locked.token).toBe(5_000_000n - ((supply - 100n) * 5_000_000n) / supply);
  });

  // The old figure, floor(100 x put / supply), said "0 tokens" here while a whole token stayed
  // behind for good. Any token may have a pool now, so whole-unit tokens are in reach (review, 2026-10-04).
  it('a whole-unit token: the locked part is never said as 0 when a whole unit can never come back', () => {
    for (const tokens of [2n, 3n, 10n, 1_000n]) {
      const p = planCreate({ ...base, quote: 10_000_000_000n, token: tokens, availableQuote: null, availableToken: null });
      if ('problem' in p) throw new Error(p.problem);
      // The pool program's own sum for the opener's whole share, done by hand.
      const out = { quote: (p.lp * 10_000_000_000n) / p.supply, token: (p.lp * tokens) / p.supply };
      expect(p.locked, `${tokens} tokens`).toEqual({ quote: 10_000_000_000n - out.quote, token: tokens - out.token });
      expect(p.locked.token, `${tokens} tokens`).toBeGreaterThanOrEqual(1n);
      expect((100n * tokens) / p.supply, 'the old figure').toBe(0n);
    }
  });

  it('with SOL as token1 the sides swap, and only then', () => {
    const p = planCreate({ ...base, quoteIsToken0: false });
    if ('problem' in p) throw new Error(p.problem);
    expect([p.init0, p.init1]).toEqual([5_000_000n, 1_000_000_000n]);
  });

  it('each side over what the wallet can put in, naming it', () => {
    expect(planCreate({ ...base, availableQuote: 999_999_999n })).toEqual({ problem: 'over-balance', side: 'quote', need: 1_000_000_000n, have: 999_999_999n });
    expect(planCreate({ ...base, availableToken: 4_999_999n })).toEqual({ problem: 'over-balance', side: 'token', need: 5_000_000n, have: 4_999_999n });
    // Exactly the balance is fine.
    expect('problem' in planCreate({ ...base, availableQuote: 1_000_000_000n, availableToken: 5_000_000n })).toBe(false);
  });

  it('a balance that was not read runs no rule, and is never taken as 0', () => {
    expect('problem' in planCreate({ ...base, availableQuote: null, availableToken: null })).toBe(false);
  });

  it('the share rule comes first', () => {
    expect(planCreate({ ...base, quote: 100n, token: 100n, availableQuote: 1n })).toEqual({ problem: 'too-small', supply: 100n });
    expect(planCreate({ ...base, quote: 0n })).toEqual({ problem: 'empty-side' });
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
