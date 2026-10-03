import { describe, it, expect } from 'vitest';
import { routeVoice, isToweliRoomPage, isSolanaPage, TOWELI_ROOM_PATHS } from './routeVoice';
import { BUNGALOWS } from './bungalows';

describe('routeVoice (wave seven, row Q)', () => {
  it('puts TOWELI protocol pages and TOWELI doors in the TOWELI room', () => {
    for (const p of ['/tokenomics', '/treasury', '/premium', '/lore', '/referrals', '/zap', '/earn/toweli', '/toweli', '/towelie']) {
      expect(routeVoice(p), p).toBe('toweli');
    }
  });

  it('gives other residents their doors, and the venue its records and its terms', () => {
    expect(routeVoice('/bayla')).toBe('bungalow');
    expect(routeVoice('/pepe')).toBe('bungalow');
    expect(routeVoice('/changelog')).toBe('record');
    expect(routeVoice('/contracts')).toBe('record');
    expect(routeVoice('/terms')).toBe('legal');
  });

  it('leaves every other route with the venue, the venue tools included', () => {
    for (const p of ['/', '/faq', '/security', '/earn', '/farm', '/vesting', '/airdrop', '/history', '/launch/0xabc']) {
      expect(routeVoice(p), p).toBe('venue');
    }
  });

  it('ignores a trailing slash, and never bands the room\'s own doors', () => {
    expect(routeVoice('/tokenomics/')).toBe('toweli');
    expect(isToweliRoomPage('/tokenomics/')).toBe(true);
    expect(isToweliRoomPage('/toweli')).toBe(false);
    expect(TOWELI_ROOM_PATHS.size).toBe(7);
  });
});

describe("isSolanaPage: where the top bar's Connect connects Solana", () => {
  it("is true for the venue's Solana pages, with or without a trailing slash", () => {
    for (const p of ['/solana', '/pools', '/pools/', '/curve-launch', '/curve-launch/', '/curve-launch/So11111111111111111111111111111111111111112']) {
      expect(isSolanaPage(p), p).toBe(true);
    }
  });

  // Computed from the registry, so a new Solana pool is covered the day it is added.
  it('is true for every live Solana room with a pool, and for no other room', () => {
    const solanaRooms = BUNGALOWS.filter((b) => b.live && b.chain === 'solana' && (b.stakePool || b.ladderPool));
    expect(solanaRooms.map((b) => b.id)).toContain('bayla');
    for (const b of BUNGALOWS) {
      expect(isSolanaPage(`/earn/${b.id}`), b.id).toBe(solanaRooms.includes(b));
    }
  });

  it('is false for the Ethereum pages, the lists and the doors', () => {
    for (const p of ['/', '/swap', '/liquidity', '/launch', '/eth-curve', '/earn', '/earn/', '/earn/toweli', '/earn/pepe', '/earn/nope', '/bayla', '/curve-launchpad', '/solanaX', '/earn/bayla/x']) {
      expect(isSolanaPage(p), p).toBe(false);
    }
  });

  it('reads /dashboard by the room, as DashboardPage does', () => {
    expect(isSolanaPage('/dashboard', { chain: 'solana' })).toBe(true);
    expect(isSolanaPage('/dashboard', { chain: 'ethereum' })).toBe(false);
    expect(isSolanaPage('/dashboard', { chain: 'base' })).toBe(false);
    expect(isSolanaPage('/dashboard', null)).toBe(false);
    expect(isSolanaPage('/dashboard')).toBe(false);
  });
});
