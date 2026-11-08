// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair } from '@solana/web3.js';
import type { PoolView } from '../lp/poolFinder';
import type { Arbitrage } from '../lp/poolList';
import { SOL_QUOTE } from '../lp/quotes';
import type { JupiterApi, JupiterQuote } from './jupiterApi';

/**
 * A trip against Jupiter that falls short at its planned size (sized at Jupiter's listed price)
 * but pays smaller, and a gap Jupiter keeps falling short on. Our pool and Jupiter's leg are each
 * one x·y = k pool here; the pass's own steps (planFor, the keeper's balances, the sizing) run as
 * they do live, and the trip stops where Jupiter would build its swap.
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
vi.mock('./rule', async (orig) => ({ ...(await orig<typeof import('./rule')>()), tokenGate: vi.fn(() => null) }));
// Our pool: selling it the token pays SOL on x·y = k, `ours` deep.
const ours = { sol: 40_800_000_000n, token: 40_000_000_000n };
vi.mock('../cpswap/read', async (orig) => ({
  ...(await orig<typeof import('../cpswap/read')>()),
  quoteOwnPool: vi.fn((_snapshot: unknown, _config: unknown, inputMint: string, amountIn: bigint) =>
    inputMint === SOL_QUOTE.mint ? { outAmount: (ours.token * amountIn) / (ours.sol + amountIn) } : { outAmount: (ours.sol * amountIn) / (ours.token + amountIn) },
  ),
}));

const { runCycle, DEFAULT_SETTINGS, QUOTE_SHORT_KEEP_MS, QUOTE_SHORT_MAX_MS } = await import('./cycle');
const { DEFAULT_LIMITS, jupiterFloor } = await import('./plan');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const key = () => Keypair.generate().publicKey.toBase58();
function view(): PoolView {
  return {
    address: key(),
    tokenMint: key(),
    quote: SOL_QUOTE,
    quoteIsToken0: true,
    vaultsFrozen: false,
    quoteReserve: 1n,
    tokenReserve: 1n,
    config: {},
    snapshot: { pool: { token0Program: TOKEN_PROGRAM, token1Program: TOKEN_PROGRAM, token0Vault: key(), token1Vault: key() } },
  } as unknown as PoolView;
}
// The pool is dear: buy the token on Jupiter, sell it here. `gap`: pool over Jupiter less one.
const arb = (gap: number): Arbitrage => ({ side: 'sell', gap, profitUsd: 0.4, tradeUsd: 40 }) as unknown as Arbitrage;

function holding(amount: bigint) {
  const data = new Uint8Array(165);
  new DataView(data.buffer).setBigUint64(64, amount, true);
  return { data: [Buffer.from(data).toString('base64'), 'base64'], owner: TOKEN_PROGRAM, lamports: 2_039_280, executable: false, rentEpoch: 0 };
}
// The keeper holds 5 SOL and the token's account is open: no rent, no loan.
const rpc = vi.fn(async (_method: string, params: unknown[]) => ({ value: (params[0] as string[]).map(() => holding(5_000_000_000n)) }));

// Jupiter's leg, SOL → token, one x·y = k pool `deep` lamports and tokens deep.
let deep = 40_000_000_000n;
const quote = vi.fn(async (p: { amount: bigint; slippageBps: number; inputMint: string; outputMint: string }): Promise<JupiterQuote> => ({
  inputMint: p.inputMint,
  outputMint: p.outputMint,
  inAmount: String(p.amount),
  outAmount: String((deep * p.amount) / (deep + p.amount)),
  otherAmountThreshold: '0',
  swapMode: 'ExactIn',
  slippageBps: p.slippageBps,
  routePlan: [],
}));
const swapInstructions = vi.fn(async () => {
  throw new Error('stopped where Jupiter builds the swap');
});
const io = () => ({ rpc, jupiter: { quote, swapInstructions } as unknown as JupiterApi, owner: Keypair.generate().publicKey, indexFetch: fetch, log: vi.fn() });

const settings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, maxTradeUsd: 40, lighthouseProven: true, minProfitUsd: 0.01, allowRaydium: true, raydiumPrograms: [], outsidePools: [] };
const PLANNED = 400_000_000n; // $40 at SOL $100

/** What a trip of `x` lamports brings back: Jupiter's least in tokens, sold here. */
const back = (x: bigint) => {
  const tokens = jupiterFloor((deep * x) / (deep + x), settings.slippageBps);
  return (ours.sol * tokens) / (ours.token + tokens);
};
const askedFor = () => quote.mock.calls.map((c) => c[0].amount);

