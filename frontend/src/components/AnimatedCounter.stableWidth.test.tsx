import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { AnimatedCounter } from './AnimatedCounter';

/**
 * A ticking number must not change its DIGIT COUNT while it ticks.
 *
 * `formatAnimatedNumber` chose its decimal count from the frame being drawn. A
 * counter travelling to 1,129.78 therefore starts below 0.01, takes the
 * micro-cap branch, renders eight decimals — "0.00000000" — and snaps to two
 * partway through. The string's width changes mid-flight and everything laid
 * out beside it moves. A 2026-09-03 field review described this as figures that
 * "shift as they tick" and prescribed `tabular-nums`; tabular figures were
 * already global (index.css:195) and cannot help here, because they equalise the
 * width of each DIGIT and this bug changes how many digits there are.
 *
 * The fix reads the decimal count from the DESTINATION, so it is fixed for the
 * whole run. Mutation-checked: passing `displayValue` back into
 * animatedDecimals() reds the first test here.
 */

/** Drive rAF manually so we can inspect the intermediate frames. */
function installFrameControl() {
  const callbacks: FrameRequestCallback[] = [];
  let now = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    callbacks.push(cb);
    return callbacks.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  return {
    advance(ms: number) {
      now += ms;
      const pending = callbacks.splice(0, callbacks.length);
      act(() => { for (const cb of pending) cb(now); });
    },
  };
}

afterEach(() => vi.restoreAllMocks());

function decimalsOf(text: string): number {
  const m = text.replace(/[^\d.,]/g, '').split('.');
  return m.length > 1 ? m[1]!.length : 0;
}

describe('AnimatedCounter keeps a stable width while animating', () => {
  it('never changes its decimal count mid-animation', () => {
    const frames = installFrameControl();
    // DIRECTION MATTERS, and it took two vacuous attempts to see why.
    // easeOutCubic rises so steeply that an UPWARD run out of 0 is already past
    // 0.01 by the first sampled frame — every frame reads two decimals and the
    // bug never shows. The decisive direction is DOWN to a sub-cent
    // destination: the intermediate frames are large (2 decimals) while the
    // destination is tiny (8), so a per-frame decision flips the digit count
    // partway through and the string's width jumps. That is a real tile: a price
    // or TVL figure re-animating onto a much smaller value.
    const { container, rerender } = render(<AnimatedCounter value={1129.78} decimals={2} duration={1000} />);
    rerender(<AnimatedCounter value={0.00006781} decimals={2} duration={1000} />);

    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      frames.advance(90);
      const text = container.textContent ?? '';
      if (text) seen.add(decimalsOf(text));
    }

    expect(
      [...seen],
      'the decimal count changed while the value was animating, so the string width jittered',
    ).toEqual([8]);
  });

  it('still gives a genuinely sub-cent target its micro-cap precision', () => {
    // The branch exists for a reason — a $0.00006781 token price needs it. What
    // changed is only WHERE the decision is made, not that it is made.
    const frames = installFrameControl();
    const { container, rerender } = render(<AnimatedCounter value={0} decimals={2} duration={1000} />);
    rerender(<AnimatedCounter value={0.00006781} decimals={2} duration={1000} />);
    frames.advance(1200);
    expect(decimalsOf(container.textContent ?? '')).toBe(8);
  });

  it('holds that precision steady across the run too', () => {
    const frames = installFrameControl();
    const { container, rerender } = render(<AnimatedCounter value={0} decimals={2} duration={1000} />);
    rerender(<AnimatedCounter value={0.00006781} decimals={2} duration={1000} />);
    const seen = new Set<number>();
    for (let i = 0; i < 12; i++) {
      frames.advance(90);
      const text = container.textContent ?? '';
      if (text) seen.add(decimalsOf(text));
    }
    expect([...seen]).toEqual([8]);
  });
});
