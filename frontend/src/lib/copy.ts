/**
 * copy.ts — Centralized product copy for memetics.finance (the farm's own voice).
 *
 * Why this file exists:
 *   The Spartan Battle Plan brand audit rated meme-integration at 4.1/10.
 *   Engineering was good; voice was generic DeFi ("STAKE CONFIRMED", "7 Days").
 *   This file replaces those strings with Randy-Marsh-era memetics.finance voice
 *   across receipts, lock durations, error surfaces, and tooltip flavor.
 *
 * Why centralized:
 *   The user has explicit Randy/Cartman/DEA/Towelie references (Paramount IP
 *   risk: MEDIUM-HIGH). Keeping all character-named strings in this one file
 *   means a 48-hour rebrand ("Towel Farms" / "Randy's DeFi") is a surgical
 *   string-swap rather than a codebase-wide hunt.
 *
 * How to use:
 *   import { RECEIPT_COPY, LOCK_DURATIONS, PENALTY_COPY, TOWELIE_QUOTES } from '@/lib/copy';
 *   <button>{PENALTY_COPY.earlyExitLabel}</button>
 */

// ═══════════════════════════════════════════════════════════════
// Transaction receipt labels — swap the clinical all-caps for
// in-voice verbs. Format: { label, verb } mirroring TYPE_CONFIG
// shape in TransactionReceipt.tsx so it drops in as a spread.
// ═══════════════════════════════════════════════════════════════

/**
 * BOOTSTRAP APR — the shared threshold and the sentence that must travel with
 * any four-digit rate.
 *
 * The displayed APR is the REAL on-chain rate by explicit operator choice. But
 * pre-LP-seed it is fixed-emissions over a tiny TVL, which produces a four-digit
 * number that pattern-matches to a rug for exactly the DeFi-native audience this
 * venue courts. The answer is not to hide the number; it is to never show it
 * without saying why it is that big and that it falls.
 *
 * Centralised because it was NOT: IncentivesStrip carried this note while
 * BoostScheduleTable rendered the largest figure on the whole page — the max-boost
 * row, base APR x4 — with no context at all. Two surfaces, one rule, one copy of it.
 */
export const BOOTSTRAP_APR_THRESHOLD = 1000; // %

export const BOOTSTRAP_APR_NOTE = 'TOWELI emission incentive — bootstrap rate, falls as TVL grows';

/** True when a rate is large enough that showing it bare would mislead. */
export function isBootstrapApr(aprNum: number | undefined): boolean {
  return (aprNum ?? 0) > BOOTSTRAP_APR_THRESHOLD;
}

export const RECEIPT_COPY = {
  swap:             { label: 'SWAPPED, ON THE VENUE',     verb: 'swapped' },
  stake:            { label: 'LOCKED DOWN, HELD TIME ON', verb: 'locked down' },
  unstake:          { label: 'HARVEST WITHDRAWN',         verb: 'pulled off the farm' },
  claim:            { label: 'HARVEST COMPLETE',          verb: 'harvested' },
  vote:             { label: 'VOTE REGISTERED',           verb: 'voted on-chain' },
  bounty:           { label: 'BOUNTY ON THE BOARD',       verb: 'put up a bounty' },
  lock:             { label: 'LOCKED DOWN, HELD TIME ON', verb: 'locked it down' },
  approve:          { label: 'PERMISSION GRANTED',        verb: 'granted the farm permission' },
  liquidity_add:    { label: 'CROP EXPANDED',             verb: 'grew the crop' },
  liquidity_remove: { label: 'CROP ROTATED',              verb: 'pulled crop out' },
  subscribe:        { label: "RANDY'S GOLD CARD ACTIVE",  verb: 'joined the Gold Card' },
  claim_revenue:    { label: 'REVENUE PAID OUT',          verb: 'collected the ETH' },
} as const;

export type ReceiptCopyKey = keyof typeof RECEIPT_COPY;

// ═══════════════════════════════════════════════════════════════
// Lock durations — Randy Wisdom.
// Order matches MIN_LOCK_DURATION / MAX_LOCK_DURATION in constants.ts.
// Use `label` in UI; keep `days` as the source of truth for math.
// ═══════════════════════════════════════════════════════════════

