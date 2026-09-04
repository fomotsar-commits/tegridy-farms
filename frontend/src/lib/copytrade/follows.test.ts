// The follow store, and the three properties that make it safe to have at all:
// it holds nothing that could move a token, it never repairs a cap, and it never
// drops a row it can still read.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FOLLOWS_STORAGE_KEY,
  MAX_FOLLOWS,
  MAX_SLIPPAGE_BPS,
  MIRRORS_STORAGE_KEY,
  SOLANA_FOLLOWER_STORAGE_KEY,
  addMirrorIntent,
  loadFollows,
  loadMirrorIntents,
  saveFollows,
  saveMirrorIntents,
  validateFollow,
  type FollowConfig,
  type MirrorIntent,
} from './follows';
import { isEvictable } from '../storage';
import { SOL_MINT } from '../solana';

const LEADER = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
const OTHER = '0x1111111111111111111111111111111111111111';
const QUOTE = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const TOKEN_OUT = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}`;

const SOL_LEADER = '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k';
const SOL_FOLLOWER = '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump';
const SOL_TOKEN_OUT = '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump';
const SOL_SIG = 'z'.repeat(87);

const NOW = 1_780_000_000;

function draft(over: Partial<Parameters<typeof validateFollow>[0]> = {}) {
  return {
    venue: 'evm' as const,
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
    expect(result.config.venue).toBe('evm');

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
      venue: 'evm',
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

  it('accepts a base58 leader only on the Solana venue, and only at 32 bytes', () => {
    const ok = validateFollow(draft({ venue: 'solana', leader: SOL_LEADER, quoteToken: SOL_MINT }));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.config.leader).toBe(SOL_LEADER); // exact case, never lowercased

    // 44 base58 characters that decode to 33 bytes. A regex-only guard stores it.
    const notAKey = validateFollow(
      draft({ venue: 'solana', leader: 'z'.repeat(44), quoteToken: SOL_MINT }),
    );
    expect(notAKey.ok).toBe(false);
    if (!notAKey.ok) expect(notAKey.reason).toBe('bad-leader');
  });

  it('names the mistake when a real address is filed under the wrong venue', () => {
    const evmOnSolana = validateFollow(draft({ venue: 'solana', leader: LEADER, quoteToken: SOL_MINT }));
    expect(evmOnSolana.ok).toBe(false);
    if (!evmOnSolana.ok) expect(evmOnSolana.reason).toBe('leader-venue-mismatch');

    const solOnEvm = validateFollow(draft({ venue: 'evm', leader: SOL_LEADER }));
    expect(solOnEvm.ok).toBe(false);
    if (!solOnEvm.ok) expect(solOnEvm.reason).toBe('leader-venue-mismatch');
  });

  it('refuses a quote token from another venue', () => {
    // A SOL cap on an EVM follow would size a trade in a token the pool does not
    // hold; a WETH cap on a Solana follow has no contract on that chain at all.
    const solCapOnEvm = validateFollow(draft({ quoteToken: SOL_MINT }));
    expect(solCapOnEvm.ok).toBe(false);
    if (!solCapOnEvm.ok) expect(solCapOnEvm.reason).toBe('quote-venue-mismatch');

    const wethOnSolana = validateFollow(draft({ venue: 'solana', leader: SOL_LEADER, quoteToken: QUOTE }));
    expect(wethOnSolana.ok).toBe(false);
    if (!wethOnSolana.ok) expect(wethOnSolana.reason).toBe('quote-venue-mismatch');
  });

  it('refuses a quote token that is not in the table at all', () => {
    const result = validateFollow(draft({ quoteToken: '0x9999999999999999999999999999999999999999' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad-quote-token');
  });
});

describe('persistence', () => {
  it('round-trips a cap through JSON without going near Number', () => {
    // Above 2^53. A JSON number here would come back as a different cap, and a
    // cap silently enlarged is a trade the user did not authorise the size of.
    const huge = 123_456_789_012_345_678_901_234n;
    const config: FollowConfig = {
      venue: 'evm',
      leader: LEADER.toLowerCase(),
      quoteToken: QUOTE.toLowerCase(),
      maxNotionalWei: huge,
      slippageBps: 25,
      createdAt: NOW,
    };
    expect(saveFollows([config], NOW)).toBe(true);
    expect(loadFollows()[0]!.maxNotionalWei).toBe(huge);
  });

  it('loads a v1 row as an EVM follow with its cap intact', () => {
    // THE MIGRATION PIN. Every row written before the venue field was an EVM
    // follow. A decoder that drops rows with an unknown venue deletes a
    // per-trade cap the user set, which is the exact failure the caps exist to
    // prevent.
    localStorage.setItem(
      FOLLOWS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        ts: NOW,
        follows: [
          { leader: OTHER, quoteToken: QUOTE.toLowerCase(), maxNotionalWei: '7', slippageBps: 25, createdAt: NOW },
        ],
      }),
    );
    const loaded = loadFollows();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.venue).toBe('evm');
    expect(loaded[0]!.maxNotionalWei).toBe(7n);
    expect(loaded[0]!.slippageBps).toBe(25);
  });

  it('round-trips a Solana follow without lowercasing its base58', () => {
    const config: FollowConfig = {
      venue: 'solana',
      leader: SOL_LEADER,
      quoteToken: SOL_MINT,
      maxNotionalWei: 500_000_000n,
      slippageBps: 100,
      createdAt: NOW,
    };
    expect(saveFollows([config], NOW)).toBe(true);
    expect(loadFollows()).toEqual([config]);
  });

  it('drops a corrupt row instead of repairing it', () => {
    localStorage.setItem(
      FOLLOWS_STORAGE_KEY,
      JSON.stringify({
        v: 2,
        ts: NOW,
        follows: [
          { venue: 'evm', leader: LEADER.toLowerCase(), quoteToken: QUOTE.toLowerCase(), maxNotionalWei: 'not-a-number', slippageBps: 25, createdAt: NOW },
          { venue: 'evm', leader: LEADER.toLowerCase(), quoteToken: QUOTE.toLowerCase(), maxNotionalWei: '5', slippageBps: 99_999, createdAt: NOW },
          { venue: 'evm', leader: OTHER, quoteToken: QUOTE.toLowerCase(), maxNotionalWei: '7', slippageBps: 25, createdAt: NOW },
        ],
      }),
    );
    const loaded = loadFollows();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.leader).toBe(OTHER);
  });

  it('drops a row whose address does not belong to its own venue', () => {
    localStorage.setItem(
      FOLLOWS_STORAGE_KEY,
      JSON.stringify({
        v: 2,
        ts: NOW,
        follows: [
          { venue: 'solana', leader: LEADER.toLowerCase(), quoteToken: SOL_MINT, maxNotionalWei: '5', slippageBps: 25, createdAt: NOW },
          { venue: 'evm', leader: OTHER, quoteToken: SOL_MINT, maxNotionalWei: '5', slippageBps: 25, createdAt: NOW },
        ],
      }),
    );
    expect(loadFollows()).toEqual([]);
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
      [{ venue: 'evm', leader: LEADER.toLowerCase(), quoteToken: QUOTE.toLowerCase(), maxNotionalWei: 5n, slippageBps: 25, createdAt: NOW }],
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
      'venue',
    ]);
    expect(raw).not.toMatch(/key|secret|mnemonic|seed|signature|privateKey/i);
  });

  it('keeps the pasted Solana address out of the quota sweeper', () => {
    // A wallet address the reader typed is a choice, not a cache: evicted, it is
    // gone, and the reconciliation silently stops finding their own fills.
    expect(isEvictable(SOLANA_FOLLOWER_STORAGE_KEY)).toBe(false);
  });
});

describe('mirror intents', () => {
  const intent: MirrorIntent = {
    venue: 'evm',
    leader: LEADER.toLowerCase(),
    leaderTxHash: TX,
    leaderTimestamp: NOW - 60,
    confirmedAt: NOW,
    follower: OTHER,
    quoteToken: QUOTE.toLowerCase(),
    tokenOut: TOKEN_OUT,
    notionalWei: 10n ** 16n,
    poolKey: 'eth:0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
  };

  it('round-trips, including the planned output token and the pool it came from', () => {
    expect(saveMirrorIntents([intent], NOW)).toBe(true);
    expect(loadMirrorIntents()).toEqual([intent]);
  });

  it('round-trips a Solana intent, signature and all', () => {
    // Fails on the pre-venue decoder, which tested every field against the EVM
    // regexes and threw the whole row away.
    const sol: MirrorIntent = {
      venue: 'solana',
      leader: SOL_LEADER,
      leaderTxHash: SOL_SIG,
      leaderTimestamp: NOW - 60,
      confirmedAt: NOW,
      follower: SOL_FOLLOWER,
      quoteToken: SOL_MINT,
      tokenOut: SOL_TOKEN_OUT,
      notionalWei: 500_000_000n,
      poolKey: 'solana:31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX',
    };
    expect(saveMirrorIntents([sol], NOW)).toBe(true);
    expect(loadMirrorIntents()).toEqual([sol]);
  });

  it('loads a v1 intent as an EVM one with no pool', () => {
    localStorage.setItem(
      MIRRORS_STORAGE_KEY,
      JSON.stringify({
        v: 1,
        ts: NOW,
        intents: [
          {
            leader: LEADER.toLowerCase(),
            leaderTxHash: TX,
            leaderTimestamp: NOW - 60,
            confirmedAt: NOW,
            follower: OTHER,
            quoteToken: QUOTE.toLowerCase(),
            tokenOut: TOKEN_OUT,
            notionalWei: '1',
          },
        ],
      }),
    );
    const loaded = loadMirrorIntents();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.venue).toBe('evm');
    // Null, not a guessed pool: the tape reconciler judges inside ONE pool, and
    // a fabricated pool key would make it judge in the wrong one.
    expect(loaded[0]!.poolKey).toBeNull();
  });

  it('drops an intent with no planned output token rather than matching loosely later', () => {
    const { tokenOut: _dropped, ...withoutTokenOut } = intent;
    localStorage.setItem(
      MIRRORS_STORAGE_KEY,
      JSON.stringify({ v: 2, ts: NOW, intents: [{ ...withoutTokenOut, notionalWei: '1' }] }),
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
