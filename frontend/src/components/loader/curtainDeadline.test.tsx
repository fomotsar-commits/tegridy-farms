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
import { CURTAIN_BUDGET_MS, SKIP_DISSOLVE_MS } from './constants';

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

  it('clears its timers on unmount rather than firing into a dead component', () => {
    const onComplete = vi.fn();
    const { unmount } = render(<AppLoader onComplete={onComplete} />);
    unmount();

    vi.advanceTimersByTime(CURTAIN_BUDGET_MS * 2);
    expect(onComplete).not.toHaveBeenCalled();
  });
});
