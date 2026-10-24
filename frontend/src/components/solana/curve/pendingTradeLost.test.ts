// A note with no signature: a Jupiter swap whose wallet answer was lost (owner, 2026-10-14, D1).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  LOST_ANSWER_TTL_MS,
  clearPendingTrade,
  noteKey,
  readPendingTrades,
  savePendingTrade,
  swapPendingScope,
} from './pendingTrade';

const scope = swapPendingScope('11111111111111111111111111111111');
let NOW = 0;

beforeEach(() => {
  localStorage.clear();
  // Behind the clock clearPendingTrade reads, so every note here is live for it.
  NOW = Date.now() - 10_000;
});

describe('a note with no signature', () => {
  it('is kept for a Jupiter swap for 2 minutes, then no longer', () => {
    savePendingTrade(scope, { kind: 'jupiter-swap', signature: null, lastValidBlockHeight: null }, NOW);
    expect(readPendingTrades(scope, NOW + LOST_ANSWER_TTL_MS)).toEqual([expect.objectContaining({ signature: null, sentAt: NOW })]);
    expect(readPendingTrades(scope, NOW + LOST_ANSWER_TTL_MS + 1)).toEqual([]);
  });

  it('is never read for any other kind: those always have a signature', () => {
    localStorage.setItem(scope, JSON.stringify([{ kind: 'venue-swap', signature: null, lastValidBlockHeight: null, sentAt: NOW }]));
    expect(readPendingTrades(scope, NOW)).toEqual([]);
  });

  it('two lost answers are two notes, each cleared by its own key, and a blockhash learned later keeps the first time', () => {
    savePendingTrade(scope, { kind: 'jupiter-swap', signature: null, lastValidBlockHeight: null }, NOW);
    savePendingTrade(scope, { kind: 'jupiter-swap', signature: null, lastValidBlockHeight: null }, NOW + 5_000);
    expect(readPendingTrades(scope, NOW + 6_000)).toHaveLength(2);
    const bh = { hash: 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi', validAt: 9 };
    savePendingTrade(scope, { kind: 'jupiter-swap', signature: null, lastValidBlockHeight: null, blockhash: bh, sentAt: NOW }, NOW + 7_000);
    const notes = readPendingTrades(scope, NOW + 7_000);
    expect(notes).toHaveLength(2);
    expect(notes.find((n) => n.sentAt === NOW)?.blockhash).toEqual(bh);
    clearPendingTrade(scope, noteKey({ signature: null, sentAt: NOW }));
    expect(readPendingTrades(scope, NOW + 7_000)).toEqual([expect.objectContaining({ sentAt: NOW + 5_000 })]);
  });
});
