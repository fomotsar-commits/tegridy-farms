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
 * "More" dropdown — every secondary destination not in the primary 5.
 * Sectioned so a long list stays scannable. Was previously trimmed to 4
 * items, which left Treasury, Contracts, Lore, FAQ, Premium, Leaderboard,
 * History, Security, Risks, Terms, and Privacy reachable only from the
 * footer. They're now all here.
 */
export const MORE_NAV_SECTIONS: NavSection[] = [
  {
    heading: 'Engage',
    items: [
      { to: '/community', label: 'Community' },
      { to: '/gallery',   label: 'Gallery' },
    ],
  },
  {
    heading: 'Stats',
    items: [
      { to: '/tokenomics', label: 'Tokenomics' },
      { to: '/treasury',   label: 'Treasury' },
      { to: '/contracts',  label: 'Contracts' },
    ],
  },
  {
    heading: 'Activity',
    items: [
      { to: '/leaderboard', label: 'Leaderboard' },
      { to: '/history',     label: 'History' },
      { to: '/changelog',   label: 'Changelog' },
      { to: '/premium',     label: 'Gold Card' },
    ],
  },
  {
    heading: 'Learn',
    items: [
      { to: '/lore',     label: 'Lore' },
      { to: '/faq',      label: 'FAQ' },
      { to: '/security', label: 'Security' },
      { to: '/risks',    label: 'Risks' },
    ],
  },
  {
    heading: 'Legal',
    items: [
      { to: '/terms',   label: 'Terms' },
      { to: '/privacy', label: 'Privacy' },
    ],
  },
];

/** Flat list of every "More" item — used by the mobile drawer. */
export const MORE_NAV: NavItem[] = MORE_NAV_SECTIONS.flatMap((s) => s.items);

/**
 * Mobile-only "More" drawer — curated subset of MORE_NAV_SECTIONS. Trims
 * pages that have low mobile traffic or are better reached through other
 * surfaces (Lore/FAQ/Security/Gold Card/History/Changelog still live on
 * desktop and via direct URL + the Footer). Three sections of three keeps
 * the drawer scannable on a phone.
 */
export const MOBILE_MORE_SECTIONS: NavSection[] = [
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
      { to: '/contracts',  label: 'Contracts' },
    ],
  },
  {
    heading: 'Legal',
    items: [
      { to: '/risks',   label: 'Risks' },
      { to: '/terms',   label: 'Terms' },
      { to: '/privacy', label: 'Privacy' },
    ],
  },
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
