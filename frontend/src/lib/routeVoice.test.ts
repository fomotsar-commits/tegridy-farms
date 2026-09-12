import { describe, it, expect } from 'vitest';
import { routeVoice, isToweliRoomPage, TOWELI_ROOM_PATHS } from './routeVoice';

describe('routeVoice (wave seven, row Q)', () => {
  it('puts TOWELI protocol pages and TOWELI doors in the TOWELI room', () => {
    for (const p of ['/tokenomics', '/treasury', '/premium', '/lore', '/referrals', '/zap', '/toweli', '/towelie']) {
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
    for (const p of ['/', '/faq', '/security', '/farm', '/vesting', '/airdrop', '/history', '/launch/0xabc']) {
      expect(routeVoice(p), p).toBe('venue');
    }
  });

  it('ignores a trailing slash, and never bands the room\'s own doors', () => {
    expect(routeVoice('/tokenomics/')).toBe('toweli');
    expect(isToweliRoomPage('/tokenomics/')).toBe(true);
    expect(isToweliRoomPage('/toweli')).toBe(false);
    expect(TOWELI_ROOM_PATHS.size).toBe(6);
  });
});
