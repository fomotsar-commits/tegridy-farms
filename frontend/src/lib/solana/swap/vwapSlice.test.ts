// One VWAP slice: the checks run in order and the wallet is asked only after every one
// passed; a slice that is out is called "did not land" only on proof, never on a read that
// did not answer (that would send it again and pay twice).
import { describe, it, expect, vi } from 'vitest';
import { SOL_MINT } from '../../solana';
import type { JupiterQuote } from '../../jupiter';
import type { PreparedJupiterSwap } from './jupiterFeeRetry';
import type { PairAverage } from './pairAverage';
import type { WalletSwapEnd } from './walletSwapSend';
import { UNLANDED_AFTER_MS } from './vwapOrder';
import { SLICE_NO_FEE_ROUTE, settleSlice, trySlice, type SettleDeps, type SliceDeps } from './vwapSlice';

const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const SIG = '5LJAXrtqJJXfsfDQvWPkvfD1xQF6E3RR21RPt1R6YwaCmk65QtTaahhebRYr4qaxQ4DmpWLwVvcDdWfyBd6ugQrw';
const ORDER = { pay: { mint: SOL_MINT, symbol: 'SOL', decimals: 9 }, buy: { mint: BAYLA, symbol: 'BAYLA', decimals: 6 }, bandBps: 100 };
const AVG: PairAverage = { kind: 'ok', baseMint: BAYLA, quoteMint: SOL_MINT, price: 0.000005 };
const ONE_SOL = 1_000_000_000n;
// 1 SOL at the average buys 200,000 BAYLA; 190,000 is 5.26% above it.
const AT_AVERAGE = '200000000000';
const PAST_LIMIT = '190000000000';

// 1 SOL for a guaranteed 197,000 BAYLA is 1.52% above the average: past a 1% limit.
const MIN_PAST_LIMIT = '197000000000';

const quote = (out: string, min: string = out) => ({ outAmount: out, otherAmountThreshold: min, inAmount: ONE_SOL.toString() }) as unknown as JupiterQuote;

function deps(over: Partial<SliceDeps> = {}) {
  const send = vi.fn(async (_b64: string, _w: string, onSent: (s: string) => void): Promise<WalletSwapEnd> => {
    onSent(SIG);
    return { kind: 'sent', signature: SIG, outcome: 'confirmed' };
  });
  const d: SliceDeps & { send: typeof send } = {
    average: vi.fn(async () => AVG),
    quote: vi.fn(async () => quote(AT_AVERAGE)),
    prepare: vi.fn(async (q: JupiterQuote): Promise<PreparedJupiterSwap> => ({ status: 'ready', quote: q, swapTransaction: 'B64', siteFeeWaived: false })),
    words: (paid, out) => `≈${out} BAYLA with ${paid} SOL`,
    send,
    ...over,
  } as SliceDeps & { send: typeof send };
  return d;
}

