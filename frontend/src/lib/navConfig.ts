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
import { isSolanaSubmitReady } from './launcher/solana/dbc';

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
 *
 * 🔄 2026-08-12 — STATUS CORRECTION, verified by live mainnet read. The two
 * halves of this override are now in OPPOSITE states and must not be reasoned
 * about together:
 *   · NFT finance — three of its four addresses are real in constants.ts, so
 *     `NFT_FINANCE_ADDRESSES_LIVE` is already true. The override is redundant
 *     there; turning it off changes nothing.
 *   · Governance — all four contracts are DEPLOYED AND UNPAUSED on mainnet
 *     (GaugeController, VoteIncentives, MemeBountyBoard, CommunityGrants — full
 *     checksummed addresses live in CommunityPage.tsx's DEPLOYED_NOT_WIRED, which
 *     is the single place they are written; deliberately NOT abbreviated here,
 *     because a truncated address in this repo once got copied forward into a
 *     fabricated 33-byte value), but their constants.ts entries
 *     are still 0x0. `COMMUNITY_ADDRESSES_LIVE` is therefore FALSE and the
 *     override is the only thing holding /community in the menu. The 0x0s are a
 *     UI wiring gate, NOT a statement that the contracts do not exist.
 * The two signals are exported separately below so a reader — and
 * navConfig.test.ts — can tell which input is actually carrying each entry.
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
      // Community is gated on COMMUNITY_LIVE. 🔄 2026-08-12: the old note here
      // said all four governance contracts were "zeroed" and the page was
      // "wall-to-wall isn't live yet" — the first half is true only of
      // constants.ts, and the second half is now false. All four contracts are
      // deployed and unpaused on mainnet; only the frontend wiring is missing,
      // and /community says exactly that. The entry is carried by
      // PROMOTE_PENDING, not by COMMUNITY_ADDRESSES_LIVE (which is false).
      ...(COMMUNITY_LIVE ? [{ to: '/community', label: 'Community' }] : []),
      { to: '/gallery',     label: 'Gallery' },
      { to: '/leaderboard', label: 'Tegridy Score' },
      ...(SOLANA_LIVE ? [{ to: '/solana', label: 'Solana Swap' }] : []),
      // The launch rail is LIVE (LAUNCHER_ENABLED=true since 2026-07-22), so the
      // "Soon" pill self-clears — the flag drives it, so this entry stays honest
      // either way: while gated, /launch renders the SOON wall + LauncherExplainer
      // rather than a dead link.
      { to: '/launch',      label: 'Launch', soon: !isLauncherEnabled() },
      // The Solana leg (fee-capture sub-brand over Meteora DBC). Previously only
      // reachable via a cross-link buried in /launch's GATED explainer, so an
      // operator (who sees the live wizard, not the explainer) had no path to it.
      // Surfaced here for parity with Solana Swap.
      //
      // The pill answers ONE question: can I launch from this page? It was once
      // `soon: !isSolanaLauncherEnabled()`, which keyed it to a feature flag instead
      // — with the flag on and no signer, the pill cleared and the nav advertised a
      // launch surface that could not launch. It was then pilled unconditionally.
      //
      // 🔄 2026-08-04 — the submit path shipped, so the pill now tracks the honest
      // condition: `isSolanaSubmitReady()` is the flag AND a published live config.
      // Both are required and neither implies the other — the flag can be on with no
      // config, which is precisely the state that produced the original bug.
      { to: '/solana-launch', label: 'Solana Launch', soon: !isSolanaSubmitReady() },
      // Our OWN Solana curve (tegridy-launch + our cp-swap fork), as opposed to
      // the Meteora rail above. Permanently pilled "Soon": the program is not
      // deployed on any cluster, and the page proves that from a live read of
      // the program id rather than from a flag. No flag drives this one because
      // there is nothing to flip — a deploy is what changes it, and the page
      // picks that up on its own.
      { to: '/curve-launch', label: 'Tegridy Curve', soon: true },
      // Pure client-side — always usable, deliberately live before the launch rail opens.
      { to: '/launch-simulator', label: 'Launch Simulator' },
    ],
  },
  {
    heading: 'Stats',
    items: [
      { to: '/tokenomics', label: 'Tokenomics' },
      { to: '/treasury',   label: 'Treasury' },
    ],
  },
  // The three detection surfaces are the protocol's one genuine differentiator and
  // they work on ANY token/wallet, not just TOWELI — so they earn their own named
  // section instead of sitting under "Stats" beside Tokenomics/Treasury, where they
  // read as protocol vanity metrics. /trust is the hub that frames them as one suite.
  {
    heading: 'Trust & Safety',
    items: [
      { to: '/trust',    label: 'Trust Tools' },
      { to: '/scan',     label: 'Token Scanner' },
      { to: '/deployer', label: 'Deployer Graph' },
      { to: '/exposure', label: 'Wallet Exposure' },
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
