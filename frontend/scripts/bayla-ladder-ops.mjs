// bayla-ladder operator + tester CLI.
//
// The program is deployed by `solana program deploy`; everything AFTER that —
// creating the pool, funding a reward window, and driving a real position
// end-to-end — had no tooling at all. The only code that had ever called
// `initialize_pool` was inline YAML inside `solana-ci.yml`, which cannot be run
// anywhere but a CI runner. This is that tooling.
//
//   READ (no keypair, no signing, safe anywhere):
//     node scripts/bayla-ladder-ops.mjs read --pool <addr>
//     node scripts/bayla-ladder-ops.mjs positions --pool <addr> --owner <addr>
//
//   OPERATOR (dry run by default — builds, SIMULATES, prints; signs nothing):
//     node scripts/bayla-ladder-ops.mjs init-pool --mint <m> --nonce 0 \
//          --min-stake 100 --deposit-cap 1000000 --max-wallet 100000
//     node scripts/bayla-ladder-ops.mjs notify --pool <p> --amount 50000
//     node scripts/bayla-ladder-ops.mjs notify --pool <p> --amount 0 --from-budget max
//     node scripts/bayla-ladder-ops.mjs notify --pool <p> --amount 50000 --preview  # NO keypair
//
//   STAKER (same dry-run rule):
//     node scripts/bayla-ladder-ops.mjs stake  --pool <p> --amount 500 --lock-days 90
//     node scripts/bayla-ladder-ops.mjs claim  --pool <p> --nonce 0
//     node scripts/bayla-ladder-ops.mjs exit   --pool <p> --nonce 0        # matured, free
//     node scripts/bayla-ladder-ops.mjs exit   --pool <p> --nonce 0 --early # 75% penalty
//     node scripts/bayla-ladder-ops.mjs hatch  --pool <p> --nonce 0
//     node scripts/bayla-ladder-ops.mjs claim-carried --pool <p>
//
// ⚠ THE HATCH IS NOT FREE WHILE LOCKED. `emergency_withdraw` charges the SAME flat
// 75% as `early_exit` when `now < lock_end` and the pool is not `degraded`
// (lib.rs `emergency_withdraw`). It is free only after maturity, or once the pool is
// degraded — which frees `early_exit` too.
// This file said "no penalty" unconditionally and the runbook agreed with it; both
// were wrong, and the penalty is invisible in a dry run because it rides inside a
// base64 `Program data:` event line. `hatch` now reads the position and prints the
// real number. What the hatch DOES avoid is the reward ledger: accrued rewards move
// to `rewards_carried` and stay claimable, so it cannot revert on accounting drift.
//
// NO PERCENTAGE IS TYPED INTO ANYTHING THIS CLI PRINTS. Every one is built from
// EARLY_EXIT_PENALTY_BPS (and every amount from `penaltyFor`), so the output cannot say
// one number while the program charges another; the test refuses a literal.
//
// ⏱ "NOW" IS THE CHAIN'S, NEVER THIS MACHINE'S. Lock state, penalties and reward rates
// are all decided against the Clock sysvar's `unix_timestamp`, read in the SAME
// `getMultipleAccountsInfoAndContext` call as the pool and its vaults. A wall clock that
// runs even a few seconds ahead of the cluster prints "matured, no penalty" for a
// position the program still charges, and a failed Clock read aborts rather than
// becoming zero.
//
//   Add --broadcast to actually send. Without it NOTHING is signed or sent: the
//   transaction is built and run through `simulateTransaction` with
//   sigVerify:false, so you get the program's real logs and compute usage against
//   real chain state before you commit a lamport. A dry run that "passes" is
//   therefore evidence, not a formatting exercise.
//
// AMOUNTS ARE WHOLE TOKENS on the command line and converted with the mint's OWN
// decimals, read on-chain. Never pass raw base units.
//
// Security posture, same as bayla-lighthouse-ceremony.mjs: --keypair reads a
// standard solana id.json, secret keys are never printed, and broadcasting is an
// explicit, separate act.
//
// ── why this file hand-encodes everything ────────────────────────────────────
// `@coral-xyz/anchor` is not a dependency of this repo and adding it to ship one
// script is not worth the weight. Discriminators are `sha256("global:<snake>")`
// and `sha256("account:<Pascal>")`, first 8 bytes — the identical routine that
// reproduces every committed value in
// `src/lib/launcher/solana/curve/program.ts` byte-for-byte. Accounts are passed
// in DECLARATION order because Anchor matches by POSITION, not by name; a
// reordered list produces a confusing constraint failure rather than an obvious
// one. The layout offsets below are hand-summed and their totals are asserted
// against the sizes the program itself pins (508 / 205 / 126).
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
// EXPLICIT, never off `globalThis` — the same rule `curve/ix.ts` states and for
// the same reason. The seed constants below are built at module-eval time, and
// under a jsdom test environment the ambient `Buffer` is a shim whose output
// `findProgramAddressSync` cannot use: every bump comes back on-curve and it
// throws "Unable to find a viable program address nonce". That failure names
// nothing about Buffer, and importing this module poisoned an unrelated test in
// the same file before the import was made explicit.
import { Buffer } from 'buffer';
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
// The ATA is not created by the program: every token-moving instruction takes it as a
// bare `constraint`, so a wallet that has never held this mint has no account for the
// tokens to land in and the instruction fails on a missing account. The IDEMPOTENT
// form is safe to prepend unconditionally - it is a no-op when the ATA exists.
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';

// ── constants ────────────────────────────────────────────────────────────────

const POOL_SEED = Buffer.from('pool');
const POSITION_SEED = Buffer.from('position');
const USER_SEED = Buffer.from('user');
const STAKE_VAULT_SEED = Buffer.from('svault');
const REWARD_VAULT_SEED = Buffer.from('rvault');

/** math.rs — the ladder's own bounds. Quoted so a mistake is refused locally. */
const MIN_LOCK_SECS = 7 * 86_400;
const MAX_LOCK_SECS = 4 * 365 * 86_400;
const REWARDS_DURATION_SECS = 90 * 86_400;
/**
 * math.rs: penalty_for(a) = a * 7500 / 10000, floored. Used by BOTH early doors.
 * 75% since 2026-09-17; the test file reads it back out of math.rs. Not the EVM
 * LighthouseLadder.sol, which still charges 25%.
 */
const EARLY_EXIT_PENALTY_BPS = 7_500;
const BPS = 10_000;
const PENALTY_PCT = `${EARLY_EXIT_PENALTY_BPS / 100}%`;

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const TOKEN_LEGACY = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

const disc = (ns, name) => createHash('sha256').update(`${ns}:${name}`).digest().subarray(0, 8);

const IX = {
  initializePool: disc('global', 'initialize_pool'),
  stake: disc('global', 'stake'),
  claim: disc('global', 'claim'),
  withdrawMatured: disc('global', 'withdraw_matured'),
  earlyExit: disc('global', 'early_exit'),
  emergencyWithdraw: disc('global', 'emergency_withdraw'),
  claimCarried: disc('global', 'claim_carried'),
  notifyReward: disc('global', 'notify_reward'),
  sweepOrphanedPenalty: disc('global', 'sweep_orphaned_penalty'),
  proposeAuthority: disc('global', 'propose_authority'),
  acceptAuthority: disc('global', 'accept_authority'),
  proposeCapRaise: disc('global', 'propose_cap_raise'),
  cancelCapRaise: disc('global', 'cancel_cap_raise'),
  executeCapRaise: disc('global', 'execute_cap_raise'),
  declareDegraded: disc('global', 'declare_degraded'),
};
// math.rs:102 - the delay between propose_cap_raise and execute_cap_raise.
const CAP_TIMELOCK_SECS = 48 * 3_600;

/** math.rs PRECISION and MIN_BOOST_BPS, for the off-chain replay of `checkpoint`. */
const PRECISION = 1_000_000_000_000n;
const MIN_BOOST_BPS = 4_000n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

/** What the leaver KEEPS on an early door, as printed (PENALTY_PCT, above, is what they forfeit). */
const KEEP_PCT = `${(BPS - EARLY_EXIT_PENALTY_BPS) / 100}%`;

/** Blockhash life is ~60-90s; a notify previewed now may land this much later. */
const LANDING_SLACK_SECS = 120n;

// The program's error codes, 6000 + declaration order in errors.rs. Pinned against the
// committed IDL by the test. `submit` names a simulated failure with this, so an
// operator reads `RewardRateWouldDecrease (6028)` instead of `{"Custom":6028}`.
const LADDER_ERRORS = Object.freeze({
  6000: 'Overflow', 6001: 'ZeroAmount', 6002: 'LockTooShort', 6003: 'LockTooLong',
  6004: 'BelowMinStake', 6005: 'TooManyPositions', 6006: 'DepositCapExceeded',
  6007: 'StillLocked', 6008: 'UseWithdrawMatured', 6009: 'Unauthorized',
  6010: 'NotDeployAuthority', 6011: 'MintHasFreezeAuthority', 6012: 'UnsupportedMintExtension',
  6013: 'WrongTokenProgram', 6014: 'RewardTooHigh', 6015: 'CapCanOnlyRaise',
  6016: 'TimelockNotElapsed', 6017: 'NoPendingChange', 6018: 'InvalidParameter',
  6019: 'AlreadyDegraded', 6020: 'EmissionExceedsFunding', 6021: 'PrincipalInvariant',
  6022: 'WeightInvariant', 6023: 'NothingToSweep', 6024: 'RewardRateTooSmall',
  6025: 'MintHasMintAuthority', 6026: 'PoolDegraded', 6027: 'WalletCapExceeded',
  6028: 'RewardRateWouldDecrease',
});
const errName = (code) => `${LADDER_ERRORS[code]} (${code})`;

// Sysvar accounts are owned by the sysvar "program", and the Clock is exactly 40 bytes:
// slot u64 @0, epoch_start_timestamp i64 @8, epoch u64 @16, leader_schedule_epoch u64 @24,
// unix_timestamp i64 @32.
const SYSVAR_OWNER = new PublicKey('Sysvar1111111111111111111111111111111111111');
const CLOCK_SIZE = 40;
/** An SPL token account (legacy and Token-2022 base): mint @0, owner @32, amount u64 @64. */
const TOKEN_ACCOUNT_MIN_SIZE = 165;

const ACCT = {
  Pool: disc('account', 'Pool'),
  Position: disc('account', 'Position'),
  UserStats: disc('account', 'UserStats'),
};

// Offsets INCLUDE the 8-byte discriminator. Totals are asserted below against the
// sizes `account_sizes_are_pinned` fixes in the program itself — if the program's
// layout moves and this file does not, the assertion fires here rather than
// producing plausible-looking garbage.
const POOL_L = {
  bump: 8, nonce: 9, mint: 10, tokenProgram: 42, decimals: 74, authority: 75,
  pendingAuthority: 107, stakeVault: 139, rewardVault: 171, minStake: 203,
  depositCap: 211, pendingCap: 219, pendingCapTs: 227, maxWalletPrincipal: 235,
  totalPrincipal: 243, totalWeighted: 251, rewardRate: 267, periodFinish: 283,
  lastUpdateTime: 291, rewardPerWeightStored: 299, rewardsEmitted: 315,
  rewardsPaid: 331, rewardFundedCumulative: 347, penaltyCollectedCumulative: 363,
  orphanedPenalty: 379, degraded: 387, rpwResidue: 388, emittedResidue: 404,
  SIZE: 508,
};
const POSITION_L = {
  bump: 8, pool: 9, owner: 41, nonce: 73, amount: 77, weight: 85, lockEnd: 101,
  rewardPerWeightPaid: 109, rewardsOwed: 125, SIZE: 205,
};
const USER_L = {
  bump: 8, pool: 9, owner: 41, nextNonce: 73, openPositions: 77,
  rewardsCarried: 78, principal: 94, SIZE: 126,
};

// ── tiny binary helpers ──────────────────────────────────────────────────────

const u8 = (n) => Buffer.from([n & 0xff]);
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64le = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const i64le = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };

