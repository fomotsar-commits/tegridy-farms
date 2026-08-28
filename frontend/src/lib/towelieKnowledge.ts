/**
 * Towelie's Q&A bank. Plain keyword-overlap matching — no LLM, no API.
 * If your question doesn't hit a keyword set, you get the fallback.
 *
 * Entry shape:
 *   keywords: tokens that, when present in the user's question, count
 *             toward this entry's score. Lowercase, no punctuation.
 *   answer:   what Towelie says back. Keep in voice (slacker towel).
 *   priority: optional tiebreaker bump for ambiguous questions.
 */

export interface KnowledgeEntry {
  keywords: string[];
  answer: string;
  priority?: number;
}

export const KNOWLEDGE_BASE: KnowledgeEntry[] = [
  // ── Core protocol ────────────────────────────────────────────
  {
    // AUDIT R073: prior copy said "100% of swap fees flow to stakers" — wrong.
    // TegridyPair splits the 0.3% swap fee into 6 LP shares: 5/6 stay with LPs
    // (rebasing K-invariant earnings) and 1/6 mints protocol-owned LP that gets
    // routed to the RevenueDistributor for staker ETH yield.
    keywords: ['toweli', 'token'],
    answer: "TOWELI is the farm's token. 1B fixed supply, no mint function. Swap fees split 5/6 to LPs, 1/6 to the protocol → stakers as ETH — that pipeline is on-chain and turns on with the native pool. That's the whole pitch.",
  },
  {
    // HONESTY PASS 2026-06-11: rewards today are TOWELI emissions from a fixed
    // launch seed; the ETH swap-fee share is deployed but has distributed 0 ETH
    // until the native pool is seeded. Don't claim "real yield" in present tense.
    keywords: ['tegridy', 'farms', 'protocol', 'project'],
    answer: "Tegridy Farms is a yield farm where you stake TOWELI. Rewards today are TOWELI emissions from a fixed launch seed; the ETH swap-fee share is deployed on-chain and kicks in when the native pool goes live. Supply's fixed — no printer.",
  },
  {
    keywords: ['supply', 'total', 'circulating', 'mint'],
    answer: "TOWELI total supply is 1B, fixed forever. No mint function. /tokenomics has the full breakdown.",
  },
  {
    keywords: ['fdv', 'marketcap', 'mcap', 'valuation'],
    answer: "FDV = price × 1B supply. Live number on /tokenomics. Market cap is similar since most supply is circulating.",
  },
  {
    // HONESTY PASS 2026-06-11: supply is fixed (true), but current rewards ARE
    // emissions from a one-time 6.4M seed — ETH fee rewards start with the pool.
    keywords: ['emission', 'inflation', 'distribution'],
    answer: "Supply is fixed — no new TOWELI, ever. Staking rewards today come from a one-time 6.4M emissions seed funded at launch; ETH swap-fee rewards switch on when the native pool goes live. /tokenomics shows the breakdown.",
  },
  {
    // HONESTY PASS 2026-06-11: treasury Safe is freshly rebuilt post-relaunch and
    // still being funded; grants/governance spend-votes are not deployed yet.
    keywords: ['treasury', 'dao', 'fund'],
    answer: "Community treasury is a Safe multisig — rebuilt fresh at the relaunch, so it's still filling up. Protocol fee flows route to it on-chain as revenue ramps. Watch it at /treasury; every wei's on Etherscan.",
  },

  // ── Staking ──────────────────────────────────────────────────
  {
    keywords: ['stake', 'staking', 'farm'],
    answer: "Go to /farm, type how much TOWELI to lock, pick a duration (longer = bigger boost), hit Stake. Tegridy demands it.",
    priority: 2,
  },
  {
    keywords: ['lock', 'duration', 'period'],
    answer: "Lock from 7 days to 4 years. 4 years = 4× boost on rewards. Math checks out.",
  },
  {
    // AUDIT R073: clarified — boost floor is 0.4× (not 1×), max is 4×, and
    // a JBAC NFT applies a flat +0.5× as a binary attribute (not stackable).
    keywords: ['boost', 'multiplier'],
    answer: "Lock longer, earn more. Boost ranges 0.4× (sub-week) to 4.0× (4-year max). A JBAC NFT adds a flat +0.5× boost — binary, only one applies, no stacking.",
  },
  {
    // AUDIT R073: prior copy said the early-withdrawal penalty "scales with
    // distance from unlock". Actual on-chain constant is a flat 25% on the
    // staked principal regardless of how much lock time is left.
    keywords: ['unstake', 'withdraw', 'exit'],
    answer: "Withdraw early = flat 25% penalty on your stake, no matter how close you are to unlock. The penalty goes to the protocol treasury — not to other stakers. Wait it out for the full payout.",
  },
  {
    keywords: ['extend', 'top', 'increase', 'add', 'position'],
    answer: "You can extend lock or add to your stake from /farm. New deposits inherit your current unlock date.",
  },
  {
    keywords: ['claim', 'rewards', 'harvest'],
    answer: "Dashboard → Claim Rewards button. Pulls all pending TOWELI/ETH to your wallet. One tx, done.",
    priority: 2,
  },
  {
    keywords: ['apr', 'apy', 'yield', 'returns', 'earn'],
    answer: "APR depends on TVL + your lock duration + boost. Check the Farm page for the live rate. Not financial advice — I'm a towel.",
  },
  {
    keywords: ['compound', 'reinvest', 'restake'],
    answer: "Claim, then re-stake. No auto-compound vault yet — but it's on the radar. Watch /changelog.",
  },
  {
    keywords: ['math', 'calculation', 'formula'],
    // AUDIT COPY-FIX: the prior "Boost = 1 + 3 × (lock/max)" implied a 1x–4x
    // range and a linear floor of 1x at 0 lock. Actual on-chain constants:
    // MIN_BOOST_BPS = 4000 (0.4x, anything below MIN_LOCK_DURATION),
    // MAX_BOOST_BPS = 40000 (4.0x, at MAX_LOCK_DURATION = 4 years), with
    // linear interpolation between MIN_LOCK and MAX_LOCK. See
    // lib/boostCalculations.ts for the authoritative math.
    answer: "Reward = (your_stake × boost) / (total_stake × avg_boost) × pool_emissions. Boost = 0.4 + 3.6 × (lock_remaining / max_lock), clamped to 0.4x–4.0x between 7-day and 4-year locks.",
  },

  // ── Swap / trade ─────────────────────────────────────────────
  {
    keywords: ['swap', 'trade', 'buy', 'sell'],
    answer: "Trade page → Swap tab. Pick tokens, amounts, slippage. Hit Swap. Wallet confirms. Done.",
  },
  {
    keywords: ['where', 'buy', 'purchase'],
    answer: "Cheapest in-app at /swap. Routes through Uniswap V2. CEX listings might come later — for now, DEX only.",
  },
  {
    keywords: ['slippage', 'tolerance'],
    answer: "Slippage = max price drift you'll accept. 0.5% is normal. 5%+ means low liquidity — be careful, frontrunners eat that.",
  },
  {
    keywords: ['impact', 'price', 'movement'],
    answer: "Price impact = how much your trade moves the pool price. Big trade vs thin pool = big impact. Split into chunks if it's >3%.",
  },
  {
    keywords: ['dca', 'dollar', 'cost', 'average', 'recurring'],
    answer: "Trade page → DCA tab. Schedule recurring buys so you don't have to time the market. Set it, forget it.",
  },
  {
    keywords: ['limit', 'order', 'target', 'price'],
    answer: "Trade page → Limit tab. Set a target price; the order fills when the market hits it. No babysitting.",
  },
  {
    keywords: ['approve', 'approval', 'allowance', 'spend'],
    answer: "First swap of a token needs an approval tx (lets the contract pull tokens from your wallet). One-time per token. Then swap.",
  },
  {
    // F200/T3 (2026-06-13): reconcile with the swap UI's "(incl. 0.5% fee)"
    // disclosure. Two distinct fees: the SwapFeeRouter PROTOCOL fee (0.5% on the
    // native front-door route, routed to TOWELI stakers as ETH) and the standard
    // 0.3% AMM pair fee that LPs earn via K-growth. Earlier copy named only the
    // 0.3% and called it "the swap fee", which understated what a native-route
    // trader actually pays and contradicted the swap screen.
    keywords: ['fee', 'swap', 'cost', 'percent'],
    answer: "Two fees. Swapping through our native front-door adds a 0.5% protocol fee that flows to TOWELI stakers as ETH (it kicks in once the native pool is trading). Underneath that, the AMM pair charges the standard 0.3% that LPs earn via K-growth. The swap screen always shows the protocol fee on the route it picks.",
  },

  // ── Liquidity ───────────────────────────────────────────────
  {
    keywords: ['liquidity', 'lp', 'provide', 'pool'],
    answer: "Trade page → Liquidity tab. Add equal value of both tokens, earn fees per swap. Watch for impermanent loss.",
  },
  {
    keywords: ['impermanent', 'loss', 'il'],
    answer: "Impermanent loss = your LP underperforms holding when one side moves vs. the other. Fees usually offset it. Usually.",
  },
  {
    keywords: ['remove', 'liquidity', 'pull', 'lp'],
    answer: "Trade → Liquidity → Remove tab. Pick how much LP to burn, get both tokens back at the current ratio.",
  },

  // ── Token launches (the Tegridy Curve) ──────────────────────
  {
    // ADDED 2026-08-28: the flagship launch surface had NO entry — a user
    // typing "curve" or "launch" got the NFT-AMM answer or silence. priority
    // bump wins keyword ties against older entries.
    priority: 1,
    keywords: ['launch', 'launcher', 'curve', 'tegridy', 'create', 'token', 'memecoin', 'graduate'],
    answer: "The Tegridy Curve is our own bonding-curve launcher, live on Ethereum, Base and Robinhood Chain at /eth-curve. One signature launches a token; trades pay a 1% fee split 40% to the creator, 25% treasury, 35% protocol; hit the raise target and it graduates into a Tegridy pool with the LP burned — nobody can pull it. Browse live launches right on the page, or open any token's own page at /eth-curve/<address>.",
  },

  // ── NFTs ─────────────────────────────────────────────────────
  {
    // AUDIT R073: prior copy said "stack them for stacked boost" — wrong.
    // The on-chain attribute is binary: hasJbacBoost is true or false, applies
    // a single +0.5× regardless of how many NFTs you hold.
    keywords: ['jbac', 'nft'],
    answer: "Holding any JBAC NFT adds a flat +0.5× boost on top of your lock boost. Binary attribute — extra NFTs don't stack. Boost floor is 0.4× either way.",
  },
  {
    // HONESTY PASS 2026-08-28: this trio (lending / AMM / launchpad) said "not
    // redeployed since the relaunch" for contracts that have been LIVE since
    // 2026-07-21 (constants.ts:97/101/114) — /faq said "live" while the towel
    // said "waiting". The assistant is a surface like any other: keep it in
    // sync with constants.ts in BOTH directions.
    keywords: ['nft', 'lending', 'borrow', 'collateral'],
    answer: "NFT Finance → NFT Lending, live on mainnet. Use JBAC, Nakamigos, or GNSS as collateral to borrow ETH — peer-to-peer terms, no oracles needed. Internally reviewed, no third-party audit yet.",
  },
  {
    keywords: ['liquidation', 'liquidate', 'default'],
    answer: "If you don't repay your NFT loan by the deadline, the lender keeps the NFT. No partial liquidations — it's all-or-repay.",
  },
  {
    keywords: ['nakamigos', 'naka'],
    answer: "Nakamigos has its own marketplace at /nakamigos — full trading floor, listings, offers, the works.",
  },
  {
    keywords: ['gnss', 'collection'],
    answer: "GNSS is one of the supported NFT collections — used for boosts and as collateral in NFT Lending.",
  },
  {
    // 2026-08-28: 'curve'/'bonding' moved OFF this entry — those words now
    // belong to the live Tegridy Curve launcher entry below; a user typing
    // "curve" was getting an NFT answer about the flagship's name.
    keywords: ['amm', 'nft', 'pool', 'swap'],
    answer: "NFT AMM lets you trade NFTs against on-chain pools, live on mainnet — add NFTs as inventory, earn fees on every swap.",
  },
  {
    keywords: ['launchpad'],
    answer: "Launchpad V2 is live: project owners create gated NFT collections with a wizard under NFT Finance → Launchpad. Internally reviewed, no third-party audit yet.",
  },

  // ── Governance ──────────────────────────────────────────────
  // HONESTY PASS 2026-08-28: the 06-11 framing ("not deployed, zeroed
  // addresses") became half-false — all four governance contracts ARE deployed
  // on mainnet (the 2026-07-16 batch, unpaused) but their addresses are still
  // zeroed in THIS app, so the pages stay gated. /risks says exactly that;
  // the towel was the fourth surface still telling the 06-11 story (the
  // 08-13 three-surfaces fix, 428abc5f, missed it). Deployed-but-not-wired
  // is the true state — say that.
  {
    keywords: ['vote', 'voting', 'governance', 'gauge'],
    answer: "Gauge voting's deployed on mainnet but not wired into this app yet — the addresses here are still zeroed, so /community stays gated while the wiring and checks finish. The design: your locked TOWELI × boost directs emissions to pools. Meanwhile, stake and watch /changelog.",
  },
  {
    keywords: ['weight', 'power', 'vote'],
    answer: "When gauge voting is wired up here, vote weight = locked TOWELI × current boost. Lock more or longer → more weight. Locking now still builds your future weight.",
  },
  {
    keywords: ['epoch', 'cycle', 'period'],
    answer: "Voting epochs run 7 days once gauge voting is wired into the app — votes cast one epoch direct emissions the next. The contract's on mainnet; this app hasn't connected to it yet, so no clock's ticking here.",
  },
  {
    keywords: ['bribes', 'bribe', 'incentive', 'cartman'],
    answer: "Cartman's Market — deposit tokens to bribe voters into directing emissions your way. Kinda shady. Deployed on mainnet, not wired into this app yet — it lands on /community alongside gauge voting.",
  },
  {
    keywords: ['bounty', 'bounties', 'task'],
    answer: "MemeBountyBoard is deployed on mainnet but not wired into this app yet. When it connects: post a task with a reward, contributors complete it for the bounty. Both sides win.",
  },
  {
    keywords: ['grants', 'proposal', 'fund'],
    answer: "Community Grants is deployed on mainnet, not wired into this app yet. When it connects: propose a project, locked-TOWELI voters fund it. Tegridy preserved by votes.",
  },

  // ── Wallet / network ────────────────────────────────────────
  {
    keywords: ['wallet', 'connect'],
    answer: "Top right → Connect Wallet. MetaMask, Rainbow, Coinbase, WalletConnect — anything WalletConnect-compatible works.",
  },
  {
    keywords: ['hardware', 'ledger', 'trezor'],
    answer: "Hardware wallets work via MetaMask or Rainbow's hardware-wallet integration. Plug in, connect, sign on the device.",
  },
  // 2026-08-07: the assistant is the surface a confused user asks "what chain is
  // this?" on — and it answered, flatly, Ethereum-only, with no Solana entry anywhere
  // in this file. Asking about Solana, SOL or Jupiter fell through to a generic reply
  // on a site that has a live Solana swap. Fixed here, plus the three new entries
  // below so the keywords actually match what someone would type.
  {
    // HONESTY PASS 2026-08-28: "two chains" and "its own launch rail" were both
    // false — the Tegridy Curve is live on Ethereum, Base AND Robinhood since
    // 08-25, and the Solana launch rail was retired 08-23 with nothing
    // launchable there. Four chains total, one of them swap-only.
    keywords: ['network', 'chain', 'switch', 'mainnet', 'chains'],
    answer: "Four chains. TOWELI staking, farming and the launchers run on Ethereum mainnet; the Tegridy Curve also launches on Base and Robinhood Chain — wrong chain and your wallet shows a 'Switch' button, hit it. Solana is swap-only: /solana routes SPL trades through Jupiter (no Solana launches right now). The token scanner reads EVM and Solana both.",
  },
  {
    keywords: ['solana', 'sol', 'phantom', 'spl'],
    answer: "Solana's partly live. /solana swaps SPL tokens through Jupiter with limit orders and SOL liquid-staking — that works today. The Solana LAUNCH rail does not: we retired the third-party bonding curve we used to run on, and our own curve isn't deployed yet, so you can't launch a Solana token here right now. TOWELI itself is never deployed on Solana — that's deliberate, Solana is a separate rail, not a second home for the token.",
  },
  {
    keywords: ['jupiter', 'jup', 'swap solana', 'solana swap'],
    answer: "Jupiter is the router behind /solana — it shops your trade across Solana's DEXes for the best price. Our platform fee is shown before you sign, every time.",
  },
  {
    keywords: ['meteora', 'dbc', 'bonding curve', 'solana launch'],
    // RETIRED 2026-08-23. This used to say the rail "runs on Meteora's Dynamic Bonding
    // Curve — their audited program, not ours". True at the time, and live to users.
    // The keywords stay so anyone who asks about Meteora gets the retirement rather
    // than silence, which would read as the old answer still being right.
    answer: "We don't run on Meteora any more. That rail graduated into a pool we didn't own, so we retired it — we only want launchers that graduate into our own venue. The replacement exists and is LIVE on the EVM side: the Tegridy Curve at /eth-curve launches on Ethereum, Base and Robinhood, graduates into our own AMM and burns the LP outright. The SOLANA version is not live — those programs were closed and need fresh addresses — so nothing can be launched on Solana here for now.",
  },
  {
    // HONESTY PASS 2026-08-28: "No L2 yet" went false on 2026-08-25 — the
    // Tegridy Curve launcher is live on Base (OP-stack L2) and Robinhood Chain
    // (Arbitrum Orbit L2). Keep this in sync with lib/chains/registry.ts.
    keywords: ['l2', 'layer', 'rollup', 'arbitrum', 'optimism', 'base', 'robinhood'],
    answer: "Two L2s, live: the Tegridy Curve launches tokens on Base and on Robinhood Chain — /eth-curve follows whichever chain your wallet's on. The core protocol (staking, farming, swap) stays on Ethereum mainnet, and Solana handles swap-only.",
  },
  {
    keywords: ['gas', 'expensive', 'cost'],
    answer: "Gas is whatever Ethereum's charging that minute. Use Etherscan's gas tracker to time txs when fees are low.",
  },
  {
    keywords: ['stuck', 'pending', 'tx', 'transaction', 'failed'],
    answer: "Pending forever? Speed up or cancel from MetaMask's activity tab. Failed? Wallet probably underfunded gas — bump it.",
  },

  // ── Tx history / accounting ────────────────────────────────
  {
    // 2026-08-28: "export coming soon" promised a feature with no owner while
    // /tax already ships the actual export surface. Point at what exists.
    keywords: ['history', 'transactions', 'past', 'activity'],
    answer: "Dashboard → History tab (or just /history) for your full tx log, filterable by type. Need an export? /tax builds the downloadable report.",
  },
  {
    keywords: ['tax', 'taxes', 'accounting', 'cost', 'basis'],
    answer: "Pull your /history page or use Etherscan to export tx data. I'm a towel — talk to a tax pro for the rest.",
  },
  {
    // UPDATED 2026-07-19: source-verification is now COMPLETE for all 8 core
    // contracts (TOWELI, Staking, Factory, Router, RevenueDistributor,
    // SwapFeeRouter, POLAccumulator, ReferralSplitter). The old "rolling out
    // contract by contract" hedge was accurate on 2026-06-11 and is now false —
    // it understated us on exactly the question a skeptic asks. /contracts shows
    // a LIVE per-address badge read from Etherscan, so this is checkable, not a
    // claim. Keep this answer in sync with reality in both directions.
    keywords: ['etherscan', 'verify', 'contract', 'address'],
    answer: "All 8 core contracts are source-verified on Etherscan — you can read the actual Solidity, not just bytecode. Every address is at /contracts with a live verification badge (checked against Etherscan, not hardcoded), plus the full code on GitHub and public ABIs.",
  },

  // ── Premium / referrals / scoring ──────────────────────────
  {
    // HONESTY PASS 2026-06-11: there is NO paid third-party audit and the bug
    // bounty has no funded pool — state the real (checkable) security record.
    keywords: ['safe', 'security', 'audit', 'rug', 'risk'],
    answer: "Straight answer: no paid outside audit yet. Security record = internal multi-agent audit waves, Slither on every CI run, 1,500+ tests. Token's fixed-supply with no mint or pause, and the sensitive admin changes — treasury, fees, oracle floors — wait out a 24–48h timelock. Emergency pause and a few operational setters are immediate, so it's not every change. /security has the artifacts, /risks has the blunt version.",
  },
  {
    keywords: ['risks'],
    answer: "Smart-contract risk, market risk, IL risk for LPs. /risks has the honest version. Read it.",
  },
  {
    // HONESTY PASS 2026-07-24: PremiumAccess went live 2026-07-21. Fee is in
    // TOWELI (read from the contract — never hardcode it here, it is timelock-
    // mutable), and there is no points multiplier or fee discount.
    // HONESTY PASS 2026-08-28: "holders earn ETH from swap fees" was the exact
    // unconditioned history-claim the #199/#215/#258 passes banned — the
    // distributor has paid 0 ETH to date (premiumBenefits.ts conditions the
    // same sentence on a live read). A static answer can't read the chain, so
    // it states the DESIGN and the current honest status.
    keywords: ['premium', 'gold', 'card', 'subscription'],
    answer: "Randy's Gold Card is live at /premium. You pay in TOWELI — the monthly fee is read straight off the contract and shown on the page. Holders are in line for ETH from protocol swap fees like every staker; none has been distributed yet (the page shows the live number). JBAC holders get it free for life. Internally reviewed, no third-party audit yet.",
  },
  {
    // AUDIT R073: prior copy said "no refund mid-period" — wrong. PremiumAccess
    // implements pull-payment pro-rata refunds: cancel mid-window and the
    // unspent fraction is credited as a pull-pattern claim you withdraw.
    keywords: ['cancel', 'unsubscribe', 'refund'],
    answer: "Cancel from /premium → Manage. You get a pro-rata refund on the unused portion as a pull-payment credit — claim it from the same screen after you cancel.",
  },
  {
    keywords: ['leaderboard', 'points', 'rank', 'ranking'],
    answer: "Earn points for staking, claiming, voting, etc. Top of /leaderboard gets bragging rights and seasonal rewards.",
  },
  {
    // HONESTY PASS 2026-08-28: "you both earn bonus" was the joiner-bonus
    // overclaim /referrals and the changelog already record as fixed — the
    // splitter credits the REFERRER only (ReferralSplitter.sol). This was the
    // last surface still promising the friend a cut.
    keywords: ['referral', 'invite', 'friend', 'code'],
    answer: "Dashboard has your referral link. When someone you refer trades, the referral share of their fee is credited to YOU — the joiner gets no discount or bonus, and /referrals says so up front. Tegridy through community.",
  },
  {
    keywords: ['tegridy', 'score'],
    answer: "Tegridy Score measures commitment: stake size, lock length, NFT boost, vote activity. Higher = better perks.",
  },

  // ── Misc ────────────────────────────────────────────────────
  {
    keywords: ['mobile', 'phone', 'pwa', 'install', 'ios', 'android'],
    answer: "Works on mobile browsers. Add to home screen for an app-like install. Wallet needs WalletConnect or Coinbase deeplink.",
  },
  {
    keywords: ['lore', 'story'],
    answer: "/lore has the whole saga — how Tegridy was lost, found, lost again, then locked down on-chain.",
  },
  {
    keywords: ['changelog', 'updates', 'shipped', 'recent'],
    answer: "/changelog has every shipped feature with dates. New stuff on top.",
  },
  {
    keywords: ['roadmap', 'upcoming', 'future', 'next'],
    answer: "Big swings get voted on at /community once governance deploys. Until then, /changelog tracks everything that actually ships.",
  },
  {
    // HONESTY PASS 2026-06-11: contracts are NOT multisig-governed yet — the
    // multisig handoff (acceptOwnership) is in progress; timelock IS live.
    keywords: ['team', 'devs', 'who', 'built'],
    answer: "Team's pseudonymous. Sensitive admin changes sit behind a 24–48h timelock — emergency pause and some operational setters don't — and the multisig handoff is in progress. /security has the setup, /contracts the code.",
  },
  {
    keywords: ['contact', 'support', 'help', 'discord'],
    answer: "Community channels link from /community footer. For bugs use the responsible-disclosure channel on /security. For tax stuff, talk to a pro.",
  },

  // ── South Park easter eggs ─────────────────────────────────
  {
    keywords: ['randy', 'marsh'],
    answer: "Randy. He's the patron saint of Tegridy. Inspired the Gold Card. Don't ask too many questions.",
  },
  {
    keywords: ['stan', 'kyle', 'cartman', 'kenny', 'south', 'park'],
    answer: "We share aesthetics with a certain mountain town. The references are intentional. Don't @ us.",
  },

  // ── Towelie meta ────────────────────────────────────────────
  {
    keywords: ['towelie', 'towel', 'who'],
    answer: "I'm Towelie. I'm just a towel, but I help people farm here. Don't forget to bring a towel.",
  },
  {
    keywords: ['help', 'menu', 'commands'],
    answer: "Ask me anything about staking, swap, NFTs, voting, gas, security, premium. If I'm stumped, /faq has more.",
  },
  {
    keywords: ['hide', 'disable', 'shut', 'silent', 'mute'],
    answer: "Cool, click 'Don't show again' under any bubble. I'll respect it. No hard feelings, towel's gotta towel.",
  },
  {
    keywords: ['high', 'weed', 'stoned'],
    answer: "Yeah man. Wanna get high? Oh wait, this is a yield farm. Wanna get yield?",
  },
];

