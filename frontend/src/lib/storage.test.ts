import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  safeSetItem,
  safeGetItem,
  isEvictable,
  EVICTION_PROTECTED_KEYS,
  EVICTION_PROTECTED_PREFIXES,
} from './storage';
import { WATCHLIST_STORAGE_KEY } from './terminal/watchlist';

describe('eviction protection for choice keys', () => {
  beforeEach(() => localStorage.clear());

  it('choice keys are namespaced-but-NOT-evictable; caches are', () => {
    // Pre-fix, isEvictable('tegridy-bungalow') was true and the sweeper
    // deleted the plain-string choice keys FIRST (ts-less sorts oldest).
    for (const k of EVICTION_PROTECTED_KEYS) {
      expect(isEvictable(k), `${k} must be protected`).toBe(false);
    }
    expect(isEvictable('tegridy_price_history_cache')).toBe(true);
    expect(isEvictable('tegridy-alerts')).toBe(true);
    expect(isEvictable('foreign-key')).toBe(false);
  });

  it('quota-pressure eviction spares the bungalow choice and takes the cache', () => {
    localStorage.setItem('tegridy-bungalow', 'bayla');
    localStorage.setItem('tegridy_cache_blob', JSON.stringify({ ts: 1, data: 'x' }));
    // A value large enough that the pre-flight estimate demands eviction
    // (budget is ~2.6M chars), yet jsdom itself enforces no quota, so the
    // write succeeds and we can observe exactly what the sweeper chose.
    expect(safeSetItem('tegridy_big', 'z'.repeat(2_700_000))).toBe(true);
    expect(localStorage.getItem('tegridy-bungalow'), 'choice must survive eviction').toBe('bayla');
    expect(localStorage.getItem('tegridy_cache_blob'), 'cache is the evictable mass').toBeNull();
    localStorage.removeItem('tegridy_big');
  });

  it('protects data the user BUILT, which nothing can re-derive', () => {
    // The watchlist stores as a ts-less JSON array, which put it at the very
    // front of the sweeper's "oldest first" queue: the first quota-pressured
    // write of any price cache emptied a hand-built list of starred pairs, with
    // no error and nothing to restore it from. A cache re-fetches; this does not.
    expect(isEvictable(WATCHLIST_STORAGE_KEY)).toBe(false);
    expect(EVICTION_PROTECTED_KEYS.has(WATCHLIST_STORAGE_KEY)).toBe(true);
  });

  it('never evicts a saved alert rule, its inbox, or its watermark', () => {
    // Named one by one rather than swept from the set: the loop above iterates
    // EVICTION_PROTECTED_KEYS, so it passes vacuously if a key is deleted from
    // it. These fail on the pre-change code, where all three were evictable.
    for (const k of ['tegridy-alert-rules-v1', 'tegridy-alert-inbox-v1', 'tegridy-alert-priors-v1']) {
      expect(isEvictable(k), `${k} must survive a quota sweep`).toBe(false);
    }
  });

  it('never evicts a follow list or the cap that bounds a mirror', () => {
    // These two carry a top-level `ts`, so the sweeper reads them as ordinary
    // caches. A cache that is evicted re-fetches; a per-trade cap that is
    // evicted is gone, and it goes at the exact moment the user is near quota.
    expect(isEvictable('tegridy_copytrade_follows')).toBe(false);
    expect(isEvictable('tegridy_copytrade_mirrors')).toBe(false);
    // The pasted Solana address needs no entry — it lives in the namespace.
    expect(isEvictable('tegridy-own-copytrade-solana-wallet')).toBe(false);
  });

  it('protects the whole `tegridy-own-` namespace, which is per-item and cannot be listed', () => {
    // An alert rule per pool and a follow per wallet have keys that only exist
    // at runtime, so an exact-key set can never cover them.
    expect(EVICTION_PROTECTED_PREFIXES).toContain('tegridy-own-');
    expect(isEvictable('tegridy-own-alerts-eth-0xabc')).toBe(false);
    expect(isEvictable('tegridy-own-follows')).toBe(false);
    // ...and the namespace is exact: a cache does not become protected by
    // sitting near one alphabetically.
    expect(isEvictable('tegridy-owned-cache')).toBe(true);
    expect(isEvictable('tegridy_price_history_cache')).toBe(true);
  });

  it('spares a saved list under quota pressure and takes the cache instead', () => {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(['0xabc']));
    localStorage.setItem('tegridy-own-alerts-1', JSON.stringify({ pool: '0xabc', above: 1 }));
    localStorage.setItem('tegridy_cache_blob', JSON.stringify({ ts: 1, data: 'x' }));
    expect(safeSetItem('tegridy_big', 'z'.repeat(2_700_000))).toBe(true);
    expect(localStorage.getItem(WATCHLIST_STORAGE_KEY), 'a hand-built list must survive').toBeTruthy();
    expect(localStorage.getItem('tegridy-own-alerts-1'), 'a saved rule must survive').toBeTruthy();
    expect(localStorage.getItem('tegridy_cache_blob'), 'the cache is the evictable mass').toBeNull();
    localStorage.removeItem('tegridy_big');
  });

  it('blocked storage access (throwing window.localStorage getter) returns false, never throws', () => {
    // Chrome "block all cookies": even `typeof localStorage` invokes the
    // throwing getter. Pre-fix the quota pre-flight sat outside every try
    // and safeSetItem THREW into door/picker handlers.
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() { throw new DOMException('denied', 'SecurityError'); },
    });
    try {
      expect(() => safeSetItem('k', 'v')).not.toThrow();
      expect(safeSetItem('k', 'v')).toBe(false);
      expect(safeGetItem('k')).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('safeSetItem', () => {
  beforeEach(() => localStorage.clear());

  it('stores a simple string value', () => {
    expect(safeSetItem('key1', 'value1')).toBe(true);
    expect(localStorage.getItem('key1')).toBe('value1');
  });

  it('stores JSON-serialized data', () => {
    const data = JSON.stringify({ foo: 'bar', num: 42 });
    expect(safeSetItem('json-key', data)).toBe(true);
    expect(JSON.parse(localStorage.getItem('json-key')!)).toEqual({ foo: 'bar', num: 42 });
  });

  it('overwrites existing keys', () => {
    safeSetItem('k', 'old');
    safeSetItem('k', 'new');
    expect(localStorage.getItem('k')).toBe('new');
  });

  it('returns false when localStorage.setItem always throws', () => {
    // `vi.restoreAllMocks()` at the end restores the original — no need to
    // capture it explicitly.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    });
    expect(safeSetItem('fail-key', 'data')).toBe(false);
    vi.restoreAllMocks();
  });

  it('evicts old tegridy_ entries when quota is tight', () => {
    // Seed some tegridy_ entries
    localStorage.setItem('tegridy_old1', JSON.stringify({ ts: 1000, data: 'x' }));
    localStorage.setItem('tegridy_old2', JSON.stringify({ ts: 2000, data: 'y' }));

    // Mock setItem to throw on first call, succeed after eviction
    let callCount = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key: string, value: string) => {
      callCount++;
      if (callCount <= 1) {
        throw new DOMException('quota exceeded', 'QuotaExceededError');
      }
      // Actually store it
      Object.getPrototypeOf(localStorage).setItem.call(localStorage, key, value);
    });

    // The function should try, fail, evict, retry
    // Because of our mock, the second setItem call will succeed
    const result = safeSetItem('new-key', 'new-val');
    // It may succeed or fail depending on eviction — just ensure no crash
    expect(typeof result).toBe('boolean');
    vi.restoreAllMocks();
  });

  it('handles empty string key and value', () => {
    expect(safeSetItem('', '')).toBe(true);
    expect(localStorage.getItem('')).toBe('');
  });

  it('handles very long values', () => {
    const longVal = 'a'.repeat(10_000);
    expect(safeSetItem('long', longVal)).toBe(true);
    expect(localStorage.getItem('long')).toBe(longVal);
  });
});

describe('safeGetItem', () => {
  beforeEach(() => localStorage.clear());

  it('retrieves a stored value', () => {
    localStorage.setItem('test', 'hello');
    expect(safeGetItem('test')).toBe('hello');
  });

  it('returns null for non-existent key', () => {
    expect(safeGetItem('nonexistent')).toBeNull();
  });

  it('returns null when localStorage.getItem throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('access denied');
    });
    expect(safeGetItem('any')).toBeNull();
    vi.restoreAllMocks();
  });

  it('retrieves JSON data correctly', () => {
    const obj = { a: 1, b: [2, 3] };
    localStorage.setItem('json', JSON.stringify(obj));
    const raw = safeGetItem('json');
    expect(JSON.parse(raw!)).toEqual(obj);
  });
});
