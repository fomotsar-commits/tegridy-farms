import { describe, it, expect } from 'vitest';
import { lpEmissionsPhase, dayTwoEconomyPhrase, dayTwoEconomyShortPhrase } from './lpEmissions';

// The real mainnet reading, 2026-07-31 (TegridyLPFarming 0x1171…e149):
//   periodFinish() = 1781493095  → 2026-06-15 UTC, in the PAST
//   rewardRate()   = 3365022998270306 → still non-zero, the residual trap
const MAINNET_PERIOD_FINISH = 1781493095;
const NOW_2026_07_31 = Date.parse('2026-07-31T00:00:00Z');

describe('lpEmissionsPhase', () => {
  it('reports the live farm as ENDED at the real on-chain periodFinish', () => {
    expect(lpEmissionsPhase(MAINNET_PERIOD_FINISH, NOW_2026_07_31)).toBe('ended');
  });

  it('reports a funded, future period as running', () => {
    expect(lpEmissionsPhase(MAINNET_PERIOD_FINISH, Date.parse('2026-06-01T00:00:00Z'))).toBe('running');
  });

  it('flips exactly at periodFinish', () => {
    expect(lpEmissionsPhase(1000, 999_999)).toBe('running');
    expect(lpEmissionsPhase(1000, 1_000_000)).toBe('ended');
  });

  it('degrades an unread period to unknown — never to running', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(lpEmissionsPhase(bad, NOW_2026_07_31)).toBe('unknown');
    }
  });
});

describe('day-2 economy copy', () => {
  it('never says LP farming is happening unless the period is running', () => {
    // /launch shipped "boosted LP farming today" for six weeks after the period ended.
    for (const phrase of [dayTwoEconomyPhrase('ended'), dayTwoEconomyShortPhrase('ended')]) {
      expect(phrase).not.toMatch(/today|running now/i);
    }
    for (const phrase of [dayTwoEconomyPhrase('unknown'), dayTwoEconomyShortPhrase('unknown')]) {
      expect(phrase).not.toMatch(/today|running now/i);
    }
  });

  it('says so plainly when a period IS funded and running', () => {
    expect(dayTwoEconomyPhrase('running')).toMatch(/running right now/i);
    expect(dayTwoEconomyShortPhrase('running')).toMatch(/running now/i);
  });

  it('names the ended period as ended rather than staying silent about it', () => {
    expect(dayTwoEconomyPhrase('ended')).toMatch(/ended/i);
    expect(dayTwoEconomyShortPhrase('ended')).toMatch(/awaiting its next funded period/i);
  });

  it('says the funding state is unreadable rather than guessing', () => {
    expect(dayTwoEconomyPhrase('unknown')).toMatch(/could not read/i);
    expect(dayTwoEconomyShortPhrase('unknown')).toMatch(/could not read/i);
  });
});
