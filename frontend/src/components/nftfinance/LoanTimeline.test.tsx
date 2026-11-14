import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { parseEther } from 'viem';
import { LoanTimeline, type TimelineCost } from './LoanTimeline';
import { interestFor } from '../../lib/gondi/loanMath';
import { dayOf, lifeFraction, reminderFractions, reminderMarks, scrubStep } from '../../lib/gondi/timeline';
import { monoWidth } from '../../lib/markLabels';

const DAY = 86_400;
const START = 1_800_000_000;
const PRINCIPAL = parseEther('1');
const APR = 1000n; // 10%
const FEE = 500n; // the venue keeps 5% of the interest

function costAt(at: number): TimelineCost {
  const interest = interestFor(PRINCIPAL, APR, BigInt(Math.max(0, at - START)));
  const toVenue = (interest * FEE + 9_999n) / 10_000n;
  return { total: PRINCIPAL + interest, interest, toVenue, toLenders: PRINCIPAL + interest - toVenue };
}
const slider = () => screen.getByRole('slider') as HTMLInputElement;
const text = (id: string) => screen.getByTestId(id).textContent;

describe('the arithmetic under the picture', () => {
  it('places a moment on the loan\'s life, clamped to it', () => {
    expect(lifeFraction(START, 30 * DAY, START)).toBe(0);
    expect(lifeFraction(START, 30 * DAY, START + 15 * DAY)).toBe(0.5);
    expect(lifeFraction(START, 30 * DAY, START + 99 * DAY)).toBe(1);
    expect(lifeFraction(START, 30 * DAY, START - DAY)).toBe(0);
    expect(lifeFraction(START, 0, START)).toBe(0);
  });

  it('marks only the reminders that fit inside the loan', () => {
    // 30 days: a week, three days, a day and two hours before all fit.
    expect(reminderFractions(30 * DAY)).toHaveLength(4);
    expect(reminderFractions(30 * DAY)[0]).toBeCloseTo(1 - 7 / 30, 10);
    // 3 days: a week does not fit, and three days before is the start itself, so it is out too.
    expect(reminderFractions(3 * DAY)).toHaveLength(2);
    expect(reminderFractions(0)).toEqual([]);
  });

  it('steps by the hour, the quarter day or the day by the loan\'s length', () => {
    expect(scrubStep(7 * DAY)).toBe(3_600);
    expect(scrubStep(30 * DAY)).toBe(21_600);
    expect(scrubStep(365 * DAY)).toBe(DAY);
  });

  it('counts days from 1 and never past the last', () => {
    expect(dayOf(START, 30 * DAY, START)).toEqual({ day: 1, of: 30 });
    expect(dayOf(START, 30 * DAY, START + 12 * DAY + 5)).toEqual({ day: 13, of: 30 });
    expect(dayOf(START, 30 * DAY, START + 30 * DAY)).toEqual({ day: 30, of: 30 });
  });

  it('names each reminder by how long before the deadline it rings, the week first', () => {
    expect(reminderMarks(30 * DAY).map((m) => m.before)).toEqual(['7d', '3d', '1d', '2h']);
    expect(reminderMarks(3 * DAY).map((m) => m.before)).toEqual(['1d', '2h']);
    expect(reminderMarks(30 * DAY).map((m) => m.fraction)).toEqual(reminderFractions(30 * DAY));
  });
});

describe('the row under the axis: day 1, the reminders, due (owner 2026-11-12: the ticks said nothing)', () => {
  const labels = (container: HTMLElement) => [...container.querySelectorAll('svg text')].map((t) => t.textContent);
  const box = (width: number) =>
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, toJSON: () => ({}) } as DOMRect);
  afterEach(() => vi.restoreAllMocks());

  it('on a desktop card names the week, three days and the day before; two hours would sit on "due"', () => {
    box(1600);
    const { container } = render(<LoanTimeline side="lender" start={START} duration={30 * DAY} costAt={costAt} nft="a NAKA" />);
    expect(labels(container)).toEqual(['7d left', '3d left', '1d left', 'day 1', 'due']);
  });

  it('on a phone keeps the week\'s notice and leaves out the reminders that would crowd', () => {
    box(306);
    const { container } = render(<LoanTimeline side="lender" start={START} duration={30 * DAY} costAt={costAt} nft="a NAKA" />);
    expect(labels(container)).toEqual(['7d left', 'day 1', 'due']);
  });

  it('every label it shows sits inside the picture', () => {
    for (const width of [306, 600, 1600]) {
      box(width);
      const { container, unmount } = render(<LoanTimeline side="borrower" start={START} duration={7 * DAY} costAt={costAt} nft="NAKA #1" />);
      for (const t of container.querySelectorAll('svg text')) {
        const left = Number(t.getAttribute('x'));
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left + monoWidth(t.textContent ?? '', Number(t.getAttribute('font-size')))).toBeLessThanOrEqual(width);
      }
      unmount();
      vi.restoreAllMocks();
    }
  });

  it('on a phone the headline keeps one line and the date takes the next, rather than both squeezing', () => {
    // At 306 px "Repay 0.070805" and "WETH" broke apart, beside a date in two lines.
    render(<LoanTimeline side="borrower" start={START} duration={30 * DAY} costAt={costAt} nft="NAKA #1" />);
    expect(screen.getByTestId('loan-timeline-top').className).toMatch(/\bflex-wrap\b/);
    expect(screen.getByTestId('loan-timeline-headline').className).toMatch(/\bwhitespace-nowrap\b/);
  });
});

