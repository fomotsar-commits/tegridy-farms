// @vitest-environment node
//
// Jito: the tip copied from a real mainnet Jito-tipped transaction, the 30% rule, where the tip
// sits in a trip and what it adds to the floor, and how a sent bundle's ending is called.
import { describe, it, expect, vi } from 'vitest';
import { base58 } from '@scure/base';
import { Keypair, PublicKey, TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { SOL_QUOTE } from '../lp/quotes';
import { tripInstructions } from './cycle';
import { floorOfCheck } from './lighthouse';
import { JITO_KEEP_LAMPORTS, JITO_MIN_TIP_LAMPORTS, JITO_TIP_ACCOUNTS, jitoSender, jitoTip, jitoTipIx, pickTipAccount } from './jito';

// Mainnet transaction 5NWjWUTarePF557unjrhWPnobzYca6oDMRwARnbAmVbYTfUHik9cshCHRZ1yTDkeT3qgGAXLDeiSeitncQGBNQQF
// (slot 465,966,356), its last instruction (5 of 0..5), as getTransaction returned it 2026-11-05.
const REAL = {
  program: '11111111111111111111111111111111',
  data: '3Bxs4ThwQbE4vyj5',
  signer: '84TyvhEkyhmMuDtdj614ZMFrbpSUBcWNxyMnR7KyZzC5',
  tipAccount: '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
  lamports: 100_000n,
};

describe('the Jito tip: the real transaction’s instruction, byte for byte', () => {
  it('pays with the same program, data and accounts', () => {
    const ix = jitoTipIx(new PublicKey(REAL.signer), REAL.lamports, REAL.tipAccount);
    expect(ix.programId.toBase58()).toBe(REAL.program);
    expect(Buffer.from(ix.data).toString('hex')).toBe(Buffer.from(base58.decode(REAL.data)).toString('hex'));
    expect(Buffer.from(ix.data).toString('hex')).toBe('02000000a086010000000000');
    expect(ix.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [REAL.signer, true, true],
      [REAL.tipAccount, false, true],
    ]);
  });

  it('pays only one of Jito’s tip accounts, as its block engine listed them, and never under its least tip', () => {
    expect(JITO_TIP_ACCOUNTS).toHaveLength(8);
    expect(JITO_TIP_ACCOUNTS).toContain(REAL.tipAccount);
    const payer = Keypair.generate().publicKey;
    expect(() => jitoTipIx(payer, 5_000n, Keypair.generate().publicKey.toBase58())).toThrow(/tip account/);
    expect(() => jitoTipIx(payer, JITO_MIN_TIP_LAMPORTS - 1n, REAL.tipAccount)).toThrow(/at least/);
    expect(pickTipAccount(() => 0)).toBe(JITO_TIP_ACCOUNTS[0]);
    expect(pickTipAccount(() => 7)).toBe(JITO_TIP_ACCOUNTS[7]);
    expect(pickTipAccount(() => 255)).toBe(JITO_TIP_ACCOUNTS[7]);
  });

  it('gives every tip account the same odds: each of the 256 bytes picks one, 32 bytes to each', () => {
    const count = new Map<string, number>();
    for (let b = 0; b < 256; b++) {
      const a = pickTipAccount(() => b);
      count.set(a, (count.get(a) ?? 0) + 1);
    }
    expect([...count.keys()].sort()).toEqual([...JITO_TIP_ACCOUNTS].sort());
    expect([...count.values()]).toEqual(Array(8).fill(32));
  });

  it('picks the tip account with the cryptographic random source, never Math.random', () => {
    const plain = vi.spyOn(Math, 'random');
    try {
      const picked = new Set(Array.from({ length: 200 }, () => pickTipAccount()));
      for (const a of picked) expect(JITO_TIP_ACCOUNTS).toContain(a);
      expect(picked.size).toBeGreaterThan(1);
      expect(plain).not.toHaveBeenCalled();
    } finally {
      plain.mockRestore();
    }
  });
});

describe('jitoTip', () => {
  const RICH = 1_000_000_000n; // plain SOL left after the trip: plenty

  it('is 30% of the test run’s gain while the gain covers the floor and the tip', () => {
    expect(jitoTip(1_000_000n, 100_000n, RICH)).toBe(300_000n);
  });

  it('is cut so the gain still covers the floor', () => {
    expect(jitoTip(1_000_000n, 900_000n, RICH)).toBe(100_000n);
  });

  it('is cut to the plain SOL the wallet can spare: the gain lands wrapped, the tip is paid plain', () => {
    // The wallet keeps 0.001 SOL: open, and able to pay the next trip's fee.
    expect(JITO_KEEP_LAMPORTS).toBe(1_000_000n);
    expect(jitoTip(1_000_000n, 100_000n, 1_050_000n)).toBe(50_000n);
    expect(jitoTip(1_000_000n, 100_000n, 1_000_000n)).toBeNull();
  });

  it('is none when that is under Jito’s least tip', () => {
    expect(jitoTip(1_000_000n, 999_500n, RICH)).toBeNull();
    expect(jitoTip(3_000n, 0n, RICH)).toBeNull();
    expect(jitoTip(100_000n, 100_000n, RICH)).toBeNull();
  });
});

