import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { ArtImg } from '../components/ArtImg';
import {
  SWAP_FEE_BPS,
  isDeployed,
  TEGRIDY_LENDING_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
  GITHUB_BLOB_BASE,
} from '../lib/constants';

/**
 * HONESTY 2026-07-24: these statuses were hardcoded 'Not yet deployed' and went
 * stale the moment the 2026-07-16 batch was un-gated (2026-07-21) — the table
 * then contradicted the sibling Contracts tab, which listed the same features as
 * live. Derive from the address map so the row can never drift again.
 */
const deployStatus = (addr: string): 'Live' | 'Not yet deployed' =>
  isDeployed(addr) ? 'Live' : 'Not yet deployed';

// Protocol-specific risks that reflect the actual current state of memetics.finance
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
    body: 'Administrative functions are held by one EOA today. A 24–48 hour timelock delays sensitive parameter changes (treasury, fee recipients, fees, emission budget, oracle floors), but some operational setters (e.g. stake caps) and emergency pause act immediately, and one key loss or compromise still puts the timelocked parameters at risk after the delay elapses. A multisig migration is the next operational milestone; until it lands, size deposits as if the single-key assumption holds.',
  },
  {
    title: 'Patched contracts not yet redeployed on-chain',
    status: 'Mitigated',
    body: 'Resolved by the June 6, 2026 relaunch: the live protocol was redeployed from scratch from a new deployer, so every contract running on mainnet today carries fresh bytecode that includes the previously-merged fixes (including the autoMaxLock/getReward stuck-state fix and the Pass-7 remediations). Since then, four more went live from the audited 2026-07-16 batch and were un-gated on 2026-07-21: premium (Gold Card), NFT lending, the NFT pool factory, and the launchpad. Four more — gauge voting, vote incentives, community grants and meme bounties — are ALSO deployed on mainnet, from the same 2026-07-16 batch, and are unpaused; their addresses are still zeroed in this app, so the surfaces are gated here even though the contracts exist. Verify any of them on Etherscan from the Contracts page. Only ETH lending, restaking and the Pro Pass are genuinely not deployed: ETH lending waits on a price oracle, restaking on an external re-audit and multisig custody (its contract-size problem was solved 2026-08-19), and the Pro Pass is a collection that has not been minted. Nothing anywhere is running old bytecode.',
  },
  {
    title: 'Treasury is an EOA / multisig, not a smart contract',
    status: 'Active',
    body: 'The treasury address that receives fee splits, swap-fee surplus, sweep destinations, and the non-recycled portion of early-withdrawal penalties is an externally-owned account or multisig — not a Tegridy contract. There is no on-chain treasury policy, no withdrawal timelock at the treasury layer, and no on-chain audit trail of treasury outflows. Whatever entity controls the treasury key controls those funds outright. The protocol contracts use the standard 24–48h timelock to change the treasury address; the treasury itself is governed off-chain.',
  },
  {
    title: 'Owner can cancel approved community-grant proposals',
    status: 'Active',
    body: 'After a CommunityGrants proposal passes its veTOWELI vote and reaches Approved status, the owner has a 3-day permissionless-execution window during which they can call cancelProposal instantly with no timelock. This effectively converts approved community votes from binding to advisory until the permissionless window opens. The owner cannot redirect funds — cancellation refunds the proposer deposit and releases the reserved budget — but the owner can veto. Recovery path: a proposer can re-submit, or any signer can execute the proposal once the 3-day owner-only window elapses.',
  },
  {
    title: 'No paid human audit by a recognised firm',
    status: 'Active',
    // HONESTY PASS 2026-09-02 (audit TF-030 / TF-065): this used to say "one
    // external review (Spartan, April 2026)". SPARTAN_AUDIT.txt's own Appendix C
    // says "The reviewer is an AI assistant (Claude, Anthropic) acting at the
    // direction of the repository owner" — so the methodology was external, the
    // reviewer was not, and "external review" read as an independent party.
    body: 'The protocol has NO third-party audit. It has one review run to an external methodology (Spartan, April 2026) which its own closing appendix states was written by an AI assistant at the owner\u2019s direction, and one pre-release document (March 2026). Everything else is internal AI-agent sweeps. None of these substitute for a paid audit by OpenZeppelin / Trail of Bits / Spearbit / Cyfrin / Code4rena. Engaging one is on the roadmap and not yet scheduled.',
  },
  {
    title: 'Thin market / low on-chain liquidity',
    status: 'Active',
    body: 'TOWELI is a low-cap token with modest trading volume and a shallow native pair. Anyone entering or exiting a large staking or LP position will experience measurable slippage, and rewards accrue off a revenue base that tracks DEX volume. Treat the APR numbers as estimates on a volume base that does not yet exist at scale.',
  },
  {
    title: 'Satirical brand exposure',
    status: 'Active',
    // The blanket 2026-08-31 rename would have made this claim FALSE — the
    // venue's own name is not the parody; Towelie is. Reworded by hand, and
    // deliberately NOT deleted: retiring the Tegridy name narrows the
    // exposure but the character and the art still ship, so the disclosure
    // still has something to disclose.
    body: 'The "Towelie" character, his voice and the accompanying art are a parody reference to a third-party IP (South Park). The "Tegridy Farms" name was retired from the app on 2026-08-31 and the venue now speaks as memetics.finance, which narrows this exposure without removing it: the character and the art still ship. The NOTICE.md file invokes fair-use and parody defences, but the protocol has not sought or received any clearance. A takedown request or rebrand instruction from the IP holder at any point would affect branding and front-end surfaces.',
  },
  {
    title: 'Single maintainer',
    status: 'Active',
    body: 'The protocol is maintained by one developer. Response to incidents, emergency pauses, and bug-bounty triage is bounded by that person being online. SECURITY.md documents the disclosure channel; realistic expectations on turnaround should reflect the maintainer count.',
  },
  {
    title: 'Anyone can launch a token, and a launch cannot be undone',
    status: 'Active',
    body: 'The token launcher is permissionless: there is no application, no human approval and no allowlist, so any member of the public can deploy an ERC-20 through it on Ethereum mainnet. Nothing about a token appearing here is an endorsement — the Fact Sheet and its gate tier are automated structural disclosures (template, mint/pause/blacklist/upgrade powers, LP lock, insider vesting, fee split) read at one moment in time, not a security audit, a valuation or a safety warranty, and a token that clears a tier can still go to zero. For creators the exposure runs the other way: the launch transaction is irreversible and the fee constitution is fixed on-chain at creation, so a mistyped supply, market-cap band or beneficiary address is permanent, and the person who launches is the issuer for every legal purpose in their own jurisdiction. We can decline to surface a token in this app; we cannot alter or remove it on-chain.',
  },
  {
    title: 'NFT collateral concentration',
    status: 'Active',
    body: 'The staking boost multiplier and NFT lending surface tie into specific collections (JBAC, JBAY Gold, GNSS). If any of those collections become illiquid or lose marketplace support, the boost ceiling and NFT-loan market depth degrade silently — positions still function, but the economic assumptions behind them thin out.',
  },
];

