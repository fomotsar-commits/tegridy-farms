// The arithmetic behind the loan timeline (components/nftfinance/LoanTimeline.tsx): where a
// moment sits on the loan's life, which reminders fit in it, and the steps a scrub moves by.
import { DUE_ALARMS_MINUTES } from './calendar';

/** A moment as a share of the loan's life, 0 at the start and 1 at the deadline. */
export function lifeFraction(start: number, duration: number, at: number): number {
  if (!(duration > 0)) return 0;
  const f = (at - start) / duration;
  return f < 0 ? 0 : f > 1 ? 1 : f;
}

/** Where the calendar file's reminders fall on the loan's life. A reminder longer than the
 *  loan itself (a week's notice on a 3 day loan) does not fit and is left out. */
export function reminderFractions(duration: number): number[] {
  if (!(duration > 0)) return [];
  return DUE_ALARMS_MINUTES.map((minutes) => minutes * 60)
    .filter((before) => before < duration)
    .map((before) => 1 - before / duration);
}

/** The scrub's step in seconds: an hour for loans up to a week, a quarter day up to 90 days,
 *  a day beyond, so a 365 day loan is 365 stops, not 8,760. */
export function scrubStep(duration: number): number {
  if (duration <= 7 * 86_400) return 3_600;
  if (duration <= 90 * 86_400) return 21_600;
  return 86_400;
}

/** Day N of M, counting the first day as day 1 and never past the last. */
export function dayOf(start: number, duration: number, at: number): { day: number; of: number } {
  const of = Math.max(1, Math.ceil(duration / 86_400));
  const day = Math.min(of, Math.max(1, Math.floor((at - start) / 86_400) + 1));
  return { day, of };
}
