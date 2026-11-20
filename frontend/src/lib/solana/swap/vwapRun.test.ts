// The VWAP order's loop: the record is written before the wallet is asked and the signature
// before the first send; Stop, a changed order and a late signature are never sent; a slice
// out holds every other one; a whole order runs to its end on a clock that only moves when
// the loop sleeps.
import { describe, it, expect, vi } from 'vitest';
import type { VersionedTransaction } from '@solana/web3.js';
import { SOL_MINT } from '../../solana';
import type { JupiterQuote } from '../../jupiter';
import type { PairAverage } from './pairAverage';
import type { WalletSwapEnd } from './walletSwapSend';
import { LATE_SIGN_MS, RETRY_MS, planOrder, type VwapOrder } from './vwapOrder';
import { DECLINED_COPY, LATE_COPY, UNCONFIRMED_COPY, WITHDRAWN_COPY, needsRunner, runOrder, sendSlice, type RunEnv } from './vwapRun';

const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const WALLET = '6VHowW4p7ZJfNC3LuU9C4LkpnTJmtTBwvKBjUcV1Nqm6';
const SIG = '5LJAXrtqJJXfsfDQvWPkvfD1xQF6E3RR21RPt1R6YwaCmk65QtTaahhebRYr4qaxQ4DmpWLwVvcDdWfyBd6ugQrw';
const T0 = Date.UTC(2026, 10, 19);
const HOUR = 3_600_000;
const AVG: PairAverage = { kind: 'ok', baseMint: BAYLA, quoteMint: SOL_MINT, price: 0.000005 };

function plan(): VwapOrder {
  const o = planOrder({
    id: 'o1', wallet: WALLET,
    pay: { mint: SOL_MINT, symbol: 'SOL', decimals: 9 }, buy: { mint: BAYLA, symbol: 'BAYLA', decimals: 6 },
    total: 4_000_000_000n, startAt: T0, durationS: 4 * 3_600, count: 4, bandBps: 100, profile: null,
  });
  if (!o) throw new Error('no plan');
  return o;
}

/** At the average: 1 SOL buys 200,000 BAYLA. */
const atAverage = (amount: string) => ({ inAmount: amount, outAmount: ((BigInt(amount) * 200_000_000_000n) / 1_000_000_000n).toString() }) as unknown as JupiterQuote;

type WalletPlay = (sign: (tx: VersionedTransaction) => Promise<VersionedTransaction>, onSent: (s: string) => void) => Promise<WalletSwapEnd>;

function world(opts: { wallet?: (env: RunEnv & { t: number }) => Promise<void>; play?: WalletPlay; saveFails?: boolean } = {}) {
  let stored: VwapOrder | null = plan();
  const seen: Array<{ at: string; order: VwapOrder | null }> = [];
  let n = 0;
  const env = {
    t: T0,
    read: () => (stored ? (JSON.parse(JSON.stringify(stored)) as VwapOrder) : null),
    save: (o: VwapOrder) => {
      if (opts.saveFails) return false;
      stored = JSON.parse(JSON.stringify(o)) as VwapOrder;
      return true;
    },
    now: () => env.t,
    sleep: vi.fn(async (ms: number) => { env.t += Math.max(1, ms); }),
    aborted: () => false,
    walletSign: vi.fn(async (tx: VersionedTransaction) => {
      seen.push({ at: 'wallet asked', order: stored });
      await opts.wallet?.(env as never);
      return tx;
    }),
    slice: {
      average: async () => AVG,
      quote: async (amount: string) => atAverage(amount),
      prepare: async (q: JupiterQuote) => ({ status: 'ready' as const, quote: q, swapTransaction: 'B64', siteFeeWaived: false }),
      words: () => 'words',
      send: vi.fn(async (_b64: string, _w: string, sign: (tx: VersionedTransaction) => Promise<VersionedTransaction>, onSent: (s: string) => void): Promise<WalletSwapEnd> => {
        if (opts.play) return opts.play(sign, onSent);
        try {
          await sign({} as VersionedTransaction);
        } catch {
          return { kind: 'not-sent', stage: 'wallet', declined: false, message: 'Your wallet did not sign it. Nothing was sent.' };
        }
        const sig = SIG.slice(0, -1) + 'ABCDEFGH'[n++];
        onSent(sig);
        seen.push({ at: 'first send', order: stored });
        return { kind: 'sent', signature: sig, outcome: 'confirmed' };
      }),
    },
    settle: { holdsNow: () => false, status: vi.fn(async () => 'confirmed' as const), history: async () => null },
    received: vi.fn(async () => 199_000_000_000n),
    onLanded: vi.fn(),
    holdReload: vi.fn(() => () => {}),
  };
  return { env, get stored() { return stored; }, set stored(v: VwapOrder | null) { stored = v; }, seen };
}

