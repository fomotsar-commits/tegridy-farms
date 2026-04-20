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
    keywords: ['toweli', 'token'],
    answer: "TOWELI is the farm's token. 1B fixed supply. 100% of swap fees flow back to stakers as ETH. That's the whole pitch.",
  },
  {
    keywords: ['tegridy', 'farms', 'protocol', 'project'],
    answer: "Tegridy Farms is a yield farm where you stake TOWELI to earn ETH from swap fees. Real yield, no printed rewards.",
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
    keywords: ['emission', 'inflation', 'distribution'],
    answer: "Zero inflation. Rewards come from real swap fees, not new tokens. /tokenomics shows the original distribution.",
  },
  {
    keywords: ['treasury', 'dao', 'fund'],
    answer: "Community treasury holds protocol-owned liquidity + grants budget. Tracked at /treasury. Spend votes go through governance.",
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
    keywords: ['boost', 'multiplier'],
    answer: "Lock longer, earn more. 4× boost at max lock (4 years). Add a JBAC NFT for an extra bump on top.",
  },
  {
    keywords: ['unstake', 'withdraw', 'exit'],
    answer: "Withdraw early = penalty (% scales with how far you are from your unlock date). Wait it out for the full payout.",
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
    keywords: ['fee', 'swap', 'cost', 'percent'],
    answer: "Swap fee is 0.3% per trade. 100% of it goes to TOWELI stakers as ETH. That's where your yield comes from.",
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

  // ── NFTs ─────────────────────────────────────────────────────
  {
    keywords: ['jbac', 'nft'],
    answer: "JBAC NFTs add a boost multiplier on top of your lock boost. Hold one, your stake earns more. Stack them for stacked boost.",
  },
  {
    keywords: ['nft', 'lending', 'borrow', 'collateral'],
    answer: "NFT Finance → NFT Lending. Use JBAC, Nakamigos, or GNSS as collateral to borrow ETH. No oracles needed.",
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
    keywords: ['amm', 'bonding', 'curve'],
    answer: "NFT AMM lets you trade NFTs against bonding-curve pools. Add NFTs as inventory, earn fees on every swap. Pure on-chain.",
  },
  {
    keywords: ['launchpad'],
    answer: "Launchpad lets project owners create gated NFT collections with a wizard. Live in NFT Finance → Launchpad tab.",
  },

  // ── Governance ──────────────────────────────────────────────
  {
    keywords: ['vote', 'voting', 'governance', 'gauge'],
    answer: "Community → Gauge Voting. Direct emissions to your favorite pool. Your vote weight = your locked TOWELI × boost.",
  },
  {
    keywords: ['weight', 'power', 'vote'],
    answer: "Vote weight = locked TOWELI × current boost. Lock more or longer → more weight. Bribe-your-friends mechanics, with tegridy.",
  },
  {
    keywords: ['epoch', 'cycle', 'period'],
    answer: "Voting epochs are 7 days. Votes you cast this epoch direct emissions next epoch. Plan ahead.",
  },
  {
    keywords: ['bribes', 'bribe', 'incentive', 'cartman'],
    answer: "Cartman's Market on /community — deposit tokens to bribe voters into directing emissions your way. Kinda shady. We love it.",
  },
  {
    keywords: ['bounty', 'bounties', 'task'],
    answer: "Community → Bounties. Post a task with a reward, contributors complete it for the bounty. Both sides win.",
  },
  {
    keywords: ['grants', 'proposal', 'fund'],
    answer: "Community → Grants. Propose a project, the DAO funds it. Tegridy preserved by votes.",
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
  {
    keywords: ['network', 'chain', 'switch', 'mainnet'],
    answer: "Tegridy Farms runs on Ethereum mainnet. Wrong chain → your wallet shows a 'Switch' button. Hit it.",
  },
  {
    keywords: ['l2', 'layer', 'rollup', 'arbitrum', 'optimism', 'base'],
    answer: "Mainnet only for now. L2 deployment is on the roadmap if community votes for it.",
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
    keywords: ['history', 'transactions', 'past', 'activity'],
    answer: "Dashboard → History tab (or just /history) for your full tx log. Filter by type, export coming soon.",
  },
  {
    keywords: ['tax', 'taxes', 'accounting', 'cost', 'basis'],
    answer: "Pull your /history page or use Etherscan to export tx data. I'm a towel — talk to a tax pro for the rest.",
  },
  {
    keywords: ['etherscan', 'verify', 'contract', 'address'],
    answer: "All contract addresses + Etherscan links live at /contracts. Source-verified, ABI public, audit linked.",
  },

  // ── Premium / referrals / scoring ──────────────────────────
  {
    keywords: ['safe', 'security', 'audit', 'rug', 'risk'],
    answer: "Audited by an independent firm + active bug bounty. /security has the full report. Probably safer than my last job.",
  },
  {
    keywords: ['risks'],
    answer: "Smart-contract risk, market risk, IL risk for LPs. /risks has the honest version. Read it.",
  },
  {
    keywords: ['premium', 'gold', 'card', 'subscription'],
    answer: "Randy's Gold Card gives bonus rewards + perks. Subscription via /premium. Pays for itself if you're staking serious size.",
  },
  {
    keywords: ['cancel', 'unsubscribe', 'refund'],
    answer: "Cancel from /premium → Manage. No refund mid-period; runs to end of your paid window.",
  },
  {
    keywords: ['leaderboard', 'points', 'rank', 'ranking'],
    answer: "Earn points for staking, claiming, voting, etc. Top of /leaderboard gets bragging rights and seasonal rewards.",
  },
  {
    keywords: ['referral', 'invite', 'friend', 'code'],
    answer: "Dashboard has your referral link. Friend signs up + farms, you both earn bonus. Tegridy through community.",
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
    answer: "Roadmap lives in community grants + governance proposals. Big swings get voted on at /community.",
  },
  {
    keywords: ['team', 'devs', 'who', 'built'],
    answer: "Team's pseudonymous, multi-sig governs the contracts. Look at /security for the multisig setup, /contracts for the code.",
  },
  {
    keywords: ['contact', 'support', 'help', 'discord'],
    answer: "Community channels link from /community footer. For bugs use the bug bounty (/security). For tax stuff, talk to a pro.",
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
