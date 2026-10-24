/**
 * What the proxy's last answer said is left of this tab's calls a minute
 * (api/_lib/ratelimit.js sets X-RateLimit-Remaining and X-RateLimit-Reset on every answer).
 * An optional read (history) refuses to start under OPTIONAL_READ_FLOOR so the live reads
 * keep working. Memory only, per tab. A missing header, or a window past its reset, is no
 * information and the gate does nothing. The reset is the proxy's epoch second compared
 * with this device's clock: a clock off by a minute moves the pause by as much.
 */
import { OPTIONAL_READ_FLOOR } from './readFetch';

let seen: { remaining: number; resetAtSec: number | null } | null = null;

const COUNT = /^\d+$/;

/** Read the proxy's headers off an answer; the newest answer wins. */
export function noteResponse(res: Response): void {
  const raw = res.headers.get('X-RateLimit-Remaining')?.trim();
  if (raw === undefined || !COUNT.test(raw)) return;
  const reset = res.headers.get('X-RateLimit-Reset')?.trim();
  seen = { remaining: Number(raw), resetAtSec: reset !== undefined && COUNT.test(reset) ? Number(reset) : null };
}

/** Calls left in the proxy's window, or null when nothing current is known. */
export function remaining(): number | null {
  if (!seen) return null;
  if (seen.resetAtSec !== null && Math.floor(Date.now() / 1000) >= seen.resetAtSec) return null;
  return seen.remaining;
}

/** May an optional read start now? Unknown is allowed: the gate protects the live reads, it is not a verdict. */
export function optionalReadAllowed(): boolean {
  const r = remaining();
  return r === null || r >= OPTIONAL_READ_FLOOR;
}

export function pausedText(): string {
  return 'History reads are paused so this page’s live reads keep working. Try again in about a minute.';
}
