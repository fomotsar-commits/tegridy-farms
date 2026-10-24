import {
  isDeployed,
  TEGRIDY_LENDING_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
  COMMUNITY_GRANTS_ADDRESS,
  MEME_BOUNTY_BOARD_ADDRESS,
  VOTE_INCENTIVES_ADDRESS,
  GAUGE_CONTROLLER_ADDRESS,
  PREMIUM_ACCESS_ADDRESS,
} from './constants';
import { isSolanaSwapLive } from './solana';
import { BUNGALOWS, getActiveBungalow } from './bungalows';
import { EARN_PATH, earnPoolPath, isEarnPoolId } from './earnRoutes';
import { hasRoutableYieldVenue } from './yield/venues';
import { isLauncherEnabled } from './launcher/config';
import { curveChainNames, isCurveLive } from './launcher/curveChains';
// Web3-free on purpose: this module is in the main bundle.
import { isCurveWriteEnabled } from './launcher/solana/curveWriteFlag';
// String-only, for the same reason: the range program's id and whether its tab shows.
import { rangePoolsVisible } from './solana/clmm/programId';
// No entry is keyed to the unhosted indexer (isIndexerConfigured). Each off mark
// below reads a rail this build already carries, so it is a computed fact.
import { hasChartableMarket } from './chart/markets';
import { hasCopyTapeSource } from './copytrade/tape';
import { hasPaymentLinkChain } from './commerce/settleTokens';

export interface NavItem {
  to: string;
  label: string;
  /** Shorter label when shown as a tab on the section's host; `label` stays the canonical, pinned name. */
  tabLabel?: string;
  /** Shown instead on phones and iPads (the `handheld` variant); visual only, `tabLabel ?? label` stays the accessible name. */
  compactTabLabel?: string;
  /** Off today: no strip lists it but its own page, which still opens by URL (law 23). */
  soon?: boolean;
  /** Green "Live" pill, opt-in, driven by the page's own live read (never a literal `true`). */
  live?: boolean;
}

/**
 * Keeps NFT finance and governance in the nav ahead of their constants.ts wiring.
 * Governance contracts are deployed but their constants are still 0x0, so this
 * alone carries /community. The address halves are exported so a test can tell
 * which input carries each entry.
 */
const PROMOTE_PENDING: boolean = true;

/** Address-derived half of the NFT-finance gate (no PROMOTE_PENDING override). */
export const NFT_FINANCE_ADDRESSES_LIVE = [
  TEGRIDY_LENDING_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
].some(isDeployed);

export const NFT_FINANCE_LIVE = PROMOTE_PENDING || NFT_FINANCE_ADDRESSES_LIVE;

/** Address-derived half of the governance gate (no PROMOTE_PENDING override). */
export const COMMUNITY_ADDRESSES_LIVE = [
  COMMUNITY_GRANTS_ADDRESS,
  MEME_BOUNTY_BOARD_ADDRESS,
  VOTE_INCENTIVES_ADDRESS,
  GAUGE_CONTROLLER_ADDRESS,
].some(isDeployed);

export const COMMUNITY_LIVE = PROMOTE_PENDING || COMMUNITY_ADDRESSES_LIVE;

export const PREMIUM_LIVE = isDeployed(PREMIUM_ACCESS_ADDRESS);

// The Jupiter swap is live wherever the same-origin aggregator proxy is: always.
export const SOLANA_LIVE = isSolanaSwapLive();

/**
 * Where "Swap" goes: the Solana swap inside a Solana room, else the Ethereum
 * swap. Read at render, because a door switches the room in place; ChainSwitch
 * keeps the other chain one click away.
 */
export function tradeRoute(): string {
  const active = getActiveBungalow();
  return active?.chain === 'solana' && isSolanaSwapLive() ? '/solana' : '/swap';
}

/**
 * Where "Lock" goes: the active room's own pool (owner, 2026-10-15: "only show the bungalow
 * selected", BAYLA's pool in BAYLA's room), else the list of every pool. Read at render, like
 * tradeRoute. `/earn` itself stays the list, so each pool's "Back to Earn" still reaches it.
 */
/**
 * Where Pools opens: in a Solana room with a coin, the Solana LP tab already on that coin
 * (owner, 2026-10-17: "the wiring for the pages inside the bayla bungalow is off"); with no
 * room, the tab as it opens for anyone.
 */
export function poolsRoute(): string {
  const active = getActiveBungalow();
  return active && active.chain === 'solana' && active.address ? `/solana-lp?mint=${active.address}` : '/solana-lp';
}

export function lockRoute(): string {
  const active = getActiveBungalow();
  return active && isEarnPoolId(active.id) ? earnPoolPath(active.id) : EARN_PATH;
}


