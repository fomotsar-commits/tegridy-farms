// @vitest-environment node
//
// Account ORDER and FLAGS, asserted by NAME.
//
// A mutation test on the CLI's equivalent suite proved flag-shaped assertions are
// vacuous here: swapping `user_stats` and `position` in `stake` left all 31 tests
// green, because both accounts are (non-signer, writable) and the helper compared
// only flags. A reordered account list is EXACTLY the defect this file exists to
// catch — Anchor matches ordinally, so it surfaces on chain as a constraint failure
// against the wrong account, after a transaction has been paid for.
//
// So every case below asserts the sequence of NAMED accounts, not just their shape.
import { describe, it, expect } from 'vitest';
import { PublicKey } from '@solana/web3.js';
import {
  IX_DISCRIMINATOR, SYSTEM_PROGRAM_ID,
  associatedTokenAddress, poolPda, positionPda, userStatsPda,
  stakeVaultPda, rewardVaultPda, MIN_LOCK_SECS,
} from './program';
import { stakeIx, claimIx, exitIx, emergencyWithdrawIx, claimCarriedIx } from './ix';

const PROGRAM = new PublicKey('HzxzfSQzJ9WQKe6xBoP5AgHFP8a84CgLB8dovdtDrtMK');
const MINT = new PublicKey('8opsYTPSp2AckjmAc2vx49kohs8CFtNcyR2sNURfrfoL');
const OWNER = new PublicKey('Gut9toQMqtrFL5ERLsAThmtq6e1Hq9BGtWPcjNqziHrj');
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

const POOL = poolPda(PROGRAM, MINT, 0);
const poolAccounts = {
  mint: MINT.toBase58(),
  tokenProgram: TOKEN_2022,
  stakeVault: stakeVaultPda(PROGRAM, POOL).toBase58(),
  rewardVault: rewardVaultPda(PROGRAM, POOL).toBase58(),
};
const common = { programId: PROGRAM, owner: OWNER, pool: POOL, poolAccounts };
const b = (u: Uint8Array | Buffer) => Array.from(u);

// Every account this client can name, so an unexpected one shows up as `other(...)`
// rather than being quietly accepted.
const NAMES: Record<string, string> = {
  owner: OWNER.toBase58(),
  pool: POOL.toBase58(),
  mint: MINT.toBase58(),
  tokenProgram: TOKEN_2022,
  stakeVault: poolAccounts.stakeVault,
  rewardVault: poolAccounts.rewardVault,
  userStats: userStatsPda(PROGRAM, POOL, OWNER).toBase58(),
  position0: positionPda(PROGRAM, POOL, OWNER, 0).toBase58(),
  ownerAta: associatedTokenAddress(MINT, OWNER, new PublicKey(TOKEN_2022)).toBase58(),
  systemProgram: SYSTEM_PROGRAM_ID.toBase58(),
};
const order = (ix: { keys: { pubkey: PublicKey }[] }) =>
  ix.keys.map((k) => Object.entries(NAMES).find(([, v]) => v === k.pubkey.toBase58())?.[0]
    ?? `other(${k.pubkey.toBase58().slice(0, 6)})`);
const shape = (ix: { keys: { isSigner: boolean; isWritable: boolean }[] }) =>
  ix.keys.map((k) => `${k.isSigner ? 'S' : ''}${k.isWritable ? 'W' : ''}`);

describe('stake', () => {
  const ix = stakeIx({ ...common, positionNonce: 0, amountRaw: 500_000_000n, lockSecs: MIN_LOCK_SECS });

  it('names its accounts in the IDL order', () => {
    expect(order(ix)).toEqual([
      'owner', 'pool', 'mint', 'userStats', 'position0', 'ownerAta',
      'stakeVault', 'tokenProgram', 'systemProgram',
    ]);
  });
  it('carries the IDL flags', () => {
    expect(shape(ix)).toEqual(['SW', 'W', '', 'W', 'W', 'W', 'W', '', '']);
  });
  it('encodes amount as u64 LE and lock as i64 LE, in that order', () => {
    expect(b(ix.data.subarray(0, 8))).toEqual(b(IX_DISCRIMINATOR.stake));
    expect(ix.data.length).toBe(8 + 8 + 8);
    expect(ix.data.readBigUInt64LE(8)).toBe(500_000_000n);
    expect(ix.data.readBigInt64LE(16)).toBe(BigInt(MIN_LOCK_SECS));
  });
  it('addresses the position the NONCE names, not always #0', () => {
    const other = stakeIx({ ...common, positionNonce: 3, amountRaw: 1n, lockSecs: MIN_LOCK_SECS });
    expect(order(other)[4]).toBe('other(' + positionPda(PROGRAM, POOL, OWNER, 3).toBase58().slice(0, 6) + ')');
    expect(other.keys[4]!.pubkey.toBase58()).not.toBe(NAMES.position0);
  });
});

