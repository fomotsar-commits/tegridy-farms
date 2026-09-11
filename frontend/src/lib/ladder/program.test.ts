// @vitest-environment node
//
// NODE, not the project's jsdom default. Under jsdom,
// `PublicKey.findProgramAddressSync` fails every bump and throws "Unable to find a
// viable program address nonce" — a message that names nothing about the
// environment and reads like a bad seed. Same choice `curve/ix.test.ts` makes.
//
// ── WHAT THESE PINS ARE ANCHORED TO ─────────────────────────────────────────
// Not to this module's own arithmetic. Two independent witnesses:
//
//  1. THE BUILT IDL. Discriminators and account sizes were compared field by field
//     against `anchor build`'s output (workflow run 34303749601): 0 mismatches.
//     They are transcribed here as literals, because recomputing sha256 on both
//     sides agrees with itself and proves nothing.
//
//  2. THE LIVE CHAIN. On 2026-09-09 the program was deployed to devnet
//     (`HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK`) and driven end to end. The
//     weights, the penalty and the account sizes below are what it ACTUALLY
//     produced, read back off real accounts — not what this file computes.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  IX_DISCRIMINATOR, ACCOUNT_DISCRIMINATOR,
  POOL_SIZE, POSITION_SIZE, USER_STATS_SIZE,
  poolPda, stakeVaultPda, rewardVaultPda, userStatsPda, positionPda,
  decodeLadderPool, decodeLadderPosition, decodeLadderUserStats,
  boostBpsForLock, weightForStake, penaltyFor, quoteExit, checkDeposit,
  MIN_LOCK_SECS, MAX_LOCK_SECS, MIN_BOOST_BPS, MAX_BOOST_BPS, MAX_POSITIONS,
  EARLY_EXIT_PENALTY_BPS, BPS,
  PRECISION, minWeightFloor, lastTimeApplicable, rewardPerWeightNow, earnedNow,
} from './program';

// The real devnet deployment.
const PROGRAM = new PublicKey('HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK');
const MINT = new PublicKey('8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL');
const OWNER = new PublicKey('Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj');
const b = (u: Uint8Array) => Array.from(u);

describe('discriminators — transcribed from the built IDL', () => {
  it('instructions', () => {
    expect(b(IX_DISCRIMINATOR.initializePool)).toEqual([95, 180, 10, 172, 84, 174, 232, 40]);
    expect(b(IX_DISCRIMINATOR.stake)).toEqual([206, 176, 202, 18, 200, 209, 179, 108]);
    expect(b(IX_DISCRIMINATOR.claim)).toEqual([62, 198, 214, 193, 213, 159, 108, 210]);
    expect(b(IX_DISCRIMINATOR.withdrawMatured)).toEqual([250, 148, 159, 141, 164, 95, 1, 80]);
    expect(b(IX_DISCRIMINATOR.earlyExit)).toEqual([57, 50, 147, 224, 231, 173, 36, 75]);
    expect(b(IX_DISCRIMINATOR.emergencyWithdraw)).toEqual([239, 45, 203, 64, 150, 73, 218, 92]);
    expect(b(IX_DISCRIMINATOR.claimCarried)).toEqual([173, 173, 45, 126, 170, 32, 215, 248]);
    expect(b(IX_DISCRIMINATOR.notifyReward)).toEqual([252, 51, 75, 132, 223, 48, 177, 213]);
  });
  it('accounts', () => {
    expect(b(ACCOUNT_DISCRIMINATOR.Pool)).toEqual([241, 154, 109, 4, 17, 177, 109, 188]);
    expect(b(ACCOUNT_DISCRIMINATOR.Position)).toEqual([170, 188, 143, 228, 122, 64, 247, 208]);
    expect(b(ACCOUNT_DISCRIMINATOR.UserStats)).toEqual([176, 223, 136, 27, 122, 79, 32, 227]);
  });
  it('account sizes are the ones the program pins', () => {
    expect(POOL_SIZE).toBe(508);
    expect(POSITION_SIZE).toBe(205);
    expect(USER_STATS_SIZE).toBe(126);
  });
});

