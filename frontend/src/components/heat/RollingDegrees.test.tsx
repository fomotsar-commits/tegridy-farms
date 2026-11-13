// Island answer twenty-four, §2b: the degrees roll up once a session; the change since the
// last visit comes from the browser's own memory; nothing moves for a reduced-motion visitor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { HeatSince, RollingDegrees } from './RollingDegrees';
import { deltaLine, sinceWords, ROLL_MS } from '../../lib/heat/ticks';

const ADDR = '0x1111111111111111111111111111111111111111';
const DAY = 24 * 3600_000;

describe('deltaLine: the change since the last visit', () => {
  const now = 1_762_000_000_000;
  it('says the change and when, from this browser’s memory', () => {
    expect(deltaLine({ degrees: 12.0, at: now - 30 * 3600_000 }, 12.44, now)).toBe('+0.44° since yesterday');
    expect(deltaLine({ degrees: 12.44, at: now - 3 * DAY }, 12.0, now)).toBe('−0.44° since 3 days ago');
    expect(deltaLine({ degrees: 12.0, at: now - 2 * 3600_000 }, 12.5, now)).toBe('+0.50° since earlier today');
  });
  it('says nothing on a first visit, an unchanged number, or a visit under an hour ago', () => {
    expect(deltaLine(null, 12, now)).toBeNull();
    expect(deltaLine({ degrees: 12, at: now - DAY }, 12.004, now)).toBeNull();
    expect(deltaLine({ degrees: 11, at: now - 1000 }, 12, now)).toBeNull();
  });
  it('words for the age', () => {
    expect(sinceWords(1000)).toBe('earlier today');
    expect(sinceWords(DAY + 1)).toBe('yesterday');
    expect(sinceWords(5 * DAY)).toBe('5 days ago');
  });
});

describe('HeatSince: the browser’s own memory, nothing stored anywhere else', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  it('a first visit remembers and says nothing; the next day it says the change', () => {
    const t0 = 1_762_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(t0);
    const first = render(<HeatSince degrees={12} address={ADDR} />);
    expect(screen.queryByTestId('heat-since')).toBeNull();
    expect(localStorage.getItem(`heat-seen:${ADDR}`)).toContain('"degrees":12');
    first.unmount();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 30 * 3600_000);
    render(<HeatSince degrees={12.44} address={ADDR} />);
    expect(screen.getByTestId('heat-since')).toHaveTextContent('+0.44° since yesterday');
    vi.restoreAllMocks();
  });
});

describe('RollingDegrees: the roll, once a session', () => {
  let raf: ((t: number) => void)[] = [];
  beforeEach(() => {
    sessionStorage.clear();
    raf = [];
    vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
      raf.push(cb);
      return raf.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    // A browser that can say motion is wanted; without matchMedia nothing rolls.
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    vi.spyOn(performance, 'now').mockReturnValue(1000);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it('starts at 0, reaches the number by 600 ms, and does not roll again this session', () => {
    render(<RollingDegrees degrees={12.34} address={ADDR} />);
    expect(screen.getByTestId('heat-degrees')).toHaveTextContent('0.00');
    act(() => raf.shift()!(1300));
    const mid = Number(screen.getByTestId('heat-degrees').textContent);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(12.34);
    act(() => raf.shift()!(1000 + ROLL_MS));
    expect(screen.getByTestId('heat-degrees')).toHaveTextContent('12.34');
    expect(raf, 'the roll kept asking for frames past its end').toHaveLength(0);
    // A second mount this session shows the number at once.
    render(<RollingDegrees degrees={12.34} address={ADDR} />);
    expect(screen.getAllByTestId('heat-degrees')[1]).toHaveTextContent('12.34');
  });
  it('a reduced-motion visitor sees the number at once, and so does a browser that cannot say', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    render(<RollingDegrees degrees={12.34} address={ADDR} />);
    expect(screen.getByTestId('heat-degrees')).toHaveTextContent('12.34');
    expect(raf).toHaveLength(0);
    vi.stubGlobal('matchMedia', undefined);
    render(<RollingDegrees degrees={56.78} address={ADDR} />);
    expect(screen.getAllByTestId('heat-degrees')[1]).toHaveTextContent('56.78');
    expect(raf).toHaveLength(0);
  });
});
