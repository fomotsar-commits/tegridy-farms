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
// The curve rail is deployed on three chains, not one. Both the label and the
// pill on the /eth-curve entry below read this registry-derived list rather than
// the mainnet address constant they used to key on — see that entry's comment.
import { curveChainNames, isCurveLive } from './launcher/curveChains';
// The four predicates below replaced `isIndexerConfigured` on their entries when
// those surfaces stopped depending on the unhosted Ponder indexer. Each is pure,
// side-effect-free at import, and reads config this build already carries — a
// registry market, a registered island pool, a verified settlement asset — so a
// pill can still be a computed fact rather than a literal. See each entry.
//
// `isIndexerConfigured` is deliberately NO LONGER IMPORTED HERE, and its absence is
// the summary of this change-set: as of 2026-09-02 not one nav entry is keyed to
// VITE_INDEXER_URL. Six surfaces used to be — /terminal, /chart, /copy-trading,
// /competitions and /tax read that one unset variable and every one of them showed
// a visitor an amber SOON. The indexer is still unhosted; those pages simply stopped
// depending on it, and now read rails this build already carries. It survives inside
// `hasScoreableBoard()` (an indexer season is one of two ways a board can exist) and
// inside the pages themselves, where an outage can be described in words instead of
// being compressed into a pill. If you re-add the import, you are re-coupling the
// menu to a service nobody hosts — read the entry comments below first.
import { hasChartableMarket } from './chart/markets';
import { hasCopyTapeSource } from './copytrade/tape';
import { hasScoreableBoard } from './competitions/availability';
import { hasPaymentLinkChain } from './commerce/settleTokens';

export interface NavItem {
  to: string;
  label: string;
  /**
   * Shorter label used when this entry is rendered as a TAB on its section's
   * host page (see SectionHost.tsx) instead of as a menu row. Defaults to
   * `label`. It exists because the two contexts have different budgets: a
   * dropdown row can afford "Memetics Curve — Ethereum · Base · Robinhood
   * Chain", a tab in a seven-wide strip cannot. `label` stays the canonical
   * name — e2e specs and lib/yield/surface.test.ts pin it — so a tab rename can
   * never quietly rename the destination.
   */
  tabLabel?: string;
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
  /**
   * COLLAPSED SECTION (2026-09-04). When set, the "More" menu renders ONE row
   * for this whole section — the heading, linking here — and the section's
   * items become the tab strip on the page at that route (SectionHost.tsx).
   *
   * `hub` must be the FIRST item's `to`. That is not decoration: the host's
   * landing tab is `items[0]`, so a hub pointing anywhere else would open the
   * menu entry on a page whose tab bar highlights something the visitor did not
   * click. hubIntegrity in navConfig.test.ts pins the two together.
   *
   * NOTHING IS DROPPED BY COLLAPSING. Every item keeps its `to`, its `label`
   * and its SOON/LIVE pill, keeps its own route in App.tsx, and keeps rendering
   * standalone from a deep link — the tab strip is added above it, not swapped
   * in for it. MORE_NAV and ALL_NAV still flatten every item, so the
   * completeness and no-duplicate assertions below still see the full set.
   *
   * A section with no `hub` renders the old way: heading, then one row per item.
   */
  hub?: string;
}

