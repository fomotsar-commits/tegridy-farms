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
// The token gate's own test is rule.test.ts; this fake chain has no mint accounts to read.
vi.mock('./rule', async (orig) => ({ ...(await orig<typeof import('./rule')>()), tokenGate: vi.fn(() => null) }));

const { runCycle, gapKey, NO_ROUTE_KEEP_MS, DEFAULT_SETTINGS } = await import('./cycle');
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
// No outside pool: their read is keeper/outside.ts's test, and would take this fake chain's first answer.
const settings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, minProfitUsd: 0.01, allowRaydium: true, raydiumPrograms: [], outsidePools: [] };

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

  // 2026-11-08: the float at 0 left these trips skipped for 4.4 h while a loan could carry them.
  it('takes a SOL gap on a loan when the keeper holds none and loans are on; never a USDC one', async () => {
    const { readMarketPrices } = await import('../lp/poolList');
    const prices = { kind: 'ok', usd: new Map([[SOL_QUOTE.mint, 100], [USDC_QUOTE.mint, 1]]) } as Awaited<ReturnType<typeof readMarketPrices>>;
    const sol = view();
    const usdc = view(USDC_QUOTE);
    pools = [sol, usdc];
    gaps.set(sol.address, arb(0.3, 70));
    gaps.set(usdc.address, arb(0.3, 70));
    // The keeper holds nothing at all: no coin account, no token account.
    const rpc = vi.fn(async (method: string, params: unknown[]) => {
      if (method !== 'getMultipleAccounts') throw new Error(`unexpected ${method}`);
      return { value: (params[0] as string[]).map(() => null) };
    });
    const quote = vi.fn(async () => {
      throw new Error('Jupiter answered 400: NO_ROUTES_FOUND');
    });
    const run = (flashLoans: boolean) => {
      vi.mocked(readMarketPrices).mockResolvedValueOnce(prices);
      return runCycle({ rpc, jupiter: { quote } as unknown as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log: vi.fn() }, { ...settings, flashLoans });
    };
    const outcomes = (r: Awaited<ReturnType<typeof runCycle>>) => r.seen.map((g) => [g.pool, g.outcome]);

    const off = await run(false);
    expect(outcomes(off)).toEqual([
      [sol.address, 'no-coin'],
      [usdc.address, 'no-coin'],
    ]);
    expect(quote).not.toHaveBeenCalled();

    // Loans on: the SOL gap goes on to Jupiter's quote (no route on this fake chain); USDC cannot borrow.
    const on = await run(true);
    expect(outcomes(on)).toEqual([
      [sol.address, 'no-route'],
      [usdc.address, 'no-coin'],
    ]);
    expect(quote).toHaveBeenCalled();
  });

  it('weighs nothing when the pools are not read', async () => {
    const { listPools } = await import('../lp/poolList');
    vi.mocked(listPools).mockResolvedValueOnce({ kind: 'unread', detail: 'down' });
    const r = await runCycle({ rpc: vi.fn(), jupiter: {} as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log: vi.fn() }, settings);
    expect([r.looked, r.seen]).toEqual([[], []]);
  });

  // Keyless Jupiter allows one call in 2 s: a gap it has already said no to costs none, until it moves.
  it('asks Jupiter about a gap it found no route for once, until our pool moves', async () => {
    const pool = { ...view(), quoteReserve: 10n, tokenReserve: 10n } as PoolView;
    pools = [pool];
    gaps.set(pool.address, arb(0.4));
    const rpc = vi.fn(async (_method: string, params: unknown[]) => ({
      value: [holding(5_000_000_000n), ...Array.from({ length: (params[0] as string[]).length - 1 }, () => null)],
    }));
    const quote = vi.fn(async () => {
      throw new Error('Jupiter answered 400: NO_ROUTES_FOUND');
    });
    const io = { rpc, jupiter: { quote } as unknown as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log: vi.fn() };

    const first = await runCycle(io, settings);
    const asked = quote.mock.calls.length;
    expect(asked).toBeGreaterThan(0);
    expect(first.seen.map((g) => g.outcome)).toEqual(['no-route']);

    const again = await runCycle(io, settings);
    expect(quote.mock.calls.length).toBe(asked);
    // Still in the gap log, with the reason it was left, marked as answered from memory.
    expect(again.seen.map((g) => g.outcome)).toEqual(['no-route']);
    expect(first.seen.map((g) => g.remembered)).toEqual([false]);
    expect(again.seen.map((g) => g.remembered)).toEqual([true]);

    // No route does not hang on a price: a trade in our pool changes nothing for an hour.
    const moved = { ...pool, quoteReserve: 11n } as PoolView;
    pools = [moved];
    gaps.set(moved.address, arb(0.4));
    await runCycle(io, settings);
    expect(quote.mock.calls.length).toBe(asked);
    // An hour on, Jupiter is asked again.
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + NO_ROUTE_KEEP_MS + 1);
    await runCycle(io, settings);
    later.mockRestore();
    expect(quote.mock.calls.length).toBe(2 * asked);
  });
});