const rdU64 = (d, o) => d.readBigUInt64LE(o);
const rdI64 = (d, o) => d.readBigInt64LE(o);
const rdU128 = (d, o) => d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n);
const rdKey = (d, o) => new PublicKey(d.subarray(o, o + 32));
const rdBool = (d, o) => (d[o] === 0 ? false : d[o] === 1 ? true : null);

function sameDisc(data, want) {
  if (!data || data.length < 8) return false;
  for (let i = 0; i < 8; i++) if (data[i] !== want[i]) return false;
  return true;
}

/** Raw base units -> a readable decimal string. Never a float. */
function fmt(raw, decimals) {
  if (raw === null || raw === undefined) return '—';
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals) || '0';
  const frac = decimals > 0 ? s.slice(s.length - decimals).replace(/0+$/, '') : '';
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + (frac ? `${grouped}.${frac}` : grouped);
}

/** Whole tokens -> raw base units, exactly. Rejects more precision than the mint has. */
function toRaw(human, decimals) {
  const t = String(human).trim();
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`not a positive amount: ${human}`);
  const [w, f = ''] = t.split('.');
  if (f.length > decimals) {
    throw new Error(`${human} has ${f.length} decimal places but the mint has ${decimals}`);
  }
  return BigInt(w + f.padEnd(decimals, '0'));
}

// ── PDAs ─────────────────────────────────────────────────────────────────────

const poolPda = (programId, mint, nonce) =>
  PublicKey.findProgramAddressSync([POOL_SEED, mint.toBuffer(), Buffer.from([nonce])], programId)[0];
const vaultPda = (programId, seed, pool) =>
  PublicKey.findProgramAddressSync([seed, pool.toBuffer()], programId)[0];
const userPda = (programId, pool, owner) =>
  PublicKey.findProgramAddressSync([USER_SEED, pool.toBuffer(), owner.toBuffer()], programId)[0];
const positionPda = (programId, pool, owner, nonce) =>
  PublicKey.findProgramAddressSync(
    [POSITION_SEED, pool.toBuffer(), owner.toBuffer(), u32le(nonce)], programId)[0];

/** The owner's associated token account, for whichever token program owns the mint. */
const ataFor = (mint, owner, tokenProgram) =>
  PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

// ── decoders (a failure returns a REASON, never a zeroed struct) ─────────────

function decodePool(data) {
  if (!data) return { ok: false, reason: 'missing — no account at that address' };
  if (data.length !== POOL_L.SIZE) return { ok: false, reason: `bad-length ${data.length} != ${POOL_L.SIZE}` };
  if (!sameDisc(data, ACCT.Pool)) return { ok: false, reason: 'wrong-discriminator — not a bayla-ladder Pool' };
  const degraded = rdBool(data, POOL_L.degraded);
  if (degraded === null) return { ok: false, reason: 'malformed — `degraded` is neither 0 nor 1' };
  return {
    ok: true,
    value: {
      bump: data[POOL_L.bump], nonce: data[POOL_L.nonce],
      mint: rdKey(data, POOL_L.mint), tokenProgram: rdKey(data, POOL_L.tokenProgram),
      decimals: data[POOL_L.decimals],
      authority: rdKey(data, POOL_L.authority), pendingAuthority: rdKey(data, POOL_L.pendingAuthority),
      stakeVault: rdKey(data, POOL_L.stakeVault), rewardVault: rdKey(data, POOL_L.rewardVault),
      minStake: rdU64(data, POOL_L.minStake), depositCap: rdU64(data, POOL_L.depositCap),
      pendingCap: rdU64(data, POOL_L.pendingCap), pendingCapTs: rdI64(data, POOL_L.pendingCapTs),
      maxWalletPrincipal: rdU64(data, POOL_L.maxWalletPrincipal),
      totalPrincipal: rdU64(data, POOL_L.totalPrincipal),
      totalWeighted: rdU128(data, POOL_L.totalWeighted),
      rewardRate: rdU128(data, POOL_L.rewardRate),
      periodFinish: rdI64(data, POOL_L.periodFinish),
      lastUpdateTime: rdI64(data, POOL_L.lastUpdateTime),
      // The replay of `checkpoint` is exact only with BOTH residues; without them it
      // drifts by up to a unit per interval from what the program will compute.
      rewardPerWeightStored: rdU128(data, POOL_L.rewardPerWeightStored),
      rpwResidue: rdU128(data, POOL_L.rpwResidue),
      emittedResidue: rdU128(data, POOL_L.emittedResidue),
      rewardsEmitted: rdU128(data, POOL_L.rewardsEmitted),
      rewardsPaid: rdU128(data, POOL_L.rewardsPaid),
      rewardFundedCumulative: rdU128(data, POOL_L.rewardFundedCumulative),
      penaltyCollectedCumulative: rdU128(data, POOL_L.penaltyCollectedCumulative),
      orphanedPenalty: rdU64(data, POOL_L.orphanedPenalty),
      degraded,
    },
  };
}

function decodePosition(data) {
  if (!data) return { ok: false, reason: 'missing' };
  if (data.length !== POSITION_L.SIZE) return { ok: false, reason: `bad-length ${data.length}` };
  if (!sameDisc(data, ACCT.Position)) return { ok: false, reason: 'wrong-discriminator' };
  return {
    ok: true,
    value: {
      pool: rdKey(data, POSITION_L.pool), owner: rdKey(data, POSITION_L.owner),
      nonce: data.readUInt32LE(POSITION_L.nonce), amount: rdU64(data, POSITION_L.amount),
      weight: rdU128(data, POSITION_L.weight), lockEnd: rdI64(data, POSITION_L.lockEnd),
      rewardsOwed: rdU128(data, POSITION_L.rewardsOwed),
    },
  };
}

function decodeUserStats(data) {
  if (!data) return { ok: false, reason: 'missing — this wallet has never staked in this pool' };
  if (data.length !== USER_L.SIZE) return { ok: false, reason: `bad-length ${data.length}` };
  if (!sameDisc(data, ACCT.UserStats)) return { ok: false, reason: 'wrong-discriminator' };
  return {
    ok: true,
    value: {
      nextNonce: data.readUInt32LE(USER_L.nextNonce),
      openPositions: data[USER_L.openPositions],
      rewardsCarried: rdU128(data, USER_L.rewardsCarried),
      principal: rdU64(data, USER_L.principal),
    },
  };
}

/** The Clock sysvar. `unix_timestamp` is the only "now" this file may use. */
function decodeClock(info) {
  if (!info) return { ok: false, reason: 'missing — the RPC returned no Clock account' };
  if (!info.owner?.equals?.(SYSVAR_OWNER)) {
    return { ok: false, reason: `owned by ${info.owner?.toBase58?.() ?? String(info.owner)}, not the sysvar program` };
  }
  const data = info.data;
  if (!data || data.length !== CLOCK_SIZE) return { ok: false, reason: `bad-length ${data?.length} != ${CLOCK_SIZE}` };
  return {
    ok: true,
    value: {
      slot: rdU64(data, 0),
      epochStartTimestamp: rdI64(data, 8),
      epoch: rdU64(data, 16),
      leaderScheduleEpoch: rdU64(data, 24),
      unixTimestamp: rdI64(data, 32),
    },
  };
}

/** A pool vault's balance, or a reason. Never a zero standing in for an unread account. */
function decodeTokenAccount(info, p) {
  if (!info) return { ok: false, reason: 'missing — no account at that address' };
  if (!info.owner?.equals?.(p.tokenProgram)) {
    return { ok: false, reason: `owned by ${info.owner?.toBase58?.() ?? String(info.owner)}, not the pool's token program` };
  }
  const data = info.data;
  if (!data || data.length < TOKEN_ACCOUNT_MIN_SIZE) return { ok: false, reason: `bad-length ${data?.length} < ${TOKEN_ACCOUNT_MIN_SIZE}` };
  if (!Buffer.from(data.subarray(0, 32)).equals(p.mint.toBuffer())) return { ok: false, reason: 'holds a different mint' };
  return { ok: true, value: { amount: rdU64(data, 64) } };
}

// ── the reward engine, replayed off-chain (PURE, BigInt) ─────────────────────
//
// `rewards_emitted` is only BANKED when an instruction checkpoints the pool, so the
// stored figure is stale by every second since `last_update_time`. notify_reward
// checkpoints FIRST and then reasons about the banked value, so a preview built on the
// stored one can be wrong in both directions. These mirror math.rs and lib.rs
// `checkpoint` exactly — saturating u128 arithmetic, both residue carries, the burn
// branch — and the test pins them to vectors printed by rustc from math.rs itself.

const satAdd = (a, b) => (a + b > U128_MAX ? U128_MAX : a + b);
const satMul = (a, b) => (a * b > U128_MAX ? U128_MAX : a * b);
const satSub = (a, b) => (a > b ? a - b : 0n);
const i64SatSub = (a, b) => { const d = a - b; return d > I64_MAX ? I64_MAX : d < I64_MIN ? I64_MIN : d; };

/** A `now` that did not come from the Clock sysvar is refused, not coerced. */
function chainTime(now) {
  if (typeof now !== 'bigint') {
    throw new TypeError(`"now" must be the Clock sysvar's unix_timestamp (a bigint), got ${typeof now}`);
  }
  return now;
}

/** math.rs `last_time_applicable`. */
const lastTimeApplicable = (now, periodFinish) => (now < periodFinish ? now : periodFinish);

/** math.rs `min_weight_floor` — invariant I-11's divisor floor. */
const minWeightFloor = (minStake) => (minStake * MIN_BOOST_BPS) / BigInt(BPS);

/** math.rs `reward_per_weight_with_residue`. Returns [rpw, residue]. */
function rewardPerWeightWithResidue(stored, residue, lastUpdate, applicable, rate, totalWeighted, floor) {
  // The burn branch drops the rpw residue.
  if (totalWeighted === 0n || totalWeighted < floor) return [stored, 0n];
  const d = i64SatSub(applicable, lastUpdate);
  const dt = d > 0n ? d : 0n;
  const num = satAdd(residue, satMul(satMul(dt, rate), PRECISION));
  return [satAdd(stored, num / totalWeighted), num % totalWeighted];
}

/** math.rs `emitted_delta_with_residue`. Returns [delta, residue]. */
function emittedDeltaWithResidue(rpwNow, rpwStored, totalWeighted, residue) {
  const num = satAdd(residue, satMul(satSub(rpwNow, rpwStored), totalWeighted));
  return [num / PRECISION, num % PRECISION];
}

/**
 * lib.rs `checkpoint(pool, now)`, returning the pool as the program would leave it.
 *
 * NOTE THE BURN BRANCH. When the interval is burned `rpw == stored`, so the emitted
 * numerator is just the carried `emitted_residue`: it comes back UNCHANGED, not zeroed.
 * state.rs's docstring says both residues are dropped; the code keeps this one, and the
 * replay follows the code.
 */
function checkpointReplay(p, now) {
  chainTime(now);
  const applicable = lastTimeApplicable(now, p.periodFinish);
  const [rpw, rpwResidue] = rewardPerWeightWithResidue(
    p.rewardPerWeightStored, p.rpwResidue, p.lastUpdateTime, applicable,
    p.rewardRate, p.totalWeighted, minWeightFloor(p.minStake));
  const [delta, emittedResidue] = emittedDeltaWithResidue(
    rpw, p.rewardPerWeightStored, p.totalWeighted, p.emittedResidue);
  return {
    ...p,
    rewardsEmitted: satAdd(p.rewardsEmitted, delta),
    rpwResidue,
    emittedResidue,
    rewardPerWeightStored: rpw,
    // `.max(...)`: a mark ahead of `now` is never moved back.
    lastUpdateTime: applicable > p.lastUpdateTime ? applicable : p.lastUpdateTime,
  };
}

/** math.rs `new_reward_rate`: fresh after the window, the unspent tail folded in during it. */
function newRewardRate(amount, now, periodFinish, oldRate) {
  const dur = BigInt(REWARDS_DURATION_SECS);
  if (now >= periodFinish) return amount / dur;
  return satAdd(amount, satMul(periodFinish - now, oldRate)) / dur;
}