/**
 * "More" dropdown / drawer — curated secondary destinations, grouped into
 * sections so the menu is scannable on desktop and mobile from a single source
 * of truth. Some entries are gated (Community appears only when a governance
 * contract is live), so the rendered counts vary.
 *
 * 🔻 CONDENSED 2026-09-04, on the operator's report that the dropdown "has too
 * much going on". It listed twenty-one rows under six headings; Trust & Safety
 * alone was seven of them, which is more links than the entire primary nav.
 *
 * FOUR SECTIONS NOW CARRY `hub` and render as ONE row each — Launch, Earn,
 * Stats, Trust & Safety — and their items become the tab strip on the page that
 * row opens (SectionHost.tsx). Nine rows instead of twenty-one. Discover and
 * Trade are short enough already and stay expanded.
 *
 * THE ITEMS DID NOT MOVE AND NOTHING WAS DELETED. Every `to`, every `label`,
 * every gating expression and every comment below is exactly where it was: the
 * change is four `hub:` lines, some `tabLabel:` shorthands, and a different
 * renderer in TopNav.tsx. That matters here — this repo's e2e specs pin nav
 * LABELS and have gone red twice on rename waves — and it is why MORE_NAV /
 * ALL_NAV are unchanged in shape and navConfig.test.ts needed no rewrite.
 *
 * Pages that were ALREADY merged into tabbed hosts keep one representative
 * entry each (ActivityPage covers Leaderboard/Gold Card/History/Changelog;
 * LearnPage covers Lore/Security/FAQ; InfoPage covers
 * Contracts/Risks/Terms/Privacy) so the menu never lists a tab twice. Those
 * tabs stay reachable via the Footer and direct URLs.
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
    // COLLAPSED: one "Launch" row in the menu; these four are the tab strip on
    // the page it opens. See the `hub` doc on NavSection.
    hub: '/launch',
    items: [
      { to: '/launch',      label: 'Launch', tabLabel: 'Launchpad', soon: !isLauncherEnabled() },
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
      { to: '/curve-launch', label: 'Memetics Curve (Solana)', tabLabel: 'Solana Curve', soon: true },
      // Our OWN EVM curve (TegridyCurveLauncher) — zero-toll, graduate-to-us, no
      // Airlock/petition.
      //
      // 🔧 2026-09-04 — THIS ENTRY NAMED ONE CHAIN AND GATED ON ONE CHAIN, AND
      // THE RAIL IS ON THREE. It read `label: 'Memetics Curve (EVM)'` with
      // `soon`/`live` both keyed to `isDeployed(CURVE_LAUNCHER_ADDRESS)` — the
      // MAINNET constant. But the curve has been live on Base (8453) and
      // Robinhood Chain (4663) since 2026-08-25 (both addresses are in
      // chains/registry.ts, read-back verified), and "(EVM)" is not a string
      // anybody searching for the Robinhood launcher would ever type. The
      // operator's report was exactly that: the Base and Robinhood launchers
      // are not named anywhere, and the Robinhood one cannot be found at all.
      //
      // Both halves now come from `deployedCurveChains()` over the same registry
      // the page reads, so the label ENUMERATES the live chains and the pill
      // answers the question it claims to ("can I launch?") across all of them
      // rather than for mainnet only. A fourth deployment names itself here; the
      // last one being removed puts SOON back. `tabLabel` keeps the tab strip
      // short — the chains are named again, at full width, by the chain picker
      // at the top of /eth-curve, which is the control that actually switches
      // them.
      {
        to: '/eth-curve',
        label: isCurveLive() ? `Memetics Curve (${curveChainNames()})` : 'Memetics Curve (EVM)',
        tabLabel: 'Memetics Curve',
        soon: !isCurveLive(),
        live: isCurveLive(),
      },
      // Pure client-side — always usable, deliberately live before the launch rail opens.
      { to: '/launch-simulator', label: 'Launch Simulator', tabLabel: 'Simulator' },
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
      // Contrast /curve-launch above, which IS pilled and cannot self-clear: its Solana
      // program is deployed on no cluster, so no flag or config can make it launchable.
      // (/yield used to be the example here and no longer is — it now carries verified
      // deposit addresses and its pill cleared.) The comparable dependency here —
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
    // COLLAPSED: one "Earn" row; these five are the tab strip on /referrals.
    hub: '/referrals',
    items: [
      { to: '/referrals', label: 'Referrals' },
      // Yield Routing compares THIRD-PARTY liquid staking and stablecoin lending
      // venues. It sits in Engage rather than Stats because what a visitor does here
      // is choose between other people's protocols, which is an action, not a metric
      // about ours.
      //
      // NO LONGER PILLED, and the expression did not change — what it computes did.
      // The entry names ROUTING, and `hasRoutableYieldVenue()` reads whether any venue
      // carries a real, on-chain-verified deposit target. Every one of them used to be
      // the zero address, so the pill was on; seven now hold the protocol's own
      // canonical permissionless entry point (Lido submit, Rocket Pool deposit,
      // ether.fi, Renzo, Aave v3 supply, Compound v3 supply, sUSDS deposit), each
      // registered in scripts/addresses.json and re-read on chain, so it is off. That
      // is the pill working exactly as designed — a computed fact that turned over on
      // its own the moment the destinations became real.
      //
      // cbETH deliberately stays unroutable and does NOT hold the pill on: Coinbase
      // mints it only for its own custody customers, so there is no public contract to
      // wire, and its row says so instead of offering a button that cannot fire.
      //
      // Deliberately NOT keyed to a rate feed. A readable feed with no wired
      // destination is a working comparison table and a router that cannot route,
      // which is exactly the /solana-launch bug — a pill that clears on a flag while
      // the advertised action stays impossible. Rates are now read on chain anyway;
      // an unread rate degrades one cell, and never this entry.
      { to: '/yield', label: 'Yield Routing', tabLabel: 'Yield', soon: !hasRoutableYieldVenue() },
      // Copy Trading and Competitions. Both were keyed to VITE_INDEXER_URL when the
      // venue's own Ponder indexer was the only thing either could read. Neither is
      // any more: both now read the ISLAND TAPE — GeckoTerminal's pool-trade feed for
      // every bungalow carrying a registered `market`, plus the venue's own TOWELI/WETH
      // pool. No env var, no key, no proxy: api.geckoterminal.com is already in
      // connect-src and usePoolTrades already reads this exact URL in production.
      //
      // Both pills are therefore REGISTRY-CONSTANT, the same shape as /eth-curve's
      // `!isDeployed(...)` above: each clears because a readable pool is REGISTERED,
      // not because a read succeeded. A failed read is described by the page's own
      // ledger, which can name the pool that failed and the reason it gave; a pill can
      // do neither, and one keyed to a live read would flicker SOON during a
      // third-party outage on pages that still have a follow list, a mirror queue, a
      // personal record and a season's rules. Feed reachability at render time is
      // deliberately NOT folded in — the same convention /swap follows, whose pill does
      // not probe the aggregator.
      //
      // The two predicates differ in ONE way worth keeping: `hasScoreableBoard()` is
      // true if EITHER a resident pool is registered OR an indexer is configured,
      // because /competitions still offers the router season when one exists.
      // `hasCopyTapeSource()` is the registry alone. Both return to SOON if every
      // market is removed from the registry (and, for competitions, no indexer is set).
      //
      // What these entries do NOT promise, and must not be edited to: that a follow
      // executes anything — there is no keeper, so the user places every mirror — or
      // that a season pays or ever closes, since no prize pool, escrow or settlement
      // exists. Both pages state those from the modules that enforce them.
      { to: '/copy-trading', label: 'Copy Trading', soon: !hasCopyTapeSource() },
      { to: '/competitions', label: 'Competitions', soon: !hasScoreableBoard() },
      // Merchant checkout. NOT PILLED since 2026-09-02, and the reason is the same
      // one that keeps /referrals above unpilled: the thing this entry names now
      // happens entirely in the browser.
      //
      // The invoice is an EIP-712 document the merchant signs with their own wallet
      // and carries in the link's URL fragment (lib/commerce/paymentLink.ts). The
      // buyer's browser verifies that signature against the merchant address with
      // viem, re-reads the settlement token on chain, and signs the exact transfer.
      // No server, no database, no migration, no account, no env var participates —
      // so there is nothing a server could fail to answer that could make this pill
      // lie in either direction.
      //
      // `021_commerce.sql` has NOT landed and this entry does not wait for it. What
      // that migration buys is now only the shorter `/checkout?invoice=` form and the
      // merchant's claims list, exactly the way `019_referral_codes.sql` buys only
      // `/?r=code` — its absence degrades one optional affordance instead of the
      // feature. Pilling this would tell a visitor they cannot be paid here when they
      // can.
      //
      // KEYED TO THE ONE FACT THAT CAN VARY. `hasPaymentLinkChain()` is false when no
      // served chain has an on-chain-verified, registry-registered settlement asset in
      // SETTLE_TOKENS_BY_CHAIN — a table that can genuinely be empty, and that extends
      // itself the day a Base or Robinhood asset is verified and registered.
      // Deliberately NOT keyed to CONFIGURED_CHAIN_IDS, which viemChains.ts makes
      // non-empty by construction: a condition that cannot be false is a tautology
      // wearing a check's clothes. navConfig.test.ts asserts the table contains chain
      // 1 BEFORE it asserts the pill, so emptying the table fails the precondition
      // first and forces this comment to be re-read.
      //
      // What this entry does NOT promise, and must not be edited to: that this venue
      // executes the swap leg. lib/aggregator.ts is quote-only here, so the checkout
      // signs the exact transfer and states that step 1 happens on the trade surface.
      { to: '/checkout', label: 'Checkout', soon: !hasPaymentLinkChain() },
    ],
  },
  {
    heading: 'Stats',
    // COLLAPSED: one "Stats" row; these three are the tab strip on /tokenomics.
    //
    // ⚠️ THIS SECTION TOOK TWO ROUTES OFF OTHER HOSTS, 2026-09-04, and that is
    // the part to re-read before moving anything back. /tokenomics was a tab on
    // LearnPage and /treasury a tab on InfoPage — a route renders exactly one
    // tab bar, so "Stats is one page with tabs" is only true if Stats OWNS
    // them. LearnPage is now Lore/Security/FAQ and InfoPage is
    // Contracts/Risks/Terms/Privacy, which is a cleaner split anyway: Learn is
    // the narrative, Info is the legal + reference shelf, Stats is the numbers.
    // Every URL, footer link and e2e route is unchanged.
    hub: '/tokenomics',
    items: [
      { to: '/tokenomics', label: 'Tokenomics' },
      { to: '/treasury',   label: 'Treasury' },
      // Tax reports no longer read the F1 indexer and nothing else. Ethereum-mainnet
      // history is read through /api/etherscan — a same-origin serverless function that
      // ships with every deployment of this repo and allowlists exactly the three account
      // actions the ledger needs (txlist, txlistinternal, tokentx) — and it returns BOTH
      // legs of a trade in one transaction, so disposals get real proceeds. That is a REPO
      // fact, not a deployment flag, so the pill is a concrete `false`.
      //
      // The one input that could make it false is the SERVER-SIDE ETHERSCAN_API_KEY, and
      // it is not client-readable at nav-render time (this array is built at module
      // scope). So the honest disclosure lives where the state IS readable: the ledger
      // status card on /tax names ETHERSCAN_API_KEY and prints the operator step the
      // moment a read comes back keyless, and every export carries the whole period as a
      // declared `explorer-unavailable` gap. Same treatment lib/alerts/sources.ts already
      // gives the identical source (explorer readable: true — a same-origin resource
      // whose failure is an outage, reported at read time).
      //
      // Deliberately NOT a function returning a constant, which is the hardcoded value
      // wearing a check this list warns about. It is guarded three ways instead:
      // lib/tax/rails.test.ts parses api/etherscan.js for the three actions and asserts
      // the page-level disclosure exists, navConfig.test.ts pins the concrete false AND
      // that stubbing isIndexerConfigured() either way leaves it unchanged, and
      // TaxPage.test.tsx renders the keyless copy. The indexer is now optional
      // enrichment and does not decide this pill.
      { to: '/tax', label: 'Tax Reports', tabLabel: 'Tax', soon: false },
    ],
  },
  // The three detection surfaces are the protocol's one genuine differentiator and
  // they work on ANY token/wallet, not just TOWELI — so they earn their own named
  // section instead of sitting under "Stats" beside Tokenomics/Treasury, where they
  // read as protocol vanity metrics. /trust is the hub that frames them as one suite.
  {
    heading: 'Trust & Safety',
    // COLLAPSED: one "Trust & Safety" row; these seven are the tab strip on
    // /trust, whose page was already written as the hub that frames them as one
    // suite — it just had no way to keep the visitor inside it. Seven was by far
    // the worst offender in the old menu: a third of every link in the dropdown
    // was this section.
    hub: '/trust',
    items: [
      { to: '/trust',    label: 'Trust Tools',     tabLabel: 'Overview' },
      { to: '/scan',     label: 'Token Scanner',   tabLabel: 'Scanner' },
      { to: '/deployer', label: 'Deployer Graph',  tabLabel: 'Deployer' },
      { to: '/exposure', label: 'Wallet Exposure', tabLabel: 'Exposure' },
      // The same three reads, applied to a discovery feed instead of to one
      // pasted address. It sits here rather than beside Trade because the feed is
      // the delivery mechanism and the safety read is the product.
      //
      // NO PILL, and the absence is the honest answer rather than an oversight.
      //
      // This entry was pilled on `!isIndexerConfigured()` when the page's only feed
      // was the venue's own Ponder indexer. It is not any more: /terminal's market
      // feed is a browser-direct read of GeckoTerminal — keyless, on an origin the
      // CSP already allows (vercel.json connect-src), with no operator step and no
      // environment variable behind it. It works on every deployment, so a "soon"
      // pill here would mark a working page as absent.
      //
      // And there is nothing else to key one on. The rule wants a pill driven by the
      // same live read the page gates on; this page's gate is a constant (the
      // GeckoTerminal source is readable by construction, exactly like the
      // same-origin entries in lib/alerts/sources.ts). Dressing that constant up as
      // a live check would be a hardcoded value pretending to self-clear — nothing
      // in the client can read a CSP header or an upstream's mood. The live signal
      // is the page's own "The market feed could not be read" banner, reported at
      // read time, which is where a rate limit or an outage actually shows up.
      //
      // The indexer half is STILL a live read, and it gates only the extra
      // "Venue pairs" TAB, which appears when VITE_INDEXER_URL is set.
      { to: '/terminal', label: 'Pro Terminal', tabLabel: 'Terminal' },
      // Pro Charting no longer reads the indexer for its primary source. Its data
      // path is api.geckoterminal.com (CSP: vercel.json connect-src) over the
      // registry's `market` fields (lib/bungalows.ts) plus TOWELI's own pool, so the
      // pill reads `hasChartableMarket()` — a client-readable registry fact, the same
      // discipline as `!isDeployed(CURVE_LAUNCHER_ADDRESS)` above — and returns to
      // SOON only if every registry market is removed. Runtime outages (429/404) are
      // the page banner's job; a pill that flickered with a rate limit would be less
      // honest, not more. In practice the expression is a compile-time constant today,
      // which is said here rather than dressed up as a live probe. The indexed-swap
      // panel on that page still self-enables on VITE_INDEXER_URL.
      { to: '/chart', label: 'Pro Charting', tabLabel: 'Charting', soon: !hasChartableMarket() },
      // Alerts belongs to this section rather than to Engage or Stats: its rule kinds
      // watch exactly what the tools above read on demand (a deployer's reputation
      // band, a launch going live, a wallet's Heat tier, a pool's quoted price), on
      // ANY token, wallet or pool. Same subject matter, pushed instead of pulled.
      //
      // NOT PILLED, and this is the assertion to re-read if that ever changes. The
      // pill answers one question — can I do the thing this entry names? — and the
      // answer is yes, unconditionally, in every build: the rule store is this
      // browser's own localStorage (lib/alerts/ruleStore.ts — no server table, no
      // session, no env), and the readable rule kinds run on sources that ship with
      // every deployment (sources.ts hardcodes heat-oracle / launch-radar / explorer /
      // gecko-pool as readable; venue-lending is readable wherever the NFT-lending
      // address is deployed).
      //
      // It was pilled because the store lived behind `016_alert_rules.sql` AND a SIWE
      // session this venue has no control for, so nothing could be saved. The store
      // moved into the browser; 016 now gates only the deferred wallet-SYNC step,
      // which nothing on the page promises. navConfig.test.ts pins the PRECONDITION
      // (the store's source contains no `fetch(`) rather than the conclusion, so the
      // day someone gives this store a server dependency that assertion fails first
      // and sends them back here.
      //
      // NOTE for a future editor: TradePage's fifth tab is *also* labelled "Alerts"
      // (internal id 'limit', heading "Limit Order" — a browser-tab price watcher
      // beside a CoW limit order). It is a different surface and is not in the nav.
      // This entry is the rule store + inbox at /alerts.
      { to: '/alerts',   label: 'Alerts' },
    ],
  },
];

/**
 * The section a host page renders as its tab strip.
 *
 * THROWS RATHER THAN RETURNING UNDEFINED, and that is the point. The alternative
 * — a host that quietly falls back to an empty `items` array — renders a page
 * with a blank tab bar and no way to reach six of its seven surfaces, which is
 * this repo's most-repeated bug class: an unreadable state that reads as fine.
 * The headings are string literals a few lines above, so the only way to trip
 * this is to rename one without updating its host, and then the whole app fails
 * at import with the heading named in the message.
 */
function requireSection(heading: string): NavSection {
  const found = MORE_NAV_SECTIONS.find((s) => s.heading === heading);
  if (!found) {
    throw new Error(
      `navConfig: no "${heading}" section — a host page renders its items as tabs (see SectionHost.tsx)`,
    );
  }
  return found;
}

/** The four collapsed sections, each rendered as one menu row + one tabbed page. */
export const LAUNCH_SECTION = requireSection('Launch');
export const EARN_SECTION = requireSection('Earn');
export const STATS_SECTION = requireSection('Stats');
export const TRUST_SECTION = requireSection('Trust & Safety');

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