describe('PDAs — checked against the addresses the live pool actually has', () => {
  // These four came off the devnet pool created 2026-09-09. If a seed or its order
  // ever changes, the derivation stops matching a pool that demonstrably exists.
  const POOL = '2RJNUuj3y8CDibhCehvRoufAvkBG9idpKrryYosvZxi4';
  const STAKE_VAULT = '4LxQa62VsQKPh4ig2cXDPQZDtvewWKsRC3KYMkLZronM';
  const REWARD_VAULT = '92WyYwAHDQMNMVQxxe214SrDcxJsZmzRtHDHXNx7ojL6';

  it('the pool PDA reproduces the live pool address', () => {
    expect(poolPda(PROGRAM, MINT, 0).toBase58()).toBe(POOL);
  });
  it('both vault PDAs reproduce the live vaults', () => {
    const pool = new PublicKey(POOL);
    expect(stakeVaultPda(PROGRAM, pool).toBase58()).toBe(STAKE_VAULT);
    expect(rewardVaultPda(PROGRAM, pool).toBase58()).toBe(REWARD_VAULT);
    // Separate vaults ARE invariant I-12: a reward can never be paid out of principal.
    expect(STAKE_VAULT).not.toBe(REWARD_VAULT);
  });
  it('the pool nonce is a u8 — 256 is REFUSED, not wrapped to 0', () => {
    // The on-chain seed is a single byte, so an unguarded 256 would silently
    // address pool 0 — a different pool, and the one most likely to exist.
    expect(() => poolPda(PROGRAM, MINT, 256)).toThrow(/u8/);
    expect(() => poolPda(PROGRAM, MINT, -1)).toThrow();
    expect(poolPda(PROGRAM, MINT, 255).toBase58()).not.toBe(poolPda(PROGRAM, MINT, 0).toBase58());
  });
  it('a position is keyed on a u32 nonce, so #0 and #1 differ', () => {
    const pool = new PublicKey(POOL);
    expect(positionPda(PROGRAM, pool, OWNER, 0).toBase58())
      .not.toBe(positionPda(PROGRAM, pool, OWNER, 1).toBase58());
  });
  it('user stats are per (pool, owner)', () => {
    const pool = new PublicKey(POOL);
    expect(userStatsPda(PROGRAM, pool, OWNER).toBase58()).toHaveLength(44);
  });
});

describe('the ladder — pinned to weights the chain produced', () => {
  // 500 tokens at 6 decimals = 500_000_000 raw. Both of these were READ BACK off
  // real positions on devnet, not computed here first.
  const FIVE_HUNDRED = 500_000_000n;

  it('a 7-day lock gets the 0.40x FLOOR, and produced weight 200,000,000', () => {
    expect(boostBpsForLock(7 * 86_400)).toBe(MIN_BOOST_BPS);
    expect(weightForStake(FIVE_HUNDRED, 7 * 86_400)).toBe(200_000_000n);
  });

  it('a 30-day lock produced weight 228,450,000 (0.4569x)', () => {
    expect(weightForStake(FIVE_HUNDRED, 30 * 86_400)).toBe(228_450_000n);
  });

  it('the ends are the ends, and nothing exceeds them', () => {
    expect(boostBpsForLock(MIN_LOCK_SECS)).toBe(MIN_BOOST_BPS);
    expect(boostBpsForLock(MAX_LOCK_SECS)).toBe(MAX_BOOST_BPS);
    expect(boostBpsForLock(0)).toBe(MIN_BOOST_BPS);              // below the floor clamps
    expect(boostBpsForLock(MAX_LOCK_SECS * 10)).toBe(MAX_BOOST_BPS);
  });

  it('is monotonic — a longer lock never earns less weight', () => {
    let prev = -1;
    for (const d of [7, 14, 30, 90, 180, 365, 730, 1460]) {
      const bps = boostBpsForLock(d * 86_400);
      expect(bps).toBeGreaterThanOrEqual(prev);
      prev = bps;
    }
  });

  it('the 90-day rung is 0.6056x, NOT 4.00x — the top needs the full four years', () => {
    // Worth pinning: a UI that advertises the 4.00x beside a 90-day ceiling is
    // quoting a rung nobody can select. That bug has already shipped once here.
    expect(boostBpsForLock(90 * 86_400)).toBe(6056);
  });
});

