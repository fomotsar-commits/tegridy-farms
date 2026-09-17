// THE FILM'S LIFECYCLE - rewritten from curtainDeadline.test.tsx (answer ten, ruling 1).
//
// That file tested the curtain's deadline: a timer that ended the short arrival
// overlay inside a 3,000 ms budget whatever the machine did. The curtain is gone
// from the arrival and deleted from the loader, so its budget, its slack and its
// mark-the-arrival-at-mount tests had nothing left to protect.
//
// What it ALSO pinned was true of the film, and is kept here:
//
//   - the film ends only by choice: no timer ever ends it for the viewer;
//   - a parent re-render is not a new film: IslandPage passes an inline arrow,
//     and anything keyed on its identity would restart the choreography;
//   - unmounting mid-film never calls onComplete into a dead parent;
//   - the film writes no arrival record. The record decided whether the curtain
//     played; with no curtain there is no reader, so a write would be the
//     half-retired record the island ruled out.
//
// THE FILM ACTUALLY PLAYS HERE. The first version of this file ran with no 2D
// context, so the canvas effect returned before its animation loop, its preload
// timer or any of its exits existed, and a review showed three of these tests could
// not fail: an auto-end timer, a missing cleanup or a storage write inside that
// effect all stayed green. So the context is a stub that accepts every call, the
// clock drives requestAnimationFrame, and each test first proves frames are being
// drawn before it asserts anything about what those frames did.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

vi.mock('./preload', () => ({
  // Art that never arrives: the film proceeds on its own 2,500 ms budget.
  preloadImages: () => new Promise(() => {}),
}));
vi.mock('./fx/audio', () => ({
  AudioEngine: class {
    init() {}
    playAmbient() {}
    playCrack() {}
    fadeOutAmbient() {}
    dispose() {}
    setMute() {}
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
// A dozen particles instead of two thousand: the choreography is the same code.
vi.mock('./geometry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./geometry')>()),
  MAX_PARTICLES: 12,
}));

const { AppLoader } = await import('./AppLoader');
const { SKIP_DISSOLVE_MS } = await import('./constants');

/** Every frame the tick draws starts with clearRect, so this counts frames drawn. */
let framesDrawn = 0;

/** A 2D context that accepts anything the film asks of it. */
function stubContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const props: Record<string | symbol, unknown> = { canvas };
  return new Proxy(props, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'clearRect') return () => { if (canvas.isConnected) framesDrawn += 1; };
      if (key === 'measureText') return (s: string) => ({ width: s.length * 8 });
      if (key === 'getImageData') {
        return (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(4), width: w, height: h });
      }
      if (key === 'createLinearGradient' || key === 'createRadialGradient') return () => ({ addColorStop() {} });
      return () => undefined;
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

const film = () => document.querySelector('[data-arrival="film"]');
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

/** Frames drawn over the next `ms`: the proof the loop is running, not a stale count. */
function framesOver(ms: number): number {
  const before = framesDrawn;
  advance(ms);
  return framesDrawn - before;
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
  });
  framesDrawn = 0;
  localStorage.clear();
  sessionStorage.clear();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return stubContext(this);
  } as unknown as HTMLCanvasElement['getContext']);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('the film', () => {
  it('mounts its overlay at once, with no skip decision to consult', () => {
    render(<AppLoader onComplete={() => {}} />);
    expect(film()).not.toBeNull();
  });

  it('plays: frames are drawn once the art budget runs out, so the tests below watch a running film', () => {
    render(<AppLoader onComplete={() => {}} />);
    advance(3_000);
    expect(framesOver(1_000), 'the animation loop never started').toBeGreaterThan(30);
  });

  it('ends only by choice: no timer ends it, however long it plays', () => {
    const onComplete = vi.fn();
    render(<AppLoader onComplete={onComplete} />);
    advance(60_000);
    expect(framesOver(1_000), 'the film stopped drawing on its own').toBeGreaterThan(30);
    expect(onComplete).not.toHaveBeenCalled();
    expect(film()).not.toBeNull();
  });

  it('Escape ends it, and the parent hears exactly once', () => {
    const onComplete = vi.fn();
    render(<AppLoader onComplete={onComplete} />);
    advance(5_000);
    fireEvent.keyDown(window, { key: 'Escape' });
    advance(SKIP_DISSOLVE_MS + 500);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(film()).toBeNull();
  });

  it('a Skip tapped while the art is still loading ends the film instead of being overwritten', () => {
    // The Skip button shows at 400 ms and the art may take up to 2,500 ms. A skip in
    // between set the phase, and then the preload's own continuation set it back to
    // the start and played the whole film.
    const onComplete = vi.fn();
    render(<AppLoader onComplete={onComplete} />);
    advance(500);
    fireEvent.click(screen.getByRole('button', { name: 'Skip intro animation' }));
    advance(SKIP_DISSOLVE_MS + 100);
    expect(onComplete, 'the skip waited for the art to finish loading').toHaveBeenCalledTimes(1);
    advance(10_000);
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(film()).toBeNull();
  });

  it('never calls onComplete into a parent that unmounted it mid-film', () => {
    const onComplete = vi.fn();
    const { unmount } = render(<AppLoader onComplete={onComplete} />);
    advance(5_000);
    expect(framesOver(500)).toBeGreaterThan(10);
    // Mid-dissolve: the next frames would have finalized.
    fireEvent.keyDown(window, { key: 'Escape' });
    unmount();
    advance(60_000);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not restart the choreography when the parent re-renders', () => {
    // The canvas effect asks for its 2D context once per run, so the count of
    // asks IS the count of runs (the film's own offscreen canvases aside, which
    // are only made once it has played on, and this asks before that).
    const getContext = vi.mocked(HTMLCanvasElement.prototype.getContext);
    const { rerender } = render(<AppLoader onComplete={() => {}} />);
    const runs = getContext.mock.calls.length;
    expect(runs, 'the canvas effect never ran, so this proves nothing').toBeGreaterThan(0);

    rerender(<AppLoader onComplete={() => {}} />);
    rerender(<AppLoader onComplete={() => {}} />);
    expect(getContext.mock.calls.length).toBe(runs);
  });

  it('writes no arrival record, in either storage, through a whole viewing and its end', () => {
    const onComplete = vi.fn();
    render(<AppLoader onComplete={onComplete} />);
    advance(20_000);
    fireEvent.keyDown(window, { key: 'Escape' });
    advance(SKIP_DISSOLVE_MS + 500);
    expect(onComplete, 'the film never ended, so its exits were never walked').toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});
