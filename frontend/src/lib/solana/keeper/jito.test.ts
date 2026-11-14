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
import {
  JITO_BLOCK_ENGINE,
  JITO_GIVE_UP_MS,
  JITO_REGIONS,
  JITO_KEEP_LAMPORTS,
  JITO_LANDING_TIP_LAMPORTS,
  JITO_LANDING_TIP_MEASURED_2026_11_14,
  JITO_MIN_TIP_LAMPORTS,
  JITO_TIP_ACCOUNTS,
  JITO_WATCH_MS,
  PLAIN_KNOCKS,
  PLAIN_REFUSALS_LOST,
  jitoNote,
  jitoSender,
  jitoTip,
  jitoUrls,
  jitoTipIx,
  pickTipAccount,
  type PlainDoor,
} from './jito';

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

  it('is none under the least tip that lands: such bundles never landed live, so the trip goes the usual way', () => {
    expect(JITO_LANDING_TIP_LAMPORTS).toBe(20_000n);
    // 11-06/07: a ~37,400-lamport gain gave an 11,224-lamport tip, sent 15 times, landed 0 times.
    expect(jitoTip(37_413n, 0n, RICH)).toBeNull();
    expect(jitoTip(66_000n, 0n, RICH)).toBeNull();
    expect(jitoTip(1_000_000n, 1_000_000n - 19_999n, RICH)).toBeNull();
    expect(jitoTip(70_000n, 0n, RICH)).toBe(21_000n);
    expect(jitoTip(1_000_000n, 1_000_000n - 20_000n, RICH)).toBe(20_000n);
  });

  it('takes the least tip that lands from the setting (KEEPER_JITO_MIN_TIP_LAMPORTS), never under Jito’s own least', () => {
    // 11-11 to 11-14: tips of 25,295 to 46,312 lamports landed 1 time in 8; 48,230 and more, 8 in 9.
    expect(JITO_LANDING_TIP_MEASURED_2026_11_14).toBe(50_000n);
    // A 152,000-lamport gain: a 45,600 tip. It went through Jito before, and goes the usual way at 50,000.
    expect(jitoTip(152_000n, 0n, RICH)).toBe(45_600n);
    expect(jitoTip(152_000n, 0n, RICH, JITO_LANDING_TIP_MEASURED_2026_11_14)).toBeNull();
    expect(jitoTip(167_000n, 0n, RICH, JITO_LANDING_TIP_MEASURED_2026_11_14)).toBe(50_100n);
    // A setting under Jito's own least tip is held to it.
    expect(jitoTip(3_000n, 0n, RICH, 1n)).toBeNull();
    expect(jitoTip(4_000n, 0n, RICH, 1n)).toBe(1_200n);
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
    expect(await r.send(signed)).toEqual({ signature: SIG, outcome: 'confirmed', bundle: 'bundle-1', took: 1, asked: 1, jitoSaid: 'Pending' });
    expect(r.calls[0]).toMatchObject({ method: 'sendBundle', params: [['AQID'], { encoding: 'base64' }] });
    expect((await rig({}, [{ err: { InstructionError: [3, 'Custom'] }, confirmationStatus: 'finalized' }]).send(signed)).outcome).toBe('reverted');
  });

  it('calls a bundle every region failed lost: it never lands, nothing is paid', async () => {
    const r = rig({ inflight: ['Pending', 'Failed'] });
    expect(await r.send(signed)).toMatchObject({ outcome: 'lost', jitoSaid: 'Failed' });
  });

  it('keeps Jito’s last word on a bundle it never failed, for the log', async () => {
    expect(await rig({ inflight: ['Pending', 'Pending', 'Invalid'] }).send(signed)).toMatchObject({ outcome: 'unknown', jitoSaid: 'Pending' });
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (body.method === 'sendBundle') return new Response(JSON.stringify({ result: 'bundle-1' }));
      return new Response('not json', { status: 500 });
    }) as unknown as typeof fetch;
    let clock = 0;
    const never = jitoSender({ fetchImpl, status: async () => null, sleep: async (ms) => void (clock += ms), now: () => clock });
    expect(await never(signed)).toMatchObject({ outcome: 'unknown', jitoSaid: null });
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

  describe('to several regions at once (KEEPER_JITO_REGIONS)', () => {
    function regions(answer: (url: string) => Response | Error, inflight = 'Failed') {
      const sends: string[] = [];
      const asks: string[] = [];
      const fetchImpl = (async (url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.method !== 'sendBundle') {
          asks.push(url);
          return new Response(JSON.stringify({ result: { value: [{ status: inflight }] } }));
        }
        sends.push(url);
        const a = answer(url);
        if (a instanceof Error) throw a;
        return a;
      }) as unknown as typeof fetch;
      let clock = 0;
      const urls = [JITO_REGIONS.ny!, JITO_REGIONS.frankfurt!, JITO_REGIONS.tokyo!];
      const send = jitoSender({ fetchImpl, urls, status: async () => null, sleep: async (ms) => void (clock += ms), now: () => clock });
      return { send: () => send(signed), sends, asks, urls };
    }
    const ok = () => new Response(JSON.stringify({ result: 'bundle-1' }));

    it('sends the same bundle to every one, once each, and asks the first that took it how it fares', async () => {
      const r = regions(ok);
      expect(await r.send()).toMatchObject({ outcome: 'lost', took: 3, asked: 3, bundle: 'bundle-1' });
      expect(r.sends.map((u) => u.replace('/api/v1/bundles', ''))).toEqual(r.urls);
      expect(new Set(r.asks)).toEqual(new Set([`${JITO_REGIONS.ny}/api/v1/bundles`]));
    });

    it('is sent when some refuse it (one too busy, one unreachable): the first that took it is asked', async () => {
      const r = regions((u) => (u.includes('ny.') ? new Response('{}', { status: 429 }) : u.includes('frankfurt.') ? new Error('fetch failed') : ok()));
      expect(await r.send()).toMatchObject({ took: 1, asked: 3 });
      expect(new Set(r.asks)).toEqual(new Set([`${JITO_REGIONS.tokyo}/api/v1/bundles`]));
    });

    it('throws when none takes it: nothing was sent', async () => {
      await expect(regions(() => new Response(JSON.stringify({ error: { message: 'bundle tip too low' } }))).send()).rejects.toThrow(/tip too low/);
      await expect(regions(() => new Error('fetch failed')).send()).rejects.toThrow(/fetch failed/);
    });
  });

  describe('watched until its blockhash runs out', () => {
    const BLOCKHASH = 'Blockhash1111111111111111111111111111111111';
    const withHash = { ...signed, message: { recentBlockhash: BLOCKHASH } } as unknown as VersionedTransaction;
    const EXPIRES_AT = 65_000;
    /**
     * A bundle Jito never fails; the chain's status of it is `status(clock, ranOut)` (an Error =
     * unread), `ranOut` once the robot has been told the blockhash ran out; it runs out at `expiresAt`.
     */
    function watch(status: (clock: number, ranOut: boolean) => { err: unknown; confirmationStatus: string } | null | Error, expiresAt = EXPIRES_AT) {
      let clock = 0;
      let ranOut = false;
      const asked: string[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.method === 'sendBundle') return new Response(JSON.stringify({ result: 'bundle-1' }));
        return new Response(JSON.stringify({ result: { value: [{ status: 'Pending' }] } }));
      }) as unknown as typeof fetch;
      const send = jitoSender({
        fetchImpl,
        status: async () => {
          const s = status(clock, ranOut);
          if (s instanceof Error) throw s;
          return s;
        },
        blockhashValid: async (bh) => {
          asked.push(bh);
          ranOut = clock >= expiresAt;
          return !ranOut;
        },
        sleep: async (ms) => {
          clock += ms;
        },
        now: () => clock,
      });
      return { send: () => send(withHash), asked, clock: () => clock };
    }

    it('calls a bundle the chain never took, once its blockhash ran out, lost: it costs nothing', async () => {
      const r = watch(() => null);
      expect((await r.send()).outcome).toBe('lost');
      expect(r.clock()).toBeGreaterThanOrEqual(EXPIRES_AT);
      expect(r.clock()).toBeLessThan(JITO_GIVE_UP_MS);
      expect(r.asked.every((bh) => bh === BLOCKHASH)).toBe(true);
    });

    it('asks about the blockhash only once the first watch is over', async () => {
      const r = watch(() => null, 0);
      expect((await r.send()).outcome).toBe('lost');
      expect(r.clock()).toBeGreaterThanOrEqual(JITO_WATCH_MS);
    });

    it('is still confirmed (or refused) when the last read, after the blockhash ran out, finds it landed', async () => {
      expect((await watch((_, ranOut) => (ranOut ? { err: null, confirmationStatus: 'confirmed' } : null)).send()).outcome).toBe('confirmed');
      expect((await watch((_, ranOut) => (ranOut ? { err: { InstructionError: [3, 'Custom'] }, confirmationStatus: 'confirmed' } : null)).send()).outcome).toBe('reverted');
    });

    it('stays unknown when the chain cannot be read once the blockhash ran out', async () => {
      const r = watch((_, ranOut) => (ranOut ? new Error('429') : null));
      expect((await r.send()).outcome).toBe('unknown');
    });

    it('stays unknown, after JITO_GIVE_UP_MS, while the blockhash never reads as run out', async () => {
      const r = watch(() => null, Number.POSITIVE_INFINITY);
      expect((await r.send()).outcome).toBe('unknown');
      expect(r.clock()).toBeGreaterThanOrEqual(JITO_GIVE_UP_MS);
    });

    it('watches on while the chain has it in a block not yet confirmed', async () => {
      const r = watch((clock, ranOut) => (clock >= 90_000 ? { err: null, confirmationStatus: 'confirmed' } : ranOut ? { err: null, confirmationStatus: 'processed' } : null));
      expect((await r.send()).outcome).toBe('confirmed');
      expect(r.clock()).toBeGreaterThanOrEqual(90_000);
    });
  });

  describe('with two doors (KEEPER_TWO_DOORS): the same signed transaction to the usual RPC too', () => {
    const BLOCKHASH = 'Blockhash1111111111111111111111111111111111';
    const withHash = { ...signed, message: { recentBlockhash: BLOCKHASH } } as unknown as VersionedTransaction;
    const SENT: PlainDoor = { door: 'sent' };
    const REFUSED: PlainDoor = { door: 'refused', why: 'instruction 2: custom program error: 0x1774' };
    const UNREAD: PlainDoor = { door: 'unread', why: '429 Too Many Requests' };
    /**
     * Jito takes the bundle (or answers `bundleStatus`) and says `inflight` of it, in turn; the plain
     * door answers `doors` in turn (the last one again after that; an Error is thrown); the chain's
     * status is `status(clock, reads)`; the blockhash runs out at `expiresAt` when given.
     */
    function doors(o: { doors: (PlainDoor | Error)[]; inflight?: string[]; status?: (clock: number, reads: number) => { err: unknown; confirmationStatus: string } | null; bundleStatus?: number; expiresAt?: number }) {
      let clock = 0;
      let asks = 0;
      let reads = 0;
      const knocks: { at: number; tx: VersionedTransaction }[] = [];
      const order: string[] = [];
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        if (body.method === 'sendBundle') {
          order.push('bundle');
          return new Response(JSON.stringify({ result: 'bundle-1' }), { status: o.bundleStatus ?? 200 });
        }
        return new Response(JSON.stringify({ result: { value: [{ status: o.inflight?.[Math.min(asks++, o.inflight.length - 1)] ?? 'Pending' }] } }));
      }) as unknown as typeof fetch;
      const send = jitoSender({
        fetchImpl,
        status: async () => o.status?.(clock, reads++) ?? null,
        ...(o.expiresAt === undefined ? {} : { blockhashValid: async () => clock < o.expiresAt! }),
        plain: async (tx) => {
          order.push('plain');
          const a = o.doors[Math.min(knocks.length, o.doors.length - 1)]!;
          knocks.push({ at: clock, tx });
          if (a instanceof Error) throw a;
          return a;
        },
        sleep: async (ms) => void (clock += ms),
        now: () => clock,
      });
      return { send: () => send(withHash), knocks, order, clock: () => clock };
    }
    const confirmedFrom = (ms: number) => (clock: number) => (clock >= ms ? { err: null, confirmationStatus: 'confirmed' } : null);

    it('hands the plain door the very transaction the bundle carries, at the same moment, and says so', async () => {
      const r = doors({ doors: [SENT], status: confirmedFrom(1_000) });
      const sent = await r.send();
      expect(sent).toMatchObject({ signature: SIG, outcome: 'confirmed', bundle: 'bundle-1', plain: 'sent', plainWhy: null });
      expect(r.knocks).toEqual([{ at: 0, tx: withHash }]);
      expect(new Set(r.order)).toEqual(new Set(['bundle', 'plain']));
      expect(jitoNote(sent)).toBe("Jito's last word: none; the plain door: sent too");
    });

    it('a bundle Jito drops still lands by the plain door: Failed no longer ends the watch once it went out by it', async () => {
      const r = doors({ doors: [SENT], inflight: ['Failed'], status: confirmedFrom(3_000) });
      expect(await r.send()).toMatchObject({ outcome: 'confirmed', jitoSaid: 'Failed', plain: 'sent' });
      expect(r.clock()).toBe(3_000);
    });

    it('a failed trip that lands by the plain door is reverted, as the chain says', async () => {
      const r = doors({ doors: [SENT], status: (clock) => (clock >= 2_000 ? { err: { InstructionError: [3, { Custom: 6005 }] }, confirmationStatus: 'confirmed' } : null) });
      expect((await r.send()).outcome).toBe('reverted');
    });

    it('knocks again each watch round while it has not landed, PLAIN_KNOCKS times in all', async () => {
      expect(PLAIN_KNOCKS).toBe(4);
      const r = doors({ doors: [UNREAD] });
      await r.send();
      expect(r.knocks.map((k) => k.at)).toEqual([0, 1_000, 2_000, 3_000]);
    });

    it('calls a trip the RPC’s test run refuses three times running, with nothing sent by that door, lost in 2 s, not 35', async () => {
      expect(PLAIN_REFUSALS_LOST).toBe(3);
      const r = doors({ doors: [REFUSED], inflight: ['Invalid'], expiresAt: 35_000 });
      const sent = await r.send();
      expect(sent).toMatchObject({ outcome: 'lost', jitoSaid: 'Invalid', plain: 'refused', plainWhy: 'instruction 2: custom program error: 0x1774' });
      expect(r.clock()).toBe(2_000);
      expect(r.knocks).toHaveLength(3);
      expect(jitoNote(sent)).toBe("Jito's last word: Invalid; the plain door: its test run refused it: instruction 2: custom program error: 0x1774");
    });

    it('never calls it lost early once it went out by the plain door, whatever its later test runs say: only the blockhash running out does', async () => {
      // Out by the plain door at once; then its test run says no three times running (a rival took
      // the gap, say). The transaction is out all the same and may land while its blockhash lives.
      const r = doors({ doors: [SENT, REFUSED, REFUSED, REFUSED], inflight: ['Invalid'], expiresAt: 35_000 });
      const sent = await r.send();
      expect(sent).toMatchObject({ outcome: 'lost', plain: 'sent' });
      expect(r.clock()).toBeGreaterThanOrEqual(35_000);
      // And one that went out by it only at the second knock.
      const late = doors({ doors: [REFUSED, SENT, REFUSED, REFUSED], inflight: ['Invalid'], expiresAt: 35_000 });
      expect(await late.send()).toMatchObject({ outcome: 'lost', plain: 'sent' });
      expect(late.clock()).toBeGreaterThanOrEqual(35_000);
    });

    it('never counts an RPC that could not be reached as a refusal', async () => {
      const r = doors({ doors: [REFUSED, UNREAD, REFUSED, REFUSED], inflight: ['Invalid'] });
      const sent = await r.send();
      // Refusals running never reach three: unknown once the watch runs out, never lost.
      expect(sent).toMatchObject({ outcome: 'unknown', plain: 'refused' });
      expect(r.clock()).toBeGreaterThanOrEqual(JITO_WATCH_MS);
      const thrown = doors({ doors: [new Error('socket hang up')], inflight: ['Invalid'] });
      expect(await thrown.send()).toMatchObject({ outcome: 'unknown', plain: 'unread', plainWhy: 'socket hang up' });
    });

    it('watches on when the chain knows the signature after all, three refusals or not', async () => {
      // Reads 0 and 1: unknown to the chain. Read 2 (the last look before calling it lost): in a block, not yet confirmed.
      const r = doors({ doors: [REFUSED], inflight: ['Invalid'], status: (_clock, reads) => (reads < 2 ? null : reads < 4 ? { err: null, confirmationStatus: 'processed' } : { err: null, confirmationStatus: 'confirmed' }) });
      expect(await r.send()).toMatchObject({ outcome: 'confirmed' });
    });

    it('with the plain door never sending, Jito’s Failed is lost at once, as before', async () => {
      const r = doors({ doors: [UNREAD], inflight: ['Failed'] });
      expect(await r.send()).toMatchObject({ outcome: 'lost', jitoSaid: 'Failed', plain: 'unread' });
      expect(r.clock()).toBe(1_000);
    });

    it('is sent all the same when no block engine takes it but the plain door does', async () => {
      const r = doors({ doors: [SENT], bundleStatus: 429, status: confirmedFrom(2_000) });
      expect(await r.send()).toMatchObject({ outcome: 'confirmed', bundle: null, took: 0, asked: 1, jitoSaid: null, plain: 'sent' });
    });

    it('throws when no block engine takes it and the plain door sends nothing: nothing was sent', async () => {
      await expect(doors({ doors: [REFUSED], bundleStatus: 429 }).send()).rejects.toThrow(/429/);
      await expect(doors({ doors: [UNREAD], bundleStatus: 429 }).send()).rejects.toThrow(/429/);
    });

    it('says nothing of a plain door when there is none (the setting off): the result is as it always was', async () => {
      const r = rig({}, [null, { err: null, confirmationStatus: 'confirmed' }]);
      const sent = await r.send(signed);
      expect('plain' in sent).toBe(false);
      expect(jitoNote(sent)).toBe("Jito's last word: Pending");
    });
  });
});

