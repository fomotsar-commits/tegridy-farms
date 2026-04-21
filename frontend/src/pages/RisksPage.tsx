import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { ArtImg } from '../components/ArtImg';

// Protocol-specific risks that reflect the actual current state of Tegridy Farms
// (as of the last RisksPage refresh). Distinct from the generic DeFi risks
// below. Each item names the specific exposure and the honest mitigation status.
const PROTOCOL_RISKS: Array<{
  title: string;
  status: 'Active' | 'In progress' | 'Mitigated';
  body: string;
}> = [
  {
    title: 'Single-operator admin key (no multisig yet)',
    status: 'Active',
    body: 'Administrative functions are held by one EOA today. A 24–48 hour timelock delays every parameter change, but one key loss or compromise still puts those parameters at risk after the delay elapses. A multisig migration is the next operational milestone; until it lands, size deposits as if the single-key assumption holds.',
  },
  {
    title: 'Patched contracts not yet redeployed on-chain',
    status: 'In progress',
    body: 'Several contracts have fixes merged in the repository but are still running the older bytecode on mainnet: VoteIncentives, TegridyLending, TegridyNFTPool (template + factory), TegridyFeeHook (with the patched constructor), and TegridyLaunchpadV2. Until the redeploys broadcast, the on-chain surfaces carry the pre-fix behaviour — see FIX_STATUS.md for the exact list and blast radius.',
  },
  {
    title: 'No paid human audit by a recognised firm',
    status: 'Active',
    body: 'The protocol has one external review (Spartan, April 2026) and one pre-release external doc (March 2026). Everything else is internal AI-agent sweeps. We do not claim those substitute for a paid audit by OpenZeppelin / Trail of Bits / Spearbit / Cyfrin / Code4rena. Engaging one is on the roadmap and not yet scheduled.',
  },
  {
    title: 'Thin market / low on-chain liquidity',
    status: 'Active',
    body: 'TOWELI is a low-cap token with modest trading volume and a shallow native pair. Anyone entering or exiting a large staking or LP position will experience measurable slippage, and rewards accrue off a revenue base that tracks DEX volume. Treat the APR numbers as estimates on a volume base that does not yet exist at scale.',
  },
  {
    title: 'Satirical brand exposure',
    status: 'Active',
    body: 'The "Tegridy Farms" / "Towelie" brand is a parody reference to a third-party IP (South Park). The NOTICE.md file invokes fair-use and parody defences, but the protocol has not sought or received any clearance. A takedown request or rebrand instruction from the IP holder at any point would affect domain, branding, and front-end surfaces.',
  },
  {
    title: 'Single maintainer',
    status: 'Active',
    body: 'The protocol is maintained by one developer. Response to incidents, emergency pauses, and bug-bounty triage is bounded by that person being online. SECURITY.md documents the disclosure channel; realistic expectations on turnaround should reflect the maintainer count.',
  },
  {
    title: 'NFT collateral concentration',
    status: 'Active',
    body: 'The staking boost multiplier and NFT lending surface tie into specific collections (JBAC, JBAY Gold, GNSS). If any of those collections become illiquid or lose marketplace support, the boost ceiling and NFT-loan market depth degrade silently — positions still function, but the economic assumptions behind them thin out.',
  },
];

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
        <ArtImg pageId="risks" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        {/* Dark scrim so the risk copy stays legible against the chaos-scene bg */}
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
            Risk Disclosure
          </h1>
          <p className="text-white/70 text-sm">
            DeFi carries significant risks. Read this page carefully before using the Protocol.
          </p>
        </m.div>

        <m.div
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
        </m.div>

        <m.section
          aria-labelledby="protocol-risks-heading"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="mb-10"
        >
          <div className="mb-4">
            <h2
              id="protocol-risks-heading"
              className="text-2xl font-semibold text-white mb-1"
            >
              What can actually go wrong — as of today
            </h2>
            <p className="text-white/60 text-sm">
              Protocol-specific risks that reflect the current state of Tegridy Farms. Not legalese — read them.
            </p>
          </div>

          <ul className="space-y-4 list-none p-0 m-0">
            {PROTOCOL_RISKS.map((risk, i) => (
              <m.li
                key={risk.title}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: 0.12 + i * 0.04 }}
                className="rounded-2xl p-6 md:p-7 backdrop-blur-md"
                style={{
                  background: 'rgba(48, 12, 16, 0.82)',
                  border: '1px solid rgba(248, 113, 113, 0.32)',
                }}
              >
                <div className="flex items-start gap-3">
                  <span className="text-red-400 text-lg mt-0.5 shrink-0" aria-hidden="true">&#9888;</span>
                  <div className="flex-1">
                    <div className="flex items-center flex-wrap gap-2 mb-3">
                      <h3 className="text-lg font-semibold text-white">
                        {risk.title}
                      </h3>
                      <span
                        className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
                        style={{
                          background:
                            risk.status === 'Mitigated'
                              ? 'rgba(34, 197, 94, 0.18)'
                              : risk.status === 'In progress'
                                ? 'rgba(234, 179, 8, 0.2)'
                                : 'rgba(248, 113, 113, 0.22)',
                          color:
                            risk.status === 'Mitigated'
                              ? '#4ade80'
                              : risk.status === 'In progress'
                                ? '#fde047'
                                : '#fca5a5',
                          border:
                            risk.status === 'Mitigated'
                              ? '1px solid rgba(74, 222, 128, 0.4)'
                              : risk.status === 'In progress'
                                ? '1px solid rgba(253, 224, 71, 0.4)'
                                : '1px solid rgba(252, 165, 165, 0.4)',
                        }}
                      >
                        {risk.status}
                      </span>
                    </div>
                    <p className="text-white/75 text-sm leading-relaxed">
                      {risk.body}
                    </p>
                  </div>
                </div>
              </m.li>
            ))}
          </ul>

          <p className="text-white/55 text-xs mt-4 leading-relaxed">
            Rolling status is tracked in{' '}
            <a
              href="https://github.com/fomotsar-commits/tegridy-farms/blob/main/FIX_STATUS.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-white/70 hover:text-white"
            >
              FIX_STATUS.md
            </a>{' '}
            and{' '}
            <a
              href="https://github.com/fomotsar-commits/tegridy-farms/blob/main/AUDITS.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-white/70 hover:text-white"
            >
              AUDITS.md
            </a>
            .
          </p>
        </m.section>

        <div className="mb-4">
          <h2 className="text-xl font-semibold text-white mb-1">
            General DeFi risk disclosure
          </h2>
          <p className="text-white/60 text-sm">
            These risks apply to any DeFi protocol, including this one.
          </p>
        </div>

        <div className="space-y-6">
          {RISKS.map((risk, i) => (
            <m.div
              key={risk.title}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4, delay: 0.15 + i * 0.05 }}
              className="rounded-2xl p-6 md:p-8 backdrop-blur-md"
              style={{
                background: 'rgba(13, 21, 48, 0.88)',
                border: '1px solid var(--color-purple-12)',
              }}
            >
              <div className="flex items-start gap-3">
                <span className="text-amber-400 text-lg mt-0.5 shrink-0" aria-hidden="true">&#9888;</span>
                <div>
                  <h3 className="text-lg font-semibold text-white mb-3">
                    {risk.title}
                  </h3>
                  <p className="text-white/70 text-sm leading-relaxed">
                    {risk.body}
                  </p>
                </div>
              </div>
            </m.div>
          ))}
        </div>

        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.9 }}
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
