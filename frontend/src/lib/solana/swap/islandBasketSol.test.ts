// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { NoRouteError, type JupiterQuote } from '../../jupiter';
import { SOL_BASKET } from '../../islandBasket';
import { NOT_TEST_RUN_COPY } from './jupiterFeeRetry';
import { BASKET_COPY, PoolNotNamedError, pinnedGetQuote, prepareSolLeg, quotedPool, retryingGetQuote, solLegRoute, type SolLegDeps } from './islandBasketSol';
import type { VenuePoolCandidate } from './venuePools';

const SOL = 'So11111111111111111111111111111111111111112';
const brainlet = SOL_BASKET.find((c) => c.symbol === 'BRAINLET')!;

const quote = (out: string, o: { pool?: string; percent?: number; hops?: number; mint?: string } = {}): JupiterQuote => ({
  inputMint: SOL, outputMint: o.mint ?? brainlet.mint, inAmount: '1000', outAmount: out, otherAmountThreshold: out,
  swapMode: 'ExactIn', slippageBps: 100, priceImpactPct: '0',
  routePlan: Array.from({ length: o.hops ?? 1 }, () => ({ percent: o.percent ?? 100, swapInfo: { ammKey: o.pool ?? brainlet.pool.address, label: 'Pump.fun Amm' } })),
});
const own = (out: bigint): VenuePoolCandidate => ({ venue: 'own-pool', outAmount: out, label: 'venue pool', poolAddress: 'OwnPool111' } as VenuePoolCandidate);

describe('quotedPool', () => {
  it('names the pool of a single whole hop, and nothing else', () => {
    expect(quotedPool(quote('1'))).toBe(brainlet.pool.address);
    expect(quotedPool(quote('1', { hops: 2 }))).toBeNull();
    expect(quotedPool(quote('1', { percent: 60 }))).toBeNull();
    expect(quotedPool({ routePlan: [] })).toBeNull();
    expect(quotedPool({ routePlan: [{ percent: 100, swapInfo: {} }] })).toBeNull();
  });
});

describe('pinnedGetQuote', () => {
  it('asks Jupiter for one hop on the pool’s DEX, and passes an answer through that pool', async () => {
    const get = vi.fn(async () => quote('500'));
    const q = await pinnedGetQuote(get, brainlet)({ inputMint: SOL, outputMint: brainlet.mint, amount: '1000', slippageBps: 100 });
    expect(q.outAmount).toBe('500');
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ pin: { dex: 'Pump.fun Amm' } }));
  });

  it('refuses an answer through any other pool, a split route, or another coin: a migrated pool is never taken', async () => {
    for (const bad of [quote('500', { pool: 'OldMigratedPool1111' }), quote('500', { hops: 2 }), quote('500', { mint: 'OtherMint111' })]) {
      await expect(pinnedGetQuote(async () => bad, brainlet)({ inputMint: SOL, outputMint: brainlet.mint, amount: '1000', slippageBps: 100 })).rejects.toBeInstanceOf(PoolNotNamedError);
    }
  });
});

describe('solLegRoute', () => {
  it('our pool on a tie or better, Jupiter when it pays more, none when nothing quoted', () => {
    expect(solLegRoute(500n, [own(500n)])).toBe('own');
    expect(solLegRoute(500n, [own(499n)])).toBe('jupiter');
    expect(solLegRoute(null, [own(1n)])).toBe('own');
    expect(solLegRoute(500n, [])).toBe('jupiter');
    expect(solLegRoute(null, [])).toBe('none');
  });
});