export const LOCK_DURATIONS = [
  { days: 7,    label: 'The Taste Test',           sublabel: '7 days',   flavor: "Just a sample, Randy-style." },
  { days: 30,   label: 'One Month of Integrity',   sublabel: '30 days',  flavor: 'Short commitment. Real held time.' },
  { days: 90,   label: 'The Harvest Season',       sublabel: '90 days',  flavor: 'Through the growing cycle.' },
  { days: 365,  label: 'The Long Haul',            sublabel: '1 year',   flavor: 'A full year on the farm.' },
  { days: 730,  label: 'In It For The Kids',       sublabel: '2 years',  flavor: "For the kids' college fund." },
  { days: 1460, label: 'Till Death Do Us Farm',    sublabel: '4 years',  flavor: 'Maximum held time. Maximum boost.' },
] as const;

// Map seconds → meme label. Call with an epoch-based duration.
export function lockLabelForSeconds(seconds: number): { label: string; sublabel: string; flavor: string } | undefined {
  const days = Math.round(seconds / 86400);
  return LOCK_DURATIONS.find(d => d.days === days);
}

// ═══════════════════════════════════════════════════════════════
// Early-exit / liquidation / penalty copy.
// ═══════════════════════════════════════════════════════════════

export const PENALTY_COPY = {
  earlyExitLabel: 'DEA Raid Tax',
  earlyExitPct: '25%',
  earlyExitTagline: "For the kids' college fund.",
  earlyExitTooltip:
    "Randy always said the farm needs to stay pure. Pull out early and the cops show up — 25% of your crop goes to the treasury, funding the protocol that keeps the rest of the farm running.",
  liquidationLabel: 'The cops showed up',
  liquidationDescription: 'Your loan position crossed the liquidation threshold and was closed out by the protocol.',
  slippageLabel: 'Crop windstorm tolerance',
  slippageTooltip:
    'Max price movement tolerated before the trade is cancelled. Higher = more slippage OK. Randy recommends 0.5% for calm weather, 1% when the market is blowing around.',
} as const;

// ═══════════════════════════════════════════════════════════════
// Vote incentives / governance flavor — "Cartman's Market".
// ═══════════════════════════════════════════════════════════════

export const GOVERNANCE_COPY = {
  bribesSectionTitle: "Cartman's Market",
  bribesSectionTag: 'Totally Not Bribes. Just Donations.',
  bribesSubheading:
    "Incentivize voters to back your pool. Is it bribery? Cartman says no — call it community-funded campaign contributions. Either way, it works.",
  voteCtaLabel: 'Register Your Vote',
  revealLabel: 'Reveal Your Hand',
  commitLabel: 'Commit in Secret',
} as const;

// ═══════════════════════════════════════════════════════════════
// F357: one-sentence per-tab intro so the Community tabs read
// distinctly when rendered logged-out (each says what it is + what
// connecting unlocks), instead of one generic "connect to participate".
// ═══════════════════════════════════════════════════════════════

// ⚠ These four render logged-out, DIRECTLY ABOVE the "deployed — not yet enabled
// here" notice on /community. "Connect to vote" told a visitor that connecting was
// the missing step; it is not — all four contracts are live and unpaused on
// mainnet, but their constants.ts addresses are still 0x0, so no wallet can reach
// them from this app. Promising an action a connected wallet still cannot perform
// is the same defect class as the "isn't live yet" claim two lines below it.
// Say what connecting will do WHEN the address is wired, not what it does today.
export const COMMUNITY_TAB_INTRO = {
  grants: 'On-chain governance: propose and vote on how the community treasury funds builders. Connecting will not unlock it yet — voting and proposals open here once the contract is wired into this app.',
  bounties: 'Meme bounties: fund a task, builders ship, the best work gets paid on-chain. Connecting will not unlock it yet — posting and claiming open here once the contract is wired into this app.',
  bribes: "Cartman's Market: incentivize voters to back your pool with token rewards. Connecting will not unlock it yet — deposits and claims open here once the contract is wired into this app.",
  gauges: 'Gauge voting: direct TOWELI emissions toward the pools you want deepened. Connecting will not unlock it yet — gauge weights open here once the contract is wired into this app.',
} as const;

// ═══════════════════════════════════════════════════════════════
// FAQ opener — the first thing visitors read.
// ═══════════════════════════════════════════════════════════════

export const FAQ_INTRO = {
  headline: 'Questions about the farm',
  subheading:
    "Look. We're not gonna bullshit you. This is a real farm. With real yield. Earned with held time. Below are the questions we hear most.",
} as const;

