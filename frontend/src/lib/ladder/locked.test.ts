// @vitest-environment node
// The home strip counts $BAYLA locked: the island's coin. Since 2026-10-31 other Solana rooms have
// ladders too, and the strip must never print another room's total under its own words.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bungalow } from '../bungalows';

const rooms = vi.hoisted(() => ({ list: [] as Partial<Bungalow>[] }));
const read = vi.hoisted(() => ({ pools: [] as string[] }));

vi.mock('../bungalows', () => ({
  get BUNGALOWS() {
    return rooms.list;
  },
}));
vi.mock('./program', async (orig) => {
  const m = await orig<typeof import('./program')>();
  const { PublicKey } = await import('@solana/web3.js');
  return { ...m, isLadderConfigured: () => true, ladderProgramId: () => new PublicKey('EJLP5GEJXEyPTdoKbGtp2xJiREJpE4DkHSWbVEs9FfUQ') };
});
vi.mock('../solana', async (orig) => ({ ...(await orig<typeof import('../solana')>()), solanaRpcEndpoint: () => 'https://rpc.invalid' }));
vi.mock('./read', () => ({
  readLadderPool: async (_c: unknown, _p: unknown, pool: { toBase58: () => string }) => {
    read.pools.push(pool.toBase58());
    return { ok: true, value: { totalPrincipalRaw: 7_000_000n, decimals: 6 } };
  },
}));

import { readLadderLocked } from './locked';

const BOBO = { id: 'bobo', symbol: 'BOBO', chain: 'solana', live: true, ladderPool: 'CX24Ti8vamGXAVF2T9bgJj3EfX627Na4tcXbfkaDz1pT' } as const;
const BAYLA = { id: 'bayla', symbol: 'BAYLA', chain: 'solana', live: true, ladderPool: 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV' } as const;

beforeEach(() => {
  read.pools = [];
});

describe('readLadderLocked', () => {
  it("reads BAYLA's pool, whichever ladder room comes first", async () => {
    rooms.list = [BOBO, BAYLA];
    expect(await readLadderLocked()).toEqual({ symbol: 'BAYLA', raw: 7_000_000n, decimals: 6 });
    expect(read.pools).toEqual([BAYLA.ladderPool]);
  });

  it("prints nothing when BAYLA has no ladder, even with another room's", async () => {
    rooms.list = [BOBO, { ...BAYLA, ladderPool: undefined }];
    expect(await readLadderLocked()).toBeNull();
    expect(read.pools).toEqual([]);
  });
});