describe('prepareSolLeg', () => {
  const base = { coin: brainlet, inputMint: SOL, amountIn: 1_000n, shown: quote('10000'), shownOwn: [] as VenuePoolCandidate[], slippageBps: 100, user: 'User1111' };
  const deps = (o: Partial<SolLegDeps> & { fresh?: JupiterQuote; feePair?: boolean; sim?: { ok: boolean } } = {}): SolLegDeps & { built: ReturnType<typeof vi.fn> } => {
    const built = vi.fn(async () => 'TX_B64');
    return {
      getQuote: o.getQuote ?? (async () => o.fresh ?? quote('10000')),
      buildSwapTransaction: built,
      simulateSwap: o.simulateSwap ?? (async () => ({ ok: true, ...(o.sim ?? {}) }) as never),
      swapCarriesPlatformFee: () => o.feePair ?? true,
      ownPools: o.ownPools ?? (async () => []),
      built,
    };
  };

  it('builds and test-runs Jupiter’s transaction for the price shown', async () => {
    const d = deps();
    await expect(prepareSolLeg(d, base)).resolves.toEqual({ kind: 'ready', quote: quote('10000'), swapTransaction: 'TX_B64', siteFeeWaived: false });
  });

  it('sends nothing when the price fell past slippage since it was shown: nothing is built', async () => {
    const d = deps({ fresh: quote('9899') });
    await expect(prepareSolLeg(d, base)).resolves.toEqual({ kind: 'not-sent', why: BASKET_COPY.moved });
    expect(d.built).not.toHaveBeenCalled();
    // At the floor exactly it goes.
    await expect(prepareSolLeg(deps({ fresh: quote('9900') }), base)).resolves.toMatchObject({ kind: 'ready' });
  });

  it('hands the coin to our pool’s review when our pool pays at least as much, before anything is built on a fee-free pair', async () => {
    const d = deps({ feePair: false, ownPools: async () => [own(10_000n)] });
    await expect(prepareSolLeg(d, base)).resolves.toEqual({ kind: 'own' });
    expect(d.built).not.toHaveBeenCalled();
  });

  it('compares our pool with what Jupiter’s transaction FROM THIS SITE pays, on a fee pair', async () => {
    // Jupiter's built quote pays 10,000; our pool 10,000 → ours (the tie goes to us).
    await expect(prepareSolLeg(deps({ ownPools: async () => [own(10_000n)] }), base)).resolves.toEqual({ kind: 'own' });
    await expect(prepareSolLeg(deps({ ownPools: async () => [own(9_999n)] }), base)).resolves.toMatchObject({ kind: 'ready' });
  });

  it('an unread read of our pools changes nothing: what was on screen stands, and an unread one on screen is no pool', async () => {
    const fails = async () => { throw new Error('rpc down'); };
    await expect(prepareSolLeg(deps({ ownPools: fails }), { ...base, shownOwn: [own(20_000n)] })).resolves.toEqual({ kind: 'own' });
    await expect(prepareSolLeg(deps({ ownPools: async () => null }), { ...base, shownOwn: null })).resolves.toMatchObject({ kind: 'ready' });
  });

  it('says why nothing was sent: another pool, no route, a refused or unchecked test run', async () => {
    await expect(prepareSolLeg(deps({ getQuote: async () => { throw new PoolNotNamedError(); } }), base)).resolves.toEqual({ kind: 'not-sent', why: BASKET_COPY.poolNotNamed });
    await expect(prepareSolLeg(deps({ getQuote: async () => { throw new NoRouteError(); } }), base)).resolves.toEqual({ kind: 'not-sent', why: BASKET_COPY.noRoute });
    const refused = await prepareSolLeg(deps({ simulateSwap: async () => ({ ok: false, reason: null, jupiterIncorrectTokenProgram: false }) as never }), base);
    expect(refused.kind).toBe('not-sent');
    expect((refused as { why: string }).why).toMatch(/failed its test run/);
    await expect(prepareSolLeg(deps({ simulateSwap: async () => { throw new Error('rpc down'); } }), base)).resolves.toEqual({ kind: 'not-sent', why: NOT_TEST_RUN_COPY });
  });
});

describe('retryingGetQuote', () => {
  const ask = { inputMint: SOL, outputMint: brainlet.mint, amount: '1000', slippageBps: 100 };
  it('asks once more after a wait when a quote is refused (a rate limit), and returns that answer', async () => {
    const get = vi.fn().mockRejectedValueOnce(new Error('Quote unavailable (429)')).mockResolvedValueOnce(quote('7'));
    const slept: number[] = [];
    await expect(retryingGetQuote(get, [2_500], async (ms) => { slept.push(ms); })(ask)).resolves.toMatchObject({ outAmount: '7' });
    expect(get).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([2_500]);
  });

  it('does not ask again on Jupiter’s own "no route", and gives up after the last wait', async () => {
    const none = vi.fn().mockRejectedValue(new NoRouteError());
    await expect(retryingGetQuote(none, [0, 0, 0], async () => {})(ask)).rejects.toBeInstanceOf(NoRouteError);
    expect(none).toHaveBeenCalledTimes(1);
    const down = vi.fn().mockRejectedValue(new Error('Quote unavailable (502)'));
    const slept: number[] = [];
    await expect(retryingGetQuote(down, [2_500, 5_000, 10_000], async (ms) => { slept.push(ms); })(ask)).rejects.toThrow('502');
    expect(down).toHaveBeenCalledTimes(4);
    expect(slept).toEqual([2_500, 5_000, 10_000]);
  });
});

