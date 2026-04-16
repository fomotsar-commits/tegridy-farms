export interface NavItem {
  to: string;
  label: string;
}

/** Primary navigation items shown in the main nav bar */
export const PRIMARY_NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/farm', label: 'Farm' },
  { to: '/swap', label: 'Trade' },
  { to: '/lending', label: 'NFT Finance' },
];

/** Community link shown separately */
export const COMMUNITY_NAV: NavItem = { to: '/community', label: 'Community' };

/** Items in the "More" dropdown / overflow menu */
export const MORE_NAV: NavItem[] = [
  { to: '/premium', label: 'Gold Card' },
  { to: '/gallery', label: 'Gallery' },
  { to: '/nakamigos', label: 'Marketplace' },
  { to: '/tokenomics', label: 'Tokenomics' },
  { to: '/security', label: 'Security' },
  { to: '/faq', label: 'FAQ' },
  { to: '/changelog', label: 'Changelog' },
  { to: '/lore', label: 'Lore' },
  { to: '/history', label: 'History' },
];

/** Points link shown separately */
export const POINTS_NAV: NavItem = { to: '/leaderboard', label: 'Points' };

/** All nav items combined (for mobile drawer) */
export const ALL_NAV: NavItem[] = [
  ...PRIMARY_NAV,
  COMMUNITY_NAV,
  ...MORE_NAV,
  POINTS_NAV,
];

/** Paths that belong to the "More" section (for active state detection) */
export const MORE_PATHS: string[] = MORE_NAV.map(n => n.to);
