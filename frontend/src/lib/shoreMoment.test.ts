// Island answer thirty, §3: the engine needs a canvas, so the island's WebKit harness proves the
// moment itself. What jsdom can prove is the promise the card leans on: where a browser hands back
// no 2D canvas (jsdom does exactly that), the engine draws nothing, throws nothing, and its stop is
// safe to call. A throw here would escape the card's effect and take the receipt card down with it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startShoreMoment } from './shoreMoment';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the engine where there is no canvas', () => {
  it('returns a stop that does nothing, and asks for no frame', () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const ring = document.createElement('div');
    let stop: (() => void) | null = null;
    expect(() => {
      stop = startShoreMoment({
        shore: document.createElement('canvas'),
        fx: document.createElement('canvas'),
        ring,
        state: 'catching',
        wallet: '8SxYtKrtPZoEwtgpkXmn7TrS7VGa1qSiGPHnYjfFWQuv',
        holders: 12,
        reduced: false,
      });
    }).not.toThrow();
    expect(getContext).toHaveBeenCalled();
    expect(typeof stop).toBe('function');
    expect(() => stop?.()).not.toThrow();
    expect(raf).not.toHaveBeenCalled();
    // Nothing struck: the ring keeps its ember.
    expect(ring.dataset.shore).toBeUndefined();
  });
});
