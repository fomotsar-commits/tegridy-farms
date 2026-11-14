import { describe, expect, it } from 'vitest';
import { MAX_APR_BPS, parseAprPercent } from '../../components/nftfinance/nftLendingShared';
import { DUE_ALARMS_MINUTES, loanDueIcs } from './calendar';

describe('parseAprPercent: the Lend form takes a yearly rate in percent', () => {
  it.each([
    ['14', 1400n],
    ['12.5', 1250n],
    ['9.75', 975n],
    ['0.01', 1n],
    ['1000', 100_000n],
    [' 10 ', 1000n],
  ])('%s%% is %s basis points', (typed, bps) => {
    expect(parseAprPercent(typed)).toBe(bps);
  });

  it.each(['', '0', '0.00', '-5', '14%', '1e2', '12.345', '.5', '5.', 'abc', '10,5'])('refuses %j', (typed) => {
    expect(parseAprPercent(typed)).toBeNull();
  });

  it('refuses a rate over the cap, so basis points typed by habit never sign', () => {
    expect(MAX_APR_BPS).toBe(100_000n);
    expect(parseAprPercent('1000.01')).toBeNull();
    expect(parseAprPercent('1400')).toBeNull();
  });
});

describe('loanDueIcs: the due date as a calendar file', () => {
  const DUE = 1_797_000_000; // 2026-12-11T10:40:00Z
  const ics = loanDueIcs({
    loanId: '7',
    title: 'Repay loan #7 or lose NAKA #1234',
    description: 'About 0.4032 WETH is due; after it, the lender can take NAKA #1234.',
    dueSeconds: DUE,
    nowSeconds: DUE - 86_400 * 30,
  });
  const lines = ics.split('\r\n');

  it('ends exactly at the deadline, in UTC', () => {
    const stamp = new Date(DUE * 1000).toISOString().replace(/[-:]/g, '').replace('.000Z', 'Z');
    expect(lines).toContain(`DTEND:${stamp}`);
    expect(lines.find((l) => l.startsWith('DTSTART:'))! < `DTSTART:${stamp}`).toBe(true);
  });

  it('rings a week, three days, a day and two hours before the deadline', () => {
    expect(DUE_ALARMS_MINUTES).toEqual([10080, 4320, 1440, 120]);
    expect(lines.filter((l) => l.startsWith('TRIGGER'))).toEqual([
      'TRIGGER;RELATED=END:-PT10080M',
      'TRIGGER;RELATED=END:-PT4320M',
      'TRIGGER;RELATED=END:-PT1440M',
      'TRIGGER;RELATED=END:-PT120M',
    ]);
  });

  it('escapes commas and semicolons, and is one well-formed event', () => {
    expect(lines).toContain('DESCRIPTION:About 0.4032 WETH is due\\; after it\\, the lender can take NAKA #1234.');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
    expect(lines.filter((l) => l === 'BEGIN:VALARM')).toHaveLength(4);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });
});
