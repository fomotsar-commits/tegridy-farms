// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { JupiterBusyError, PRESS_WAITS_MS, whileJupiterBusy } from './jupiterBusy';
import { buildSwapTransaction, getQuote, NoRouteError, type JupiterQuote } from '../../jupiter';

/**
 * A refusal from Jupiter's keyless tier (our relay's 502, or its own 429) is a wait.
 * getQuote and buildSwapTransaction say which failures are refusals; whileJupiterBusy
 * asks again after each wait, and only for those. Before the fix a refusal anywhere in
 * a press ended it: 3 of 5 SOL -> BAYLA presses, measured against production 2026-10-23.
 */

const SOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const ASK = { inputMint: SOL, outputMint: USDC, amount: '100000000', slippageBps: 50 };
const QUOTE = { inputMint: SOL, outputMint: USDC, inAmount: '100000000', outAmount: '14925000', platformFee: null } as unknown as JupiterQuote;
const busy = () => new JupiterBusyError('Quote unavailable (502)', 502);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('whileJupiterBusy', () => {
  it('a refusal is asked again after each wait, and the answer that comes is returned', async () => {
    const fn = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockResolvedValue('built');
    const waits: number[] = [];
    const call = whileJupiterBusy(fn, [10, 20], async (ms) => { waits.push(ms); });
    await expect(call('a', 1)).resolves.toBe('built');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(fn.mock.calls.every((c) => c[0] === 'a' && c[1] === 1)).toBe(true);
    expect(waits).toEqual([10, 20]);
  });

  it('still refused after the last wait: that refusal ends it', async () => {
    const last = busy();
    const fn = vi.fn().mockRejectedValueOnce(busy()).mockRejectedValueOnce(busy()).mockRejectedValueOnce(last);
    const call = whileJupiterBusy(fn, [10, 20], async () => {});
    await expect(call()).rejects.toBe(last);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['no route', new NoRouteError()],
    ['a failure that is not a refusal', new Error('Quote unavailable (400)')],
    ['a request that never arrived', new TypeError('Failed to fetch')],
  ])('%s is not asked again', async (_name, err) => {
    const fn = vi.fn().mockRejectedValue(err);
    const sleep = vi.fn(async () => {});
    await expect(whileJupiterBusy(fn, [10, 20], sleep)()).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a press waits 2.5 s, then 5 s', () => {
    expect(PRESS_WAITS_MS).toEqual([2_500, 5_000]);
  });
});

describe('getQuote and buildSwapTransaction say which failures are refusals', () => {
  const answer = (status: number) => vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"x"}', { status })));
  const quoteErr = () => getQuote(ASK).then(() => null, (e: unknown) => e);
  const buildErr = () => buildSwapTransaction({ quote: QUOTE, userPublicKey: SOL }).then(() => null, (e: unknown) => e);

  it.each([502, 429])('%i is a refusal, said with its status as before', async (status) => {
    answer(status);
    const q = await quoteErr();
    expect(q).toBeInstanceOf(JupiterBusyError);
    expect((q as JupiterBusyError).status).toBe(status);
    expect((q as Error).message).toBe(`Quote unavailable (${status})`);
    const b = await buildErr();
    expect(b).toBeInstanceOf(JupiterBusyError);
    expect((b as Error).message).toBe(`Could not build swap (${status})`);
  });

  it.each([400, 403, 500, 503])('%i is not a refusal', async (status) => {
    answer(status);
    const q = await quoteErr();
    expect(q).toBeInstanceOf(Error);
    expect(q).not.toBeInstanceOf(JupiterBusyError);
    const b = await buildErr();
    expect(b).toBeInstanceOf(Error);
    expect(b).not.toBeInstanceOf(JupiterBusyError);
  });
});
