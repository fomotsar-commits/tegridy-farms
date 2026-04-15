import { motion } from 'framer-motion';
import { ART } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';

interface ChangelogEntry {
  date: string;
  title: string;
  items: string[];
}

const CHANGELOG: ChangelogEntry[] = [
  {
    date: 'April 14, 2026',
    title: 'NFT Finance UX Overhaul',
    items: [
      'Added How It Works guides across all NFT Finance sections',
      'Added tooltips for DeFi terminology',
      'Added repayment previews and risk banners for borrowers',
      'Added step indicators for multi-transaction flows',
      'Improved empty states with actionable guidance',
      'Added intro overview cards and mobile-friendly tab navigation',
    ],
  },
  {
    date: 'April 14, 2026',
    title: 'NFT Lending & AMM Deployment',
    items: [
      'Deployed TegridyNFTLending contract (generic NFT collateral)',
      'Deployed TegridyNFTPool & TegridyNFTPoolFactory (bonding curve AMM)',
      'Whitelisted JBAC, Nakamigos, GNSS collections for lending',
      'Full 3-tab UI for NFT Lending (Lend, Borrow, My Loans)',
      'Full 3-tab UI for NFT AMM (Trade, Create Pool, My Pools)',
    ],
  },
  {
    date: 'April 2026',
    title: 'Security Hardening',
    items: [
      'Fixed all v4 audit findings (C-02, C-03, C-04, H-01, H-03, M-01, M-04)',
      'Added WETH fallback on acceptOffer (audit M-02)',
      'Added reentrancy tests for NFT Pool contracts',
      'Added sandwich attack simulation tests',
    ],
  },
  {
    date: 'March 2026',
    title: 'Community Features Launch',
    items: [
      'Launched Community Grants voting system',
      'Launched Meme Bounty Board',
      'Added Vote Incentives (bribes) for governance participation',
      'Referral system with on-chain tracking',
    ],
  },
  {
    date: 'February 2026',
    title: 'Core Protocol Launch',
    items: [
      'Deployed TegridyFactory, TegridyPair, TegridyRouter (Uniswap V2 fork)',
      'Deployed TegridyStaking with NFT positions and boost mechanics',
      'Deployed RevenueDistributor (100% fee sharing)',
      'Deployed SwapFeeRouter for fee capture',
      'Launched Dashboard, Farm, Swap, and Tokenomics pages',
    ],
  },
];

export default function ChangelogPage() {
  usePageTitle('Changelog', 'Protocol development history and updates');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img src={ART.forestScene.src} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[800px] mx-auto px-4 md:px-6 pt-28 pb-20">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">Changelog</h1>
          <p className="text-gray-400 text-sm md:text-base">
            Protocol updates and development history
          </p>
        </motion.div>

        {/* Timeline */}
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[19px] md:left-[23px] top-2 bottom-2 w-px bg-purple-500/20" />

          <div className="space-y-8">
            {CHANGELOG.map((entry, idx) => (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + idx * 0.08 }}
                className="relative pl-12 md:pl-14"
              >
                {/* Timeline dot */}
                <div className="absolute left-[14px] md:left-[18px] top-[22px] w-[11px] h-[11px] rounded-full bg-purple-500 border-2 border-purple-400 shadow-[0_0_8px_rgba(139,92,246,0.5)]" />

                {/* Card */}
                <div
                  className="rounded-xl p-5 md:p-6"
                  style={{ background: 'rgba(13, 21, 48, 0.6)', border: '1px solid rgba(139, 92, 246, 0.12)' }}
                >
                  {/* Date badge */}
                  <span className="inline-block text-xs font-semibold text-purple-400 bg-purple-500/10 px-3 py-1 rounded-full mb-3">
                    {entry.date}
                  </span>

                  {/* Title */}
                  <h2 className="text-white text-lg font-bold mb-4">{entry.title}</h2>

                  {/* Items */}
                  <ul className="space-y-2.5">
                    {entry.items.map((item, iIdx) => (
                      <li key={iIdx} className="flex items-start gap-2.5 text-sm text-gray-300 leading-relaxed">
                        <svg
                          className="w-4 h-4 text-green-400 shrink-0 mt-0.5"
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