describe('runCycle, when Jupiter says too many calls', () => {
  it('asks nothing more that pass', async () => {
    const a = { ...view(), quoteReserve: 20n, tokenReserve: 20n } as PoolView;
    const b = { ...view(), quoteReserve: 30n, tokenReserve: 30n } as PoolView;
    pools = [a, b];
    gaps.set(a.address, arb(0.4));
    gaps.set(b.address, arb(0.4));
    const rpc = vi.fn(async (_method: string, params: unknown[]) => ({
      value: [holding(5_000_000_000n), ...Array.from({ length: (params[0] as string[]).length - 1 }, () => null)],
    }));
    const quote = vi.fn(async () => {
      throw new Error('Jupiter /swap/v1/quote answered 429');
    });
    const r = await runCycle({ rpc, jupiter: { quote } as unknown as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log: vi.fn() }, settings);
    expect(quote).toHaveBeenCalledTimes(1);
    expect(r.seen.map((g) => [g.pool, g.outcome])).toEqual([[a.address, 'error']]);
  });

  it('goes on when it is the RPC, not Jupiter, that says too many calls', async () => {
    const a = { ...view(), quoteReserve: 40n, tokenReserve: 40n } as PoolView;
    const b = { ...view(), quoteReserve: 50n, tokenReserve: 50n } as PoolView;
    pools = [a, b];
    gaps.set(a.address, arb(0.4));
    gaps.set(b.address, arb(0.4));
    let reads = 0;
    const rpc = vi.fn(async (_method: string, params: unknown[]) => {
      if (reads++ === 0) throw new Error('getMultipleAccounts: the RPC answered 429');
      return { value: [holding(5_000_000_000n), ...Array.from({ length: (params[0] as string[]).length - 1 }, () => null)] };
    });
    const quote = vi.fn(async () => {
      throw new Error('Jupiter /swap/v1/quote answered 400 (NO_ROUTES_FOUND)');
    });
    const r = await runCycle({ rpc, jupiter: { quote } as unknown as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log: vi.fn() }, settings);
    expect(quote).toHaveBeenCalled();
    expect(r.seen.map((g) => [g.pool, g.outcome])).toEqual([
      [a.address, 'error'],
      [b.address, 'no-route'],
    ]);
  });
});

describe('gapKey: when a quote that fell short is asked again', () => {
  const usd = new Map([[SOL_QUOTE.mint, 100]]);
  const pool = { ...view(), quoteReserve: 10n, tokenReserve: 10n } as PoolView;
  usd.set(pool.tokenMint, 1);
  const key0 = gapKey(pool, usd);

  it('is the same gap while nothing moves, or a price moves under a 0.25% step', () => {
    expect(gapKey({ ...pool } as PoolView, new Map(usd))).toBe(key0);
    expect(gapKey(pool, new Map([...usd, [pool.tokenMint, 1.0001]]))).toBe(key0);
  });

  it('is a new gap once our pool trades, or either price moves a step', () => {
    expect(gapKey({ ...pool, quoteReserve: 11n } as PoolView, usd)).not.toBe(key0);
    expect(gapKey({ ...pool, tokenReserve: 11n } as PoolView, usd)).not.toBe(key0);
    expect(gapKey(pool, new Map([...usd, [pool.tokenMint, 1.01]]))).not.toBe(key0);
    expect(gapKey(pool, new Map([...usd, [SOL_QUOTE.mint, 101]]))).not.toBe(key0);
  });
});
