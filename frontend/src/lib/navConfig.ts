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
 * Where "Swap" goes. The venue has two swap surfaces — /swap (Ethereum) and
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

export interface NavSection {
  /**
   * The word in the top bar AND the section's name — they are the same string
   * on purpose. A section whose menu heading said one thing while the top bar
   * said another is exactly the drift this file spent two rewrites removing.
   */
  heading: string;

  /**
   * Where the top-bar word goes. MUST be `items[0].to` — hubIntegrity in
   * navConfig.test.ts pins the two together.
   *
   * That is not decoration. The host's landing tab is `items[0]`
   * (SectionHost.tsx derives `active` from the URL and falls back to items[0]),
   * so a hub pointing anywhere else would open the top-bar word on a page whose
   * tab bar highlights something the visitor did not click.
   */
  hub: string;

  /**
   * The section's destinations, in tab order. items[0] is the landing tab.
   *
   * NOTHING IS SECONDARY ANY MORE. Before 2026-09-05 a section's own hub page
   * was deliberately kept OUT of `items` — PRIMARY_NAV was a hand-written
   * parallel list that owned those paths, and ALL_NAV asserted no path appeared
   * twice, so listing a hub in both would have failed. PRIMARY_NAV is now
   * DERIVED from these sections (see below), so the hub belongs in `items`
   * where it always should have been: one list, no way for the bar and the
   * strip to disagree about what a section contains.
   */
  items: NavItem[];

  /**
   * Optional override for where the TOP-BAR word points, when that is not the
   * hub. Exactly one section uses it — Swap, whose landing surface follows the
   * active bungalow's chain (TRADE_ROUTE above).
   *
   * It must still be one of this section's own `items`, which navConfig.test.ts
   * asserts: an override pointing outside the section would light no tab.
   */
  primaryTo?: string;
}

/**
 * THE VENUE'S SIX WORDS (2026-09-05).
 *
 * The top bar was Dashboard / Farm / Trade / NFT Finance, a right-aligned
 * Marketplace, and a "More ▾" dropdown holding five more sections. The
 * operator's reading of it, which is the brief this rewrite answers:
 *
 *   - "More" means "we couldn't decide", and it was three levels deep —
 *     More → section → page — on a site this size.
 *   - "Farm" is DeFi jargon, and there was already an "Earn" group inside More,
 *     so one idea wore two names at two levels.
 *   - "Trade" and "Marketplace" gave no clue which one was tokens and which was
 *     art. "Trust & Safety" reads as a policy page, and behind it sat the
 *     scanner, the deployer graph and wallet exposure — the venue's single best
 *     differentiator, under the most boring label on the site, two clicks deep.
 *   - "Dashboard" led a nav it has no business leading: it is empty until a
 *     wallet connects, so a stranger's first word was a blank page.
 *
 * So: SIX VERBS, no dropdown, every one naming a job rather than a container —
 *
 *     Swap · Pools · Island · Launch · Earn · Check
 *
 * and Dashboard appended LAST, only once a wallet is connected, which is the
 * order the operator asked for: the execution words first, then "what is
 * happening with my assets".
 *
 * PRIMARY_NAV IS DERIVED FROM THIS ARRAY. There is no second list to keep in
 * step, which is what let the hub pages move INTO `items` (see NavSection.items).
 */

