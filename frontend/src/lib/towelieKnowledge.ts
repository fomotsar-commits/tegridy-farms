/** Towelie's Q&A bank: plain keyword overlap, no LLM, no API; a miss gets the fallback.
 *  keywords: lowercase, no punctuation. Each one found in the question scores, and a
 *            keyword of several words counts when all its words are in the question.
 *  answer:   what Towelie says back, in voice (slacker towel).
 *  priority: optional tiebreaker bump for ambiguous questions. */

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
    answer: "memetics.finance is a yield farm where you stake TOWELI. Rewards today are TOWELI emissions from a fixed launch seed; the ETH swap-fee share is deployed on-chain and kicks in when the native pool goes live. Supply's fixed — no printer.",
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
    answer: "Go to /earn/toweli, type how much TOWELI to lock, pick a duration (longer = bigger boost), hit Stake. The island demands it.",
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
    answer: "You can extend lock or add to your stake from /earn/toweli. New deposits inherit your current unlock date.",
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

  // ── Token launches (the Memetics Curve) ──────────────────────
  {
    // ADDED 2026-08-28: the flagship launch surface had NO entry — a user
    // typing "curve" or "launch" got the NFT-AMM answer or silence. priority
    // bump wins keyword ties against older entries.
    priority: 1,
    keywords: ['launch', 'launcher', 'curve', 'tegridy', 'create', 'token', 'memecoin', 'graduate'],
    answer: "The Memetics Curve is our own bonding-curve launcher, live on Ethereum, Base and Robinhood Chain at /eth-curve. Trades pay a 1% fee split 40% to the creator, 25% treasury, 35% protocol; hit the raise target and it graduates into our own pool with the LP burned — nobody can pull it. Browse live launches right on the page, or open any token's own page at /eth-curve/<address>.",
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
    // belong to the live Memetics Curve launcher entry below; a user typing
    // "curve" was getting an NFT answer about the flagship's name.
    keywords: ['amm', 'nft', 'pool', 'swap'],
    answer: "NFT AMM lets you trade NFTs against on-chain pools, live on mainnet — add NFTs as inventory, earn fees on every swap.",
  },
  {
    keywords: ['launchpad'],
    answer: "Launchpad V2 is live: project owners create gated NFT collections with a wizard under NFT Finance → Launchpad. Internally reviewed, no third-party audit yet.",
  },

  // ── Governance ──────────────────────────────────────────────
  // The four governance contracts are deployed on mainnet (the 2026-07-16 batch,
  // unpaused), but this app still has their addresses zeroed, so the pages stay gated.
  // Answers say deployed but not wired, as /risks does.
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
  // Solana has the Jupiter swap (/solana) and our own curve (/curve-launch), where anyone
  // trades and a maker at Resident or better launches through the heat door. These
  // coins are priced in SOL: never call them island coins or "born in $BAYLA".
  {
    keywords: ['network', 'chain', 'switch', 'mainnet', 'chains'],
    answer: "Four chains. TOWELI staking, farming and the launchers run on Ethereum mainnet; the Memetics Curve also launches on Base and Robinhood Chain — wrong chain and your wallet shows a 'Switch' button, hit it. On Solana, /solana routes SPL trades through Jupiter, and /curve-launch is our own Solana curve: anyone can trade there, and a maker at Resident or better can launch through the memetics.finance gate. The token scanner reads EVM and Solana both.",
  },
  {
    // The bump wins "launch a token on solana" from the EVM launch entry; the phrases win
    // a curve, memecoin or graduation question that names Solana.
    priority: 1,
    keywords: ['solana', 'sol', 'phantom', 'spl', 'solana launch', 'solana token', 'solana curve', 'solana bonding', 'solana memecoin', 'solana graduate'],
    answer: "Solana's live here two ways. /solana swaps SPL tokens through Jupiter, with limit orders and SOL liquid-staking. /curve-launch is our own Solana bonding curve, priced in SOL: anyone can buy and sell a launch there, and a maker at Resident or better (80° of held time on Jungle Bay Island) can launch a new token through the memetics.finance gate, which reads the maker's wallet at create. The program itself accepts any wallet, so check the full token address before you buy. TOWELI itself is never deployed on Solana: that's deliberate, Solana is a separate rail, not a second home for the token.",
  },
  {
    keywords: ['jupiter', 'jup', 'swap solana', 'solana swap'],
    answer: "Jupiter is the router behind /solana — it shops your trade across Solana's DEXes for the best price. Our platform fee is shown before you sign, every time.",
  },
  {
    // The Meteora rail was retired 2026-08-23; anyone asking about it gets that answer.
    keywords: ['meteora', 'dbc', 'bonding curve'],
    answer: "We don't run on Meteora any more. That rail graduated into a pool we didn't own, so we retired it: we only want launchers that graduate into our own venue. Our own curve replaced it, and it graduates into our own AMM and burns the LP outright. The Memetics Curve launches on Ethereum, Base and Robinhood at /eth-curve, and on Solana at /curve-launch, where a maker at Resident or better launches through the memetics.finance gate.",
  },
  {
    // Keep in sync with lib/chains/registry.ts: Base is an OP-stack L2, Robinhood
    // Chain an Arbitrum Orbit L2.
    keywords: ['l2', 'layer', 'rollup', 'arbitrum', 'optimism', 'base', 'robinhood'],
    answer: "Two L2s, live: the Memetics Curve launches tokens on Base and on Robinhood Chain — /eth-curve follows whichever chain your wallet's on. The core protocol (staking, farming, swap) stays on Ethereum mainnet, and Solana has its own swap at /solana and its own curve at /curve-launch.",
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
    // All 8 core contracts are source-verified (TOWELI, Staking, Factory, Router,
    // RevenueDistributor, SwapFeeRouter, POLAccumulator, ReferralSplitter), and /contracts
    // shows a live per-address badge read from Etherscan. Keep this answer in sync with
    // that, in both directions.
    keywords: ['etherscan', 'verify', 'contract', 'address'],
    answer: "All 8 core contracts are source-verified on Etherscan: you can read the actual Solidity, not just bytecode. Every address is at /contracts with a live verification badge (checked against Etherscan, not hardcoded), plus links to the source code and public ABIs.",
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
    // PremiumAccess is live. The fee is in TOWELI, read from the contract (never hardcode
    // it: it is timelock-mutable), and there is no points multiplier or fee discount. A
    // static answer cannot read the chain, so it states the design and that no ETH has been
    // distributed yet, never "holders earn ETH" (premiumBenefits.ts reads it live).
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
    answer: "Venue Score measures commitment: stake size, lock length, NFT boost, vote activity. Higher = better perks.",
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

/** The best-matching answer for a free-text question, or a random fallback when nothing
 *  scores. An entry scores one point per question token in its keywords, plus one point
 *  per word of each several-word keyword whose words are all in the question, plus its
 *  priority. Threshold is 1 hit, and a tie goes to the entry listed first. */
export function answerQuestion(question: string): string {
  const tokens = tokenize(question);
  if (tokens.length === 0) {
    return "Ask me something specific — staking, swap, NFTs, gas, whatever.";
  }
  const asked = new Set(tokens);
  let bestScore = 0;
  let best: KnowledgeEntry | null = null;
  for (const entry of KNOWLEDGE_BASE) {
    const set = new Set(entry.keywords);
    let score = 0;
    for (const tok of tokens) if (set.has(tok)) score++;
    // A question token never holds a space, so a phrase is matched word by word.
    for (const k of entry.keywords) {
      const words = k.split(' ');
      if (words.length > 1 && words.every((w) => asked.has(w))) score += words.length;
    }
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
