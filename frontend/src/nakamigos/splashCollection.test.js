// The splash's collection resolver decides which collection's STATS a visitor is
// told about on the very first screen. It got that wrong for every collection
// except one.
//
// `/nakamigos` is simultaneously the route mount prefix and a collection key, so
// scanning path segments forwards always matched the prefix first. Entering
// /nakamigos/gnssart therefore reported Nakamigos' 20,000 supply for a
// 9,696-piece collection — a factual claim, wrong by more than 2x, before the
// visitor has clicked anything.

import { describe, it, expect } from 'vitest';
import { resolveSplashCollectionFromPath } from './components/SplashScreen';
import { COLLECTIONS, DEFAULT_COLLECTION, LOADING_MESSAGES } from './constants';

describe('splash collection resolver', () => {
  it('resolves the DEEPEST collection segment, not the mount prefix', () => {
    // The regression itself.
    expect(resolveSplashCollectionFromPath('/nakamigos/gnssart')).toBe('gnssart');
    expect(resolveSplashCollectionFromPath('/nakamigos/junglebay')).toBe('junglebay');
  });

  it('still resolves the prefix when it is the only collection in the path', () => {
    expect(resolveSplashCollectionFromPath('/nakamigos')).toBe('nakamigos');
    expect(resolveSplashCollectionFromPath('/nakamigos/')).toBe('nakamigos');
  });

  it('ignores trailing non-collection segments', () => {
    expect(resolveSplashCollectionFromPath('/nakamigos/gnssart/trade')).toBe('gnssart');
    expect(resolveSplashCollectionFromPath('/nakamigos/junglebay/analytics')).toBe('junglebay');
  });

  it('falls back to the default for an unknown or empty path', () => {
    expect(resolveSplashCollectionFromPath('/swap')).toBe(DEFAULT_COLLECTION);
    expect(resolveSplashCollectionFromPath('')).toBe(DEFAULT_COLLECTION);
    expect(resolveSplashCollectionFromPath(null)).toBe(DEFAULT_COLLECTION);
  });

  it('the collections it resolves to really do declare different supplies', () => {
    // Guards the premise: if every collection shared a supply the bug would be
    // invisible, and this test would be pinning nothing.
    const supplies = Object.values(COLLECTIONS).map((c) => c.supply).filter(Boolean);
    expect(new Set(supplies).size).toBeGreaterThan(1);
    expect(COLLECTIONS.gnssart.supply).not.toBe(COLLECTIONS.nakamigos.supply);
  });
});

// The splash is the first screen a visitor sees, so it must not speak for a
// collection it does not know. The family collections have no loading lines
// of their own (nothing is invented for them), and an ERC-1155 has no single
// supply, so neither may fall back to Nakamigos' copy or Nakamigos' 20,000.
describe('splash copy for the Jungle Bay family', () => {
  const splash = () => import('./components/SplashScreen');

  it('resolves a family collection from its route', () => {
    expect(resolveSplashCollectionFromPath('/nakamigos/bojungles/about')).toBe('bojungles');
    expect(resolveSplashCollectionFromPath('/nakamigos/junglebaygoldcards/nft/5')).toBe('junglebaygoldcards');
  });

  it('a collection with no loading lines gets generic ones, never another collection\'s', async () => {
    const { splashLoadingLines } = await splash();
    const lines = splashLoadingLines('bojungles');
    expect(Array.isArray(lines)).toBe(true);
    const others = Object.values(LOADING_MESSAGES).flat();
    for (const l of lines) {
      expect(others, l).not.toContain(l);
      expect(l).not.toMatch(/Ghost|Nakamigo|Eom|rug pull/i);
    }
    expect(splashLoadingLines('nakamigos')).toEqual(LOADING_MESSAGES.nakamigos);
  });

  it('WORKS is the registry supply, and is absent where there is no single supply', async () => {
    const { splashPlaques } = await splash();
    const works = (slug) => splashPlaques(slug).find((p) => p.label === 'WORKS');
    expect(works('junglebaygoldcards')?.val).toBe('123');
    expect(works('memeticseeds')?.val).toBe('369');
    expect(works('junglets')?.val).toBe('208');
    expect(works('junglebaymemes')).toBeUndefined();
    expect(works('raretowelie')).toBeUndefined();
    expect(works('nakamigos')?.val).toBe('20,000');
  });

  it('STANDARD and CHAIN read the registry tags for all six', async () => {
    const { splashPlaques } = await splash();
    for (const slug of ['junglebaygoldcards', 'junglebaymemes', 'memeticseeds', 'junglets', 'bojungles', 'raretowelie']) {
      const plaque = Object.fromEntries(splashPlaques(slug).map((p) => [p.label, p.val]));
      expect(plaque.STANDARD, slug).toBe(COLLECTIONS[slug]?.tags?.[0]);
      expect(plaque.CHAIN, slug).toBe(COLLECTIONS[slug]?.tags?.[1]);
    }
    const junglets = Object.fromEntries(splashPlaques('junglets').map((p) => [p.label, p.val]));
    expect(junglets.STANDARD).toBe('METAPLEX PNFT');
    expect(junglets.CHAIN).toBe('SOLANA');
  });
});
