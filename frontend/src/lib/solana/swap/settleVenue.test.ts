// @vitest-environment node
//
// The Buy press's verdict. Our pool wins a tie and nothing short of one; Jupiter is judged
// by what this site's Jupiter path would deliver now, its one no-fee retry included.
import { describe, expect, it, vi } from 'vitest';
import { NoRouteError, type JupiterQuote, type SwapSimulation } from '../../jupiter';
import { prepareJupiterSwap, type FeeRetryDeps, type PreparedJupiterSwap } from './jupiterFeeRetry';
import { SETTLE_COPY, settleVenue, type SettleDeps } from './settleVenue';

const SOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const AMOUNT = '100000000';
const FEE_OUT = 21_651_030_522n;
const NO_FEE_OUT = 21_759_829_670n;

function quote(over: Partial<JupiterQuote> = {}): JupiterQuote {
  return {
    inputMint: SOL, outputMint: BAYLA, inAmount: AMOUNT, outAmount: String(FEE_OUT), otherAmountThreshold: '21542775370',
    swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.001', routePlan: [], platformFee: { amount: '108799148', feeBps: 50 }, ...over,
  };
}
const FEE_QUOTE = quote();
const NO_FEE_QUOTE = quote({ outAmount: String(NO_FEE_OUT), otherAmountThreshold: '21651030522', platformFee: null });
const ARGS = { inputMint: SOL, outputMint: BAYLA, amount: AMOUNT, slippageBps: 50 };

function deps(over: { getQuote?: SettleDeps['getQuote']; prepareJupiter?: SettleDeps['prepareJupiter'] } = {}) {
  return {
    getQuote: vi.fn<SettleDeps['getQuote']>(over.getQuote ?? (async (p) => (p.noPlatformFee ? NO_FEE_QUOTE : FEE_QUOTE))),
    prepareJupiter: vi.fn<SettleDeps['prepareJupiter']>(over.prepareJupiter ?? (async (q) => ({ status: 'ready', quote: q, swapTransaction: 'TX', siteFeeWaived: false }))),
  };
}

describe('settleVenue: the fresh quote', () => {
  it('Jupiter paying one raw unit more wins once its own path is ready to sign, and that transaction is handed on', async () => {
    const d = deps();
    expect(await settleVenue(d, { ...ARGS, ownOut: FEE_OUT - 1n })).toEqual({
      venue: 'jupiter', fresh: FEE_QUOTE, prepared: { status: 'ready', quote: FEE_QUOTE, swapTransaction: 'TX', siteFeeWaived: false },
    });
    expect(d.prepareJupiter).toHaveBeenCalledTimes(1);
  });

  it('Jupiter quoting more but refused by its own simulation cannot deliver: our pool takes it, with no Jupiter number to meet', async () => {
    const refused: PreparedJupiterSwap = { status: 'blocked', reason: 'custom program error: 0x1771', retried: false, cause: 'refused' };
    expect(await settleVenue(deps({ prepareJupiter: async () => refused }), { ...ARGS, ownOut: FEE_OUT - 1n })).toEqual({ venue: 'own', against: null });
  });

  it('a tie on a quote with no site fee goes to our pool, with the number it met, and asks Jupiter nothing more', async () => {
    const noFee = quote({ platformFee: null });
    const d = deps({ getQuote: async () => noFee });
    expect(await settleVenue(d, { ...ARGS, ownOut: FEE_OUT })).toEqual({ venue: 'own', against: FEE_OUT });
    expect(d.getQuote).toHaveBeenCalledTimes(1);
    expect(d.prepareJupiter).not.toHaveBeenCalled();
  });

  it("only Jupiter's own no-route answer is no route: our pool takes it", async () => {
    const d = deps({ getQuote: async () => { throw new NoRouteError(); } });
    expect(await settleVenue(d, { ...ARGS, ownOut: 1n })).toEqual({ venue: 'own', against: null });
  });

  it('a quote that could not be fetched sends nothing anywhere', async () => {
    const d = deps({ getQuote: async () => { throw new Error('Quote unavailable (502)'); } });
    expect(await settleVenue(d, { ...ARGS, ownOut: FEE_OUT * 2n })).toEqual({ venue: 'unavailable', detail: SETTLE_COPY.quoteUnread });
  });

  it.each<[string, Partial<JupiterQuote>]>([
    ['an unreadable out amount', { outAmount: '1e9' }],
    ['another input amount', { inAmount: '100000001' }],
    ['another output mint', { outputMint: SOL }],
    ['another input mint', { inputMint: BAYLA }],
  ])('%s is not a quote for this trade: nothing is sent', async (_name, over) => {
    const d = deps({ getQuote: async () => quote(over) });
    expect(await settleVenue(d, { ...ARGS, ownOut: FEE_OUT })).toEqual({ venue: 'unavailable', detail: SETTLE_COPY.quoteOdd });
  });
});