export interface NavSection {
  /** The section's word, on the bar or as its drawer row: one string, so they cannot drift. */
  heading: string;

  /** The host's landing tab. MUST equal `items[0].to` (navConfig.test.ts). */
  hub: string;

  /** The section's destinations in tab order, the hub first: its host's tab strip. */
  items: NavItem[];

  /** Where the word goes when not the hub; one of `items`. Swap follows the room, Pools opens Solana LP. */
  primaryTo?: string;
}

/** Every tabbed section. Four are bar words (BAR_NAV) and two are drawer rows (DRAWER_SECTIONS). */
export const NAV_SECTIONS: NavSection[] = [
  {
    heading: 'Swap',
    hub: '/swap',
    // The word follows the room's chain, read on every access.
    get primaryTo() {
      return tradeRoute();
    },
    items: [
      { to: '/swap', label: 'Swap', tabLabel: 'Ethereum' },
      ...(SOLANA_LIVE ? [{ to: '/solana', label: 'Solana Swap', tabLabel: 'Solana' }] : []),
    ],
  },
  {
    // Providing liquidity: add/remove, Solana LP, the venue's own Solana AMM, and zap in.
    heading: 'Pools',
    hub: '/liquidity',
    // Owner, 2026-10-03: "pools land on solana lp". The drawer row opens the Solana LP tab,
    // on the room's coin inside a Solana room; the strip keeps its order, so the Ethereum
    // form is the tab to its left.
    get primaryTo() {
      return poolsRoute();
    },
    items: [
      { to: '/liquidity', label: 'Liquidity', tabLabel: 'Add / Remove' },
      // Ungated, like /pools: the page mounts its LP section only once the venue reads live.
      { to: '/solana-lp', label: 'Solana LP' },
      // Hidden, with no route, until range pools open (RANGE_POOLS_OPEN, clmm/programId.ts).
      ...(rangePoolsVisible() ? [{ to: '/range-pools', label: 'Range pools', tabLabel: 'Range' }] : []),
      // Ungated: a live probe of the venue's AMM that states when it is undeployed.
      { to: '/pools', label: 'Venue AMM' },
      // On: every leg runs on deployed contracts; a missing vault is named on the page.
      { to: '/zap', label: 'Zap In', tabLabel: 'Zap' },
    ],
  },
  {
    // A lobby of cards, not a tab strip: /community and /tokenomics each own a strip
    // already, and a route renders one. One row per tabbed host. No points, no score
    // (owner, 2026-10-15: the points program and the competitions are deleted).
    // Its heading is the bar's first word, which opens the home; the hall links the lobby.
    heading: 'Island',
    hub: '/island',
    items: [
      { to: '/island',      label: 'The island',  tabLabel: 'Island' },
      { to: '/gallery',     label: 'Gallery' },
      ...(COMMUNITY_LIVE ? [{ to: '/community', label: 'Community' }] : []),
      // NUMBERS_TABS[0]; StatsPage hosts /tokenomics, /treasury and /tax. The test keeps the two equal.
      { to: '/tokenomics',  label: 'Treasury & numbers', tabLabel: 'Numbers' },
    ],
  },
  {
    heading: 'Launch',
    hub: '/launch',
    items: [
      { to: '/launch',      label: 'Launch', tabLabel: 'Launchpad', soon: !isLauncherEnabled() },
      // The venue's own Solana curve. Off whenever launching and trading cannot load:
      // in a production build that is ONLY the committed CURVE_WRITES_ENABLED, which
      // website release 2 turns on together with the program ids (curveWriteFlag.ts).
      { to: '/curve-launch', label: 'Memetics Curve (Solana)', tabLabel: 'Solana Curve', soon: !isCurveWriteEnabled() },
      // The EVM curve on every chain it is deployed to: the label names them and the Live mark reads them all.
      {
        to: '/eth-curve',
        label: isCurveLive() ? `Memetics Curve (${curveChainNames()})` : 'Memetics Curve (EVM)',
        tabLabel: 'Memetics Curve',
        soon: !isCurveLive(),
        live: isCurveLive(),
      },
      { to: '/launch-simulator', label: 'Launch Simulator', tabLabel: 'Simulator' },
    ],
  },
  {
    // /earn is the list of every pool and one pool is /earn/<id> (App.tsx). The word and the
    // Staking tab open the room's own pool (owner, 2026-10-15), the list with no room; each
    // pool's "Back to Earn" leads to the list (owner, 2026-09-30).
    heading: 'Lock',
    hub: '/earn',
    get primaryTo() {
      return lockRoute();
    },
    items: [
      // "Staking", not "Pools": Pools is the drawer row for providing liquidity.
      { to: '/earn', label: 'Staking' },
      ...(NFT_FINANCE_LIVE ? [{ to: '/nft-finance', label: 'Borrow on NFTs', tabLabel: 'NFT Loans' }] : []),
      // Off only while no venue carries an on-chain-verified deposit target.
      { to: '/yield', label: 'Yield Routing', tabLabel: 'Yield', soon: !hasRoutableYieldVenue() },
      // Reads the island tape; on when a readable pool is registered, never on a live
      // read. It promises no execution and no payout.
      // CT on phones and iPads: "Copy Trading" is wider than its tab there.
      { to: '/copy-trading', label: 'Copy Trading', compactTabLabel: 'CT', soon: !hasCopyTapeSource() },
      // Browser-only (signed invoice in the URL fragment); off only while no served
      // chain has a verified settlement asset.
      { to: '/checkout', label: 'Checkout', soon: !hasPaymentLinkChain() },
    ],
  },
  {
    // The detection suite works on any token or wallet; /trust frames it.
    heading: 'Check',
    hub: '/trust',
    items: [
      { to: '/trust',    label: 'Trust Tools',     tabLabel: 'Overview' },
      { to: '/scan',     label: 'Token Scanner',   tabLabel: 'Scanner' },
      { to: '/deployer', label: 'Deployer Graph',  tabLabel: 'Deployer' },
      { to: '/exposure', label: 'Wallet Exposure', tabLabel: 'Exposure' },
      // On: its feed is a keyless browser read of GeckoTerminal; outages show as a page banner.
      { to: '/terminal', label: 'Pro Terminal', tabLabel: 'Terminal' },
      // Off only if no registry market is chartable; rate limits are the page's to report.
      { to: '/chart', label: 'Pro Charting', tabLabel: 'Charting', soon: !hasChartableMarket() },
      // On: rules live in this browser (ruleStore.ts); the test pins that the store never fetches.
      { to: '/alerts',   label: 'Alerts' },
    ],
  },
];