describe('trySlice', () => {
  it('within the limit: built, test-run, then the wallet; the signature is handed on as soon as it exists', async () => {
    const d = deps();
    const onSent = vi.fn();
    const r = await trySlice(d, ORDER, ONE_SOL, onSent);
    expect(r).toMatchObject({ kind: 'sent', signature: SIG, outcome: 'confirmed', quotedOut: AT_AVERAGE });
    expect(d.prepare).toHaveBeenCalledWith(expect.anything(), ONE_SOL.toString());
    expect(d.send).toHaveBeenCalledWith('B64', `≈${AT_AVERAGE} BAYLA with ${ONE_SOL} SOL`, expect.any(Function));
    expect(onSent).toHaveBeenCalledWith(SIG, AT_AVERAGE);
  });

  it('no average: waits, and Jupiter is not even asked', async () => {
    for (const avg of [{ kind: 'unread' }, { kind: 'thin' }, { kind: 'none' }] as PairAverage[]) {
      const d = deps({ average: async () => avg });
      const r = await trySlice(d, ORDER, ONE_SOL, vi.fn());
      expect(r.kind).toBe('wait');
      expect(d.quote).not.toHaveBeenCalled();
      expect(d.send).not.toHaveBeenCalled();
    }
    const thrown = deps({ average: async () => { throw new Error('429'); } });
    expect((await trySlice(thrown, ORDER, ONE_SOL, vi.fn())).kind).toBe('wait');
  });

  it('a quote past the limit: waits with the figure, nothing is built or signed', async () => {
    const d = deps({ quote: vi.fn(async () => quote(PAST_LIMIT)) });
    const r = await trySlice(d, ORDER, ONE_SOL, vi.fn());
    expect(r).toMatchObject({ kind: 'wait' });
    expect(r.kind === 'wait' && r.why).toContain('5.26% above the 24h average');
    expect(d.prepare).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
  });

  it('the quote the transaction was built from is held to the limit too', async () => {
    const d = deps({ prepare: vi.fn(async (): Promise<PreparedJupiterSwap> => ({ status: 'ready', quote: quote(PAST_LIMIT), swapTransaction: 'B64', siteFeeWaived: false })) });
    expect((await trySlice(d, ORDER, ONE_SOL, vi.fn())).kind).toBe('wait');
    expect(d.send).not.toHaveBeenCalled();
  });

  it('a transaction rebuilt without the platform fee is never a slice: it waits, the wallet is not asked', async () => {
    const d = deps({ prepare: vi.fn(async (q: JupiterQuote): Promise<PreparedJupiterSwap> => ({ status: 'ready', quote: q, swapTransaction: 'B64', siteFeeWaived: true })) });
    const r = await trySlice(d, ORDER, ONE_SOL, vi.fn());
    expect(r).toMatchObject({ kind: 'wait', why: SLICE_NO_FEE_ROUTE });
    expect(d.send).not.toHaveBeenCalled();
  });

  it('the limit holds at the least the slice can receive, not only at the quoted amount', async () => {
    const quoted = deps({ quote: vi.fn(async () => quote(AT_AVERAGE, MIN_PAST_LIMIT)) });
    const r = await trySlice(quoted, ORDER, ONE_SOL, vi.fn());
    expect(r.kind === 'wait' && r.why).toContain('1.52% above the 24h average');
    expect(quoted.prepare).not.toHaveBeenCalled();
    const built = deps({ prepare: vi.fn(async (): Promise<PreparedJupiterSwap> => ({ status: 'ready', quote: quote(AT_AVERAGE, MIN_PAST_LIMIT), swapTransaction: 'B64', siteFeeWaived: false })) });
    expect((await trySlice(built, ORDER, ONE_SOL, vi.fn())).kind).toBe('wait');
    expect(built.send).not.toHaveBeenCalled();
    // A quote that names no least amount is not a price.
    const none = deps({ quote: vi.fn(async () => ({ outAmount: AT_AVERAGE, inAmount: '1' }) as unknown as JupiterQuote) });
    expect((await trySlice(none, ORDER, ONE_SOL, vi.fn())).kind).toBe('wait');
    expect(none.prepare).not.toHaveBeenCalled();
  });

  it('a refused or unrun test run, a moved price, or a build that threw: waits, the wallet is not asked', async () => {
    const ends: Array<() => Promise<PreparedJupiterSwap>> = [
      async () => ({ status: 'blocked', reason: 'custom program error: 0x1771', retried: false }),
      async () => ({ status: 'blocked', reason: null, retried: false, unchecked: true }),
      async () => ({ status: 'moved', quote: quote(AT_AVERAGE) }),
      async () => { throw new Error('busy'); },
    ];
    for (const prepare of ends) {
      const d = deps({ prepare: vi.fn(prepare) });
      expect((await trySlice(d, ORDER, ONE_SOL, vi.fn())).kind).toBe('wait');
      expect(d.send).not.toHaveBeenCalled();
    }
  });

  it('a quote that could not be read, or that has no amount: waits', async () => {
    expect((await trySlice(deps({ quote: async () => { throw new Error('x'); } }), ORDER, ONE_SOL, vi.fn())).kind).toBe('wait');
    expect((await trySlice(deps({ quote: async () => quote('') }), ORDER, ONE_SOL, vi.fn())).kind).toBe('wait');
  });

  it('the wallet said no: not sent, said as a no', async () => {
    const d = deps({ send: vi.fn(async (): Promise<WalletSwapEnd> => ({ kind: 'not-sent', stage: 'wallet', declined: true, message: 'You said no.' })) });
    expect(await trySlice(d, ORDER, ONE_SOL, vi.fn())).toMatchObject({ kind: 'not-sent', declined: true, why: 'You said no.' });
  });
});