// Every min/max/cap in the protocol, with the rationale and live status. Surfaced
// here as a single reference so users are never surprised by a hidden limit (the
// live forms also show their own limits inline). Values mirror the contracts; the
// mutable ones (staking caps, swap fee, lending principal) can change via governance.
const PROTOCOL_LIMITS: Array<{
  feature: string;
  status: 'Live' | 'Not yet deployed';
  items: Array<{ label: string; value: string; why: string }>;
}> = [
  {
    feature: 'Staking (TOWELI)',
    status: 'Live',
    items: [
      { label: 'Minimum stake', value: '100 TOWELI', why: 'Blocks dust positions' },
      { label: 'Maximum per wallet', value: '50,000 TOWELI', why: 'Testing-phase cap — to be raised' },
      { label: 'Protocol-wide cap', value: '5,000,000 TOWELI', why: 'Testing-phase safety ceiling' },
      { label: 'Lock duration', value: '7 days – 4 years', why: 'Longer lock = higher boost' },
      { label: 'Boost range', value: '0.4× – 4.0× (4.5× with JBAC NFT)', why: 'Rewards long-term locking' },
      { label: 'Early-exit penalty', value: '25%', why: 'Sent to the protocol treasury' },
    ],
  },
  {
    feature: 'LP Farming',
    status: 'Live',
    items: [
      { label: 'Minimum stake', value: '100 LP', why: 'Anti-dust — needs a deeper pool to be reachable; lowering planned' },
      { label: 'Max boost', value: '4.5×', why: 'Shared from your TOWELI staking position' },
    ],
  },
  {
    feature: 'Swap',
    status: 'Live',
    items: [
      { label: 'Protocol fee', value: `${SWAP_FEE_BPS / 100}% (1% hard cap)`, why: 'Revenue to stakers; fee routing being finalized' },
      { label: 'Pool trading fee', value: '0.3%', why: 'Standard AMM fee, paid to liquidity providers' },
      { label: 'Slippage', value: 'You choose', why: 'Caps adverse price movement / MEV' },
    ],
  },
  {
    feature: 'Lending (ETH)',
    status: deployStatus(TEGRIDY_LENDING_ADDRESS),
    items: [
      { label: 'Loan principal', value: '0.001 – 1,000 ETH', why: 'Dust floor + whale cap' },
    ],
  },
  {
    feature: 'NFT Lending',
    status: deployStatus(TEGRIDY_NFT_LENDING_ADDRESS),
    items: [
      { label: 'Loan duration', value: '1 – 365 days', why: 'Sane loan-term bounds' },
      { label: 'Minimum offer', value: '~0.001 ETH', why: 'Blocks dust offers' },
    ],
  },
  {
    feature: 'NFT Launchpad / Drops',
    status: deployStatus(TEGRIDY_LAUNCHPAD_V2_ADDRESS),
    items: [
      { label: 'Max collection supply', value: '100,000', why: 'Sanity bound at creation' },
      { label: 'Max mint price', value: '100 ETH', why: 'Sanity bound at creation' },
      { label: 'Per-wallet mint cap', value: 'Set per drop', why: 'Anti-whale — the creator’s choice' },
    ],
  },
];

