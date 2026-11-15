// @vitest-environment node
// (node: web3.js cannot serialize a transaction under jsdom, whose Uint8Array is another realm's.)
// A Jupiter swap from the wallet to the chain (walletSwapSend.ts), 2026-11-15. Pinned here:
// the wallet only signs and this page sends, on a fresh blockhash put on before the wallet;
// the note is written before the first send, and its "can no longer land" proof is read
// from the blockhash the SIGNED transaction carries (a wallet that swaps in its own never
// gets a proof on the one it was handed: the hold would end while the swap can still land);
// a refusal at the first send is "not sent" in the network's words, Phantom's own guard
// named; a wallet that cannot sign alone still signs and sends, as before.

import { describe, expect, it, vi } from 'vitest';
import { ComputeBudgetProgram, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { HELD_NOT_SENT, DECLINED_IN_WALLET } from './walletCopy';
import { LIGHTHOUSE_PROGRAM, sendWalletSwap, type SwapNote, type WalletSwapDeps } from './walletSwapSend';

const WALLET = Keypair.generate();
const JUPITER_HASH = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const FRESH_HASH = new PublicKey(new Uint8Array(32).fill(9)).toBase58();
const WALLETS_OWN_HASH = new PublicKey(new Uint8Array(32).fill(11)).toBase58();
const FRESH = { context: { slot: 500 }, value: { blockhash: FRESH_HASH, lastValidBlockHeight: 1_150 } };
const ARGS = { words: '≈10,000 BAYLA with 0.05 SOL', slippageBps: 50, timeoutMs: 5_000 };

/** Jupiter's transaction as it arrives: unsigned, on Jupiter's own blockhash, Phantom's guard at instruction 1. */
function jupiterTx(payer = WALLET.publicKey): VersionedTransaction {
  const ixs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }),
    new TransactionInstruction({ programId: new PublicKey(LIGHTHOUSE_PROGRAM), keys: [], data: Buffer.from([1]) }),
  ];
  return new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: JUPITER_HASH, instructions: ixs }).compileToV0Message());
}

const signedBy = (kp: Keypair) => async (tx: VersionedTransaction) => {
  tx.sign([kp]);
  return tx;
};

/** Every dependency a mock, so a test reads what was asked; `over` swaps one for another mock, or `sign` for none. */
function deps(over: Partial<Record<keyof WalletSwapDeps, unknown>> = {}) {
  const held: SwapNote[] = [];
  const order: string[] = [];
  const rpc = {
    getLatestBlockhashAndContext: vi.fn(async () => FRESH),
    getBlockHeight: vi.fn(async () => 1_000),
    isBlockhashValid: vi.fn(async () => ({ context: { slot: 600 }, value: true })),
    sendRawTransaction: vi.fn(async (_raw: Uint8Array, _opts?: object) => {
      order.push('send');
      return 'sig';
    }),
    getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [{ slot: 700, confirmations: 1, err: null, confirmationStatus: 'confirmed' as const }] })),
  };
  const base = {
    rpc,
    owner: WALLET.publicKey,
    sign: vi.fn<NonNullable<WalletSwapDeps['sign']>>(signedBy(WALLET)),
    signAndSend: vi.fn<WalletSwapDeps['signAndSend']>(async () => '5'.repeat(88)),
    holdsNow: vi.fn<WalletSwapDeps['holdsNow']>(() => false),
    hold: vi.fn<WalletSwapDeps['hold']>((n: SwapNote) => {
      order.push('hold');
      const i = held.findIndex((h) => h.signature === n.signature && h.sentAt === n.sentAt);
      if (i >= 0) held[i] = n;
      else held.push(n);
    }),
    stillHeld: vi.fn<WalletSwapDeps['stillHeld']>((n) => held.some((h) => h.signature === n.signature && h.sentAt === n.sentAt)),
    release: vi.fn<WalletSwapDeps['release']>((sig: string) => {
      const i = held.findIndex((h) => h.signature === sig);
      if (i >= 0) held.splice(i, 1);
    }),
    confirm: undefined as WalletSwapDeps['confirm'],
  };
  const d = { ...base, ...over } as typeof base;
  return { d, held, order, rpc };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The network's refusal at the first send, as web3.js throws it. */
