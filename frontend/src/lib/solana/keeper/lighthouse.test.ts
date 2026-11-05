// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { LIGHTHOUSE_PROGRAM, atLeastCheck, failedAsLighthouse, floorOfCheck, proveLighthouse } from './lighthouse';
import { tripInstructions } from './cycle';

/** The robot's wrapped-SOL account, and the balance the mainnet proof ran at (2026-11-05). */
const ACCOUNT = new PublicKey('2GK38o149SdbNrzKhNdEuQfWf4EWdrhd2ZZ7UYhPB5y2');
const PROVEN_AT = 598_593_502n;

describe('atLeastCheck', () => {
  it('is the bytes proven on mainnet: AssertTokenAccount, silent, Amount, u64, ≥', () => {
    const ix = atLeastCheck(ACCOUNT, PROVEN_AT);
    expect(ix.programId.equals(LIGHTHOUSE_PROGRAM)).toBe(true);
    expect(Buffer.from(ix.data).toString('hex')).toBe('090002decfad230000000004');
    expect(ix.keys).toEqual([{ pubkey: ACCOUNT, isSigner: false, isWritable: false }]);
    expect(floorOfCheck(ix)).toEqual({ account: ACCOUNT, min: PROVEN_AT });
  });

  it('refuses a floor that does not fit', () => {
    expect(() => atLeastCheck(ACCOUNT, -1n)).toThrow();
    expect(() => atLeastCheck(ACCOUNT, 1n << 64n)).toThrow();
  });
});

describe('the proof the cap waits on', () => {
  const failed = { InstructionError: [0, { Custom: 6001 }] };
  /** A chain where Lighthouse checks the amount as it does on mainnet. */
  const honest = (balance: bigint) => async (ix: TransactionInstruction) => ((floorOfCheck(ix)?.min ?? 0n) <= balance ? null : failed);

  it('passes only when the check holds at the balance and fails one unit over it', async () => {
    expect(await proveLighthouse(ACCOUNT, 10n, honest(10n))).toBeNull();
  });

  it('fails when a broken floor is not refused', async () => {
    expect(await proveLighthouse(ACCOUNT, 10n, async () => null)).toMatch(/did not fail as Lighthouse fails/);
  });

  it('fails when the check refuses even a floor that is met, or fails some other way', async () => {
    expect(await proveLighthouse(ACCOUNT, 10n, async () => failed)).toMatch(/at the balance failed/);
    expect(await proveLighthouse(ACCOUNT, 10n, async (ix) => ((floorOfCheck(ix)?.min ?? 0n) <= 10n ? null : { InstructionError: [0, { Custom: 1 }] }))).not.toBeNull();
    expect(failedAsLighthouse('AccountNotFound')).toBe(false);
  });
});

describe('a trip’s instructions', () => {
  it('end with the Lighthouse check: the coin account holds what it held plus the floor', () => {
    const owner = Keypair.generate().publicKey;
    const coinAta = Keypair.generate().publicKey;
    const swap = new TransactionInstruction({ programId: owner, keys: [], data: Buffer.from([1]) });
    const accounts = { coinAta, tokenAta: Keypair.generate().publicKey, otherAta: Keypair.generate().publicKey, tokenMint: Keypair.generate().publicKey, tokenProgram: Keypair.generate().publicKey, coinMint: Keypair.generate().publicKey };
    const ixs = tripInstructions(owner, { accounts, legs: [swap, swap], floor: 119_000n }, 10_000, 400_000, 5_000_000n);
    expect(ixs.at(-3)).toBe(swap);
    expect(floorOfCheck(ixs.at(-1)!)).toEqual({ account: coinAta, min: 5_119_000n });
  });
});
