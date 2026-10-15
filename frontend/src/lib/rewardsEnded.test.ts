import { describe, it, expect } from 'vitest';
import { rewardsEndDate, rewardsEndedLine, rewardsHaveEnded } from './rewardsEnded';

describe('rewardsEnded', () => {
  it('dates the end on the UTC day, so a visitor west of UTC sees the chain date', () => {
    // 2026-06-15T03:11:35Z is still June 14 in every US time zone.
    expect(rewardsEndDate(1_781_493_095)).toBe('Jun 15, 2026');
    expect(rewardsEndDate(1_781_493_095n)).toBe('Jun 15, 2026');
  });

  it('says the end, the closed stake and the open exits in one line', () => {
    expect(rewardsEndedLine(1_781_493_095)).toBe(
      'Rewards ended Jun 15, 2026, so new stakes are closed. Withdraw and claim still work.',
    );
  });

  it('is ended only for a landed end time that has passed', () => {
    expect(rewardsHaveEnded(100n, 101n)).toBe(true);
    expect(rewardsHaveEnded(100, 100)).toBe(true);
    expect(rewardsHaveEnded(100n, 99n)).toBe(false);
    expect(rewardsHaveEnded(null, 101)).toBe(false); // unread is not ended
    expect(rewardsHaveEnded(0n, 101n)).toBe(false); // never funded is not ended
  });
});
