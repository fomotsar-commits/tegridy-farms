// @vitest-environment node
// The robot runs in Node (scripts/price-keeper.mjs), as its other tests say.
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { decompileTransactionMessage, getBase58Decoder, getCompiledTransactionMessageDecoder, getTransactionDecoder } from '@solana/kit';
import { LEGACY_TX_SIZE_LIMIT, MAX_LOADED_ACCOUNTS_DATA_SIZE, V1_TX_SIZE_LIMIT, assembleV1, fitsLegacy, isV1, signV1, v1Config } from './v1tx';

const BLOCKHASH = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
const payer = Keypair.generate();
const program = Keypair.generate().publicKey;
/** An instruction naming `n` fresh writable accounts, as a swap names its pool's. */
const swapLike = (n: number, tag: number) =>
  new TransactionInstruction({ programId: program, keys: [{ pubkey: payer.publicKey, isSigner: true, isWritable: true }, ...Array.from({ length: n }, () => ({ pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true }))], data: Buffer.from([tag, 1, 2, 3, 4, 5, 6, 7, 8]) });
const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 })];
const decode = (wire: Uint8Array) => {
  const tx = getTransactionDecoder().decode(wire);
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  return { tx, compiled, message: decompileTransactionMessage(compiled) };
};

describe('a trip as a version 1 transaction', () => {
  it('carries the budget a legacy trip pays as its config, never 0 loaded data', () => {
    expect(v1Config(400_000, 10_000)).toEqual({ computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA_SIZE, priorityFeeLamports: 4_000n });
    // 13,773,260 bytes loaded (the GRR trip's test run) plus a quarter: 17,216,575, so 526 pages of 32 KiB.
    expect(v1Config(150_001, 10_000, 13_773_260)).toEqual({ computeUnitLimit: 150_001, loadedAccountsDataSizeLimit: 526 * 32 * 1024, priorityFeeLamports: 1_501n });
    expect(v1Config(1, 1, 0).loadedAccountsDataSizeLimit).toBe(MAX_LOADED_ACCOUNTS_DATA_SIZE);
    expect(v1Config(1, 1, 10 ** 12).loadedAccountsDataSizeLimit).toBe(MAX_LOADED_ACCOUNTS_DATA_SIZE);
  });

  it('is version 1 on the wire, with its payer, blockhash and config, and no ComputeBudget instruction', () => {
    const body = [swapLike(3, 1), swapLike(4, 2)];
    const t = assembleV1(payer.publicKey, BLOCKHASH, 1_000, v1Config(400_000, 10_000), [...budget, ...body]);
    expect(isV1(t)).toBe(true);
    const { compiled, message } = decode(t.wire);
    expect(compiled.version).toBe(1);
    expect(String(message.feePayer.address)).toBe(payer.publicKey.toBase58());
    expect('blockhash' in message.lifetimeConstraint && String(message.lifetimeConstraint.blockhash)).toBe(BLOCKHASH);
    expect(message.config).toMatchObject({ computeUnitLimit: 400_000, loadedAccountsDataSizeLimit: MAX_LOADED_ACCOUNTS_DATA_SIZE, priorityFeeLamports: 4_000n });
    expect(message.instructions).toHaveLength(2);
    expect(message.instructions.map((ix) => String(ix.programAddress))).toEqual([program.toBase58(), program.toBase58()]);
    expect([...message.instructions[1]!.data!]).toEqual([2, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('holds a trip no legacy transaction can: 44 accounts', () => {
    const body = [swapLike(15, 1), swapLike(15, 2), swapLike(13, 3)];
    const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: BLOCKHASH, instructions: [...budget, ...body] }).compileToV0Message());
    expect(fitsLegacy(v0)).toBe(false);
    const t = assembleV1(payer.publicKey, BLOCKHASH, 1_000, v1Config(400_000, 10_000), [...budget, ...body]);
    expect(t.wire.length).toBeGreaterThan(LEGACY_TX_SIZE_LIMIT);
    expect(t.wire.length).toBeLessThanOrEqual(V1_TX_SIZE_LIMIT);
    // A small one still fits the old way, and stays that way.
    const small = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: BLOCKHASH, instructions: [...budget, swapLike(3, 1)] }).compileToV0Message());
    expect(fitsLegacy(small)).toBe(true);
    expect(isV1(small)).toBe(false);
  });

  it('is signed by the keeper: the signature checks out over the message, and is the one the chain names', () => {
    const t = assembleV1(payer.publicKey, BLOCKHASH, 1_000, v1Config(200_000, 10_000), [swapLike(5, 1)]);
    const signed = signV1(t, payer);
    const { tx } = decode(signed.wire);
    const sig = tx.signatures[payer.publicKey.toBase58() as keyof typeof tx.signatures] as Uint8Array;
    expect(sig).toHaveLength(64);
    expect(ed25519.verify(sig, new Uint8Array(tx.messageBytes), payer.publicKey.toBytes())).toBe(true);
    expect(signed.signature).toBe(getBase58Decoder().decode(sig));
    // The unsigned bytes are not changed in place.
    expect(decode(t.wire).tx.signatures[payer.publicKey.toBase58() as keyof typeof tx.signatures]).toBeNull();
    expect(() => signV1(t, Keypair.generate())).toThrow(/not a signer/);
    expect(new PublicKey(payer.publicKey).toBase58()).toBe(payer.publicKey.toBase58());
  });
});