describe('jitoUrls: where KEEPER_JITO_REGIONS sends a bundle', () => {
  it('is the one endpoint unset or blank, as before', () => {
    expect(jitoUrls(undefined)).toEqual([JITO_BLOCK_ENGINE]);
    expect(jitoUrls('  ')).toEqual([JITO_BLOCK_ENGINE]);
    expect(jitoUrls(' , ')).toEqual([JITO_BLOCK_ENGINE]);
  });

  it('is every region for "all", eight of them, each Jito’s own host', () => {
    const all = jitoUrls('ALL');
    expect(all).toHaveLength(8);
    for (const u of all) expect(u).toMatch(/^https:\/\/[a-z]+\.mainnet\.block-engine\.jito\.wtf$/);
  });

  it('takes region names joined by commas, "mainnet" for the one endpoint, each once', () => {
    expect(jitoUrls('ny, tokyo,ny,mainnet')).toEqual([JITO_REGIONS.ny, JITO_REGIONS.tokyo, JITO_BLOCK_ENGINE]);
  });

  it('refuses a name Jito does not list: a typo is never a silent default', () => {
    expect(() => jitoUrls('ny,newyork')).toThrow(/"newyork" is not one of Jito's regions/);
  });
});

describe('jitoNote', () => {
  it('says how many regions took a bundle sent to several, and Jito’s last word', () => {
    expect(jitoNote({ took: 7, asked: 8, jitoSaid: 'Pending' })).toBe("7 of 8 regions took it; Jito's last word: Pending");
    expect(jitoNote({ took: 1, asked: 1, jitoSaid: null })).toBe("Jito's last word: none");
  });
});