/** math.rs `rate_change_allowed`: inside a live window the rate may not fall. */
const rateChangeAllowed = (now, periodFinish, oldRate, newRate) => now >= periodFinish || newRate >= oldRate;

/** math.rs `fundable`: the vault after reserving everything emitted and not yet paid. */
const fundable = (vault, emitted, paid) => satSub(vault, satSub(emitted, paid));

/** math.rs `penalty_for`: the amount FORFEITED on an early door, floored. */
const penaltyFor = (amountRaw) => (amountRaw * BigInt(EARLY_EXIT_PENALTY_BPS)) / BigInt(BPS);

/**
 * What one exit door would do to `position` at chain `now`, mirroring lib.rs:
 *
 *   withdraw_matured    refused while locked (StillLocked); free.
 *   early_exit          refused once matured (UseWithdrawMatured); penalty_for(amount),
 *                       or 0 when the pool is degraded.
 *   emergency_withdraw  never refused; penalty_for(amount) while locked, 0 once matured
 *                       or when the pool is degraded.
 *
 * `door` defaults to the one that applies. A refused door moves nothing, so its
 * `penalty` and `receive` are null, never a zero that reads like "free".
 * `receive` is principal only — rewards are paid (or carried) separately.
 */
const DOORS = ['withdraw_matured', 'early_exit', 'emergency_withdraw'];
function exitPreview(position, pool, chainNow, door) {
  chainTime(chainNow);
  const locked = chainNow < position.lockEnd;
  const d = door ?? (locked ? 'early_exit' : 'withdraw_matured');
  if (!DOORS.includes(d)) throw new Error(`unknown exit door: ${d}`);
  const refuse = (refusedReason) => ({ door: d, locked, penalty: null, receive: null, refusedReason });
  const charge = (penalty) => ({ door: d, locked, penalty, receive: position.amount - penalty, refusedReason: null });
  if (d === 'withdraw_matured') {
    return locked ? refuse(`the position is still locked; withdraw_matured refuses it (${errName(6007)})`) : charge(0n);
  }
  if (d === 'early_exit') {
    if (!locked) return refuse(`the position has matured; early_exit refuses it (${errName(6008)}) — withdraw for free instead`);
    return charge(pool.degraded ? 0n : penaltyFor(position.amount));
  }
  return charge(locked && !pool.degraded ? penaltyFor(position.amount) : 0n);
}

/** The lines `exit` and `hatch` print for a preview. Pure, so the test can read them. */
function exitReport(pv, position, pool, chainNow) {
  const d = pool.decimals;
  const out = [];
  const iso = (t) => new Date(Number(t) * 1000).toISOString();
  out.push(`  door          ${pv.door}`);
  out.push(`  principal     ${fmt(position.amount, d)}`);
  out.push(`  status        ${pv.locked ? 'STILL LOCKED' : 'matured'}${pool.degraded ? ', pool DEGRADED' : ''}` +
    `  (lock ends ${iso(position.lockEnd)}; chain clock ${iso(chainNow)})`);
  if (pv.refusedReason) {
    out.push(`  ⚠ REFUSED: ${pv.refusedReason}`);
    if (pv.door === 'withdraw_matured') {
      const alt = exitPreview(position, pool, chainNow, 'early_exit');
      out.push(`  --early would forfeit ${fmt(alt.penalty, d)} and return ${fmt(alt.receive, d)} of principal` +
        (alt.penalty > 0n ? ` (you keep ${KEEP_PCT})` : ' (no penalty: the pool is degraded)'));
    }
    return out;
  }
  if (pv.penalty > 0n) {
    out.push(`  🔴 PENALTY    ${fmt(pv.penalty, d)} FORFEITED  (${PENALTY_PCT} of principal)`);
    out.push(`  you receive   ${fmt(pv.receive, d)}  (${KEEP_PCT} of principal)`);
    const left = position.lockEnd - chainNow;
    if (left <= LANDING_SLACK_SECS) out.push(`  the lock ends in ${left}s — waiting that long makes this free`);
    else out.push(`  Waiting until ${iso(position.lockEnd)} makes it free.`);
  } else {
    out.push(`  penalty       none — ${pool.degraded && pv.locked ? 'the pool is degraded' : 'this position has matured'}`);
    out.push(`  you receive   ${fmt(pv.receive, d)}  (all of it)`);
  }
  return out;
}

/**
 * The reward ledger as it stands at chain `now`, beside what the account stores.
 * `live` is what the next checkpoint will bank; the stored figure lags it by every
 * second since `last_update_time`.
 */
function liveLedger(p, now) {
  const c = checkpointReplay(p, now);
  return {
    bankedEmitted: p.rewardsEmitted,
    unbanked: c.rewardsEmitted - p.rewardsEmitted,
    liveEmitted: c.rewardsEmitted,
    paid: p.rewardsPaid,
    storedOutstanding: satSub(p.rewardsEmitted, p.rewardsPaid),
    liveOutstanding: satSub(c.rewardsEmitted, p.rewardsPaid),
    // L-4's failure shape: saturation would print this as a healthy zero.
    paidExceedsEmitted: p.rewardsPaid > c.rewardsEmitted,
  };
}

/**
 * How far a mid-window schedule can drift toward RewardTooHigh between preview and
 * landing. The unemitted tail falls by exactly `rate` per second; the fundable budget
 * falls by what gets banked, which exceeds `rate` per second by at most the two residue
 * carries: 2 + 2*ceil(tw/1e12) raw units, with tw bounded by 4x the larger of the
 * deposit cap and any pending raise (every weight is at most 4.00x its principal).
 */
function driftBound(p) {
  const cap = p.depositCap > p.pendingCap ? p.depositCap : p.pendingCap;
  const twMax = 4n * cap > p.totalWeighted ? 4n * cap : p.totalWeighted;
  return 2n + 2n * ((twMax + PRECISION - 1n) / PRECISION);
}

/** What `--from-budget max` leaves unscheduled: the drift bound, never less than one whole token. */
function budgetMargin(p) {
  const bound = driftBound(p);
  const oneToken = 10n ** BigInt(p.decimals);
  return oneToken > bound ? oneToken : bound;
}

/**
 * Everything in the reward vault that a new window may schedule and nothing has pledged:
 * the fundable budget after the transfer, minus the tail the window will fold in, minus
 * the fresh amount (it is already inside that budget), minus the landing margin. The
 * amount cancels, so the result does not depend on it.
 */
function fromBudgetMax({ pool, now, rewardVaultRaw, amount = 0n, margin = budgetMargin(pool) }) {
  const c = checkpointReplay(pool, now);
  const budgetAfter = fundable(rewardVaultRaw + amount, c.rewardsEmitted, pool.rewardsPaid);
  const leftover = now < pool.periodFinish ? satMul(pool.periodFinish - now, pool.rewardRate) : 0n;
  const v = budgetAfter - leftover - amount - margin;
  return v > 0n ? v : 0n;
}

/**
 * notify_reward, previewed at chain `now` against a same-slot snapshot. Checks run in
 * lib.rs order, so the first `problems` entry that carries a `code` is the error the
 * program would raise. Entries without a code are this CLI's own refusals.
 *
 *   problems  always refused before anything is sent
 *   risks     refused under --broadcast: true at preview time, but at risk of flipping
 *             in the seconds before the transaction lands
 *   notes     printed only
 */
function notifyPreview({ pool, now, rewardVaultRaw, amount, fromBudget, allowEmptyPool = false,
  slackSecs = LANDING_SLACK_SECS }) {
  chainTime(now);
  const d = pool.decimals;
  const DUR = BigInt(REWARDS_DURATION_SECS);
  const problems = [];
  const risks = [];
  const notes = [];
  const program = (code, text) => problems.push({ code, name: LADDER_ERRORS[code], text: `${text} (${errName(code)})` });

  const oldRate = pool.rewardRate;
  const pf = pool.periodFinish;
  const midWindow = now < pf;
  const remaining = midWindow ? pf - now : 0n;
  const leftover = satMul(remaining, oldRate);
  const scheduled = amount + fromBudget;

  if (amount === 0n && fromBudget === 0n) program(6001, 'nothing is scheduled: pass --amount and/or --from-budget');
  if (amount > U64_MAX || fromBudget > U64_MAX || scheduled > U64_MAX) {
    problems.push({ code: null, text: 'amount + from-budget exceeds u64; the program would saturate it silently' });
  }
  const c = checkpointReplay(pool, now);
  const vaultPost = rewardVaultRaw + amount;
  const outstanding = satSub(c.rewardsEmitted, pool.rewardsPaid);
  if (outstanding > vaultPost) {
    program(6020, `the pool owes ${fmt(outstanding, d)} at chain now but the vault would hold ${fmt(vaultPost, d)}`);
  }
  const newRate = newRewardRate(scheduled > U64_MAX ? U64_MAX : scheduled, now, pf, oldRate);
  const budget = fundable(vaultPost, c.rewardsEmitted, pool.rewardsPaid);
  const ceiling = budget / DUR;
  if (newRate > ceiling) {
    program(6014, `rate ${fmt(newRate, d)}/s exceeds what the vault can fund, ${fmt(ceiling, d)}/s (budget ${fmt(budget, d)} over 90 days)`);
  }
  if (newRate === 0n) {
    program(6024, `the new rate floors to ZERO per second — the window would emit nothing`);
  } else if (pool.totalWeighted !== 0n && satMul(newRate, PRECISION) < pool.totalWeighted) {
    program(6024, `rate x 1e12 is below total_weighted ${pool.totalWeighted}: the accumulator floors to zero every second and the pool emits NOTHING`);
  }
  // THE RATE GUARD. floor((S + L) / D) >= r  iff  S + L >= r x D, so this is exact.
  const minScheduled = midWindow ? satSub(satMul(oldRate, DUR), leftover) : 0n;
  // Landing drift: the tail shrinks by `oldRate` every second the transaction waits, so
  // the minimum rises. Worst case is the latest landing still inside the window.
  const worstRemaining = remaining - slackSecs >= 1n ? remaining - slackSecs : 1n;
  const minScheduledAtSlack = midWindow ? satSub(satMul(oldRate, DUR), satMul(worstRemaining, oldRate)) : 0n;
  if (!rateChangeAllowed(now, pf, oldRate, newRate)) {
    program(6028, `mid-window the rate may not fall: ${fmt(newRate, d)}/s < ${fmt(oldRate, d)}/s. ` +
      `Schedule at least ${fmt(minScheduled, d)} (the current rate x the seconds elapsed since the last notify)` +
      (fromBudget > 0n
        ? ` — with this from-budget, an --amount of at least ${fmt(satSub(minScheduledAtSlack, fromBudget), d)} (${slackSecs}s of landing slack included)`
        : '') +
      `, or wait for period_finish ${new Date(Number(pf) * 1000).toISOString()}`);
  }
  const drift = driftBound(pool);
  if (midWindow) {
    if (scheduled >= minScheduled && scheduled < minScheduledAtSlack) {
      risks.push(`${fmt(scheduled, d)} holds the rate only if it lands NOW: the minimum is ${fmt(minScheduled, d)} ` +
        `at chain now but ${fmt(minScheduledAtSlack, d)} if it lands ${slackSecs}s later ` +
        `(RewardRateWouldDecrease). Schedule at least ${fmt(minScheduledAtSlack, d)}.`);
    }
    // After period_finish nothing more is banked, so this drift exists only mid-window.
    if (newRate <= ceiling && satAdd(scheduled, leftover) + drift > budget) {
      risks.push(`the schedule sits within ${drift} raw units of the fundable budget: banking between now and landing ` +
        `can turn it into RewardTooHigh. Schedule a little less.`);
    }
  }
  if (pool.rewardsPaid > c.rewardsEmitted) {
    risks.push(`rewards_paid exceeds live rewards_emitted (L-4 anomaly): outstanding saturates to zero and the budget reads high`);
  }
  // CLI-ONLY. Every open position weighs at least the floor, so below it means nobody is
  // staked: each second of the window is burned (I-11), not emitted. The tokens stay in the
  // vault and can be scheduled again, but the window's time is lost.
  //
  // Both halves are the program's, not a hope. lib.rs `checkpoint` below the floor: math.rs
  // `reward_per_weight_with_residue` returns `stored` unchanged, so `emitted_delta_with_residue`
  // banks `emitted_residue / PRECISION` = 0 and `rewards_emitted` does not move, while
  // `last_update_time` still advances to `applicable`. TIME: those seconds are gone, and
  // `period_finish` was fixed at notify time. TOKENS: `fundable` = vault - (emitted - paid)
  // still counts them, and the next mid-window tail is `remaining x rate` only, so they are
  // budget a later notify can schedule with `from_budget`. Nothing can withdraw them either.
  // The floor is never 0 on-chain (initialize_pool requires min_stake >= 10,000 raw), so
  // `total_weighted < floor` covers the program's `total_weighted == 0` case too.
  const floor = minWeightFloor(pool.minStake);
  if (pool.totalWeighted < floor) {
    const text = `total_weighted ${pool.totalWeighted} is below the floor ${floor}${pool.totalWeighted === 0n ? ' (nobody is staked)' : ''}: ` +
      `every second until the first stake is BURNED, not emitted`;
    const cost = 'Funding before anyone stakes loses window TIME, not tokens: the 90 days start now and ' +
      'the burned seconds never come back, but their tokens stay in the reward vault and remain schedulable (--from-budget)';
    if (allowEmptyPool) notes.push(`${text}. Proceeding (--allow-empty-pool). ${cost}.`);
    else problems.push({ code: null, text: `${text}. ${cost}. Pass --allow-empty-pool to fund an empty pool knowingly.` });
  }

  return {
    problems, risks, notes, checkpoint: c, midWindow, oldRate, newRate, remaining, leftover, scheduled,
    vaultPost, outstanding, budget, ceiling, minScheduled, minScheduledAtSlack, floor, drift,
    newPeriodFinish: now + DUR,
    // basis points of the old rate; null when there is no live window to compare against
    pctChangeBps: midWindow && oldRate > 0n ? ((newRate - oldRate) * 10_000n) / oldRate : null,
  };
}