function refusal(message: string, logs: string[] = []) {
  return Object.assign(new Error(`Simulation failed. \nMessage: ${message}.`), { transactionMessage: message, transactionLogs: logs });
}

describe('sendWalletSwap: the wallet signs, this page sends', () => {
  it('signs on a fresh blockhash, writes the note before the first send, sends with the network check, and releases once confirmed', async () => {
    const { d, held, order, rpc } = deps();
    const end = await sendWalletSwap(d, jupiterTx(), ARGS);
    expect(end).toMatchObject({ kind: 'sent', outcome: 'confirmed' });
    // The wallet signed the transaction on the fresh blockhash, not Jupiter's.
    const handed = d.sign.mock.calls[0]![0] as VersionedTransaction;
    expect(handed.message.recentBlockhash).toBe(FRESH_HASH);
    // It signed only: the wallet's own send was never used.
    expect(d.signAndSend).not.toHaveBeenCalled();
    // The note came before the first byte left; that send ran the network's own check.
    expect(order.slice(0, 2)).toEqual(['hold', 'send']);
    expect(rpc.sendRawTransaction.mock.calls[0]![1]).toMatchObject({ skipPreflight: false });
    // Its proof is the blockhash the signed transaction carries, with its exact last height.
    expect(d.hold.mock.calls[0]![0]).toMatchObject({ lastValidBlockHeight: 1_150, blockhash: { hash: FRESH_HASH, validAt: 500 } });
    if (end.kind !== 'sent') throw new Error('not sent');
    expect(d.release).toHaveBeenCalledWith(end.signature);
    expect(held).toHaveLength(0);
  });

  it('a wallet that swaps in its own blockhash never gets a proof on the one it was handed', async () => {
    // Phantom does this when it adds its guard (2026-11-15): a proof on FRESH_HASH would end
    // the hold when FRESH_HASH dies, while the signed swap can still land on its own.
    const ownHash = async (tx: VersionedTransaction) => {
      tx.message.recentBlockhash = WALLETS_OWN_HASH;
      tx.sign([WALLET]);
      return tx;
    };
    const statuses = vi.fn(async () => ({ context: { slot: 1 }, value: [null] }));
    const { d, rpc } = deps({ sign: vi.fn(ownHash) });
    rpc.getSignatureStatuses = statuses as unknown as typeof rpc.getSignatureStatuses;
    const end = await sendWalletSwap(d, jupiterTx(), { ...ARGS, timeoutMs: 10 });
    expect(end).toMatchObject({ kind: 'sent', outcome: 'unknown' });
    const first = d.hold.mock.calls[0]![0];
    expect(first.blockhash).toBeNull();
    expect(first.lastValidBlockHeight).toBeNull();
    await flush();
    // The late reads complete it: on the blockhash it carries, and Jupiter's bound (height + 300).
    const all = d.hold.mock.calls.map((c) => c[0]);
    expect(all.every((n) => n.blockhash === null || n.blockhash.hash === WALLETS_OWN_HASH)).toBe(true);
    expect(all.at(-1)).toMatchObject({ lastValidBlockHeight: 1_300, blockhash: { hash: WALLETS_OWN_HASH } });
    expect(rpc.isBlockhashValid).toHaveBeenCalledWith(WALLETS_OWN_HASH, expect.anything());
  });

  it('the wallet saying no sends nothing and writes no note', async () => {
    const { d, rpc } = deps({ sign: vi.fn(async () => Promise.reject(Object.assign(new Error('User rejected the request.'), { code: 4001 }))) });
    const end = await sendWalletSwap(d, jupiterTx(), ARGS);
    expect(end).toEqual({ kind: 'not-sent', stage: 'wallet', declined: true, message: DECLINED_IN_WALLET });
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(d.hold).not.toHaveBeenCalled();
  });

  it('any other throw while signing is "not sent" too: signing alone, nothing left the page', async () => {
    const { d, rpc } = deps({ sign: vi.fn(async () => Promise.reject(new Error('Unexpected error'))) });
    const end = await sendWalletSwap(d, jupiterTx(), ARGS);
    expect(end).toMatchObject({ kind: 'not-sent', stage: 'wallet', declined: false });
    expect(end.kind === 'not-sent' && end.message).toMatch(/Unexpected error.*Nothing was sent/);
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(d.hold).not.toHaveBeenCalled();
  });

  it('a transaction signed for another payer is not sent', async () => {
    const other = Keypair.generate();
    const { d, rpc } = deps({ sign: vi.fn(async () => { const t = jupiterTx(other.publicKey); t.sign([other]); return t; }) });
    const end = await sendWalletSwap(d, jupiterTx(), ARGS);
    expect(end).toMatchObject({ kind: 'not-sent', stage: 'wallet' });
    expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a swap this wallet sent elsewhere, seen after the blockhash read, holds it: the wallet is not asked', async () => {
    const { d } = deps({ holdsNow: vi.fn(() => true) });
    const end = await sendWalletSwap(d, jupiterTx(), ARGS);
    expect(end).toMatchObject({ kind: 'not-sent', message: HELD_NOT_SENT });
    expect(d.sign).not.toHaveBeenCalled();
    expect(d.holdsNow.mock.invocationCallOrder[0]!).toBeGreaterThan(d.rpc.getLatestBlockhashAndContext.mock.invocationCallOrder[0]!);
  });
});

