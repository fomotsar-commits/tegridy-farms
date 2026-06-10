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

export interface NavItem {
  to: string;
  label: string;
}

/**
 * CREDIBILITY GATING (2026-06-09): a primary-nav destination where every
 * section dead-ends in "Contract Not Deployed" costs more trust than the
 * feature earns back. Feature surfaces stay routable by URL (and reappear
 * in the nav automatically the moment their relaunch addresses land in
 * constants.ts) but are not promoted while 100% dark.
 */
export const NFT_FINANCE_LIVE = [
  TEGRIDY_LENDING_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
].some(isDeployed);

export const COMMUNITY_LIVE = [
  COMMUNITY_GRANTS_ADDRESS,
  MEME_BOUNTY_BOARD_ADDRESS,
  VOTE_INCENTIVES_ADDRESS,
  GAUGE_CONTROLLER_ADDRESS,
].some(isDeployed);

export const PREMIUM_LIVE = isDeployed(PREMIUM_ACCESS_ADDRESS);

/**
 * Primary navigation — the core items shown in both TopNav (desktop)
 * and BottomNav (mobile). Order is identical across viewports for
 * symmetric IA. Everything else lives in the Footer.
 */
export const PRIMARY_NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/farm', label: 'Farm' },
  { to: '/swap', label: 'Trade' },
  ...(NFT_FINANCE_LIVE ? [{ to: '/nft-finance', label: 'NFT Finance' }] : []),
];

/** Tradermigos link — right-aligned action, separate from primary nav. Swapped
 *  in from the dropdown so the art gallery is promoted to the top bar. */
export const POINTS_NAV: NavItem = { to: '/nakamigos', label: 'Tradermigos' };

export interface NavSection {
  heading: string;
  items: NavItem[];
}

/**
 * "More" dropdown / drawer — curated secondary destinations. Three sections
 * of three items keeps the menu scannable on both desktop and mobile with a
 * single source of truth. Pages merged into tabbed hosts (LearnPage covers
 * Tokenomics/Lore/Security/FAQ; ActivityPage covers Leaderboard/Gold Card/
 * History/Changelog; InfoPage covers Treasury/Contracts/Risks/Terms/Privacy)
 * have one representative entry each so the menu stays flat instead of
 * listing every tab. Lore/FAQ/Security/Gold Card/History/Changelog remain
 * reachable via the Footer and direct URLs.
 */
export const MORE_NAV_SECTIONS: NavSection[] = [
  {
    heading: 'Engage',
    items: [
      // Community is gated until any governance contract redeploys —
      // today all four (grants/bounties/bribes/gauges) are zeroed and the
      // page is wall-to-wall "isn't live yet".
      ...(COMMUNITY_LIVE ? [{ to: '/community', label: 'Community' }] : []),
      { to: '/gallery',     label: 'Gallery' },
      { to: '/leaderboard', label: 'Tegridy Score' },
    ],
  },
  {
    heading: 'Stats',
    items: [
      { to: '/tokenomics', label: 'Tokenomics' },
      { to: '/treasury',   label: 'Treasury' },
    ],
  },
];

/** Flat list of every "More" item — used by the mobile drawer. */
export const MORE_NAV: NavItem[] = MORE_NAV_SECTIONS.flatMap((s) => s.items);

/**
 * All-nav list used by the mobile drawer fallback. Matches PRIMARY_NAV
 * plus the Tradermigos action and the "More" destinations so every top-level
 * route is reachable from the drawer.
 */
export const ALL_NAV: NavItem[] = [
  ...PRIMARY_NAV,
  POINTS_NAV,
  ...MORE_NAV,
];