/** Signed basis points as a percentage with two decimals: 5000n -> "+50.00%". */
function fmtBps(bps) {
  const abs = bps < 0n ? -bps : bps;
  return `${bps < 0n ? '-' : '+'}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}%`;
}

/** The lines `notify` prints for a preview. Pure, so the test can read them. */
function notifyReport(pv, pool, { amount, fromBudget, now, slot }) {
  const d = pool.decimals;
  const iso = (t) => new Date(Number(t) * 1000).toISOString();
  const perDay = (r) => `${fmt(r, d)} / s  (${fmt(r * 86_400n, d)} / day)`;
  const out = [];
  if (slot !== undefined) out.push(`  snapshot       slot ${slot}, chain clock ${iso(now)}`);
  out.push(`  fresh capital  ${fmt(amount, d)}  (transferred from your ATA)`);
  out.push(`  from budget    ${fmt(fromBudget, d)}  (already in the reward vault)`);
  out.push(`  current rate   ${perDay(pv.oldRate)}${pv.midWindow ? '' : `  — window ended ${pool.periodFinish === 0n ? '(never funded)' : iso(pool.periodFinish)}, nothing is emitting`}`);
  out.push(`  new rate       ${perDay(pv.newRate)}`);
  out.push(`  change         ${pv.pctChangeBps === null ? 'n/a — no live window to compare against' : fmtBps(pv.pctChangeBps)}`);
  if (pv.midWindow) {
    out.push(`  unemitted tail ${fmt(pv.leftover, d)}  (${pv.remaining}s left x current rate, folded into the new window)`);
  }
  out.push(`  new finish     ${iso(pv.newPeriodFinish)}  (chain now + 90 days; the program uses its landing time)`);
  out.push(`  owed (LIVE)    ${fmt(pv.outstanding, d)}  (emitted to chain now, minus paid; reserved first)`);
  out.push(`  vault after    ${fmt(pv.vaultPost, d)}`);
  out.push(`  fundable       ${fmt(pv.budget, d)}  (ceiling ${fmt(pv.ceiling, d)} / s)`);
  if (pv.midWindow) {
    out.push(`  minimum        ${fmt(pv.minScheduled, d)} holds the current rate at chain now; ` +
      `${fmt(pv.minScheduledAtSlack, d)} if it lands ${LANDING_SLACK_SECS}s later`);
  }
  for (const n of pv.notes) out.push(`  note: ${n}`);
  for (const r of pv.risks) out.push(`  ⚠ RISK: ${r}`);
  for (const p of pv.problems) out.push(`  🔴 REFUSED: ${p.text}`);
  return out;
}

/**
 * What `notify --preview` adds, for an operator who builds the transaction elsewhere (a
 * Squads multisig): who has to sign it, and the smallest --amount that holds the current
 * rate. The minimums are the preview's own `minScheduled` and `minScheduledAtSlack` less
 * --from-budget, because the guard is on the SUM: amount + from_budget + tail >= rate x D.
 * A multisig can take far longer than LANDING_SLACK_SECS to execute, so the per-second
 * growth is printed as well. Pure, so the test can read it.
 */
function notifyPreviewLines(pv, pool, { fromBudget }) {
  const d = pool.decimals;
  const out = [
    '',
    '  PREVIEW — no keypair was read; nothing was built, simulated or sent.',
    `  pool authority     ${pool.authority.toBase58()}  (the notify_reward signer: build the transaction there, e.g. in Squads)`,
  ];
  if (pv.midWindow) {
    out.push(`  minimum --amount   ${fmt(satSub(pv.minScheduled, fromBudget), d)}  holds the current rate if it lands at chain now`);
    out.push(`  minimum --amount   ${fmt(satSub(pv.minScheduledAtSlack, fromBudget), d)}  holds it if it lands ${LANDING_SLACK_SECS}s later`);
    out.push(`                     (with --from-budget ${fmt(fromBudget, d)}; each further second before it lands adds ` +
      `${fmt(pv.oldRate, d)}, ${fmt(pv.oldRate * 3_600n, d)} per hour, until period_finish)`);
  } else {
    out.push('  minimum --amount   none — no live window, so the rate guard does not apply');
  }
  return out;
}

/**
 * `--amount` and `--from-budget` as raw units. `--from-budget max` schedules everything
 * unpledged; when that is nothing and no fresh amount is given, it is refused rather than
 * sent as 0/0.
 */
function resolveNotifyAmounts(args, snap) {
  const p = snap.pool;
  const amount = toRaw(args.amount ?? '0', p.decimals);
  if (args.fromBudget !== 'max') return { amount, fromBudget: toRaw(args.fromBudget ?? '0', p.decimals), max: false };
  if (!snap.rewardVault?.ok) throw new Error(`--from-budget max needs the reward vault balance, and it is unreadable: ${snap.rewardVault?.reason}`);
  if (p.rewardsPaid > checkpointReplay(p, snap.now).rewardsEmitted) {
    throw new Error('--from-budget max refused: rewards_paid exceeds live rewards_emitted (L-4 anomaly), so the fundable budget reads high');
  }
  const fromBudget = fromBudgetMax({ pool: p, now: snap.now, rewardVaultRaw: snap.rewardVault.value.amount, amount });
  if (fromBudget === 0n && amount === 0n) {
    throw new Error('--from-budget max: nothing in the reward vault is unpledged (after the live liability, the unemitted tail and the landing margin)');
  }
  return { amount, fromBudget, max: true };
}

// ── instruction builders (PURE: no connection, no signing) ───────────────────

const meta = (pubkey, isSigner, isWritable) => ({ pubkey, isSigner, isWritable });

function ixInitializePool({ programId, payer, mint, tokenProgram, nonce, minStake, depositCap, maxWallet }) {
  const pool = poolPda(programId, mint, nonce);
  return new TransactionInstruction({
    programId,
    keys: [
      meta(payer, true, true),
      meta(mint, false, false),
      meta(pool, false, true),
      meta(vaultPda(programId, STAKE_VAULT_SEED, pool), false, true),
      meta(vaultPda(programId, REWARD_VAULT_SEED, pool), false, true),
      meta(tokenProgram, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data: Buffer.concat([IX.initializePool, u8(nonce), u64le(minStake), u64le(depositCap), u64le(maxWallet)]),
  });
}

function ixStake({ programId, owner, pool, p, positionNonce, amountRaw, lockSecs }) {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(owner, true, true),
      meta(pool, false, true),
      meta(p.mint, false, false),
      meta(userPda(programId, pool, owner), false, true),
      meta(positionPda(programId, pool, owner, positionNonce), false, true),
      meta(ataFor(p.mint, owner, p.tokenProgram), false, true),
      meta(p.stakeVault, false, true),
      meta(p.tokenProgram, false, false),
      meta(SystemProgram.programId, false, false),
    ],
    data: Buffer.concat([IX.stake, u64le(amountRaw), i64le(lockSecs)]),
  });
}

function ixClaim({ programId, owner, pool, p, positionNonce }) {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(owner, true, false),
      meta(pool, false, true),
      meta(p.mint, false, false),
      meta(positionPda(programId, pool, owner, positionNonce), false, true),
      meta(ataFor(p.mint, owner, p.tokenProgram), false, true),
      meta(p.rewardVault, false, true),
      meta(p.tokenProgram, false, false),
    ],
    data: Buffer.from(IX.claim),
  });
}

/** `Exit` backs BOTH doors — the only difference is the discriminator. */
function ixExit({ programId, owner, pool, p, positionNonce, early }) {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(owner, true, true),
      meta(pool, false, true),
      meta(p.mint, false, false),
      meta(userPda(programId, pool, owner), false, true),
      meta(positionPda(programId, pool, owner, positionNonce), false, true),
      meta(ataFor(p.mint, owner, p.tokenProgram), false, true),
      meta(p.stakeVault, false, true),
      meta(p.rewardVault, false, true),
      meta(p.tokenProgram, false, false),
    ],
    data: Buffer.from(early ? IX.earlyExit : IX.withdrawMatured),
  });
}

/** The hatch. Note it declares NO reward vault — invariant I-12, enforced by the struct. */
function ixEmergencyWithdraw({ programId, owner, pool, p, positionNonce }) {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(owner, true, true),
      meta(pool, false, true),
      meta(p.mint, false, false),
      meta(userPda(programId, pool, owner), false, true),
      meta(positionPda(programId, pool, owner, positionNonce), false, true),
      meta(ataFor(p.mint, owner, p.tokenProgram), false, true),
      meta(p.stakeVault, false, true),
      meta(p.tokenProgram, false, false),
    ],
    data: Buffer.from(IX.emergencyWithdraw),
  });
}

/** Pays out `rewards_carried`. Reward vault only — it names no stake vault. */
function ixClaimCarried({ programId, owner, pool, p }) {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(owner, true, false),
      meta(pool, false, true),
      meta(p.mint, false, false),
      meta(userPda(programId, pool, owner), false, true),
      meta(ataFor(p.mint, owner, p.tokenProgram), false, true),
      meta(p.rewardVault, false, true),
      meta(p.tokenProgram, false, false),
    ],
    data: Buffer.from(IX.claimCarried),
  });
}

/** PERMISSIONLESS: the Accounts struct declares no Signer at all. */
function ixSweep({ programId, pool, p }) {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(pool, false, true),
      meta(p.mint, false, false),
      meta(p.stakeVault, false, true),
      meta(p.rewardVault, false, true),
      meta(p.tokenProgram, false, false),
    ],
    data: Buffer.from(IX.sweepOrphanedPenalty),
  });
}

