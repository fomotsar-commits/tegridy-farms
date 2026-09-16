import { BUNGALOWS } from './bungalows';

/**
 * WAVE SEVEN, ruling 2 (row Q): EVERY ROUTE SPEAKS AS THE VENUE OR LIVES BEHIND
 * /toweli.
 *
 * A PURE, ROUTE-SCOPED VERDICT, and deliberately NOT arrivalVoice(). That one
 * drives chrome that opens things by itself (Towelie's assistant, the TOWELI
 * tour, the picker) and four module-scope reads, so widening its path check
 * would put all of that on every TOWELI protocol URL a stranger lands on. This
 * reads only the pathname. It persists nothing and reloads nothing.
 *
 * The census must agree with it: every audited row of e2e/fixtures/routes.ts
 * carries a `voice`, a11yRouteCoverage.test.ts holds each one equal to this
 * function, and e2e/voice-census.spec.ts walks them.
 */
export type RouteVoice = 'venue' | 'toweli' | 'bungalow' | 'record' | 'legal';

/**
 * TOWELI's protocol pages. They describe one resident's protocol, so they open
 * in the TOWELI room: its band, its way back (components/layout/ToweliRoomStrip).
 *
 * The island named fifteen; six are here, and the other nine are not missed:
 *   - /restake, /grants, /governance, /bounties and /bribes are redirects (to
 *     /farm and /community). A redirect has no page to put in a room.
 *   - /farm is the venue's Earn landing for a venue visitor (VenueEarn); the
 *     TOWELI farm already opens behind the room's own door. Moving that hub is
 *     the owner's call, not a copy pass.
 *   - /vesting, /airdrop and /history render no TOWELI content at all. They are
 *     venue tools, and the census proves it by reading zero TOWELI-voice nodes.
 */
export const TOWELI_ROOM_PATHS: ReadonlySet<string> = new Set([
  '/tokenomics',
  '/treasury',
  '/premium',
  '/lore',
  '/referrals',
  '/zap',
]);

/** The venue's records (ruling 1): dated, labeled, exempt from the sweep by structure. */
export const RECORD_PATHS: ReadonlySet<string> = new Set(['/changelog', '/contracts']);

/**
 * The binding legal document. It speaks as the venue and is judged like any
 * venue page, but its words change only through its own amendment clause and
 * an owner's sign-off, never a copy pass; its census debt says what is owed.
 */
export const LEGAL_PATHS: ReadonlySet<string> = new Set(['/terms']);

const TOWELI_DOORS: ReadonlySet<string> = new Set(['/toweli', '/towelie']);

function normalize(pathname: string): string {
  return pathname.replace(/\/+$/, '') || '/';
}

export function routeVoice(pathname: string): RouteVoice {
  const path = normalize(pathname);
  if (TOWELI_DOORS.has(path) || TOWELI_ROOM_PATHS.has(path)) return 'toweli';
  if (BUNGALOWS.some((b) => `/${b.id}` === path)) return 'bungalow';
  if (RECORD_PATHS.has(path)) return 'record';
  if (LEGAL_PATHS.has(path)) return 'legal';
  return 'venue';
}

/** A TOWELI protocol page (not the room's own doors, which ARE the room). */
export function isToweliRoomPage(pathname: string): boolean {
  return TOWELI_ROOM_PATHS.has(normalize(pathname));
}
