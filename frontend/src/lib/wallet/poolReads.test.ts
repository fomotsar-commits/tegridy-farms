// One /dashboard load made about 60 Solana RPC calls (2026-11-01), against a proxy that allows
// 300 a minute per IP: the board and Harvest each read every Streamflow pool and lock ladder for
// the wallet, on their own, at the same time. A load now reads each pool account once, shared.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const OWNER = '9WAugU3gEpYMy1VQpjjCX7Dqo7PJAwhGfXmhNmpS2Fcz';
const ROOMS = vi.hoisted(() => [
  { id: 'bobo', symbol: 'BOBO', address: '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump', ladderPool: 'CX24Ti8vamGXAVF2T9bgJj3EfX627Na4tcXbfkaDz1pT' },
  { id: 'soy', symbol: 'SOY', address: '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump', ladderPool: '3woT5BZgznYQGvemUQmaKesbUmXJRWxaGUxAYkudSYBn' },
]);
/** Every pool read that reached a reader, as `<reader> <pool>`. */
const reads = vi.hoisted(() => [] as string[]);

vi.mock('../bungalows', async (orig) => ({ ...(await orig<typeof import('../bungalows')>()), ladderRooms: () => ROOMS }));
// Under node the site's relative RPC path is no URL; nothing is fetched here anyway.
vi.mock('../solana', async (orig) => ({ ...(await orig<typeof import('../solana')>()), solanaRpcEndpoint: () => 'https://rpc.invalid' }));
vi.mock('../jupiter', async (orig) => ({ ...(await orig<typeof import('../jupiter')>()), getUsdPrices: async () => ({}) }));
vi.mock('../ladder/program', async (orig) => ({
  ...(await orig<typeof import('../ladder/program')>()),
  isLadderConfigured: () => true,
  ladderProgramId: () => new PublicKey('EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ'),
}));
vi.mock('../bungalowStaking', async (orig) => ({
  ...(await orig<typeof import('../bungalowStaking')>()),
  readEntries: async (pool: string) => {
    reads.push(`entries ${pool}`);
    return { ok: true, entries: [{ address: `E-${pool}`, nonce: 0, amountRaw: 5n, durationSecs: 86_400, createdTs: 1, closedTs: 0, effectiveAmountRaw: 5n, pendingRaw: {} }] };
  },
  readPool: async (pool: string) => {
    reads.push(`pool ${pool}`);
    return { ok: true, pool: { address: pool, mint: 'stranger', decimals: 6, rewardPools: [] } };
  },
}));
vi.mock('../ladder/read', () => ({
  readLadderPool: async (_c: unknown, _p: unknown, pool: PublicKey) => {
    reads.push(`ladder-pool ${pool.toBase58()}`);
    return { ok: true, value: { address: pool.toBase58(), mint: 'stranger', decimals: 6, stakeVault: 'S', rewardVault: 'R' } };
  },
  readLadderWallet: async (_c: unknown, _p: unknown, pool: PublicKey) => {
    reads.push(`ladder-wallet ${pool.toBase58()}`);
    return { ok: true, value: { stats: { address: 'U', openPositions: 0, rewardsCarriedRaw: 0n }, slots: [], open: [], truncated: false, shareBasis: null } };
  },
  readVaultBalances: async (_c: unknown, pool: { address: string }) => {
    reads.push(`ladder-vaults ${pool.address}`);
    return { stakeRaw: 1n, rewardRaw: 1n };
  },
}));

import { solanaJobs } from '../../hooks/useWalletBoard';
import { readSolanaHarvest } from '../harvest/solana';
import { noteStakesChanged } from '../harvest/stakesChanged';
import { solanaStakePools } from './walletRows';
import { forgetHeldReads } from './heldReads';

/** One dashboard load: the board's pool legs and Harvest, started together. */
async function load(): Promise<void> {
  const legs = solanaJobs().filter((j) => j.key.startsWith('sol-ladder:') || j.key.startsWith('sol-stake:'));
  const answers = await Promise.all([...legs.map((j) => j.run(OWNER)), readSolanaHarvest(OWNER, 1_800_000_000)]);
  // Every leg read: a test that counted fewer reads because a leg failed would prove nothing.
  expect(answers.slice(0, -1).map((l) => (l as { status: string }).status)).toEqual(legs.map(() => 'ok'));
}

const tally = () => {
  const n: Record<string, number> = {};
  for (const r of reads) n[r] = (n[r] ?? 0) + 1;
  return n;
};

/** Each pool account, read once. */
const once = () => {
  const n: Record<string, number> = {};
  for (const t of solanaStakePools()) {
    n[`entries ${t.pool}`] = 1;
    n[`pool ${t.pool}`] = 1;
  }
  for (const r of ROOMS) {
    n[`ladder-pool ${r.ladderPool}`] = 1;
    n[`ladder-wallet ${r.ladderPool}`] = 1;
    n[`ladder-vaults ${r.ladderPool}`] = 1;
  }
  return n;
};

beforeEach(() => {
  reads.length = 0;
  forgetHeldReads();
});

describe('a dashboard load: the board and Harvest share each pool read', () => {
  it('reads every Streamflow pool and every ladder once, however many cards ask', async () => {
    expect(solanaStakePools().length).toBeGreaterThan(1);
    await load();
    expect(tally()).toEqual(once());
  });

  it('a staking write in between: the next load reads every pool again, once', async () => {
    await load();
    noteStakesChanged({});
    await load();
    expect(tally()).toEqual(Object.fromEntries(Object.keys(once()).map((k) => [k, 2])));
  });
});
