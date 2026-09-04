// Sizing a mirror, and the four things this module refuses to do.

import { describe, it, expect } from 'vitest';
import {
  MAX_SIGNAL_AGE_SECONDS,
  MIRROR_EXECUTION,
  planMirror,
  planMirrors,
} from './mirror';
import type { FollowConfig } from './follows';
import type { IndexedSwap } from '../indexer/queries';

const LEADER = '0xabcdef0123456789abcdef0123456789abcdef01';
const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const OUT = '0x2222222222222222222222222222222222222222';
const NOW = 1_780_000_000;

const follow: FollowConfig = {
  // planMirror itself never reads the venue - it matches on leader and quote
  // token - but a follow now carries one, and LEADER and QUOTE are hex
  // addresses, so the only venue this fixture can honestly claim is 'evm'.
  venue: 'evm',
  leader: LEADER,
  quoteToken: QUOTE,
  maxNotionalWei: 10n ** 17n, // 0.1
  slippageBps: 100,
  createdAt: NOW - 1000,
};

function swap(over: Partial<IndexedSwap> = {}): IndexedSwap {
  return {
    id: 'swap-1',
    user: LEADER,
    tokenIn: QUOTE,
    tokenOut: OUT,
    amountIn: 10n ** 16n, // 0.01, under the cap
    fee: 0n,
    timestamp: BigInt(NOW - 60),
    txHash: `0x${'ab'.repeat(32)}`,
    ...over,
  };
}

describe('planMirror', () => {
  it('sizes at the leader’s amount when it is under the cap', () => {
    const outcome = planMirror(swap(), follow, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.notionalWei).toBe(10n ** 16n);
    expect(outcome.plan.capped).toBe(false);
    expect(outcome.plan.signalAgeSeconds).toBe(60);
  });

  it('never scales UP to match a leader — the cap is a ceiling in one direction', () => {
    const outcome = planMirror(swap({ amountIn: 10n ** 19n }), follow, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.notionalWei).toBe(follow.maxNotionalWei);
    expect(outcome.plan.capped).toBe(true);
    expect(outcome.plan.leaderAmountIn).toBe(10n ** 19n);
  });

  it('refuses a leg denominated in a token the cap is not in', () => {
    // The failure this prevents: converting 0.1 WETH into "some amount of USDC"
    // needs a rate, and there is no rate anywhere in the indexed row.
    const outcome = planMirror(swap({ tokenIn: OUT, tokenOut: QUOTE }), follow, NOW);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('quote-token-mismatch');
  });

  it('refuses a signal older than the window', () => {
    const stale = swap({ timestamp: BigInt(NOW - MAX_SIGNAL_AGE_SECONDS - 1) });
    const outcome = planMirror(stale, follow, NOW);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('stale-signal');

    // And the boundary itself is inside the window, not outside it.
    const edge = planMirror(swap({ timestamp: BigInt(NOW - MAX_SIGNAL_AGE_SECONDS) }), follow, NOW);
    expect(edge.ok).toBe(true);
  });

  it('refuses a row timestamped ahead of the clock rather than reporting a negative age', () => {
    const outcome = planMirror(swap({ timestamp: BigInt(NOW + 5) }), follow, NOW);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('unusable-timestamp');
  });

  it('refuses a zero-input row', () => {
    const outcome = planMirror(swap({ amountIn: 0n }), follow, NOW);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('zero-input');
  });

  it('never computes a minimum-out from a past fill', () => {
    // A slippage bound derived from the leader's old trade would guard a price
    // that no longer exists, which is worse than no bound because it looks like
    // one. The guard travels as bps and is applied to a live quote instead.
    const outcome = planMirror(swap(), follow, NOW);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.plan.minOut).toBeNull();
    expect(outcome.plan.slippageBps).toBe(follow.slippageBps);
    expect(outcome.plan.minOutReason).toMatch(/live quote/i);
  });
});

describe('planMirrors', () => {
  it('keeps refusals as rows so the copyable fraction is visible', () => {
    // A queue that filtered these out would present the leader as a stream of
    // clean opportunities and hide that most of what they did is not copyable.
    const rows = planMirrors(
      [
        swap({ id: 'a' }),
        swap({ id: 'b', tokenIn: OUT, tokenOut: QUOTE, timestamp: BigInt(NOW - 30) }),
        swap({ id: 'c', timestamp: BigInt(NOW - MAX_SIGNAL_AGE_SECONDS - 10) }),
      ],
      [follow],
      NOW,
    );
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.outcome.ok)).toHaveLength(1);
    // Newest first.
    expect(rows.map((r) => r.swap.id)).toEqual(['b', 'a', 'c']);
  });

  it('ignores rows belonging to a wallet that is not followed', () => {
    const rows = planMirrors([swap({ user: OUT })], [follow], NOW);
    expect(rows).toEqual([]);
  });
});

describe('the execution claim', () => {
  it('states that nothing is automatic, in the copy the surfaces render', () => {
    // The venue runs no keeper. This string is imported verbatim by the page and
    // the queue, so a reword that quietly promises automation fails here.
    expect(MIRROR_EXECUTION).toMatch(/manual/i);
    expect(MIRROR_EXECUTION).toMatch(/no keeper/i);
    expect(MIRROR_EXECUTION).toMatch(/sign yourself/i);
  });
});
