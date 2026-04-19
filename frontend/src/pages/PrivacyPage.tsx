import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { ArtImg } from '../components/ArtImg';

const SECTIONS = [
  {
    title: '1. Information We Collect',
    body: 'The Tegridy Farms protocol interacts with publicly available blockchain data. This includes your public wallet address when you connect to the Protocol and transaction data that is permanently recorded on the Ethereum blockchain. User preferences are stored locally in your browser via localStorage (such as theme settings, slippage tolerance, and dismissed notifications); the Protocol also stores a random per-tab session identifier in sessionStorage to de-duplicate analytics events within a session. All blockchain data is inherently public and accessible to anyone. We do not associate wallet addresses with personal identities. See Section 3 for the specific first-party analytics events we emit.',
  },
  {
    title: '2. Information We Don\'t Collect',
    body: 'Tegridy Farms does not collect any personally identifiable information. We do not collect or store: email addresses, names, phone numbers, or physical addresses; browser fingerprints or device identifiers; tracking cookies or cross-site tracking mechanisms; social media profiles or linked accounts; or geolocation data. We do not deliberately transmit your IP address in any event payload. Note that when your browser makes a request to any web endpoint — ours or a third party\'s — the receiving server necessarily sees the connecting IP as part of standard HTTP; that information may appear in transient access logs, but it is not retained in our analytics records or linked to your wallet or session.',
  },
  {
    title: '3. Analytics',
    body: 'We operate a first-party, privacy-preserving analytics pipeline to monitor Protocol health. No third-party analytics or tracking scripts are loaded. When enabled (controlled by the VITE_ANALYTICS_ENDPOINT build-time environment variable), the frontend batches and sends a small set of event records to our own analytics endpoint. The events we emit are: page views, swaps (token symbols, amount, route), stakes and unstakes (amount, lock duration), NFT purchases (collection, token ID, price), wallet-connect events (the name of the wallet provider such as "MetaMask" or "Rainbow" — not your wallet address), and client-side errors (error message and the feature context it occurred in). Every event record additionally carries a random session identifier regenerated per browser-tab session and a timestamp. The event records do NOT include your wallet address, your IP address, your name, your email, browser fingerprints, or any personally identifiable information, and the session identifier is not linked to any identity. If no analytics endpoint is configured, or in development, events are logged to the browser console only.',
  },
  {
    title: '4. Third-Party Services',
    body: 'The Protocol interfaces with the following third-party services to function: Alchemy and other public Ethereum RPC providers, which relay transactions to the Ethereum network; block explorers such as Etherscan and Basescan, used for linking to transaction details and contract verification; WalletConnect, for wallet-to-dapp connectivity; GeckoTerminal and other price oracles, for displaying token prices; and DEX aggregators (Odos, 0x, 1inch, CoW Swap, LiFi, KyberSwap, OpenOcean, Paraswap) when you request a swap quote. When you make a request to any of these services from your browser, they necessarily see your IP address as part of standard HTTP, and some will see your wallet address if it is included in the request payload (for example, an aggregator quote asks for the "taker" address in order to simulate the swap). This is inherent to how the web and Ethereum work; we do not deliberately transmit additional data. Each of these services has its own privacy policy — we encourage you to review them.',
  },
  {
    title: '5. Data Storage',
    body: 'All user preference data is stored exclusively on the client side using your browser\'s localStorage. No user data is stored on any server-side database operated by Tegridy Farms. Transaction data is stored on the Ethereum blockchain, which is a public, immutable ledger not controlled by the Protocol. You have full control over your locally stored data and can clear it at any time through your browser settings.',
  },
  {
    title: '6. Your Rights',
    body: 'You have complete control over your interaction with the Protocol. You may disconnect your wallet from the Protocol at any time, ending the session. You may clear all localStorage data associated with the Protocol through your browser settings. You may stop using the Protocol at any time without any obligation. Since we do not collect personal data, there is no personal data to request, modify, or delete from our systems. Your on-chain transaction history is permanently recorded on the blockchain and cannot be altered or removed by any party.',
  },
  {
    title: '7. Security',
    body: 'The Protocol employs industry-standard security measures including: HTTPS encryption for all frontend communications; Content Security Policy (CSP) headers to prevent cross-site scripting attacks; no storage of sensitive data such as private keys, seed phrases, or passwords; and smart contract audits to identify and remediate vulnerabilities. Despite these measures, no system is completely secure. Users are responsible for maintaining the security of their own wallets and devices.',
  },
  {
    title: '8. Children',
    body: 'The Tegridy Farms protocol is not intended for use by individuals under the age of 18. We do not knowingly facilitate interactions with minors. If you are under 18, you must not use the Protocol. Since we do not collect personal information, we cannot verify ages, but we rely on users to comply with this requirement.',
  },
  {
    title: '9. Changes to This Policy',
    body: 'We may update this Privacy Policy from time to time to reflect changes in our practices or for other operational, legal, or regulatory reasons. Any updates will be posted on this page with a revised "Last Updated" date. Your continued use of the Protocol after any changes constitutes acceptance of the updated Privacy Policy. We encourage you to review this page periodically.',
  },
  {
    title: '10. Contact',
    body: 'For security-related inquiries, vulnerability reports, or questions about this Privacy Policy, please contact us at security@tegridyfarms.xyz. For general community discussions, join our official channels linked on the Protocol\'s website.',
  },
];

export default function PrivacyPage() {
  usePageTitle('Privacy Policy', 'How Tegridy Farms handles your data and privacy.');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="privacy" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        {/* Dark scrim so the long-form privacy copy stays crisp no matter where you scroll */}
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
            Privacy Policy
          </h1>
          <p className="text-white/70 text-sm">
            How Tegridy Farms handles your data — plain English, no dark patterns.
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
            Last updated: April 16, 2026
          </p>
        </m.div>
      </div>
    </div>
  );
}