describe('sendSlice', () => {
  it('the slice is "sending", with what it pays, before the wallet is asked; its signature is kept before the first send', async () => {
    const w = world();
    await sendSlice(w.env, w.env.read()!, 0, 1_000_000_000n);
    expect(w.seen[0]!.at).toBe('wallet asked');
    expect(w.seen[0]!.order!.slices[0]).toMatchObject({ state: 'sending', paid: '1000000000' });
    expect(w.seen[1]!.at).toBe('first send');
    expect(w.seen[1]!.order!.slices[0]).toMatchObject({ state: 'unconfirmed', got: '200000000000', gotExact: false });
    expect(w.seen[1]!.order!.slices[0]!.sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
    expect(w.stored!.slices[0]).toMatchObject({ state: 'filled', paid: '1000000000', gotExact: true });
    expect(w.env.onLanded).toHaveBeenCalledWith(expect.any(String), expect.anything(), 1_000_000_000n);
    expect(w.env.holdReload).toHaveBeenCalledTimes(1);
  });

  it('Stop pressed while the wallet is open: what it signed is not sent, and the stop stands', async () => {
    const w = world({ wallet: async () => { w.stored = { ...w.stored!, stoppedAt: T0 + 5 }; } });
    await sendSlice(w.env, w.env.read()!, 0, 1_000_000_000n);
    expect(w.seen.some((s) => s.at === 'first send')).toBe(false);
    expect(w.stored!.stoppedAt).toBe(T0 + 5);
    expect(w.stored!.slices[0]).toMatchObject({ state: 'waiting', why: WITHDRAWN_COPY });
    expect(w.stored!.slices[0]!.paid).toBeUndefined();
    expect(w.env.onLanded).not.toHaveBeenCalled();
  });

  it('a signature later than 45 s is not sent, and the slice is asked again at once with a fresh price', async () => {
    const w = world({ wallet: async (env) => { env.t += LATE_SIGN_MS + 1; } });
    await sendSlice(w.env, w.env.read()!, 0, 1_000_000_000n);
    expect(w.seen.some((s) => s.at === 'first send')).toBe(false);
    expect(w.stored!.slices[0]).toMatchObject({ state: 'waiting', why: LATE_COPY });
    expect(w.stored!.slices[0]!.triedAt).toBe(w.env.t - RETRY_MS);
  });

  it('a record the browser will not keep: the wallet is never asked', async () => {
    const w = world({ saveFails: true });
    await sendSlice(w.env, w.env.read()!, 0, 1_000_000_000n);
    expect(w.env.walletSign).not.toHaveBeenCalled();
    expect(w.env.slice.send).not.toHaveBeenCalled();
  });

  it('a no in the wallet skips the slice for its window', async () => {
    const w = world({ play: async () => ({ kind: 'not-sent', stage: 'wallet', declined: true, message: 'no' }) });
    await sendSlice(w.env, w.env.read()!, 0, 1_000_000_000n);
    expect(w.stored!.slices[0]).toMatchObject({ state: 'waiting', declined: true, why: DECLINED_COPY });
  });

  it('sent and not confirmed: it stays out, and the next look settles it instead of sending another', async () => {
    const w = world({
      play: async (_sign, onSent) => {
        onSent(SIG);
        return { kind: 'sent', signature: SIG, outcome: 'unknown' };
      },
    });
    await sendSlice(w.env, w.env.read()!, 0, 1_000_000_000n);
    expect(w.stored!.slices[0]).toMatchObject({ state: 'unconfirmed', sig: SIG, why: UNCONFIRMED_COPY, paid: '1000000000' });
    expect(needsRunner({ ...w.stored!, stoppedAt: T0 })).toBe(true);
  });
});

describe('runOrder', () => {
  it('runs every slice when due, then ends with the whole total paid', async () => {
    const w = world();
    await runOrder(w.env, 'o1');
    expect(w.stored!.slices.map((s) => s.state)).toEqual(['filled', 'filled', 'filled', 'filled']);
    expect(w.stored!.slices.reduce((s, x) => s + BigInt(x.paid!), 0n)).toBe(4_000_000_000n);
    expect(w.env.slice.send).toHaveBeenCalledTimes(4);
    expect(w.env.t).toBeLessThan(T0 + 4 * HOUR);
    expect(needsRunner(w.stored)).toBe(false);
  });

  it('a slice that landed while the page was closed is settled from the chain before anything else goes', async () => {
    const w = world();
    const o = w.env.read()!;
    o.slices[0] = { ...o.slices[0]!, state: 'unconfirmed', sig: SIG, sentAt: T0, paid: '1000000000', got: '1' };
    w.stored = o;
    w.env.t = T0 + 2 * HOUR;
    await runOrder(w.env, 'o1');
    expect(w.env.settle.status).toHaveBeenCalledWith(SIG);
    expect(w.stored!.slices[0]).toMatchObject({ state: 'filled', sig: SIG, paid: '1000000000' });
    // Slice 1's window passed while it was out: missed, and its part went with slice 2.
    expect(w.stored!.slices[1]!.state).toBe('missed');
    expect(w.stored!.slices[2]).toMatchObject({ state: 'filled', paid: '2000000000' });
  });

  it('a different order in the record, or none: the loop stops', async () => {
    const w = world();
    w.stored = null;
    await runOrder(w.env, 'o1');
    expect(w.env.slice.send).not.toHaveBeenCalled();
  });
});
