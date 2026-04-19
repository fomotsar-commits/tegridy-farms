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
    keywords: ['what', 'toweli', 'token'],
    answer: "TOWELI is the farm's token. 1B supply. 100% of swap fees flow back to stakers as ETH. That's the whole pitch.",
  },
  {
    keywords: ['what', 'tegridy', 'farms'],
    answer: "Tegridy Farms is a yield farm where you stake TOWELI to earn ETH from swap fees. Real yield, not printed rewards.",
  },

  // ── Staking ──────────────────────────────────────────────────
  {
    keywords: ['how', 'stake', 'staking'],
    answer: "Go to /farm, type how much TOWELI to lock, pick a lock duration (longer = bigger boost), hit Stake. Tegridy demands it.",
    priority: 2,
  },
  {
    keywords: ['lock', 'duration', 'how', 'long'],
    answer: "Lock from 7 days to 4 years. 4 years = 4× boost on rewards. Math checks out.",
  },
  {
    keywords: ['boost', 'multiplier'],
    answer: "Lock longer, earn more. 4× boost at max lock (4 years). Add a JBAC NFT for an extra bump.",
  },
  {
    keywords: ['unstake', 'withdraw', 'early', 'exit'],
    answer: "Withdraw early = penalty (% increases the further you are from your unlock date). Wait it out for full payout.",
  },
  {
    keywords: ['claim', 'rewards', 'how', 'claim'],
    answer: "Dashboard → Claim Rewards button. Pulls all pending TOWELI to your wallet. No gas surprises.",
    priority: 2,
  },
  {
    keywords: ['apr', 'yield', 'returns', 'earn'],
    answer: "APR depends on TVL + lock duration + your boost. Check the Farm page for the current rate. Not financial advice — I'm a towel.",
  },

  // ── Swap / trade ─────────────────────────────────────────────
  {
    keywords: ['how', 'swap', 'trade', 'buy'],
    answer: "Trade page → Swap tab. Pick tokens, amounts, slippage. Hit Swap. Wallet confirms. Done.",
  },
  {
    keywords: ['slippage', 'price', 'impact'],
    answer: "Slippage = max price drift you'll accept. 0.5% is normal. 5%+ means low liquidity — be careful.",
  },
  {
    keywords: ['dca', 'dollar', 'cost', 'average'],
    answer: "Trade page → DCA tab. Schedule recurring buys so you don't have to time the market. Set it, forget it.",
  },
  {
    keywords: ['limit', 'order'],
    answer: "Trade page → Limit tab. Set a target price; the order fills when the market hits it. No babysitting.",
  },
  {
    keywords: ['liquidity', 'lp', 'provide'],
    answer: "Trade page → Liquidity tab. Add equal value of both tokens to a pool, earn fees per swap. Watch out for impermanent loss.",
  },
  {
    keywords: ['impermanent', 'loss', 'il'],
    answer: "Impermanent loss happens when one token in your LP pair moons or tanks vs. the other. Fees usually offset it. Usually.",
  },

  // ── NFTs ─────────────────────────────────────────────────────
  {
    keywords: ['jbac', 'nft', 'boost', 'nft'],
    answer: "JBAC NFTs add a boost multiplier on top of your lock boost. Hold one, your stake earns more. Stack them for stacked boost.",
  },
  {
    keywords: ['nft', 'lending', 'borrow'],
    answer: "NFT Finance → NFT Lending. Use your JBAC, Nakamigos, or GNSS as collateral to borrow ETH. No oracles needed.",
  },
  {
    keywords: ['nakamigos'],
    answer: "Nakamigos has its own marketplace at /nakamigos — full trading floor, listings, offers, the works.",
  },

  // ── Governance ──────────────────────────────────────────────
  {
    keywords: ['vote', 'voting', 'governance', 'gauge'],
    answer: "Community → Gauge Voting. Direct emissions to your favorite pool. Your vote weight = your locked TOWELI × boost.",
  },
  {
    keywords: ['bribes', 'incentive', 'cartman'],
    answer: "Cartman's Market on the Community page — deposit tokens to bribe voters into directing emissions your way. Kinda shady. We love it.",
  },
  {
    keywords: ['bounty', 'bounties'],
    answer: "Community → Bounties. Post a task with a reward, contributors complete it for the bounty. Both sides win.",
  },
  {
    keywords: ['grants', 'proposal'],
    answer: "Community → Grants. Propose a project, the DAO funds it. Tegridy preserved by votes.",
  },

  // ── Wallet / network ────────────────────────────────────────
  {
    keywords: ['wallet', 'connect', 'how'],
    answer: "Top right → Connect Wallet. MetaMask, Rainbow, WalletConnect — anything WalletConnect-compatible works.",
  },
  {
    keywords: ['network', 'chain', 'switch', 'mainnet'],
    answer: "Tegridy Farms runs on Ethereum mainnet. If you're on the wrong chain, your wallet shows a 'Switch' button — hit it.",
  },
  {
    keywords: ['gas', 'fee', 'fees', 'expensive'],
    answer: "Gas is whatever Ethereum's charging that minute. Use Etherscan's gas tracker to time txs when fees are low.",
  },

  // ── Misc / safety ───────────────────────────────────────────
  {
    keywords: ['safe', 'security', 'audit', 'rug'],
    answer: "Audited by an independent firm + active bug bounty. /security has the full report. Probably safer than my last job.",
  },
  {
    keywords: ['premium', 'gold', 'card', 'randy'],
    answer: "Randy's Gold Card gives bonus rewards + perks. Subscription via /premium. Pays for itself if you're staking serious size.",
  },
  {
    keywords: ['leaderboard', 'points', 'rank'],
    answer: "Earn points for staking, claiming, voting, etc. Top of the leaderboard gets bragging rights and seasonal rewards.",
  },
  {
    keywords: ['referral', 'invite', 'friend'],
    answer: "Dashboard has your referral link. Friend signs up + farms, you both earn bonus. Tegridy through community.",
  },
  {
    keywords: ['tegridy', 'score'],
    answer: "Tegridy Score measures how committed you are: stake size, lock length, NFT boost, vote activity. Higher = better perks.",
  },
  {
    keywords: ['lore', 'story', 'history'],
    answer: "/lore has the whole saga — how Tegridy was lost, found, lost again, then locked down on-chain.",
  },

  // ── Towelie meta ────────────────────────────────────────────
  {
    keywords: ['who', 'are', 'you', 'towelie'],
    answer: "I'm Towelie. I'm just a towel, but I help people farm here. Don't forget to bring a towel.",
  },
  {
    keywords: ['help', 'menu', 'commands'],
    answer: "Ask me anything about staking, swapping, NFTs, governance, gas, security — I'll do my best. If I'm stumped, /faq has more.",
  },
  {
    keywords: ['hide', 'disable', 'go', 'away', 'shut', 'up'],
    answer: "Cool, click 'Don't show again' under any bubble. I'll respect it. No hard feelings, towel's gotta towel.",
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
