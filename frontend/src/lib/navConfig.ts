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
  { to: '/community', label: 'Community' },
];

/** Tradermigos link — right-aligned action, separate from primary nav. Swapped
 *  in from the dropdown so the art gallery is promoted to the top bar. */
export const POINTS_NAV: NavItem = { to: '/nakamigos', label: 'Tradermigos' };

/**
 * "More" dropdown — secondary destinations that don't fit in the primary 5
 * but are too important to hide behind the footer. Shown as a dropdown on
 * desktop and expanded inline in the mobile drawer.
 */
export const MORE_NAV: NavItem[] = [
  { to: '/gallery',   label: 'Gallery' },
  { to: '/tokenomics', label: 'Tokenomics' },
  { to: '/changelog', label: 'Changelog' },
  // /security, /faq, /lore → tabs of the LearnPage at /tokenomics.
  // /leaderboard, /premium, /history → tabs of the ActivityPage at /changelog.
  // All routes still work, just removed from the More dropdown per product decision.
];

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