describe('the penalty — pinned to the event the chain emitted', () => {
  it('is 25%, floored, exactly as math.rs computes it', () => {
    expect(EARLY_EXIT_PENALTY_BPS).toBe(2500);
    expect(BPS).toBe(10000);
    expect(penaltyFor(1_000_000n)).toBe(250_000n);
    expect(penaltyFor(3n)).toBe(0n);     // floors, never rounds up
    expect(penaltyFor(7n)).toBe(1n);
  });

  it('reproduces the live Withdrawn event: 500 in -> 375 out, 125 retained', () => {
    // Decoded from the real base64 `Program data:` line on devnet.
    const amount = 500_000_000n;
    expect(penaltyFor(amount)).toBe(125_000_000n);
    expect(amount - penaltyFor(amount)).toBe(375_000_000n);
  });
});

describe('quoteExit — the doors, and what each ACTUALLY costs', () => {
  const NOW = 1_800_000_000;
  const locked = { amountRaw: 500_000_000n, lockEnd: BigInt(NOW + 86_400) };
  const matured = { amountRaw: 500_000_000n, lockEnd: BigInt(NOW - 86_400) };
  const healthy = { degraded: false };
  const degraded = { degraded: true };
  const door = (qs: ReturnType<typeof quoteExit>, d: string) => qs.find((q) => q.door === d)!;

  it('WHILE LOCKED the hatch costs the SAME 25% as an early exit', () => {
    // The defect this whole module exists to not repeat: the CLI and the runbook
    // both said the hatch was free, and the penalty is invisible in a simulation.
    const q = quoteExit(locked, healthy, NOW);
    expect(door(q, 'hatch').penaltyRaw).toBe(125_000_000n);
    expect(door(q, 'hatch').penaltyRaw).toBe(door(q, 'early').penaltyRaw);
    expect(door(q, 'hatch').receivesRaw).toBe(375_000_000n);
    expect(door(q, 'hatch').reason).toMatch(/NOT free while locked/);
  });

  it('the two normal doors PARTITION time — exactly one is open', () => {
    for (const [pos, open] of [[locked, 'early'], [matured, 'matured']] as const) {
      const q = quoteExit(pos, healthy, NOW);
      const openDoors = q.filter((x) => x.door !== 'hatch' && !x.refused).map((x) => x.door);
      expect(openDoors).toEqual([open]);
    }
  });

  it('the hatch is NEVER refused — that is its whole purpose', () => {
    for (const pos of [locked, matured]) {
      for (const pool of [healthy, degraded]) {
        expect(door(quoteExit(pos, pool, NOW), 'hatch').refused).toBe(false);
      }
    }
  });

  it('after maturity the hatch is free', () => {
    expect(door(quoteExit(matured, healthy, NOW), 'hatch').penaltyRaw).toBe(0n);
  });

  it('a DEGRADED pool makes the hatch free even while locked', () => {
    // audit M-3: the doors were made to agree so neither dominates the other.
    expect(door(quoteExit(locked, degraded, NOW), 'hatch').penaltyRaw).toBe(0n);
  });

  it('the matured door is free and the early door is not', () => {
    const q = quoteExit(matured, healthy, NOW);
    expect(door(q, 'matured').penaltyRaw).toBe(0n);
    expect(door(q, 'matured').receivesRaw).toBe(500_000_000n);
    expect(door(q, 'early').penaltyRaw).toBe(125_000_000n);
  });
});

