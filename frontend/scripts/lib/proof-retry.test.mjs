import { describe, it, expect } from 'vitest';
import { COULD_NOT_RUN, couldNotRun, keepProving, proveAtStart } from './proof-retry.mjs';

const BUSY = `${COULD_NOT_RUN}: getAccountInfo: the RPC answered 429`;
const FAILED = 'the check at the balance failed: {"InstructionError":[0,{"Custom":6001}]}';
/** A proof that answers `answers` in turn (the last one again after that), counting its calls. */
function proofOf(answers) {
  let calls = 0;
  const prove = async () => {
    const a = answers[Math.min(calls++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  return { prove, calls: () => calls };
}

describe('couldNotRun: the proof never ran, as against ran and failed', () => {
  it('reads the robot’s own wording', () => {
    expect(couldNotRun(BUSY)).toBe(true);
    expect(couldNotRun(FAILED)).toBe(false);
    expect(couldNotRun(null)).toBe(false);
  });
});

describe('proveAtStart: the start-up proof asked again when it could not run', () => {
  const slept = [];
  const sleep = async (ms) => void slept.push(ms);

  it('proven at once is asked once', async () => {
    const p = proofOf([null]);
    expect(await proveAtStart(p.prove, { sleep })).toEqual({ proof: null, tried: 1 });
    expect(p.calls()).toBe(1);
  });

  it('asks again, a wait apart, while the RPC is too busy, and takes the proof when it comes (2026-11-14 08:15:50Z: one 429 cost the whole run its cap)', async () => {
    slept.length = 0;
    const p = proofOf([BUSY, BUSY, null]);
    expect(await proveAtStart(p.prove, { sleep, waitMs: 2_000 })).toEqual({ proof: null, tried: 3 });
    expect(slept).toEqual([2_000, 2_000]);
  });

  it('gives up after its tries and answers why, so the robot starts capped rather than waits', async () => {
    const p = proofOf([BUSY]);
    expect(await proveAtStart(p.prove, { sleep, tries: 4 })).toEqual({ proof: BUSY, tried: 4 });
    expect(p.calls()).toBe(4);
  });

  it('never asks again for a proof that ran and failed: that is the chain’s answer', async () => {
    const p = proofOf([FAILED, null]);
    expect(await proveAtStart(p.prove, { sleep })).toEqual({ proof: FAILED, tried: 1 });
    expect(p.calls()).toBe(1);
  });
});

describe('keepProving: asked again while the robot runs unproven', () => {
  /** A timer the test turns by hand: `tick()` runs the function once and waits for it. */
  function timer() {
    let fn = null;
    let stopped = 0;
    return {
      every: (f) => ((fn = f), 'handle'),
      stop: (h) => {
        expect(h).toBe('handle');
        stopped++;
        fn = null;
      },
      tick: async () => (fn ? fn() : undefined),
      running: () => fn !== null,
      stopped: () => stopped,
    };
  }

  it('lifts the cap once, at the first clean proof, and stops asking', async () => {
    const t = timer();
    const p = proofOf([BUSY, FAILED, null, null]);
    const proven = [];
    keepProving(p.prove, { onProven: (asked) => proven.push(asked), every: t.every, stop: t.stop });
    await t.tick();
    await t.tick();
    expect(proven).toEqual([]);
    await t.tick();
    expect(proven).toEqual([3]);
    expect(t.running()).toBe(false);
    await t.tick();
    expect(p.calls()).toBe(3);
  });

  it('takes a proof that ran and failed mid-run as a reason to ask again, never as proven (a trip can move the balance between its two test runs)', async () => {
    const t = timer();
    const p = proofOf([FAILED]);
    const proven = [];
    const gaveUp = [];
    keepProving(p.prove, { onProven: () => proven.push(1), onGaveUp: (why) => gaveUp.push(why), most: 3, every: t.every, stop: t.stop });
    await t.tick();
    await t.tick();
    expect(gaveUp).toEqual([]);
    await t.tick();
    expect(proven).toEqual([]);
    expect(gaveUp).toEqual([FAILED]);
    expect(t.running()).toBe(false);
  });

  it('counts a proof that throws as one that could not run, and asks again', async () => {
    const t = timer();
    const p = proofOf([new Error('fetch failed'), null]);
    const proven = [];
    keepProving(p.prove, { onProven: (asked) => proven.push(asked), every: t.every, stop: t.stop });
    await t.tick();
    expect(proven).toEqual([]);
    await t.tick();
    expect(proven).toEqual([2]);
  });

  it('never runs two proofs at once, and its stop ends it for good', async () => {
    const t = timer();
    let release;
    let calls = 0;
    const slow = () => new Promise((r) => ((calls++), (release = () => r(null))));
    const proven = [];
    const stop = keepProving(slow, { onProven: () => proven.push(1), every: t.every, stop: t.stop });
    const first = t.tick();
    await t.tick(); // the first is still running: this turn does nothing
    expect(calls).toBe(1);
    stop();
    release();
    await first;
    // Stopped before the proof came back: the cap is not lifted by it.
    expect(proven).toEqual([]);
    expect(t.stopped()).toBeGreaterThanOrEqual(1);
  });
});
