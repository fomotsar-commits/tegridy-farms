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
import { getActiveBungalow } from './bungalows';
import { hasRoutableYieldVenue } from './yield/venues';
import { isLauncherEnabled } from './launcher/config';
import { curveChainNames, isCurveLive } from './launcher/curveChains';
// Web3-free on purpose: this module is in the main bundle.
import { isCurveWriteEnabled } from './launcher/solana/curveWriteFlag';
// No entry is keyed to the unhosted indexer (isIndexerConfigured). Each pill
// below reads a rail this build already carries, so it is a computed fact.
import { hasChartableMarket } from './chart/markets';
import { hasCopyTapeSource } from './copytrade/tape';
import { hasScoreableBoard } from './competitions/availability';
import { hasPaymentLinkChain } from './commerce/settleTokens';

export interface NavItem {
  to: string;
  label: string;
  /** Shorter label when shown as a tab on the section's host; `label` stays the canonical, pinned name. */
  tabLabel?: string;
  /** Shown instead on phones and iPads (the `handheld` variant); visual only, `tabLabel ?? label` stays the accessible name. */
  compactTabLabel?: string;
  /** Amber "Soon" pill: routable and worth finding, not yet usable. */
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


export interface NavSection {
  /** The top-bar word and the section's name: one string, so they cannot drift. */
  heading: string;

  /** Where the top-bar word goes. MUST equal `items[0].to`, the host's landing tab (navConfig.test.ts). */
  hub: string;

  /** The section's destinations in tab order, the hub first. PRIMARY_NAV derives from these. */
  items: NavItem[];

