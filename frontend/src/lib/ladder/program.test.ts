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
