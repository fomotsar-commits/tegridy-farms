// The "no site fee" retry is counted (leak audit 2026-11-15, LC-3): each time a fee-free
// Jupiter trade is handed to the wallet, one analytics event, `solana_site_fee_waived`, with
// no properties at all (no coin, amount, route or wallet). Every other outcome counts nothing.
// Runs the real analytics queue with consent granted; in a test it flushes to the console.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JupiterQuote, SwapSimulation } from '../../jupiter';
import type { FeeRetryDeps } from './jupiterFeeRetry';

const SOL = 'So11111111111111111111111111111111111111112';
const BAYLA = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';
const USER = '5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9';
const AMOUNT = '100000000';
const quote = (over: Partial<JupiterQuote> = {}): JupiterQuote => ({
  inputMint: SOL, outputMint: BAYLA, inAmount: AMOUNT, outAmount: '21651030522', otherAmountThreshold: '21542775370',
  swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: '0.001', routePlan: [{ swapInfo: { label: 'Pump.fun Amm' } }],
  platformFee: { amount: '108799148', feeBps: 50 }, ...over,
});
const FEE_QUOTE = quote();
const NO_FEE_QUOTE = quote({ outAmount: '21759829670', otherAmountThreshold: '21651030522', platformFee: null });
const OK: SwapSimulation = { ok: true, reason: null, jupiterIncorrectTokenProgram: false };
const JUP_6014: SwapSimulation = { ok: false, reason: 'custom program error: 0x177e', jupiterIncorrectTokenProgram: true };
const ARGS = { fresh: FEE_QUOTE, shown: FEE_QUOTE, inputMint: SOL, outputMint: BAYLA, amount: AMOUNT, slippageBps: 50, user: USER };

const deps = (simulate: (tx: string) => SwapSimulation, getQuote: () => JupiterQuote = () => NO_FEE_QUOTE): FeeRetryDeps => ({
  getQuote: async () => getQuote(),
  buildSwapTransaction: async (p) => (p.noPlatformFee ? 'TX_NO_FEE' : 'TX_FEE'),
  simulateSwap: async (tx) => simulate(tx),
  swapCarriesPlatformFee: () => true,
});

/** The analytics events flushed while `run` ran, as [name, properties]. */
async function eventsDuring(run: (prepare: typeof import('./jupiterFeeRetry').prepareJupiterSwap) => Promise<unknown>) {
  const { prepareJupiterSwap } = await import('./jupiterFeeRetry');
  await run(prepareJupiterSwap);
  vi.advanceTimersByTime(11_000);
  return (console.log as unknown as ReturnType<typeof vi.fn>).mock.calls
    .filter((c) => c[0] === '[analytics]')
    .map((c) => [c[1], c[2]]);
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.setItem('tegridy_telemetry_consent', 'granted');
  vi.useFakeTimers();
  vi.stubEnv('DEV', true);
  vi.stubEnv('VITE_ANALYTICS_ENDPOINT', '');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('the no-site-fee retry is counted', () => {
  it('a fee-free trade handed to the wallet is one event, with no properties', async () => {
    const events = await eventsDuring(async (prepare) => {
      const r = await prepare(deps((tx) => (tx === 'TX_FEE' ? JUP_6014 : OK)), ARGS);
      expect(r).toMatchObject({ status: 'ready', siteFeeWaived: true });
    });
    expect(events).toEqual([['solana_site_fee_waived', {}]]);
  });

  it('a fee-bearing trade that passes counts nothing', async () => {
    const events = await eventsDuring(async (prepare) => {
      expect(await prepare(deps(() => OK), ARGS)).toMatchObject({ status: 'ready', siteFeeWaived: false });
    });
    expect(events).toEqual([]);
  });

  it('a retry that fails its own test run, or whose price moved, counts nothing: no fee was dropped', async () => {
    const events = await eventsDuring(async (prepare) => {
      expect(await prepare(deps(() => JUP_6014), ARGS)).toMatchObject({ status: 'blocked', retried: true });
      const worse = quote({ outAmount: '1000', otherAmountThreshold: '900', platformFee: null });
      expect(await prepare(deps((tx) => (tx === 'TX_FEE' ? JUP_6014 : OK), () => worse), ARGS)).toMatchObject({ status: 'moved' });
    });
    expect(events).toEqual([]);
  });
});
