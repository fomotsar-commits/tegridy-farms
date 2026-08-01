import { describe, it, expect } from 'vitest';
import { seasonStatus } from './season';

// A fixed window so these assertions never drift with the real CURRENT_SEASON dates.
const WINDOW = { startDate: '2026-06-07', endDate: '2026-09-05' };
const at = (iso: string) => Date.parse(iso);

describe('seasonStatus', () => {
  it('counts down while the window is open', () => {
    const s = seasonStatus(at('2026-09-01T00:00:00Z'), WINDOW);
    expect(s.phase).toBe('active');
    expect(s.days).toBe(4);
    expect(s.shortLabel).toBe('4d left');
  });

  it('reports the window as ENDED rather than freezing at "0d left"', () => {
    // The defect: FarmPage did Math.max(0, ceil((end - now)/day)), so every day after
    // endDate rendered a confident "0d left" forever. Pin the phase, not the number.
    const s = seasonStatus(at('2027-01-01T00:00:00Z'), WINDOW);
    expect(s.phase).toBe('ended');
    expect(s.shortLabel).toBe('Ended');
    expect(s.shortLabel).not.toContain('left');
  });

  it('is ended the instant endDate is reached, not a day later', () => {
    expect(seasonStatus(at('2026-09-05T00:00:00Z'), WINDOW).phase).toBe('ended');
    expect(seasonStatus(at('2026-09-04T23:59:59Z'), WINDOW).phase).toBe('active');
  });

  it('reports an un-started window as upcoming', () => {
    const s = seasonStatus(at('2026-06-05T00:00:00Z'), WINDOW);
    expect(s.phase).toBe('upcoming');
    expect(s.days).toBe(2);
    expect(s.shortLabel).toBe('starts in 2d');
  });

  it('degrades an unparseable window to unknown — never to a live season', () => {
    const s = seasonStatus(at('2026-07-31T00:00:00Z'), { startDate: 'soon', endDate: 'later' });
    expect(s.phase).toBe('unknown');
    expect(s.days).toBe(0);
    expect(s.shortLabel).toBe('–');
  });

  it('degrades an inverted window to unknown', () => {
    const s = seasonStatus(at('2026-07-31T00:00:00Z'), { startDate: '2026-09-05', endDate: '2026-06-07' });
    expect(s.phase).toBe('unknown');
  });
});