function ixNotifyReward({ programId, authority, pool, p, amountRaw, fromBudgetRaw }) {
  return new TransactionInstruction({
    programId,
    keys: [
      meta(authority, true, false),
      meta(pool, false, true),
      meta(p.mint, false, false),
      meta(ataFor(p.mint, authority, p.tokenProgram), false, true),
      meta(p.rewardVault, false, true),
      meta(p.tokenProgram, false, false),
    ],
    data: Buffer.concat([IX.notifyReward, u64le(amountRaw), u64le(fromBudgetRaw)]),
  });
}

/* -- governance: the six calls the pool authority (and one stranger) can make --
 *
 * NONE OF THESE MOVES A TOKEN. Read the account lists: AuthorityOnly names the
 * authority and the pool and nothing else; AcceptAuthority names the pending key and
 * the pool; ExecuteCapRaise names only the pool. There is no vault in any of them, so
 * no signature on this page can take principal or rewards out - which is why a plain
 * wallet is an acceptable POOL authority. The UPGRADE authority is a different key.
 */
function ixAuthorityOnly(programId, authority, pool, data) {
  return new TransactionInstruction({
    programId,
    keys: [meta(authority, true, false), meta(pool, false, true)],
    data,
  });
}

function ixProposeAuthority({ programId, authority, pool, newAuthority }) {
  return ixAuthorityOnly(programId, authority, pool,
    Buffer.concat([IX.proposeAuthority, newAuthority.toBuffer()]));
}

/** Signed by the PROPOSED key, not the current one. */
function ixAcceptAuthority({ programId, pending, pool }) {
  return new TransactionInstruction({
    programId,
    keys: [meta(pending, true, false), meta(pool, false, true)],
    data: Buffer.from(IX.acceptAuthority),
  });
}

function ixProposeCapRaise({ programId, authority, pool, newCapRaw }) {
  return ixAuthorityOnly(programId, authority, pool,
    Buffer.concat([IX.proposeCapRaise, u64le(newCapRaw)]));
}

function ixCancelCapRaise({ programId, authority, pool }) {
  return ixAuthorityOnly(programId, authority, pool, Buffer.from(IX.cancelCapRaise));
}

/** PERMISSIONLESS once the timelock has run: `ExecuteCapRaise` declares no Signer. */
function ixExecuteCapRaise({ programId, pool }) {
  return new TransactionInstruction({
    programId,
    keys: [meta(pool, false, true)],
    data: Buffer.from(IX.executeCapRaise),
  });
}

/** ONE-WAY. There is no instruction that clears it. */
function ixDeclareDegraded({ programId, authority, pool }) {
  return ixAuthorityOnly(programId, authority, pool, Buffer.from(IX.declareDegraded));
}

/* What the program would refuse, said BEFORE a fee is paid.
 *
 * Each returns null when lib.rs would accept, or a sentence naming the error it would
 * raise. They mirror propose_cap_raise .. declare_degraded line for line; the program
 * stays the authority, these only stop an operator paying for a revert. Exported so
 * the test can pin every boundary - `>=` against `>` above all. */
function authorityProblem(p, signerKey) {
  return signerKey.equals(p.authority)
    ? null
    : `this pool's authority is ${p.authority.toBase58()}, not ${signerKey.toBase58()} (Unauthorized)`;
}

function capRaiseProblem(p, newCapRaw) {
  return newCapRaw > p.depositCap
    ? null
    : `the cap can only rise: ${fmt(newCapRaw, p.decimals)} is not above the current ${fmt(p.depositCap, p.decimals)} (CapCanOnlyRaise)`;
}

function cancelCapRaiseProblem(p) {
  return p.pendingCap > 0n ? null : 'there is no pending cap raise to cancel (NoPendingChange)';
}

function executeCapRaiseProblem(p, nowSecs) {
  if (p.pendingCap === 0n) return 'there is no pending cap raise to execute (NoPendingChange)';
  const readyAt = p.pendingCapTs + BigInt(CAP_TIMELOCK_SECS);
  // `>=`, exactly as lib.rs: executable AT readyAt, not one second after it.
  if (BigInt(nowSecs) < readyAt) {
    return `the 48-hour timelock has not run: executable at ${new Date(Number(readyAt) * 1000).toISOString()} (TimelockNotElapsed)`;
  }
  return p.pendingCap > p.depositCap ? null : 'the pending cap is not above the current cap (CapCanOnlyRaise)';
}

function acceptAuthorityProblem(p, signerKey) {
  if (p.pendingAuthority.equals(PublicKey.default)) return 'no authority transfer is pending (run propose-authority first)';
  return signerKey.equals(p.pendingAuthority)
    ? null
    : `only the PROPOSED key ${p.pendingAuthority.toBase58()} can accept; this is ${signerKey.toBase58()} (Unauthorized)`;
}

function declareDegradedProblem(p) {
  return p.degraded ? 'the pool is already degraded, and the flag is one-way (AlreadyDegraded)' : null;
}

/** Broadcasting a ONE-WAY flag needs a second, explicit word. A dry run never does.
 *  STRICTLY `=== true`: `--confirm-permanent yes` parses "yes" as the flag's VALUE,
 *  and a truthy check would let it through. Same rule as the broadcast gate. */
function confirmPermanentProblem(broadcast, args) {
  return broadcast && args.confirmPermanent !== true
    ? 'declare-degraded is permanent: pass --confirm-permanent together with --broadcast'
    : null;
}

/** `exit` and `hatch` print "the penalty is UNKNOWN" when the position did not decode.
 *  A dry run may still go ahead - it signs nothing and its simulation is evidence. A
 *  BROADCAST may not: the penalty is 75% of principal while locked, and an operator must
 *  not pay it blind. `pos` is `decodePosition`'s `{ ok, value | reason }`; anything but
 *  `ok === true` is unreadable. */
/** `notify`'s mode, from the arguments alone, before any keypair or RPC is touched.
 *
 *  --preview exists for a pool authority nobody holds as a file (a Squads multisig): it
 *  reads NO keypair, skips the authority check, and never builds, simulates or sends.
 *  It is a bare flag, STRICTLY `=== true` like --broadcast, and any value is REFUSED:
 *  `--preview yes` read as "not a preview" would route an operator who asked for a
 *  preview to the path that signs, and with --broadcast also present, that sends.
 *  --preview together with --broadcast is a contradiction and is refused too. */
function notifyMode(args) {
  if (args.preview !== undefined && args.preview !== true) {
    throw new Error(`--preview takes no value, got ${JSON.stringify(args.preview)}`);
  }
  const preview = args.preview === true;
  if (preview && args.broadcast !== undefined) {
    throw new Error('--preview never sends: drop --broadcast, or drop --preview and sign with --keypair');
  }
  return { preview, needsKeypair: !preview };
}

function unpreviewedExitProblem(broadcast, pos) {
  return broadcast && pos?.ok !== true
    ? `refusing to broadcast an exit whose penalty could not be previewed (position: ${pos?.reason ?? 'unread'}); ` +
      'a dry run without --broadcast is still allowed'
    : null;
}

// ── plumbing ─────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  // A leading flag means no command was given — `--help` must print usage, not be
  // read as a subcommand and then die on an unrelated missing argument.
  const hasCmd = argv.length > 0 && !argv[0].startsWith('--');
  const out = { _: hasCmd ? argv[0] : undefined };
  for (let i = hasCmd ? 1 : 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[k] = true;
    else { out[k] = next; i++; }
  }
  return out;
}

const flag = (name) => `--${name.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}`;

function need(args, name) {
  const v = args[name];
  if (v === undefined || v === true) throw new Error(`${flag(name)} is required`);
  return v;
}

/**
 * A whole number, or a refusal.
 *
 * `Number('abc')` is NaN and `Number('')` is 0, and `writeUInt32LE` encodes BOTH as
 * **zero** without complaining. So a typo — or an empty shell variable, which is
 * exactly what `--nonce $Nonce` produces when `$Nonce` is unset — silently
 * addressed position #0: the first and usually largest position a wallet owns.
 * There is no recovering from having closed the wrong position.
 */
function intArg(args, name, { min = 0, max = 0xffffffff } = {}) {
  const raw = need(args, name);
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) throw new Error(`${flag(name)} must be a whole number, got: ${JSON.stringify(raw)}`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${flag(name)} must be between ${min} and ${max}, got ${s}`);
  }
  return n;
}

function loadKeypair(path) {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  return Keypair.fromSecretKey(new Uint8Array(raw));
}

/**
 * The instructions needed so `owner` can receive `mint`, or [] when it already can.
 *
 * Prepended rather than run separately: one transaction means there is no window in
 * which the ATA exists but the stake did not happen, and no second signature.
 */
async function ensureAta(conn, payer, owner, p) {
  const ata = ataFor(p.mint, owner, p.tokenProgram);
  const info = await conn.getAccountInfo(ata);
  if (info) return [];
  console.log(`  note: ${owner.toBase58()} has no token account for this mint;`);
  console.log(`        creating ${ata.toBase58()} in the same transaction.`);
  return [createAssociatedTokenAccountIdempotentInstruction(payer, ata, owner, p.mint, p.tokenProgram)];
}

async function loadPool(conn, programId, poolKey) {
  const info = await conn.getAccountInfo(poolKey);
  if (!info) throw new Error(`no account at ${poolKey.toBase58()} — is the pool created, and is --rpc pointing at the right cluster?`);
  if (!info.owner.equals(programId)) {
    throw new Error(`${poolKey.toBase58()} is owned by ${info.owner.toBase58()}, not the ladder program ${programId.toBase58()}`);
  }
  const d = decodePool(info.data);
  if (!d.ok) throw new Error(`could not decode Pool: ${d.reason}`);
  return d.value;
}

/**
 * THE POOL, THE CHAIN CLOCK AND BOTH VAULTS FROM ONE SLOT.
 *
 * One `getMultipleAccountsInfoAndContext` call, so every figure is from the same slot:
 * separate reads can straddle a claim or a stake and produce a budget no slot ever had.
 * `extra` rides in the same call (a position, for the exit doors).
 *
 * The pool and the Clock are REQUIRED: without them nothing time-dependent can be said,
 * so an unreadable one throws. The vaults come back as `{ ok, value | reason }`; with
 * `requireVaults` an unreadable vault throws too. Nothing here ever defaults to zero.
 */
async function loadSnapshot(conn, programId, poolKey, { requireVaults = false, extra = [] } = {}) {
  const rewardVaultKey = vaultPda(programId, REWARD_VAULT_SEED, poolKey);
  const stakeVaultKey = vaultPda(programId, STAKE_VAULT_SEED, poolKey);
  const keys = [poolKey, SYSVAR_CLOCK_PUBKEY, rewardVaultKey, stakeVaultKey, ...extra];
  const res = await conn.getMultipleAccountsInfoAndContext(keys, 'confirmed');
  const infos = res?.value;
  if (!Array.isArray(infos) || infos.length !== keys.length) {
    throw new Error(`the RPC answered ${Array.isArray(infos) ? infos.length : 'nothing'} accounts for ${keys.length} requested — refusing a partial snapshot`);
  }
  const [poolInfo, clockInfo, rvInfo, svInfo, ...extraInfos] = infos;
  if (!poolInfo) throw new Error(`no account at ${poolKey.toBase58()} — is the pool created, and is --rpc pointing at the right cluster?`);
  if (!poolInfo.owner.equals(programId)) {
    throw new Error(`${poolKey.toBase58()} is owned by ${poolInfo.owner.toBase58()}, not the ladder program ${programId.toBase58()}`);
  }
  const d = decodePool(poolInfo.data);
  if (!d.ok) throw new Error(`could not decode Pool: ${d.reason}`);
  const p = d.value;
  if (!p.rewardVault.equals(rewardVaultKey) || !p.stakeVault.equals(stakeVaultKey)) {
    throw new Error(`the pool's stored vaults are not this program's vault PDAs — refusing to read balances from the wrong accounts`);
  }
  const clock = decodeClock(clockInfo);
  if (!clock.ok) {
    throw new Error(`the Clock sysvar is unreadable (${clock.reason}) — refusing to decide anything time-dependent without the chain's own clock`);
  }
  const rewardVault = decodeTokenAccount(rvInfo, p);
  const stakeVault = decodeTokenAccount(svInfo, p);
  if (requireVaults) {
    if (!rewardVault.ok) throw new Error(`reward vault ${rewardVaultKey.toBase58()} is unreadable: ${rewardVault.reason}`);
    if (!stakeVault.ok) throw new Error(`stake vault ${stakeVaultKey.toBase58()} is unreadable: ${stakeVault.reason}`);
  }
  return {
    slot: res.context?.slot,
    now: clock.value.unixTimestamp,
    clock: clock.value,
    pool: p,
    rewardVault,
    stakeVault,
    extra: extraInfos,
  };
}

