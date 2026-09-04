import { describe, it, expect } from 'vitest';
import { coverageOf, reconcileTapeMirrors, summariseTapeByLeader } from './tapeReconcile';
import { FILL_MATCH_WINDOW_SECONDS } from './followerRelative';
import type { MirrorIntent } from './follows';
import { poolKeyOf, type IslandPool, type IslandTape, type PoolTapeRead, type TapeFill } from './tape';
import { WETH_ADDRESS } from '../constants';

const NOW = 1_780_000_000;
const LEADER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ME = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TX = `0x${'ab'.repeat(32)}`;
const FILL_TX = `0x${'cd'.repeat(32)}`;

const pool: IslandPool = {
  bungalowId: 'pepe',
  symbol: 'PEPE',
  network: 'eth',
  family: 'evm',
  pool: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f',
  label: 'PEPE / WETH',
  baseToken: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
  quoteToken: WETH_ADDRESS.toLowerCase(),
};

const POOL_KEY = poolKeyOf(pool);

function fill(over: Partial<TapeFill> = {}): TapeFill {
  return {
    pool,
    txHash: FILL_TX,
    wallet: ME,
    side: 'buy',
    at: NOW,
    usd: 42,
    quoteAmount: '0.05',
    blockNumber: null,
    ...over,
  };
}

function read(fills: TapeFill[], over: Partial<Extract<PoolTapeRead, { status: 'read' }>> = {}): PoolTapeRead {
  return {
    status: 'read',
    pool,
    fills,
    fetchedAt: NOW * 1000,
    newestAt: fills.length ? Math.max(...fills.map((f) => f.at)) : null,
    oldestAt: fills.length ? Math.min(...fills.map((f) => f.at)) : null,
    capped: false,
    undated: 0,
    ...over,
  };
}

function tapeOf(reads: PoolTapeRead[]): IslandTape {
  return { reads, fetchedAt: NOW * 1000, stoppedEarly: false };
}

function intent(over: Partial<MirrorIntent> = {}): MirrorIntent {
  return {
    venue: 'evm',
    leader: LEADER,
    leaderTxHash: TX,
    leaderTimestamp: NOW - 120,
    confirmedAt: NOW - 60,
    follower: ME,
    quoteToken: WETH_ADDRESS.toLowerCase(),
    tokenOut: pool.baseToken,
    notionalWei: 10n ** 16n,
    poolKey: POOL_KEY,
    ...over,
  };
}

describe('coverageOf', () => {
  it('is null for an unread pool and for a pool that returned nothing', () => {
    expect(coverageOf(undefined)).toBeNull();
    expect(coverageOf({ status: 'unread', pool, reason: 'http', detail: 'HTTP 500' })).toBeNull();
    expect(coverageOf(read([]))).toBeNull();
  });

  it('is the source s own oldest and newest timestamps, not the fetch time', () => {
    // Widening coverage to `fetchedAt − 24h` on upstream's documented window
    // would let a short read call a real mirror missed.
    const c = coverageOf(read([fill({ at: NOW - 500 }), fill({ at: NOW - 10 })]))!;
    expect(c).toEqual({ from: NOW - 500, to: NOW - 10 });
  });
});

