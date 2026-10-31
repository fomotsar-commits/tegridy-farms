// Owner, 2026-10-31: the other Solana rooms stake exactly like BAYLA, so the board reads a lock
// ladder for every room that has one. It used to read the first room's alone (a `find`).

import { describe, it, expect, vi } from 'vitest';
import type { Bungalow } from '../lib/bungalows';

const OWNER = '9WAugU3gEpYMy1VQpjjCX7Dqo7PJAwhGfXmhNmpS2Fcz';
const ROOMS = vi.hoisted(() => [
  { id: 'bayla', symbol: 'BAYLA', ladderPool: 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV' },
  { id: 'bobo', symbol: 'BOBO', ladderPool: 'CX24Ti8vamGXAVF2T9bgJj3EfX627Na4tcXbfkaDz1pT' },
]);

vi.mock('../lib/bungalows', async (orig) => ({
  ...(await orig<typeof import('../lib/bungalows')>()),
  ladderRooms: () => ROOMS,
}));

import { solanaJobs } from './useWalletBoard';

const reader = {
  readSolanaLadder: async (_owner: string, room: Bungalow) => ({
    status: 'ok' as const,
    rows: [{ key: `ladder:${room.id}`, roomId: room.id, chain: 'solana' as const, title: `${room.symbol} lock`, facts: [], to: `/earn/${room.id}` }],
  }),
} as unknown as typeof import('../lib/wallet/readSolanaWallet');

describe('the board: a lock ladder leg for every Solana room that has one', () => {
  it('gives each room its own leg, named for its coin and read for that room', async () => {
    const ladders = solanaJobs(async () => reader).filter((j) => j.key.startsWith('sol-ladder:'));
    expect(ladders.map((j) => [j.key, j.what, j.kind])).toEqual([
      ['sol-ladder:Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV', 'your BAYLA locks', 'positions'],
      ['sol-ladder:CX24Ti8vamGXAVF2T9bgJj3EfX627Na4tcXbfkaDz1pT', 'your BOBO locks', 'positions'],
    ]);
    const legs = await Promise.all(ladders.map((j) => j.run(OWNER)));
    expect(legs.map((l) => (l.status === 'ok' ? l.rows.map((r) => r.roomId) : null))).toEqual([['bayla'], ['bobo']]);
  });
});
