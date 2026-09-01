// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { recordActivity, getActivity, timeAgo } from './solanaActivity';

describe('solana activity record', () => {
  let store: Record<string, string>;

  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = v; },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const entry = (sig: string, ts = 1) => ({ sig, ts, kind: 'swap' as const, summary: `swap ${sig}` });

  it('records newest-first, per wallet, capped at 25, deduped by signature', () => {
    for (let i = 0; i < 30; i++) recordActivity('W1', entry(`S${i}`, i));
    recordActivity('W2', entry('OTHER'));
    recordActivity('W1', entry('S29', 99)); // resubmit dedupes, moves to front
    const w1 = getActivity('W1');
    expect(w1.length).toBe(25);
    expect(w1[0]!.sig).toBe('S29');
    expect(w1.filter((e) => e.sig === 'S29').length).toBe(1);
    expect(getActivity('W2').map((e) => e.sig)).toEqual(['OTHER']);
  });

  it('drops corrupt rows and degrades to empty without storage', () => {
    store['sol.activity.W1'] = JSON.stringify([entry('OK'), { sig: 42 }, 'junk']);
    expect(getActivity('W1').map((e) => e.sig)).toEqual(['OK']);
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    expect(() => recordActivity('W1', entry('X'))).not.toThrow();
    expect(getActivity('W1')).toEqual([]);
  });

  it('formats coarse time-ago buckets', () => {
    const now = 1_000_000_000_000;
    expect(timeAgo(now - 30_000, now)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d ago');
  });
});
