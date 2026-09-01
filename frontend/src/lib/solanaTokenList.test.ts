// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isUnverified,
  findSolToken,
  SOL,
  USDC,
  BUY_TOKENS,
  LST_TOKENS,
  rememberToken,
  getRecentTokens,
  getFavoriteTokens,
  toggleFavoriteToken,
  isFavoriteToken,
} from './solanaTokenList';

describe('isUnverified — the one verified/unverified decision', () => {
  it('treats an UNSET flag as unverified (the curated BAYLA case)', () => {
    // BAYLA deliberately leaves `verified` unset — Jupiter's tag would be a
    // lie — and its own comment expects the Unverified chip to render. The
    // old `=== false` checks silently exempted it from the badge AND the
    // risk-ack gate; this pin fails on that shape.
    const bayla = findSolToken('7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump');
    expect(bayla).toBeDefined();
    expect(bayla!.verified).toBeUndefined();
    expect(isUnverified(bayla!)).toBe(true);
  });

  it('treats an explicit false as unverified', () => {
    expect(isUnverified({ ...SOL, verified: false })).toBe(true);
  });

  it('only an explicit true passes', () => {
    expect(isUnverified(SOL)).toBe(false);
    expect(isUnverified(USDC)).toBe(false);
  });

  it('every curated featured/LST token except BAYLA is explicitly verified', () => {
    // Breadth guard the other way: `!== true` must not suddenly badge the
    // whole curated shortlist. If a future curated entry legitimately lacks
    // Jupiter verification, list it here with the reason, like BAYLA.
    const knownUnverified = new Set(['7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump']);
    for (const t of [...BUY_TOKENS, ...LST_TOKENS]) {
      if (knownUnverified.has(t.mint)) continue;
      expect(t.verified, `${t.symbol} (${t.mint})`).toBe(true);
    }
  });
});

describe('recents + favorites store', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('remembers picks front-first, deduped, capped at 8', () => {
    for (let i = 0; i < 10; i++) {
      rememberToken({ mint: `M${i}`, symbol: `T${i}`, name: `Tok ${i}`, decimals: 6 });
    }
    rememberToken({ mint: 'M5', symbol: 'T5', name: 'Tok 5', decimals: 6 });
    const recents = getRecentTokens();
    expect(recents.length).toBe(8);
    expect(recents[0]!.mint).toBe('M5'); // re-pick moves to front, no duplicate
    expect(recents.filter((t) => t.mint === 'M5').length).toBe(1);
  });

  it('stores full tokens so decimals survive offline, and drops corrupt rows', () => {
    rememberToken({ ...SOL });
    store['sol.recents'] = JSON.stringify([
      ...JSON.parse(store['sol.recents']!),
      { mint: 'NoDecimals', symbol: 'X' }, // corrupt: decimals missing
      'garbage',
    ]);
    const recents = getRecentTokens();
    expect(recents.length).toBe(1);
    expect(recents[0]!.decimals).toBe(9);
  });

  it('toggles favorites and reports state', () => {
    expect(isFavoriteToken(USDC.mint)).toBe(false);
    expect(toggleFavoriteToken(USDC)).toBe(true);
    expect(isFavoriteToken(USDC.mint)).toBe(true);
    expect(getFavoriteTokens()[0]!.mint).toBe(USDC.mint);
    expect(toggleFavoriteToken(USDC)).toBe(false);
    expect(getFavoriteTokens()).toEqual([]);
  });

  it('degrades to empty, never throws, when storage is unavailable', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    });
    expect(() => rememberToken(SOL)).not.toThrow();
    expect(getRecentTokens()).toEqual([]);
    expect(getFavoriteTokens()).toEqual([]);
  });
});
