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
  CURVE_LAUNCHER_ADDRESS,
} from './constants';
import { isSolanaSwapLive } from './solana';
import { getActiveBungalow } from './bungalows';
import { isIndexerConfigured } from './indexer/client';
import { hasRoutableYieldVenue } from './yield/venues';
import { isLauncherEnabled } from './launcher/config';

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
  /**
   * Renders a small green "Live" pill beside the label — the POSITIVE mirror of
   * `soon`, opt-in per entry (most live links carry nothing; a LIVE pill on every
   * one would be noise). Reserved for a surface that JUST went live and is worth
   * pointing at. MUST be driven by the same live-read the page gates on (e.g.
   * `isDeployed(...)`), never a hardcoded `true`, so the pill cannot outlive the
   * thing it announces. `soon` and `live` are mutually exclusive by construction.
   */
  live?: boolean;
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

// Solana swap surface (Surface A). Live whenever the aggregator proxy is —
// which is always, since it is same-origin and deployed. It used to be gated
// on VITE_SOLANA_FEE_ACCOUNT, i.e. on whether the venue could CHARGE for the
// swap, which hid a working surface whenever the fee recipient was unset.
export const SOLANA_LIVE = isSolanaSwapLive();

/**
 * Primary navigation — the core items shown in both TopNav (desktop)
 * and BottomNav (mobile). Order is identical across viewports for
 * symmetric IA. Everything else lives in the Footer.
 */
/**
 * Where "Trade" goes. The venue has two swap surfaces — /swap (Ethereum) and
 * /solana (Jupiter) — and the nav used to hardcode the Ethereum one, so a
 * visitor inside a Solana bungalow clicked Trade and landed on a swap that
 * could not touch the token whose page they were standing on. The bungalow's
 * own chain decides the landing surface; ChainSwitch on both pages makes the
 * other one one click away, so this is a default, never a trap.
 *
 * Resolved at module scope, like every other gate in this file: a bungalow
 * switch persists + reloads (see bungalows.ts), so there is no live value to
 * track. Off-browser (`getActiveBungalow` returns null) it is the classic
 * Ethereum default.
 */
export const TRADE_ROUTE: string = (() => {
  const active = getActiveBungalow();
  return active?.chain === 'solana' && isSolanaSwapLive() ? '/solana' : '/swap';
})();

export const PRIMARY_NAV: NavItem[] = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/farm', label: 'Farm' },
  { to: TRADE_ROUTE, label: 'Trade' },
  ...(NFT_FINANCE_LIVE ? [{ to: '/nft-finance', label: 'NFT Finance' }] : []),
];

/** Tradermigos link — right-aligned action, separate from primary nav. Swapped
 *  in from the dropdown so the art gallery is promoted to the top bar. */
