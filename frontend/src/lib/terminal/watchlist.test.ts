import { describe, it, expect, beforeEach } from 'vitest';
import {
  WATCHLIST_MAX,
  WATCHLIST_STORAGE_KEY,
  isWatched,
  loadWatchlist,
  normalizeWatchKey,
  parseWatchlist,
  saveWatchlist,
  toggleWatch,
} from './watchlist';

// The watchlist stores addresses and nothing else, so most of what could go wrong
// here is corruption rather than dishonesty. The one honesty property it does have
// is that a key which can never match a row is refused at the door: a watch that
// silently matches nothing looks identical to a watch on a pair that never trades.

beforeEach(() => {
  localStorage.clear();
});

describe('keys are the form the indexer stores', () => {
  it('folds an address to lowercase so a checksummed paste still matches a row', () => {
    expect(normalizeWatchKey('0xAbCdEf0123456789AbCdEf0123456789AbCdEf01')).toBe(
      '0xabcdef0123456789abcdef0123456789abcdef01',
    );
  });

  it('refuses anything that is not an address rather than storing a dead key', () => {
    for (const bad of ['', '  ', 'not-an-address', '0x123', 'So1anaMintAddress11111111111111111111111']) {
      expect(normalizeWatchKey(bad)).toBeNull();
    }
  });
});

describe('a corrupt store degrades to empty, never to a throw', () => {
  it('survives junk', () => {
    for (const junk of [null, '', 'not json', '{"a":1}', '[1,2,3]', '["nope"]']) {
      expect(parseWatchlist(junk)).toEqual([]);
    }
  });

  it('drops malformed entries but keeps the good ones', () => {
    const good = '0x1111111111111111111111111111111111111111';
    expect(parseWatchlist(JSON.stringify([good, 'junk', 42, null]))).toEqual([good]);
  });

  it('de-duplicates across casing', () => {
    const a = '0x1111111111111111111111111111111111111111';
    expect(parseWatchlist(JSON.stringify([a, a.toUpperCase().replace('0X', '0x')]))).toEqual([a]);
  });

  it('caps a hostile store', () => {
    const many = Array.from({ length: WATCHLIST_MAX + 50 }, (_, i) =>
      `0x${i.toString(16).padStart(40, '0')}`,
    );
    expect(parseWatchlist(JSON.stringify(many))).toHaveLength(WATCHLIST_MAX);
  });
});

describe('toggling', () => {
  const a = '0x1111111111111111111111111111111111111111';
  const b = '0x2222222222222222222222222222222222222222';

  it('adds, removes, and does not mutate the input', () => {
    const start: string[] = [];
    const added = toggleWatch(start, a);
    expect(added).toEqual([a]);
    expect(start).toEqual([]);
    expect(toggleWatch(added, a)).toEqual([]);
  });

  it('is case-insensitive on removal', () => {
    expect(toggleWatch([a], a.toUpperCase().replace('0X', '0x'))).toEqual([]);
  });

  it('ignores a malformed address instead of storing it', () => {
    expect(toggleWatch([a], 'garbage')).toEqual([a]);
  });

  it('drops the OLDEST entry at the cap so the newest intent survives', () => {
    const full = Array.from({ length: WATCHLIST_MAX }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
    const next = toggleWatch(full, b);
    expect(next).toHaveLength(WATCHLIST_MAX);
    expect(next[next.length - 1]).toBe(b);
    expect(next[0]).toBe(full[1]);
  });

  it('isWatched agrees with the list, case-insensitively', () => {
    expect(isWatched([a], a.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(isWatched([a], b)).toBe(false);
    expect(isWatched([a], 'garbage')).toBe(false);
  });
});

describe('round trip through storage', () => {
  it('saves and reloads', () => {
    const a = '0x1111111111111111111111111111111111111111';
    expect(saveWatchlist([a])).toBe(true);
    expect(localStorage.getItem(WATCHLIST_STORAGE_KEY)).toBe(JSON.stringify([a]));
    expect(loadWatchlist()).toEqual([a]);
  });

  it('uses a prefix the storage sweeper can reclaim', () => {
    expect(WATCHLIST_STORAGE_KEY.startsWith('tegridy-')).toBe(true);
  });
});
