import { describe, it, expect, vi } from 'vitest';
import type { Connection } from '@solana/web3.js';
import { pollConfirm } from './confirm';

/**
 * A SENT transaction has three truthful endings: landed, refused on chain, or not
 * known yet. "Not known" is never "failed": someone told "failed" sends it again and
 * pays twice.
 *
 * These are the swap path's own poller tests (lib/solana/swap/confirm.test.ts, #703),
 * carried onto the one shared module when the swap's copy was deleted. lib/ladder's
 * write.test.ts pins the same module through `submitLadder`.
 */

const SIG = '5'.repeat(88);

type Status = { err: unknown; confirmationStatus?: string; slot?: number } | null;
type Conn = Pick<Connection, 'getSignatureStatuses'>;

/** A connection whose only method answers from `read`. */
function conn(read: (sigs: string[]) => Promise<{ value: Status[] }>) {
  const getSignatureStatuses = vi.fn(read);
  return { getSignatureStatuses, asConn: { getSignatureStatuses } as unknown as Conn };
}

/** A clock the test owns: every sleep moves it, nothing really waits. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms; }) };
}

function poll(c: Conn, timeoutMs = 60_000, k = clock()) {
  return pollConfirm(c, SIG, timeoutMs, k.sleep, k.now);
}

describe('pollConfirm', () => {
  it('confirmed without an error is confirmed', async () => {
    const c = conn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }));
    expect((await poll(c.asConn)).outcome).toBe('confirmed');
  });

  it('finalized without an error is confirmed', async () => {
    const c = conn(async () => ({ value: [{ err: null, confirmationStatus: 'finalized' }] }));
    expect((await poll(c.asConn)).outcome).toBe('confirmed');
  });

  it('carries the slot it confirmed at, and null when the status names none', async () => {
    const withSlot = conn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed', slot: 412_345_678 }] }));
    expect(await poll(withSlot.asConn)).toEqual({ outcome: 'confirmed', slot: 412_345_678 });
    const without = conn(async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] }));
    expect(await poll(without.asConn)).toEqual({ outcome: 'confirmed', slot: null });
  });

  it('an error at confirmed is reverted', async () => {
    const c = conn(async () => ({ value: [{ err: { InstructionError: [3, { Custom: 6001 }] }, confirmationStatus: 'confirmed' }] }));
    expect(await poll(c.asConn)).toEqual({ outcome: 'reverted', slot: null });
  });

  it('an error at finalized is reverted', async () => {
    const c = conn(async () => ({ value: [{ err: { InstructionError: [3, { Custom: 6001 }] }, confirmationStatus: 'finalized' }] }));
    expect((await poll(c.asConn)).outcome).toBe('reverted');
  });

  it('the time limit is unknown: never a throw, never a failure', async () => {
    const k = clock();
    const c = conn(async () => ({ value: [null] }));
    await expect(poll(c.asConn, 10_000, k)).resolves.toEqual({ outcome: 'unknown', slot: null });
    // Polled every 2 s for the whole window (0, 2, 4, 6, 8 and the look at 10 s), then stopped.
    expect(c.getSignatureStatuses).toHaveBeenCalledTimes(6);
    expect(k.sleep).toHaveBeenCalledWith(2_000);
  });

  it('a status read that throws is not an ending: the wait goes on and a later read decides', async () => {
    let n = 0;
    const c = conn(async () => {
      n += 1;
      if (n < 3) throw new Error('429 Too Many Requests');
      return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    });
    expect((await poll(c.asConn)).outcome).toBe('confirmed');
    expect(n).toBe(3);
  });

  it('reads that throw for the whole window end as unknown', async () => {
    const c = conn(async () => { throw new Error('fetch failed'); });
    await expect(poll(c.asConn, 6_000)).resolves.toEqual({ outcome: 'unknown', slot: null });
  });

  // The rule carried over from the swap path's poller. Before it, the shared module
  // returned 'reverted' on the first read below, for a transaction that then confirmed.
  it('an error seen only at processed is not an ending', async () => {
    let n = 0;
    const c = conn(async () => {
      n += 1;
      return n === 1
        ? { value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }] }
        : { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    });
    expect((await poll(c.asConn)).outcome).toBe('confirmed');
    expect(n).toBe(2);
  });

  it('an error that never gets past processed ends as unknown, not reverted', async () => {
    const c = conn(async () => ({ value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }] }));
    await expect(poll(c.asConn, 6_000)).resolves.toEqual({ outcome: 'unknown', slot: null });
  });

  it('an error on a status that names no level is not an ending either', async () => {
    let n = 0;
    const c = conn(async () => {
      n += 1;
      return n === 1
        ? { value: [{ err: { InstructionError: [0, 'Custom'] } }] }
        : { value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }] };
    });
    expect((await poll(c.asConn)).outcome).toBe('reverted');
    expect(n).toBe(2);
  });

  it('a success seen only at processed is not an ending', async () => {
    let n = 0;
    const c = conn(async () => {
      n += 1;
      return n === 1
        ? { value: [{ err: null, confirmationStatus: 'processed' }] }
        : { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    });
    expect((await poll(c.asConn)).outcome).toBe('confirmed');
    expect(n).toBe(2);
  });
});
