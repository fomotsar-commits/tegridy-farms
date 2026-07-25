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
import { isSolanaConfigured } from './solana';
import { isLauncherEnabled } from './launcher/config';
import { isSolanaLauncherEnabled } from './launcher/solana/dbc';

export interface NavItem {
  to: string;
  label: string;
  /**
   * Renders a small amber "Soon" pill beside the label. For destinations that
   * are routable and worth discovering but are still flag-gated shut — the
   * link must never read as live, and never as broken either. Reuses the same
   * amber token as FeatureNotDeployed.tsx:40 so nav and page agree visually.
   */
  soon?: boolean;
}

/**
 * CREDIBILITY GATING (2026-06-09): a primary-nav destination where every
 * section dead-ends in "Contract Not Deployed" costs more trust than the
 * feature earns back. Feature surfaces stay routable by URL (and reappear
 * in the nav automatically the moment their relaunch addresses land in
 * constants.ts) but are not promoted while 100% dark.
 *
 * PRE-DEPLOY STAGING (2026-06-12): the NFT-finance and governance contracts
 * are being deployed now, so both surfaces are promoted in the nav ahead of
 * the address wiring. PROMOTE_PENDING forces them visible; until the real
 * addresses land in constants.ts the pages render their "Contract Not
 * Deployed" placeholder. Set PROMOTE_PENDING back to false to restore pure
 * isDeployed-driven gating (the address lists below stay the source of truth).
 */
const PROMOTE_PENDING: boolean = true;

export const NFT_FINANCE_LIVE = PROMOTE_PENDING || [
  TEGRIDY_LENDING_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
].some(isDeployed);

export const COMMUNITY_LIVE = PROMOTE_PENDING || [
  COMMUNITY_GRANTS_ADDRESS,
  MEME_BOUNTY_BOARD_ADDRESS,
  VOTE_INCENTIVES_ADDRESS,
  GAUGE_CONTROLLER_ADDRESS,
].some(isDeployed);

export const PREMIUM_LIVE = isDeployed(PREMIUM_ACCESS_ADDRESS);

// Solana fee-capture surface (Surface A). Gated until the operator sets a fee
// account (VITE_SOLANA_FEE_ACCOUNT) — hidden from nav until then so we don't
// promote an inert page. The /solana route stays reachable by URL (it renders
// the FeatureNotDeployed placeholder while dark).
export const SOLANA_LIVE = isSolanaConfigured();

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
 * "More" dropdown / drawer — curated secondary destinations. A short set of
 * grouped sections (Engage / Stats) keeps the menu scannable on both desktop
 * and mobile from a single source of truth. Some entries are gated
 * (Community appears only when a governance contract is live), so the rendered
 * counts vary. Pages merged into tabbed hosts (LearnPage covers
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
      ...(SOLANA_LIVE ? [{ to: '/solana', label: 'Solana Swap' }] : []),
      // Routable and worth discovering, but the launch rail is gated shut
      // (LAUNCHER_ENABLED=false + zero integrator, launcher/config.ts:14,21).
      // Shown with a "Soon" pill rather than hidden: /launch teaches the rail
      // (LaunchPage renders the SOON wall + LauncherExplainer while gated), so
      // the entry is honest, not a dead link. The pill clears itself when
      // isLauncherEnabled() flips.
      { to: '/launch',      label: 'Launch', soon: !isLauncherEnabled() },
      // The Solana leg (fee-capture sub-brand over Meteora DBC). Previously only
      // reachable via a cross-link buried in /launch's GATED explainer, so an
      // operator (who sees the live wizard, not the explainer) had no path to it.
      // Surfaced here for parity with Solana Swap; "Soon" pill until the launcher
      // flag flips (SOLANA_LAUNCHER_ENABLED, launcher/solana/dbc.ts).
      { to: '/solana-launch', label: 'Solana Launch', soon: !isSolanaLauncherEnabled() },
      // Pure client-side — always usable, deliberately live before the launch rail opens.
      { to: '/launch-simulator', label: 'Launch Simulator' },
    ],
  },
  {
    heading: 'Stats',
    items: [
      { to: '/tokenomics', label: 'Tokenomics' },
      { to: '/treasury',   label: 'Treasury' },
      { to: '/scan',       label: 'Token Scanner' },
      { to: '/exposure',   label: 'Wallet Exposure' },
      { to: '/deployer',   label: 'Deployer Graph' },
    ],
  },
];

/** Flat list of every "More" item — used by the mobile drawer. */
export const MORE_NAV: NavItem[] = MORE_NAV_SECTIONS.flatMap((s) => s.items);

/**
 * Flat all-nav list (PRIMARY_NAV + the Tradermigos action + the "More"
 * destinations). NOTE: the live TopNav drawer renders MORE_NAV_SECTIONS
 * directly (primary tabs live in the BottomNav), so this export is currently
 * only consumed by navConfig.test.ts as a completeness assertion. Kept as the
 * canonical "every reachable top-level route" list for tooling/tests.
 */
export const ALL_NAV: NavItem[] = [
  ...PRIMARY_NAV,
  POINTS_NAV,
  ...MORE_NAV,
];
