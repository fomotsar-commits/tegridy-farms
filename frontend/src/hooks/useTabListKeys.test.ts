import { describe, it, expect } from 'vitest';
import { nextTabIndex } from './useTabListKeys';

describe('nextTabIndex (WAI-ARIA tabs roving focus)', () => {
  const N = 4; // e.g. swap / liquidity / dca / limit

  it('ArrowRight advances and wraps at the end', () => {
    expect(nextTabIndex(0, N, 'ArrowRight')).toBe(1);
    expect(nextTabIndex(3, N, 'ArrowRight')).toBe(0);
  });

  it('ArrowDown behaves like ArrowRight', () => {
    expect(nextTabIndex(1, N, 'ArrowDown')).toBe(2);
    expect(nextTabIndex(3, N, 'ArrowDown')).toBe(0);
  });

  it('ArrowLeft retreats and wraps at the start', () => {
    expect(nextTabIndex(1, N, 'ArrowLeft')).toBe(0);
    expect(nextTabIndex(0, N, 'ArrowLeft')).toBe(3);
  });

  it('ArrowUp behaves like ArrowLeft', () => {
    expect(nextTabIndex(2, N, 'ArrowUp')).toBe(1);
    expect(nextTabIndex(0, N, 'ArrowUp')).toBe(3);
  });

  it('Home/End jump to first/last', () => {
    expect(nextTabIndex(2, N, 'Home')).toBe(0);
    expect(nextTabIndex(1, N, 'End')).toBe(3);
  });

  it('returns -1 for non-navigation keys (caller ignores)', () => {
    expect(nextTabIndex(0, N, 'Enter')).toBe(-1);
    expect(nextTabIndex(0, N, ' ')).toBe(-1);
    expect(nextTabIndex(0, N, 'Tab')).toBe(-1);
    expect(nextTabIndex(0, N, 'a')).toBe(-1);
  });

  it('handles empty/degenerate tablists safely', () => {
    expect(nextTabIndex(0, 0, 'ArrowRight')).toBe(-1);
    expect(nextTabIndex(0, 1, 'ArrowRight')).toBe(0);
    expect(nextTabIndex(0, 1, 'ArrowLeft')).toBe(0);
  });
});