describe('reconcileTapeMirrors', () => {
  it('matches a buy by the reader inside the window and reports the LAG', () => {
    const rows = reconcileTapeMirrors([intent()], tapeOf([read([fill({ at: NOW - 30 })])]));
    expect(rows[0]!.state).toBe('filled');
    // Lag is measured from the LEADER's fill, not from the confirmation.
    expect(rows[0]!.entryLagSeconds).toBe(90);
    expect(rows[0]!.fillTxHash).toBe(FILL_TX);
    expect(rows[0]!.fillUsd).toBe(42);
  });

  it('says AWAITING, not not-filled, when the window runs past what was read', () => {
    // THE CENTRAL PIN. A mutation that compares the deadline to a passed clock or
    // to Date.now() reports "this mirror did not happen" for a mirror the tape
    // simply has not been re-read far enough to see.
    const rows = reconcileTapeMirrors(
      [intent({ confirmedAt: NOW - 10 })],
      tapeOf([read([fill({ at: NOW - 400, wallet: LEADER }), fill({ at: NOW - 20, wallet: LEADER })])]),
    );
    expect(rows[0]!.state).toBe('awaiting');
    expect(NOW - 10 + FILL_MATCH_WINDOW_SECONDS).toBeGreaterThan(NOW - 20);
  });

  it('says UNVERIFIABLE for a confirmation older than the oldest fill read', () => {
    const rows = reconcileTapeMirrors(
      [intent({ confirmedAt: NOW - 10_000 })],
      tapeOf([read([fill({ at: NOW - 500, wallet: LEADER }), fill({ at: NOW - 100, wallet: LEADER })])]),
    );
    expect(rows[0]!.state).toBe('unverifiable');
    expect(rows[0]!.unverifiableBecause).toMatch(/older than the oldest fill/);
  });

  it('says UNVERIFIABLE for an unread pool, a zero-fill pool and a router-sourced intent', () => {
    const unread = reconcileTapeMirrors(
      [intent()],
      tapeOf([{ status: 'unread', pool, reason: 'rate-limited', detail: 'throttled' }]),
    );
    expect(unread[0]!.state).toBe('unverifiable');

    const empty = reconcileTapeMirrors([intent()], tapeOf([read([])]));
    expect(empty[0]!.state).toBe('unverifiable');

    const router = reconcileTapeMirrors([intent({ poolKey: null })], tapeOf([read([fill()])]));
    expect(router[0]!.state).toBe('unverifiable');
    expect(router[0]!.unverifiableBecause).toMatch(/venue router/);
  });

  it('says NOT-FILLED only when the whole window sits inside coverage', () => {
    const rows = reconcileTapeMirrors(
      [intent({ confirmedAt: NOW - 5_000 })],
      tapeOf([
        read([
          fill({ at: NOW - 6_000, wallet: LEADER }),
          // A fill by somebody else inside the window must not be credited.
          fill({ at: NOW - 4_900, wallet: '0xcccccccccccccccccccccccccccccccccccccccc' }),
          fill({ at: NOW - 100, wallet: LEADER }),
        ]),
      ]),
    );
    expect(rows[0]!.state).toBe('not-filled');
  });

  it('never matches a SELL by the reader', () => {
    const rows = reconcileTapeMirrors(
      [intent({ confirmedAt: NOW - 5_000 })],
      tapeOf([
        read([
          fill({ at: NOW - 6_000, wallet: LEADER }),
          fill({ at: NOW - 4_990, side: 'sell' }),
          fill({ at: NOW - 100, wallet: LEADER }),
        ]),
      ]),
    );
    expect(rows[0]!.state).toBe('not-filled');
  });

  it('consumes each fill once, so two confirmations cannot claim one trade', () => {
    const rows = reconcileTapeMirrors(
      [
        intent({ confirmedAt: NOW - 5_000, leaderTxHash: `0x${'11'.repeat(32)}` }),
        intent({ confirmedAt: NOW - 4_900, leaderTxHash: `0x${'22'.repeat(32)}` }),
      ],
      // One buy by the reader sits inside BOTH match windows. Coverage is widened
      // past both deadlines by the two leader fills, so neither confirmation can
      // fall back on 'awaiting'.
      tapeOf([
        read([
          fill({ at: NOW - 6_000, wallet: LEADER }),
          fill({ at: NOW - 4_890 }),
          fill({ at: NOW - 100, wallet: LEADER }),
        ]),
      ]),
    );
    const states = rows.map((r) => r.state).sort();
    // One filled, one not — never two fills out of one trade.
    expect(states).toEqual(['filled', 'not-filled']);
  });

  it('never matches a fill on a different pool, even for the same address', () => {
    const other: IslandPool = { ...pool, bungalowId: 'qr', pool: '0xf02c421e15abdf2008bb6577336b0f3d7aec98f0' };
    const rows = reconcileTapeMirrors(
      [intent({ confirmedAt: NOW - 5_000 })],
      tapeOf([
        read([fill({ at: NOW - 6_000, wallet: LEADER }), fill({ at: NOW - 100, wallet: LEADER })]),
        {
          status: 'read',
          pool: other,
          fills: [{ ...fill({ at: NOW - 4_990 }), pool: other }],
          fetchedAt: NOW * 1000,
          newestAt: NOW - 4_990,
          oldestAt: NOW - 4_990,
          capped: false,
          undated: 0,
        },
      ]),
    );
    expect(rows[0]!.state).toBe('not-filled');
  });
});

describe('summariseTapeByLeader', () => {
  it('counts unverifiable on its own line and never inside notFilled', () => {
    const rows = reconcileTapeMirrors(
      [
        intent({ confirmedAt: NOW - 60, leaderTxHash: `0x${'11'.repeat(32)}` }),
        intent({ confirmedAt: NOW - 10_000, leaderTxHash: `0x${'22'.repeat(32)}` }),
      ],
      tapeOf([read([fill({ at: NOW - 30 }), fill({ at: NOW - 5_000, wallet: LEADER })])]),
    );
    const [summary] = summariseTapeByLeader(rows);
    expect(summary!.confirmed).toBe(2);
    expect(summary!.filled).toBe(1);
    expect(summary!.unverifiable).toBe(1);
    // The whole point: an unverifiable mirror is not a failed one.
    expect(summary!.notFilled).toBe(0);
    expect(summary!.medianEntryLagSeconds).toBe(90);
  });

  it('gives a leader with no mirrors no row at all rather than a row of zeroes', () => {
    expect(summariseTapeByLeader([])).toEqual([]);
  });
});
