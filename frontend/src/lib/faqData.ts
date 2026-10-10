import { BUNGALOW_COUNT } from './bungalows';
import { VENUE } from './arrival';

export interface FAQItem {
  q: string;
  a: string;
}

export interface FAQSection {
  category: string;
  items: FAQItem[];
}

/**
 * The FAQ in the venue's voice: the island's reference copy (answer seven), re-authored
 * only where the venue's facts are more exact, with heat in the island's own sentences.
 * The launch answer never says the floor is enforced: the gate is advisory, and a
 * launcher can call the contracts directly. Built per call: the floor is read per render.
 */
export function venueFaq(floor: number): FAQSection[] {
  return [
    {
      category: 'The venue',
      items: [
        {
          q: 'What is memetics.finance?',
          a: 'The venue of Jungle Bay Island: bungalows for meme communities, launches that open on held time, and swaps and staking with every fee routed on chain where you can read it. It runs on Ethereum, Base, Robinhood Chain and Solana.',
        },
        {
          q: 'What is a bungalow?',
          a: `A community's own door at the venue: its token, its walls, its art, its stake. There are ${BUNGALOW_COUNT} today. Walk in where you hold.`,
        },
        {
          q: 'What network does memetics.finance run on?',
          a: 'Staking, farming, swaps and NFT finance run on Ethereum Mainnet. The Memetics Curve launcher is also live on Base and Robinhood Chain, and /solana swaps SPL tokens through Jupiter. Your wallet prompts a network switch when a page needs a different chain.',
        },
      ],
    },
    {
      category: 'Heat',
      items: [
        {
          q: 'What is Heat?',
          a: `${VENUE.heatPlain} ${VENUE.heatDays} Price never enters it.`,
        },
        {
          q: 'Can Heat be bought?',
          a: `No. A fresh bag starts near zero however big it is. Only time held moves it. ${VENUE.heatOnePerson}`,
        },
        {
          q: 'How does a launch open?',
          a: `The launch door reads the launching wallet's held time live from the island. The floor is ${floor}°. The door broadcasts nothing before that read.`,
        },
      ],
    },
    {
      category: 'Liquidity and risk',
      items: [
        {
          q: 'How does providing liquidity work?',
          a: "Deposit both sides of a pair and hold the LP token. Fees add to the pool as it trades. Withdraw any time; no lock. The pools page shows the venue's live status, read from the chain.",
        },
        {
          q: 'What can go wrong?',
          a: 'Contracts carry risk; pools carry impermanent loss; a wallet read can be stale, and the venue says so instead of guessing. Never put in more than you can afford to lose. The Risks page lists the rest, plainly.',
        },
      ],
    },
  ];
}

/** The TOWELI room's own FAQ: answers about one resident's protocol, rendered by the room
 *  (HomePage), never by /faq. ethYieldClaims.test.ts and revenueClaimHonesty.test.ts read
 *  these words by path. */
