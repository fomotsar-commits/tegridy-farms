export interface NavItem {
  to: string;
  label: string;
}

/**
 * Primary navigation — the 5 core items shown in both TopNav (desktop)
 * and BottomNav (mobile). Order is identical across viewports for
 * symmetric IA. Everything else lives in the Footer.
 */
export const PRIMARY_NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/farm', label: 'Farm' },
  { to: '/swap', label: 'Trade' },
  { to: '/nft-finance', label: 'NFT Finance' },
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
      { to: '/community',   label: 'Community' },
      { to: '/gallery',     label: 'Gallery' },
      { to: '/leaderboard', label: 'Leaderboard' },
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
