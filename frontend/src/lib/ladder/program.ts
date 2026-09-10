// `bayla-ladder` — program identity, PDAs, and account decoding.
//
// THIS IS A PORT, NOT A REWRITE. Every constant, offset and derivation here comes
// from `frontend/scripts/bayla-ladder-ops.mjs`, which was verified field-by-field
// against the program's own IDL (0 mismatches across 8 instruction discriminators,
// 3 account discriminators, and every account's position and writable/signer flag)
// and then driven successfully against the live program on devnet — pool created,
// funded, staked, claimed, both exit doors, the hatch, carried rewards and the
// sweep. Eight instructions, real transactions. Do not "improve" a value here
// without re-checking it against a built IDL; the CLI's test file
// (`scripts/bayla-ladder-ops.test.mjs`) is the pinned reference.
//
// Module split follows `src/lib/launcher/solana/curve/`: `program.ts` holds identity
// + decoding, `ix.ts` holds pure instruction builders, `read.ts` classifies what came
// back. Same `Decoded<T>` convention: a failure returns a REASON, never a zeroed
// struct, because this venue's repeated defect is a zero that no read produced.
//
// ── THE THREE THINGS A LADDER POOL HAS THAT A STREAMFLOW POOL DOES NOT ───────
//  1. DEPOSIT GATES. `minStake` (immutable — no setter exists), `depositCap`
//     (raise-only, 48h timelock) and `maxWalletPrincipal` are all enforced on-chain.
//     A UI that does not pre-check them turns a refusal into a confusing failure.
//  2. `rewardsCarried` — a per-wallet balance the hatch and a closing exit deposit,
//     claimable separately. It is real money sitting in a field, and a UI that never
//     shows it is hiding a balance.
//  3. `degraded` — an authority-set flag that FLATTENS the ladder and makes the
//     hatch free. It changes what the exit doors cost, so it changes what the UI
//     must say.
//
// ⚠️ THE HATCH IS NOT FREE WHILE LOCKED. `emergency_withdraw` charges the same flat
// 25% as `early_exit` when `now < lock_end` and the pool is not degraded
// (bayla-ladder/src/lib.rs:607-613). Confirmed on chain: the `Withdrawn` event on a
// 500-token locked position decoded to `amount=375, penalty=125`, while the
// `transfer_checked` in that same transaction moved only 375 — so the penalty is
// invisible to anything watching token transfers, and to a raw simulation. It has to
// be computed and shown. An earlier version of the CLI and the runbook both said
// "no penalty"; a review caught it before anyone lost money to it.
import { PublicKey } from '@solana/web3.js';

/* ─────────────────────────── identity ─────────────────────────── */

/**
 * The deployed program.
 *
 * Env-driven and ABSENT BY DEFAULT: unlike the Streamflow rail there is no mainnet
 * bayla-ladder yet, and a hardcoded devnet id would be a live-looking address on a
 * cluster the app does not talk to. `isLadderConfigured()` is the gate every caller
 * must pass before deriving anything.
 */
export const LADDER_PROGRAM_ID: string =
  (import.meta.env.VITE_BAYLA_LADDER_PROGRAM as string | undefined)?.trim() ?? '';

/** True once an operator has pointed the app at a deployed ladder program. */
export function isLadderConfigured(): boolean {
  return LADDER_PROGRAM_ID.length > 0;
}

/** Throws rather than deriving addresses off an empty program id. */
export function ladderProgramId(): PublicKey {
  if (!isLadderConfigured()) {
    throw new Error('bayla-ladder is not configured — set VITE_BAYLA_LADDER_PROGRAM');
  }
  return new PublicKey(LADDER_PROGRAM_ID);
}

export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const TOKEN_LEGACY_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const SYSTEM_PROGRAM_ID = new PublicKey('11111111111111111111111111111111');

/* ─────────────────── the program's own bounds (math.rs) ─────────────────── */

