// The local store, through the hook: a rejected follow changes nothing, and a
// write the browser refused is reported rather than swallowed.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StrictMode, createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';

const { safeSetItemMock } = vi.hoisted(() => ({ safeSetItemMock: vi.fn() }));

vi.mock('../lib/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/storage')>();
  return { ...actual, safeSetItem: safeSetItemMock };
});

import { useCopyFollows, useSolanaFollowerAddress } from './useCopyFollows';
import { loadFollows, type MirrorIntent } from '../lib/copytrade/follows';

const LEADER = '0xabcdef0123456789abcdef0123456789abcdef01';
const FOLLOWER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const OUT = '0x2222222222222222222222222222222222222222';
const NOW = 1_780_000_000;

const draft = {
  // Every follow now names its venue: the island spans three chains and the
  // quote-token table is per-chain, so an address without a venue cannot be
  // validated against anything.
  venue: 'evm' as const,
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
      venue: 'evm',
      leader: LEADER,
      leaderTxHash: `0x${'ab'.repeat(32)}`,
      leaderTimestamp: NOW - 60,
      confirmedAt: NOW,
      follower: FOLLOWER,
      quoteToken: QUOTE,
      tokenOut: OUT,
      notionalWei: 10n ** 16n,
      poolKey: null,
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

  // PERF-13. `removeFollow` and `recordMirror` did their localStorage write and
  // a second setState INSIDE the updater handed to setState. StrictMode
  // double-invokes updaters ON PURPOSE, so each of these performed its durable
  // write twice per action in development — and a render React discarded would
  // have written for a state change that never happened. The app mounts under
  // StrictMode (src/main.tsx), so this wrapper is the real environment, not a
  // contrived one.
  describe('under StrictMode, one action is one durable write', () => {
    // `createElement` rather than JSX: this file is `.ts`, and renaming it to
    // `.tsx` would move it out of whatever glob the collection guard pins it under.
    const wrapper = ({ children }: { children: ReactNode }) => createElement(StrictMode, null, children);

    it('writes once when a follow is removed', () => {
      const { result } = renderHook(() => useCopyFollows(), { wrapper });
      act(() => {
        result.current.addFollow(draft);
      });
      safeSetItemMock.mockClear();

      act(() => {
        result.current.removeFollow(LEADER, QUOTE);
      });

      expect(safeSetItemMock).toHaveBeenCalledTimes(1);
      expect(result.current.follows).toHaveLength(0);
    });

    it('writes once when a mirror is recorded', () => {
      const intent: MirrorIntent = {
        venue: 'evm',
        leader: LEADER,
        leaderTxHash: `0x${'cd'.repeat(32)}`,
        leaderTimestamp: NOW - 60,
        confirmedAt: NOW,
        follower: FOLLOWER,
        quoteToken: QUOTE,
        tokenOut: OUT,
        notionalWei: 10n ** 16n,
        poolKey: null,
      };
      const { result } = renderHook(() => useCopyFollows(), { wrapper });
      safeSetItemMock.mockClear();

      act(() => {
        result.current.recordMirror(intent);
      });

      expect(safeSetItemMock).toHaveBeenCalledTimes(1);
      expect(result.current.intents).toHaveLength(1);
    });
  });
});

describe('useSolanaFollowerAddress', () => {
  const REAL = '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k';

  it('accepts a 32-byte key, keeps its case, and survives a remount', () => {
    const first = renderHook(() => useSolanaFollowerAddress());
    act(() => {
      expect(first.result.current.save(` ${REAL} `)).toBe('ok');
    });
    expect(first.result.current.address).toBe(REAL);
    first.unmount();

    const second = renderHook(() => useSolanaFollowerAddress());
    expect(second.result.current.address).toBe(REAL);
  });

  it('refuses a string that is base58-shaped but not a key, and stores nothing', () => {
    // 44 base58 characters decoding to 33 bytes. A regex-only guard would store
    // it, render it, and then never match a fill.
    const { result } = renderHook(() => useSolanaFollowerAddress());
    act(() => {
      expect(result.current.save('z'.repeat(44))).toBe('invalid');
    });
    expect(result.current.address).toBeNull();
    expect(safeSetItemMock).not.toHaveBeenCalled();
  });

  it('reports a refused write rather than pretending the address stuck', () => {
    safeSetItemMock.mockReturnValue(false);
    const { result } = renderHook(() => useSolanaFollowerAddress());
    act(() => {
      expect(result.current.save(REAL)).toBe('persist-failed');
    });
    // In memory it still applies, so the session behaves; the caller says so.
    expect(result.current.address).toBe(REAL);
  });

  it('ignores a stored value that is not a key any more', () => {
    localStorage.setItem('tegridy-own-copytrade-solana-wallet', 'not-a-key');
    const { result } = renderHook(() => useSolanaFollowerAddress());
    // Storage is editable by anything on this origin, so it is re-validated on
    // read rather than trusted because it is ours.
    expect(result.current.address).toBeNull();
  });
});
