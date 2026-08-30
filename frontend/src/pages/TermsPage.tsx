import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { ArtImg } from '../components/ArtImg';
import { SWAP_FEE_BPS } from '../lib/constants';
import { DEFAULT_FEE_CONSTITUTION, LAUNCH_FEE_TIER, TOWELI_NUMERAIRE } from '../lib/launcher/config';
import { protocolFeeSink } from '../lib/launcher/launchService';
import { MIGRATION_POOL } from '../lib/launcher/airlock';

// Render the swap fee straight from the on-chain-mirrored constant so Terms can
// never drift from the Risks page / contract again (F373/F440).
const SWAP_FEE_PCT = (SWAP_FEE_BPS / 100).toFixed(2).replace(/\.?0+$/, '');

// Same rule for the launcher's fee figures. A launch's split is fixed on-chain by the
// locker at create time and published in that launch's Fact Sheet, so the Terms must
// FOLLOW the constants the wizard submits rather than restate them in prose.
// LAUNCH_FEE_TIER is in hundredths of a basis point (10000 = 1%).
const LAUNCH_FEE_PCT = (LAUNCH_FEE_TIER / 10_000).toFixed(2).replace(/\.?0+$/, '');
// The GRADUATED pool's fee — a different number from the auction fee above, and the one
// the fee constitution actually divides. Rendered from the same constant airlock.ts passes
// to withMigration(), so the Terms cannot drift from what is deployed.
const MIGRATION_POOL_FEE_PCT = (MIGRATION_POOL.fee / 10_000).toFixed(2).replace(/\.?0+$/, '');
// The protocol line's label comes from protocolFeeSink() — the single source of truth
// shared with the Fact Sheet — so the Terms can never name a recipient the routing
// cannot actually pay (the sink is the treasury Safe, NOT staker yield).
const PROTOCOL_FEE_RECIPIENT = protocolFeeSink().recipient;
// A locker position carries TWO currencies and they do not land in the same place: on an
// ETH pair the numeraire leg reaches stakers, on a TOWELI pair both legs are ERC20 and sweep
// to the treasury. Render BOTH from protocolFeeSink so §7 cannot drift from the routing.
const PROTOCOL_FEE_RECIPIENT_EXOTIC = protocolFeeSink(TOWELI_NUMERAIRE).recipient;
const PROTOCOL_FEE_PCT = (
  (DEFAULT_FEE_CONSTITUTION.find((l) => l.role === 'protocol-stakers')?.shareBps ?? 0) / 100
).toFixed(0);
const FEE_CONSTITUTION_TEXT = DEFAULT_FEE_CONSTITUTION.map(
  (l) =>
    `${l.role === 'protocol-stakers' ? PROTOCOL_FEE_RECIPIENT : l.recipient} ${(l.shareBps / 100).toFixed(0)}%`,
).join(', ');

