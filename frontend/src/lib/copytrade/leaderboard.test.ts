// The board, and the column that must never appear on it.

import { describe, it, expect } from 'vitest';
import { RETURN_RANKING, TRUNCATED_NOTICE, buildLeaderboard } from './leaderboard';
import type { IndexedSwap } from '../indexer/queries';

const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const TOKEN_A = '0x1111111111111111111111111111111111111111';
const TOKEN_B = '0x2222222222222222222222222222222222222222';
const W1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const W2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

let seq = 0;
function swap(over: Partial<IndexedSwap> = {}): IndexedSwap {
  seq += 1;
  return {
    id: `s${seq}`,
    user: W1,
    tokenIn: QUOTE,
    tokenOut: TOKEN_A,
    amountIn: 10n ** 18n,
    fee: 0n,
    timestamp: 1_780_000_000n,
    txHash: `0x${'ab'.repeat(32)}`,
    ...over,
  };
}

describe('the return verdict', () => {
  it('is a refusal, and it names both halves of why', () => {
    // The two independent reasons a leader's PnL must not be printed beside a
    // Follow button: it is not computable from these rows AT ALL, and even if it
    // were it would describe a trade the follower cannot take.
    expect(RETURN_RANKING.ranked).toBe(false);
    expect(RETURN_RANKING.reason).toMatch(/never what came back/i);
    expect(RETURN_RANKING.reason).toMatch(/after them/i);
    expect(RETURN_RANKING.rankedInstead).toMatch(/activity/i);
  });
});

describe('buildLeaderboard', () => {
  it('sums only the quote-token legs and counts the rest separately', () => {
    // Adding a TOKEN_A amount to a WETH amount produces a figure with no unit
    // that still looks like money. The off-quote trades are surfaced as a count.
    const board = buildLeaderboard(
      [
        swap({ amountIn: 2n * 10n ** 18n }),
        swap({ tokenIn: TOKEN_A, tokenOut: QUOTE, amountIn: 999n * 10n ** 18n }),
      ],
      { quoteToken: QUOTE, truncated: false },
    );
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]!.quoteDeployed).toBe(2n * 10n ** 18n);
    expect(board.rows[0]!.offQuoteTrades).toBe(1);
    expect(board.rows[0]!.trades).toBe(2);
  });

  it('counts distinct tokens bought, not distinct trades', () => {
    const board = buildLeaderboard(
      [swap({ tokenOut: TOKEN_A }), swap({ tokenOut: TOKEN_A }), swap({ tokenOut: TOKEN_B })],
      { quoteToken: QUOTE, truncated: false },
    );
    expect(board.rows[0]!.tokensBought).toBe(2);
  });

  it('orders deterministically, including the ties', () => {
    // Two wallets with identical figures must not swap places between renders of
    // the same data — movement on a board is supposed to mean something.
    const rows = [
      swap({ user: W2, amountIn: 10n ** 18n }),
      swap({ user: W1, amountIn: 10n ** 18n }),
    ];
    const first = buildLeaderboard(rows, { quoteToken: QUOTE, truncated: false });
    const second = buildLeaderboard([...rows].reverse(), { quoteToken: QUOTE, truncated: false });
    expect(first.rows.map((r) => r.leader)).toEqual([W1, W2]);
    expect(second.rows.map((r) => r.leader)).toEqual([W1, W2]);
  });

  it('excludes the viewer’s own wallet without dropping it from the window bounds', () => {
    const board = buildLeaderboard(
      [swap({ user: W1, timestamp: 100n }), swap({ user: W2, timestamp: 200n })],
      { quoteToken: QUOTE, truncated: false, exclude: [W1.toUpperCase()] },
    );
    expect(board.rows.map((r) => r.leader)).toEqual([W2]);
    expect(board.swapsRead).toBe(2);
    expect(board.window).toEqual({ from: 100n, to: 200n });
  });

  it('carries truncation through, because a partial page is a provisional order', () => {
    const board = buildLeaderboard([swap()], { quoteToken: QUOTE, truncated: true });
    expect(board.truncated).toBe(true);
    expect(TRUNCATED_NOTICE).toMatch(/provisional/i);
  });

  it('reports no window at all when nothing came back', () => {
    // Not a zero-length window and not a window starting at the epoch — no rows
    // means no measured bounds, and a fabricated span is what a surface would
    // then print "0 trades in the last 7 days" underneath.
    const board = buildLeaderboard([], { quoteToken: QUOTE, truncated: false });
    expect(board.window).toBeNull();
    expect(board.rows).toEqual([]);
  });

  it('has no field on a row that could be read as a profit', () => {
    // A structural check, not a stylistic one: this is the shape a future edit
    // would have to change first to put a return on the board.
    const board = buildLeaderboard([swap()], { quoteToken: QUOTE, truncated: false });
    const keys = Object.keys(board.rows[0]!);
    for (const forbidden of ['pnl', 'profit', 'roi', 'return', 'returns', 'gain', 'apy']) {
      expect(keys.map((k) => k.toLowerCase())).not.toContain(forbidden);
    }
  });
});
