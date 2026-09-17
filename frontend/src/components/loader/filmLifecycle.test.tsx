// THE FILM'S LIFECYCLE - rewritten from curtainDeadline.test.tsx (answer ten, ruling 1).
//
// That file tested the curtain's deadline: a timer that ended the short arrival
// overlay inside a 3,000 ms budget whatever the machine did. The curtain is gone
// from the arrival and deleted from the loader, so its budget, its slack and its
// mark-the-arrival-at-mount tests had nothing left to protect.
//
// What it ALSO pinned was true of the film, and is kept here under the same worst
// conditions: no 2D canvas context (so the animation tick never runs) and a
// preload that never resolves.
//
//   - the film ends only by choice: no timer ever ends it for the viewer;
//   - a parent re-render is not a new film: IslandPage passes an inline arrow,
//     and anything keyed on its identity would restart the choreography;
//   - unmounting mid-film never calls onComplete into a dead parent.
//
// And one the curtain never had to prove: the film writes no arrival record. The
// record decided whether the curtain played; with no curtain there is no reader,
// so a write would be the half-retired record the island ruled out.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('./preload', () => ({
  preloadImages: () => new Promise(() => {}),
}));
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

/** Long past anything the old curtain ever lived: an hour of fake time. */
const AN_HOUR = 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  sessionStorage.clear();
  // NO 2D CONTEXT: the animation tick can never start.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('the film', () => {
  it('mounts its overlay at once, with no skip decision to consult', () => {
    const { container } = render(<AppLoader onComplete={() => {}} />);
    expect(container.querySelector('[data-arrival="film"]')).not.toBeNull();
  });

  it('ends only by choice: no timer ends it, however long it plays', () => {
    const onComplete = vi.fn();
    const { container } = render(<AppLoader onComplete={onComplete} />);
    vi.advanceTimersByTime(AN_HOUR);
    expect(onComplete).not.toHaveBeenCalled();
    expect(container.querySelector('[data-arrival="film"]')).not.toBeNull();
  });

  it('never calls onComplete into a parent that unmounted it mid-film', () => {
    const onComplete = vi.fn();
    const { unmount } = render(<AppLoader onComplete={onComplete} />);
    unmount();
    vi.advanceTimersByTime(AN_HOUR);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not restart the choreography when the parent re-renders', () => {
    // The canvas effect asks for its 2D context once per run, so the count of
    // asks IS the count of runs.
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    const { rerender } = render(<AppLoader onComplete={() => {}} />);
    const runs = getContext.mock.calls.length;
    expect(runs, 'the canvas effect never ran, so this proves nothing').toBeGreaterThan(0);

    rerender(<AppLoader onComplete={() => {}} />);
    rerender(<AppLoader onComplete={() => {}} />);
    expect(getContext.mock.calls.length).toBe(runs);
  });

  it('writes no arrival record, in either storage', () => {
    render(<AppLoader onComplete={() => {}} />);
    vi.advanceTimersByTime(AN_HOUR);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
