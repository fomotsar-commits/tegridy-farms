import { describe, it, expect, afterEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { publishLadderPick, useLadderPick, type LadderPick } from './ladderPick';

const RUNGS = [
  { bps: 4_000, lock: '7d', weight: '0.40×' },
  { bps: 40_000, lock: '4y', weight: '4.00×' },
];
const pick = (picked: number | null, held: number[] | null = null): LadderPick => ({ rungs: RUNGS, picked, held, meter: 'idle' });

afterEach(() => {
  publishLadderPick('bayla', null);
  publishLadderPick('soy', null);
});

describe("a pool page's ladder pick (lib/ladderPick.ts)", () => {
  it('is nothing until a staircase publishes, then the very object it published', () => {
    const { result } = renderHook(() => useLadderPick('bayla'));
    expect(result.current).toBeNull();
    const first = pick(0);
    act(() => publishLadderPick('bayla', first));
    expect(result.current).toBe(first);
  });

  it('is replaced by the next publish, and cleared by null', () => {
    const { result } = renderHook(() => useLadderPick('bayla'));
    act(() => publishLadderPick('bayla', pick(0)));
    const next = pick(1, [12_869]);
    act(() => publishLadderPick('bayla', next));
    expect(result.current).toBe(next);
    act(() => publishLadderPick('bayla', null));
    expect(result.current).toBeNull();
  });

  it('holds one snapshot between publishes: a re-render, or the same object again, changes nothing', () => {
    let renders = 0;
    const { result, rerender } = renderHook(() => {
      renders += 1;
      return useLadderPick('bayla');
    });
    const only = pick(0);
    act(() => publishLadderPick('bayla', only));
    const seen = renders;
    rerender();
    expect(result.current).toBe(only);
    act(() => publishLadderPick('bayla', only));
    expect(renders).toBe(seen + 1);
    expect(result.current).toBe(only);
  });

  it('keeps two rooms apart', () => {
    const bayla = renderHook(() => useLadderPick('bayla'));
    const soy = renderHook(() => useLadderPick('soy'));
    const mine = pick(1);
    act(() => publishLadderPick('bayla', mine));
    expect(bayla.result.current).toBe(mine);
    expect(soy.result.current).toBeNull();
    act(() => publishLadderPick('soy', pick(0)));
    act(() => publishLadderPick('soy', null));
    expect(bayla.result.current).toBe(mine);
    expect(soy.result.current).toBeNull();
  });
});
