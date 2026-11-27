// @vitest-environment node
// The shared send for every Solana write with no review screen (lib/solana/walletWrite.ts).
// Its full path (a legacy, a version 0 and a version 1 wallet) is walked end to end in
// lib/ladder/write.test.ts; here: the SOL check's arithmetic and words, and a transaction
// someone else built (sendBuiltTx: Jupiter's DCA and limit orders).
import { describe, it, expect, vi } from 'vitest';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, type Connection } from '@solana/web3.js';
import {
  RENT_EXEMPT_EMPTY_LAMPORTS, WALLET_FEE_ROOM_LAMPORTS, WRITE_COPY, sendBuiltTx, solShortCopy, solShortfall, solWords,
} from './walletWrite';

describe('the SOL check (Phantom, ticket #467471: check the balance covers the fee and the rent)', () => {
  it('needs what the test run took, the fee, room for the wallet’s own fee, and the wallet left rent-exempt', () => {
    const need = 2_039_280n + 5_000n + WALLET_FEE_ROOM_LAMPORTS + RENT_EXEMPT_EMPTY_LAMPORTS;
    expect(solShortfall(need, need - 2_039_280n, 5_000n)).toBeNull();
    expect(solShortfall(need - 1n, need - 1n - 2_039_280n, 5_000n)).toEqual({ need, have: need - 1n });
  });

  it('a run that paid the wallet, or did not say, counts nothing taken', () => {
    expect(solShortfall(1_000_000n, 2_000_000n, 5_000n)).toBeNull();
    expect(solShortfall(1_000_000n, null, 5_000n)).toBeNull();
    expect(solShortfall(900_000n, null, 5_000n)).not.toBeNull();
  });

  it('never overstates in the reader’s favour: what is needed rounds up, what is held rounds down', () => {
    expect(solWords(3_035_160n, 'up')).toBe('0.003036');
    expect(solWords(3_035_160n, 'down')).toBe('0.003035');
    expect(solWords(1_000_000_000n, 'down')).toBe('1');
    expect(solWords(0n, 'up')).toBe('0');
    expect(solShortCopy(3_035_160n, 2_500_000n)).toBe(
      'Not enough SOL: this needs about 0.003036 SOL in your wallet for the network fee and account rent, and it holds 0.0025 SOL. Your wallet was not asked. Nothing was sent.',
    );
    expect(solShortCopy(1n, 0n)).not.toContain('—');
  });
});

describe('sendBuiltTx: a transaction someone else built, tested as it is, signed only, sent by us', () => {
  const owner = Keypair.generate();
  const built = () => new VersionedTransaction(new TransactionMessage({
    payerKey: owner.publicKey,
    recentBlockhash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    instructions: [SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message());
  const conn = (over: { run?: { err: unknown; logs?: string[] } | 'silent'; balance?: number; after?: number } = {}) => ({
    getBalance: vi.fn(async () => over.balance ?? 1_000_000_000),
    simulateTransaction: vi.fn(async (..._a: unknown[]) => {
      if (over.run === 'silent') throw new Error('429');
      const r = over.run ?? { err: null };
      return { context: { slot: 1 }, value: { err: r.err, logs: r.logs ?? [], accounts: [{ lamports: over.after ?? (over.balance ?? 1_000_000_000) - 5_000, data: ['', 'base64'] }] } };
    }),
    sendRawTransaction: vi.fn(async () => 'ignored'),
    getSignatureStatuses: vi.fn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed', slot: 9 }] })),
    getLatestBlockhash: vi.fn(),
  });
  const sign = vi.fn(async (tx: VersionedTransaction) => { tx.sign([owner]); return tx; });
  const refused = (r: { logs: string[] }, where: 'test' | 'send') => `${where}: ${r.logs.join('|')}`;
  const deps = { sleep: async () => {}, now: () => 0 };

  it('tests its own bytes, blockhash untouched, before the wallet; the wallet only signs; we send with preflight on', async () => {
    const c = conn();
    const tx = built();
    const bytes = tx.serialize();
    const end = await sendBuiltTx(c as unknown as Connection, sign, owner.publicKey, tx, { refused, deps });
    expect(end).toMatchObject({ kind: 'sent', outcome: 'confirmed', slot: 9 });
    expect(Buffer.from((c.simulateTransaction.mock.calls[0]![0] as { serialize(): Uint8Array }).serialize()).equals(Buffer.from(bytes))).toBe(true);
    expect(c.simulateTransaction.mock.calls[0]![1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: false });
    expect(c.simulateTransaction.mock.invocationCallOrder[0]).toBeLessThan(sign.mock.invocationCallOrder.at(-1)!);
    expect((c.sendRawTransaction.mock.calls[0] as unknown[])[1]).toMatchObject({ skipPreflight: false });
    expect(c.getLatestBlockhash).not.toHaveBeenCalled();
  });

  it.each([
    ['a test run that refuses it', { run: { err: { InstructionError: [0, { Custom: 1 }] }, logs: ['boom'] } }, 'test: boom'],
    ['a test run that cannot finish', { run: 'silent' as const }, WRITE_COPY.noAnswer],
    ['a wallet short of SOL', { balance: 500_000 }, /^Not enough SOL/],
  ])('%s: the wallet is never asked, nothing is sent', async (_, over, said) => {
    sign.mockClear();
    const c = conn(over);
    const end = await sendBuiltTx(c as unknown as Connection, sign, owner.publicKey, built(), { refused, deps });
    expect(end.kind).toBe('not-sent');
    if (end.kind === 'not-sent') {
      if (typeof said === 'string') expect(end.reason).toBe(said);
      else expect(end.reason).toMatch(said);
    }
    expect(sign).not.toHaveBeenCalled();
    expect(c.sendRawTransaction).not.toHaveBeenCalled();
  });

  it('a transaction another wallet pays for is never put to this one', async () => {
    sign.mockClear();
    const end = await sendBuiltTx(conn() as unknown as Connection, sign, Keypair.generate().publicKey, built(), { refused, deps });
    expect(end).toMatchObject({ kind: 'not-sent', stage: 'check' });
    expect(sign).not.toHaveBeenCalled();
  });
});