export const MIN_LOCK_SECS = 7 * 86_400;
export const MAX_LOCK_SECS = 4 * 365 * 86_400;
export const REWARDS_DURATION_SECS = 90 * 86_400;
/** Both exit doors charge this. `penalty_for(a) = a * 2500 / 10000`, floored. */
export const EARLY_EXIT_PENALTY_BPS = 2_500;
export const BPS = 10_000;
/** The ladder's ends, in bps: 0.40x at the 7-day floor, 4.00x at 4 years. */
export const MIN_BOOST_BPS = 4_000;
export const MAX_BOOST_BPS = 40_000;
/** Positions per wallet per pool — this is what bounds client enumeration. */
export const MAX_POSITIONS = 20;

/* ─────────────────────────── discriminators ─────────────────────────── */

// `sha256("global:<snake_case>")[0..8]` and `sha256("account:<PascalCase>")[0..8]`.
// TRANSCRIBED FROM THE BUILT IDL rather than recomputed: recomputing sha256 on both
// sides agrees with itself and proves nothing, so the literal is the witness.
export const IX_DISCRIMINATOR = {
  initializePool: Uint8Array.from([95, 180, 10, 172, 84, 174, 232, 40]),
  stake: Uint8Array.from([206, 176, 202, 18, 200, 209, 179, 108]),
  claim: Uint8Array.from([62, 198, 214, 193, 213, 159, 108, 210]),
  withdrawMatured: Uint8Array.from([250, 148, 159, 141, 164, 95, 1, 80]),
  earlyExit: Uint8Array.from([57, 50, 147, 224, 231, 173, 36, 75]),
  emergencyWithdraw: Uint8Array.from([239, 45, 203, 64, 150, 73, 218, 92]),
  claimCarried: Uint8Array.from([173, 173, 45, 126, 170, 32, 215, 248]),
  notifyReward: Uint8Array.from([252, 51, 75, 132, 223, 48, 177, 213]),
} as const;

export const ACCOUNT_DISCRIMINATOR = {
  Pool: Uint8Array.from([241, 154, 109, 4, 17, 177, 109, 188]),
  Position: Uint8Array.from([170, 188, 143, 228, 122, 64, 247, 208]),
  UserStats: Uint8Array.from([176, 223, 136, 27, 122, 79, 32, 227]),
} as const;

/* ─────────────────────────── seeds + PDAs ─────────────────────────── */

const enc = (s: string) => new TextEncoder().encode(s);
export const POOL_SEED = enc('pool');
export const POSITION_SEED = enc('position');
export const USER_SEED = enc('user');
export const STAKE_VAULT_SEED = enc('svault');
export const REWARD_VAULT_SEED = enc('rvault');

const u32le = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

/** One pool per (mint, nonce). The nonce is a **u8** — 256 would wrap to 0. */
export function poolPda(programId: PublicKey, mint: PublicKey, nonce: number): PublicKey {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 255) {
    throw new Error(`pool nonce must be a u8 (0-255), got ${nonce}`);
  }
  return PublicKey.findProgramAddressSync(
    [POOL_SEED, mint.toBytes(), Uint8Array.from([nonce])], programId)[0];
}

export const stakeVaultPda = (programId: PublicKey, pool: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([STAKE_VAULT_SEED, pool.toBytes()], programId)[0];

export const rewardVaultPda = (programId: PublicKey, pool: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([REWARD_VAULT_SEED, pool.toBytes()], programId)[0];

export const userStatsPda = (programId: PublicKey, pool: PublicKey, owner: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([USER_SEED, pool.toBytes(), owner.toBytes()], programId)[0];

/** The position nonce is a **u32 LE**, assigned by the program from `next_nonce`. */
export function positionPda(
  programId: PublicKey, pool: PublicKey, owner: PublicKey, nonce: number,
): PublicKey {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > 0xffffffff) {
    throw new Error(`position nonce must be a u32, got ${nonce}`);
  }
  return PublicKey.findProgramAddressSync(
    [POSITION_SEED, pool.toBytes(), owner.toBytes(), u32le(nonce)], programId)[0];
}

/**
 * The owner's associated token account.
 *
 * The program constrains `owner_ata` only by `mint == pool.mint && owner == owner`,
 * so ANY token account of the right mint and owner is accepted — but the canonical
 * ATA is the one a wallet actually holds, and the one a UI can create idempotently.
 */
export function associatedTokenAddress(
  mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgram.toBytes(), mint.toBytes()], ASSOCIATED_TOKEN_PROGRAM_ID)[0];
}

