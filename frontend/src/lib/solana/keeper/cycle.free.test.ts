// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, type PublicKey } from '@solana/web3.js';
import type { AmmConfigView } from '../cpswap/program';
import type { PoolView } from '../lp/poolFinder';
import { SOL_QUOTE } from '../lp/quotes';
import type { JupiterApi } from './jupiterApi';

/**
 * KEEPER_FREE_SWAPS in the robot's pass: every pool of ours it reads comes with its tier as that
 * tier charges the robot (cpswap/read.ts chargedTo), so the gaps, loops and quotes after it price
 * the robot's swaps the way the pool program will once the keeper's fee is on mainnet.
 */

const seen: (PoolView['config'])[] = [];
let pools: PoolView[] = [];
vi.mock('../lp/poolList', async (orig) => ({
  ...(await orig<typeof import('../lp/poolList')>()),
  listPools: vi.fn(async () => ({ kind: 'ok', list: { pools, chainNow: 100n } })),
  readMarketPrices: vi.fn(async () => ({ kind: 'ok', usd: new Map([[SOL_QUOTE.mint, 100]]) })),
  arbitrage: vi.fn((view: PoolView) => {
    seen.push(view.config);
    return null;
  }),
  rowTokenFee: vi.fn(() => null),
}));
vi.mock('../lp/tokenSafety', async (orig) => ({ ...(await orig<typeof import('../lp/tokenSafety')>()), readTokenSafety: vi.fn(async () => new Map()) }));
vi.mock('./plan', async (orig) => ({ ...(await orig<typeof import('./plan')>()), poolProblem: vi.fn(() => null) }));
vi.mock('./rule', async (orig) => ({ ...(await orig<typeof import('./rule')>()), tokenGate: vi.fn(() => null) }));

const { runCycle, DEFAULT_SETTINGS } = await import('./cycle');
const { DEFAULT_LIMITS } = await import('./plan');

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const key = () => Keypair.generate().publicKey;
const robot = key();

/** A tier of ours: 1% trade fee, a 0.5% creator fee, naming `keeper` (or no one). */
const tier = (keeper: PublicKey | null): AmmConfigView =>
  ({ address: key().toBase58(), index: 1, disableCreatePool: false, tradeFeeRate: 10_000n, protocolFeeRate: 160_000n, fundFeeRate: 0n, createPoolFee: 0n, creatorFeeRate: 5_000n, protocolOwner: '', fundOwner: '', keeper: keeper?.toBase58() ?? null });
const view = (config: AmmConfigView): PoolView =>
  ({
    address: key().toBase58(),
    tokenMint: key().toBase58(),
    quote: SOL_QUOTE,
    quoteIsToken0: true,
    vaultsFrozen: false,
    quoteReserve: 1n,
    tokenReserve: 1n,
    config,
    snapshot: { pool: { token0Program: TOKEN_PROGRAM, token1Program: TOKEN_PROGRAM, token0Vault: key().toBase58(), token1Vault: key().toBase58() } },
  }) as unknown as PoolView;

const rpc = vi.fn(async (_method: string, params: unknown[]) => ({ value: (params[0] as string[]).map(() => null) }));
const io = () => ({ rpc, jupiter: { labels: async () => ({}) } as unknown as JupiterApi, owner: robot, indexFetch: fetch, log: vi.fn() });
const settings = { ...DEFAULT_LIMITS, ...DEFAULT_SETTINGS, maxTradeUsd: 40, lighthouseProven: true, minProfitUsd: 0.01, allowRaydium: true, raydiumPrograms: [], outsidePools: [] };

const named = tier(robot);
const other = tier(key());
const none = tier(null);
beforeEach(() => {
  seen.length = 0;
  pools = [view(named), view(other), view(none)];
});

describe('the robot’s pass with KEEPER_FREE_SWAPS', () => {
  it('weighs a pool on a tier naming the robot at no fee, the creator’s 0 on the output; any other at its tier’s fee', async () => {
    await runCycle(io(), { ...settings, freeSwaps: true });
    expect(seen).toHaveLength(3);
    expect(seen[0]).toMatchObject({ tradeFeeRate: 0n, creatorFeeRate: 0n, keeperFree: true, keeper: robot.toBase58() });
    expect(seen[1]).toBe(other);
    expect(seen[2]).toBe(none);
  });

  it('weighs every pool at its tier’s fee when it is off (the default), its own tier included', async () => {
    expect(DEFAULT_SETTINGS.freeSwaps).toBe(false);
    await runCycle(io(), settings);
    expect(seen).toEqual([named, other, none]);
    expect(seen[0]).toBe(named);
  });
});
