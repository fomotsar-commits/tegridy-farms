/**
 * Centralized "why this matters" copy for every feature surface in the app.
 *
 * Each entry follows the user-feedback shape from 2026-05-16:
 *   • A short title.
 *   • `forYou` — why the user personally benefits (1-2 sentences).
 *   • `forCrypto` — why the broader network / ecosystem benefits (1-2
 *     sentences). This is the "net positive to crypto" angle the user
 *     asked us to surface everywhere.
 *
 * Frame: confident, plain English, jargon-as-light-as-possible. Treat
 * the reader as smart but not a DeFi PhD.
 *
 * KEEP this file the only source of "why" copy — auditing reads each
 * entry once instead of greping JSX across a hundred components.
 */

export type FeatureKey =
  // Trade
  | 'swap'
  | 'liquidity'
  // Farm
  | 'stake'
  | 'lpFarm'
  | 'restake'
  // NFT Finance
  | 'lending'
  | 'nftLending'
  | 'nftAmm'
  | 'launchpad'
  // Community / governance
  | 'gaugeVote'
  | 'bribes'
  | 'grants'
  | 'bounties'
  // Misc
  | 'premium'
  | 'referral';

export type FeatureRationale = {
  title: string;
  /** Why the user personally benefits. */
  forYou: string;
  /** Why the broader crypto ecosystem benefits. */
  forCrypto: string;
};

