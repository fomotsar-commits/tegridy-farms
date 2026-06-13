import { useState, useEffect } from 'react';
import { m, AnimatePresence } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { FAQ_INTRO } from '../lib/copy';
import { ArtImg } from '../components/ArtImg';

interface FAQItem {
  q: string;
  a: string;
}

interface FAQSection {
  category: string;
  items: FAQItem[];
}

const FAQ_DATA: FAQSection[] = [
  {
    category: 'Getting Started',
    items: [
      { q: 'What is Tegridy Farms?', a: 'Tegridy Farms is a yield farming protocol on Ethereum. Stake TOWELI tokens to earn rewards from the protocol. Today’s rewards are TOWELI emissions from a fixed launch seed; the ETH fee-share pipeline — protocol swap fees routed on-chain to stakers — is deployed and switches on when the native pool goes live.' },
      { q: 'How do I get TOWELI tokens?', a: 'Buy TOWELI on Uniswap V2. Simply swap ETH for TOWELI at app.uniswap.org. Make sure you are connected to Ethereum Mainnet.' },
      { q: 'What wallets are supported?', a: 'MetaMask, WalletConnect, Coinbase Wallet, and most Ethereum wallets are supported via RainbowKit. Any wallet that supports Ethereum Mainnet should work.' },
      { q: 'What network does Tegridy Farms run on?', a: 'Ethereum Mainnet only. Make sure your wallet is connected to the correct network before interacting with the protocol.' },
    ],
  },
  {
    category: 'Staking',
    items: [
      { q: 'How does staking work?', a: 'Deposit TOWELI tokens into the staking contract to earn rewards. Choose a lock duration to receive a boost multiplier — longer locks earn higher yields. Rewards are currently paid in TOWELI emissions; ETH fee-share rewards activate once the native pool is live.' },
      { q: 'What is the lock duration?', a: 'You can lock your TOWELI from 7 days up to 4 years. Contract bounds are MIN_LOCK_DURATION = 7 days and MAX_LOCK_DURATION = 4 years. Longer lock durations give you a higher boost multiplier, which means more rewards.' },
      { q: 'Can I withdraw early?', a: 'Yes, but with a 25% early withdrawal penalty. The penalty amount is distributed proportionally to all remaining stakers as a bonus.' },
      { q: 'What is a boost multiplier?', a: 'Your lock duration determines your yield boost on a linear scale: 0.4x at 7 days up to 4.0x at the full 4-year lock. With the JBAC NFT bonus stacked on top, the contract enforces a 4.5x ceiling (MAX_BOOST_BPS_CEILING = 45000). Higher multipliers mean a larger share of the reward pool.' },
      { q: 'Do I get an NFT for staking?', a: 'Yes. Your staking position is represented as an ERC-721 NFT. This NFT tracks your deposit amount, lock duration, and boost. It can also be used as collateral for peer-to-peer lending.' },
      { q: 'What are NFT boosts?', a: 'Holders of a JBAC NFT receive a flat +0.5x bonus on top of their lock multiplier (capped at 4.5x by MAX_BOOST_BPS_CEILING). Simply hold the NFT in your connected wallet to activate the bonus.' },
    ],
  },
  {
    category: 'Rewards',
    items: [
      { q: 'Where do rewards come from?', a: 'Right now, from a one-time 6.4M TOWELI emissions seed funded at launch — no new tokens are ever minted, supply is fixed. The next stage is already on-chain: protocol swap fees route through the SwapFeeRouter to the RevenueDistributor and out to stakers as ETH. That ETH stream starts flowing when the native pool launches; both contracts are verifiable on Etherscan today.' },
      { q: 'How often can I claim rewards?', a: 'Anytime. Rewards accrue continuously in real-time and can be claimed whenever you want with no minimum threshold.' },
      { q: 'What is the Tegridy Score?', a: 'A points system based on your on-chain activity — staking, swapping, and referrals all earn points (voting joins once gauge voting goes live). Higher scores unlock tier benefits and leaderboard rankings.' },
    ],
  },
  {
    category: 'NFT Finance',
    items: [
      { q: 'What is NFT Lending?', a: 'Borrow ETH by locking your NFTs (JBAC, Nakamigos, GNSS) as collateral. It is fully peer-to-peer with no oracles and no liquidation auctions. The lending contracts are audited but not yet redeployed after the June 2026 relaunch — the page un-gates automatically when they go live.' },
      { q: 'What happens if I default on a loan?', a: 'The lender claims your NFT permanently. There is no liquidation auction — the NFT simply transfers to the lender after the loan expires unpaid.' },
      { q: 'What is the NFT AMM?', a: 'Bonding curve pools for instant NFT trading. Provide liquidity by depositing NFTs and ETH into a pool to earn fees on every trade that occurs in that pool. Not yet redeployed post-relaunch — it un-gates when the contracts go live.' },
      { q: 'What is pro-rata interest?', a: 'Interest is calculated based on the actual time borrowed, not the full loan term. If you repay early, you pay proportionally less interest than the maximum.' },
    ],
  },
  {
    category: 'Security',
    items: [
      { q: 'Are the contracts audited?', a: 'There is no paid third-party audit yet — we don’t claim one. The contracts have undergone extensive internal security review: multi-agent AI audit waves, red team testing, fuzz and invariant testing, Slither on every CI run, and a 1,500+ test suite. Visit the Security page for the artifacts and the Risks page for the honest gap list.' },
      { q: 'Can the admin rug pull?', a: 'The TOWELI token itself cannot be rugged: fixed supply, no mint function, no pause, no blocklist — and staked tokens can only ever be withdrawn by their owner. Admin powers are real but bounded: every parameter change goes through a 24-48 hour timelock, so you always have time to review and exit. Admin functions are held by a single operator key (EOA) today, with a multisig migration in progress — until it lands, size deposits as if the single-key assumption holds. A compromised admin who waited out the timelock could redirect fee flows, pause staking indefinitely (emergency withdrawal still works), or add a malicious NFT collection to lending — but could not mint tokens or take your stake. The full threat model is on the Risks page.' },
      { q: 'What are the risks?', a: 'Smart contract risk, market volatility, impermanent loss for liquidity providers, and early withdrawal penalties. Always do your own research and never invest more than you can afford to lose.' },
    ],
  },
  {
    category: 'Premium',
    items: [
      { q: 'What is the Gold Card?', a: 'The Gold Card is a premium tier that grants 3x points multiplier, priority access to new features, and exclusive benefits, paid monthly in ETH. The premium contract is built and audited but not yet deployed — the page un-gates when it goes live.' },
      { q: 'Do JBAC holders get free access?', a: 'Yes — once premium is live, JBAC NFT holders receive lifetime Gold Card access at no cost. Simply hold a JBAC in your connected wallet to activate premium benefits.' },
    ],
  },
];

