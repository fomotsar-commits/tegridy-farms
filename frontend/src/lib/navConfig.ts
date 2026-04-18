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
  { to: '/lending', label: 'Lending' },
  { to: '/community', label: 'Governance' },
];

/** Points link — right-aligned action, separate from primary nav */
export const POINTS_NAV: NavItem = { to: '/leaderboard', label: 'Points' };

/**
 * All-nav list used by the mobile drawer fallback. Matches PRIMARY_NAV
 * plus the Points action so every top-level action is reachable without
 * opening the footer.
 */
export const ALL_NAV: NavItem[] = [
  ...PRIMARY_NAV,
  POINTS_NAV,
];
