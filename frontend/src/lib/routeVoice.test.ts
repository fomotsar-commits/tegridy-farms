import { describe, it, expect } from 'vitest';
import { routeVoice, isToweliRoomPage, isSolanaPage, hasMixedSolanaSection, TOWELI_ROOM_PATHS } from './routeVoice';
import { BUNGALOWS } from './bungalows';
import { NAV_SECTIONS } from './navConfig';
import { tabChains } from './sectionChains';

describe('routeVoice (wave seven, row Q)', () => {
  it('puts TOWELI protocol pages and TOWELI doors in the TOWELI room', () => {
    for (const p of ['/tokenomics', '/treasury', '/premium', '/lore', '/zap', '/earn/toweli', '/toweli', '/towelie']) {
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
    expect(TOWELI_ROOM_PATHS.size).toBe(6);
  });
});

describe("isSolanaPage: where the top bar's Connect connects Solana", () => {
  it("is true for the venue's Solana pages, with or without a trailing slash", () => {
    // /solana-lp mounts the same Solana section as /pools: left out, the top bar
    // mounted its own connection there and the page then took it away mid-approval.
    // /range-pools mounts its own (RangeSection's SolanaProviders) the same way.
    for (const p of ['/solana', '/pools', '/pools/', '/solana-lp', '/solana-lp/', '/range-pools', '/range-pools/', '/curve-launch', '/curve-launch/', '/curve-launch/So11111111111111111111111111111111111111112']) {
      expect(isSolanaPage(p), p).toBe(true);
    }
  });

  // Computed from the nav, so a new Solana tab is covered the day it is listed: /range-pools
  // was listed with no entry here, and the top bar would have mounted its own connection.
  it('is true for every tab that runs on Solana alone', () => {
    const solanaTabs = NAV_SECTIONS.flatMap((s) => s.items).map((i) => i.to).filter((to) => {
      const c = tabChains(to);
      return Array.isArray(c) && c.length === 1 && c[0] === 'solana';
    });
    expect(solanaTabs).toContain('/range-pools');
    for (const to of solanaTabs) expect(isSolanaPage(to), to).toBe(true);
  });

  // Computed from the registry, so a new Solana pool is covered the day it is added.
  it('is true for every live Solana room with a pool, and for no other room', () => {
    const solanaRooms = BUNGALOWS.filter((b) => b.live && b.chain === 'solana' && (b.stakePool || b.ladderPool));
    expect(solanaRooms.map((b) => b.id)).toContain('bayla');
    for (const b of BUNGALOWS) {
      expect(isSolanaPage(`/earn/${b.id}`), b.id).toBe(solanaRooms.includes(b));
    }
  });

  // The router matches these whatever their case and decodes them, and the page
  // then draws its Solana section. Read as "not a Solana page", the top bar
  // mounted its own connection under the page's.
  it('is true for those routes written in another case or percent-encoded, as the router matches them', () => {
    for (const p of ['/Earn/bayla', '/EARN/bayla', '/earn/%62ayla', '/Curve-Launch/So11111111111111111111111111111111111111112']) {
      expect(isSolanaPage(p), p).toBe(true);
    }
    expect(isSolanaPage('/Dashboard', { chain: 'solana' })).toBe(true);
    expect(isSolanaPage('/Dashboard', { chain: 'ethereum' })).toBe(false);
    // The pool id and the mint are read as written by the pages themselves.
    expect(isSolanaPage('/earn/BAYLA')).toBe(false);
    // The four tabs match exactly: /POOLS draws the Ethereum tab.
    expect(isSolanaPage('/POOLS')).toBe(false);
    expect(isSolanaPage('/Solana-LP')).toBe(false);
    // A malformed escape is judged as written, and throws nothing.
    expect(isSolanaPage('/earn/%E0%A4%A')).toBe(false);
  });

  // That page draws "Not a token address" and mounts no wallet section.
  it('is false for a launch page whose address is not an address', () => {
    for (const p of ['/curve-launch/nope', '/curve-launch/0xabc', '/curve-launch/So1111111111111111111111111111111111111111O', '/curve-launch/So11111111111111111111111111111111111111112/x']) {
      expect(isSolanaPage(p), p).toBe(false);
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

// The home, the island lobby and BAYLA's door carry the same three cards (components/VenueCards.tsx),
// whose Solana connection is the top bar's there. Missed on a page that has them, the top bar
// mounts a second connection beside the cards', and the two disagree (owner, 2026-10-19: the
// cards on the island page, then on /bayla: "on here").
describe('hasMixedSolanaSection: the pages whose cards are the Solana connection', () => {
  it("is the home, the island lobby and BAYLA's door, as the router matches them", () => {
    for (const p of ['/', '', '/island', '/island/', '/Island', '/ISLAND', '/%69sland', '/bayla', '/bayla/', '/BAYLA']) {
      expect(hasMixedSolanaSection(p), p).toBe(true);
    }
  });

  // Another room's door: the cards are BAYLA's coin's (lib/bungalows.ts CARDS_ROOM_ID).
  it('is no other page, and no other room', () => {
    for (const p of ['/gallery', '/bobo', '/pepe', '/toweli', '/baylax', '/islands', '/island/x', '/solana', '/earn/bayla', '/%E0%A4%A']) {
      expect(hasMixedSolanaSection(p), p).toBe(false);
    }
  });
});