describe('a refusal at the first send: not sent, in the network’s words', () => {
  const refusedWith = async (err: Error) => {
    const { d, held, rpc } = deps();
    rpc.sendRawTransaction = vi.fn(async () => Promise.reject(err)) as unknown as typeof rpc.sendRawTransaction;
    const end = await sendWalletSwap(d, jupiterTx(), ARGS);
    expect(end).toMatchObject({ kind: 'not-sent', stage: 'network', declined: false });
    // The note written before the send is released: nothing reached the chain.
    expect(held).toHaveLength(0);
    return end.kind === 'not-sent' ? end.message : '';
  };

  it('names Phantom’s own guard when its instruction is the one that failed', async () => {
    const said = await refusedWith(refusal('Transaction simulation failed: Error processing Instruction 1: Computational budget exceeded'));
    expect(said).toMatch(/wallet’s own safety check stopped it/);
    expect(said).toMatch(/Nothing was sent/);
  });

  it('names it from the logs too', async () => {
    const said = await refusedWith(refusal('Transaction simulation failed: custom program error: 0x1', [`Program ${LIGHTHOUSE_PROGRAM} failed: custom program error: 0x1`]));
    expect(said).toMatch(/wallet’s own safety check/);
  });

  it('says a blockhash that ran out as too long in the wallet', async () => {
    expect(await refusedWith(refusal('Transaction simulation failed: Blockhash not found'))).toMatch(/took too long to approve/);
  });

  it('says Jupiter’s slippage refusal with the slippage set', async () => {
    expect(await refusedWith(refusal('Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1771'))).toMatch(/past your 0\.50% slippage/);
  });

  it('says anything else in the network’s own words', async () => {
    const said = await refusedWith(refusal('Transaction simulation failed: Error processing Instruction 0: invalid account data for instruction'));
    expect(said).toBe('The network refused it before sending it (Error processing Instruction 0: invalid account data for instruction). Nothing was sent.');
  });
});

describe('a wallet that cannot sign alone signs and sends, as before', () => {
  it('a lost answer writes a note with no signature, and no proof on a blockhash it may have swapped', async () => {
    const { d, held } = deps({ sign: undefined, signAndSend: vi.fn(async () => Promise.reject(new Error('Unexpected error'))) });
    const end = await sendWalletSwap(d, jupiterTx(), ARGS);
    expect(end.kind).toBe('lost');
    expect(held).toEqual([expect.objectContaining({ signature: null, blockhash: null, lastValidBlockHeight: null })]);
  });

  it('a signature is watched and its note released once the chain answers', async () => {
    const { d, held } = deps({ sign: undefined, confirm: vi.fn(async () => 'confirmed' as const) });
    const end = await sendWalletSwap(d, jupiterTx(), ARGS);
    expect(end).toMatchObject({ kind: 'sent', outcome: 'confirmed', signature: '5'.repeat(88) });
    expect(d.rpc.sendRawTransaction).not.toHaveBeenCalled();
    expect(held).toHaveLength(0);
  });
});