/**
 * A simulated `{ InstructionError: [i, { Custom: n }] }` as the ladder's error name, or
 * null. Named ONLY when instruction `i` belongs to the ladder program (every call site
 * puts the ladder instruction last): an ATA-create in front of it has its own numbering.
 */
function simErrorName(err, ixs) {
  const ie = err?.InstructionError;
  if (!Array.isArray(ie)) return null;
  const [i, detail] = ie;
  const code = detail?.Custom;
  const ladder = ixs[ixs.length - 1]?.programId;
  if (typeof code !== 'number' || !LADDER_ERRORS[code] || !ladder || !ixs[i]?.programId?.equals(ladder)) return null;
  return errName(code);
}

/**
 * DRY RUN IS THE DEFAULT AND IT IS NOT A FORMATTING EXERCISE.
 *
 * The transaction is built and run through `simulateTransaction` against real
 * chain state with sigVerify off, so the program's own logs, its error code and
 * its compute usage all come back before anything is signed. A dry run that
 * reports a program error has told you something true.
 */
async function submit(conn, ixs, payer, { broadcast, label }) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = payer.publicKey ?? payer;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;

  const sim = await conn.simulateTransaction(tx, undefined, false);
  const logs = sim.value.logs ?? [];
  const cu = sim.value.unitsConsumed;
  console.log(`\n  simulation: ${sim.value.err ? 'FAILED' : 'ok'}${cu !== undefined ? `  (${cu.toLocaleString()} CU)` : ''}`);
  for (const l of logs) console.log('    ' + l);
  if (sim.value.err) {
    const named = simErrorName(sim.value.err, ixs);
    console.log(`\n  ${label} would FAIL: ${JSON.stringify(sim.value.err)}${named ? `  — ${named}` : ''}`);
    process.exitCode = 1;
    return null;
  }
  if (!broadcast) {
    console.log(`\n  DRY RUN — nothing signed, nothing sent. Re-run with --broadcast to execute.`);
    return null;
  }
  try {
    const sig = await sendAndConfirmTransaction(conn, tx, [payer], { commitment: 'confirmed' });
    console.log(`\n  ${label} SENT: ${sig}`);
    return sig;
  } catch (e) {
    // A CONFIRMATION FAILURE IS NOT PROOF THE TRANSACTION DID NOT LAND. It may
    // have been broadcast and confirmed after the client stopped waiting. Re-running
    // blind is how a stake, or a reward funding, happens twice.
    console.log(`\n  WARNING: ${label} failed to CONFIRM - but it MAY ALREADY BE ON CHAIN.`);
    console.log(`  Do NOT re-run this command yet. Check first:`);
    console.log(`      node scripts/bayla-ladder-ops.mjs read --pool <pool>`);
    console.log(`  and check your wallet balance. Re-run only once you are sure it did not land.`);
    console.log(`  underlying error: ${e.message}`);
    throw e;
  }
}

/** The pool as `read` prints it, at chain `now`. Pure, so the test can read it. */
function poolLines(p, now) {
  chainTime(now);
  const d = p.decimals;
  const out = [];
  out.push(`  mint                 ${p.mint.toBase58()}  (${d} dp)`);
  out.push(`  token program        ${p.tokenProgram.toBase58()}${p.tokenProgram.equals(TOKEN_2022) ? '  (Token-2022)' : p.tokenProgram.equals(TOKEN_LEGACY) ? '  (legacy SPL)' : '  (UNKNOWN)'}`);
  out.push(`  authority            ${p.authority.toBase58()}`);
  if (!p.pendingAuthority.equals(PublicKey.default)) out.push(`  pending authority    ${p.pendingAuthority.toBase58()}`);
  out.push(`  stake vault          ${p.stakeVault.toBase58()}`);
  out.push(`  reward vault         ${p.rewardVault.toBase58()}`);
  out.push(`  min stake            ${fmt(p.minStake, d)}`);
  out.push(`  deposit cap          ${fmt(p.depositCap, d)}`);
  out.push(`  max per wallet       ${fmt(p.maxWalletPrincipal, d)}`);
  out.push(`  total principal      ${fmt(p.totalPrincipal, d)}`);
  out.push(`  total weighted       ${p.totalWeighted}`);
  // Raw base units per second. PRECISION scales only the accumulator, never the rate.
  out.push(`  reward rate          ${fmt(p.rewardRate, d)} / second  (${fmt(p.rewardRate * 86_400n, d)} / day)`);
  const left = p.periodFinish - now;
  out.push(`  period finish        ${p.periodFinish === 0n ? 'never funded' : new Date(Number(p.periodFinish) * 1000).toISOString() + (left > 0n ? `  (${left / 86_400n}d left by the chain clock)` : '  (ENDED)')}`);
  const l = liveLedger(p, now);
  out.push(`  rewards emitted      ${fmt(l.bankedEmitted, d)}  (banked at the last checkpoint)`);
  out.push(`  emitted since then   ${fmt(l.unbanked, d)}  (replayed to chain now; not yet banked)`);
  out.push(`  rewards paid         ${fmt(l.paid, d)}`);
  out.push(`  outstanding (stored) ${fmt(l.storedOutstanding, d)}  (banked emitted − paid, as the account holds it)`);
  out.push(`  outstanding (LIVE)   ${fmt(l.liveOutstanding, d)}  (what the pool owes at chain now)`);
  if (l.unbanked > 0n) {
    out.push(`    they differ because rewards_emitted is only banked when an instruction checkpoints`);
    out.push(`    the pool; ${fmt(l.unbanked, d)} has accrued since ${new Date(Number(p.lastUpdateTime) * 1000).toISOString()}`);
    out.push(`    and the next checkpoint will bank it exactly as replayed here.`);
  }
  if (l.paidExceedsEmitted) out.push(`  🔴 ANOMALY: rewards_paid exceeds live rewards_emitted — outstanding is shown as 0, not negative (L-4)`);
  out.push(`  penalties collected  ${fmt(p.penaltyCollectedCumulative, d)}`);
  out.push(`  orphaned penalty     ${fmt(p.orphanedPenalty, d)}`);
  if (p.degraded) out.push(`  ⚠ DEGRADED — no new stakes, and BOTH early doors (exit --early and the hatch) charge no penalty`);
  return out;
}

/**
 * The two solvency invariants `read` reports, at chain `now`. Pure, so the test reaches them.
 *
 * THREE OUTCOMES, NOT TWO. This used to check `if (sv && ...)`, so an UNREADABLE vault
 * skipped the check entirely and the command exited 0 - reporting success for a solvency
 * question it never got to ask. That is the bug class this repo names most often: a zero
 * is only publishable when a read returned it.
 *
 *   I-1  stake vault  >= total_principal
 *   I-4  reward vault >= LIVE outstanding (emitted replayed to chain now, minus paid).
 *        notify_reward refuses EmissionExceedsFunding on exactly this comparison after
 *        its checkpoint; the STORED figure lags it and can pass while the pool is short.
 *
 * `balances` is `{ stakeVault, rewardVault }`, each `{ ok, value: { amount } | reason }`.
 * Each row is `{ invariant, verdict: 'HOLDS' | 'BROKEN' | 'UNVERIFIED', lines }`; `exitCode`
 * is 1 when any row is not HOLDS.
 */
function solvencyVerdicts(p, now, { stakeVault: sv, rewardVault: rv } = {}) {
  chainTime(now);
  const d = p.decimals;
  const rows = [];
  const outage = (invariant, which) => rows.push({ invariant, verdict: 'UNVERIFIED', lines: [
    `  ⚠ INVARIANT ${invariant} UNVERIFIED: the ${which} vault could not be read.`,
    `    This is an OUTAGE, not a pass. Re-run before acting on it.`,
  ] });

  if (!sv?.ok) {
    outage('I-1', 'stake');
  } else if (sv.value.amount < p.totalPrincipal) {
    rows.push({ invariant: 'I-1', verdict: 'BROKEN', lines: [
      `  🔴 INVARIANT I-1 BROKEN: stake vault < total_principal`,
      `    ${fmt(sv.value.amount, d)} held vs ${fmt(p.totalPrincipal, d)} owed.`,
    ] });
  } else {
    rows.push({ invariant: 'I-1', verdict: 'HOLDS', lines: [`  invariant I-1 holds: vault >= total_principal`] });
  }

  const owed = liveLedger(p, now).liveOutstanding;
  if (!rv?.ok) {
    outage('I-4', 'reward');
  } else if (owed > rv.value.amount) {
    rows.push({ invariant: 'I-4', verdict: 'BROKEN', lines: [
      `  🔴 INVARIANT I-4 BROKEN: live outstanding > reward vault`,
      `    ${fmt(rv.value.amount, d)} held vs ${fmt(owed, d)} owed at chain now.`,
    ] });
  } else {
    const tail = now < p.periodFinish ? satMul(p.periodFinish - now, p.rewardRate) : 0n;
    const unpledged = fromBudgetMax({ pool: p, now, rewardVaultRaw: rv.value.amount });
    rows.push({ invariant: 'I-4', verdict: 'HOLDS', lines: [
      `  invariant I-4 holds: reward vault >= live outstanding`,
      `  unemitted tail       ${fmt(tail, d)}  (still to emit in this window)`,
      `  unpledged budget     ${fmt(unpledged, d)}  (what 'notify --from-budget max' would schedule)`,
    ] });
  }

  return { rows, exitCode: rows.every((r) => r.verdict === 'HOLDS') ? 0 : 1 };
}

/**
 * The `notify` command. The connection, the signer and the printer are injected so the
 * test can drive the command itself: above all, that `--preview` never asks for a keypair
 * and never reaches anything that builds, simulates or sends. Returns the exit code.
 */
async function notifyCommand(args, { conn, programId, broadcast, signer, log = console.log }) {
  const { preview, needsKeypair } = notifyMode(args);
  // --preview reads NO keypair. Once the pool authority is a Squads multisig nobody holds
  // it as a file, and the rate guard (6028) makes previewing a reload essential.
  const authority = needsKeypair ? signer() : null;
  const poolKey = new PublicKey(need(args, 'pool'));
  // ONE same-slot read of the pool, the Clock and both vaults. The preview is
  // meaningless against a balance nobody read, so an unreadable vault throws.
  const snap = await loadSnapshot(conn, programId, poolKey, { requireVaults: true });
  const p = snap.pool;
  if (needsKeypair) {
    const notMine = authorityProblem(p, authority.publicKey);
    if (notMine) throw new Error(notMine);
  }
  const { amount, fromBudget, max } = resolveNotifyAmounts(args, snap);
  // The program's own order of checks, replayed at chain now: the rate is the
  // mid-window fold-in (not scheduled / 90 days), and nothing is sent that it would refuse.
  const pv = notifyPreview({
    pool: p, now: snap.now, rewardVaultRaw: snap.rewardVault.value.amount, amount, fromBudget,
    allowEmptyPool: args.allowEmptyPool === true,
  });
  log(`\nnotify-reward over ${REWARDS_DURATION_SECS / 86400} days${max ? '  (--from-budget max)' : ''}${preview ? '  (--preview)' : ''}`);
  for (const line of notifyReport(pv, p, { amount, fromBudget, now: snap.now, slot: snap.slot })) log(line);
  if (preview) {
    for (const line of notifyPreviewLines(pv, p, { fromBudget })) log(line);
    return pv.problems.length ? 1 : 0;
  }
  if (pv.problems.length) {
    throw new Error(`notify refused before anything was built or sent: ${pv.problems.length} problem(s), listed above as REFUSED`);
  }
  if (broadcast && pv.risks.length) {
    throw new Error('refusing to BROADCAST with a landing RISK (listed above); a dry run is still allowed');
  }
  await submit(conn, [ixNotifyReward({
    programId, authority: authority.publicKey, pool: poolKey, p, amountRaw: amount, fromBudgetRaw: fromBudget,
  })], authority, { broadcast, label: 'notify-reward' });
  return 0;
}