  /** Override for the top-bar word. Only Swap has one (tradeRoute); it must be one of `items`. */
  primaryTo?: string;
}

/**
 * The top bar's six words, each a job: Swap, Pools, Island, Launch, Earn,
 * Check. Dashboard comes last and only once a wallet is connected. PRIMARY_NAV
 * is derived from this array, so there is no second list to keep in step.
 */

export const NAV_SECTIONS: NavSection[] = [
  {
    heading: 'Swap',
    hub: '/swap',
    // The top-bar word follows the room's chain, read on every access.
    get primaryTo() {
      return tradeRoute();
    },
    items: [
      { to: '/swap', label: 'Swap', tabLabel: 'Ethereum' },
      ...(SOLANA_LIVE ? [{ to: '/solana', label: 'Solana Swap', tabLabel: 'Solana' }] : []),
    ],
  },
  {
    // Providing liquidity: add/remove, the venue's own Solana AMM, and zap in.
    heading: 'Pools',
    hub: '/liquidity',
    items: [
      { to: '/liquidity', label: 'Liquidity', tabLabel: 'Add / Remove' },
      // Ungated: a live probe of the venue's AMM that states when it is undeployed.
      { to: '/pools', label: 'Venue AMM' },
      // Unpilled: every leg runs on deployed contracts; a missing vault is named on the page.
      { to: '/zap', label: 'Zap In', tabLabel: 'Zap' },
    ],
  },
  {
    // A lobby of cards, not a tab strip: /community, /leaderboard and /tokenomics
    // each own a strip already, and a route renders one. One row per tabbed host.
    heading: 'Island',
    hub: '/island',
    items: [
      { to: '/island',      label: 'The island',  tabLabel: 'Island' },
      { to: '/gallery',     label: 'Gallery' },
      // Mounted outside AppLayout (App.tsx), so it could never render in a host's panel.
      { to: '/nakamigos',   label: 'Marketplace' },
      ...(COMMUNITY_LIVE ? [{ to: '/community', label: 'Community' }] : []),
      { to: '/leaderboard', label: 'Venue Score' },
      // NUMBERS_TABS[0]; StatsPage hosts /tokenomics, /treasury and /tax. The test keeps the two equal.
      { to: '/tokenomics',  label: 'Treasury & numbers', tabLabel: 'Numbers' },
    ],
  },
  {
    heading: 'Launch',
    hub: '/launch',
    items: [
      { to: '/launch',      label: 'Launch', tabLabel: 'Launchpad', soon: !isLauncherEnabled() },
      // The venue's own Solana curve. "Soon" whenever launching and trading cannot load:
      // in a production build that is ONLY the committed CURVE_WRITES_ENABLED, which
      // website release 2 turns on together with the program ids (curveWriteFlag.ts).
      { to: '/curve-launch', label: 'Memetics Curve (Solana)', tabLabel: 'Solana Curve', soon: !isCurveWriteEnabled() },
      // The EVM curve on every chain it is deployed to: the label names them and the pill reads them all.
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
    // Earning: staking is the hub, the one surface a stranger can read unconnected.
    heading: 'Earn',
    hub: '/farm',
    items: [
      // "Staking", not "Pools": Pools is the top-bar word for providing liquidity.
      { to: '/farm', label: 'Staking' },
      ...(NFT_FINANCE_LIVE ? [{ to: '/nft-finance', label: 'Borrow on NFTs', tabLabel: 'NFT Loans' }] : []),
      // Unpilled: the splitter is deployed and a `/?ref=0x…` link needs no server.
      { to: '/referrals', label: 'Referrals' },
      // Pilled only while no venue carries an on-chain-verified deposit target.
      { to: '/yield', label: 'Yield Routing', tabLabel: 'Yield', soon: !hasRoutableYieldVenue() },
      // Both read the island tape; each pill clears when a readable pool is registered,
      // never on a live read. Neither promises execution or a payout.
      // CT on phones and iPads: "Copy Trading" is wider than its tab there.
      { to: '/copy-trading', label: 'Copy Trading', compactTabLabel: 'CT', soon: !hasCopyTapeSource() },
      { to: '/competitions', label: 'Competitions', soon: !hasScoreableBoard() },
      // Browser-only (signed invoice in the URL fragment); pilled only while no served
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
      // Unpilled: its feed is a keyless browser read of GeckoTerminal; outages show as a page banner.
      { to: '/terminal', label: 'Pro Terminal', tabLabel: 'Terminal' },
      // Pilled only if no registry market is chartable; rate limits are the page's to report.
      { to: '/chart', label: 'Pro Charting', tabLabel: 'Charting', soon: !hasChartableMarket() },
      // Unpilled: rules live in this browser (ruleStore.ts); the test pins that the store never fetches.
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

/** The six sections, each one word in the top bar and one tabbed page. */
export const SWAP_SECTION = requireSection('Swap');
export const POOLS_SECTION = requireSection('Pools');
export const ISLAND_SECTION = requireSection('Island');
export const LAUNCH_SECTION = requireSection('Launch');
export const EARN_SECTION = requireSection('Earn');
export const CHECK_SECTION = requireSection('Check');

/** The top bar, derived from the sections. `to` is read on access, so Swap follows the room. */
export const PRIMARY_NAV: NavItem[] = NAV_SECTIONS.map((s) => ({
  get to() {
    return s.primaryTo ?? s.hub;
  },
  label: s.heading,
}));

/** Appended last by TopNav and BottomNav once a wallet is connected; not a section. */
export const DASHBOARD_NAV: NavItem = { to: '/dashboard', label: 'Dashboard' };

/** StatsPage's tabs, one host behind Island's "Treasury & numbers" row. Here so the tests beside the /tax pill see it. */
export const NUMBERS_TABS: NavItem[] = [
  { to: '/tokenomics', label: 'Tokenomics' },
  { to: '/treasury',   label: 'Treasury' },
  // A concrete false: /tax reads same-origin /api/etherscan, and a keyless server says so on the page.
  { to: '/tax', label: 'Tax Reports', tabLabel: 'Tax', soon: false },
];

/** Flat list of every sectioned destination — used by the mobile drawer. */
export const MORE_NAV: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/** Every reachable top-level destination, exactly once: the sections plus Dashboard. */
export const ALL_NAV: NavItem[] = [
  ...MORE_NAV,
  DASHBOARD_NAV,
];
