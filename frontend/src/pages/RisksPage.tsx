import { motion } from 'framer-motion';
import { ART } from '../lib/artConfig';
import { usePageTitle } from '../hooks/usePageTitle';

const RISKS = [
  {
    title: '1. Smart Contract Risk',
    body: 'The Tegridy Farms protocol relies on smart contracts deployed on the Ethereum blockchain. While these contracts have undergone testing and auditing, no audit can guarantee the absence of all vulnerabilities. Undiscovered bugs, logic errors, or exploits in the smart contract code could result in partial or total loss of funds deposited into the Protocol. Smart contract risk is inherent to all DeFi protocols and cannot be fully eliminated.',
  },
  {
    title: '2. Market Risk',
    body: 'The TOWELI token and all other digital assets traded through the Protocol are subject to extreme price volatility. The value of TOWELI can decrease significantly in a short period of time, including to zero. Cryptocurrency markets are influenced by speculation, regulatory developments, technological changes, and macroeconomic factors. You should never invest more than you can afford to lose entirely.',
  },
  {
    title: '3. Impermanent Loss',
    body: 'When providing liquidity to automated market maker (AMM) pools, you are exposed to impermanent loss. This occurs when the price ratio of paired tokens changes relative to when you deposited them. In volatile markets, impermanent loss can exceed the trading fees earned, resulting in a net loss compared to simply holding the tokens. The greater the price divergence, the larger the impermanent loss.',
  },
  {
    title: '4. Staking Lock Risk',
    body: 'Staked TOWELI tokens are subject to lock periods chosen by the user. During the lock period, your tokens cannot be withdrawn without incurring a 25% early withdrawal penalty. If market conditions change unfavorably during your lock period, you will be unable to access your full staked amount without accepting this penalty. Locked funds are governed entirely by the smart contract and cannot be released early by any party, including the Protocol developers.',
  },
  {
    title: '5. Liquidation Risk (NFT Lending)',
    body: 'If you borrow against NFT collateral through the Protocol\'s lending feature, failure to repay the loan by the agreed-upon deadline will result in the lender claiming your NFT collateral. This process is automatic and enforced by the smart contract. Once liquidation occurs, it cannot be reversed. The value of your NFT collateral may exceed the loan amount, but you will still lose the NFT if you default on repayment.',
  },
  {
    title: '6. Oracle Risk',
    body: 'While the Tegridy Farms core protocol does not currently rely on external price oracles, partner protocols and integrations may use oracle services for pricing data. Oracle manipulation, downtime, or inaccurate data feeds in these third-party protocols could indirectly affect your positions or the value of assets within the Tegridy Farms ecosystem.',
  },
  {
    title: '7. Regulatory Risk',
    body: 'The regulatory landscape for DeFi protocols is rapidly evolving and varies significantly across jurisdictions. New laws, regulations, or enforcement actions could restrict or prohibit the use of the Protocol, the TOWELI token, or DeFi services in general. The Protocol may need to adapt its operations, restrict access from certain jurisdictions, or modify its features to comply with emerging regulations. Users are responsible for understanding and complying with their local laws.',
  },
  {
    title: '8. Centralization Risk',
    body: 'Certain administrative functions of the Protocol are controlled by admin keys held by the core team. These keys can pause contracts, modify fee parameters, and update contract configurations. While all administrative actions are subject to a 24-48 hour timelock to allow community review, this represents a centralization vector. If admin keys were compromised, an attacker could potentially execute malicious parameter changes after the timelock period.',
  },
  {
    title: '9. Network Risk',
    body: 'The Protocol operates on the Ethereum blockchain, which is subject to network congestion, high gas fees, and occasional downtime. During periods of high network activity, transactions may fail, be delayed, or become prohibitively expensive. Failed transactions still consume gas fees. Network upgrades or hard forks could also temporarily disrupt Protocol functionality or require contract migrations.',
  },
  {
    title: '10. Front-Running & MEV',
    body: 'Transactions submitted to the Ethereum network are visible in the public mempool before they are confirmed. Maximal Extractable Value (MEV) bots may front-run your transactions by submitting competing transactions with higher gas fees, resulting in worse execution prices for your trades. While the Protocol implements slippage protections, sophisticated MEV strategies such as sandwich attacks can still extract value from your transactions.',
  },
  {
    title: '11. No Insurance',
    body: 'Deposits, stakes, and liquidity positions in the Tegridy Farms protocol are not insured by any government agency, insurance fund, or guarantee scheme. There is no equivalent of FDIC, SIPC, or any other deposit protection. If funds are lost due to smart contract exploits, market crashes, or any other reason, there is no insurance mechanism to compensate you. You bear the full risk of any losses incurred.',
  },
  {
    title: '12. No Guarantee of Returns',
    body: 'All yield percentages, APY figures, and reward projections displayed by the Protocol are estimates based on current conditions and are subject to change at any time. Past yields and returns do not predict or guarantee future performance. Farming rewards, staking yields, and trading fees earned may decrease significantly or cease entirely due to changes in market conditions, protocol parameters, or user participation levels.',
  },
  {
    title: '13. Acknowledgment of Risks',
    body: 'By using the Tegridy Farms protocol, you acknowledge that you have read, understood, and accepted all risks described in this disclosure. You confirm that you are using the Protocol voluntarily and at your own risk. You agree that neither the Protocol, its contributors, developers, nor community members shall be held liable for any losses you may incur. DeFi is experimental technology — please exercise caution and never risk more than you can afford to lose.',
  },
];

export default function RisksPage() {
  usePageTitle('Risk Disclosure', 'Important risk factors for using Tegridy Farms DeFi protocol.');

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
            Risk Disclosure
          </h1>
          <p className="text-white/50 text-sm">
            DeFi carries significant risks. Read this page carefully before using the Protocol.
          </p>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="rounded-2xl p-5 mb-8 backdrop-blur-md"
          style={{
            background: 'rgba(234, 179, 8, 0.08)',
            border: '1px solid rgba(234, 179, 8, 0.25)',
          }}
        >
          <div className="flex items-start gap-3">
            <span className="text-yellow-400 text-xl mt-0.5 shrink-0">&#9888;</span>
            <p className="text-yellow-200/90 text-sm leading-relaxed">
              This protocol is experimental software. All interactions with smart contracts carry
              inherent risk. You could lose some or all of your deposited funds. Please do not
              invest more than you can afford to lose.
            </p>
          </div>
        </motion.div>

        <div className="space-y-6">
          {RISKS.map((risk, i) => (
            <motion.div
              key={risk.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.15 + i * 0.05 }}
              className="rounded-2xl p-6 md:p-8 backdrop-blur-md"
              style={{
                background: 'rgba(13, 21, 48, 0.6)',
                border: '1px solid var(--color-purple-12)',
              }}
            >
              <div className="flex items-start gap-3">
                <span className="text-amber-400 text-lg mt-0.5 shrink-0">&#9888;</span>
                <div>
                  <h2 className="text-lg font-semibold text-white mb-3">
                    {risk.title}
                  </h2>
                  <p className="text-white/70 text-sm leading-relaxed">
                    {risk.body}
                  </p>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.9 }}
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