// ── commands ─────────────────────────────────────────────────────────────────

const USAGE = `bayla-ladder ops

  read       --pool <addr>
  positions  --pool <addr> --owner <addr>
  init-pool  --mint <addr> --nonce <n> --min-stake <t> --deposit-cap <t> --max-wallet <t>
  notify     --pool <addr> --amount <t> [--from-budget <t>|max] [--allow-empty-pool] [--preview]
                                             # mid-window the rate may not fall; the preview prints the minimum
                                             # --preview: NO --keypair, nothing built/simulated/sent; prints the
                                             #   pool authority and the minimum --amount (for a Squads authority).
                                             #   Exits 1 if the notify would be refused. Not with --broadcast.
  stake      --pool <addr> --amount <t> --lock-days <d>
  claim      --pool <addr> --nonce <n>
  exit       --pool <addr> --nonce <n> [--early]
  hatch      --pool <addr> --nonce <n>       # principal; ${PENALTY_PCT} penalty WHILE LOCKED (you keep ${KEEP_PCT})
  claim-carried --pool <addr>
  sweep      --pool <addr>                   # permissionless, no signer
  propose-cap-raise --pool <addr> --cap <t>     # authority; raise-only, runs after 48h
  cancel-cap-raise  --pool <addr>               # authority
  execute-cap-raise --pool <addr>               # PERMISSIONLESS once 48h have run
  propose-authority --pool <addr> --new-authority <addr>   # authority; step 1 of 2
  accept-authority  --pool <addr>               # signed by the PROPOSED key; step 2
  declare-degraded  --pool <addr> --confirm-permanent      # authority; ONE-WAY

  common: --program <id> --rpc <url> --keypair <path> --broadcast
          amounts are WHOLE TOKENS; dry run unless --broadcast`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args._ || args.help) { console.log(USAGE); return; }

  const programId = new PublicKey(
    args.program || process.env.BAYLA_LADDER_PROGRAM ||
    (() => { throw new Error('--program <id> (or BAYLA_LADDER_PROGRAM) is required'); })());
  const rpc = args.rpc || process.env.SOLANA_RPC || 'https://api.devnet.solana.com';
  const conn = new Connection(rpc, 'confirmed');
  const broadcast = args.broadcast === true;

  console.log(`program ${programId.toBase58()}`);
  console.log(`rpc     ${rpc}`);

  const signer = () => {
    const kp = loadKeypair(need(args, 'keypair'));
    console.log(`signer  ${kp.publicKey.toBase58()}`);
    return kp;
  };

  switch (args._) {
    case 'read': {
      const poolKey = new PublicKey(need(args, 'pool'));
      const snap = await loadSnapshot(conn, programId, poolKey);
      const p = snap.pool;
      console.log(`\nPool ${poolKey.toBase58()}  (nonce ${p.nonce})`);
      console.log(`  snapshot             slot ${snap.slot}, chain clock ${new Date(Number(snap.now) * 1000).toISOString()}`);
      for (const line of poolLines(p, snap.now)) console.log(line);
      const sv = snap.stakeVault;
      const rv = snap.rewardVault;
      console.log(`\n  stake vault balance  ${sv.ok ? fmt(sv.value.amount, p.decimals) : `— unreadable (${sv.reason})`}`);
      console.log(`  reward vault balance ${rv.ok ? fmt(rv.value.amount, p.decimals) : `— unreadable (${rv.reason})`}`);
      // I-1 and I-4, three outcomes each (holds / BROKEN / UNVERIFIED). See solvencyVerdicts.
      const solvency = solvencyVerdicts(p, snap.now, { stakeVault: sv, rewardVault: rv });
      for (const row of solvency.rows) for (const line of row.lines) console.log(line);
      if (solvency.exitCode) process.exitCode = solvency.exitCode;
      return;
    }

    case 'positions': {
      const poolKey = new PublicKey(need(args, 'pool'));
      const owner = new PublicKey(need(args, 'owner'));
      const snap = await loadSnapshot(conn, programId, poolKey);
      const p = snap.pool;
      const now = snap.now;
      const us = decodeUserStats((await conn.getAccountInfo(userPda(programId, poolKey, owner)))?.data);
      if (!us.ok) { console.log(`\nUserStats: ${us.reason}`); return; }
      console.log(`\nUserStats for ${owner.toBase58()}`);
      console.log(`  next nonce       ${us.value.nextNonce}`);
      console.log(`  open positions   ${us.value.openPositions}`);
      console.log(`  principal        ${fmt(us.value.principal, p.decimals)}`);
      console.log(`  rewards carried  ${fmt(us.value.rewardsCarried, p.decimals)}`);
      console.log(`  chain clock      ${new Date(Number(now) * 1000).toISOString()}`);
      // Every nonce ever issued is probed: a CLOSED position leaves no account, so
      // an absent one is reported as closed rather than skipped silently.
      for (let n = 0; n < us.value.nextNonce; n++) {
        const info = await conn.getAccountInfo(positionPda(programId, poolKey, owner, n));
        const d = decodePosition(info?.data);
        if (!d.ok) { console.log(`  #${n}  closed (${d.reason})`); continue; }
        const v = d.value;
        const left = v.lockEnd - now;
        const early = exitPreview(v, p, now, 'early_exit');
        console.log(`  #${n}  ${fmt(v.amount, p.decimals)}  weight ${v.weight}  ` +
          (left > 0n
            ? `locked ${(left + 86_399n) / 86_400n}d more; --early forfeits ${fmt(early.penalty, p.decimals)}`
            : 'MATURED — withdraw is free'));
      }
      return;
    }

    case 'init-pool': {
      const payer = signer();
      const mint = new PublicKey(need(args, 'mint'));
      // u8() masks with & 0xff, so an unvalidated 256 silently addresses pool 0 -
      // a different pool than the operator asked for, possibly one that exists.
      // The position-nonce sites were fixed first; this one was missed.
      const nonce = intArg(args, 'nonce', { min: 0, max: 255 });
      const mintInfo = await conn.getAccountInfo(mint);
      if (!mintInfo) throw new Error(`no mint at ${mint.toBase58()}`);
      const tokenProgram = mintInfo.owner;
      const decimals = mintInfo.data[44];
      // The program refuses both of these; refusing locally costs nothing and
      // explains itself, instead of surfacing as a constraint failure.
      const floor = 100n * 10n ** BigInt(decimals);
      const minStake = toRaw(need(args, 'minStake'), decimals);
      const depositCap = toRaw(need(args, 'depositCap'), decimals);
      const maxWallet = toRaw(need(args, 'maxWallet'), decimals);
      if (minStake < floor) throw new Error(`--min-stake must be at least 100 whole tokens (${fmt(floor, decimals)}); it has NO setter and cannot be changed later`);
      if (depositCap < minStake) throw new Error('--deposit-cap must be >= --min-stake');
      if (maxWallet < minStake || maxWallet > depositCap) throw new Error('--max-wallet must be between --min-stake and --deposit-cap');
      const pool = poolPda(programId, mint, nonce);
      console.log(`\ninit-pool`);
      console.log(`  mint          ${mint.toBase58()}  (${decimals} dp, owner ${tokenProgram.toBase58()})`);
      console.log(`  pool (PDA)    ${pool.toBase58()}`);
      console.log(`  min stake     ${fmt(minStake, decimals)}   ⚠ PERMANENT — no setter exists`);
      console.log(`  deposit cap   ${fmt(depositCap, decimals)}  (raise-only, 48h timelock)`);
      console.log(`  max / wallet  ${fmt(maxWallet, decimals)}   ⚠ PERMANENT — no setter exists; later cap raises do not lift it`);
      // The signer becomes pool.authority: the only key that can fund rewards, raise
      // the cap or declare the pool degraded. Transfer is a two-step propose/accept,
      // and there is no recovery if it is lost.
      console.log(`  authority     ${payer.publicKey.toBase58()}`);
      console.log(`                ^ becomes the POOL AUTHORITY (notify_reward, cap raises,`);
      console.log(`                  declare_degraded). Transfer is two-step; loss is final.`);
      await submit(conn, [ixInitializePool({
        programId, payer: payer.publicKey, mint, tokenProgram, nonce, minStake, depositCap, maxWallet,
      })], payer, { broadcast, label: 'init-pool' });
      return;
    }

    case 'notify': {
      // Extracted so the test can drive it; --preview needs no keypair (see notifyMode).
      const code = await notifyCommand(args, { conn, programId, broadcast, signer });
      if (code) process.exitCode = code;
      return;
    }

    case 'stake': {
      const owner = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const amountRaw = toRaw(need(args, 'amount'), p.decimals);
      const lockDays = Number(need(args, 'lockDays'));
      const lockSecs = lockDays * 86400;
      if (lockSecs < MIN_LOCK_SECS) throw new Error(`--lock-days must be at least 7`);
      if (lockSecs > MAX_LOCK_SECS) throw new Error(`--lock-days must be at most ${MAX_LOCK_SECS / 86400}`);
      if (amountRaw < p.minStake) throw new Error(`below this pool's minimum of ${fmt(p.minStake, p.decimals)}`);
      const us = decodeUserStats((await conn.getAccountInfo(userPda(programId, poolKey, owner.publicKey)))?.data);
      // The position address is PROGRAM-ASSIGNED from next_nonce, so it has to be
      // read before the instruction can be addressed at all.
      const positionNonce = us.ok ? us.value.nextNonce : 0;
      console.log(`\nstake`);
      console.log(`  amount        ${fmt(amountRaw, p.decimals)}`);
      console.log(`  lock          ${lockDays} days`);
      console.log(`  position #    ${positionNonce}  (from UserStats.next_nonce${us.ok ? '' : ' — first stake'})`);
      console.log(`  position PDA  ${positionPda(programId, poolKey, owner.publicKey, positionNonce).toBase58()}`);
      const pre = await ensureAta(conn, owner.publicKey, owner.publicKey, p);
      await submit(conn, [...pre, ixStake({
        programId, owner: owner.publicKey, pool: poolKey, p, positionNonce, amountRaw, lockSecs,
      })], owner, { broadcast, label: 'stake' });
      return;
    }

    case 'claim': {
      const owner = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const n = intArg(args, 'nonce');
      const pre = await ensureAta(conn, owner.publicKey, owner.publicKey, p);
      await submit(conn, [...pre, ixClaim({ programId, owner: owner.publicKey, pool: poolKey, p, positionNonce: n })],
        owner, { broadcast, label: 'claim' });
      return;
    }

    case 'exit': {
      const owner = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const n = intArg(args, 'nonce');
      const early = args.early === true;
      // The position rides in the SAME snapshot as the pool and the Clock, so the lock
      // state below is the chain's at one slot, not this machine's wall clock.
      const snap = await loadSnapshot(conn, programId, poolKey,
        { extra: [positionPda(programId, poolKey, owner.publicKey, n)] });
      const p = snap.pool;
      const pos = decodePosition(snap.extra[0]?.data);
      console.log(`\n${early ? 'early-exit' : 'withdraw-matured'} — position #${n}`);
      if (!pos.ok) {
        console.log(`  ⚠ could not read the position (${pos.reason}) — the penalty is UNKNOWN.`);
      } else {
        // The two doors partition time; taking the wrong one is refused on-chain, so say
        // which one applies, and what the early door actually costs, before any fee.
        const pv = exitPreview(pos.value, p, snap.now, early ? 'early_exit' : 'withdraw_matured');
        for (const line of exitReport(pv, pos.value, p, snap.now)) console.log(line);
      }
      // Before ANYTHING is built: an unknown penalty is never broadcast.
      const blindExit = unpreviewedExitProblem(broadcast, pos);
      if (blindExit) throw new Error(blindExit);
      const pre = await ensureAta(conn, owner.publicKey, owner.publicKey, p);
      await submit(conn, [...pre, ixExit({ programId, owner: owner.publicKey, pool: poolKey, p, positionNonce: n, early })],
        owner, { broadcast, label: early ? `early-exit (${p.degraded ? 'no penalty, pool degraded' : `${PENALTY_PCT} penalty`})` : 'withdraw-matured' });
      return;
    }

    case 'hatch': {
      const owner = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const n = intArg(args, 'nonce');
      // THE HATCH IS NOT FREE WHILE LOCKED, and this used to say it was.
      //
      // `emergency_withdraw` (lib.rs) charges the SAME flat 75% as
      // `early_exit` when `now < lock_end` and the pool is not `degraded`. It is
      // free only after maturity, or once the pool is degraded — the M-3 fix that
      // made the two doors agree so neither dominates the other.
      //
      // The penalty is invisible in a dry run: it rides inside the `Withdrawn`
      // event as a base64 `Program data:` line, so the simulation cannot correct a
      // wrong claim on screen. It has to be computed and shown here — against the
      // CHAIN clock: a wall clock ahead of the cluster near lock_end printed "matured,
      // free" for a position the program still charged.
      const snap = await loadSnapshot(conn, programId, poolKey,
        { extra: [positionPda(programId, poolKey, owner.publicKey, n)] });
      const p = snap.pool;
      const pos = decodePosition(snap.extra[0]?.data);
      console.log(`\nemergency-withdraw — position #${n}`);
      console.log(`  principal only. Accrued rewards are NOT lost: they move to`);
      console.log(`  rewards_carried and stay claimable with 'claim-carried'.`);
      if (!pos.ok) {
        console.log(`  ⚠ could not read the position (${pos.reason}) — the penalty below is UNKNOWN.`);
      } else {
        const pv = exitPreview(pos.value, p, snap.now, 'emergency_withdraw');
        for (const line of exitReport(pv, pos.value, p, snap.now)) console.log(line);
        if (pv.penalty > 0n) {
          console.log(`  'exit --early' costs exactly the same ${PENALTY_PCT} and ALSO pays your rewards out.`);
        }
      }
      // Before ANYTHING is built: an unknown penalty is never broadcast.
      const blindHatch = unpreviewedExitProblem(broadcast, pos);
      if (blindHatch) throw new Error(blindHatch);
      const pre = await ensureAta(conn, owner.publicKey, owner.publicKey, p);
      await submit(conn, [...pre, ixEmergencyWithdraw({ programId, owner: owner.publicKey, pool: poolKey, p, positionNonce: n })],
        owner, { broadcast, label: 'emergency-withdraw' });
      return;
    }

    case 'claim-carried': {
      // Pays out `rewards_carried` — the balance the hatch and a closing exit
      // deposit. Without this command the CLI printed a number it could not move,
      // and the hatch pointed at a command that did not exist.
      const owner = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const us = decodeUserStats((await conn.getAccountInfo(userPda(programId, poolKey, owner.publicKey)))?.data);
      console.log(`\nclaim-carried`);
      console.log(`  rewards carried  ${us.ok ? fmt(us.value.rewardsCarried, p.decimals) : `— (${us.reason})`}`);
      const pre = await ensureAta(conn, owner.publicKey, owner.publicKey, p);
      await submit(conn, [...pre, ixClaimCarried({ programId, owner: owner.publicKey, pool: poolKey, p })],
        owner, { broadcast, label: 'claim-carried' });
      return;
    }

    case 'sweep': {
      // PERMISSIONLESS by design — `Sweep` declares no Signer at all. The fee payer
      // is whoever runs it; it moves the retained penalty from the stake vault into
      // the reward vault so it becomes schedulable budget.
      const payer = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      console.log(`\nsweep-orphaned-penalty (permissionless — anyone may call it)`);
      console.log(`  orphaned penalty  ${fmt(p.orphanedPenalty, p.decimals)}`);
      if (p.orphanedPenalty === 0n) console.log(`  ⚠ nothing to sweep; the program will refuse this (NothingToSweep).`);
      console.log(`  after sweeping, 'notify --from-budget' can schedule it as rewards.`);
      await submit(conn, [ixSweep({ programId, pool: poolKey, p })],
        payer, { broadcast, label: 'sweep-orphaned-penalty' });
      return;
    }

    case 'propose-cap-raise': {
      const authority = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const newCap = toRaw(need(args, 'cap'), p.decimals);
      const bad = authorityProblem(p, authority.publicKey) ?? capRaiseProblem(p, newCap);
      if (bad) throw new Error(bad);
      console.log(`\npropose-cap-raise`);
      console.log(`  current cap    ${fmt(p.depositCap, p.decimals)}`);
      console.log(`  proposed cap   ${fmt(newCap, p.decimals)}`);
      console.log(`  takes effect   48 hours after this lands, via 'execute-cap-raise' (anyone may run it)`);
      console.log(`  max / wallet   ${fmt(p.maxWalletPrincipal, p.decimals)} - unchanged; it has NO setter`);
      if (p.pendingCap > 0n) {
        console.log(`  WARNING: this REPLACES the pending ${fmt(p.pendingCap, p.decimals)} proposal and restarts the 48h clock`);
      }
      await submit(conn, [ixProposeCapRaise({
        programId, authority: authority.publicKey, pool: poolKey, newCapRaw: newCap,
      })], authority, { broadcast, label: 'propose-cap-raise' });
      return;
    }

    case 'cancel-cap-raise': {
      const authority = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const bad = authorityProblem(p, authority.publicKey) ?? cancelCapRaiseProblem(p);
      if (bad) throw new Error(bad);
      console.log(`\ncancel-cap-raise`);
      console.log(`  abandoning     ${fmt(p.pendingCap, p.decimals)}  (the cap stays ${fmt(p.depositCap, p.decimals)})`);
      await submit(conn, [ixCancelCapRaise({ programId, authority: authority.publicKey, pool: poolKey })],
        authority, { broadcast, label: 'cancel-cap-raise' });
      return;
    }

    case 'execute-cap-raise': {
      // PERMISSIONLESS once the timelock has run. The signer only pays the fee.
      const payer = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const snap = await loadSnapshot(conn, programId, poolKey);
      const p = snap.pool;
      const bad = executeCapRaiseProblem(p, snap.now);
      if (bad) throw new Error(bad);
      console.log(`\nexecute-cap-raise (permissionless)`);
      console.log(`  cap            ${fmt(p.depositCap, p.decimals)}  ->  ${fmt(p.pendingCap, p.decimals)}`);
      await submit(conn, [ixExecuteCapRaise({ programId, pool: poolKey })],
        payer, { broadcast, label: 'execute-cap-raise' });
      return;
    }

    case 'propose-authority': {
      const authority = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const next = new PublicKey(need(args, 'newAuthority'));
      const bad = authorityProblem(p, authority.publicKey);
      if (bad) throw new Error(bad);
      if (next.equals(p.authority)) throw new Error(`${next.toBase58()} is already the authority`);
      console.log(`\npropose-authority (step 1 of 2)`);
      console.log(`  current        ${p.authority.toBase58()}`);
      console.log(`  proposed       ${next.toBase58()}`);
      console.log(`  Nothing changes until the PROPOSED key runs 'accept-authority'; until then the`);
      console.log(`  current key keeps full control. To abandon, propose ${PublicKey.default.toBase58()}.`);
      if (!PublicKey.isOnCurve(next.toBytes())) {
        console.log(`  WARNING: ${next.toBase58()} is OFF-CURVE (a PDA, e.g. a Squads vault). It cannot`);
        console.log(`  sign this CLI's accept-authority - the accept must be executed from inside that multisig.`);
      }
      await submit(conn, [ixProposeAuthority({
        programId, authority: authority.publicKey, pool: poolKey, newAuthority: next,
      })], authority, { broadcast, label: 'propose-authority' });
      return;
    }

    case 'accept-authority': {
      const pending = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const bad = acceptAuthorityProblem(p, pending.publicKey);
      if (bad) throw new Error(bad);
      console.log(`\naccept-authority (step 2 of 2)`);
      console.log(`  authority      ${p.authority.toBase58()}  ->  ${pending.publicKey.toBase58()}`);
      await submit(conn, [ixAcceptAuthority({ programId, pending: pending.publicKey, pool: poolKey })],
        pending, { broadcast, label: 'accept-authority' });
      return;
    }

    case 'declare-degraded': {
      const authority = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const bad = authorityProblem(p, authority.publicKey) ?? declareDegradedProblem(p);
      if (bad) throw new Error(bad);
      console.log(`\ndeclare-degraded  -- ONE-WAY: there is no instruction that clears it`);
      console.log(`  After this the pool takes NO new stakes, and neither early exit nor the`);
      console.log(`  emergency hatch charges a penalty while locked. Every existing position can`);
      console.log(`  still exit.`);
      // A dry run is always safe. Broadcasting an irreversible flag needs a second,
      // explicit word, so a --broadcast typed on the wrong line cannot set it.
      const unconfirmed = confirmPermanentProblem(broadcast, args);
      if (unconfirmed) throw new Error(unconfirmed);
      await submit(conn, [ixDeclareDegraded({ programId, authority: authority.publicKey, pool: poolKey })],
        authority, { broadcast, label: 'declare-degraded' });
      return;
    }

    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
}

