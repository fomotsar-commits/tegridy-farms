// @vitest-environment node
//
// What may reach a wallet without a second read: a transaction prepared again whose
// instructions are the reviewed ones, byte for byte. Real web3 instructions, no chain.
import { describe, expect, it } from 'vitest';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { serializeBody } from './prepare';
import { sameToSign } from './sameToSign';
import type { PreparedTx, TxKind, TxVersion } from './types';

const KEY = (n: number) => new PublicKey(new Uint8Array(32).fill(n));
const PAYER = KEY(2);

type Meta = { pubkey: PublicKey; isSigner: boolean; isWritable: boolean };
const keys = (): Meta[] => [
  { pubkey: PAYER, isSigner: true, isWritable: true },
  { pubkey: KEY(51), isSigner: false, isWritable: true },
];
const ix = (over: { programId?: PublicKey; keys?: Meta[]; data?: number[] } = {}) =>
  new TransactionInstruction({ programId: over.programId ?? KEY(50), keys: over.keys ?? keys(), data: Buffer.from(over.data ?? [1, 2, 3]) });

/** Only what `sameToSign` reads: the kind, the payer, the message's version and the body as prepared. */
function p(ixs: TransactionInstruction[], o: { payer?: PublicKey | null; kind?: TxKind; version?: TxVersion } = {}): PreparedTx {
  const payer = o.payer === null ? null : (o.payer ?? PAYER);
  return { kind: o.kind ?? 'buy', payer, wire: { version: o.version ?? 'legacy' }, check: { body: serializeBody(ixs) } } as unknown as PreparedTx;
}

describe('sameToSign', () => {
  it('the same instructions under a newer blockhash and another budget are the same to sign', () => {
    // Neither the blockhash nor the budget is part of the body: each prepare sets its own,
    // `decodeIntent` caps the fee it makes, and the fee is a line of the review.
    expect(sameToSign(p([ix(), ix({ data: [4] })]), p([ix(), ix({ data: [4] })]))).toBe(true);
    expect(sameToSign(p([ix()], { version: 1 }), p([ix()], { version: 1 }))).toBe(true);
  });

  it.each<[string, PreparedTx]>([
    ['one byte of an amount', p([ix({ data: [1, 2, 4] })])],
    ['an account', p([ix({ keys: [keys()[0]!, { pubkey: KEY(52), isSigner: false, isWritable: true }] })])],
    ['who must sign', p([ix({ keys: [keys()[0]!, { pubkey: KEY(51), isSigner: true, isWritable: true }] })])],
    ['what may be written', p([ix({ keys: [keys()[0]!, { pubkey: KEY(51), isSigner: false, isWritable: false }] })])],
    ['the program', p([ix({ programId: KEY(53) })])],
    ['one more instruction', p([ix(), ix({ data: [9] })])],
    ['no instruction at all', p([])],
    ['who pays', p([ix()], { payer: KEY(60) })],
    ['no payer', p([ix()], { payer: null })],
    ['the kind', p([ix()], { kind: 'sell' })],
    ['the message version: a version 1 message is not the legacy one', p([ix()], { version: 1 })],
  ])('a difference in %s is not the same to sign', (_what, other) => {
    const a = p([ix()]);
    expect(sameToSign(a, other)).toBe(false);
    expect(sameToSign(other, a)).toBe(false);
  });

  it('the order of the instructions is part of what is signed', () => {
    expect(sameToSign(p([ix({ data: [1] }), ix({ data: [2] })]), p([ix({ data: [2] }), ix({ data: [1] })]))).toBe(false);
  });

  it('two transactions with no payer are never the same: an unreadable payer is not a match', () => {
    expect(sameToSign(p([ix()], { payer: null }), p([ix()], { payer: null }))).toBe(false);
  });
});
