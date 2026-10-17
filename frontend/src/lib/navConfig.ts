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

/** Every tabbed section. Three are bar words (BAR_NAV) and three are drawer rows (DRAWER_SECTIONS). */
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
    heading: 'Island',
    hub: '/island',
    items: [
      { to: '/island',      label: 'The island',  tabLabel: 'Island' },
      { to: '/gallery',     label: 'Gallery' },
      // Mounted outside AppLayout (App.tsx), so it could never render in a host's panel.
      { to: '/nakamigos',   label: 'Marketplace' },
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

/** The hall of doors on the home (VenueDoors.tsx), where every "pick a bungalow" link lands. */
const HALL = '#hall';

/** A room's own door: one route per island slug, plus /towelie (App.tsx). */
export function isRoomDoor(pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '');
  return path === '/towelie' || BUNGALOWS.some((b) => `/${b.id}` === path);
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
 * The bar, phone and wide screen alike (owner, 2026-10-03, the island's venue review item 1).
 * Heat is the home, where the read field is; Rooms is the home's hall of doors. Five is the
 * ceiling: a 44px tab and a 10px label at 390px.
 */
export const BAR_NAV: readonly BarWord[] = [
  { label: 'Heat', to: '/', lit: (pathname, hash) => pathname === '/' && hash !== HALL },
  { label: 'Rooms', to: `/${HALL}`, lit: (pathname, hash) => (pathname === '/' && hash === HALL) || isRoomDoor(pathname) },
  sectionWord(LOCK_SECTION),
  sectionWord(LAUNCH_SECTION),
  sectionWord(SWAP_SECTION),
];

/** The word that owns this page, if any. */
export function litWord(pathname: string, hash = ''): BarWord | null {
  return BAR_NAV.find((w) => w.lit(pathname, hash)) ?? null;
}

/** The drawer's rows, one per section, at every width. Pools leads, on the Solana LP tab. */
export const DRAWER_SECTIONS: readonly NavSection[] = [POOLS_SECTION, CHECK_SECTION, ISLAND_SECTION];

/** Not on the bar and not in the footer since 2026-10-15: the records and the developer API. */
export const DRAWER_LINKS: readonly NavItem[] = [
  { to: '/changelog', label: 'Changelog' },
  { to: '/contracts', label: 'Contracts' },
  { to: '/developers', label: 'Developer API' },
];

/** A drawer row once a wallet is connected: it is empty for a stranger. Not a section. */
export const DASHBOARD_NAV: NavItem = { to: '/dashboard', label: 'Dashboard' };

/** StatsPage's tabs, behind Island's "Treasury & numbers" row. Here so navConfig.test.ts sees /tax. */
export const NUMBERS_TABS: NavItem[] = [
  { to: '/tokenomics', label: 'Tokenomics' },
  { to: '/treasury',   label: 'Treasury' },
  // A concrete false: /tax reads same-origin /api/etherscan, and a keyless server says so on the page.
  { to: '/tax', label: 'Tax Reports', tabLabel: 'Tax', soon: false },
];

/** Every section's destinations, flat. */
export const MORE_NAV: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/** Every listed destination, exactly once: the sections, the drawer's own links and Dashboard. */
export const ALL_NAV: NavItem[] = [
  ...MORE_NAV,
  ...DRAWER_LINKS,
  DASHBOARD_NAV,
];