const FALLBACK_ANSWERS = [
  "Are you high? Try the /faq page — they probably know.",
  "Are you high? I'm not following. Hit the /faq, the answer's in there.",
  "Are you high? That one's beyond me. /faq has the real docs.",
];

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'do', 'does', 'for',
  'have', 'how', 'i', 'in', 'is', 'it', 'its', 'me', 'my', 'of', 'on',
  'or', 'so', 'that', 'the', 'this', 'to', 'was', 'what', 'where', 'why',
  'with', 'you', 'your', 'can', 'could', 'should', 'would', 'will',
]);

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Find the best-matching answer for a free-text question. Returns null if
 * no entry scores above the minimum threshold (caller should use a fallback).
 *
 * Scoring: each entry's score = count of question tokens that appear in its
 * keyword set, plus the entry's optional priority bump. Threshold is 1 hit.
 */
export function answerQuestion(question: string): string {
  const tokens = tokenize(question);
  if (tokens.length === 0) {
    return "Ask me something specific — staking, swap, NFTs, gas, whatever.";
  }
  let bestScore = 0;
  let best: KnowledgeEntry | null = null;
  for (const entry of KNOWLEDGE_BASE) {
    const set = new Set(entry.keywords);
    let score = 0;
    for (const tok of tokens) if (set.has(tok)) score++;
    if (score === 0) continue;
    score += entry.priority ?? 0;
    if (score > bestScore) {
      bestScore = score;
      best = entry;
    }
  }
  if (!best || bestScore < 1) {
    return FALLBACK_ANSWERS[Math.floor(Math.random() * FALLBACK_ANSWERS.length)]!;
  }
  return best.answer;
}