export const NAV_SECTIONS: NavSection[] = [
  {
    // ── SWAP ────────────────────────────────────────────────────────────────
    // Was "Trade", which said nothing about whether it meant tokens or the art
    // marketplace. "Swap" is what the page actually is.
    //
    // ITS OWN PAGE IS NOW IN `items`. Before this rewrite the section carried
    // `inPrimaryNav: true` and held only the two SECONDARY destinations, and
    // TradeHostPage composed `[primary, ...items]` at render because
    // PRIMARY_NAV owned '/swap' and ALL_NAV forbade a repeat. PRIMARY_NAV is
    // derived now, so the strip is simply `items` and the host composes nothing.
    heading: 'Swap',
    hub: '/swap',
    // The top-bar word follows the active bungalow's chain; both destinations
    // are in `items`, so whichever one it resolves to lights a real tab.
    primaryTo: TRADE_ROUTE,
    items: [
      { to: '/swap', label: 'Swap', tabLabel: 'Ethereum' },
      ...(SOLANA_LIVE ? [{ to: '/solana', label: 'Solana Swap', tabLabel: 'Solana' }] : []),
    ],
  },
  {
    // ── POOLS ───────────────────────────────────────────────────────────────
    // NEW TOP-LEVEL SECTION, 2026-09-05, on the operator's brief: "the platform
    // is not friendly for LPing today… this should be a separate page from
    // SWAP… it deserves its own section, not just a tab."
    //
    // It was literally a tab: `LiquidityTab` is the 2nd of six inner tabs on
    // TradePage, reachable as /swap?tab=liquidity, with /liquidity as a path
    // alias that fell through to the same host. Someone arriving to provide
    // liquidity had to know to open the swap page first and then find a tab —
    // and the venue's own pool card said "View all pools →" and landed them on
    // that single-pair form rather than on any list of pools.
    //
    // /pools joins it here rather than staying under Swap: it is the venue's
    // own Solana AMM status page, which is a LIQUIDITY surface, not a trading
    // one. /zap is promoted out of orphanhood — it composes swap → add
    // liquidity → stake in one run and, until now, was linked from nowhere at
    // all: no nav entry, no footer row, no page.
    heading: 'Pools',
    hub: '/liquidity',
    items: [
      { to: '/liquidity', label: 'Liquidity', tabLabel: 'Add / Remove' },
      // The venue's own constant-product AMM on Solana. Deliberately UNGATED:
      // the page is a live chain probe of the venue's status, so while the
      // program is undeployed it renders that fact rather than an empty market.
      // Hiding it would hide the one surface that explains where the venue is.
      { to: '/pools', label: 'Venue AMM' },
      // One-token entry into an LP position. NOT PILLED: the swap and
      // add-liquidity legs run against the venue's own deployed factory and
      // router (constants.ts), and the staking leg against the deployed LP
      // farm. The one leg that is gated — the compounder vault — is the zap
      // machine's own `unavailable` branch, reported on the page at plan time
      // where it can name which venue is missing, which a pill cannot.
      { to: '/zap', label: 'Zap In', tabLabel: 'Zap' },
    ],
  },
  {
    // ── ISLAND ──────────────────────────────────────────────────────────────
    // Absorbs the old "Discover" (Community / Gallery / Venue Score) AND the
    // old "Stats" (Tokenomics / Treasury / Tax). Both were containers rather
    // than jobs — "Discover" is not what those three have in common, and
    // "Stats about WHAT?" was the operator's question about the other.
    //
    // What they DO have in common is the venue itself: this is the place, its
    // art, its people, its score and its money. Marketplace comes in from its
    // old right-aligned slot for the same reason — an art marketplace is an
    // island surface, and sitting it beside "Trade" only ever raised the
    // question of which of the two sold tokens.
    //
    // ⚠️ THE ONE SECTION THAT IS NOT A SectionHost, AND THE REASON MATTERS.
    // Every other section's items are pages with no tab bar of their own, so a
    // strip on top of them is free. Island's are not: /community, /leaderboard
    // (ActivityPage) and /tokenomics (StatsPage) EACH already own a tab strip,
    // and a route renders exactly one — the same constraint the old Stats
    // section's comment was written about. Giving Island a strip would either
    // nest two bars or force three hosts to give theirs up.
    //
    // So Island's hub is a LOBBY (/island): one page of cards, one door each.
    // A tab strip is for switching between sibling views of one subject; this
    // group is five different subjects that happen to share a place. The cards
    // say so, and every destination keeps the strip it already had.
    //
    // ONE ENTRY PER HOST, which is the convention this file already follows for
    // ActivityPage (Leaderboard/Gold Card/History/Changelog) and InfoPage: a
    // tabbed host appears in the nav once, at its landing tab, and its siblings
    // are reached from inside it. That is why "Treasury & numbers" is a single
    // row pointing at /tokenomics rather than three rows — /treasury and /tax
    // are StatsPage's own tabs and stay reachable there, in the footer, and by
    // direct URL, exactly as they were.
    heading: 'Island',
    hub: '/island',
    items: [
      { to: '/island',      label: 'The island',  tabLabel: 'Island' },
      { to: '/gallery',     label: 'Gallery' },
      // Tradermigos — a separate route tree (App.tsx mounts `nakamigos/*`
      // OUTSIDE AppLayout), which is a second reason the lobby is cards and not
      // tabs: this destination could never have rendered in a host's panel.
      { to: '/nakamigos',   label: 'Marketplace' },
      // Community is gated on COMMUNITY_LIVE. 🔄 2026-08-12: the old note here
      // said all four governance contracts were "zeroed" and the page was
      // "wall-to-wall isn't live yet" — the first half is true only of
      // constants.ts, and the second half is now false. All four contracts are
      // deployed and unpaused on mainnet; only the frontend wiring is missing,
      // and /community says exactly that. The entry is carried by
      // PROMOTE_PENDING, not by COMMUNITY_ADDRESSES_LIVE (which is false).
      ...(COMMUNITY_LIVE ? [{ to: '/community', label: 'Community' }] : []),
      { to: '/leaderboard', label: 'Venue Score' },
      // The old "Stats" section, as ONE row. "Stats about what?" was the
      // operator's question and it was a fair one; this names the subject.
      // StatsPage still hosts /tokenomics + /treasury + /tax as its own three
      // tabs — nothing moved, nothing was dropped, and the ⚠️ note that used to
      // live on that section still applies: /tokenomics came off LearnPage and
      // /treasury off InfoPage on 2026-09-04 precisely so ONE host could own
      // all three, which is why they must not be split back out.
      // NUMBERS_TABS[0] — see that export. Kept as a literal rather than a
      // reference so this list reads as one list; navConfig.test.ts asserts the
      // two agree, so they cannot drift.
      { to: '/tokenomics',  label: 'Treasury & numbers', tabLabel: 'Numbers' },
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
    // ── EARN ────────────────────────────────────────────────────────────────
    // "Farm" left the top bar and its page landed here, which fixes the thing
    // the operator named directly: "Farm" is DeFi jargon, AND there was already
    // an "Earn" group inside the dropdown, so one idea wore two names at two
    // levels of the same nav. There is one name now, and it is the job.
    //
    // /nft-finance joins from the top bar for the same reason "NFT Finance" was
    // flagged — a category name, not something anyone wants to do. Its label is
    // what it does. Borrowing against an NFT is a way to get money out of an
    // asset you are holding, which is this section's subject.
    //
    // THE HUB MOVED /referrals → /farm. Referrals is a recruiting tool; the
    // pool is what someone means by "earn", and it is the only item here whose
    // numbers a stranger can read without connecting anything.
    heading: 'Earn',
    hub: '/farm',
    items: [
      // ⚠️ NOT "Pools", WHICH IS WHAT THIS READ FIRST. "Pools" is a TOP-BAR WORD
      // now and it means providing liquidity; the same word one level down,
      // meaning "stake a token in its reward pool", is two different jobs
      // wearing one name — the exact defect that made "Farm" and "Earn" both
      // exist before this rewrite. Staking is what you do here: lock a token,
      // or lock the LP receipt you minted under Pools, and take a share.
      { to: '/farm', label: 'Staking' },
      ...(NFT_FINANCE_LIVE ? [{ to: '/nft-finance', label: 'Borrow on NFTs', tabLabel: 'NFT Loans' }] : []),
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
  // The three detection surfaces are the protocol's one genuine differentiator and
  // they work on ANY token/wallet, not just TOWELI — so they earn their own named
  // section instead of sitting under "Stats" beside Tokenomics/Treasury, where they
  // read as protocol vanity metrics. /trust is the hub that frames them as one suite.
  {
    // ── CHECK ───────────────────────────────────────────────────────────────
    // Was "Trust & Safety", and that rename is the single biggest win in this
    // change-set. "Trust & Safety" is content-moderation language: it reads as a
    // policy page — terms, reporting, a form. Behind it sit the scanner, the
    // deployer graph and wallet exposure, which is the venue's best
    // differentiator, and it was buried under the most boring label on the site,
    // two clicks deep inside a dropdown called "More".
    //
    // "Check" is what a visitor is actually here to do, and it is now one word
    // in the top bar. The seven items are unchanged — every `to`, every label,
    // every pill and every comment below is exactly where it was.
    heading: 'Check',
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

/**
 * The top bar, DERIVED — never hand-written beside the sections it duplicates.
 *
 * This used to be a literal array of four items maintained in parallel with
 * MORE_NAV_SECTIONS, and the two could disagree: a section could gain a
 * destination the bar never learned about, or point its word at a page whose tab
 * strip highlighted something else. Deriving it makes both impossible, and it is
 * what let each section's hub page move INTO its own `items` (NavSection.items).
 *
 * `primaryTo` exists for exactly one section — see Swap.
 */
export const PRIMARY_NAV: NavItem[] = NAV_SECTIONS.map((s) => ({
  to: s.primaryTo ?? s.hub,
  label: s.heading,
}));

/**
 * Dashboard — appended to the bar LAST, and only once a wallet is connected.
 *
 * It led the nav before this change, and it is the one destination that is
 * empty for a visitor who has not connected: a stranger's first word in the top
 * bar opened a page with nothing in it. The operator's own framing is the rule
 * now — "you go through the main executive tabs and then you could see what is
 * happening with your assets" — so it comes last, after the six things you can
 * actually DO, and it appears when there is something for it to show.
 *
 * NOT part of PRIMARY_NAV, deliberately: PRIMARY_NAV is derived from the
 * sections, and Dashboard is not a section — it has no tab strip and no
 * children. TopNav appends it from wagmi's connection state; BottomNav shows it
 * on the same condition. ALL_NAV includes it so the route-coverage assertions
 * still see it.
 */
export const DASHBOARD_NAV: NavItem = { to: '/dashboard', label: 'Dashboard' };

/**
 * StatsPage's three tabs.
 *
 * NOT a NavSection, and not in NAV_SECTIONS: these are the sibling views of ONE
 * host, and the nav lists a tabbed host once, at its landing tab — the same
 * convention ActivityPage (Leaderboard / Gold Card / History / Changelog) and
 * InfoPage (Contracts / Risks / Terms / Privacy) already follow. Island carries
 * the single "Treasury & numbers" row that opens this host; /treasury and /tax
 * stay reachable as its tabs, from the Footer, and by direct URL.
 *
 * DECLARED HERE rather than inside StatsPage.tsx, unlike InfoPage's local
 * `TABS`, for one reason: the /tax pill. It is the only pill on any of the three
 * and navConfig.test.ts guards it — that it is a concrete `false`, and that
 * stubbing isIndexerConfigured() either way does not move it. A pill and the
 * assertions that keep it honest should not live in different files.
 */
export const NUMBERS_TABS: NavItem[] = [
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
  // declared `explorer-unavailable` gap.
  //
  // Deliberately NOT a function returning a constant, which is the hardcoded value
  // wearing a check this file warns about. It is guarded three ways instead:
  // lib/tax/rails.test.ts parses api/etherscan.js for the three actions and asserts
  // the page-level disclosure exists, navConfig.test.ts pins the concrete false AND
  // that stubbing isIndexerConfigured() either way leaves it unchanged, and
  // TaxPage.test.tsx renders the keyless copy.
  { to: '/tax', label: 'Tax Reports', tabLabel: 'Tax', soon: false },
];

/** Flat list of every sectioned destination — used by the mobile drawer. */
export const MORE_NAV: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

/**
 * Every reachable top-level destination, exactly once.
 *
 * PRIMARY_NAV is deliberately NOT spread in here any more. It is derived from
 * the very sections MORE_NAV flattens, so including both would make every path
 * in the bar appear twice and turn the no-duplicates assertion into a test of
 * this file's own arithmetic rather than of the nav.
 *
 * Dashboard IS included, because it is the one destination no section owns —
 * without it the route-coverage assertions would call /dashboard un-navigable.
 */
export const ALL_NAV: NavItem[] = [
  ...MORE_NAV,
  DASHBOARD_NAV,
];