/** The section a host renders as its tab strip. Throws on a missing heading rather than render a blank strip. */
function requireSection(heading: string): NavSection {
  const found = NAV_SECTIONS.find((s) => s.heading === heading);
  if (!found) {
    throw new Error(
      `navConfig: no "${heading}" section — a host page renders its items as tabs (see SectionHost.tsx)`,
    );
  }
  return found;
}

/** Is `pathname` one of the section's own pages (or under one)? What lights its word. */
export function sectionIsActive(section: NavSection, pathname: string): boolean {
  return section.items.some((i) => pathname === i.to || pathname.startsWith(`${i.to}/`));
}

export const SWAP_SECTION = requireSection('Swap');
export const POOLS_SECTION = requireSection('Pools');
export const ISLAND_SECTION = requireSection('Island');
export const LAUNCH_SECTION = requireSection('Launch');
export const LOCK_SECTION = requireSection('Lock');
export const CHECK_SECTION = requireSection('Check');

/** A word on the bar. `to` is read at render, so Swap follows the room. */
export interface BarWord {
  label: string;
  readonly to: string;
  /** This word owns the page: lit, and aria-current. At most one word owns any page. */
  lit: (pathname: string, hash: string) => boolean;
}

/** A room's own door: one route per island slug, plus /towelie (App.tsx). */
export function isRoomDoor(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '');
  return path === '/towelie' || BUNGALOWS.some((b) => `/${b.id}` === path);
}

/**
 * Where Island opens (owner, 2026-10-17, of the word it replaced: "inside a room, Heat should
 * open that room's own page, like /bayla, instead of leaving for the venue home"): the room's
 * door while a room is entered, the venue home otherwise. Read at render, as Lock's and Swap's
 * are, so a skin switch moves it.
 */
export function islandRoute(): string {
  const active = getActiveBungalow();
  const door = active ? `/${active.id}` : null;
  return door && isRoomDoor(door) ? door : '/';
}

function sectionWord(section: NavSection): BarWord {
  return {
    label: section.heading,
    get to() {
      return section.primaryTo ?? section.hub;
    },
    lit: (pathname) => sectionIsActive(section, pathname),
  };
}

/**
 * The bar, phone and wide screen alike. Island is the home, with its read field and its hall of
 * doors, or inside a room that room's own page (owner, 2026-10-18: Heat and Rooms "are the same";
 * one word stays, named Island, and the drawer's Island row moves up into it). Five is the
 * ceiling: a 44px tab and a 10px label at 390px.
 */
export const BAR_NAV: readonly BarWord[] = [
  // Owns the home with or without its hall, every room's door, and the island's own pages
  // (the lobby and its doors), which its drawer row used to own.
  {
    label: ISLAND_SECTION.heading,
    get to() {
      return islandRoute();
    },
    lit: (pathname) => pathname === '/' || isRoomDoor(pathname) || sectionIsActive(ISLAND_SECTION, pathname),
  },
  sectionWord(LOCK_SECTION),
  sectionWord(LAUNCH_SECTION),
  sectionWord(SWAP_SECTION),
];

