// The follow store, and the two properties that make it safe to have at all:
// it holds nothing that could move a token, and it never repairs a cap.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FOLLOWS_STORAGE_KEY,
  MAX_FOLLOWS,
  MAX_SLIPPAGE_BPS,
  MIRRORS_STORAGE_KEY,
  addMirrorIntent,
  loadFollows,
  loadMirrorIntents,
  saveFollows,
  saveMirrorIntents,
  validateFollow,
  type FollowConfig,
  type MirrorIntent,
} from './follows';

const LEADER = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
const OTHER = '0x1111111111111111111111111111111111111111';
const QUOTE = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const TOKEN_OUT = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}`;

const NOW = 1_780_000_000;

function draft(over: Partial<Parameters<typeof validateFollow>[0]> = {}) {
  return {
    leader: LEADER,
    quoteToken: QUOTE,
    maxNotionalWei: 10n ** 17n,
    slippageBps: 100,
    now: NOW,
    ...over,
  };
}

beforeEach(() => {
  localStorage.clear();
});

describe('validateFollow', () => {
  it('lowercases both addresses so a checksummed entry cannot become a second follow', () => {
    const result = validateFollow(draft());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.leader).toBe(LEADER.toLowerCase());
    expect(result.config.quoteToken).toBe(QUOTE.toLowerCase());

    const second = validateFollow(draft({ leader: LEADER.toLowerCase() }), [result.config]);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe('duplicate');
  });

  it('refuses a wallet following itself', () => {
    const result = validateFollow(draft({ follower: LEADER.toLowerCase() }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('self-follow');
  });

  it('refuses a zero cap rather than treating it as unlimited', () => {
    const result = validateFollow(draft({ maxNotionalWei: 0n }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('cap-not-positive');
  });

  it('refuses a slippage guard wide enough to stop being one', () => {
    for (const bps of [0, -1, MAX_SLIPPAGE_BPS + 1, 10_000, 1.5]) {
      const result = validateFollow(draft({ slippageBps: bps }));
      expect(result.ok, `${bps} bps should be refused`).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('slippage-out-of-range');
    }
  });

  it('caps the list length instead of growing without bound', () => {
    const existing: FollowConfig[] = Array.from({ length: MAX_FOLLOWS }, (_, i) => ({
      leader: `0x${String(i).padStart(40, '0')}`,
      quoteToken: QUOTE.toLowerCase(),
      maxNotionalWei: 1n,
      slippageBps: 50,
      createdAt: NOW,
    }));
    const result = validateFollow(draft(), existing);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('too-many-follows');
  });
});

describe('persistence', () => {
  it('round-trips a cap through JSON without going near Number', () => {
    // Above 2^53. A JSON number here would come back as a different cap, and a
    // cap silently enlarged is a trade the user did not authorise the size of.
    const huge = 123_456_789_012_345_678_901_234n;
    const config: FollowConfig = {
      leader: LEADER.toLowerCase(),
      quoteToken: QUOTE.toLowerCase(),
      maxNotionalWei: huge,
      slippageBps: 25,
      createdAt: NOW,
    };
    expect(saveFollows([config], NOW)).toBe(true);
    expect(loadFollows()[0]!.maxNotionalWei).toBe(huge);
  });

  it('drops a corrupt row instead of repairing it', () => {
    localStorage.setItem(
      FOLLOWS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        ts: NOW,
        follows: [
          { leader: LEADER.toLowerCase(), quoteToken: QUOTE.toLowerCase(), maxNotionalWei: 'not-a-number', slippageBps: 25, createdAt: NOW },
          { leader: LEADER.toLowerCase(), quoteToken: QUOTE.toLowerCase(), maxNotionalWei: '5', slippageBps: 99_999, createdAt: NOW },
          { leader: OTHER, quoteToken: QUOTE.toLowerCase(), maxNotionalWei: '7', slippageBps: 25, createdAt: NOW },
        ],
      }),
    );
    const loaded = loadFollows();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.leader).toBe(OTHER);
  });

  it('returns nothing at all when the stored blob is not a store', () => {
    localStorage.setItem(FOLLOWS_STORAGE_KEY, 'null');
    expect(loadFollows()).toEqual([]);
    localStorage.setItem(FOLLOWS_STORAGE_KEY, '{"v":1,"follows":"nope"}');
    expect(loadFollows()).toEqual([]);
  });

  it('stores no key material — only public addresses, a cap and timestamps', () => {
    // The non-custodial claim, checked against the bytes that actually land in
    // storage rather than against the type. A key or a mnemonic reaching this
    // blob is the one failure no product argument covers.
    saveFollows(
      [{ leader: LEADER.toLowerCase(), quoteToken: QUOTE.toLowerCase(), maxNotionalWei: 5n, slippageBps: 25, createdAt: NOW }],
      NOW,
    );
    const raw = localStorage.getItem(FOLLOWS_STORAGE_KEY)!;
    const parsed = JSON.parse(raw) as { follows: Record<string, unknown>[] };
    expect(Object.keys(parsed.follows[0]!).sort()).toEqual([
      'createdAt',
      'leader',
      'maxNotionalWei',
      'quoteToken',
      'slippageBps',
    ]);
    expect(raw).not.toMatch(/key|secret|mnemonic|seed|signature|privateKey/i);
  });
});

describe('mirror intents', () => {
  const intent: MirrorIntent = {
    leader: LEADER.toLowerCase(),
    leaderTxHash: TX,
    leaderTimestamp: NOW - 60,
    confirmedAt: NOW,
    follower: OTHER,
    quoteToken: QUOTE.toLowerCase(),
    tokenOut: TOKEN_OUT,
    notionalWei: 10n ** 16n,
  };

  it('round-trips, including the planned output token', () => {
    expect(saveMirrorIntents([intent], NOW)).toBe(true);
    expect(loadMirrorIntents()).toEqual([intent]);
  });

  it('drops an intent with no planned output token rather than matching loosely later', () => {
    const { tokenOut: _dropped, ...withoutTokenOut } = intent;
    localStorage.setItem(
      MIRRORS_STORAGE_KEY,
      JSON.stringify({ v: 1, ts: NOW, intents: [{ ...withoutTokenOut, notionalWei: '1' }] }),
    );
    expect(loadMirrorIntents()).toEqual([]);
  });

  it('treats a second confirmation of the same leader trade as one mirror', () => {
    const again = { ...intent, confirmedAt: NOW + 30 };
    const list = addMirrorIntent(addMirrorIntent([], intent), again);
    expect(list).toHaveLength(1);
    expect(list[0]!.confirmedAt).toBe(NOW + 30);
  });

  it('keeps a different follower’s confirmation of the same trade separate', () => {
    const other = { ...intent, follower: LEADER.toLowerCase() };
    expect(addMirrorIntent(addMirrorIntent([], intent), other)).toHaveLength(2);
  });
});
