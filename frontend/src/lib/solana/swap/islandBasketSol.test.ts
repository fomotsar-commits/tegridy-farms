// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { NoRouteError, type JupiterQuote } from '../../jupiter';
import { SOL_BASKET } from '../../islandBasket';
import { NOT_TEST_RUN_COPY } from './jupiterFeeRetry';
import { Keypair, PublicKey, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { BASKET_COPY, PoolNotNamedError, pinnedGetQuote, prepareSolLeg, quotedPool, retryingGetQuote, sendSigned, signatureOf, solLegRoute, stampBlockhash, type SolLegDeps } from './islandBasketSol';
import type { VenuePoolCandidate } from './venuePools';

const SOL = 'So11111111111111111111111111111111111111112';
const brainlet = SOL_BASKET.find((c) => c.symbol === 'BRAINLET')!;

const quote = (out: string, o: { pool?: string; percent?: number; hops?: number; mint?: string } = {}): JupiterQuote => ({
  inputMint: SOL, outputMint: o.mint ?? brainlet.mint, inAmount: '1000', outAmount: out, otherAmountThreshold: out,
  swapMode: 'ExactIn', slippageBps: 100, priceImpactPct: '0',
  routePlan: Array.from({ length: o.hops ?? 1 }, () => ({ percent: o.percent ?? 100, swapInfo: { ammKey: o.pool ?? brainlet.pool.address, label: 'Pump.fun Amm' } })),
});
const own = (out: bigint): VenuePoolCandidate => ({ venue: 'own-pool', outAmount: out, label: 'venue pool', poolAddress: 'OwnPool111' } as VenuePoolCandidate);
/** Our pool takes the coin, its swap held to what Jupiter's transaction was just seen to pay. */
const ownAt = (jupiterOut: bigint) => ({ kind: 'own', pool: 'OwnPool111', aggregator: { kind: 'quoted', out: jupiterOut, when: 'now' } });

describe('quotedPool', () => {
  it('names the pool of a single whole hop, and nothing else', () => {
    expect(quotedPool(quote('1'))).toBe(brainlet.pool.address);
    expect(quotedPool(quote('1', { hops: 2 }))).toBeNull();
    expect(quotedPool(quote('1', { percent: 60 }))).toBeNull();
    expect(quotedPool({ routePlan: [] })).toBeNull();
    expect(quotedPool({ routePlan: [{ percent: 100, swapInfo: {} }] })).toBeNull();
  });

  it('reads a whole hop in basis points: Jupiter’s answer for a V2 quote (percent null, bps 10000)', () => {
    // As Jupiter answered SOL → BRAINLET pinned to its PumpSwap pool, instructionVersion=V2, 2026-10-24.
    const v2 = { routePlan: [{ swapInfo: { ammKey: brainlet.pool.address, label: 'Pump.fun Amm' }, percent: null, bps: 10000 }] };
    expect(quotedPool(v2)).toBe(brainlet.pool.address);
    expect(quotedPool({ routePlan: [{ swapInfo: { ammKey: brainlet.pool.address }, percent: null, bps: 6000 }] })).toBeNull();
    expect(quotedPool({ routePlan: [{ swapInfo: { ammKey: brainlet.pool.address }, percent: null, bps: null }] })).toBeNull();
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

  it('gives the coin to our pool when it pays at least as much, held to Jupiter’s fresh figure, before anything is built on a fee-free pair', async () => {
    const d = deps({ feePair: false, ownPools: async () => [own(10_000n)] });
    await expect(prepareSolLeg(d, base)).resolves.toEqual(ownAt(10_000n));
    expect(d.built).not.toHaveBeenCalled();
  });

  it('compares our pool with what Jupiter’s transaction FROM THIS SITE pays, on a fee pair', async () => {
    // Jupiter's built quote pays 10,000; our pool 10,000 → ours (the tie goes to us).
    await expect(prepareSolLeg(deps({ ownPools: async () => [own(10_000n)] }), base)).resolves.toEqual(ownAt(10_000n));
    await expect(prepareSolLeg(deps({ ownPools: async () => [own(9_999n)] }), base)).resolves.toMatchObject({ kind: 'ready' });
  });

  it('an unread read of our pools changes nothing: what was on screen stands, and an unread one on screen is no pool', async () => {
    const fails = async () => { throw new Error('rpc down'); };
    await expect(prepareSolLeg(deps({ ownPools: fails }), { ...base, shownOwn: [own(20_000n)] })).resolves.toEqual(ownAt(10_000n));
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


describe('stampBlockhash', () => {
  it('puts one blockhash on every transaction of a press, versioned and legacy alike', () => {
    const payer = Keypair.generate().publicKey;
    const v0 = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message());
    const legacy = new Transaction({ feePayer: payer, recentBlockhash: '11111111111111111111111111111111' });
    const fresh = new PublicKey(Keypair.generate().publicKey).toBase58();
    stampBlockhash([v0, legacy], fresh);
    expect(v0.message.recentBlockhash).toBe(fresh);
    expect(legacy.recentBlockhash).toBe(fresh);
  });
});

describe('signatureOf', () => {
  it('reads the fee payer’s signature, and nothing from a transaction that is not signed', () => {
    const payer = Keypair.generate();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer.publicKey, recentBlockhash: '11111111111111111111111111111111', instructions: [] }).compileToV0Message());
    expect(signatureOf(tx)).toBeNull();
    tx.sign([payer]);
    expect(signatureOf(tx)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,90}$/);
  });
});

describe('sendSigned', () => {
  const raw = new Uint8Array([1, 2, 3]);
  const conn = (o: { first?: () => Promise<string>; status?: () => unknown }) => ({
    sendRawTransaction: vi.fn(o.first ?? (async () => 'SIG')),
    getSignatureStatuses: vi.fn(async () => ({ value: [o.status ? o.status() : { err: null, confirmationStatus: 'confirmed', slot: 9 }] })),
  });

  it('sends the signed bytes through the network’s own check first, then watches them to the chain’s answer', async () => {
    const c = conn({});
    await expect(sendSigned(c as never, raw, 'SIG', 5_000)).resolves.toEqual({ kind: 'sent', outcome: 'confirmed' });
    expect(c.sendRawTransaction).toHaveBeenCalledWith(raw, expect.objectContaining({ skipPreflight: false }));
  });

  it('a refusal at the first send never reached the chain: not sent, with why; a blockhash gone is a wallet left open too long', async () => {
    const refused = conn({ first: async () => { throw new Error('Transaction simulation failed: Error processing Instruction 3'); } });
    await expect(sendSigned(refused as never, raw, 'SIG', 5_000)).resolves.toEqual({ kind: 'not-sent', why: BASKET_COPY.refusedFirst });
    expect(refused.getSignatureStatuses).not.toHaveBeenCalled();
    const late = conn({ first: async () => { throw new Error('Transaction simulation failed: Blockhash not found'); } });
    await expect(sendSigned(late as never, raw, 'SIG', 5_000)).resolves.toEqual({ kind: 'not-sent', why: BASKET_COPY.tooSlow });
  });

  it('any other error at the first send may have come after it was passed on: it is watched, never called not sent', async () => {
    const dropped = conn({ first: async () => { throw new Error('fetch failed'); } });
    await expect(sendSigned(dropped as never, raw, 'SIG', 5_000)).resolves.toEqual({ kind: 'sent', outcome: 'confirmed' });
    expect(dropped.getSignatureStatuses).toHaveBeenCalled();
  });
});
