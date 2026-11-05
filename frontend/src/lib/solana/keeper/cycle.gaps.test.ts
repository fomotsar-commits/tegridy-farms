// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { PoolView } from '../lp/poolFinder';
import type { Arbitrage } from '../lp/poolList';
import { SOL_QUOTE, USDC_QUOTE } from '../lp/quotes';
import type { JupiterApi } from './jupiterApi';

/**
 * What one pass hands the gap log (keeper/gaps.ts): every pool it weighed, and why it left each
 * gap worth the floor. The pool list, its prices and its gaps are made up here; the pass's own
 * steps (planFor, the keeper's balances, Jupiter's quote) run as they do live.
 */

const gaps = new Map<string, Arbitrage | null>();
vi.mock('../lp/poolList', async (orig) => ({
  ...(await orig<typeof import('../lp/poolList')>()),
  listPools: vi.fn(async () => ({ kind: 'ok', list: { pools: pools, chainNow: 100n } })),
  readMarketPrices: vi.fn(async () => ({ kind: 'ok', usd: new Map([[SOL_QUOTE.mint, 100]]) })),
  arbitrage: vi.fn((view: PoolView) => gaps.get(view.address) ?? null),
  rowTokenFee: vi.fn(() => null),
}));
vi.mock('../lp/tokenSafety', async (orig) => ({ ...(await orig<typeof import('../lp/tokenSafety')>()), readTokenSafety: vi.fn(async () => new Map()) }));
vi.mock('./plan', async (orig) => ({ ...(await orig<typeof import('./plan')>()), poolProblem: vi.fn(() => null) }));

const { runCycle, DEFAULT_SETTINGS } = await import('./cycle');
const { DEFAULT_LIMITS } = await import('./plan');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const key = () => Keypair.generate().publicKey.toBase58();
function view(quote = SOL_QUOTE): PoolView {
  return {
    address: key(),
    tokenMint: key(),
    quote,
    quoteIsToken0: true,
    vaultsFrozen: false,
    config: {},
    snapshot: { pool: { token0Program: TOKEN_PROGRAM, token1Program: TOKEN_PROGRAM, token0Vault: key(), token1Vault: key() } },
  } as unknown as PoolView;
}
const arb = (profitUsd: number, tradeUsd = 40): Arbitrage => ({ side: 'sell', profitUsd, tradeUsd }) as unknown as Arbitrage;

/** A token account holding `amount`, as getMultipleAccounts answers it. */
function holding(amount: bigint) {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}

let pools: PoolView[] = [];
const settings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, minProfitUsd: 0.01, allowRaydium: true, raydiumPrograms: [] };

describe('runCycle, for the gap log', () => {
  beforeEach(() => gaps.clear());

  it('names every pool it weighed, and the reason it left each gap worth the floor', async () => {
    const quiet = view();
    const tiny = view();
    const unpriced = view(USDC_QUOTE); // no USDC price this pass: planFor cannot size it
    const broke = view();
    const noRoute = view();
    pools = [quiet, tiny, unpriced, broke, noRoute];
    gaps.set(tiny.address, arb(0.005));
    gaps.set(unpriced.address, arb(0.2));
    gaps.set(broke.address, arb(0.3, 70));
    gaps.set(noRoute.address, arb(0.4));
    // The keeper's balances: none of the coin on the first trip's read, some on the next.
    let reads = 0;
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method !== 'getMultipleAccounts') throw new Error(`unexpected ${method}`);
      const n = (params[0] as string[]).length;
      const coin = reads++ === 0 ? null : holding(5_000_000_000n);
      return { value: [coin, ...Array.from({ length: n - 1 }, () => null)] };
    });
    const jupiter = {
      quote: vi.fn(async () => {
        throw new Error('Jupiter answered 400: NO_ROUTES_FOUND');
      }),
    } as unknown as JupiterApi;
    const log = vi.fn();

    const r = await runCycle({ rpc, jupiter, owner: Keypair.generate().publicKey, indexFetch: fetch, log }, settings);

    expect(r.looked).toEqual(pools.map((v) => v.address));
    expect(r.gaps).toBe(4);
    expect(r.seen.map((g) => [g.pool, g.outcome, g.listedUsd, g.wantUsd, g.coin, g.tokenMint])).toEqual([
      [unpriced.address, 'no-plan', 0.2, 40, 'USDC', unpriced.tokenMint],
      [broke.address, 'no-coin', 0.3, 70, 'SOL', broke.tokenMint],
      [noRoute.address, 'no-route', 0.4, 40, 'SOL', noRoute.tokenMint],
    ]);
    expect(r.sent).toBe(0);
  });

  it('weighs nothing when the pools are not read', async () => {
    const { listPools } = await import('../lp/poolList');
    vi.mocked(listPools).mockResolvedValueOnce({ kind: 'unread', detail: 'down' });
    const r = await runCycle({ rpc: vi.fn(), jupiter: {} as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log: vi.fn() }, settings);
    expect([r.looked, r.seen]).toEqual([[], []]);
  });
});