describe('checkDeposit — refuse locally, with a reason', () => {
  const pool = {
    minStakeRaw: 100_000_000n,        // 100 tokens, immutable
    depositCapRaw: 1_000_000_000_000n,
    maxWalletPrincipalRaw: 100_000_000_000n,
    totalPrincipalRaw: 0n,
    degraded: false,
  };
  const ok = (amt: bigint, wallet = 0n, lock = 7 * 86_400, open = 0) =>
    checkDeposit(pool, amt, wallet, lock, open);

  it('accepts a sane stake', () => expect(ok(500_000_000n).allowed).toBe(true));
  it('refuses below the minimum, and says it cannot be lowered', () => {
    const v = ok(1n);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/minimum/i);
  });
  it('refuses zero and negative', () => {
    expect(ok(0n).allowed).toBe(false);
    expect(ok(-5n).allowed).toBe(false);
  });
  it('refuses locks outside the program bounds', () => {
    expect(ok(500_000_000n, 0n, 86_400).allowed).toBe(false);
    expect(ok(500_000_000n, 0n, MAX_LOCK_SECS + 1).allowed).toBe(false);
  });
  it('refuses past the POOL cap', () => {
    const v = checkDeposit({ ...pool, totalPrincipalRaw: pool.depositCapRaw }, 500_000_000n, 0n, 7 * 86_400, 0);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/deposit cap/i);
  });
  it('refuses past the PER-WALLET cap, counting existing principal', () => {
    const v = ok(500_000_000n, pool.maxWalletPrincipalRaw);
    expect(v.allowed).toBe(false);
    expect(v.reason).toMatch(/per-wallet/i);
  });
  it('refuses a 21st position', () => {
    expect(ok(500_000_000n, 0n, 7 * 86_400, MAX_POSITIONS).allowed).toBe(false);
  });
});