describe('claim', () => {
  const ix = claimIx({ ...common, positionNonce: 0 });
  it('names its accounts in the IDL order', () => {
    expect(order(ix)).toEqual(['owner', 'pool', 'mint', 'position0', 'ownerAta', 'rewardVault', 'tokenProgram']);
  });
  it('the owner SIGNS but is not writable, and no stake vault is named', () => {
    expect(shape(ix)).toEqual(['S', 'W', '', 'W', 'W', 'W', '']);
    expect(order(ix)).not.toContain('stakeVault');
  });
  it('takes no args', () => expect(b(ix.data)).toEqual(b(IX_DISCRIMINATOR.claim)));
});

describe('the two normal exit doors', () => {
  const matured = exitIx({ ...common, positionNonce: 0, early: false });
  const early = exitIx({ ...common, positionNonce: 0, early: true });

  it('share an account list exactly', () => {
    expect(order(matured)).toEqual([
      'owner', 'pool', 'mint', 'userStats', 'position0', 'ownerAta',
      'stakeVault', 'rewardVault', 'tokenProgram',
    ]);
    expect(order(early)).toEqual(order(matured));
    expect(shape(early)).toEqual(shape(matured));
  });

  it('differ ONLY in the discriminator', () => {
    expect(b(matured.data)).toEqual(b(IX_DISCRIMINATOR.withdrawMatured));
    expect(b(early.data)).toEqual(b(IX_DISCRIMINATOR.earlyExit));
    expect(b(matured.data)).not.toEqual(b(early.data));
  });
});

describe('the hatch', () => {
  const ix = emergencyWithdrawIx({ ...common, positionNonce: 0 });

  it('NAMES NO REWARD VAULT — invariant I-12, enforced by the account list', () => {
    expect(order(ix)).toEqual([
      'owner', 'pool', 'mint', 'userStats', 'position0', 'ownerAta',
      'stakeVault', 'tokenProgram',
    ]);
    expect(order(ix)).not.toContain('rewardVault');
    expect(order(ix)).toContain('stakeVault');
  });
  it('carries the IDL flags', () => {
    expect(shape(ix)).toEqual(['SW', 'W', '', 'W', 'W', 'W', 'W', '']);
  });
  it('sends the emergency_withdraw discriminator and no args', () => {
    expect(b(ix.data)).toEqual(b(IX_DISCRIMINATOR.emergencyWithdraw));
  });
});

describe('claim-carried', () => {
  const ix = claimCarriedIx(common);
  it('names its accounts in the IDL order, and NO position', () => {
    // It pays a per-WALLET balance, so there is no position in the list at all.
    expect(order(ix)).toEqual(['owner', 'pool', 'mint', 'userStats', 'ownerAta', 'rewardVault', 'tokenProgram']);
    expect(order(ix)).not.toContain('position0');
  });
  it('draws on the REWARD vault only', () => {
    expect(order(ix)).toContain('rewardVault');
    expect(order(ix)).not.toContain('stakeVault');
    expect(shape(ix)).toEqual(['S', 'W', '', 'W', 'W', 'W', '']);
  });
  it('sends the claim_carried discriminator, NOT claim', () => {
    // MUTATION-FOUND. `claim` and `claim_carried` have similar-looking account
    // lists of the same length, so swapping the opcode passed every assertion in
    // this block until this line existed. On chain it would decode as the wrong
    // instruction against the wrong accounts.
    expect(b(ix.data)).toEqual(b(IX_DISCRIMINATOR.claimCarried));
    expect(b(ix.data)).not.toEqual(b(IX_DISCRIMINATOR.claim));
  });
});

describe('the token program comes from the POOL, never assumed', () => {
  // BAYLA is Token-2022 and the first Streamflow broadcast in this repo died with
  // IncorrectProgramId for assuming legacy SPL. A legacy pool must produce a legacy
  // account list — including a DIFFERENT ATA, since the ATA derivation includes it.
  const LEGACY = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
  it('a legacy-SPL pool yields the legacy program and its own ATA', () => {
    const ix = claimIx({
      ...common,
      poolAccounts: { ...poolAccounts, tokenProgram: LEGACY },
      positionNonce: 0,
    });
    expect(ix.keys[6]!.pubkey.toBase58()).toBe(LEGACY);
    const legacyAta = associatedTokenAddress(MINT, OWNER, new PublicKey(LEGACY)).toBase58();
    expect(ix.keys[4]!.pubkey.toBase58()).toBe(legacyAta);
    expect(legacyAta).not.toBe(NAMES.ownerAta);
  });
});
