import { motion } from 'framer-motion';
import { ART } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';

const SECTIONS = [
  {
    title: '1. Information We Collect',
    body: 'The Tegridy Farms protocol interacts with publicly available blockchain data. This includes your public wallet address when you connect to the Protocol, transaction data that is permanently recorded on the Ethereum blockchain, and user preferences stored locally in your browser via localStorage (such as theme settings, slippage tolerance, and dismissed notifications). All blockchain data is inherently public and accessible to anyone. We do not associate wallet addresses with personal identities.',
  },
  {
    title: '2. Information We Don\'t Collect',
    body: 'Tegridy Farms does not collect any personally identifiable information. We do not collect or store: email addresses, names, phone numbers, or physical addresses; IP addresses or geolocation data; browser fingerprints or device identifiers; tracking cookies or cross-site tracking mechanisms; social media profiles or linked accounts. The Protocol is designed to operate without requiring any personal data from its users.',
  },
  {
    title: '3. Analytics',
    body: 'We may use minimal, privacy-preserving analytics to monitor Protocol health and performance. This includes aggregate metrics such as total value locked (TVL), transaction volume, and active wallet counts. These analytics are derived from publicly available on-chain data and do not involve tracking individual users. No third-party analytics scripts are injected into the Protocol\'s frontend that would track user behavior.',
  },
  {
    title: '4. Third-Party Services',
    body: 'The Protocol interfaces with the following third-party services to function: Alchemy, which serves as our RPC provider to relay transactions to the Ethereum network; Etherscan, used for linking to transaction details and contract verification; and Uniswap, which provides DEX liquidity and pricing data. Each of these services has its own privacy policy. We encourage you to review their respective policies. The Protocol does not share user data with these services beyond what is inherent in standard Ethereum RPC calls.',
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
  usePageTitle('Privacy Policy');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <img
          src={ART.forestScene.src}
          alt=""
          loading="lazy"
          className="w-full h-full object-cover"
        />
      </div>

      <div className="relative z-10 max-w-[800px] mx-auto px-4 md:px-6 pt-28 pb-20">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="text-center mb-12"
        >
          <h1 className="text-3xl md:text-4xl font-bold text-white mb-3">
            Privacy Policy
          </h1>
          <p className="text-white/50 text-sm">
            How Tegridy Farms handles your data — spoiler: we don't collect any.
          </p>
        </motion.div>

        <div className="space-y-6">
          {SECTIONS.map((section, i) => (
            <motion.div
              key={section.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.1 + i * 0.05 }}
              className="rounded-2xl p-6 md:p-8 backdrop-blur-md"
              style={{
                background: 'rgba(13, 21, 48, 0.6)',
                border: '1px solid rgba(139, 92, 246, 0.12)',
              }}
            >
              <h2 className="text-lg font-semibold text-white mb-3">
                {section.title}
              </h2>
              <p className="text-white/70 text-sm leading-relaxed">
                {section.body}
              </p>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.8 }}
          className="text-center mt-12"
        >
          <p className="text-white/40 text-xs">
            Last updated: April 2026
          </p>
        </motion.div>
      </div>
    </div>
  );
}
