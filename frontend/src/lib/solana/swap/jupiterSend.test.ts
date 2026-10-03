// @vitest-environment node
// (node, not jsdom: web3.js cannot serialize a transaction under jsdom, where
// Buffer and Uint8Array come from different realms.)
import { describe, it, expect, vi } from 'vitest';
import { PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { JUPITER_SEND_COPY, sendJupiterSwap, type JupiterSendDeps, type JupiterSendResult } from './jupiterSend';
import { NO_SITE_FEE_ROUTE_COPY } from './jupiterFeeRetry';
import type { BuildSwapParams, JupiterQuote, QuoteParams, QuoteRead, SwapSimulation } from '../../jupiter';

/**
 * THE JUPITER SEND, END TO END (SPEC_S3 sections 2.1, 5.3 and 5.4).
 *
 * The test this file exists for is the first one: a pre-sign simulation that
 * could not be RUN used to send the swap to the wallet anyway (the page's empty
 * catch, then the fee-retry rule's "unchanged" branch). Here it stops.
 */

const key = () => PublicKey.unique();
const USER = key();
const SOL = key().toBase58();
const TOKEN = key().toBase58();
const AMOUNT = '100000000';
const SIG = '5'.repeat(88);

/** A real, serialized v0 transaction; `tag` makes two of them different bytes. */
function realTx(tag: number): string {
  const message = new TransactionMessage({
    payerKey: USER,
    recentBlockhash: PublicKey.default.toBase58(),
    instructions: [new TransactionInstruction({ programId: key(), keys: [], data: Buffer.from([tag]) })],
  }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
}
const TX_FEE = realTx(1);
const TX_NO_FEE = realTx(2);
const HEIGHT_FEE = 430_000_111;
const HEIGHT_NO_FEE = 430_000_222;

function quote(over: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: SOL,
    outputMint: TOKEN,
    inAmount: AMOUNT,
    outAmount: '21651030522',
    otherAmountThreshold: '21542775370',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.001',
    routePlan: [],
    platformFee: { amount: '108799148', feeBps: 50 },
    ...over,
  };
}
const FEE_QUOTE = quote();
const NO_FEE_QUOTE = quote({ outAmount: '21759829670', otherAmountThreshold: '21651030522', platformFee: null });

const OK: SwapSimulation = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
const JUP_6014: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };
const SLIPPAGE: SwapSimulation = { ok: false, reason: 'custom program error: 0x1771', jupiterIncorrectTokenProgram: false };

type Status = { err: unknown; confirmationStatus?: string | null } | null;

