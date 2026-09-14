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
//
//   STAKER (same dry-run rule):
//     node scripts/bayla-ladder-ops.mjs stake  --pool <p> --amount 500 --lock-days 90
//     node scripts/bayla-ladder-ops.mjs claim  --pool <p> --nonce 0
//     node scripts/bayla-ladder-ops.mjs exit   --pool <p> --nonce 0        # matured, free
//     node scripts/bayla-ladder-ops.mjs exit   --pool <p> --nonce 0 --early # 25% penalty
//     node scripts/bayla-ladder-ops.mjs hatch  --pool <p> --nonce 0
//     node scripts/bayla-ladder-ops.mjs claim-carried --pool <p>
//
// ⚠ THE HATCH IS NOT FREE WHILE LOCKED. `emergency_withdraw` charges the SAME flat
// 25% as `early_exit` when `now < lock_end` and the pool is not `degraded`
// (lib.rs:607-613). It is free only after maturity, or once the pool is degraded.
// This file said "no penalty" unconditionally and the runbook agreed with it; both
// were wrong, and the penalty is invisible in a dry run because it rides inside a
// base64 `Program data:` event line. `hatch` now reads the position and prints the
// real number. What the hatch DOES avoid is the reward ledger: accrued rewards move
// to `rewards_carried` and stay claimable, so it cannot revert on accounting drift.
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
/** math.rs: penalty_for(a) = a * 2500 / 10000, floored. Used by BOTH exit doors. */
const EARLY_EXIT_PENALTY_BPS = 2_500;
const BPS = 10_000;

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
    console.log(`\n  ${label} would FAIL: ${JSON.stringify(sim.value.err)}`);
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

function printPool(p) {
  const d = p.decimals;
  const now = Math.floor(Date.now() / 1000);
  console.log(`  mint                 ${p.mint.toBase58()}  (${d} dp)`);
  console.log(`  token program        ${p.tokenProgram.toBase58()}${p.tokenProgram.equals(TOKEN_2022) ? '  (Token-2022)' : p.tokenProgram.equals(TOKEN_LEGACY) ? '  (legacy SPL)' : '  (UNKNOWN)'}`);
  console.log(`  authority            ${p.authority.toBase58()}`);
  if (!p.pendingAuthority.equals(PublicKey.default)) console.log(`  pending authority    ${p.pendingAuthority.toBase58()}`);
  console.log(`  stake vault          ${p.stakeVault.toBase58()}`);
  console.log(`  reward vault         ${p.rewardVault.toBase58()}`);
  console.log(`  min stake            ${fmt(p.minStake, d)}`);
  console.log(`  deposit cap          ${fmt(p.depositCap, d)}`);
  console.log(`  max per wallet       ${fmt(p.maxWalletPrincipal, d)}`);
  console.log(`  total principal      ${fmt(p.totalPrincipal, d)}`);
  console.log(`  total weighted       ${p.totalWeighted}`);
  console.log(`  reward rate          ${p.rewardRate}  (per second, scaled)`);
  const left = Number(p.periodFinish) - now;
  console.log(`  period finish        ${p.periodFinish === 0n ? 'never funded' : new Date(Number(p.periodFinish) * 1000).toISOString() + (left > 0 ? `  (${Math.floor(left / 86400)}d left)` : '  (ENDED)')}`);
  console.log(`  rewards emitted      ${fmt(p.rewardsEmitted, d)}`);
  console.log(`  rewards paid         ${fmt(p.rewardsPaid, d)}`);
  console.log(`  outstanding owed     ${fmt(p.rewardsEmitted - p.rewardsPaid, d)}`);
  console.log(`  penalties collected  ${fmt(p.penaltyCollectedCumulative, d)}`);
  console.log(`  orphaned penalty     ${fmt(p.orphanedPenalty, d)}`);
  if (p.degraded) console.log(`  ⚠ DEGRADED — the ladder is flat and early_exit charges nothing`);
}

// ── commands ─────────────────────────────────────────────────────────────────

