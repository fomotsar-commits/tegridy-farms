// @vitest-environment node
// Owner, 2026-10-31: the other Solana rooms stake exactly like BAYLA, so Harvest All reads a lock
// ladder for every room that has one. It used to read the first room's alone (a `find`), and a
// second room's rewards would never have been offered or named as not read.

import { describe, it, expect, vi } from 'vitest';
import { PublicKey } from '@solana/web3.js';

const ROOMS = vi.hoisted(() => [
  { id: 'bayla', symbol: 'BAYLA', ladderPool: 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV' },
  { id: 'bobo', symbol: 'BOBO', ladderPool: 'CX24Ti8vamGXAVF2T9bgJj3EfX627Na4tcXbfkaDz1pT' },
]);
const read = vi.hoisted(() => ({ pools: [] as string[] }));

vi.mock('../bungalows', async (orig) => ({
  ...(await orig<typeof import('../bungalows')>()),
  ladderRooms: () => ROOMS,
}));
vi.mock('../wallet/walletRows', async (orig) => ({
  ...(await orig<typeof import('../wallet/walletRows')>()),
  solanaStakePools: () => [],
}));
// Under node the site's relative RPC path is no URL; nothing is fetched here anyway.
vi.mock('../solana', async (orig) => ({ ...(await orig<typeof import('../solana')>()), solanaRpcEndpoint: () => 'https://rpc.invalid' }));
vi.mock('../ladder/program', async (orig) => ({
  ...(await orig<typeof import('../ladder/program')>()),
  isLadderConfigured: () => true,
  ladderProgramId: () => new PublicKey('EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ'),
}));
vi.mock('../ladder/read', () => ({
  readLadderPool: async () => ({ ok: true, value: {} }),
  readLadderWallet: async (_c: unknown, _p: unknown, pool: PublicKey) => {
    read.pools.push(pool.toBase58());
    return { ok: false, unreadable: true, reason: `${pool.toBase58().slice(0, 4)} answered 429` };
  },
  readVaultBalances: async () => ({ rewardRaw: null }),
}));

import { readSolanaHarvest } from './solana';

describe('readSolanaHarvest: every ladder room', () => {
  it('reads each room, and names each one it could not read', async () => {
    const plan = await readSolanaHarvest('9WAugU3gEpYMy1VQpjjCX7Dqo7PJAwhGfXmhNmpS2Fcz', 1_800_000_000);
    expect(read.pools).toEqual(ROOMS.map((r) => r.ladderPool));
    expect(plan.unread.map((u) => [u.key, u.roomId, u.what, u.detail])).toEqual([
      ['ladder:Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV', 'bayla', 'your BAYLA locks', 'Bq6j answered 429'],
      ['ladder:CX24Ti8vamGXAVF2T9bgJj3EfX627Na4tcXbfkaDz1pT', 'bobo', 'your BOBO locks', 'CX24 answered 429'],
    ]);
  });
});