function deps(over: Partial<JupiterSendDeps> = {}) {
  let t = 0;
  return {
    readQuote: vi.fn<JupiterSendDeps['readQuote']>(
      over.readQuote ?? (async (p: QuoteParams): Promise<QuoteRead> =>
        p.noPlatformFee ? { kind: 'quote', quote: NO_FEE_QUOTE, feeBpsSent: null } : { kind: 'quote', quote: FEE_QUOTE, feeBpsSent: 50 }),
    ),
    buildSwapTransaction: vi.fn<JupiterSendDeps['buildSwapTransaction']>(
      over.buildSwapTransaction ?? (async (p: BuildSwapParams) =>
        p.noPlatformFee
          ? { swapTransaction: TX_NO_FEE, lastValidBlockHeight: HEIGHT_NO_FEE }
          : { swapTransaction: TX_FEE, lastValidBlockHeight: HEIGHT_FEE }),
    ),
    simulateSwap: vi.fn<JupiterSendDeps['simulateSwap']>(over.simulateSwap ?? (async () => OK)),
    swapCarriesPlatformFee: vi.fn<JupiterSendDeps['swapCarriesPlatformFee']>(over.swapCarriesPlatformFee ?? (() => true)),
    sendTransaction: vi.fn<JupiterSendDeps['sendTransaction']>(over.sendTransaction ?? (async () => SIG)),
    getSignatureStatuses: vi.fn<JupiterSendDeps['getSignatureStatuses']>(
      over.getSignatureStatuses ?? (async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' } as Status] })),
    ),
    // A clock the test owns: every sleep moves it, nothing really waits.
    sleep: vi.fn(async (ms: number) => { t += ms; }),
    now: () => t,
  };
}

function args(over: Partial<Parameters<typeof sendJupiterSwap>[1]> = {}) {
  return {
    shown: FEE_QUOTE,
    inputMint: SOL,
    outputMint: TOKEN,
    amount: AMOUNT,
    slippageBps: 50,
    user: USER.toBase58(),
    priority: 'high' as const,
    onReady: vi.fn<(sent: JupiterQuote, siteFeeWaived: boolean) => void>(),
    onSent: vi.fn<(signature: string, lastValidBlockHeight: number | null) => void>(),
    ...over,
  };
}

const notSent = (r: JupiterSendResult) => {
  expect(r.status).toBe('not-sent');
  return r as Extract<JupiterSendResult, { status: 'not-sent' }>;
};

describe('FAIL CLOSED: a swap that could not be simulated is never sent to the wallet (J1)', () => {
  it('the simulation throws -> not sent, "simulate-unread"; the wallet is never asked', async () => {
    const d = deps({ simulateSwap: vi.fn(async () => { throw new Error('Simulation failed (503)'); }) });
    const a = args();
    const r = notSent(await sendJupiterSwap(d, a));
    expect(r.reason).toBe('simulate-unread');
    expect(r.message).toBe(JUPITER_SEND_COPY.simulateUnread);
    expect(d.simulateSwap).toHaveBeenCalledTimes(1);
    expect(d.sendTransaction).not.toHaveBeenCalled();
    expect(a.onReady).not.toHaveBeenCalled();
    expect(a.onSent).not.toHaveBeenCalled();
    expect(d.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it('the simulation answers with no result (the RPC returned nothing usable) -> the same', async () => {
    const d = deps({ simulateSwap: vi.fn(async () => { throw new Error('No simulation result'); }) });
    expect(notSent(await sendJupiterSwap(d, args())).reason).toBe('simulate-unread');
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it('the no-fee REBUILD cannot be simulated -> the same, even though the first simulation answered', async () => {
    const d = deps({
      simulateSwap: vi.fn(async (tx: string) => {
        if (tx === TX_FEE) return JUP_6014;
        throw new Error('Simulation failed (429)');
      }),
    });
    expect(notSent(await sendJupiterSwap(d, args())).reason).toBe('simulate-unread');
    expect(d.simulateSwap).toHaveBeenCalledTimes(2);
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it('a simulation that says the swap would fail -> not sent, "simulate-failed", with the chain’s own words', async () => {
    const d = deps({ simulateSwap: vi.fn(async () => SLIPPAGE) });
    const r = notSent(await sendJupiterSwap(d, args()));
    expect(r.reason).toBe('simulate-failed');
    expect(r.message).toContain('custom program error: 0x1771');
    expect(r.message).toContain('not sent to your wallet');
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it('a clean simulation is the only way to the wallet', async () => {
    const d = deps();
    const r = await sendJupiterSwap(d, args());
    expect(r.status).toBe('confirmed');
    expect(d.simulateSwap).toHaveBeenCalledWith(TX_FEE);
    expect(d.sendTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('the fresh quote: unread and no-route are different answers, and both stop', () => {
  it('unread -> not sent, "quote-unread"; nothing is built', async () => {
    const d = deps({ readQuote: vi.fn(async (): Promise<QuoteRead> => ({ kind: 'unread', detail: 'Jupiter did not give a price (HTTP 502)' })) });
    const r = notSent(await sendJupiterSwap(d, args()));
    expect(r.reason).toBe('quote-unread');
    expect(r.message).toBe(JUPITER_SEND_COPY.quoteUnread);
    expect(d.buildSwapTransaction).not.toHaveBeenCalled();
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it('no-route -> not sent, "no-route"; nothing is built', async () => {
    const d = deps({ readQuote: vi.fn(async (): Promise<QuoteRead> => ({ kind: 'no-route' })) });
    const r = notSent(await sendJupiterSwap(d, args()));
    expect(r.reason).toBe('no-route');
    expect(r.message).toBe(JUPITER_SEND_COPY.noRoute);
    expect(d.buildSwapTransaction).not.toHaveBeenCalled();
  });

  it('a quote read that throws is unread, not a crash', async () => {
    const d = deps({ readQuote: vi.fn(async () => { throw new Error('boom'); }) });
    expect(notSent(await sendJupiterSwap(d, args())).reason).toBe('quote-unread');
  });

  it('asks for the same trade the trader clicked', async () => {
    const d = deps();
    await sendJupiterSwap(d, args());
    expect(d.readQuote).toHaveBeenCalledWith({ inputMint: SOL, outputMint: TOKEN, amount: AMOUNT, slippageBps: 50 });
  });
});

describe('display-vs-submit: a fresh quote worse than the one clicked, beyond the slippage, is shown and not sent', () => {
  // shown 1,000,000 at 50 bps: the floor is 995,000.
  const shown = quote({ outAmount: '1000000' });
  const fresh = (outAmount: string) => vi.fn(async (): Promise<QuoteRead> => ({ kind: 'quote', quote: quote({ outAmount }), feeBpsSent: 50 }));

  it('one unit under the floor -> "moved", with the fresh quote; nothing is built', async () => {
    const d = deps({ readQuote: fresh('994999') });
    const r = await sendJupiterSwap(d, args({ shown }));
    expect(r).toEqual({ status: 'moved', why: 'price', fresh: quote({ outAmount: '994999' }), siteFeeWaived: false });
    expect(d.buildSwapTransaction).not.toHaveBeenCalled();
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it('exactly at the floor goes ahead', async () => {
    const d = deps({ readQuote: fresh('995000') });
    expect((await sendJupiterSwap(d, args({ shown }))).status).toBe('confirmed');
  });

  it('a better fresh quote goes ahead, built from the FRESH quote', async () => {
    const d = deps({ readQuote: fresh('1200000') });
    const r = await sendJupiterSwap(d, args({ shown }));
    expect(r).toMatchObject({ status: 'confirmed', fresh: quote({ outAmount: '1200000' }) });
    expect(d.buildSwapTransaction.mock.calls[0]![0].quote.outAmount).toBe('1200000');
  });

  // funds-2 (dark review): the guard used to sit in a try/catch with an empty catch, so a
  // clicked amount or a slippage that could not be turned into a whole number SKIPPED it
  // and the swap went to the wallet on a quote far below what the screen showed.
  it('FAIL CLOSED: a clicked amount that cannot be read is not "nothing moved": not sent, nothing built, the wallet never asked', async () => {
    for (const bad of [undefined, null, '', 'abc', '12.5', '-5', 1_000_000, '9'.repeat(31)]) {
      // The fresh quote pays a thousandth of anything the screen could have shown.
      const d = deps({ readQuote: fresh('1000') });
      const r = await sendJupiterSwap(d, args({ shown: quote({ outAmount: bad as never }) }));
      expect(notSent(r), String(bad)).toMatchObject({ reason: 'quote-unread', message: JUPITER_SEND_COPY.shownUnread });
      expect(d.buildSwapTransaction, String(bad)).not.toHaveBeenCalled();
      expect(d.simulateSwap, String(bad)).not.toHaveBeenCalled();
      expect(d.sendTransaction, String(bad)).not.toHaveBeenCalled();
    }
  });

  it('FAIL CLOSED: a slippage that is not a whole number from 0 to 10,000 stops it too (BigInt(0.5) used to throw into the empty catch)', async () => {
    for (const slippageBps of [0.5, Number.NaN, -1, 10_001, Number.POSITIVE_INFINITY]) {
      const d = deps({ readQuote: fresh('1000') });
      const r = await sendJupiterSwap(d, args({ shown, slippageBps }));
      expect(notSent(r), String(slippageBps)).toMatchObject({ reason: 'quote-unread', message: JUPITER_SEND_COPY.shownUnread });
      expect(d.buildSwapTransaction, String(slippageBps)).not.toHaveBeenCalled();
      expect(d.sendTransaction, String(slippageBps)).not.toHaveBeenCalled();
    }
    // The same holds when the clicked quote is the no-fee one (the amount check is skipped there, the slippage check is not).
    const d = deps();
    expect(notSent(await sendJupiterSwap(d, args({ shown: NO_FEE_QUOTE, shownWaived: true, slippageBps: 0.5 }))).reason).toBe('quote-unread');
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it('FAIL CLOSED: a fresh quote whose amount cannot be read is not compared as zero or as fine', async () => {
    const d = deps({ readQuote: vi.fn(async (): Promise<QuoteRead> => ({ kind: 'quote', quote: quote({ outAmount: undefined as never }), feeBpsSent: 50 })) });
    expect(notSent(await sendJupiterSwap(d, args({ shown }))).reason).toBe('quote-unread');
    expect(d.buildSwapTransaction).not.toHaveBeenCalled();
  });

  it('not run when the clicked quote is the no-fee one: the fee-bearing fresh quote sits on that floor by construction', async () => {
    // shown (no fee) 21,759,829,670, so its floor is 21,651,030,522: exactly the fee-bearing
    // quote. One tick of the market (fresh 21,651,030,000) and the guard would say "moved"
    // when only the fee differs. With `shownWaived` the fee-retry rule compares like with like.
    const lower = quote({ outAmount: '21651030000' });
    const d = deps({
      readQuote: vi.fn(async (p: QuoteParams): Promise<QuoteRead> =>
        p.noPlatformFee ? { kind: 'quote', quote: NO_FEE_QUOTE, feeBpsSent: null } : { kind: 'quote', quote: lower, feeBpsSent: 50 }),
      simulateSwap: vi.fn(async (tx: string) => (tx === TX_FEE ? JUP_6014 : OK)),
    });
    const r = await sendJupiterSwap(d, args({ shown: NO_FEE_QUOTE, shownWaived: true }));
    expect(r).toMatchObject({ status: 'confirmed', siteFeeWaived: true, fresh: NO_FEE_QUOTE });
    const without = deps();
    const r2 = await sendJupiterSwap(without, args({ shown: quote({ outAmount: '21800000000' }) }));
    expect(r2.status).toBe('moved');
  });
});

describe('the fee-retry rule runs unchanged inside it', () => {
  it('Jupiter’s 6014 on the fee-bearing build -> one no-fee rebuild, simulated clean, sent; the result says so', async () => {
    const d = deps({ simulateSwap: vi.fn(async (tx: string) => (tx === TX_FEE ? JUP_6014 : OK)) });
    const a = args();
    const r = await sendJupiterSwap(d, a);
    expect(r).toEqual({ status: 'confirmed', signature: SIG, fresh: NO_FEE_QUOTE, siteFeeWaived: true });
    expect(d.readQuote).toHaveBeenCalledTimes(2);
    expect(d.readQuote.mock.calls[1]![0]).toEqual({ inputMint: SOL, outputMint: TOKEN, amount: AMOUNT, slippageBps: 50, noPlatformFee: true });
    expect(d.simulateSwap.mock.calls.map((c) => c[0])).toEqual([TX_FEE, TX_NO_FEE]);
    // The transaction that went to the wallet is the rebuilt one, and so is its expiry.
    const sentTx = d.sendTransaction.mock.calls[0]![0];
    expect(Buffer.from(sentTx.serialize()).toString('base64')).toBe(TX_NO_FEE);
    expect(a.onSent).toHaveBeenCalledWith(SIG, HEIGHT_NO_FEE);
    expect(a.onReady).toHaveBeenCalledWith(NO_FEE_QUOTE, true);
    expect(NO_SITE_FEE_ROUTE_COPY).toMatch(/No site fee on this route/);
  });

  it('the retry’s re-quote is unread or has no route -> blocked, never sent fee-bearing or unsimulated', async () => {
    for (const second of [{ kind: 'unread', detail: 'HTTP 429' }, { kind: 'no-route' }] as QuoteRead[]) {
      const d = deps({
        readQuote: vi.fn(async (p: QuoteParams): Promise<QuoteRead> => (p.noPlatformFee ? second : { kind: 'quote', quote: FEE_QUOTE, feeBpsSent: 50 })),
        simulateSwap: vi.fn(async () => JUP_6014),
      });
      expect(notSent(await sendJupiterSwap(d, args())).reason).toBe('simulate-failed');
      expect(d.buildSwapTransaction).toHaveBeenCalledTimes(1);
      expect(d.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it('the no-fee re-quote pays less beyond the slippage -> "moved" with that quote, labelled no-fee', async () => {
    const worse = quote({ outAmount: '21000000000', otherAmountThreshold: '20895000000', platformFee: null });
    const d = deps({
      readQuote: vi.fn(async (p: QuoteParams): Promise<QuoteRead> =>
        p.noPlatformFee ? { kind: 'quote', quote: worse, feeBpsSent: null } : { kind: 'quote', quote: FEE_QUOTE, feeBpsSent: 50 }),
      simulateSwap: vi.fn(async () => JUP_6014),
    });
    expect(await sendJupiterSwap(d, args())).toEqual({ status: 'moved', why: 'price', fresh: worse, siteFeeWaived: true });
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it('clicked a no-fee quote, and the fee can be taken again -> "moved: fee-returned", not silently sent for less', async () => {
    const d = deps();
    const r = await sendJupiterSwap(d, args({ shown: NO_FEE_QUOTE, shownWaived: true }));
    expect(r).toEqual({ status: 'moved', why: 'fee-returned', fresh: FEE_QUOTE, siteFeeWaived: false });
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('the build', () => {
  it('a build that throws -> not sent, "build", with its detail; nothing is simulated or sent', async () => {
    const d = deps({ buildSwapTransaction: vi.fn(async () => { throw new Error('Could not build swap (422)'); }) });
    const r = notSent(await sendJupiterSwap(d, args()));
    expect(r.reason).toBe('build');
    expect(r.message).toBe('Jupiter could not build this swap (Could not build swap (422)). Nothing was sent.');
    expect(d.simulateSwap).not.toHaveBeenCalled();
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it('a transaction that does not decode -> not sent, "build"', async () => {
    const d = deps({ buildSwapTransaction: vi.fn(async () => ({ swapTransaction: 'AAAA', lastValidBlockHeight: 1 })) });
    expect(notSent(await sendJupiterSwap(d, args())).reason).toBe('build');
    expect(d.sendTransaction).not.toHaveBeenCalled();
  });

  it('passes the trader, the speed and the fresh quote to the build', async () => {
    const d = deps();
    await sendJupiterSwap(d, args({ priority: 'veryHigh' }));
    expect(d.buildSwapTransaction).toHaveBeenCalledWith({ quote: FEE_QUOTE, userPublicKey: USER.toBase58(), priorityLevel: 'veryHigh' });
  });
});

describe('the wallet', () => {
  it.each([
    ['User rejected the request.'],
    ['Transaction cancelled'],
    ['The user declined to sign'],
    ['Permission denied by user'],
  ])('"%s" -> not sent, "declined"', async (words) => {
    const d = deps({ sendTransaction: vi.fn(async () => { throw new Error(words); }) });
    const a = args();
    const r = notSent(await sendJupiterSwap(d, a));
    expect(r.reason).toBe('declined');
    expect(r.message).toBe(JUPITER_SEND_COPY.declined);
    expect(a.onSent).not.toHaveBeenCalled();
    expect(d.getSignatureStatuses).not.toHaveBeenCalled();
  });

  it('a wallet error by its class name is a decline too', async () => {
    class WalletSignTransactionError extends Error {
      override name = 'WalletSignTransactionError';
    }
    const d = deps({ sendTransaction: vi.fn(async () => { throw new WalletSignTransactionError('x'); }) });
    expect(notSent(await sendJupiterSwap(d, args())).reason).toBe('declined');
  });

  it('any other throw -> "wallet-error": it may have sent, and the message says to check, never "failed"', async () => {
    const d = deps({ sendTransaction: vi.fn(async () => { throw new Error('WalletSendTransactionError: blockhash not found'); }) });
    const a = args();
    const r = await sendJupiterSwap(d, a);
    expect(r.status).toBe('wallet-error');
    if (r.status !== 'wallet-error') return;
    expect(r.message).toContain('blockhash not found');
    expect(r.message).toContain('it may still have sent the swap');
    expect(r.message).not.toMatch(/failed/i);
    expect(a.onSent).not.toHaveBeenCalled();
  });

  it('onReady runs before the wallet is asked, with the quote that is being sent', async () => {
    const order: string[] = [];
    const d = deps({ sendTransaction: vi.fn(async () => { order.push('wallet'); return SIG; }) });
    const a = args({ onReady: vi.fn(() => { order.push('ready'); }) });
    await sendJupiterSwap(d, a);
    expect(order).toEqual(['ready', 'wallet']);
    expect(a.onReady).toHaveBeenCalledWith(FEE_QUOTE, false);
  });

  it('an onReady that throws does not stop a checked swap', async () => {
    const d = deps();
    const r = await sendJupiterSwap(d, args({ onReady: () => { throw new Error('render'); } }));
    expect(r.status).toBe('confirmed');
  });
});

describe('after a signature exists: onSent first, then only honest endings (J2)', () => {
  it('onSent is called once, with the signature and the build’s lastValidBlockHeight, BEFORE any status is read', async () => {
    const order: string[] = [];
    const d = deps({
      getSignatureStatuses: vi.fn(async () => {
        order.push('status');
        return { value: [{ err: null, confirmationStatus: 'confirmed' } as Status] };
      }),
    });
    const a = args({ onSent: vi.fn(() => { order.push('sent'); }) });
    await sendJupiterSwap(d, a);
    expect(a.onSent).toHaveBeenCalledTimes(1);
    expect(a.onSent).toHaveBeenCalledWith(SIG, HEIGHT_FEE);
    expect(order).toEqual(['sent', 'status']);
  });

  it('a build with no height reports null, not 0', async () => {
    const d = deps({ buildSwapTransaction: vi.fn(async () => ({ swapTransaction: TX_FEE, lastValidBlockHeight: null })) });
    const a = args();
    await sendJupiterSwap(d, a);
    expect(a.onSent).toHaveBeenCalledWith(SIG, null);
  });

  it('an onSent that throws does not lose the signature or the ending', async () => {
    const d = deps();
    const r = await sendJupiterSwap(d, args({ onSent: () => { throw new Error('storage full'); } }));
    expect(r).toMatchObject({ status: 'confirmed', signature: SIG });
  });

  it('confirmed without an error -> confirmed', async () => {
    expect(await sendJupiterSwap(deps(), args())).toEqual({ status: 'confirmed', signature: SIG, fresh: FEE_QUOTE, siteFeeWaived: false });
  });

  it('an error at confirmed -> reverted', async () => {
    const d = deps({ getSignatureStatuses: vi.fn(async () => ({ value: [{ err: { InstructionError: [2, { Custom: 6001 }] }, confirmationStatus: 'confirmed' } as Status] })) });
    expect(await sendJupiterSwap(d, args())).toEqual({ status: 'reverted', signature: SIG, fresh: FEE_QUOTE, siteFeeWaived: false });
  });

  it('never seen before the time limit -> unknown, never a throw and never "failed"', async () => {
    const d = deps({ getSignatureStatuses: vi.fn(async () => ({ value: [null as Status] })) });
    const r = await sendJupiterSwap(d, args());
    expect(r).toEqual({ status: 'unknown', signature: SIG, fresh: FEE_QUOTE, siteFeeWaived: false });
    // 90 s at one read every 2 s, on the test's own clock.
    expect(d.getSignatureStatuses).toHaveBeenCalledTimes(45);
  });

  it('status reads that throw the whole time -> unknown', async () => {
    const d = deps({ getSignatureStatuses: vi.fn(async () => { throw new Error('429'); }) });
    expect((await sendJupiterSwap(d, args())).status).toBe('unknown');
  });

  it('an error seen only at processed, then confirmed clean -> confirmed', async () => {
    const answers: Status[] = [{ err: 'x', confirmationStatus: 'processed' }, { err: null, confirmationStatus: 'confirmed' }];
    const d = deps({ getSignatureStatuses: vi.fn(async () => ({ value: [answers.shift() ?? null] })) });
    expect((await sendJupiterSwap(d, args())).status).toBe('confirmed');
  });
});

describe('what the trader is told', () => {
  it('no sentence says "failed" for something that was never sent, and none uses an em dash', () => {
    const all = [
      JUPITER_SEND_COPY.quoteUnread,
      JUPITER_SEND_COPY.shownUnread,
      JUPITER_SEND_COPY.noRoute,
      JUPITER_SEND_COPY.build('x'),
      JUPITER_SEND_COPY.simulateUnread,
      JUPITER_SEND_COPY.simulateFailed('x'),
      JUPITER_SEND_COPY.simulateFailed(null),
      JUPITER_SEND_COPY.declined,
      JUPITER_SEND_COPY.walletError('x'),
    ];
    for (const s of all) {
      expect(s).not.toContain('—');
      expect(s).not.toMatch(/swap failed/i);
    }
    expect(JUPITER_SEND_COPY.simulateFailed(null)).toBe('This swap would fail on chain, so it was not sent to your wallet.');
  });
});
