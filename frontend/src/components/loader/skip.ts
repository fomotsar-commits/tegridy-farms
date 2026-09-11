/**
 * Does the splash play at all, decided synchronously at mount.
 *
 * Split out of AppLoader.tsx (PERF-16, 2026-09-03) because it is the ONE part
 * of the loader that has to be eager. AppLoader and its eight phase modules and
 * three fx modules — an audio engine among them — total ~93 KB of source and
 * landed in the ENTRY chunk, so every visitor downloaded the whole intro before
 * first paint even though this function decides, before a single frame, that
 * repeat visitors and `prefers-reduced-motion` users will never see it. The
 * decision is ~20 lines; it stays. The choreography is now fetched only by the
 * visitors who actually watch it.
 *
 * R007 Pattern B — the decision happens during `useState` lazy init so the
 * loader never renders for those visitors, rather than being unmounted by an
 * effect one frame later.
 *
 * SIDE EFFECT, DELIBERATE: a reduced-motion visitor's `tf_loaded` is written
 * here, during render of the loader's own shell and therefore BEFORE AppLayout's
 * `freshSplash` initializer reads it. Moving this write later changes which
 * visitors auto-open the bungalow picker.
 *
 * WAVE SEVEN, element A: this decision grew, and it stays eager anyway. It now also
 * refuses the curtain on a room deep link and on a shared `?heat=` read, and the
 * durable half of the key moved to localStorage so the film plays once per BROWSER
 * rather than once per tab. `BUNGALOWS` is already in the entry chunk (AppLayout
 * imports it), so reading the real registry adds nothing to first paint — and it
 * means the room list here can never drift from the routes App.tsx actually mounts.
 */

import { BUNGALOWS } from '../../lib/bungalows';
export const ARRIVAL_SEEN_KEY = 'tf_loaded';

/**
 * TWO STORAGES, ON PURPOSE (wave seven, element A).
 *
 * localStorage is the DURABLE record: this browser has seen the arrival, so it
 * never plays again. That is the element's "once per browser, never per tab" —
 * every new tab used to replay the whole film.
 *
 * sessionStorage is a TRANSIENT suppression, and it is still honoured because two
 * real callers depend on exactly that scope: the art studios write it so the splash
 * does not play inside their same-origin preview iframes (which share storage with
 * the top window), and the e2e fixtures seed it per context. Promoting those writes
 * to localStorage would mean opening the art studio once permanently consumes a
 * visitor's arrival, and would vacuum three e2e seeders. Reading both keeps every
 * existing behaviour intact while the durable half becomes per-browser.
 */
export function hasSeenArrival(): boolean {
  try {
    if (localStorage.getItem(ARRIVAL_SEEN_KEY)) return true;
  } catch { /* privacy mode */ }
  try {
    if (sessionStorage.getItem(ARRIVAL_SEEN_KEY)) return true;
  } catch { /* privacy mode */ }
  return false;
}

/** Record that this BROWSER has seen the arrival. Durable by design. */
export function markArrivalSeen(): void {
  try {
    localStorage.setItem(ARRIVAL_SEEN_KEY, '1');
  } catch { /* privacy mode — the splash simply plays again */ }
}

/**
 * The rooms. A deep link into a bungalow IS the arrival there, so the venue's
 * curtain never plays over it.
 *
 * Matched on the PATHNAME rather than through getBungalowIdentity(), and that is
 * not a shortcut: the identity resolver reads `?bungalow=` or localStorage
 * (bungalows.ts), so on a COLD /bayla it returns null at loader-mount time and the
 * curtain would mount anyway. BungalowDoor also persists the choice and reloads, so
 * a cold door is TWO document loads and the gate has to hold on both.
 *
 * BUNGALOWS is already in the entry chunk (AppLayout imports it), so reading the
 * real registry here costs nothing and cannot drift from it. 'towelie' is the
 * spelled-out alias App.tsx routes alongside the 'toweli' slug.
 */
function isRoomPath(pathname: string): boolean {
  const first = pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  if (!first) return false;
  if (first === 'towelie') return true;
  return BUNGALOWS.some((b) => b.id === first);
}

export function shouldSkipAtMount(): boolean {
  if (typeof window === 'undefined') return false;

  if (hasSeenArrival()) return true;

  try {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      markArrivalSeen();
      return true;
    }
  } catch { /* matchMedia unavailable */ }

  try {
    // A room deep link is its own arrival, and a shared read must open ON THE
    // NUMBER. Neither consumes the arrival: someone who lands on /bayla today
    // still meets the venue's own curtain the first time they visit the venue.
    if (isRoomPath(window.location.pathname)) return true;
    if (new URLSearchParams(window.location.search).has('heat')) return true;
  } catch { /* location unavailable */ }

  return false;
}