// Only run when invoked as a program. Importing this file (the test does) must
// not execute a command — the pure pieces below are the point of the export.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((e) => {
    console.error(`\nERROR: ${e.message}`);
    process.exitCode = 1;
  });
}

// Exported for the test. These are the constants and pure builders whose
// correctness cannot be observed by running the CLI without a deployed program:
// a wrong discriminator or a reordered account list produces a confusing
// on-chain constraint failure, not a local one.
export {
  IX, ACCT, POOL_L, POSITION_L, USER_L,
  poolPda, vaultPda, userPda, positionPda, ataFor,
  decodePool, decodePosition, decodeUserStats,
  ixInitializePool, ixStake, ixClaim, ixExit, ixEmergencyWithdraw, ixNotifyReward,
  ixClaimCarried, ixSweep,
  ixProposeAuthority, ixAcceptAuthority, ixProposeCapRaise, ixCancelCapRaise,
  ixExecuteCapRaise, ixDeclareDegraded, CAP_TIMELOCK_SECS,
  authorityProblem, capRaiseProblem, cancelCapRaiseProblem, executeCapRaiseProblem,
  acceptAuthorityProblem, declareDegradedProblem, confirmPermanentProblem,
  toRaw, fmt, parseArgs, intArg, EARLY_EXIT_PENALTY_BPS, BPS,
  POOL_SEED, POSITION_SEED, USER_SEED, STAKE_VAULT_SEED, REWARD_VAULT_SEED,
  MIN_LOCK_SECS, MAX_LOCK_SECS, REWARDS_DURATION_SECS,
};

// Chain time, the off-chain replay of the reward engine, and the previews built on them.
export {
  PRECISION, PENALTY_PCT, KEEP_PCT, LADDER_ERRORS, SYSVAR_OWNER, LANDING_SLACK_SECS,
  decodeClock, decodeTokenAccount, loadSnapshot, simErrorName,
  lastTimeApplicable, minWeightFloor, rewardPerWeightWithResidue, emittedDeltaWithResidue,
  checkpointReplay, newRewardRate, rateChangeAllowed, fundable, penaltyFor,
  exitPreview, exitReport, liveLedger, poolLines,
  driftBound, budgetMargin, fromBudgetMax, notifyPreview, notifyReport, resolveNotifyAmounts,
};

// The read verdicts, the blind-exit broadcast guard, and `notify --preview`.
export {
  solvencyVerdicts, unpreviewedExitProblem, notifyMode, notifyPreviewLines, notifyCommand,
};
