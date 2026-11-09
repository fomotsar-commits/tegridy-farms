// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ComputeBudgetProgram, Keypair, SystemProgram } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { DEFAULT_GAS, gasTopUp, gasTopUpIxs } from './gas';

const g = { lowLamports: 5_000_000n, targetLamports: 20_000_000n };

describe('plain SOL kept up from wrapped SOL', () => {
  it('unwraps nothing while plain SOL is at or over the low mark', () => {
    expect(gasTopUp(5_000_000n, 1_000_000_000n, g)).toBe(0n);
    expect(gasTopUp(9_000_000n, 1_000_000_000n, g)).toBe(0n);
  });

  it('brings plain SOL back to the target when it falls under the low mark', () => {
    // The robot on 2026-11-08: 777,248 plain, 211,139,319 wrapped.
    expect(gasTopUp(777_248n, 211_139_319n, g)).toBe(19_222_752n);
    expect(gasTopUp(0n, 1_000_000_000n, g)).toBe(20_000_000n);
  });

  it('unwraps all the wrapped SOL there is when that is less than the top-up, and nothing from none', () => {
    expect(gasTopUp(1_000_000n, 3_000_000n, g)).toBe(3_000_000n);
    expect(gasTopUp(1_000_000n, 0n, g)).toBe(0n);
  });

  it('defaults to 0.005 SOL low and 0.02 SOL target', () => {
    expect(DEFAULT_GAS).toEqual(g);
  });

  it('closes the wrapped-SOL account, opens it again and wraps back all but the top-up, in that order', () => {
    const owner = Keypair.generate().publicKey;
    const ata = getAssociatedTokenAddressSync(NATIVE_MINT, owner, true);
    const ixs = gasTopUpIxs(owner, 211_139_319n, 19_222_752n, 10_000);
    expect(ixs.map((i) => i.programId.toBase58())).toEqual([
      ComputeBudgetProgram.programId.toBase58(),
      ComputeBudgetProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
      ASSOCIATED_TOKEN_PROGRAM_ID.toBase58(),
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM_ID.toBase58(),
    ]);
    // Close: account, destination (the keeper), authority (the keeper); data byte 9 = CloseAccount.
    const close = ixs[2]!;
    expect(close.data[0]).toBe(9);
    expect(close.keys.map((k) => k.pubkey.toBase58())).toEqual([ata, owner, owner].map((k) => k.toBase58()));
    // The transfer puts back exactly what is kept wrapped, into the same account.
    const put = ixs[4]!;
    expect(put.keys.map((k) => k.pubkey.toBase58())).toEqual([owner, ata].map((k) => k.toBase58()));
    expect(new DataView(put.data.buffer, put.data.byteOffset).getBigUint64(4, true)).toBe(211_139_319n - 19_222_752n);
    // Sync: data byte 17 = SyncNative, on the same account.
    expect(ixs[5]!.data[0]).toBe(17);
    expect(ixs[5]!.keys[0]!.pubkey.toBase58()).toBe(ata.toBase58());
  });

  it('only closes the account when all of it is unwrapped', () => {
    const owner = Keypair.generate().publicKey;
    const ixs = gasTopUpIxs(owner, 3_000_000n, 3_000_000n, 10_000);
    expect(ixs.map((i) => i.programId.toBase58())).toEqual([ComputeBudgetProgram.programId.toBase58(), ComputeBudgetProgram.programId.toBase58(), TOKEN_PROGRAM_ID.toBase58()]);
  });

  it('refuses to unwrap nothing, or more than is wrapped', () => {
    const owner = Keypair.generate().publicKey;
    expect(() => gasTopUpIxs(owner, 3_000_000n, 0n, 10_000)).toThrow();
    expect(() => gasTopUpIxs(owner, 3_000_000n, 3_000_001n, 10_000)).toThrow();
  });
});