/* ─────────────────────────── account layouts ─────────────────────────── */

// Offsets INCLUDE the 8-byte anchor discriminator, and the totals are the sizes the
// program pins as literals in its own Rust test (`account_sizes_are_pinned`). That
// agreement is what makes the offsets trustworthy — a decoder wrong by one byte
// still returns a plausible number.
export const POOL_SIZE = 508;
export const POSITION_SIZE = 205;
export const USER_STATS_SIZE = 126;

const POOL_L = {
  bump: 8, nonce: 9, mint: 10, tokenProgram: 42, decimals: 74, authority: 75,
  pendingAuthority: 107, stakeVault: 139, rewardVault: 171, minStake: 203,
  depositCap: 211, pendingCap: 219, pendingCapTs: 227, maxWalletPrincipal: 235,
  totalPrincipal: 243, totalWeighted: 251, rewardRate: 267, periodFinish: 283,
  lastUpdateTime: 291, rewardPerWeightStored: 299, rewardsEmitted: 315,
  rewardsPaid: 331, rewardFundedCumulative: 347, penaltyCollectedCumulative: 363,
  orphanedPenalty: 379, degraded: 387,
} as const;

const POSITION_L = {
  bump: 8, pool: 9, owner: 41, nonce: 73, amount: 77, weight: 85, lockEnd: 101,
  rewardPerWeightPaid: 109, rewardsOwed: 125,
} as const;

const USER_L = {
  bump: 8, pool: 9, owner: 41, nextNonce: 73, openPositions: 77,
  rewardsCarried: 78, principal: 94,
} as const;

/* ─────────────────────────── views ─────────────────────────── */

export interface LadderPoolView {
  address: string;
  bump: number;
  nonce: number;
  mint: string;
  /** Pinned at init to whatever program ACTUALLY owns the mint. Never assumed. */
  tokenProgram: string;
  decimals: number;
  authority: string;
  pendingAuthority: string;
  stakeVault: string;
  rewardVault: string;
  /** Immutable. There is no `set_min_stake` anywhere in the program. */
  minStakeRaw: bigint;
  /** Raise-only, behind a 48h timelock. */
  depositCapRaw: bigint;
  pendingCapRaw: bigint;
  pendingCapTs: bigint;
  maxWalletPrincipalRaw: bigint;
  totalPrincipalRaw: bigint;
  totalWeighted: bigint;
  rewardRate: bigint;
  periodFinish: bigint;
  lastUpdateTime: bigint;
  rewardsEmitted: bigint;
  rewardsPaid: bigint;
  rewardFundedCumulative: bigint;
  penaltyCollectedCumulative: bigint;
  orphanedPenaltyRaw: bigint;
  /** Set by the authority. Flattens the ladder AND makes the hatch free. */
  degraded: boolean;
}

export interface LadderPositionView {
  address: string;
  pool: string;
  owner: string;
  nonce: number;
  amountRaw: bigint;
  weight: bigint;
  lockEnd: bigint;
  rewardsOwed: bigint;
}

export interface LadderUserStatsView {
  address: string;
  nextNonce: number;
  openPositions: number;
  /** Rewards the hatch (or a closing exit) deferred. Claimable via `claim_carried`. */
  rewardsCarriedRaw: bigint;
  principalRaw: bigint;
}