describe('settleSlice', () => {
  const NOW = 1_800_000_000_000;
  function settle(over: Partial<SettleDeps> = {}) {
    return {
      holdsNow: vi.fn(() => false),
      status: vi.fn(async (): Promise<'confirmed' | 'reverted' | null> => null),
      history: vi.fn(async (): Promise<'confirmed' | 'reverted' | null> => null),
      blockhashDead: vi.fn(async () => true),
      ...over,
    };
  }
  const HASH = 'GfVcyD4kkTrj4bKc7WA9sZCin9JDbdT4Zkd3EittNR1W';
  const out = (sentAgo: number) => ({ state: 'unconfirmed' as const, sig: SIG, sentAt: NOW - sentAgo, blockhash: HASH });

  it('a slice with no signature never left the page: free once no note holds the wallet', async () => {
    expect(await settleSlice(settle({ holdsNow: () => true }), { state: 'sending' }, NOW)).toEqual({ kind: 'open' });
    expect((await settleSlice(settle(), { state: 'sending' }, NOW)).kind).toBe('free');
  });

  it('landed, or refused on chain, as the chain says', async () => {
    expect(await settleSlice(settle({ status: async () => 'confirmed' }), out(1_000), NOW)).toEqual({ kind: 'landed' });
    expect((await settleSlice(settle({ status: async () => 'reverted' }), out(1_000), NOW)).kind).toBe('free');
  });

  it('no status yet: still out while it is young or a note holds it, and the history is not even read', async () => {
    const young = settle();
    expect(await settleSlice(young, out(UNLANDED_AFTER_MS - 1), NOW)).toEqual({ kind: 'open' });
    const held = settle({ holdsNow: () => true });
    expect(await settleSlice(held, out(UNLANDED_AFTER_MS + 1), NOW)).toEqual({ kind: 'open' });
    expect(young.history).not.toHaveBeenCalled();
    expect(held.history).not.toHaveBeenCalled();
  });

  it('old, held by nothing, and no history either: it did not land', async () => {
    expect(await settleSlice(settle(), out(UNLANDED_AFTER_MS), NOW)).toMatchObject({ kind: 'free', why: 'This slice never reached the chain. Nothing was spent.' });
  });

  it('old and unseen, but its blockhash can still land, is unknown, or was never kept: still out', async () => {
    const live = settle({ blockhashDead: vi.fn(async () => false) });
    expect(await settleSlice(live, out(UNLANDED_AFTER_MS * 3), NOW)).toEqual({ kind: 'open' });
    expect(live.blockhashDead).toHaveBeenCalledWith(HASH);
    expect(await settleSlice(settle({ blockhashDead: async () => { throw new Error('x'); } }), out(UNLANDED_AFTER_MS * 3), NOW)).toEqual({ kind: 'open' });
    expect(await settleSlice(settle(), { state: 'unconfirmed', sig: SIG, sentAt: NOW - UNLANDED_AFTER_MS * 3 }, NOW)).toEqual({ kind: 'open' });
  });

  it('the history holds it after all: landed', async () => {
    expect(await settleSlice(settle({ history: async () => 'confirmed' }), out(UNLANDED_AFTER_MS), NOW)).toEqual({ kind: 'landed' });
  });

  it('a read that did not answer is never "did not land"', async () => {
    expect(await settleSlice(settle({ status: async () => { throw new Error('x'); } }), out(UNLANDED_AFTER_MS * 3), NOW)).toEqual({ kind: 'open' });
    expect(await settleSlice(settle({ history: async () => { throw new Error('x'); } }), out(UNLANDED_AFTER_MS * 3), NOW)).toEqual({ kind: 'open' });
  });
});