describe('decoders refuse rather than invent', () => {
  const buf = (disc: Uint8Array, size: number) => {
    const d = new Uint8Array(size);
    d.set(disc, 0);
    return d;
  };
  it('a missing account is a REASON, never a zeroed struct', () => {
    expect(decodeLadderPool('X', null)).toMatchObject({ ok: false });
    expect(decodeLadderPosition('X', undefined)).toMatchObject({ ok: false });
    expect(decodeLadderUserStats('X', null)).toMatchObject({ ok: false });
  });
  it('a wrong length is refused', () => {
    expect(decodeLadderPool('X', buf(ACCOUNT_DISCRIMINATOR.Pool, 507)))
      .toMatchObject({ ok: false, reason: expect.stringMatching(/bad-length/) });
  });
  it('another account TYPE is refused on its discriminator', () => {
    expect(decodeLadderPool('X', buf(ACCOUNT_DISCRIMINATOR.Position, POOL_SIZE)))
      .toMatchObject({ ok: false, reason: 'wrong-discriminator' });
  });
  it('a `degraded` byte that is neither 0 nor 1 is malformed, not `true`', () => {
    const d = buf(ACCOUNT_DISCRIMINATOR.Pool, POOL_SIZE);
    d[387] = 7;
    expect(decodeLadderPool('X', d)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('reads every field back from its OWN offset, at its own width', () => {
    // Distinct value per field, written at offsets transcribed from state.rs.
    const d = new Uint8Array(POOL_SIZE);
    d.set(ACCOUNT_DISCRIMINATOR.Pool, 0);
    const v = new DataView(d.buffer);
    const k = (byte: number) => new Uint8Array(32).fill(byte);
    d[8] = 254; d[9] = 3;
    d.set(k(0x11), 10); d.set(k(0x22), 42); d[74] = 6;
    d.set(k(0x33), 75); d.set(k(0x44), 107); d.set(k(0x55), 139); d.set(k(0x66), 171);
    v.setBigUint64(203, 100_000_000n, true);
    v.setBigUint64(211, 999_000_000n, true);
    v.setBigInt64(227, -7n, true);                       // i64, not u64
    v.setBigUint64(235, 42_000_000n, true);
    v.setBigUint64(243, 777n, true);
    v.setBigUint64(251, 5n, true); v.setBigUint64(259, 1n << 6n, true);   // u128 > 64 bits
    v.setBigInt64(283, 1_700_000_000n, true);
    v.setBigUint64(379, 31_337n, true);
    d[387] = 1;

    const r = decodeLadderPool('POOL', d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.bump).toBe(254);
    expect(r.value.nonce).toBe(3);
    expect(r.value.decimals).toBe(6);
    expect(r.value.minStakeRaw).toBe(100_000_000n);
    expect(r.value.depositCapRaw).toBe(999_000_000n);
    expect(r.value.pendingCapTs).toBe(-7n);              // signed, and negative
    expect(r.value.maxWalletPrincipalRaw).toBe(42_000_000n);
    expect(r.value.totalPrincipalRaw).toBe(777n);
    expect(r.value.totalWeighted).toBe(5n + (1n << 70n)); // full u128 width
    expect(r.value.periodFinish).toBe(1_700_000_000n);
    expect(r.value.orphanedPenaltyRaw).toBe(31_337n);
    expect(r.value.degraded).toBe(true);
    expect(r.value.mint).toBe(new PublicKey(k(0x11)).toBase58());
    expect(r.value.stakeVault).toBe(new PublicKey(k(0x55)).toBase58());
  });
});

/* ─────────────── what a position has actually earned ─────────────── */

describe('the reward accumulator', () => {
  // A pool whose stored accumulator is at `rewardPerWeightStored` and which emits at
  // `rewardRate`. Every field the live half reads is overridable, so each test can
  // isolate one term.
  const pool = (o: Partial<{
    rewardPerWeightStored: bigint; rpwResidueRaw: bigint; lastUpdateTime: bigint;
    periodFinish: bigint; rewardRate: bigint; totalWeighted: bigint; minStakeRaw: bigint;
  }> = {}) => ({
    rewardPerWeightStored: 0n,
    rpwResidueRaw: 0n,
    lastUpdateTime: 1_000n,
    periodFinish: 1_000_000n,
    rewardRate: 0n,
    totalWeighted: 4_000_000_000_000n,
    minStakeRaw: 0n,
    ...o,
  });

  it('the layout arithmetic closes on the pinned account size', () => {
    // rpw_residue sits at 388 ONLY if `degraded` is one byte at 387 and the two u128
    // residues plus the 88-byte reserve fill the account exactly. An independent
    // check on the offset rather than a restatement of it: if 388 is wrong, this sum
    // misses 508.
    expect(388 + 16 + 16 + 88).toBe(POOL_SIZE);
  });

  it("reads the accumulator fields from their own offsets, not a neighbour's", () => {
    // MUTATION-CHECKED: reward_per_weight_stored (299) sits immediately before
    // rewards_emitted (315), and both are u128 — so a one-slot slip decodes cleanly
    // and silently reports the wrong quantity. Distinct values on each side.
    const d = new Uint8Array(POOL_SIZE);
    d.set(ACCOUNT_DISCRIMINATOR.Pool, 0);
    const v = new DataView(d.buffer);
    v.setBigUint64(299, 111n, true);          // reward_per_weight_stored
    v.setBigUint64(315, 222n, true);          // rewards_emitted
    v.setBigUint64(331, 333n, true);          // rewards_paid
    v.setBigUint64(388, 444n, true);          // rpw_residue
    const r = decodeLadderPool('POOL', d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rewardPerWeightStored).toBe(111n);
    expect(r.value.rewardsEmitted).toBe(222n);
    expect(r.value.rewardsPaid).toBe(333n);
    expect(r.value.rpwResidueRaw).toBe(444n);
  });

  it("reads a position's paid mark from ITS own offset", () => {
    const d = new Uint8Array(POSITION_SIZE);
    d.set(ACCOUNT_DISCRIMINATOR.Position, 0);
    const v = new DataView(d.buffer);
    v.setBigUint64(109, 987n, true);          // reward_per_weight_paid
    v.setBigUint64(125, 654n, true);          // rewards_owed
    const r = decodeLadderPosition('POS', d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rewardPerWeightPaid).toBe(987n);
    expect(r.value.rewardsOwed).toBe(654n);
  });

  it("matches the program's own `earned` fixtures, value for value", () => {
    // Transcribed from math.rs's Rust unit tests, which is the point: agreeing with
    // my own re-derivation would prove nothing. `rewardRate: 0` freezes the
    // accumulator so these exercise `earned` alone.
    expect(earnedNow(
      { weight: 4_000_000_000_000n, rewardPerWeightPaid: 0n, rewardsOwed: 5n },
      pool({ rewardPerWeightStored: 500_000_000_000n }),
      2_000,
    )).toBe(2_000_000_000_005n);

    // no delta -> just what was owed
    expect(earnedNow(
      { weight: 4_000_000_000_000n, rewardPerWeightPaid: 9n, rewardsOwed: 42n },
      pool({ rewardPerWeightStored: 9n }),
      2_000,
    )).toBe(42n);
  });

  it("PRECISION is the program's 1e12, not the Solidity's 1e18", () => {
    expect(PRECISION).toBe(10n ** 12n);
  });

  it('a position nobody has touched has earned MORE than it has banked', () => {
    // ⚠️ THE REASON THIS MATH EXISTS. `reward_per_weight_stored` only moves when
    // somebody interacts with the pool, so a real staked position reads
    // `rewards_owed = 0` on chain for as long as nobody pokes it. A card that
    // renders that stored value tells a staker who has been earning for a month
    // that they have earned nothing — a zero no read of THEIR position produced.
    const p = { weight: 1_000_000n, rewardPerWeightPaid: 0n, rewardsOwed: 0n };
    const live = pool({ rewardRate: 1_000_000n, lastUpdateTime: 1_000n, totalWeighted: 1_000_000n });
    expect(p.rewardsOwed).toBe(0n);                        // what the chain stores
    expect(earnedNow(p, live, 2_000)).toBeGreaterThan(0n); // what it has earned
  });

  it('stops accruing at period_finish, not at now', () => {
    // MUTATION-CHECKED: using `now` instead of `last_time_applicable` keeps paying
    // out of a window that has closed, which over-reports every position in a pool
    // whose rewards have run dry.
    const p = { weight: 1_000_000n, rewardPerWeightPaid: 0n, rewardsOwed: 0n };
    const finished = pool({
      rewardRate: 1_000_000n, lastUpdateTime: 1_000n, periodFinish: 2_000n,
      totalWeighted: 1_000_000n,
    });
    const atFinish = earnedNow(p, finished, 2_000);
    const longAfter = earnedNow(p, finished, 9_999_999);
    expect(atFinish).toBeGreaterThan(0n);
    expect(longAfter).toBe(atFinish);
  });

  it('carries the residue the program carries', () => {
    // MUTATION-CHECKED (audit M-2): dropping `rpw_residue` from the numerator
    // silently discards up to a full division remainder per checkpoint — the same
    // loss that destroyed 7.4% of a plausible window before it was banked on chain.
    const p = { weight: 1_000_000n, rewardPerWeightPaid: 0n, rewardsOwed: 0n };
    const base = { rewardRate: 1n, lastUpdateTime: 1_000n, totalWeighted: 999_983n };
    const without = earnedNow(p, pool({ ...base, rpwResidueRaw: 0n }), 1_001);
    const withResidue = earnedNow(p, pool({ ...base, rpwResidueRaw: 999_982n }), 1_001);
    expect(withResidue).toBeGreaterThan(without);
  });

  it('does not advance below the I-11 weight floor — the interval is burned', () => {
    // MUTATION-CHECKED: dropping the floor check reports rewards a pool this small
    // never actually emits, because the on-chain accumulator does not move at all.
    const p = { weight: 100n, rewardPerWeightPaid: 0n, rewardsOwed: 0n };
    const tiny = pool({ rewardRate: 1_000_000n, totalWeighted: 100n, minStakeRaw: 1_000_000n });
    expect(minWeightFloor(1_000_000n)).toBe(400_000n);   // 1e6 * 4000bps / 1e4
    expect(tiny.totalWeighted).toBeLessThan(minWeightFloor(tiny.minStakeRaw));
    expect(earnedNow(p, tiny, 9_999)).toBe(0n);
  });

  it('an empty pool does not divide by zero', () => {
    const p = { weight: 0n, rewardPerWeightPaid: 0n, rewardsOwed: 7n };
    expect(earnedNow(p, pool({ totalWeighted: 0n, rewardRate: 5n }), 9_999)).toBe(7n);
  });

  it('clamps weight to the ledger exactly as the program does', () => {
    // `accrue_position_inner` uses min(weight, total_weighted). Reporting the
    // inflated figure would quote a payout the program then refuses to make.
    const desynced = { weight: 5_000n, rewardPerWeightPaid: 0n, rewardsOwed: 0n };
    const p = pool({ rewardPerWeightStored: PRECISION, totalWeighted: 100n, minStakeRaw: 0n });
    expect(earnedNow(desynced, p, 1_000)).toBe(100n);   // not 5_000n
  });

  it('a backwards clock accrues nothing, rather than a negative', () => {
    const p = { weight: 1_000_000n, rewardPerWeightPaid: 0n, rewardsOwed: 11n };
    const behind = pool({ rewardRate: 1_000_000n, lastUpdateTime: 5_000n, totalWeighted: 1_000_000n });
    expect(earnedNow(p, behind, 1_000)).toBe(11n);
  });

  it('lastTimeApplicable is a clamp, both ways', () => {
    expect(lastTimeApplicable(5, 10n)).toBe(5n);
    expect(lastTimeApplicable(50, 10n)).toBe(10n);
  });

  it('never reports a payout below what the chain has already banked', () => {
    // `rewards_owed` is money the program has already committed to this position.
    // Whatever the live half computes, the total can only be additive.
    const p = { weight: 1n, rewardPerWeightPaid: 10n ** 30n, rewardsOwed: 12_345n };
    expect(earnedNow(p, pool({ rewardPerWeightStored: 1n }), 2_000)).toBe(12_345n);
  });

  it('rewardPerWeightNow leaves a frozen pool exactly where it was', () => {
    const frozen = pool({ rewardPerWeightStored: 777n, rewardRate: 0n });
    expect(rewardPerWeightNow(frozen, 9_999_999)).toBe(777n);
  });
});

describe('the accumulator is monotonic, whatever the clock says', () => {
  // MUTATION-FOUND (A5), and the reason this is its own block rather than one more
  // assertion inside `earnedNow`'s: removing the `dt` clamp left every earlier test
  // GREEN. `earnedNow` clamps its own delta to zero, so a negative accumulator is
  // completely invisible from there — the "backwards clock accrues nothing" test
  // passed against code that computed a negative reward-per-weight and then hid it.
  //
  // On chain `reward_per_weight_stored` is a u128 and cannot go backwards. A client
  // that returns a smaller one has produced a number no chain state could hold, and
  // `rewardPerWeightNow` is exported — the next caller gets no second defence.
  it('a clock behind the last checkpoint leaves the accumulator exactly where it was', () => {
    const behind = {
      rewardPerWeightStored: 500n,
      rpwResidueRaw: 0n,
      lastUpdateTime: 5_000n,
      periodFinish: 1_000_000n,
      rewardRate: 1_000_000n,
      totalWeighted: 1_000_000n,
      minStakeRaw: 0n,
    };
    expect(rewardPerWeightNow(behind, 1_000)).toBe(500n);
    expect(rewardPerWeightNow(behind, 1_000)).toBeGreaterThanOrEqual(behind.rewardPerWeightStored);
  });
});