/** A decode either succeeded or says WHY it did not. Never a zeroed struct. */
export type Decoded<T> = { ok: true; value: T } | { ok: false; reason: string };

/* ─────────────────────────── decoding ─────────────────────────── */

const rdU64 = (v: DataView, o: number) => v.getBigUint64(o, true);
const rdI64 = (v: DataView, o: number) => v.getBigInt64(o, true);
const rdU128 = (v: DataView, o: number) => v.getBigUint64(o, true) + (v.getBigUint64(o + 8, true) << 64n);
const rdKey = (d: Uint8Array, o: number) => new PublicKey(d.subarray(o, o + 32)).toBase58();

function rdBool(d: Uint8Array, o: number): boolean | null {
  const b = d[o];
  return b === 0 ? false : b === 1 ? true : null;
}

function sameDiscriminator(d: Uint8Array, want: Uint8Array): boolean {
  if (d.length < 8) return false;
  for (let i = 0; i < 8; i++) if (d[i] !== want[i]) return false;
  return true;
}

const view = (d: Uint8Array) => new DataView(d.buffer, d.byteOffset, d.byteLength);

export function decodeLadderPool(
  address: string, data: Uint8Array | null | undefined,
): Decoded<LadderPoolView> {
  if (!data) return { ok: false, reason: 'missing' };
  if (data.length !== POOL_SIZE) return { ok: false, reason: `bad-length ${data.length}` };
  if (!sameDiscriminator(data, ACCOUNT_DISCRIMINATOR.Pool)) {
    return { ok: false, reason: 'wrong-discriminator' };
  }
  const degraded = rdBool(data, POOL_L.degraded);
  // A byte that is neither 0 nor 1 is not `true`. It is a malformed account.
  if (degraded === null) return { ok: false, reason: 'malformed' };
  const v = view(data);
  return {
    ok: true,
    value: {
      address,
      bump: data[POOL_L.bump]!,
      nonce: data[POOL_L.nonce]!,
      mint: rdKey(data, POOL_L.mint),
      tokenProgram: rdKey(data, POOL_L.tokenProgram),
      decimals: data[POOL_L.decimals]!,
      authority: rdKey(data, POOL_L.authority),
      pendingAuthority: rdKey(data, POOL_L.pendingAuthority),
      stakeVault: rdKey(data, POOL_L.stakeVault),
      rewardVault: rdKey(data, POOL_L.rewardVault),
      minStakeRaw: rdU64(v, POOL_L.minStake),
      depositCapRaw: rdU64(v, POOL_L.depositCap),
      pendingCapRaw: rdU64(v, POOL_L.pendingCap),
      pendingCapTs: rdI64(v, POOL_L.pendingCapTs),
      maxWalletPrincipalRaw: rdU64(v, POOL_L.maxWalletPrincipal),
      totalPrincipalRaw: rdU64(v, POOL_L.totalPrincipal),
      totalWeighted: rdU128(v, POOL_L.totalWeighted),
      rewardRate: rdU128(v, POOL_L.rewardRate),
      periodFinish: rdI64(v, POOL_L.periodFinish),
      lastUpdateTime: rdI64(v, POOL_L.lastUpdateTime),
      rewardsEmitted: rdU128(v, POOL_L.rewardsEmitted),
      rewardsPaid: rdU128(v, POOL_L.rewardsPaid),
      rewardFundedCumulative: rdU128(v, POOL_L.rewardFundedCumulative),
      penaltyCollectedCumulative: rdU128(v, POOL_L.penaltyCollectedCumulative),
      orphanedPenaltyRaw: rdU64(v, POOL_L.orphanedPenalty),
      degraded,
    },
  };
}

