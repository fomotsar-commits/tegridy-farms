// THE CURTAIN'S DEADLINE — the promise, tested as behaviour rather than summed.
//
// This file exists because a sum lied. The curtain's length was stated as
// void + art + dissolve = 2,000 ms and a guard "pinned the promise
// arithmetically". Two legs were missing from that sum: the wordmark's own
// 2,000 ms (a literal inside phases/textForm.ts, shared with the film) and the
// preload gate's up-to-2,500 ms. The island ran the branch instead of reading
// it and measured the curtain alive at 4,250 ms warm, 6,100 ms behind a slow
// image. The guard was green the whole time.
//
// So the promise is a timer now, and this asserts the timer — under the worst
// conditions the app can present:
//
//   - no 2D canvas context at all, so the animation tick NEVER RUNS;
//   - a preload that never resolves, so no art ever arrives.
//
// Those are exactly the conditions where a sum, or a deadline that depended on
// the tick, would fail silently. If this passes, the curtain cannot outstay its
// budget on any machine.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { CURTAIN_BUDGET_MS, CURTAIN_TIMING, DEADLINE_SLACK_MS, SKIP_DISSOLVE_MS } from './constants';
import { ARRIVAL_SEEN_KEY } from './skip';

// The preload NEVER resolves. A curtain that waits for the network is the
// defect; a curtain that waits forever is the test.
vi.mock('./preload', () => ({
  preloadImages: () => new Promise(() => {}),
}));

// Audio and post-processing are constructed on the first gesture / mount path.
// Neither exists in jsdom and neither is under test here.
vi.mock('./fx/audio', () => ({
  AudioEngine: class {
    init() {}
    playAmbient() {}
    playCrack() {}
    fadeOutAmbient() {}
    dispose() {}
    setMuted() {}
  },
}));
vi.mock('./fx/postfx', () => ({
  PostFX: class {
    init() { return false; }
    render() {}
    resize() {}
    dispose() {}
  },
}));

const { AppLoader } = await import('./AppLoader');

