// isSolanaPage's /earn/<id> rule, against a registry made for it. Today's real
// registry has no Solana room that is dark, and none without a pool, so
// routeVoice.test.ts cannot tell those two conditions from no condition.
import { describe, expect, it, vi } from 'vitest';

vi.mock('./bungalows', () => ({
  BUNGALOWS: [
    { id: 'sol-streamflow', chain: 'solana', live: true, stakePool: 'POOL' },
    { id: 'sol-ladder', chain: 'solana', live: true, ladderPool: 'LADDER' },
    { id: 'sol-dark', chain: 'solana', live: false, stakePool: 'POOL' },
    { id: 'sol-no-pool', chain: 'solana', live: true },
    { id: 'base-pool', chain: 'base', live: true, stakePool: '0x1' },
  ],
}));

const { isSolanaPage } = await import('./routeVoice');

describe('isSolanaPage: /earn/<id> is a Solana page only where a Solana pool card mounts', () => {
  it('is true for a live Solana room with either kind of pool', () => {
    expect(isSolanaPage('/earn/sol-streamflow')).toBe(true);
    expect(isSolanaPage('/earn/sol-ladder')).toBe(true);
  });

  // /earn/<a dark room> is no pool page at all: it redirects to the list (earnRoutes isEarnPoolId).
  it('is false for a Solana room that is not live', () => {
    expect(isSolanaPage('/earn/sol-dark')).toBe(false);
  });

  // BungalowFarmPanel draws the dark "being built" card there, with no wallet section.
  it('is false for a Solana room with no pool yet', () => {
    expect(isSolanaPage('/earn/sol-no-pool')).toBe(false);
  });

  it('is false for a room on another chain', () => {
    expect(isSolanaPage('/earn/base-pool')).toBe(false);
  });
});