export default function FAQPage() {
  usePageTitle('FAQ', 'Frequently asked questions about Tegridy Farms');
  const [openIndex, setOpenIndex] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Inject FAQPage structured data for SEO rich results
  useEffect(() => {
    const allItems = FAQ_DATA.flatMap(s => s.items);
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      mainEntity: allItems.map(item => ({
        '@type': 'Question',
        name: item.q,
        acceptedAnswer: { '@type': 'Answer', text: item.a },
      })),
    };
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify(jsonLd);
    document.head.appendChild(script);
    return () => { document.head.removeChild(script); };
  }, []);

  const toggle = (key: string) => setOpenIndex(openIndex === key ? null : key);

  // Stable, filter-independent key for accordion open-state + a slug-safe id for
  // aria-controls/labelledby. Keying by positional index into the *filtered*
  // arrays meant a search that reshaped the list could transfer the open state
  // to a different question (F385); the question text is stable across filters.
  const stableKey = (category: string, q: string) => `${category}|${q}`;
  const slugId = (category: string, q: string) =>
    `${category}-${q}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  const filtered = FAQ_DATA.map((section) => ({
    ...section,
    items: section.items.filter(
      (item) =>
        item.q.toLowerCase().includes(search.toLowerCase()) ||
        item.a.toLowerCase().includes(search.toLowerCase())
    ),
  })).filter((section) => section.items.length > 0);

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="faq" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <div className="relative z-10 max-w-[800px] mx-auto px-4 md:px-6 pt-32 pb-20">
        {/* Header */}
        <m.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="text-center mb-10"
        >
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">
            {FAQ_INTRO.headline}
          </h1>
          <p className="text-gray-400 text-sm md:text-base max-w-[600px] mx-auto" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
            {FAQ_INTRO.subheading}
          </p>
        </m.div>

        {/* Search */}
        <m.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="mb-8"
        >
          <div
            className="rounded-xl px-4 py-3 flex items-center gap-3"
            style={{ background: 'rgba(13, 21, 48, 0.85)', border: '1px solid var(--color-purple-12)' }}
          >
            <svg className="w-5 h-5 text-gray-500 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              aria-label="Search questions"
              placeholder="Search questions..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="bg-transparent w-full text-white placeholder-gray-500 outline-none text-[16px]"
            />
            {search && (
              <button onClick={() => setSearch('')} aria-label="Clear search" className="text-gray-500 hover:text-white text-lg leading-none">
                &times;
              </button>
            )}
          </div>
        </m.div>

        {/* FAQ Sections */}
        {filtered.length === 0 && (
          <div
            className="rounded-xl px-5 py-10 text-center"
            style={{ background: 'rgba(13, 21, 48, 0.85)', border: '1px solid var(--color-purple-12)' }}
          >
            <p className="text-white text-sm mb-1">No questions match your search.</p>
            <p className="text-gray-400 text-xs mb-4">Try a different term, or browse all questions.</p>
            <button
              onClick={() => setSearch('')}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold text-white border border-white/15 hover:border-white/30 transition-colors"
            >
              Clear search
            </button>
          </div>
        )}

        {filtered.map((section, sIdx) => (
          <m.div
            key={section.category}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 + sIdx * 0.05 }}
            className="mb-6"
          >
            {/* F434: translucent dark chip so the label stays legible over the
                bright watercolor art (same treatment as the accordion rows). */}
            <h2 className="inline-block text-purple-300 text-xs font-semibold uppercase tracking-widest mb-3 px-2.5 py-1 rounded-md"
              style={{ background: 'rgba(13, 21, 48, 0.85)', border: '1px solid var(--color-purple-12)' }}>
              {section.category}
            </h2>
            <div
              className="rounded-xl overflow-hidden divide-y divide-white/5"
              style={{ background: 'rgba(13, 21, 48, 0.85)', border: '1px solid var(--color-purple-12)' }}
            >
              {section.items.map((item) => {
                const key = stableKey(section.category, item.q);
                const id = slugId(section.category, item.q);
                const isOpen = openIndex === key;
                const panelId = `faq-panel-${id}`;
                const buttonId = `faq-q-${id}`;
                return (
                  <div key={key}>
                    {/* AUDIT FAQ-A11Y: accordion-button pattern. aria-expanded
                        announces open/closed to screen readers; aria-controls
                        + matching panel id ties the button to its content so
                        SR users can navigate to the revealed text directly. */}
                    <button
                      id={buttonId}
                      onClick={() => toggle(key)}
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left hover:bg-white/[0.03] transition-colors"
                    >
                      <span className="text-white text-sm font-medium leading-snug">{item.q}</span>
                      <m.svg
                        animate={{ rotate: isOpen ? 180 : 0 }}
                        transition={{ duration: 0.25 }}
                        className="w-4 h-4 text-purple-400 shrink-0"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </m.svg>
                    </button>
                    <AnimatePresence initial={false}>
                      {isOpen && (
                        <m.div
                          id={panelId}
                          role="region"
                          aria-labelledby={buttonId}
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.25, ease: 'easeInOut' }}
                          className="overflow-hidden"
                        >
                          <div className="px-5 pb-4 text-gray-400 text-sm leading-relaxed">
                            {item.a}
                          </div>
                        </m.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              })}
            </div>
          </m.div>
        ))}

        <p className="text-center text-white/40 text-xs mt-10" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
          Last reviewed: June 2026
        </p>
      </div>
    </div>
  );
}