describe('a trip with a tip', () => {
  const owner = Keypair.generate().publicKey;
  const coinAta = Keypair.generate().publicKey;
  const swap = new TransactionInstruction({ programId: owner, keys: [], data: Buffer.from([1]) });
  const accounts = { coinAta, tokenAta: Keypair.generate().publicKey, otherAta: Keypair.generate().publicKey, tokenMint: Keypair.generate().publicKey, tokenProgram: Keypair.generate().publicKey, coinMint: new PublicKey(SOL_QUOTE.mint) };

  it('pays it after the swaps, and the Lighthouse check, still last, holds the account to the floor plus the tip', () => {
    const tip = { lamports: 40_000n, account: REAL.tipAccount };
    const ixs = tripInstructions(owner, { accounts, legs: [swap, swap], floor: 119_000n, tip }, 10_000, 400_000, 5_000_000n);
    expect(ixs.at(-3)).toBe(swap);
    expect(ixs.at(-2)!.data).toEqual(jitoTipIx(owner, 40_000n, REAL.tipAccount).data);
    expect(ixs.at(-2)!.keys[0]!.pubkey.equals(owner)).toBe(true);
    expect(floorOfCheck(ixs.at(-1)!)).toEqual({ account: coinAta, min: 5_159_000n });
  });

  it('is never paid on a trip in another coin', () => {
    const tip = { lamports: 40_000n, account: REAL.tipAccount };
    expect(() => tripInstructions(owner, { accounts: { ...accounts, coinMint: Keypair.generate().publicKey }, legs: [swap], floor: 1n, tip }, 10_000, 400_000, 0n)).toThrow(/tip is only paid on a SOL trip/);
  });
});

describe('jitoSender', () => {
  const signed = { signatures: [new Uint8Array(64).fill(7)], serialize: () => new Uint8Array([1, 2, 3]) } as unknown as VersionedTransaction;
  const SIG = base58.encode(new Uint8Array(64).fill(7));
  function rig(answers: { send?: unknown; status?: number; inflight?: string[] }, statuses: ({ err: unknown; confirmationStatus: string } | null)[] = []) {
    const calls: { method: string; params: unknown[] }[] = [];
    let clock = 0;
    let inflight = 0;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push(body);
      if (body.method === 'sendBundle') return new Response(JSON.stringify(answers.send ?? { result: 'bundle-1' }), { status: answers.status ?? 200 });
      return new Response(JSON.stringify({ result: { value: [{ status: answers.inflight?.[inflight++] ?? 'Pending' }] } }));
    }) as unknown as typeof fetch;
    let read = 0;
    const send = jitoSender({
      fetchImpl,
      status: async () => statuses[read++] ?? null,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    return { send, calls, clock: () => clock };
  }

  it('sends the signed transaction as a one-transaction bundle, and is confirmed once the chain says so', async () => {
    const r = rig({}, [null, { err: null, confirmationStatus: 'confirmed' }]);
    expect(await r.send(signed)).toEqual({ signature: SIG, outcome: 'confirmed', bundle: 'bundle-1' });
    expect(r.calls[0]).toMatchObject({ method: 'sendBundle', params: [['AQID'], { encoding: 'base64' }] });
    expect((await rig({}, [{ err: { InstructionError: [3, 'Custom'] }, confirmationStatus: 'finalized' }]).send(signed)).outcome).toBe('reverted');
  });

  it('calls a bundle every region failed lost: it never lands, nothing is paid', async () => {
    const r = rig({ inflight: ['Pending', 'Failed'] });
    expect((await r.send(signed)).outcome).toBe('lost');
  });

  it('calls a bundle neither landed nor failed unknown once its watch runs out, never lost', async () => {
    const r = rig({ inflight: [] });
    expect((await r.send(signed)).outcome).toBe('unknown');
    expect(r.clock()).toBeGreaterThanOrEqual(30_000);
  });

  it('throws when Jito refuses the bundle: nothing was sent', async () => {
    await expect(rig({ send: { error: { message: 'bundle tip too low' } } }).send(signed)).rejects.toThrow(/tip too low/);
    await expect(rig({ status: 429, send: {} }).send(signed)).rejects.toThrow(/429/);
  });
});