const RISKS = [
  {
    title: '1. Smart Contract Risk',
    body: 'The memetics.finance protocol relies on smart contracts deployed on the Ethereum blockchain. While these contracts have undergone testing and auditing, no audit can guarantee the absence of all vulnerabilities. Undiscovered bugs, logic errors, or exploits in the smart contract code could result in partial or total loss of funds deposited into the Protocol. Smart contract risk is inherent to all DeFi protocols and cannot be fully eliminated.',
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
    body: 'While the memetics.finance core protocol does not currently rely on external price oracles, partner protocols and integrations may use oracle services for pricing data. Oracle manipulation, downtime, or inaccurate data feeds in these third-party protocols could indirectly affect your positions or the value of assets within the memetics.finance ecosystem.',
  },
  {
    title: '7. Regulatory Risk',
    body: 'The regulatory landscape for DeFi protocols is rapidly evolving and varies significantly across jurisdictions. New laws, regulations, or enforcement actions could restrict or prohibit the use of the Protocol, the TOWELI token, or DeFi services in general. The Protocol may need to adapt its operations, restrict access from certain jurisdictions, or modify its features to comply with emerging regulations. Users are responsible for understanding and complying with their local laws.',
  },
  {
    title: '8. Centralization Risk',
    body: 'Certain administrative functions of the Protocol are controlled by admin keys held by the core team. These keys can pause contracts, modify fee parameters, and update contract configurations. Sensitive administrative actions (treasury, fee recipients, fees, emission budget, oracle floors) are subject to a 24-48 hour timelock to allow community review, but emergency pause and some operational setters take effect immediately, and this still represents a centralization vector. If admin keys were compromised, an attacker could execute the immediate actions at once and the timelocked ones after the delay.',
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
    body: 'Deposits, stakes, and liquidity positions in the memetics.finance protocol are not insured by any government agency, insurance fund, or guarantee scheme. There is no equivalent of FDIC, SIPC, or any other deposit protection. If funds are lost due to smart contract exploits, market crashes, or any other reason, there is no insurance mechanism to compensate you. You bear the full risk of any losses incurred.',
  },
  {
    title: '12. No Guarantee of Returns',
    body: 'All yield percentages, APY figures, and reward projections displayed by the Protocol are estimates based on current conditions and are subject to change at any time. Past yields and returns do not predict or guarantee future performance. Farming rewards, staking yields, and trading fees earned may decrease significantly or cease entirely due to changes in market conditions, protocol parameters, or user participation levels.',
  },
  {
    title: '13. Acknowledgment of Risks',
    body: 'By using the memetics.finance protocol, you acknowledge that you have read, understood, and accepted all risks described in this disclosure. You confirm that you are using the Protocol voluntarily and at your own risk. You agree that neither the Protocol, its contributors, developers, nor community members shall be held liable for any losses you may incur. DeFi is experimental technology — please exercise caution and never risk more than you can afford to lose.',
  },
];

