/**
 * WAVE SEVEN, element P (ruling 11): THE DAY COUNTER'S ONE HOME.
 *
 * "N days held" is the unit a stranger can compare without being taught
 * anything, and until this file it was computed in two places that disagreed.
 * Element N's copy (tapeNames.daysBetween) answered null when the island's
 * reading ran backwards; elements B and D's copy (HeatCard's own daysHeld)
 * clamped the same case to 0. The island ruled one home used by B, N and P, so
 * one of the two answers had to go.
 *
 * NULL WINS, AND N'S OWN TEST SAYS WHY: "a zero would read as 'bought today',
 * which is a claim". An inverted reckoning (as_of before held_since) is the
 * island's instrument contradicting itself, and the venue's standing law is
 * that an unreadable value must never render as a fact. A zero there is a fact
 * about a wallet, invented from a reading that does not support it.
 *
 * WHAT THAT CHANGED, SAID PLAINLY: at inverted timestamps element B now hides
 * its day stat and its share button instead of showing "0 days held". That is
 * a copy change to a shipped element, reported to the island rather than filed
 * as a refactor detail.
 *
 * NOT `Date.now()`, ever. The island reckons from `held_since` to the `as_of`
 * of its own reading. Dating it against the viewer's clock would give two
 * people looking at the same row different numbers, and would keep ticking
 * while the island's reading stood still.
 *
 * FOUR CALLERS, ONE SIGNATURE. Element D passes a per-token `first_seen`
 * rather than the flame's `held_since`, so this takes a bare pair of stamps
 * and never a reading.
 */
const DAY_SECONDS = 86_400;

export function daysHeld(sinceUnix: number | null, asOfUnix: number | null): number | null {
  if (typeof sinceUnix !== 'number' || typeof asOfUnix !== 'number') return null;
  if (!Number.isFinite(sinceUnix) || !Number.isFinite(asOfUnix)) return null;
  if (asOfUnix < sinceUnix) return null;
  return Math.floor((asOfUnix - sinceUnix) / DAY_SECONDS);
}