/**
 * WAVE SEVEN, row Q: THE VENUE'S FAQ OPENER. /faq speaks as the venue now.
 * FAQ_INTRO above stays the TOWELI room's own, and HomePage's room FAQ still
 * reads it, so rewriting that one in place would have changed the room's voice.
 */
export const VENUE_FAQ_INTRO = {
  headline: 'Frequently asked questions',
  subheading: 'The venue, in short answers.',
} as const;

// ═══════════════════════════════════════════════════════════════
// Towelie one-liners — rotate randomly in confirm modals and
// empty states. Accessible, dismissable, never blocking.
// ═══════════════════════════════════════════════════════════════

export const TOWELIE_QUOTES = [
  "Don't forget to bring a towel.",
  "Wanna get high? Oh wait, wrong farm. Wanna get yield?",
  "You ever stake your TOWELI... on weed?",
  "I have no idea what's going on.",
  "I'm just a towel, but these rewards look real.",
  "Remember: always bring a towel. And your LP tokens.",
  "This farm has receipts. I'm pretty sure.",
] as const;

export function randomToweliQuote(): string {
  const i = Math.floor(Math.random() * TOWELIE_QUOTES.length);
  return TOWELIE_QUOTES[i]!;
}

// ═══════════════════════════════════════════════════════════════
// Error flavor — make reverts feel in-voice.
// Use sparingly; technical errors should stay technical.
// ═══════════════════════════════════════════════════════════════

export const ERROR_COPY = {
  insufficientBalance: "You're short, buddy.",
  walletNotConnected:  'Gotta connect a wallet to farm here.',
  txRejected:          "Changed your mind. That's fine — the farm'll still be here.",
  networkError:        "The barn's Wi-Fi is acting up. Try again.",
} as const;

// ═══════════════════════════════════════════════════════════════
// Pool labels — reskin generic pool names with farm flavor.
// Keys match pool IDs; values are the display strings.
// ═══════════════════════════════════════════════════════════════

export const POOL_FLAVOR: Record<string, string> = {
  'TOWELI':           'The Weed Whacker',       // Single-token staking
  'TOWELI-WETH-LP':   'The Integrity Crop',     // LP pair
  'TOWELI-USDC-LP':   "Randy's Cash Crop",      // Stable pair
  'JBAC':             'Jungle Boost',           // NFT boost
};

export function poolFlavorLabel(poolId: string, fallback: string): string {
  return POOL_FLAVOR[poolId] ?? fallback;
}

/**
 * THE HOME /swap CARD'S COPY. It lives here, and not beside the grid that
 * renders it, for the reason `react-refresh/only-export-components` gives: a
 * page module may export components and nothing else. Same move `farmCardDesc`/`farmCardStat` made for the card
 * sitting next to it (lib/lpEmissions.ts, pinned by trustCopyHonesty.test.ts).
 *
 * 2026-09-12: this read "Trade ETH ↔ TOWELI via Uniswap V2 with custom slippage
 * controls." over `stat: 'Uniswap V2'`, and both UNDERSTATED the surface the card
 * links to. useSwapQuote races NINE sources for every quote — the venue's own
 * pool (the 'tegridy' route, executed through SwapFeeRouter and printed as
 * "Venue DEX" on the route line), Uniswap V2, and the seven aggregators in
 * AGGREGATOR_NAMES — and takes the best. Naming only Uniswap V2 left the venue's
 * OWN DEX out of the description of the venue's own swap surface, and pinned a
 * whole token list to a single pair.
 *
 * ⚠️ THE TOWELI MENTION IS NOT THE BUG, and deleting it would be a different
 * one. This grid renders behind `IS_TOWELI_ARRIVAL && !bungalowIdentity` — it is
 * TOWELI's own bungalow, where the classic stack is his furniture and is true
 * (WAVE SEVEN element D below, and the /farm card beside this one says "Stake
 * TOWELI to earn now" deliberately). What is corrected here is the understatement,
 * not the ticker.
 *
 * `label` stays 'Ethereum' because that one was already RIGHT, and was checked
 * rather than assumed: CHAIN_ID is 1 and the aggregator leg short-circuits unless
 * the wallet is on SUPPORTED_CHAIN_ID === 1, so this surface is mainnet-only. The
 * venue's second chain is the /solana card below, which carries its own label.
 */
export const HOME_SWAP_CARD = {
  desc: 'Swap TOWELI or any listed token on the venue DEX, Uniswap V2, or the routed aggregators — best quote wins, with custom slippage controls.',
  stat: 'Best route',
  label: 'Ethereum',
} as const;