describe('borrower: what repaying on a given day costs', () => {
  it('an offer preview opens at the deadline, the most it can cost, and names what is lost', () => {
    render(<LoanTimeline side="borrower" exact={false} start={START} duration={30 * DAY} costAt={costAt} nft="NAKA #77" />);
    // 1 WETH at 10% for 30 days = 0.008219... interest, rounded up by the contract's rule.
    expect(text('loan-timeline-headline')).toBe('Repay 1.008219 WETH');
    expect(text('loan-timeline-when')).toContain('day 30 of 30 · about ');
    expect(text('loan-timeline-line')).toBe('Last moment to repay. After it the lender keeps NAKA #77.');
  });

  it('dragging to day 10 shows that day\'s cost, cheaper than the deadline\'s', () => {
    render(<LoanTimeline side="borrower" start={START} duration={30 * DAY} costAt={costAt} nft="NAKA #77" />);
    fireEvent.change(slider(), { target: { value: String(START + 10 * DAY) } });
    expect(text('loan-timeline-headline')).toBe('Repay 1.002740 WETH');
    expect(text('loan-timeline-when')).toContain('day 11 of 30');
    expect(text('loan-timeline-line')).toBe('0.002740 WETH of that is interest. Drag to try another day.');
    expect(slider().getAttribute('aria-valuetext')).toContain('Repay 1.002740 WETH');
  });

  it('a live loan opens at now and cannot be dragged into the past', () => {
    const now = START + 5 * DAY;
    render(<LoanTimeline side="borrower" start={START} duration={30 * DAY} now={now} costAt={costAt} nft="NAKA #77" />);
    expect(slider().min).toBe(String(now));
    expect(slider().max).toBe(String(START + 30 * DAY));
    expect(text('loan-timeline-headline')).toBe('Repay 1.001370 WETH');
    expect(text('loan-timeline-when')).toContain('day 6 of 30');
  });

  it('the last stop is the deadline even when the steps do not land on it', () => {
    // now is 100 seconds past a step, so the range's last whole step falls short of the end.
    const now = START + 5 * DAY + 100;
    const end = START + 30 * DAY;
    render(<LoanTimeline side="borrower" start={START} duration={30 * DAY} now={now} costAt={costAt} nft="NAKA #77" />);
    const lastStop = now + Math.floor((end - now) / 21_600) * 21_600;
    expect(lastStop).toBeLessThan(end);
    fireEvent.change(slider(), { target: { value: String(lastStop) } });
    expect(text('loan-timeline-headline')).toBe('Repay 1.008219 WETH');
    expect(text('loan-timeline-line')).toContain('Last moment to repay.');
  });
});

describe('lender: what a repaid loan leaves them, and what an unpaid one does', () => {
  it('shows the interest after the venue\'s share, and the venue\'s share in WETH', () => {
    render(<LoanTimeline side="lender" start={START} duration={30 * DAY} costAt={costAt} nft="a NAKA" />);
    fireEvent.change(slider(), { target: { value: String(START + 10 * DAY) } });
    // 0.002740 interest, 5% of it (rounded up) to the venue.
    expect(text('loan-timeline-headline')).toBe('You keep 0.002603 WETH');
    expect(text('loan-timeline-line')).toBe('The venue keeps 0.000137 WETH of the interest. Drag to try another day.');
  });

  it('at the wall it says what the lender owns instead', () => {
    render(<LoanTimeline side="lender" start={START} duration={30 * DAY} costAt={costAt} nft="a NAKA" />);
    expect(text('loan-timeline-line')).toBe('Not repaid by now: you own a NAKA, and no interest.');
  });
});