export function decodeLadderPosition(
  address: string, data: Uint8Array | null | undefined,
): Decoded<LadderPositionView> {
  if (!data) return { ok: false, reason: 'missing' };
  if (data.length !== POSITION_SIZE) return { ok: false, reason: `bad-length ${data.length}` };
  if (!sameDiscriminator(data, ACCOUNT_DISCRIMINATOR.Position)) {
    return { ok: false, reason: 'wrong-discriminator' };
  }
  const v = view(data);
  return {
    ok: true,
    value: {
      address,
      pool: rdKey(data, POSITION_L.pool),
      owner: rdKey(data, POSITION_L.owner),
      nonce: v.getUint32(POSITION_L.nonce, true),
      amountRaw: rdU64(v, POSITION_L.amount),
      weight: rdU128(v, POSITION_L.weight),
      lockEnd: rdI64(v, POSITION_L.lockEnd),
      rewardsOwed: rdU128(v, POSITION_L.rewardsOwed),
    },
  };
}

export function decodeLadderUserStats(
  address: string, data: Uint8Array | null | undefined,
): Decoded<LadderUserStatsView> {
  if (!data) return { ok: false, reason: 'missing' };
  if (data.length !== USER_STATS_SIZE) return { ok: false, reason: `bad-length ${data.length}` };
  if (!sameDiscriminator(data, ACCOUNT_DISCRIMINATOR.UserStats)) {
    return { ok: false, reason: 'wrong-discriminator' };
  }
  const v = view(data);
  return {
    ok: true,
    value: {
      address,
      nextNonce: v.getUint32(USER_L.nextNonce, true),
      openPositions: data[USER_L.openPositions]!,
      rewardsCarriedRaw: rdU128(v, USER_L.rewardsCarried),
      principalRaw: rdU64(v, USER_L.principal),
    },
  };
}

/* ─────────────────────────── the ladder, and the doors ─────────────────────────── */

/**
 * Boost in bps for a lock length — the program's own formula, integer-floored the
 * same way. Verified on chain: 500 tokens at 7 days produced weight 200 000 000
 * (0.40x, the FLOOR) and at 30 days 228 450 000 (0.4569x).
 */
export function boostBpsForLock(lockSecs: number): number {
  if (lockSecs <= MIN_LOCK_SECS) return MIN_BOOST_BPS;
  if (lockSecs >= MAX_LOCK_SECS) return MAX_BOOST_BPS;
  const span = MAX_LOCK_SECS - MIN_LOCK_SECS;
  return MIN_BOOST_BPS + Math.floor(((MAX_BOOST_BPS - MIN_BOOST_BPS) * (lockSecs - MIN_LOCK_SECS)) / span);
}

/** The weight a stake would carry. `amount * boost_bps / 10_000`, floored. */
export function weightForStake(amountRaw: bigint, lockSecs: number): bigint {
  return (amountRaw * BigInt(boostBpsForLock(lockSecs))) / BigInt(BPS);
}

/** `penalty_for` — 25%, floored, exactly as `math.rs` computes it. */
export function penaltyFor(amountRaw: bigint): bigint {
  return (amountRaw * BigInt(EARLY_EXIT_PENALTY_BPS)) / BigInt(BPS);
}

export type ExitDoor = 'matured' | 'early' | 'hatch';

export interface ExitQuote {
  door: ExitDoor;
  /** What the program will actually retain. NOT always zero for the hatch. */
  penaltyRaw: bigint;
  /** Principal the wallet receives. */
  receivesRaw: bigint;
  /** True when this door will be REFUSED on chain right now. */
  refused: boolean;
  reason: string;
}

/**
 * What each door costs THIS position, right now.
 *
 * The two normal doors partition time — `withdraw_matured` demands `now >= lock_end`
 * and `early_exit` demands `now <`, so exactly one is open and the other reverts. The
 * hatch is always open, and is the one whose price surprises people: it charges the
 * SAME 25% while locked, and is free only after maturity or once the pool is
 * `degraded`. `early_exit` at the same price also pays the rewards out, so in a
 * healthy pool it strictly dominates the hatch; the hatch is for when the reward
 * ledger is what is blocking you.
 */
