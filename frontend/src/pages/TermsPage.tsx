import { m } from 'framer-motion';
import { pageArt } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';

const SECTIONS = [
  {
    title: '1. Acceptance of Terms',
    body: 'By accessing or using the Tegridy Farms protocol ("Protocol"), including its smart contracts, website, and associated interfaces, you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you must not access or use the Protocol. Your continued use of the Protocol constitutes acceptance of any updates or modifications to these Terms.',
  },
  {
    title: '2. Description of Services',
    body: 'Tegridy Farms is a decentralized finance (DeFi) protocol built on the Ethereum blockchain. The Protocol provides the following services: yield farming and liquidity provision through automated market maker pools; token swapping via integrated DEX functionality; TOWELI token staking with vote-escrow mechanics; peer-to-peer NFT lending with collateral-based loan origination; and an NFT AMM for automated NFT trading. All services are provided through non-custodial smart contracts deployed on the Ethereum mainnet.',
  },
  {
    title: '3. Eligibility',
    body: 'You must be at least 18 years of age to use the Protocol. By using the Protocol, you represent and warrant that you are at least 18 years old and have the legal capacity to enter into these Terms. You further represent that you are not located in, incorporated in, or a citizen or resident of any jurisdiction where the use of DeFi protocols is prohibited or restricted, including but not limited to OFAC-sanctioned countries. It is your responsibility to ensure compliance with all applicable local laws and regulations.',
  },
  {
    title: '4. Wallet Connection & Self-Custody',
    body: 'The Protocol operates on a non-custodial basis. You connect your own Ethereum wallet (e.g., MetaMask, WalletConnect-compatible wallets) to interact with the Protocol. You are solely responsible for the security and management of your private keys, seed phrases, and wallet credentials. The Protocol does not have access to, and cannot recover, your private keys or funds. Loss of your private keys will result in permanent loss of access to your assets. Never share your private keys or seed phrases with anyone.',
  },
  {
    title: '5. Risks',
    body: 'Using the Protocol involves significant risks, including but not limited to: smart contract vulnerabilities that may result in loss of funds; extreme market volatility and potential total loss of token value; impermanent loss when providing liquidity to AMM pools; blockchain network congestion leading to failed or delayed transactions; regulatory changes that may affect the legality or functionality of the Protocol; and front-running or MEV extraction by third parties. There is no guarantee of returns on any investment, stake, or liquidity provision made through the Protocol. You acknowledge and accept all such risks by using the Protocol.',
  },
  {
    title: '6. No Financial Advice',
    body: 'Nothing contained in the Protocol, its website, documentation, or communications constitutes financial, investment, legal, or tax advice. The Protocol is a technology platform that enables peer-to-peer DeFi interactions. You should consult with qualified professionals before making any financial decisions. Past performance of TOWELI, liquidity pools, or staking rewards does not guarantee or predict future results. All yield projections and APY figures are estimates and may change at any time.',
  },
  {
    title: '7. Fees',
    body: 'The Protocol charges the following fees: a 0.3% fee on all token swaps executed through the AMM; a 25% early withdrawal penalty on staked positions withdrawn before their lock period expires; and protocol fees on NFT lending transactions as determined by the lending contract parameters. Fee structures may be modified through DAO governance proposals. All fees are transparently enforced by the smart contracts and cannot be altered outside of the governance process.',
  },
  {
    title: '8. Intellectual Property',
    body: 'All artwork, branding, visual assets, user interface designs, and proprietary smart contract code associated with Tegridy Farms are owned by the Protocol and its community. You may not reproduce, distribute, modify, or create derivative works from the Protocol\'s intellectual property without prior written consent. The TOWELI token, JBAC NFT collection, and associated brand elements are protected under applicable intellectual property laws. Open-source components are subject to their respective licenses.',
  },
  {
    title: '9. Limitation of Liability',
    body: 'The Protocol is experimental software provided on an "as-is" and "as-available" basis without warranties of any kind, express or implied. To the maximum extent permitted by applicable law, the Protocol, its contributors, developers, and community members shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages arising from your use of or inability to use the Protocol. This includes, without limitation, loss of funds, loss of profits, loss of data, or any other losses resulting from smart contract interactions, market conditions, or third-party actions.',
  },
  {
    title: '10. Governing Law',
    body: 'The governance of these Terms and any disputes arising from the use of the Protocol shall be determined by the Tegridy Farms DAO through its governance mechanisms. As a decentralized protocol, traditional jurisdictional governance may not apply. Users agree to participate in good faith in any dispute resolution process established by the DAO. The Protocol strives to operate in compliance with applicable laws across all jurisdictions where it is accessible.',
  },
  {
    title: '11. Changes to Terms',
    body: 'The Protocol reserves the right to modify, update, or replace these Terms at any time. Material changes will be communicated through the Protocol\'s official channels, including the website and community platforms. Your continued use of the Protocol following any changes constitutes acceptance of the revised Terms. It is your responsibility to review these Terms periodically for updates. The "Last Updated" date at the bottom of this page indicates when the most recent changes were made.',
  },
];

export default function TermsPage() {
  usePageTitle('Terms of Service', 'Terms and conditions for using the Tegridy Farms protocol.');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img
          src={pageArt('terms', 0).src}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
        />
        {/* Dark scrim so the long-form legal copy stays crisp no matter where you scroll */}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(6,12,26,0.55) 0%, rgba(6,12,26,0.78) 40%, rgba(6,12,26,0.85) 100%)' }} />
      </div>

      <div className="relative z-10 max-w-[800px] mx-auto px-4 md:px-6 pt-28 pb-20">
        <m.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">
            Terms of Service
          </h1>
          <p className="text-white/70 text-sm">
            Please read these terms carefully before using the Tegridy Farms protocol.
          </p>
        </m.div>

        <div className="space-y-6">
          {SECTIONS.map((section, i) => (
            <m.div
              key={section.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 + i * 0.05 }}
              className="rounded-2xl p-6 md:p-8 backdrop-blur-md"
              style={{
                background: 'rgba(13, 21, 48, 0.88)',
                border: '1px solid var(--color-purple-12)',
              }}
            >
              <h2 className="text-lg font-semibold text-white mb-3">
                {section.title}
              </h2>
              <p className="text-white/70 text-sm leading-relaxed">
                {section.body}
              </p>
            </m.div>
          ))}
        </div>

        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.8 }}
          className="text-center mt-12"
        >
          <p className="text-white/70 text-xs">
            Last updated: April 2026
          </p>
        </m.div>
      </div>
    </div>
  );
}
