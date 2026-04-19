import { m } from 'framer-motion';
import { pageArt } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';

interface ChangelogEntry {
  date: string;
  title: string;
  items: string[];
}

// Each card rotates through a distinct art piece so every entry feels its own.
// Uses pageArt with a dedicated changelog-cards pageId so card art stays
// disjoint from the page background (which uses the 'changelog' pageId).
const CARD_ART = Array.from({ length: 16 }, (_, i) => pageArt('changelog-cards', i));

const CHANGELOG: ChangelogEntry[] = [
  {
    date: 'April 18, 2026',
    title: 'Visual Identity Refresh',
    items: [
      'South Park palette adopted: kyle-green stat text and Kenny-orange day mode',
      'Dark mode is now the default; light/day mode toggles in manually',
      'Per-card art with translucent black content panels across Dashboard, Farm, Tokenomics, Changelog, Security, Community, and NFT Finance',
      'Nakamigos art gallery renamed to Tradermigos across splash, marketplace header, and top-bar action',
      'Top-bar Points slot swapped for Tradermigos; Points moved into the More dropdown',
      'More dropdown now opens under the More button instead of spilling under Community',
      'Collection cards on NFT Lending now use per-project canonical art (JBAC skeleton, Nakamigos pixel, GNSS Art render)',
      'Launchpad feature bullets recolored with the full South Park character palette',
      'FAQ + Changelog page-background scrims removed; Tegridy Score ring digit is kyle green',
      'History page: surface a readable message when the Etherscan proxy returns a non-JSON response instead of the raw "Unexpected token" parse error',
      'Broken /splash/*.png fallback paths fixed to the actual .jpg assets (kills the broken-image stub in the marketplace header)',
    ],
  },
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
      'Applied fixes for several v4 audit findings (C-02, C-03, H-01, H-03, M-02). Full status in SECURITY_AUDIT_300_AGENT.md',
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
        <img src={pageArt('changelog', 0).src} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[800px] mx-auto px-4 md:px-6 pt-32 pb-20">
        {/* Header */}
        <m.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-12"
        >
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">Changelog</h1>
          <p className="text-gray-400 text-sm md:text-base">
            Protocol updates and development history
          </p>
        </m.div>

        {/* Timeline */}
        <div className="relative">
          {/* Vertical line */}
          <div className="absolute left-[19px] md:left-[23px] top-2 bottom-2 w-px bg-purple-500/20" />

          <div className="space-y-8">
            {CHANGELOG.map((entry, idx) => (
              <m.div
                key={idx}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 + idx * 0.08 }}
                className="relative pl-12 md:pl-14"
              >
                {/* Timeline dot */}
                <div className="absolute left-[14px] md:left-[18px] top-[22px] w-[11px] h-[11px] rounded-full bg-purple-500 border-2 border-purple-400 shadow-[0_0_8px_var(--color-purple-50)]" />

                {/* Card */}
                <div
                  className="rounded-xl relative overflow-hidden"
                  style={{ border: '1px solid var(--color-purple-12)' }}
                >
                  <div className="absolute inset-0">
                    <img src={CARD_ART[idx % CARD_ART.length]!.src} alt="" loading="lazy" className="w-full h-full object-cover" />
                  </div>
                  {/* Translucent black content panel — art still bleeds through the border,
                      text stays readable against the dimmed backdrop. */}
                  <div className="relative z-10 m-2 md:m-3 rounded-lg p-4 md:p-5" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}>
                    {/* Date badge */}
                    <span className="inline-block text-xs font-semibold text-purple-300 bg-purple-500/20 px-3 py-1 rounded-full mb-3" style={{ backdropFilter: 'blur(4px)' }}>
                      {entry.date}
                    </span>

                    {/* Title */}
                    <h2 className="text-white text-lg font-bold mb-4" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>{entry.title}</h2>

                    {/* Items */}
                    <ul className="space-y-2.5">
                      {entry.items.map((item, iIdx) => (
                        <li key={iIdx} className="flex items-start gap-2.5 text-sm text-gray-200 leading-relaxed" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
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
                </div>
              </m.div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