export const TOWELI_FAQ_DATA: FAQSection[] = [
  {
    category: 'Getting Started',
    items: [
      { q: 'How do I get TOWELI tokens?', a: 'Buy TOWELI on Uniswap V2. Simply swap ETH for TOWELI at app.uniswap.org. Make sure you are connected to Ethereum Mainnet.' },
      { q: 'What wallets are supported?', a: 'MetaMask, WalletConnect, Coinbase Wallet, and most Ethereum wallets are supported via RainbowKit. Any wallet that supports Ethereum Mainnet should work.' },
    ],
  },
  {
    category: 'Staking',
    items: [
      { q: 'How does staking work?', a: 'Deposit TOWELI tokens into the staking contract to earn rewards. Choose a lock duration to receive a boost multiplier: longer locks earn higher yields. Rewards are paid in TOWELI emissions today. An ETH share of swap fees is wired on chain and pays in rounds that need 1 ETH of fees first; the Premium page shows what has been paid.' },
      { q: 'What is the lock duration?', a: 'You can lock your TOWELI from 7 days up to 4 years. Contract bounds are MIN_LOCK_DURATION = 7 days and MAX_LOCK_DURATION = 4 years. Longer lock durations give you a higher boost multiplier, which means more rewards.' },
      { q: 'Can I withdraw early?', a: 'Yes, but with a 25% early withdrawal penalty. The penalty is sent to the protocol treasury — it is not redistributed to other stakers.' },
      { q: 'What is a boost multiplier?', a: 'Your lock duration determines your yield boost on a linear scale: 0.4x at 7 days up to 4.0x at the full 4-year lock. With the JBAC NFT bonus stacked on top, the contract enforces a 4.5x ceiling (MAX_BOOST_BPS_CEILING = 45000). Higher multipliers mean a larger share of the reward pool.' },
      { q: 'Do I get an NFT for staking?', a: 'Yes. Your staking position is represented as an ERC-721 NFT. This NFT tracks your deposit amount, lock duration, and boost. It can also be used as collateral for peer-to-peer lending.' },
      { q: 'What are NFT boosts?', a: 'Holders of a JBAC NFT receive a flat +0.5x bonus on top of their lock multiplier (capped at 4.5x by MAX_BOOST_BPS_CEILING). Simply hold the NFT in your connected wallet to activate the bonus.' },
    ],
  },
  {
    category: 'Rewards',
    items: [
      { q: 'Where do rewards come from?', a: "Right now, from a one-time 6.4M TOWELI emissions seed funded at launch. No new tokens are ever minted; supply is fixed. The ETH side is on chain. A swap through the venue's own router pays a venue fee: 0.5% on 10 October 2026, set by the owner wallet through a 24-hour timelock and capped at 1% by the contract. 20% of that fee is the referral share, which goes to the trader's referrer if they stake enough TOWELI, and to the treasury otherwise. The other 80% is routed toward stakers through the RevenueDistributor, which can open a payout round only after 1 ETH has arrived. By 10 October 2026 the router had taken 0.000003 ETH in fees in all, and stakers had been paid none. The Premium page shows the live total, and both contracts are verifiable on Etherscan." },
      { q: 'How often can I claim rewards?', a: 'Anytime. Rewards accrue continuously in real-time and can be claimed whenever you want with no minimum threshold.' },
      { q: 'What is the Venue Score?', a: 'A points system based on your on-chain activity — staking, swapping, and referrals all earn points (voting joins once gauge voting goes live). Higher scores unlock tier benefits and leaderboard rankings.' },
    ],
  },
  {
    category: 'NFT Finance',
    items: [
      { q: 'What is NFT Lending?', a: 'Borrow ETH by locking your NFTs (JBAC, Nakamigos, GNSS) as collateral. It is fully peer-to-peer with no oracles and no liquidation auctions. NFT Lending is live — the contracts have been extensively internally reviewed, but not third-party audited, so treat it accordingly.' },
      { q: 'What happens if I default on a loan?', a: 'The lender claims your NFT permanently. There is no liquidation auction — the NFT simply transfers to the lender after the loan expires unpaid.' },
      { q: 'What is the NFT AMM?', a: 'Bonding curve pools for instant NFT trading. Provide liquidity by depositing NFTs and ETH into a pool to earn fees on every trade that occurs in that pool. The AMM is live — internally reviewed, not third-party audited.' },
      { q: 'What is pro-rata interest?', a: 'Interest is calculated based on the actual time borrowed, not the full loan term. If you repay early, you pay proportionally less interest than the maximum.' },
    ],
  },
  {
    category: 'Security',
    items: [
      { q: 'Are the contracts audited?', a: 'There is no paid third-party audit yet — we don’t claim one. The contracts have undergone extensive internal security review: multi-agent AI audit waves, red team testing, fuzz and invariant testing, Slither on every CI run, and a 1,500+ test suite. Visit the Security page for the artifacts and the Risks page for the honest gap list.' },
      { q: 'Can the admin rug pull?', a: 'The TOWELI token itself cannot be rugged: fixed supply, no mint function, no pause, no blocklist — and staked tokens can only ever be withdrawn by their owner. Admin powers are real but bounded: a 24–48 hour timelock delays SENSITIVE parameter changes (treasury, fee recipients, fees, emission budget, oracle floors) — but some operational setters (e.g. stake caps) and the emergency pause act IMMEDIATELY, so “always time to review and exit” does not hold for every change. Admin functions are held by a single operator key (EOA) today, with a multisig migration in progress — until it lands, size deposits as if the single-key assumption holds. A compromised admin who waited out the timelock could redirect fee flows, pause staking indefinitely (emergency withdrawal still works), or add a malicious NFT collection to lending — but could not mint tokens or take your stake. The full threat model is on the Risks page.' },
      { q: 'What are the risks?', a: 'Smart contract risk, market volatility, impermanent loss for liquidity providers, and early withdrawal penalties. Always do your own research and never invest more than you can afford to lose.' },
    ],
  },
  {
    category: 'Premium',
    items: [
      { q: 'What is the Gold Card?', a: 'The Gold Card is a premium membership, live now on the Premium page. You pay in TOWELI — the monthly fee is read straight from the PremiumAccess contract and shown on that page — and you can prepay 1, 3, 6 or 12 months at the same flat rate. Like every staker, holders are in line for ETH from protocol swap fees; none has been distributed yet, and the Premium page shows the live number. The contract is internally reviewed, not third-party audited.' },
      { q: 'Do JBAC holders get free access?', a: 'Yes. JBAC NFT holders have lifetime Gold Card access at no cost — simply hold a JBAC in your connected wallet and premium unlocks automatically.' },
    ],
  },
];
