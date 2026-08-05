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
import { COLLECTIONS, DEFAULT_COLLECTION } from './constants';

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