const USAGE = `bayla-ladder ops

  read       --pool <addr>
  positions  --pool <addr> --owner <addr>
  init-pool  --mint <addr> --nonce <n> --min-stake <t> --deposit-cap <t> --max-wallet <t>
  notify     --pool <addr> --amount <t> [--from-budget <t>]
  stake      --pool <addr> --amount <t> --lock-days <d>
  claim      --pool <addr> --nonce <n>
  exit       --pool <addr> --nonce <n> [--early]
  hatch      --pool <addr> --nonce <n>       # principal; 25% penalty WHILE LOCKED
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
      const p = await loadPool(conn, programId, poolKey);
      console.log(`\nPool ${poolKey.toBase58()}  (nonce ${p.nonce})`);
      printPool(p);
      const sv = await conn.getTokenAccountBalance(p.stakeVault).catch(() => null);
      const rv = await conn.getTokenAccountBalance(p.rewardVault).catch(() => null);
      console.log(`\n  stake vault balance  ${sv ? fmt(BigInt(sv.value.amount), p.decimals) : '— unreadable'}`);
      console.log(`  reward vault balance ${rv ? fmt(BigInt(rv.value.amount), p.decimals) : '— unreadable'}`);
      // INVARIANT I-1: the stake vault must hold at least the tracked principal.
      //
      // THREE OUTCOMES, NOT TWO. This used to check `if (sv && ...)`, so an
      // UNREADABLE vault skipped the check entirely and the command exited 0 -
      // reporting success for a solvency question it never got to ask. That is the
      // bug class this repo names most often: a zero is only publishable when a read
      // returned it.
      if (!sv) {
        console.log(`  ⚠ INVARIANT I-1 UNVERIFIED: the stake vault could not be read.`);
        console.log(`    This is an OUTAGE, not a pass. Re-run before acting on it.`);
        process.exitCode = 1;
      } else if (BigInt(sv.value.amount) < p.totalPrincipal) {
        console.log(`  🔴 INVARIANT I-1 BROKEN: stake vault < total_principal`);
        console.log(`    ${fmt(BigInt(sv.value.amount), p.decimals)} held vs ${fmt(p.totalPrincipal, p.decimals)} owed.`);
        process.exitCode = 1;
      } else {
        console.log(`  invariant I-1 holds: vault >= total_principal`);
      }
      return;
    }

    case 'positions': {
      const poolKey = new PublicKey(need(args, 'pool'));
      const owner = new PublicKey(need(args, 'owner'));
      const p = await loadPool(conn, programId, poolKey);
      const us = decodeUserStats((await conn.getAccountInfo(userPda(programId, poolKey, owner)))?.data);
      if (!us.ok) { console.log(`\nUserStats: ${us.reason}`); return; }
      console.log(`\nUserStats for ${owner.toBase58()}`);
      console.log(`  next nonce       ${us.value.nextNonce}`);
      console.log(`  open positions   ${us.value.openPositions}`);
      console.log(`  principal        ${fmt(us.value.principal, p.decimals)}`);
      console.log(`  rewards carried  ${fmt(us.value.rewardsCarried, p.decimals)}`);
      const now = Math.floor(Date.now() / 1000);
      // Every nonce ever issued is probed: a CLOSED position leaves no account, so
      // an absent one is reported as closed rather than skipped silently.
      for (let n = 0; n < us.value.nextNonce; n++) {
        const info = await conn.getAccountInfo(positionPda(programId, poolKey, owner, n));
        const d = decodePosition(info?.data);
        if (!d.ok) { console.log(`  #${n}  closed (${d.reason})`); continue; }
        const v = d.value;
        const left = Number(v.lockEnd) - now;
        console.log(`  #${n}  ${fmt(v.amount, p.decimals)}  weight ${v.weight}  ` +
          (left > 0 ? `locked ${Math.ceil(left / 86400)}d more` : 'MATURED — withdraw is free'));
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
      const authority = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const amount = toRaw(args.amount ?? '0', p.decimals);
      const fromBudget = toRaw(args.fromBudget ?? '0', p.decimals);
      if (amount === 0n && fromBudget === 0n) throw new Error('nothing to schedule: pass --amount and/or --from-budget');
      const scheduled = amount + fromBudget;
      // audit L-1: rate = scheduled / 7_776_000, integer division. Below this the
      // rate truncates to zero and the program refuses with RewardRateTooSmall.
      if (scheduled < BigInt(REWARDS_DURATION_SECS)) {
        throw new Error(`scheduling ${fmt(scheduled, p.decimals)} gives a per-second rate of ZERO; the minimum is ${fmt(BigInt(REWARDS_DURATION_SECS), p.decimals)}`);
      }
      if (!authority.publicKey.equals(p.authority)) {
        throw new Error(`this pool's authority is ${p.authority.toBase58()}, not ${authority.publicKey.toBase58()}`);
      }
      console.log(`\nnotify-reward over ${REWARDS_DURATION_SECS / 86400} days`);
      console.log(`  fresh capital  ${fmt(amount, p.decimals)}  (transferred from your ATA)`);
      console.log(`  from budget    ${fmt(fromBudget, p.decimals)}  (already in the reward vault)`);
      console.log(`  rate           ~${fmt(scheduled / BigInt(REWARDS_DURATION_SECS), p.decimals)} / second`);
      await submit(conn, [ixNotifyReward({
        programId, authority: authority.publicKey, pool: poolKey, p, amountRaw: amount, fromBudgetRaw: fromBudget,
      })], authority, { broadcast, label: 'notify-reward' });
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
      const p = await loadPool(conn, programId, poolKey);
      const n = intArg(args, 'nonce');
      const early = args.early === true;
      const pos = decodePosition((await conn.getAccountInfo(positionPda(programId, poolKey, owner.publicKey, n)))?.data);
      if (pos.ok) {
        const matured = Math.floor(Date.now() / 1000) >= Number(pos.value.lockEnd);
        console.log(`\nposition #${n}: ${fmt(pos.value.amount, p.decimals)}, ${matured ? 'MATURED' : 'still locked'}`);
        // The two doors partition time; taking the wrong one is refused on-chain,
        // so say which one applies rather than letting it fail as a constraint.
        if (matured && early) console.log(`  ⚠ this position is MATURED — drop --early and withdraw for free`);
        if (!matured && !early) console.log(`  ⚠ this position is still LOCKED — withdraw_matured will refuse it; --early costs 25%`);
      }
      const pre = await ensureAta(conn, owner.publicKey, owner.publicKey, p);
      await submit(conn, [...pre, ixExit({ programId, owner: owner.publicKey, pool: poolKey, p, positionNonce: n, early })],
        owner, { broadcast, label: early ? 'early-exit (25% penalty)' : 'withdraw-matured' });
      return;
    }

    case 'hatch': {
      const owner = signer();
      const poolKey = new PublicKey(need(args, 'pool'));
      const p = await loadPool(conn, programId, poolKey);
      const n = intArg(args, 'nonce');
      // THE HATCH IS NOT FREE WHILE LOCKED, and this used to say it was.
      //
      // `emergency_withdraw` (lib.rs:607-613) charges the SAME flat 25% as
      // `early_exit` when `now < lock_end` and the pool is not `degraded`. It is
      // free only after maturity, or once the pool is degraded — the M-3 fix that
      // made the two doors agree so neither dominates the other.
      //
      // The penalty is invisible in a dry run: it rides inside the `Withdrawn`
      // event as a base64 `Program data:` line, so the simulation cannot correct a
      // wrong claim on screen. It has to be computed and shown here.
      const pos = decodePosition((await conn.getAccountInfo(positionPda(programId, poolKey, owner.publicKey, n)))?.data);
      console.log(`\nemergency-withdraw — position #${n}`);
      console.log(`  principal only. Accrued rewards are NOT lost: they move to`);
      console.log(`  rewards_carried and stay claimable with 'claim-carried'.`);
      if (!pos.ok) {
        console.log(`  ⚠ could not read the position (${pos.reason}) — the penalty below is UNKNOWN.`);
      } else {
        const now = Math.floor(Date.now() / 1000);
        const locked = now < Number(pos.value.lockEnd);
        // Same arithmetic as math.rs `penalty_for`: amount * 2500 / 10000, floored.
        const penalty = locked && !p.degraded
          ? (pos.value.amount * BigInt(EARLY_EXIT_PENALTY_BPS)) / BigInt(BPS)
          : 0n;
        console.log(`  amount        ${fmt(pos.value.amount, p.decimals)}`);
        console.log(`  status        ${locked ? 'STILL LOCKED' : 'matured'}${p.degraded ? ', pool DEGRADED' : ''}`);
        if (penalty > 0n) {
          console.log(`  🔴 PENALTY    ${fmt(penalty, p.decimals)}  (25% — the hatch is NOT free while locked)`);
          console.log(`  you receive   ${fmt(pos.value.amount - penalty, p.decimals)}`);
          console.log(`  'exit --early' costs exactly the same 25% and ALSO pays your rewards out.`);
          console.log(`  Waiting until ${new Date(Number(pos.value.lockEnd) * 1000).toISOString()} makes it free.`);
        } else {
          console.log(`  penalty       none — ${p.degraded ? 'the pool is degraded' : 'this position has matured'}`);
          console.log(`  you receive   ${fmt(pos.value.amount, p.decimals)}`);
        }
      }
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
      const p = await loadPool(conn, programId, poolKey);
      const bad = executeCapRaiseProblem(p, Math.floor(Date.now() / 1000));
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
      console.log(`  After this the pool takes NO new stakes, and the emergency hatch charges`);
      console.log(`  no penalty while locked. Every existing position can still exit.`);
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