export default function RisksPage() {
  usePageTitle('Risk Disclosure', 'Important risk factors for using memetics.finance DeFi protocol.');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="risks" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        {/* Dark scrim so the risk copy stays legible against the chaos-scene bg */}
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(6,12,26,0.80) 0%, rgba(6,12,26,0.85) 40%, rgba(6,12,26,0.90) 100%)' }} />
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
              Protocol-specific risks that reflect the current state of memetics.finance. Not legalese — read them.
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
              href={`${GITHUB_BLOB_BASE}/FIX_STATUS.md`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-white/70 hover:text-white"
            >
              FIX_STATUS.md
            </a>{' '}
            and{' '}
            <a
              href={`${GITHUB_BLOB_BASE}/AUDITS.md`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-white/70 hover:text-white"
            >
              AUDITS.md
            </a>
            .
          </p>
        </m.section>

        <m.section
          aria-labelledby="limits-heading"
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
          className="mb-10"
        >
          <div className="mb-4">
            <h2 id="limits-heading" className="text-2xl font-semibold text-white mb-1">
              Protocol limits &amp; parameters
            </h2>
            <p className="text-white/60 text-sm">
              Every minimum, maximum, and cap — what it is and why. So nothing surprises you mid-transaction.
            </p>
          </div>

          <ul className="space-y-4 list-none p-0 m-0">
            {PROTOCOL_LIMITS.map((grp, i) => (
              <m.li
                key={grp.feature}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.35, delay: 0.12 + i * 0.04 }}
                className="rounded-2xl p-5 md:p-6 backdrop-blur-md"
                style={{
                  background: 'rgba(13, 21, 48, 0.82)',
                  border: '1px solid var(--color-purple-20)',
                }}
              >
                <div className="flex items-center flex-wrap gap-2 mb-3">
                  <h3 className="text-lg font-semibold text-white">{grp.feature}</h3>
                  <span
                    className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full"
                    style={{
                      background: grp.status === 'Live' ? 'rgba(34, 197, 94, 0.18)' : 'rgba(148, 163, 184, 0.15)',
                      color: grp.status === 'Live' ? '#4ade80' : '#cbd5e1',
                      border: grp.status === 'Live' ? '1px solid rgba(74, 222, 128, 0.4)' : '1px solid rgba(148, 163, 184, 0.3)',
                    }}
                  >
                    {grp.status}
                  </span>
                </div>
                <div className="space-y-2">
                  {grp.items.map((it) => (
                    <div key={it.label} className="flex flex-col sm:flex-row sm:items-baseline gap-0.5 sm:gap-3">
                      <span className="text-white/60 text-[13px] sm:w-44 sm:shrink-0">{it.label}</span>
                      <span className="text-white font-mono text-[13px] sm:w-52 sm:shrink-0">{it.value}</span>
                      <span className="text-white/45 text-[12px] flex-1">{it.why}</span>
                    </div>
                  ))}
                </div>
              </m.li>
            ))}
          </ul>

          <p className="text-white/55 text-xs mt-4 leading-relaxed">
            Live forms also show their own limits inline. Mutable values (staking caps, swap fee, lending principal)
            can change via governance and are read on-chain where shown.
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
            Last updated: August 2026
          </p>
        </m.div>
      </div>
    </div>
  );
}
