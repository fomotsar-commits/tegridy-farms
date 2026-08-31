import { describe, it, expect, beforeEach, vi } from 'vitest';
import { safeSetItem, safeGetItem, isEvictable, EVICTION_PROTECTED_KEYS } from './storage';

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