const realMatchMedia = window.matchMedia;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  window.history.replaceState({}, '', '/');
  // Not reduced motion, or the curtain never plays and the test proves nothing.
  window.matchMedia = ((q: string) => ({
    matches: false, media: q,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
    onchange: null, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  // NO 2D CONTEXT: the animation tick can never start.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  window.matchMedia = realMatchMedia;
  localStorage.clear();
  sessionStorage.clear();
});

describe('the curtain is gone by its budget, whatever the machine does', () => {
  it('ends within CURTAIN_BUDGET_MS with no canvas and no art', () => {
    const onComplete = vi.fn();
    render(<AppLoader onComplete={onComplete} />);

    // It is up, and nothing has finished it yet.
    expect(onComplete).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CURTAIN_BUDGET_MS);
    expect(onComplete).toHaveBeenCalled();
  });

  it('is still up shortly before the budget, so the deadline is real and not instant', () => {
    const onComplete = vi.fn();
    render(<AppLoader onComplete={onComplete} />);

    vi.advanceTimersByTime(CURTAIN_BUDGET_MS - SKIP_DISSOLVE_MS - 50);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('fires onComplete exactly once, not once per timer', () => {
    // Two timers arm the deadline (dissolve, then the unconditional end). The
    // shell owes its consumer a single onComplete: AppLayout's whole first-visit
    // sequence hangs off it.
    const onComplete = vi.fn();
    render(<AppLoader onComplete={onComplete} />);

    vi.advanceTimersByTime(CURTAIN_BUDGET_MS * 3);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('arms NO deadline for the film, which ends only by choice', () => {
    const onComplete = vi.fn();
    render(<AppLoader full onComplete={onComplete} />);

    vi.advanceTimersByTime(CURTAIN_BUDGET_MS * 4);
    expect(onComplete).not.toHaveBeenCalled();
  });

  // ONCE PER BROWSER, AND THE DEADLINE IS WHY IT NEEDS ITS OWN GUARD.
  //
  // The mark used to live only in the animation tick, at the frames where the
  // curtain ends by its own choreography. Arming the deadline made those frames
  // unreachable — skipIntro at goneBy - 400, a dissolve that needs 400, and the
  // finalize timer at goneBy winning the race — so `tf_loaded` was never
  // written and the curtain replayed on every single load. The island measured
  // five runs of five before anyone here noticed, because the guard that
  // claimed "once per browser: yes" read the skip decision instead of loading
  // the page twice.
  //
  // These two run under the same worst case as everything above: no 2D context,
  // so the tick never runs at all. Move the mark back inside the tick and both
  // go red immediately.
  it('marks the arrival at MOUNT, not at a frame the deadline never allows', () => {
    render(<AppLoader onComplete={vi.fn()} />);
    expect(localStorage.getItem(ARRIVAL_SEEN_KEY)).toBe('1');
  });

  it('has already marked it by the moment onComplete fires', () => {
    // Sampled INSIDE the callback. Asserting after the fact would pass on a
    // write that landed late, which is the same bug wearing a later timestamp:
    // AppLayout reads this during render, and by then it is over.
    let markedWhenCalled: string | null | undefined;
    const onComplete = vi.fn(() => {
      markedWhenCalled = localStorage.getItem(ARRIVAL_SEEN_KEY);
    });
    render(<AppLoader onComplete={onComplete} />);

    vi.advanceTimersByTime(CURTAIN_BUDGET_MS);
    expect(onComplete).toHaveBeenCalled();
    expect(markedWhenCalled).toBe('1');
  });

  it('does NOT mark at mount for the film, whose exits do their own marking', () => {
    // The ruling is curtain-only. The film has no deadline, so its three calls
    // in the tick are still reachable, and a mount-time mark there would
    // consume the arrival of someone who closes the tab two seconds in.
    render(<AppLoader full onComplete={vi.fn()} />);
    expect(localStorage.getItem(ARRIVAL_SEEN_KEY)).toBeNull();
  });

  it('clears its timers on unmount rather than firing into a dead component', () => {
    const onComplete = vi.fn();
    const { unmount } = render(<AppLoader onComplete={onComplete} />);
    unmount();

    vi.advanceTimersByTime(CURTAIN_BUDGET_MS * 2);
    expect(onComplete).not.toHaveBeenCalled();
  });

  // THE MACHINE'S SHARE, KEPT BACK FROM THE BUDGET.
  //
  // A timer armed AT the budget can only be met late: setTimeout fires at or
  // after its delay, and the removal still has a render to commit after that.
  // CI measured this path at 3,002 to 3,010 ms in five tries against the
  // 3,000 ms promise, and the same commit passed at 2,935 ms on a retry. So the
  // deadline ends the curtain DEADLINE_SLACK_MS early, and the budget holds.
  it('is gone by the budget less the slack it keeps for the machine', () => {
    const onComplete = vi.fn();
    render(<AppLoader onComplete={onComplete} />);

    vi.advanceTimersByTime(CURTAIN_BUDGET_MS - DEADLINE_SLACK_MS - 1);
    expect(onComplete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps a slack larger than the lateness measured, and small enough not to cut the name short', () => {
    // Larger than the 10 ms CI measured past the budget, or it buys nothing.
    expect(DEADLINE_SLACK_MS).toBeGreaterThan(10);
    // Small enough that a choreography running on time still reaches its own
    // dissolve before the deadline asks for one: the deadline is for a curtain
    // that is late, not a shorter curtain for everyone.
    //
    // TWO CLOCKS, AND THIS COMPARES THEM AS ONE. The left side counts from the
    // commit that arms the timers; the right side from `s.t0`, stamped later in
    // the canvas effect, after the post-processing pass is built. That gap is
    // spent before the choreography starts counting and not before the deadline
    // does, so the real margin is smaller than this arithmetic. Read it as a
    // floor, not as a promise that the deadline never cuts an on-time curtain.
    const onTime = CURTAIN_TIMING.voidEnd
      + CURTAIN_TIMING.artCount * CURTAIN_TIMING.artDuration
      + CURTAIN_TIMING.textForm;
    expect(CURTAIN_BUDGET_MS - DEADLINE_SLACK_MS - SKIP_DISSOLVE_MS).toBeGreaterThanOrEqual(onTime);
  });

  // A PARENT RE-RENDER IS NOT A NEW ARRIVAL.
  //
  // AppLayout mounts the loader as onComplete={() => setSplashDone(true)}: a
  // fresh function on every render, and the eager shell forwards it untouched.
  // So anything keyed on onComplete's identity re-runs whenever the layout
  // renders under the curtain, and it subscribes to the wallet, the theme and
  // the route.
  // finalize WAS keyed on it, and both the deadline and the choreography were
  // keyed on finalize: every re-render cleared the deadline and armed a fresh
  // one, and started the curtain again from the void.
  it('does not restart the deadline when the parent re-renders mid-arrival', () => {
    const first = vi.fn();
    const { rerender } = render(<AppLoader onComplete={first} />);
    vi.advanceTimersByTime(2000);

    const latest = vi.fn();
    rerender(<AppLoader onComplete={latest} />);

    vi.advanceTimersByTime(CURTAIN_BUDGET_MS - 2000);
    // Gone on the ORIGINAL schedule, and it is the CURRENT callback that hears.
    expect(latest).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  it('does not restart the choreography when the parent re-renders', () => {
    // The canvas effect asks for its 2D context once per run, so the count of
    // asks IS the count of runs. The spy answers null, which also keeps the
    // tick from starting: a run is observable here without drawing a frame.
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    const { rerender } = render(<AppLoader onComplete={() => {}} />);
    const runs = getContext.mock.calls.length;
    expect(runs, 'the canvas effect never ran, so this proves nothing').toBeGreaterThan(0);

    rerender(<AppLoader onComplete={() => {}} />);
    rerender(<AppLoader onComplete={() => {}} />);
    expect(getContext.mock.calls.length).toBe(runs);
  });
});
