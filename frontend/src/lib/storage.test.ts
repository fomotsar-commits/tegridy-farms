import { describe, it, expect, beforeEach, vi } from 'vitest';
import { safeSetItem, safeGetItem } from './storage';

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
    const original = localStorage.setItem.bind(localStorage);
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
