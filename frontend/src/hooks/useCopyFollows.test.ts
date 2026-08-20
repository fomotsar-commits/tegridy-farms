// The local store, through the hook: a rejected follow changes nothing, and a
// write the browser refused is reported rather than swallowed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const { safeSetItemMock } = vi.hoisted(() => ({ safeSetItemMock: vi.fn() }));

vi.mock('../lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/storage')>();
  return { ...actual, safeSetItem: safeSetItemMock };
});

import { useCopyFollows } from './useCopyFollows';
import { loadFollows, type MirrorIntent } from '../lib/copytrade/follows';

const LEADER = '0xabcdef0123456789abcdef0123456789abcdef01';
const FOLLOWER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const OUT = '0x2222222222222222222222222222222222222222';
const NOW = 1_780_000_000;

const draft = {
  leader: LEADER,
  quoteToken: QUOTE,
  maxNotionalWei: 10n ** 17n,
  slippageBps: 100,
  now: NOW,
};

beforeEach(() => {
  localStorage.clear();
  safeSetItemMock.mockReset();
  safeSetItemMock.mockImplementation((key: string, value: string) => {
    localStorage.setItem(key, value);
    return true;
  });
});

afterEach(() => {
  localStorage.clear();
});

describe('useCopyFollows', () => {
  it('adds a follow and persists it', () => {
    const { result } = renderHook(() => useCopyFollows());
    act(() => {
      expect(result.current.addFollow(draft).ok).toBe(true);
    });
    expect(result.current.follows).toHaveLength(1);
    expect(result.current.persistError).toBeNull();
    expect(loadFollows()[0]!.leader).toBe(LEADER);
  });

  it('leaves the list untouched when validation rejects', () => {
    // A rejected draft must not half-apply. The reason travels back to the form
    // instead, which is what lets the form say what was wrong rather than
    // silently saving something adjacent.
    const { result } = renderHook(() => useCopyFollows());
    let reason = '';
    act(() => {
      const outcome = result.current.addFollow({ ...draft, maxNotionalWei: 0n });
      if (!outcome.ok) reason = outcome.reason;
    });
    expect(reason).toBe('cap-not-positive');
    expect(result.current.follows).toEqual([]);
    expect(safeSetItemMock).not.toHaveBeenCalled();
  });

  it('reports a refused write instead of pretending it stuck', () => {
    // A cap that looks saved and is gone on reload teaches a user that the one
    // control bounding their trade size is decorative.
    safeSetItemMock.mockReturnValue(false);
    const { result } = renderHook(() => useCopyFollows());
    act(() => {
      result.current.addFollow(draft);
    });
    expect(result.current.follows).toHaveLength(1);
    expect(result.current.persistError).toMatch(/will not survive a reload/i);
  });

  it('removes only the matching leader-and-quote pair', () => {
    const { result } = renderHook(() => useCopyFollows());
    act(() => {
      result.current.addFollow(draft);
    });
    act(() => {
      result.current.addFollow({ ...draft, quoteToken: '0x420698CFdEDdEa6bc78D59bC17798113ad278F9D' });
    });
    expect(result.current.follows).toHaveLength(2);
    act(() => {
      result.current.removeFollow(LEADER.toUpperCase(), QUOTE.toUpperCase());
    });
    expect(result.current.follows).toHaveLength(1);
    expect(result.current.follows[0]!.quoteToken).toBe('0x420698cfdeddea6bc78d59bc17798113ad278f9d');
  });

  it('records a mirror as an intent, and a second confirmation as the same one', () => {
    const intent: MirrorIntent = {
      leader: LEADER,
      leaderTxHash: `0x${'ab'.repeat(32)}`,
      leaderTimestamp: NOW - 60,
      confirmedAt: NOW,
      follower: FOLLOWER,
      quoteToken: QUOTE,
      tokenOut: OUT,
      notionalWei: 10n ** 16n,
    };
    const { result } = renderHook(() => useCopyFollows());
    act(() => {
      result.current.recordMirror(intent);
    });
    act(() => {
      result.current.recordMirror({ ...intent, confirmedAt: NOW + 5 });
    });
    expect(result.current.intents).toHaveLength(1);
    expect(result.current.intents[0]!.confirmedAt).toBe(NOW + 5);
  });
});
