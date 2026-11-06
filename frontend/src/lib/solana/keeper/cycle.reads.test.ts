// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { Keypair, PublicKey } from '@solana/web3.js';
import { buildPool, key, viewOf } from '../lp/testkit.fixture';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import type { PoolView } from '../lp/poolFinder';
import type { JupiterApi } from './jupiterApi';

/**
 * The public RPC refuses this PC past about 40 reads of one kind in 10 s, robot and scanner
 * together, and a refused read of the keeper's wallet is an `error` row on the robot's page.
 * Trips through our own pools are sized from the pools alone; the wallet only caps the size.
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

const settings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, maxTradeUsd: 10_000, lighthouseProven: true, minProfitUsd: 0.01, allowRaydium: true, raydiumPrograms: [], outsidePools: [] };

function pool(mint: PublicKey, quote: typeof SOL_QUOTE, quoteReserve: bigint, tokenReserve: bigint): PoolView {
  return viewOf(buildPool({ mint, address: key(), quote, quoteReserve, tokenReserve }), { sol: quoteReserve, tok: tokenReserve });
}

// BAYLA's shape: the token in a SOL pool and a USDC pool, and USDC / SOL. 1% fee in each.
const token = key();
const tokenSol = pool(token, SOL_QUOTE, 50n * SOL, 10n ** 9n);
const tokenUsdcFair = pool(token, USDC_QUOTE, 10_000n * USDC, 10n ** 9n);
const tokenUsdcDear = pool(token, USDC_QUOTE, 10_500n * USDC, 10n ** 9n);
const usdcSol = pool(new PublicKey(USDC_QUOTE.mint), SOL_QUOTE, 50n * SOL, 10_000n * USDC);
// KWIF's shape: two pools of one pair.
const other = key();
const pairA = pool(other, SOL_QUOTE, 40n * SOL, 10n ** 9n);
const pairFair = pool(other, SOL_QUOTE, 40n * SOL, 10n ** 9n);
const pairDear = pool(other, SOL_QUOTE, 42n * SOL, 10n ** 9n);

/** A token account holding `amount`, as getMultipleAccounts answers it. */
function holding(amount: bigint) {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

/** A chain that answers the wallet read with an empty coin account, and counts every call. */
function chain() {
  const methods: string[] = [];
  const rpc = vi.fn(async (method: string, params: unknown[]) => {
    methods.push(method);
    if (method !== 'getMultipleAccounts') throw new Error(`unexpected ${method}`);
    return { value: [holding(0n), ...Array.from({ length: (params[0] as string[]).length - 1 }, () => null)] };
  });
  return { rpc, methods };
}

const run = async (rpc: ReturnType<typeof chain>['rpc'], log = vi.fn()) =>
  runCycle({ rpc, jupiter: {} as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log }, settings);

describe('runCycle, trips through our own pools', () => {
  it('reads the wallet for none of them while no size of any trip pays', async () => {
    pools = [tokenSol, tokenUsdcFair, usdcSol, pairA, pairFair];
    const { rpc, methods } = chain();
    const r = await run(rpc);
    expect(r.loops).toBe(2);
    expect(methods).toEqual([]);
  });

  it('reads the wallet once for each that pays at the cap, and still sizes it to what the wallet holds', async () => {
    pools = [tokenSol, tokenUsdcDear, usdcSol, pairA, pairDear];
    const { rpc, methods } = chain();
    const log = vi.fn();
    const r = await run(rpc, log);
    // The pair, and the loop the cheap way round. The wallet holds none: nothing is test-run.
    expect(methods).toEqual(['getMultipleAccounts', 'getMultipleAccounts']);
    expect(r.sent).toBe(0);
    expect(log.mock.calls.flat().filter((l) => /stopped|skipped/.test(String(l)))).toEqual([]);
  });
});
