import { describe, it, expect, vi } from 'vitest';
import { prepareJupiterSwap, NO_SITE_FEE_ROUTE_COPY, type FeeRetryDeps } from './jupiterFeeRetry';
import type { JupiterQuote, SwapSimulation } from '../../jupiter';

/**
 * THE FEE RETRY: one door, one retry.
 *
 * Live bug 2026-10-03: SOL -> BAYLA with the 0.5% fee on the SOL side reverts in
 * simulation with Jupiter's 6014, so every such buy was blocked. The fix
 * re-quotes the same trade once with no fee. These tests pin what may open that
 * retry (exactly Jupiter's 6014 on a fee-bearing build) and everything that
 * must not (any other failure, a second failure, a worse or different trade).
 *
 * On the code before the fix this file has nothing to import: there was no
 * retry, and a 6014 was just another blocked swap.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const USER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const AMOUNT = '100000000';

function quote(over: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: SOL,
    outputMint: BAYLA,
    inAmount: AMOUNT,
    outAmount: '21651030522',
    otherAmountThreshold: '21542775370',
    swapMode: 'ExactIn',
    slippageBps: 50,
    priceImpactPct: '0.001',
    routePlan: [{ swapInfo: { label: 'Pump.fun Amm' } }],
    platformFee: { amount: '108799148', feeBps: 50 },
    ...over,
  };
}
const FEE_QUOTE = quote();
const NO_FEE_QUOTE = quote({ outAmount: '21759829670', otherAmountThreshold: '21651030522', platformFee: null });

const OK: SwapSimulation = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
const JUP_6014: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };
const SLIPPAGE: SwapSimulation = { ok: false, reason: 'custom program error: 0x1771', jupiterIncorrectTokenProgram: false };

function deps(over: Partial<FeeRetryDeps> = {}) {
  // Every dep is a spy, whether it is the default or the test's own.
  return {
    getQuote: vi.fn<FeeRetryDeps['getQuote']>(over.getQuote ?? (async () => NO_FEE_QUOTE)),
    buildSwapTransaction: vi.fn<FeeRetryDeps['buildSwapTransaction']>(
      over.buildSwapTransaction ?? (async (p) => (p.noPlatformFee ? 'TX_NO_FEE' : 'TX_FEE')),
    ),
    simulateSwap: vi.fn<FeeRetryDeps['simulateSwap']>(over.simulateSwap ?? (async (tx) => (tx === 'TX_FEE' ? JUP_6014 : OK))),
    swapCarriesPlatformFee: vi.fn<FeeRetryDeps['swapCarriesPlatformFee']>(over.swapCarriesPlatformFee ?? (() => true)),
  };
}
const ARGS = {
  fresh: FEE_QUOTE,
  shown: FEE_QUOTE,
  inputMint: SOL,
  outputMint: BAYLA,
  amount: AMOUNT,
  slippageBps: 50,
  user: USER,
  priority: 'high' as const,
};

describe('prepareJupiterSwap: the fee-bearing build is tried first, and usually is the one sent', () => {
  it('a clean first simulation is sent as built, fee and all, with no re-quote', async () => {
    const d = deps({ simulateSwap: vi.fn(async () => OK) });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toEqual({ status: 'ready', quote: FEE_QUOTE, swapTransaction: 'TX_FEE', siteFeeWaived: false });
    expect(d.getQuote).not.toHaveBeenCalled();
    expect(d.buildSwapTransaction).toHaveBeenCalledTimes(1);
    expect(d.buildSwapTransaction.mock.calls[0]![0].noPlatformFee).toBeUndefined();
  });

  it('an unreadable FIRST simulation behaves as it did before the retry existed: no retry, the fee build goes on', async () => {
    const d = deps({ simulateSwap: vi.fn(async () => { throw new Error('Simulation failed (503)'); }) });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toEqual({ status: 'ready', quote: FEE_QUOTE, swapTransaction: 'TX_FEE', siteFeeWaived: false });
    expect(d.getQuote).not.toHaveBeenCalled();
  });
});

describe('prepareJupiterSwap: exactly Jupiter 6014 on a fee-bearing build opens ONE no-fee retry', () => {
  it('re-quotes the same trade with no fee, rebuilds with no fee, simulates again, and only then is ready', async () => {
    const d = deps();
    const r = await prepareJupiterSwap(d, ARGS);

    expect(r).toEqual({ status: 'ready', quote: NO_FEE_QUOTE, swapTransaction: 'TX_NO_FEE', siteFeeWaived: true });
    // The same trade, asked for once, with the fee switched off.
    expect(d.getQuote).toHaveBeenCalledTimes(1);
    expect(d.getQuote).toHaveBeenCalledWith({ inputMint: SOL, outputMint: BAYLA, amount: AMOUNT, slippageBps: 50, noPlatformFee: true });
    // Two builds: the fee one, then the no-fee one from the RE-QUOTED quote.
    expect(d.buildSwapTransaction).toHaveBeenCalledTimes(2);
    expect(d.buildSwapTransaction.mock.calls[1]![0]).toEqual({ quote: NO_FEE_QUOTE, userPublicKey: USER, priorityLevel: 'high', noPlatformFee: true });
    // The SAME simulation ran on the rebuilt transaction before it was offered.
    expect(d.simulateSwap.mock.calls.map((c) => c[0])).toEqual(['TX_FEE', 'TX_NO_FEE']);
  });

  it('the amounts handed back are the re-quoted ones, and they pay the trader more', async () => {
    const r = await prepareJupiterSwap(deps(), ARGS);
    if (r.status !== 'ready') throw new Error('expected ready');
    expect(BigInt(r.quote.outAmount)).toBeGreaterThan(BigInt(FEE_QUOTE.outAmount));
    expect(r.quote.platformFee ?? null).toBeNull();
  });

  it('the copy says it plainly', () => {
    expect(NO_SITE_FEE_ROUTE_COPY).toBe('No site fee on this route: the fee cannot be taken on it yet.');
  });
});

describe('prepareJupiterSwap: nothing else opens the retry', () => {
  it('any other simulation failure stays blocked, with no re-quote and no second build', async () => {
    const d = deps({ simulateSwap: vi.fn(async () => SLIPPAGE) });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toEqual({ status: 'blocked', reason: 'custom program error: 0x1771', retried: false, cause: 'refused' });
    expect(d.getQuote).not.toHaveBeenCalled();
    expect(d.buildSwapTransaction).toHaveBeenCalledTimes(1);
  });

  it('a failure whose TEXT mentions 0x177e but is not Jupiter\'s own 6014 stays blocked', async () => {
    // The decision reads the structured flag, never the reason string: a
    // program can print whatever it likes.
    const lookalike: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: false };
    const d = deps({ simulateSwap: vi.fn(async () => lookalike) });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toMatchObject({ status: 'blocked', cause: 'refused' });
    expect(d.getQuote).not.toHaveBeenCalled();
  });

  it('a 6014 on a build that carried NO fee stays blocked: there is no fee to drop', async () => {
    const d = deps({ swapCarriesPlatformFee: vi.fn(() => false) });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toEqual({ status: 'blocked', reason: 'custom program error: 0x177e', retried: false, cause: 'refused' });
    expect(d.getQuote).not.toHaveBeenCalled();
  });
});

describe('prepareJupiterSwap: a failing retry is blocked, and there is never a second retry', () => {
  it('the retry failing simulation blocks', async () => {
    const d = deps({ simulateSwap: vi.fn(async (tx: string) => (tx === 'TX_FEE' ? JUP_6014 : SLIPPAGE)) });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toEqual({ status: 'blocked', reason: 'custom program error: 0x1771', retried: true, cause: 'refused' });
  });

  it('the retry failing with 6014 AGAIN blocks: one re-quote, two builds, two simulations, then stop', async () => {
    const d = deps({ simulateSwap: vi.fn(async () => JUP_6014) });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toMatchObject({ status: 'blocked', cause: 'refused' });
    expect(d.getQuote).toHaveBeenCalledTimes(1);
    expect(d.buildSwapTransaction).toHaveBeenCalledTimes(2);
    expect(d.simulateSwap).toHaveBeenCalledTimes(2);
  });

  it('a retry whose simulation cannot be read is NOT sent (the first one fails open; this one never does)', async () => {
    const d = deps({
      simulateSwap: vi.fn(async (tx: string) => {
        if (tx === 'TX_FEE') return JUP_6014;
        throw new Error('Simulation failed (503)');
      }),
    });
    const r = await prepareJupiterSwap(d, ARGS);
    // Not a verdict: asking again may still find the trade.
    expect(r).toMatchObject({ status: 'blocked', cause: 'unread' });
  });

  it('a re-quote that cannot be fetched blocks', async () => {
    const d = deps({ getQuote: vi.fn(async () => { throw new Error('Quote unavailable (429)'); }) });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toEqual({ status: 'blocked', reason: 'custom program error: 0x177e', retried: true, cause: 'unread' });
    expect(d.buildSwapTransaction).toHaveBeenCalledTimes(1);
  });

  it('a rebuild that cannot be built blocks', async () => {
    const d = deps({
      buildSwapTransaction: vi.fn(async (p: { noPlatformFee?: boolean }) => {
        if (p.noPlatformFee) throw new Error('Could not build swap (500)');
        return 'TX_FEE';
      }),
    });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toMatchObject({ status: 'blocked', cause: 'unread' });
    expect(d.simulateSwap).toHaveBeenCalledTimes(1);
  });
});

describe('prepareJupiterSwap: the re-quote must be the same trade, fee-free, and not worse', () => {
  const cases: [string, Partial<JupiterQuote>][] = [
    ['a different output mint', { outputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }],
    ['a different input mint', { inputMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }],
    ['a different input amount', { inAmount: '100000001' }],
    ['a different swap mode', { swapMode: 'ExactOut' }],
    ['a different slippage', { slippageBps: 5000 }],
    ['a platform fee still priced in', { platformFee: { amount: '108799148', feeBps: 50 } }],
    ['an unreadable out amount', { outAmount: '1e9' }],
    ['an unreadable minimum', { otherAmountThreshold: '' }],
  ];
  it.each(cases)('%s blocks before anything is rebuilt', async (_name, over) => {
    const d = deps({ getQuote: vi.fn(async () => ({ ...NO_FEE_QUOTE, ...over })) });
    const r = await prepareJupiterSwap(d, ARGS);
    // Jupiter answered, and the answer is not this trade: a verdict, not a gap.
    expect(r).toMatchObject({ status: 'blocked', cause: 'refused' });
    expect(d.buildSwapTransaction).toHaveBeenCalledTimes(1);
  });

  it('a re-quote paying less than the fee-bearing quote beyond the slippage is shown, not sent', async () => {
    // 0.5% slippage on 21,651,030,522 puts the floor at 21,542,775,370.
    const worse = { ...NO_FEE_QUOTE, outAmount: '21542775369' };
    const d = deps({ getQuote: vi.fn(async () => worse) });
    const r = await prepareJupiterSwap(d, ARGS);
    expect(r).toEqual({ status: 'moved', quote: worse });
    expect(d.buildSwapTransaction).toHaveBeenCalledTimes(1);
  });

  it('a re-quote at the floor still goes through (normal movement)', async () => {
    const atFloor = { ...NO_FEE_QUOTE, outAmount: '21542775370' };
    const r = await prepareJupiterSwap(deps({ getQuote: vi.fn(async () => atFloor) }), ARGS);
    expect(r.status).toBe('ready');
  });

  it('the floor is measured from the better of the clicked quote and the fresh one', async () => {
    // The trader clicked a HIGHER quote than the fresh fee-bearing one.
    const shown = quote({ outAmount: '22000000000' });
    const d = deps();
    const r = await prepareJupiterSwap(d, { ...ARGS, shown });
    // floor = 22,000,000,000 * 0.995 = 21,890,000,000 > the re-quote's 21,759,829,670.
    expect(r.status).toBe('moved');
  });

  it('...and from the FRESH quote when that is the better one: a re-quote between the two floors is not sent', async () => {
    // The trader clicked 21,000,000,000 (floor 20,895,000,000); the fresh
    // fee-bearing quote is 21,651,030,522 (floor 21,542,775,370). A no-fee
    // re-quote of 21,200,000,000 clears the clicked floor but pays less than
    // the fee-bearing trade it is replacing: the market moved.
    const shown = quote({ outAmount: '21000000000' });
    const between = { ...NO_FEE_QUOTE, outAmount: '21200000000' };
    const d = deps({ getQuote: vi.fn(async () => between) });
    const r = await prepareJupiterSwap(d, { ...ARGS, shown });
    expect(r).toEqual({ status: 'moved', quote: between });
    expect(d.buildSwapTransaction).toHaveBeenCalledTimes(1);
  });

  // The re-quote echoes the slippage it was asked for, so the "same trade"
  // check passes and the RANGE guard is the line under test. Without it: -1
  // raises the floor (a false 'moved'), 10001 makes it negative (anything is
  // sent), and 0.5 throws out of BigInt().
  it.each([-1, 10_001, 0.5])('a slippage of %s is not a tolerance: blocked, nothing rebuilt', async (slippageBps) => {
    const d = deps({ getQuote: vi.fn(async () => ({ ...NO_FEE_QUOTE, slippageBps })) });
    const r = await prepareJupiterSwap(d, { ...ARGS, slippageBps });
    expect(r).toEqual({ status: 'blocked', reason: 'custom program error: 0x177e', retried: true, cause: 'refused' });
    expect(d.buildSwapTransaction).toHaveBeenCalledTimes(1);
  });
});
