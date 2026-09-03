// The realised half: lag, fill rate, and the refusal to turn either into a return.

import { describe, it, expect } from 'vitest';
import {
  FILL_MATCH_WINDOW_SECONDS,
  FOLLOWER_RETURN_UNMEASURABLE,
  MATCH_BASIS,
  reconcileMirrors,
  summariseByLeader,
} from './followerRelative';
import type { MirrorIntent } from './follows';
import type { IndexedSwap } from '../indexer/queries';

const LEADER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LEADER_2 = '0xcccccccccccccccccccccccccccccccccccccccc';
const FOLLOWER = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const QUOTE = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const OUT = '0x2222222222222222222222222222222222222222';
const OTHER_OUT = '0x3333333333333333333333333333333333333333';

const NOW = 1_780_000_000;

function intent(over: Partial<MirrorIntent> = {}): MirrorIntent {
  return {
    // Defaulted HERE rather than left to the spread: `Partial<MirrorIntent>`
    // makes every override optional, so a field the base literal omits arrives
    // as `T | undefined` and no longer satisfies the required intent. Naming
    // both defaults keeps a case free to override either one.
    venue: 'evm',
    leader: LEADER,
    leaderTxHash: `0x${'ab'.repeat(32)}`,
    // Old enough that the match window has closed, so an unmatched intent in
    // these cases is a real "did not fill" rather than one still in flight.
    leaderTimestamp: NOW - 2100,
    confirmedAt: NOW - 2000,
    follower: FOLLOWER,
    quoteToken: QUOTE,
    tokenOut: OUT,
    notionalWei: 10n ** 16n,
    // These intents are reconciled against indexer swaps, which name no pool.
    poolKey: null,
    ...over,
  };
}

let seq = 0;
function swap(over: Partial<IndexedSwap> = {}): IndexedSwap {
  seq += 1;
  return {
    id: `f${seq}`,
    user: FOLLOWER,
    tokenIn: QUOTE,
    tokenOut: OUT,
    amountIn: 10n ** 16n,
    fee: 0n,
    timestamp: BigInt(NOW - 1900),
    txHash: `0x${'cd'.repeat(32)}`,
    ...over,
  };
}

describe('reconcileMirrors', () => {
  it('measures the lag from the LEADER’s trade, not from the confirmation', () => {
    // The whole product claim. A lag measured from the moment the user pressed a
    // button would report a few seconds and hide the ten minutes they were
    // actually behind the wallet they copied.
    const rows = reconcileMirrors([intent()], [swap()], NOW);
    expect(rows[0]!.state).toBe('filled');
    expect(rows[0]!.entryLagSeconds).toBe(200);
  });

  it('does not match a swap on a different pair', () => {
    const rows = reconcileMirrors([intent()], [swap({ tokenOut: OTHER_OUT })], NOW);
    expect(rows[0]!.state).toBe('not-filled');
    expect(rows[0]!.entryLagSeconds).toBeNull();
  });

  it('does not match another wallet’s swap', () => {
    const rows = reconcileMirrors([intent()], [swap({ user: LEADER })], NOW);
    expect(rows[0]!.state).toBe('not-filled');
  });

  it('does not match a swap that landed before the confirmation', () => {
    const rows = reconcileMirrors([intent()], [swap({ timestamp: BigInt(NOW - 2050) })], NOW);
    expect(rows[0]!.state).toBe('not-filled');
  });

  it('reports "awaiting" while the window is still open, never "not-filled"', () => {
    // Two very different facts. Calling an open window a failure would report a
    // miss the user has not had yet.
    const fresh = intent({ confirmedAt: NOW - 10 });
    const rows = reconcileMirrors([fresh], [], NOW);
    expect(rows[0]!.state).toBe('awaiting');

    const closed = intent({ confirmedAt: NOW - FILL_MATCH_WINDOW_SECONDS - 1 });
    expect(reconcileMirrors([closed], [], NOW)[0]!.state).toBe('not-filled');
  });

  it('never credits one swap to two confirmations', () => {
    // Without this, two confirmations minutes apart both claim the same trade
    // and the surface reports a doubled fill rate produced by a matching bug.
    const a = intent({ leaderTxHash: `0x${'11'.repeat(32)}`, confirmedAt: NOW - 2000 });
    const b = intent({ leaderTxHash: `0x${'22'.repeat(32)}`, confirmedAt: NOW - 1990 });
    const rows = reconcileMirrors([a, b], [swap()], NOW);
    expect(rows.filter((r) => r.state === 'filled')).toHaveLength(1);
    expect(rows.filter((r) => r.state === 'not-filled')).toHaveLength(1);
  });
});

describe('summariseByLeader', () => {
  it('reports no lag at all when nothing filled, rather than zero', () => {
    const rows = reconcileMirrors(
      [intent({ confirmedAt: NOW - FILL_MATCH_WINDOW_SECONDS - 1 })],
      [],
      NOW,
    );
    const [summary] = summariseByLeader(rows);
    expect(summary!.filled).toBe(0);
    expect(summary!.notFilled).toBe(1);
    expect(summary!.medianEntryLagSeconds).toBeNull();
  });

  it('takes the UPPER median on a tie so the figure is not rounded flattering', () => {
    const rows = reconcileMirrors(
      [
        intent({ leaderTxHash: `0x${'11'.repeat(32)}`, leaderTimestamp: NOW - 2500, confirmedAt: NOW - 2490 }),
        intent({ leaderTxHash: `0x${'22'.repeat(32)}`, leaderTimestamp: NOW - 2400, confirmedAt: NOW - 2390 }),
      ],
      [
        swap({ id: 'x', timestamp: BigInt(NOW - 2400) }), // 100s behind the first leader trade
        swap({ id: 'y', timestamp: BigInt(NOW - 2100) }), // 300s behind the second
      ],
      NOW,
    );
    const [summary] = summariseByLeader(rows);
    expect(summary!.filled).toBe(2);
    expect(summary!.medianEntryLagSeconds).toBe(300);
    expect(summary!.worstEntryLagSeconds).toBe(300);
  });

  it('gives a leader with no confirmations no row at all', () => {
    // Zero-confirmed and ten-confirmed-none-filled are the same digits and only
    // one of them says anything about the leader.
    const rows = reconcileMirrors([intent({ leader: LEADER })], [swap()], NOW);
    const summaries = summariseByLeader(rows);
    expect(summaries.map((s) => s.leader)).toEqual([LEADER]);
    expect(summaries.map((s) => s.leader)).not.toContain(LEADER_2);
  });
});

describe('the stated method', () => {
  it('discloses that a match is an association and that no return is computed', () => {
    expect(MATCH_BASIS).toMatch(/nothing marks a swap on chain as a mirror/i);
    expect(FOLLOWER_RETURN_UNMEASURABLE).toMatch(/never what came back/i);
  });
});
