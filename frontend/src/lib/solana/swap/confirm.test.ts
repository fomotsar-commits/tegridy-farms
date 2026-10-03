import { describe, it, expect, vi } from 'vitest';
import { pollSignature, type SignatureStatusReader } from './confirm';

/**
 * A SENT swap has three truthful endings: landed, refused on chain, or not
 * known yet. Before this file existed the page's `pollConfirm` THREW on a
 * timeout and on any status read error, and the throw became a "Swap failed"
 * toast for a transaction that may well have landed.
 */

const SIG = '5'.repeat(88);

/** A clock the test owns: every sleep moves it, nothing really waits. */
function clock() {
  let t = 0;
  return { now: () => t, sleep: vi.fn(async (ms: number) => { t += ms; }) };
}

describe('pollSignature', () => {
  it('confirmed without an error is confirmed', async () => {
    const read: SignatureStatusReader = async () => ({ value: [{ err: null, confirmationStatus: 'confirmed' }] });
    expect(await pollSignature(read, SIG, clock())).toBe('confirmed');
  });

  it('finalized without an error is confirmed', async () => {
    const read: SignatureStatusReader = async () => ({ value: [{ err: null, confirmationStatus: 'finalized' }] });
    expect(await pollSignature(read, SIG, clock())).toBe('confirmed');
  });

  it('an error at confirmed is reverted', async () => {
    const read: SignatureStatusReader = async () => ({ value: [{ err: { InstructionError: [3, { Custom: 6001 }] }, confirmationStatus: 'confirmed' }] });
    expect(await pollSignature(read, SIG, clock())).toBe('reverted');
  });

  it('the time limit is unknown: never a throw, never a failure', async () => {
    const c = clock();
    const read = vi.fn<SignatureStatusReader>(async () => ({ value: [null] }));
    await expect(pollSignature(read, SIG, { ...c, timeoutMs: 10_000 })).resolves.toBe('unknown');
    // Polled every 2 s for the whole window, then stopped.
    expect(read).toHaveBeenCalledTimes(5);
    expect(c.sleep).toHaveBeenCalledWith(2000);
  });

  it('a status read that throws is not an ending: the wait goes on and a later read decides', async () => {
    let n = 0;
    const read: SignatureStatusReader = async () => {
      n += 1;
      if (n < 3) throw new Error('429 Too Many Requests');
      return { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    };
    expect(await pollSignature(read, SIG, clock())).toBe('confirmed');
    expect(n).toBe(3);
  });

  it('reads that throw for the whole window end as unknown', async () => {
    const read: SignatureStatusReader = async () => { throw new Error('fetch failed'); };
    await expect(pollSignature(read, SIG, { ...clock(), timeoutMs: 6_000 })).resolves.toBe('unknown');
  });

  it('an error seen only at processed is not an ending', async () => {
    let n = 0;
    const read: SignatureStatusReader = async () => {
      n += 1;
      return n === 1
        ? { value: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'processed' }] }
        : { value: [{ err: null, confirmationStatus: 'confirmed' }] };
    };
    expect(await pollSignature(read, SIG, clock())).toBe('confirmed');
  });
});