describe('settleVenue: our pool beats the fee-bearing quote, so the no-fee retry is asked', () => {
  it('meeting the no-fee quote settles it with nothing built', async () => {
    const d = deps();
    expect(await settleVenue(d, { ...ARGS, ownOut: NO_FEE_OUT })).toEqual({ venue: 'own', against: NO_FEE_OUT });
    expect(d.getQuote).toHaveBeenLastCalledWith({ ...ARGS, noPlatformFee: true });
    expect(d.prepareJupiter).not.toHaveBeenCalled();
  });

  it('short of the no-fee quote, or with no answer for it, the retry rule decides', async () => {
    const short = deps();
    expect(await settleVenue(short, { ...ARGS, ownOut: FEE_OUT })).toEqual({ venue: 'own', against: FEE_OUT });
    expect(short.prepareJupiter).toHaveBeenCalledWith(FEE_QUOTE);
    const down = deps({ getQuote: async (p) => { if (p.noPlatformFee) throw new Error('502'); return FEE_QUOTE; } });
    expect(await settleVenue(down, { ...ARGS, ownOut: NO_FEE_OUT })).toEqual({ venue: 'own', against: FEE_OUT });
    expect(down.prepareJupiter).toHaveBeenCalledTimes(1);
    // A no-fee answer for another amount is no answer.
    const odd = deps({ getQuote: async (p) => (p.noPlatformFee ? quote({ inAmount: '1', outAmount: '1', platformFee: null }) : FEE_QUOTE) });
    await settleVenue(odd, { ...ARGS, ownOut: FEE_OUT });
    expect(odd.prepareJupiter).toHaveBeenCalledTimes(1);
  });

  it('a no-fee retry ready to sign that pays more wins, and its transaction is handed on', async () => {
    const ready: PreparedJupiterSwap = { status: 'ready', quote: NO_FEE_QUOTE, swapTransaction: 'TX_NO_FEE', siteFeeWaived: true };
    const d = deps({ prepareJupiter: async () => ready });
    expect(await settleVenue(d, { ...ARGS, ownOut: NO_FEE_OUT - 1n })).toEqual({ venue: 'jupiter', fresh: FEE_QUOTE, prepared: ready });
    // A tie with the retry is ours.
    expect(await settleVenue(d, { ...ARGS, ownOut: NO_FEE_OUT })).toEqual({ venue: 'own', against: NO_FEE_OUT });
  });

  it('Jupiter refused (a simulation said no): it can deliver nothing, so our pool takes it with no number to meet', async () => {
    const p: PreparedJupiterSwap = { status: 'blocked', reason: 'x', retried: true, cause: 'refused' };
    expect(await settleVenue(deps({ prepareJupiter: async () => p }), { ...ARGS, ownOut: FEE_OUT })).toEqual({ venue: 'own', against: null });
  });

  it('a retry that moved: our pool takes it when it meets the moved quote, and nothing is sent when it does not', async () => {
    const moved = quote({ outAmount: '14900000', platformFee: null });
    const p: PreparedJupiterSwap = { status: 'moved', quote: moved };
    expect(await settleVenue(deps({ prepareJupiter: async () => p }), { ...ARGS, ownOut: 14_900_000n })).toEqual({ venue: 'own', against: 14_900_000n });
    expect(await settleVenue(deps({ prepareJupiter: async () => p }), { ...ARGS, ownOut: 14_899_999n })).toEqual({ venue: 'unavailable', detail: SETTLE_COPY.moved });
  });

  it('a retry that could not be read, or a build that threw, sends nothing anywhere', async () => {
    const unread: PreparedJupiterSwap = { status: 'blocked', reason: 'x', retried: true, cause: 'unread' };
    expect(await settleVenue(deps({ prepareJupiter: async () => unread }), { ...ARGS, ownOut: FEE_OUT })).toEqual({ venue: 'unavailable', detail: SETTLE_COPY.buildUnread });
    const threw = deps({ prepareJupiter: async () => { throw new Error('Could not build swap (500)'); } });
    expect(await settleVenue(threw, { ...ARGS, ownOut: FEE_OUT })).toEqual({ venue: 'unavailable', detail: SETTLE_COPY.buildUnread });
  });

  // The live case (2026-10-03): BAYLA bought with SOL fails Jupiter's simulation with 6014 while
  // the site fee rides it, and the no-fee route is what Jupiter would really deliver here.
  it('through the real retry rule: a 6014 sends the no-fee route against our pool, which wins only by meeting it', async () => {
    const JUP_6014: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };
    const OK: SwapSimulation = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
    const retryDeps: FeeRetryDeps = {
      getQuote: vi.fn(async () => NO_FEE_QUOTE),
      buildSwapTransaction: vi.fn(async (p: { noPlatformFee?: boolean }) => (p.noPlatformFee ? 'TX_NO_FEE' : 'TX_FEE')),
      simulateSwap: vi.fn(async (tx: string) => (tx === 'TX_FEE' ? JUP_6014 : OK)),
      swapCarriesPlatformFee: () => true,
    };
    const real = (fresh: JupiterQuote) => prepareJupiterSwap(retryDeps, { fresh, shown: fresh, ...ARGS, user: '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9' });
    const between = await settleVenue(deps({ prepareJupiter: real }), { ...ARGS, ownOut: FEE_OUT + 1n });
    expect(between).toMatchObject({ venue: 'jupiter', prepared: { status: 'ready', siteFeeWaived: true, swapTransaction: 'TX_NO_FEE' } });
    expect(await settleVenue(deps({ prepareJupiter: real }), { ...ARGS, ownOut: NO_FEE_OUT })).toEqual({ venue: 'own', against: NO_FEE_OUT });
  });
});
