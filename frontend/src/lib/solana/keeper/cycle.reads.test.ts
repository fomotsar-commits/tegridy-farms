// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { buildPool, key, viewOf } from '../lp/testkit.fixture';
import type { PoolView } from '../lp/poolFinder';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import type { JupiterApi } from './jupiterApi';

/**
 * The keeper's wallet read for a trip through our own pools: one RPC call, on a public RPC that
 * answers 429 when pressed. The pools' reserves alone say whether any size pays, so the wallet
 * is read only for a pair or loop that pays at some size. Pools priced by the program's maths.
 */

const NOW = 10_000_000n;
const SOL = 10n ** 9n;
const USDC = 10n ** 6n;

let pools: PoolView[] = [];
vi.mock('../lp/poolList', async (orig) => ({
  ...(await orig<typeof import('../lp/poolList')>()),
  listPools: vi.fn(async () => ({ kind: 'ok', list: { pools, chainNow: NOW } })),
  readMarketPrices: vi.fn(async () => ({ kind: 'ok', usd: new Map([[SOL_QUOTE.mint, 200], [USDC_QUOTE.mint, 1]]) })),
  arbitrage: vi.fn(() => null),
  rowTokenFee: vi.fn(() => null),
}));
vi.mock('../lp/tokenSafety', async (orig) => ({ ...(await orig<typeof import('../lp/tokenSafety')>()), readTokenSafety: vi.fn(async () => new Map()) }));
vi.mock('./plan', async (orig) => ({ ...(await orig<typeof import('./plan')>()), poolProblem: vi.fn(() => null) }));
vi.mock('./rule', async (orig) => ({ ...(await orig<typeof import('./rule')>()), tokenGate: vi.fn(() => null) }));

const { runCycle, DEFAULT_SETTINGS } = await import('./cycle');
const { DEFAULT_LIMITS } = await import('./plan');

const settings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, minProfitUsd: 0.01, allowRaydium: true, raydiumPrograms: [], outsidePools: [] };

function pool(mint: PublicKey, quote: typeof SOL_QUOTE, quoteReserve: bigint, tokenReserve: bigint): PoolView {
  return viewOf(buildPool({ mint, address: key(), quote, quoteReserve, tokenReserve }), { sol: quoteReserve, tok: tokenReserve });
}

/** A pass over `list` on a chain where the keeper holds nothing: every wallet read it makes. */
async function pass(list: PoolView[]) {
  pools = list;
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    if (method !== 'getMultipleAccounts') throw new Error(`unexpected ${method}`);
    return { value: (params[0] as string[]).map(() => null) };
  });
  const log = vi.fn();
  const r = await runCycle({ rpc, jupiter: {} as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log }, settings);
  return { r, reads: rpc.mock.calls.length, lines: log.mock.calls.map((c) => String(c[0])) };
}

const token = key();
const usdcSol = pool(new PublicKey(USDC_QUOTE.mint), SOL_QUOTE, 50n * SOL, 10_000n * USDC);
const tokenSol = pool(token, SOL_QUOTE, 50n * SOL, 10n ** 9n);

describe('runCycle: the wallet read for trips through our own pools', () => {
  // KWIF's two SOL pools and TBB's loop on 2026-11-06: a wide gap into a pool holding dust.
  it('reads nothing when the gap is into a pool too empty for any size to pay', async () => {
    const kwif = key();
    const kwifMain = pool(kwif, SOL_QUOTE, 135_957_677n, 66_327_358_089n);
    const kwifDust = pool(kwif, SOL_QUOTE, 5n, 2_138n);
    const tokenUsdcDust = pool(token, USDC_QUOTE, 74n, 137n);
    const { r, reads, lines } = await pass([kwifMain, kwifDust, tokenSol, tokenUsdcDust, usdcSol]);
    expect(r.loops).toBe(2);
    expect(reads).toBe(0);
    expect(lines.filter((l) => /our pools/.test(l))).toEqual([]);
    expect(r.sent).toBe(0);
  });

  it('reads the wallet for a pair that pays at some size, and sizes the trip to what it holds', async () => {
    const mint = key();
    const { r, reads } = await pass([pool(mint, SOL_QUOTE, 50n * SOL, 10n ** 9n), pool(mint, SOL_QUOTE, 50n * SOL, 9n * 10n ** 8n)]);
    expect(reads).toBe(1);
    expect(r.sent).toBe(0);
  });

  it('reads the wallet for the way round a loop that pays, not the way that loses', async () => {
    const tokenUsdcDear = pool(token, USDC_QUOTE, 10_500n * USDC, 10n ** 9n);
    const { r, reads } = await pass([tokenSol, tokenUsdcDear, usdcSol]);
    expect(r.loops).toBe(2);
    expect(reads).toBe(1);
    expect(r.sent).toBe(0);
  });
});