export const RATIONALE: Record<FeatureKey, FeatureRationale> = {
  // ─── Trade ─────────────────────────────────────────────────────
  swap: {
    title: 'Why swapping on-chain matters',
    forYou:
      "You hold your tokens the entire time — no exchange custody, no withdrawal limits, no KYC. The trade settles in one transaction and the assets land in your wallet.",
    forCrypto:
      "Every on-chain swap deepens the public order book and adds price discovery anyone can verify. Centralised exchanges are opaque; transparent venues like this one are how crypto stays credibly neutral.",
  },
  liquidity: {
    title: 'Why providing liquidity is good for everyone',
    forYou:
      "When you pair two tokens into the pool, you collect a slice of the fee every time someone trades through it — passive yield directly from real volume. You can pull the pair back out any time.",
    forCrypto:
      "Markets only work if someone is willing to buy and sell at fair prices. LPs are that someone. Without you, trading widens, slippage spikes, and traders bail for centralised venues — the opposite of what crypto is trying to be.",
  },

  // ─── Farm ──────────────────────────────────────────────────────
  stake: {
    title: 'Why locking your tokens is worth it',
    forYou:
      "Longer lock + JBAC NFT = up to 4.5× the share of every fee the protocol earns. You're trading time for ETH yield — paid out in ETH, not inflationary token emissions.",
    forCrypto:
      "Locked supply means fewer hands ready to sell into every pump. Long-term holders absorb volatility, smooth out price action, and align the protocol with people who actually want it to last.",
  },
  lpFarm: {
    title: 'Why LP farming makes both sides happy',
    forYou:
      "On top of the pool's natural fee yield, the protocol layers an extra TOWELI reward on LPs — so you get paid twice for the same liquidity.",
    forCrypto:
      "Boosted LP rewards are how a young protocol bootstraps a deep market without relying on a single market-maker. Distributed liquidity = censorship-resistant trading for everyone.",
  },
  restake: {
    title: 'Why auto-compounding pays off',
    forYou:
      "Instead of manually claiming and re-staking every week, the restaker rolls your rewards back into your lock automatically. Same yield, zero clicks, fewer gas spends.",
    forCrypto:
      "Compounding without unstaking keeps capital productive on-chain. The alternative — withdraw, claim, swap, re-stake — burns gas and creates artificial sell pressure on every cycle.",
  },

  // ─── NFT Finance ───────────────────────────────────────────────
  lending: {
    title: 'Why an on-chain money market matters',
    forYou:
      "Borrow against your TOWELI or LP tokens without selling them. Rates are set by supply and demand — no bank, no underwriter, no closing fees.",
    forCrypto:
      "Permissionless lending lets anyone with collateral access dollars without trusting a counterparty. It's the financial primitive crypto exists to deliver — and the protocol earns a transparent spread for routing it.",
  },
  nftLending: {
    title: 'Why P2P NFT loans beat selling the floor',
    forYou:
      "Use your NFT as collateral for an ETH loan instead of dumping it at the floor. Repay before the deadline and you keep the NFT. Don't repay, and the lender gets a discounted entry — both sides win on terms they agreed to.",
    forCrypto:
      "P2P loans unlock the liquidity trapped in NFT bags without forcing distressed sales. Healthier holders = healthier collections = a more durable on-chain art economy.",
  },
  nftAmm: {
    title: 'Why pooled NFT trading is a step forward',
    forYou:
      "Instant buys and sells against an automated market — no waiting for a buyer, no royalty haircut you didn't agree to, predictable prices because the curve is public.",
    forCrypto:
      "Order-book NFT marketplaces are slow and gameable. AMM pools turn NFTs into a continuously-tradable asset class and pay liquidity providers a real fee for showing up.",
  },
  launchpad: {
    title: 'Why fair launches matter',
    forYou:
      "Deploy a collection in one transaction with built-in allowlists, dutch auctions, on-chain royalties, and a refund path if the sale undersubscribes. No back-room presale, no team-allocation foot-gun.",
    forCrypto:
      "Most token launches concentrate supply with insiders before retail can even click buy. A public, on-chain launchpad with refund-on-cancel is how memecoins grow without rugging the people who showed up early.",
  },

  // ─── Community / governance ───────────────────────────────────
  gaugeVote: {
    title: 'Why your vote moves emissions',
    forYou:
      "Your lock-weighted vote directs where new TOWELI rewards go this epoch — which pool you're in, which collection you hold, where the boost lands. You're literally shaping the protocol's incentive map.",
    forCrypto:
      "Token-holder-directed emissions are the cleanest way for a protocol to react to changing market conditions without a centralised committee. The chain becomes the steering wheel.",
  },
  bribes: {
    title: 'Why bribing voters is a feature, not a bug',
    forYou:
      "Anyone who wants more emissions on their pool can deposit a bribe; you, the voter, get paid in their token for sending the emissions their way. It's the most honest market for governance attention there is.",
    forCrypto:
      "Public, on-chain bribes turn the implicit pay-to-play of governance lobbying into a transparent, auditable market. The bag is the same; the rules are now legible.",
  },
  grants: {
    title: 'Why on-chain grants outpace centralized foundations',
    forYou:
      "Propose a project, get veTOWELI-weighted votes, claim the grant in tranches as you hit milestones. No grant officer to ghost you, no quarterly application window.",
    forCrypto:
      "Decentralised funding routes capital to whoever the network believes in — not to whoever knew the right person. The treasury becomes a public good, not a private slush fund.",
  },
  bounties: {
    title: 'Why community-graded bounties beat moderation queues',
    forYou:
      "Post a bounty for the meme / explainer / fix you want, let the community vote on submissions, the winner gets paid in TOWELI automatically. No middleman taste-policing.",
    forCrypto:
      "Bottom-up rewarded content is how a culture stays alive. The chain settles the money so the conversation can stay weird.",
  },

  // ─── Misc ─────────────────────────────────────────────────────
  premium: {
    title: 'Why pass-gated premium is fair',
    forYou:
      "Pay once (or hold the NFT) and get the upgraded feature set — analytics, alerts, deep dashboards. No recurring credit card subscription, no surprise renewals.",
    forCrypto:
      "Pay-once-on-chain access aligns the user with the protocol on day one and removes the recurring-revenue rent-seeking that legacy SaaS depends on.",
  },
  referral: {
    title: 'Why referrals are split with you',
    forYou:
      "Anyone who swaps through your referral link gives you a slice of the protocol fee on their trades — forever, paid in ETH. No payout threshold, no fine print.",
    forCrypto:
      "Direct-to-wallet referral payouts are how networks should grow: the people doing the recruiting get rewarded by code, not by promises a centralised platform can rescind.",
  },
};

/** Convenience accessor with type-safety on the key. */
export function rationale(key: FeatureKey): FeatureRationale {
  return RATIONALE[key];
}