/** The word that owns this page, if any. */
export function litWord(pathname: string, hash = ''): BarWord | null {
  return BAR_NAV.find((w) => w.lit(pathname, hash)) ?? null;
}

/** The drawer's big rows, one per section, at every width. Pools leads, on the Solana LP tab. */
export const DRAWER_SECTIONS: readonly NavSection[] = [POOLS_SECTION, CHECK_SECTION];

/** Not on the bar and not in the footer since 2026-10-15: the records and the developer API. */
export const DRAWER_LINKS: readonly NavItem[] = [
  { to: '/changelog', label: 'Changelog' },
  { to: '/contracts', label: 'Contracts' },
  { to: '/developers', label: 'Developer API' },
];

/** A drawer row once a wallet is connected: it is empty for a stranger. Not a section. */
export const DASHBOARD_NAV: NavItem = { to: '/dashboard', label: 'Dashboard' };

/** StatsPage's tabs, behind the "Treasury & numbers" link. Here so navConfig.test.ts sees /tax. */
export const NUMBERS_TABS: NavItem[] = [
  { to: '/tokenomics', label: 'Tokenomics' },
  { to: '/treasury',   label: 'Treasury' },
  // A concrete false: /tax reads same-origin /api/etherscan, and a keyless server says so on the page.
  { to: '/tax', label: 'Tax Reports', tabLabel: 'Tax', soon: false },
];

/** Every section's destinations, flat. */
export const MORE_NAV: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/** Tabs of hosts that are no section (ActivityPage, LearnPage), each reached before only by a sibling tab. */
const UNSECTIONED_PAGES: NavItem[] = [
  ...(PREMIUM_LIVE ? [{ to: '/premium', label: 'Gold Card' }] : []),
  { to: '/history', label: 'History' },
  { to: '/lore', label: 'Lore' },
];

/** One group of the menu's index: a word, and every page under it. */
export interface IndexGroup {
  /** The group's word: a section's heading, or "Records". */
  heading: string;
  /** Where the word itself goes, read at render (Swap follows the room). The records have none. */
  readonly to?: string;
  /** Its pages in tab order, on today. An off page is left out, as its strip leaves it out. */
  items: readonly NavItem[];
  /** The group's picture in the menu: `nav-drawer:N` in /art-studio (artSurfaces.ts). */
  art: number;
}

/**
 * What the index calls a page: its tab label, which reads under the group's word ("Ethereum"
 * under Swap, "NFT Loans" under Lock), unless that only repeats the word, then its own name
 * ("The island" under Island). `label` stays the canonical, pinned name.
 */
export function indexName(group: IndexGroup, item: NavItem): string {
  return item.tabLabel && item.tabLabel !== group.heading ? item.tabLabel : item.label;
}

function indexGroup(section: NavSection, art: number, extra: readonly NavItem[] = []): IndexGroup {
  return {
    heading: section.heading,
    get to() {
      return section.primaryTo ?? section.hub;
    },
    items: [...section.items, ...extra].filter((i) => !i.soon),
    art,
  };
}

/**
 * The menu's index (owner, 2026-10-18: the shadowed features went in the side nav "until we can
 * organize them better"; 2026-10-19: organise them, on the desktop too). Every section with its
 * pages, in the order a visitor moves: find the island, trade, pool, lock, launch, check; then
 * the records. A gated page (NFT finance, Community, Gold Card) rides its gate. /airdrop and
 * /vesting stay out: their rails are undeployed (navConfig.test.ts). Dashboard joins once a
 * wallet connects (NavDrawer.tsx).
 */
export const INDEX_GROUPS: readonly IndexGroup[] = [
  // The venue's own pages no section claims (the Gold Card, History, Lore) are the island's.
  indexGroup(ISLAND_SECTION, 3, UNSECTIONED_PAGES),
  indexGroup(SWAP_SECTION, 5),
  indexGroup(POOLS_SECTION, 1),
  indexGroup(LOCK_SECTION, 6),
  indexGroup(LAUNCH_SECTION, 7),
  indexGroup(CHECK_SECTION, 2),
  { heading: 'Records', items: DRAWER_LINKS, art: 0 },
];

/** Every page the index lists, flat, each once: what navReach.test.ts starts from. */
export const INDEX_PAGES: readonly NavItem[] = INDEX_GROUPS.flatMap((g) => g.items);

/** Every listed destination, exactly once: the sections, the drawer's own links and Dashboard. */
export const ALL_NAV: NavItem[] = [
  ...MORE_NAV,
  ...DRAWER_LINKS,
  ...UNSECTIONED_PAGES,
  DASHBOARD_NAV,
];