// Exported for the content guard in termsLauncherCoverage.test.ts, which pins that the
// launcher rails described here stay in step with the launcher feature flags.
export const SECTIONS = [
  {
    title: '1. Acceptance of Terms',
    body: 'By accessing or using the Tegridy Farms protocol ("Protocol"), including its smart contracts, website, and associated interfaces, you agree to be bound by these Terms of Service ("Terms"). If you do not agree to these Terms, you must not access or use the Protocol. Your continued use of the Protocol constitutes acceptance of any updates or modifications to these Terms.',
  },
  {
    title: '2. Description of Services',
    body: 'Tegridy Farms is a decentralized finance (DeFi) protocol built on the Ethereum blockchain. The Protocol provides the following services: yield farming and liquidity provision through automated market maker pools; token swapping via integrated DEX functionality; TOWELI token staking with vote-escrow mechanics; peer-to-peer NFT lending with collateral-based loan origination; an NFT AMM for automated NFT trading; and a token launcher through which any user may create, issue and deploy a new ERC-20 token on Ethereum mainnet using the third-party Doppler protocol, paired against either native ETH or TOWELI, which runs a dynamic auction and graduates into a Uniswap V4 pool. The Protocol previously published a Solana sub-brand launch rail over a third-party Dynamic Bonding Curve program. THAT RAIL WAS RETIRED ON 2026-08-23 and the Protocol offers no Solana launch service at this time. The Protocol\'s own Solana launch program is written but is not deployed on any cluster, and no Solana token can be created through the Protocol until it is. All Ethereum services are provided through non-custodial smart contracts deployed on the Ethereum mainnet.',
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
    body: `The Protocol charges the following fees: a ${SWAP_FEE_PCT}% fee on token swaps routed through the SwapFeeRouter (SWAP_FEE_BPS = ${SWAP_FEE_BPS}; capped at 1.00% / MAX_FEE_BPS = 100 by contract); a 25% early withdrawal penalty on staked positions withdrawn before their lock period expires; and protocol fees on NFT lending transactions as determined by the lending contract parameters. Fee structures may be modified by the protocol admin subject to the on-chain timelock. All fees are transparently enforced by the smart contracts and cannot be altered outside of the timelocked admin process. Separately, the token launcher charges no fee to create a launch — you pay only Ethereum network gas for the deployment transaction. A launch then has TWO distinct fee phases, and they do not work the same way. During the initial dynamic auction, trades pay ${LAUNCH_FEE_PCT}% (LAUNCH_FEE_TIER = ${LAUNCH_FEE_TIER} hundredths of a basis point); the Protocol's share of that auction fee is collected as a third-party integrator fee by an address the Protocol controls off-chain and can change by redeploying its interface, so no split of the auction fee is enforced on-chain and none is promised to you here. After the launch graduates, its liquidity migrates into a Uniswap V4 pool whose trade fee is ${MIGRATION_POOL_FEE_PCT}% — not ${LAUNCH_FEE_PCT}% — and it is THAT pool's fees which the launch's fee constitution divides, streamed by the on-chain locker as follows: ${FEE_CONSTITUTION_TEXT}. The ${PROTOCOL_FEE_PCT}% protocol share is streamed to a Protocol-controlled contract that can claim it from the locker. Where it goes from there depends on the pair, because a locker position carries two currencies: for an ETH-paired launch the ETH leg is forwarded to the Protocol's revenue distributor (${PROTOCOL_FEE_RECIPIENT}), where TOWELI stakers may claim it; for a TOWELI-paired launch both legs are ERC-20 and are swept to the Protocol treasury (${PROTOCOL_FEE_RECIPIENT_EXOTIC}) instead. In neither case does holding a launched token grant you any claim on any Tegridy revenue distribution. The creator-directed share may be carved at launch to attention beneficiaries the creator names. That post-graduation constitution — and only it — is fixed at creation time by the on-chain streaming locker; its shares can afterwards be changed by no one, though each named beneficiary may re-point its own entry to a different address of its choosing.`,
  },
  {
    title: '8. Launching a Token: You Are the Issuer',
    body: 'If you use the Protocol\'s launcher to create a token, you are the issuer of that token and you are solely responsible for it. That includes its name, symbol, supply, artwork and metadata; every statement you or anyone acting for you makes about it; and determining and meeting any securities, commodities, consumer-protection, anti-money-laundering, sanctions, tax and disclosure obligations that apply to you in your own jurisdiction and in the jurisdictions of the people you reach. The Protocol is a non-custodial tool: it assembles a transaction that your own wallet signs and broadcasts. The Protocol is not the issuer, underwriter, sponsor, promoter, broker, dealer, exchange, market maker or fiduciary of any token launched through it, takes no custody of any launched token or of the proceeds of its sale, and does not act on your behalf. Obtain your own legal and tax advice before issuing a token.',
  },
  {
    title: '9. Launches Are Permissionless and Irreversible',
    body: 'The launcher is permissionless. There is no application, no human approval step and no allowlist of who may launch, and a launch is not reviewed or vetted by any person before it happens. A launch is a single transaction on Ethereum mainnet; once it is mined the token is deployed, the auction parameters are set and the fee constitution is fixed on-chain. None of it can be edited, paused, reversed, refunded or deleted afterwards, by you, by the Protocol, or by anyone else — a mistyped name, supply, market-cap band or beneficiary address is permanent. Review the final screen carefully before signing. Nothing about a token having been launched through the Protocol is an endorsement, a recommendation, a listing approval, an audit, or a guarantee of that token\'s legality, quality, value, liquidity or continued existence, and the Protocol does not vet, screen or guarantee any launched token or its creator.',
  },
  {
    title: '10. Fact Sheets and Gate Tiers Are Disclosures, Not Warranties',
    body: 'Every launch is described by an automatically generated Fact Sheet: a point-in-time record of facts read from the token\'s own configuration — the deploying factory and template code hash, the presence or absence of mint, pause, blacklist, fee-on-transfer, upgrade and balance-limit powers, whether ownership is renounced or held by a timelock, whether liquidity is locked and until when, the insider allocation and how much of it is vested on-chain, and the fee constitution. An automated gate turns exactly those checks into a structural tier ("flagship", "listable", or none). A tier describes contract structure as observed at one moment; it is not a security audit, a due-diligence report, a valuation, or a statement that a token is safe or that its creator is honest. A token that meets no tier is not thereby labelled unsafe, and a token that meets a tier can still lose all of its value or be abandoned. Attestations of these facts are revocable and may be corrected. Do your own research before buying any launched token.',
  },
  {
    title: '11. Prohibited Uses of the Launcher',
    body: 'You must not use the launcher to commit fraud or to operate any scheme designed to misappropriate other people\'s funds; to impersonate any person, project, brand or token, or to imply an affiliation, partnership or endorsement that does not exist; to issue a token whose name, symbol, artwork or metadata infringes another party\'s trademark, copyright or other rights; to distribute unlawful, harassing or exploitative content through token metadata; to act for, or to evade sanctions on behalf of, any person or entity subject to sanctions administered by OFAC or any equivalent authority, or to launch from a jurisdiction where doing so is prohibited; or to issue an instrument you know or should know requires a registration, licence or prospectus you do not hold. The Protocol may at its sole discretion and without notice decline to display, index, promote or attest any token across its own interfaces, and may revoke an attestation it has issued. That is an editorial decision about the Protocol\'s own front end. Because a launched token, its pool and its fee streams live on a public blockchain, removing a token from the interface does not remove, disable, freeze or otherwise affect that token on-chain, and the Protocol has no ability to do so.',
  },
  {
    title: '12. Intellectual Property',
    body: 'All artwork, branding, visual assets, user interface designs, and proprietary smart contract code associated with Tegridy Farms are owned by the Protocol and its community. You may not reproduce, distribute, modify, or create derivative works from the Protocol\'s intellectual property without prior written consent. The TOWELI token, JBAC NFT collection, and associated brand elements are protected under applicable intellectual property laws. Open-source components are subject to their respective licenses.',
  },
  {
    title: '13. Limitation of Liability',
    body: 'The Protocol is experimental software provided on an "as-is" and "as-available" basis without warranties of any kind, express or implied. To the maximum extent permitted by applicable law, the Protocol, its contributors, developers, and community members shall not be liable for any direct, indirect, incidental, special, consequential, or punitive damages arising from your use of or inability to use the Protocol. This includes, without limitation, loss of funds, loss of profits, loss of data, or any other losses resulting from smart contract interactions, market conditions, or third-party actions.',
  },
  {
    title: '14. Governing Law',
    body: 'As a decentralized protocol, traditional jurisdictional governance may not apply to disputes arising from the use of the Protocol. The Protocol is administered by its operator subject to the on-chain timelock, and community governance is being built out incrementally; there is no formal DAO entity today. Users agree to participate in good faith in any dispute-resolution process the Protocol may establish. The Protocol strives to operate in compliance with applicable laws across all jurisdictions where it is accessible.',
  },
  {
    title: '15. Changes to Terms',
    body: 'The Protocol reserves the right to modify, update, or replace these Terms at any time. Material changes will be communicated through the Protocol\'s official channels, including the website and community platforms. Your continued use of the Protocol following any changes constitutes acceptance of the revised Terms. It is your responsibility to review these Terms periodically for updates. The "Last Updated" date at the bottom of this page indicates when the most recent changes were made.',
  },
];

export default function TermsPage() {
  usePageTitle('Terms of Service', 'Terms and conditions for using the Tegridy Farms protocol.');

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="terms" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        {/* Dark scrim so the long-form legal copy stays crisp no matter where you scroll */}
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
            Last updated: August 2026
          </p>
        </m.div>
      </div>
    </div>
  );
}