export const POINTS_NAV: NavItem = { to: '/nakamigos', label: 'Marketplace' };

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
    // SPLIT FROM ONE 14-ITEM "Engage" SECTION, 2026-09-03.
    //
    // "Engage" was a catch-all mixing four unrelated jobs — discovering the
    // venue, trading on it, launching a token, and earning from it — under a
    // heading that described none of them. A newcomer scanning for "where do I
    // buy" had to read fourteen labels to find out it was the fourth one.
    //
    // NOTHING MOVED. Not one `to`, not one `label`, not one gating expression,
    // not one comment: the source order was already almost job-grouped, so this
    // is three inserted section boundaries and nothing else. That matters here
    // — this repo's e2e specs pin nav LABELS and have gone red twice on rename
    // waves, so a regrouping that renames nothing carries none of that risk.
    // (Checked before doing it: no test asserts on these headings.)
    heading: 'Discover',
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
      { to: '/leaderboard', label: 'Venue Score' },
    ],
  },
  {
    heading: 'Trade',
    items: [
      ...(SOLANA_LIVE ? [{ to: '/solana', label: 'Solana Swap' }] : []),
      // Liquidity provision on our own AMM. Promoted UNGATED on purpose: the page
      // is a live chain probe of the venue's status, so while the program is
      // undeployed it renders that fact rather than an empty market. Hiding it
      // would hide the one surface that explains where the venue actually is.
      { to: '/pools', label: 'Liquidity Pools' },
      // The launch rail is LIVE (LAUNCHER_ENABLED=true since 2026-07-22), so the
      // "Soon" pill self-clears — the flag drives it, so this entry stays honest
      // either way: while gated, /launch renders the SOON wall + LauncherExplainer
      // rather than a dead link.
    ],
  },
  {
    heading: 'Launch',
    items: [
      { to: '/launch',      label: 'Launch', soon: !isLauncherEnabled() },
      // ── /solana-launch REMOVED 2026-08-23 ────────────────────────────────
      // The Meteora DBC leg lived here. It was retired because it graduated into
      // Meteora DAMM v2 — a pool this protocol does not own and could not own
      // without deploying a different program. Only launchers that graduate into
      // our own venue survive.
      //
      // Its pill was the honest kind (`!isSolanaSubmitReady()` — the flag AND a
      // published live config, because the flag alone once advertised a launch
      // surface that could not launch). That lesson is preserved on the entry
      // below, which is now the only Solana launch rail.
      // Our OWN Solana curve (tegridy-launch + our cp-swap fork) — since the
      // Meteora rail was retired, the ONLY Solana launch rail. Permanently pilled
      // "Soon", and the pill is earned rather than flagged: the program is not
      // deployed on any cluster, and the page proves that from a live read of
      // the program id rather than from a flag. No flag drives this one because
      // there is nothing to flip — a deploy is what changes it, and the page
      // picks that up on its own.
      // 2026-08-28: renamed from the bare "Memetics Curve" — the dead Solana
      // rail owned the flagship's plain name while the LIVE EVM curve carried
      // the qualifier, so the menu read "Memetics Curve — Soon" first.
      // ARRIVAL IDENTITY 2026-08-31: "Memetics Curve" -> "Memetics Curve" on the
      // owner's call, so nothing outside the TOWELI bungalow speaks Tegridy.
      // DISPLAY NAME ONLY — the route and the TegridyCurveLauncher contract are
      // unchanged. The two lines above are HISTORY and keep the old name on
      // purpose: they record what the label was renamed FROM in August.
      { to: '/curve-launch', label: 'Memetics Curve (Solana)', soon: true },
      // Our OWN EVM curve (TegridyCurveLauncher) — zero-toll, graduate-to-us, no
      // Airlock/petition. `soon` clears itself the moment CURVE_LAUNCHER_ADDRESS
      // is filled from the deploy (M.16); no flag, same live-read discipline as
      // the entries above.
      { to: '/eth-curve', label: 'Memetics Curve (EVM)', soon: !isDeployed(CURVE_LAUNCHER_ADDRESS), live: isDeployed(CURVE_LAUNCHER_ADDRESS) },
      // Pure client-side — always usable, deliberately live before the launch rail opens.
      { to: '/launch-simulator', label: 'Launch Simulator' },
      // Referrals sits in Engage because it is a recruiting tool, not a stat and not a
      // detection surface: the thing a user does here is mint a link and carry it away.
      //
      // NOT PILLED, and that is the assertion to re-read if this ever changes. The pill
      // answers the one question the others answer — can I do the thing this entry
      // names? — and here the answer is yes, unconditionally: ReferralSplitter is
      // deployed at REFERRAL_SPLITTER_ADDRESS (a real, non-zero constant, which
      // navConfig.test.ts pins), and the link this page mints is `/?ref=0x…`, which
      // resolves in the visitor's browser with no server, no database and no migration.
      //
      // Contrast /alerts directly above, which IS pilled: nothing there can be saved at
      // all until `016_alert_rules.sql` is applied. The comparable dependency here —
      // `019_referral_codes.sql` — buys only the shorter `/?r=code` form, so its absence
      // degrades one optional affordance instead of the feature. Pilling this entry
      // would tell a visitor the referral programme is not live when it is paying.
      //
      // What is NOT promised by this entry, and must not be added to it: whether a
      // PARTICULAR wallet earns. That depends on the splitter's staking threshold, is a
      // per-wallet on-chain read, and is disclosed on the page above the share controls.
    ],
  },
  {
    heading: 'Earn',
    items: [
      { to: '/referrals', label: 'Referrals' },
      // Yield Routing compares THIRD-PARTY liquid staking and stablecoin lending
      // venues. It sits in Engage rather than Stats because what a visitor does here
      // is choose between other people's protocols, which is an action, not a metric
      // about ours.
      //
      // PILLED, and keyed to the only condition the label is about. The entry names
      // ROUTING, and `hasRoutableYieldVenue()` is false because every deposit target
      // in lib/yield/venues.ts is the zero address — so the pill is a computed fact,
      // not a hardcoded one, and it self-clears the moment an operator wires a
      // destination. navConfig.test.ts pins the precondition separately so wiring one
      // fails that assertion first and forces this comment to be re-read.
      //
      // Deliberately NOT keyed to the yield feed. A configured feed with no wired
      // destination is a working comparison table and a router that cannot route,
      // which is exactly the /solana-launch bug — a pill that clears on a flag while
      // the advertised action stays impossible.
      { to: '/yield', label: 'Yield Routing', soon: !hasRoutableYieldVenue() },
      // Copy Trading and Competitions. Both read the F1 indexer and nothing else, so
      // both pills are keyed to the one input that decides whether either can do the
      // thing its label names: VITE_INDEXER_URL. Without it there is no trade history
      // to follow and no swaps to score, and each page says exactly that instead of
      // drawing an empty board.
      //
      // Same self-clearing condition as /terminal below, and deliberately NOT a
      // separate flag: a flag can be true while the feed is unreachable, which is the
      // state a pill exists to describe rather than to hide.
      //
      // What these entries do NOT promise, and must not be edited to: that a follow
      // executes anything — there is no keeper, so the user places every mirror — or
      // that a season pays, since no prize pool, escrow or settlement exists. Both
      // pages state those from the modules that enforce them.
      { to: '/copy-trading', label: 'Copy Trading', soon: !isIndexerConfigured() },
      { to: '/competitions', label: 'Competitions', soon: !isIndexerConfigured() },
      // Merchant checkout. PILLED, AND IT CANNOT SELF-CLEAR — the same shape as
      // /alerts above and for the same reason: the invoice store lives behind
      // `021_commerce.sql`, a migration applied BY HAND, so until an operator runs it
      // every lookup answers 503 `schema-missing`, no invoice can be published, and no
      // payment link can resolve. Unlike /solana-launch (a flag plus a published config,
      // both readable in the browser) there is no client-readable signal for "the table
      // exists": it is a server fact that arrives with the first read. Hence a hardcoded
      // `true`, like /alerts and /curve-launch, rather than a condition.
      //
      // Deliberately NOT keyed to a feature flag. The page's honesty — the exact amount
      // and exact settlement asset shown before signing, and NO signature offered when
      // the route cannot guarantee the merchant's amount — is the product, and a flag
      // would hide the one state it can currently be in.
      //
      // What this entry does NOT promise, and must not be edited to: that this venue
      // executes the swap leg. lib/aggregator.ts is quote-only here, so the checkout
      // signs the exact transfer and states that step 1 happens on the trade surface.
      // Remove the pill when 021 is applied — navConfig.test.ts holds you to the reason.
      { to: '/checkout', label: 'Checkout', soon: true },
    ],
  },
  {
    heading: 'Stats',
    items: [
      { to: '/tokenomics', label: 'Tokenomics' },
      { to: '/treasury',   label: 'Treasury' },
      // Tax reports read the F1 indexer and nothing else, so the pill is keyed to the one
      // input that decides whether the entry can do the thing it names — build a report
      // FROM YOUR HISTORY. Without VITE_INDEXER_URL nothing of anyone's history is read
      // and the whole requested period is a declared gap on the export.
      //
      // The paste-your-own-lots path on that page works with no indexer at all and is
      // genuinely useful, but it is the filer's own records rather than history this
      // venue read, so it does not clear this pill. Same self-clearing condition as
      // /terminal and /chart, and deliberately not a separate flag: a flag can be true
      // while the feed is unreachable, which is the state a pill exists to describe.
      { to: '/tax', label: 'Tax Reports', soon: !isIndexerConfigured() },
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
      // The same three reads, applied to a discovery feed instead of to one
      // pasted address. It sits here rather than beside Trade because the feed is
      // the delivery mechanism and the safety read is the product.
      //
      // The pill answers the one question the others answer — can I do the thing
      // this entry names? — and it is keyed to the only input that decides:
      // VITE_INDEXER_URL. Without it there is no pair feed to discover anything
      // in, and the page says exactly that instead of drawing an empty table. No
      // separate flag, because a flag could be set true while the feed stays
      // unreachable, which is the state this pill exists to describe.
      { to: '/terminal', label: 'Pro Terminal', soon: !isIndexerConfigured() },
      // Pro Charting reads the SAME indexer as the terminal above — candles are
      // derived from its `pair_event` swap rows — so it sits beside it rather
      // than beside Trade, and its pill is keyed to the identical input for the
      // identical reason. Two entries pilled by one condition is correct here:
      // VITE_INDEXER_URL is the single fact that decides whether either surface
      // can read anything, and pilling only one of them would suggest the other
      // has a data path it does not have.
      { to: '/chart', label: 'Pro Charting', soon: !isIndexerConfigured() },
      // Alerts belongs to this section rather than to Engage or Stats: four of its five
      // rule kinds watch exactly what the tools above read on demand (whale moves, a
      // deployer's reputation band, an LP unlock, a launch going live), on ANY token or
      // wallet. Same subject matter, pushed instead of pulled.
      //
      // PILLED, AND IT CANNOT SELF-CLEAR. The pill answers the one question the others
      // answer — can I do the thing this entry names? — and today the answer is no: the
      // rule store lives behind `016_alert_rules.sql`, a migration applied BY HAND, so
      // every alerts call answers 503 `schema-missing` and nothing can be saved. Unlike
      // /solana-launch (a flag + a published config, both readable here) there is no
      // client-readable signal for "the table exists": it is a server fact that arrives
      // with the first read, which is why this is a hardcoded `true` like /curve-launch
      // rather than a condition. Remove the pill when 016 is applied — see
      // docs/WHAT_I_NEED_FROM_YOU.md §2.2 — and navConfig.test.ts will hold you to the
      // reason until you do.
      //
      // NOTE for a future editor: TradePage's fifth tab is *also* labelled "Alerts"
      // (internal id 'limit', heading "Limit Order" — a browser-tab price watcher beside
      // a CoW limit order). It is a different surface and is not in the nav. This entry
      // is the rule store + inbox at /alerts.
      { to: '/alerts',   label: 'Alerts', soon: true },
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
