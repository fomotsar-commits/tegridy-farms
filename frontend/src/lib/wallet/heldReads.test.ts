// A pool read shared between the dashboard's board and Harvest (heldReads.ts). What it holds:
// a read is shared while in flight and for HOLD_MS after it lands whole; a failed or partly
// unread answer is never handed to the next caller; a forget means the next caller reads afresh.

import { describe, it, expect, beforeEach } from 'vitest';
import { HOLD_MS, forgetHeldReads, heldRead } from './heldReads';

let clock = 0;
const now = () => clock;
let made = 0;
const whole = (a: { whole: boolean }) => a.whole;

function reader(answer: { whole: boolean } | Error) {
  return () => {
    made += 1;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  };
}

/** A read that lands only when told to. */
function pending() {
  let land!: (a: { whole: boolean }) => void;
  const read = new Promise<{ whole: boolean }>((r) => { land = r; });
  return { make: () => { made += 1; return read; }, land };
}

beforeEach(() => {
  forgetHeldReads();
  clock = 1_000;
  made = 0;
});

describe('heldRead', () => {
  it('shares a read in flight, then holds a whole answer for HOLD_MS after it lands', async () => {
    const p = pending();
    const a = heldRead('k', p.make, whole, now);
    const b = heldRead('k', reader({ whole: true }), whole, now);
    expect(b).toBe(a);
    clock += 60_000; // a slow read: the hold counts from when it lands, not when it was asked
    p.land({ whole: true });
    await a;
    clock += HOLD_MS - 1;
    await heldRead('k', reader({ whole: true }), whole, now);
    expect(made).toBe(1);
    clock += 1;
    await heldRead('k', reader({ whole: true }), whole, now);
    expect(made).toBe(2);
  });

  it('never hands on a partly unread answer or a failure: the next caller asks again', async () => {
    await heldRead('k', reader({ whole: false }), whole, now);
    await heldRead('k', reader({ whole: true }), whole, now);
    expect(made).toBe(2);
    forgetHeldReads();
    await expect(heldRead('f', reader(new Error('429')), whole, now)).rejects.toThrow('429');
    await heldRead('f', reader({ whole: true }), whole, now);
    expect(made).toBe(4);
  });

  it('a forget while a read is in flight: the next caller reads afresh, and the old answer never replaces it', async () => {
    const old = pending();
    const first = heldRead('k', old.make, whole, now);
    forgetHeldReads();
    const fresh = heldRead('k', reader({ whole: true }), whole, now);
    expect(fresh).not.toBe(first);
    await fresh;
    old.land({ whole: true });
    await first;
    expect(await heldRead('k', reader({ whole: true }), whole, now)).toBe(await fresh);
    expect(made).toBe(2);
  });

  it('keys apart: another pool or another wallet is its own read', async () => {
    await heldRead('entries:A:me', reader({ whole: true }), whole, now);
    await heldRead('entries:A:you', reader({ whole: true }), whole, now);
    await heldRead('entries:B:me', reader({ whole: true }), whole, now);
    expect(made).toBe(3);
  });
});