export function quoteExit(
  position: Pick<LadderPositionView, 'amountRaw' | 'lockEnd'>,
  pool: Pick<LadderPoolView, 'degraded'>,
  nowSecs: number,
): ExitQuote[] {
  const matured = BigInt(Math.floor(nowSecs)) >= position.lockEnd;
  const locked = !matured;
  const full = position.amountRaw;
  const pen = penaltyFor(full);
  const hatchPenalty = locked && !pool.degraded ? pen : 0n;
  return [
    {
      door: 'matured',
      penaltyRaw: 0n,
      receivesRaw: full,
      refused: locked,
      reason: locked ? 'still locked — the program refuses this door until the lock ends' : 'free',
    },
    {
      door: 'early',
      penaltyRaw: pen,
      receivesRaw: full - pen,
      refused: matured,
      reason: matured
        ? 'already matured — the program sends you to the free door instead'
        : '25% retained; your accrued rewards are paid out',
    },
    {
      door: 'hatch',
      penaltyRaw: hatchPenalty,
      receivesRaw: full - hatchPenalty,
      refused: false,
      reason: hatchPenalty > 0n
        ? '25% retained — the hatch is NOT free while locked; rewards are deferred, not lost'
        : pool.degraded
          ? 'free while the pool is degraded; rewards are deferred, not lost'
          : 'free after maturity; rewards are deferred, not lost',
    },
  ];
}

/* ─────────────────────────── deposit gates ─────────────────────────── */

export interface DepositVerdict {
  allowed: boolean;
  /** Empty when allowed. One sentence, in the user's terms, when not. */
  reason: string;
}

/**
 * Would this stake be accepted? Checked LOCALLY so a refusal explains itself
 * instead of arriving as an on-chain constraint failure.
 *
 * `walletPrincipalRaw` is the wallet's CURRENT principal in this pool — the cap is
 * on the total, not on the single deposit.
 */
export function checkDeposit(
  pool: Pick<LadderPoolView, 'minStakeRaw' | 'depositCapRaw' | 'maxWalletPrincipalRaw' | 'totalPrincipalRaw' | 'degraded'>,
  amountRaw: bigint,
  walletPrincipalRaw: bigint,
  lockSecs: number,
  openPositions: number,
): DepositVerdict {
  if (amountRaw <= 0n) return { allowed: false, reason: 'Enter an amount.' };
  if (amountRaw < pool.minStakeRaw) {
    return { allowed: false, reason: `This pool has a minimum stake. It cannot be lowered — the program has no setter for it.` };
  }
  if (lockSecs < MIN_LOCK_SECS) return { allowed: false, reason: 'The shortest lock this pool allows is 7 days.' };
  if (lockSecs > MAX_LOCK_SECS) return { allowed: false, reason: 'The longest lock this pool allows is 4 years.' };
  if (openPositions >= MAX_POSITIONS) {
    return { allowed: false, reason: `You already have ${MAX_POSITIONS} open positions here, which is the per-wallet limit.` };
  }
  if (pool.totalPrincipalRaw + amountRaw > pool.depositCapRaw) {
    return { allowed: false, reason: 'This would take the pool past its deposit cap.' };
  }
  if (walletPrincipalRaw + amountRaw > pool.maxWalletPrincipalRaw) {
    return { allowed: false, reason: 'This would take you past the per-wallet limit for this pool.' };
  }
  return { allowed: true, reason: '' };
}

/** Seconds of runway the reward vault has left, or null when it cannot be derived. */
export function rewardRunwaySecs(
  pool: Pick<LadderPoolView, 'rewardRate' | 'periodFinish'>, nowSecs: number,
): number | null {
  if (pool.rewardRate <= 0n) return null;
  const left = Number(pool.periodFinish) - Math.floor(nowSecs);
  return left > 0 ? left : 0;
}