let pools: PoolView[] = [];
beforeEach(() => {
  gaps.clear();
  quote.mockClear();
  swapInstructions.mockClear();
  deep = 40_000_000_000n;
});

describe('sizing a trip that falls short at its planned size', () => {
  it('asks at half the size, then at the best size on the fitted leg, and builds the one that pays most', async () => {
    const pool = view();
    pools = [pool];
    gaps.set(pool.address, arb(0.02));
    // The scene: short at the planned size by under 1%, paying smaller.
    expect(back(PLANNED) < PLANNED).toBe(true);
    expect(PLANNED - back(PLANNED)).toBeLessThan(PLANNED / 100n);
    expect(back(PLANNED / 2n) - PLANNED / 2n).toBeGreaterThan(200_000n);

    const r = await runCycle(io(), settings);

    const asked = askedFor();
    expect(asked.slice(0, 2)).toEqual([PLANNED, PLANNED / 2n]);
    expect(asked).toHaveLength(3);
    // The best size by brute force on the real curves, to 1%.
    let best = 1n;
    for (let x = 1_000_000n; x <= PLANNED; x += 1_000_000n) if (back(x) - x > back(best) - best) best = x;
    expect(Number(asked[2]!)).toBeGreaterThan(Number(best) * 0.99);
    expect(Number(asked[2]!)).toBeLessThan(Number(best) * 1.01);
    // The swap is asked for at that size, its quote untouched.
    expect(swapInstructions).toHaveBeenCalledTimes(1);
    expect((swapInstructions.mock.calls[0] as unknown as [JupiterQuote])[0].inAmount).toBe(String(asked[2]));
    expect(r.seen.map((g) => g.outcome)).toEqual(['error']);
  });

  it('asks once, and never for the swap, when the planned size falls far short', async () => {
    const pool = view();
    pools = [pool];
    gaps.set(pool.address, arb(0.02));
    deep = 4_000_000_000n; // a tenth as deep: short by several percent
    expect(PLANNED - back(PLANNED)).toBeGreaterThan(PLANNED / 100n);

    const r = await runCycle(io(), settings);

    expect(askedFor()).toEqual([PLANNED]);
    expect(swapInstructions).not.toHaveBeenCalled();
    expect(r.seen.map((g) => g.outcome)).toEqual(['quote-short']);
  });
});

describe('a gap Jupiter keeps falling short on', () => {
  it('is asked about less often each time, and at once when the gap grows past what it fell short by', async () => {
    const t0 = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(t0);
    try {
      deep = 4_000_000_000n;
      const pool = view();
      pools = [pool];
      const shortBy = Number(PLANNED + 120_000n - back(PLANNED)) / Number(PLANNED);
      const pass = async (gap: number, reserve: bigint) => {
        pools = [{ ...pool, quoteReserve: reserve } as PoolView];
        gaps.set(pool.address, arb(gap));
        quote.mockClear();
        await runCycle(io(), settings);
        return quote.mock.calls.length;
      };
      expect(await pass(0.02, 1n)).toBe(1);
      // Our pool trades (a new key), the gap no wider: not asked.
      expect(await pass(0.021, 2n)).toBe(0);
      // Wider by what it fell short by: asked at once.
      expect(await pass(0.02 + shortBy + 0.001, 3n)).toBe(1);
      // Short again: held twice as long, 10 minutes.
      clock.mockReturnValue(t0 + QUOTE_SHORT_KEEP_MS + 60_000);
      expect(await pass(0.02 + shortBy + 0.001, 4n)).toBe(0);
      const t5 = t0 + 2 * QUOTE_SHORT_KEEP_MS + 1;
      clock.mockReturnValue(t5);
      expect(await pass(0.02 + shortBy + 0.001, 5n)).toBe(1);
      // Then 20 minutes, then never more than 30 (not 40).
      const t6 = t5 + 4 * QUOTE_SHORT_KEEP_MS + 1;
      clock.mockReturnValue(t6 - 2);
      expect(await pass(0.02 + shortBy + 0.001, 6n)).toBe(0);
      clock.mockReturnValue(t6);
      expect(await pass(0.02 + shortBy + 0.001, 7n)).toBe(1);
      clock.mockReturnValue(t6 + QUOTE_SHORT_MAX_MS + 1);
      expect(await pass(0.02 + shortBy + 0.001, 8n)).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });
});
