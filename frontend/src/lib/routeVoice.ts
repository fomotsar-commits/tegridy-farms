import { BUNGALOWS, type Bungalow } from './bungalows';

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
 * The island named fifteen; seven are here, and the rest are not missed:
 *   - /restake, /grants, /governance, /bounties and /bribes are redirects (to
 *     /earn/toweli and /community). A redirect has no page to put in a room.
 *   - /earn is the venue's list of every resident's pool. TOWELI's farm has had
 *     its own address since 2026-09-30, /earn/toweli, and is in the room; until
 *     then it shared /farm with the list, and only the stored room told them
 *     apart (the owner's call: Earn always leads back to the list).
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
  '/earn/toweli',
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

/**
 * The Solana pages whose path alone says so. /earn/<id> and /dashboard are judged below.
 *
 * EVERY PAGE THAT MOUNTS ITS OWN SolanaProviders BELONGS HERE (or below).
 * /solana-lp was added to the router without being added here. Until its
 * Solana section had mounted, the top bar treated it as a page with none and
 * mounted its own connection; the section then mounted and took that one
 * away. A wallet approval still open at that moment landed nowhere, and a
 * hand-off into a wallet's app (lib/solanaSurface.ts) was used up by the
 * connection that was about to be unmounted (review, 2026-10-03).
 */
const SOLANA_PATHS: ReadonlySet<string> = new Set(['/solana', '/pools', '/solana-lp', '/curve-launch']);

/**
 * Pages whose wallet action is on Solana, read from the path alone, before
 * that page's Solana section has loaded: the top bar's first tap there must
 * never open the Ethereum list (lib/solanaSurface.ts). Once the page's
 * SolanaProviders mounts, its report is the truth; TopNav reads both.
 *
 * /earn/<id> mirrors BungalowFarmPanel: a live Solana room with a pool mounts
 * a Solana card. /dashboard mirrors DashboardPage: `room` is
 * getBungalowIdentity(), and a Solana room gets the Solana panel.
 */
export function isSolanaPage(pathname: string, room: Pick<Bungalow, 'chain'> | null = null): boolean {
  const path = normalize(pathname);
  if (SOLANA_PATHS.has(path)) return true;
  // One launch's page mounts its Solana section for a real mint address only;
  // a mistyped one draws "Not a token address", with no wallet section at all.
  const mint = /^\/curve-launch\/([^/]+)$/.exec(path)?.[1];
  if (mint !== undefined) return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
  if (path === '/dashboard') return room?.chain === 'solana';
  const id = /^\/earn\/([^/]+)$/.exec(path)?.[1];
  return (
    id !== undefined &&
    BUNGALOWS.some((b) => b.id === id && b.live && b.chain === 'solana' && Boolean(b.stakePool || b.ladderPool))
  );
}
