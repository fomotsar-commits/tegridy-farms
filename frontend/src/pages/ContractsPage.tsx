import { useMemo } from 'react';
import { m } from 'framer-motion';
import { usePageTitle } from '../hooks/usePageTitle';
import { useSourceVerification, type VerificationState } from '../hooks/useSourceVerification';
import { VerifiedBadge } from '../components/ui/VerifiedBadge';
import { CopyButton } from '../components/ui/CopyButton';
import { shortenAddress } from '../lib/formatting';
import { ArtImg } from '../components/ArtImg';
import {
  TOWELI_ADDRESS,
  TEGRIDY_STAKING_ADDRESS,
  TEGRIDY_RESTAKING_ADDRESS,
  TEGRIDY_FACTORY_ADDRESS,
  TEGRIDY_ROUTER_ADDRESS,
  TEGRIDY_LP_ADDRESS,
  REVENUE_DISTRIBUTOR_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS,
  POL_ACCUMULATOR_ADDRESS,
  LP_FARMING_ADDRESS,
  GAUGE_CONTROLLER_ADDRESS,
  COMMUNITY_GRANTS_ADDRESS,
  MEME_BOUNTY_BOARD_ADDRESS,
  REFERRAL_SPLITTER_ADDRESS,
  PREMIUM_ACCESS_ADDRESS,
  VOTE_INCENTIVES_ADDRESS,
  TEGRIDY_LENDING_ADDRESS,
  TEGRIDY_LAUNCHPAD_V2_ADDRESS,
  TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
  TEGRIDY_TOKEN_URI_READER_ADDRESS,
  TEGRIDY_NFT_LENDING_ADDRESS,
  TEGRIDY_TWAP_ADDRESS,
  TEGRIDY_FEE_HOOK_ADDRESS,
  UNISWAP_V2_ROUTER,
  WETH_ADDRESS,
  UNISWAP_V2_FACTORY,
  TOWELI_WETH_LP_ADDRESS,
  ETH_USD_FEED,
  TREASURY_ADDRESS,
  JBAC_NFT_ADDRESS,
  JBAY_GOLD_ADDRESS,
  isDeployed,
} from '../lib/constants';

// AUDIT R035: org was previously `tegridyfarms` (404). Source of truth per
// `git remote -v` is `fomotsar-commits/tegridy-farms`. All per-contract source
// links and the tracked-issues badge below now resolve.
// F452: point at the default/deploy branch `mvp-launch` (the repo ships from it
// and it is hundreds of commits ahead of `main`) so source links serve current
// content rather than a stale snapshot.
const GITHUB_BASE = 'https://github.com/fomotsar-commits/tegridy-farms/blob/mvp-launch';

interface ContractEntry {
  label: string;
  address: string;
  source: string; // relative path under repo root
  // AUDIT LAUNCHPAD-SEC: optional status surfaces placeholder/deprecated
  // entries so users aren't presented with a zero address that looks live.
  // 'redeploy' marks live addresses whose source has been patched and is
  // queued for a redeploy; 'multisig' marks live addresses whose
  // ownership transfer hasn't been accepted yet.
  status?: 'pending' | 'deprecated' | 'redeploy' | 'multisig';
  note?: string; // shown under the label when status is redeploy/multisig
}

interface ContractGroup {
  title: string;
  description: string;
  entries: ContractEntry[];
}

const GROUPS: ContractGroup[] = [
  {
    title: 'Core',
    description: 'TOWELI token and staking primitives.',
    entries: [
      { label: 'TOWELI Token', address: TOWELI_ADDRESS, source: 'contracts/src/TOWELI.sol' },
      { label: 'Tegridy Staking', address: TEGRIDY_STAKING_ADDRESS, source: 'contracts/src/TegridyStaking.sol' },
      { label: 'Tegridy Restaking', address: TEGRIDY_RESTAKING_ADDRESS, source: 'contracts/src/TegridyRestaking.sol' },
      { label: 'Treasury', address: TREASURY_ADDRESS, source: 'external (Safe multisig)' },
    ],
  },
  {
    title: 'DEX',
    description: 'Native UniswapV2-fork AMM and LP farming.',
    entries: [
      { label: 'Tegridy Factory', address: TEGRIDY_FACTORY_ADDRESS, source: 'contracts/src/TegridyFactory.sol' },
      { label: 'Tegridy Router', address: TEGRIDY_ROUTER_ADDRESS, source: 'contracts/src/TegridyRouter.sol' },
      { label: 'Tegridy LP (TOWELI/WETH)', address: TEGRIDY_LP_ADDRESS, source: 'contracts/src/TegridyPair.sol' },
      {
        label: 'LP Farming',
        address: LP_FARMING_ADDRESS,
        source: 'contracts/src/TegridyLPFarming.sol',
        status: 'multisig',
        note: 'Relaunch redeploy live. Awaiting protocol Safe acceptOwnership() before admin functions work.',
      },
      { label: 'Tegridy TWAP Oracle', address: TEGRIDY_TWAP_ADDRESS, source: 'contracts/src/TegridyTWAP.sol' },
      {
        label: 'Tegridy Fee Hook (V4)',
        address: TEGRIDY_FEE_HOOK_ADDRESS,
        source: 'contracts/src/TegridyFeeHook.sol',
        status: 'redeploy',
        note: 'Owner stranded on Arachnid CREATE2 proxy. Constructor patched to accept _owner — redeploy queued before activation.',
      },
    ],
  },
  {
    title: 'Revenue',
    description: 'Protocol swap fees route to stakers, POL, and treasury per the on-chain split (currently 100% to stakers).',
    entries: [
      { label: 'Revenue Distributor', address: REVENUE_DISTRIBUTOR_ADDRESS, source: 'contracts/src/RevenueDistributor.sol' },
      { label: 'Swap Fee Router', address: SWAP_FEE_ROUTER_ADDRESS, source: 'contracts/src/SwapFeeRouter.sol' },
      { label: 'POL Accumulator', address: POL_ACCUMULATOR_ADDRESS, source: 'contracts/src/POLAccumulator.sol' },
    ],
  },
  {
    title: 'Governance',
    description: 'Gauge voting, incentives, and community programs.',
    entries: [
      {
        label: 'Gauge Controller',
        address: GAUGE_CONTROLLER_ADDRESS,
        source: 'contracts/src/GaugeController.sol',
        status: 'multisig',
        note: 'Relaunch redeploy live (H-2 commit-reveal). Awaiting protocol Safe acceptOwnership().',
      },
      {
        label: 'Vote Incentives',
        address: VOTE_INCENTIVES_ADDRESS,
        source: 'contracts/src/VoteIncentives.sol',
        status: 'redeploy',
        note: 'Redeploy queued to partner the new commit-reveal GaugeController.',
      },
      { label: 'Community Grants', address: COMMUNITY_GRANTS_ADDRESS, source: 'contracts/src/CommunityGrants.sol' },
      { label: 'Meme Bounty Board', address: MEME_BOUNTY_BOARD_ADDRESS, source: 'contracts/src/MemeBountyBoard.sol' },
      { label: 'Referral Splitter', address: REFERRAL_SPLITTER_ADDRESS, source: 'contracts/src/ReferralSplitter.sol' },
      { label: 'Premium Access (Gold Card)', address: PREMIUM_ACCESS_ADDRESS, source: 'contracts/src/PremiumAccess.sol' },
    ],
  },
  {
    title: 'NFT Finance',
    description: 'NFT-collateralized lending, bonding-curve pools, and launchpad.',
    entries: [
      {
        label: 'Tegridy Lending',
        address: TEGRIDY_LENDING_ADDRESS,
        source: 'contracts/src/TegridyLending.sol',
        status: 'redeploy',
        note: 'Part of the V3Features bundle redeploy (DeployV3Features.s.sol) queued before activation.',
      },
      {
        label: 'Tegridy Launchpad',
        address: TEGRIDY_LAUNCHPAD_V2_ADDRESS,
        source: 'contracts/src/TegridyLaunchpadV2.sol',
        status: isDeployed(TEGRIDY_LAUNCHPAD_V2_ADDRESS) ? undefined : 'pending',
      },
      {
        label: 'NFT Pool Factory',
        address: TEGRIDY_NFT_POOL_FACTORY_ADDRESS,
        source: 'contracts/src/TegridyNFTPoolFactory.sol',
        status: 'redeploy',
        note: 'Part of the V3Features bundle redeploy queued before activation.',
      },
      {
        label: 'NFT Lending',
        address: TEGRIDY_NFT_LENDING_ADDRESS,
        source: 'contracts/src/TegridyNFTLending.sol',
        status: 'multisig',
        note: 'Relaunch redeploy live (C-02 grace period). Awaiting protocol Safe acceptOwnership().',
      },
      { label: 'Token URI Reader', address: TEGRIDY_TOKEN_URI_READER_ADDRESS, source: 'contracts/src/TokenURIReader.sol' },
      { label: 'JBAC NFT', address: JBAC_NFT_ADDRESS, source: 'external (Jungle Bay Apes)' },
      { label: 'JBAY Gold', address: JBAY_GOLD_ADDRESS, source: 'external (Jungle Bay Gold)' },
    ],
  },
  {
    title: 'External deps',
    description: 'Third-party contracts we integrate with.',
    entries: [
      { label: 'Uniswap V2 Router', address: UNISWAP_V2_ROUTER, source: 'external (Uniswap)' },
      { label: 'Uniswap V2 Factory', address: UNISWAP_V2_FACTORY, source: 'external (Uniswap)' },
      { label: 'WETH', address: WETH_ADDRESS, source: 'external (Canonical WETH9)' },
      { label: 'TOWELI/WETH LP (Uniswap)', address: TOWELI_WETH_LP_ADDRESS, source: 'external (Uniswap V2 Pair)' },
      { label: 'Chainlink ETH/USD Feed', address: ETH_USD_FEED, source: 'external (Chainlink)' },
    ],
  },
];

function ContractRow({ entry, verification }: { entry: ContractEntry; verification: VerificationState }) {
  const isExternal = entry.source.startsWith('external');
  const sourceHref = isExternal ? undefined : `${GITHUB_BASE}/${entry.source}`;
  // Our own contracts with an unset (zero) address aren't part of the current
  // deployment — route them through the clean "pending deploy" path so we never
  // surface a 0x0 as live or render a stale "redeploy live / awaiting multisig"
  // note. (The relaunch zeroed all Wave-0 addresses in constants.ts.)
  const undeployed = !isExternal && !isDeployed(entry.address);
  const isPending = entry.status === 'pending' || undeployed;
  const isDeprecated = entry.status === 'deprecated';
  const isRedeploy = entry.status === 'redeploy' && !undeployed;
  const isMultisig = entry.status === 'multisig' && !undeployed;
  return (
    <div
      className={`grid grid-cols-1 md:grid-cols-[1fr_auto_auto_auto] items-center gap-2 md:gap-4 py-3 border-b border-white/5 last:border-0 ${isPending ? 'opacity-70' : ''}`}
    >
      <div className="min-w-0">
        <div className="text-white text-[14px] font-medium truncate flex items-center gap-2 flex-wrap">
          <span>{entry.label}</span>
          {isPending && (
            <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-300">
              pending deploy
            </span>
          )}
          {isDeprecated && (
            <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-md border border-white/20 bg-white/5 text-white/60">
              deprecated
            </span>
          )}
          {isRedeploy && (
            <span
              className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-md border border-orange-500/40 bg-orange-500/10 text-orange-300"
              title="Source patched; live address queued for a redeploy"
            >
              redeploy queued
            </span>
          )}
          {isMultisig && (
            <span
              className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-md border border-sky-500/40 bg-sky-500/10 text-sky-300"
              title="Deployed; multisig has not yet called acceptOwnership()"
            >
              awaiting multisig
            </span>
          )}
          {/* Live Etherscan source-verification. Only for deployed addresses —
              `isPending` covers zero-address entries, which are never queried.
              The badge asserts nothing when the lookup didn't resolve. */}
          {!isPending && (
            <VerifiedBadge state={verification} address={entry.address} label={entry.label} />
          )}
        </div>
        {isExternal ? (
          <div className="text-white/40 text-[11px] mt-0.5">{entry.source}</div>
        ) : (
          <a
            href={sourceHref}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/40 text-[11px] mt-0.5 hover:text-white/70 transition-colors inline-flex items-center min-h-[44px] md:min-h-0 py-2 md:py-0"
            aria-label={`Open ${entry.source} on GitHub (opens in new tab)`}
          >
            {entry.source} <span className="text-white/15">↗</span>
          </a>
        )}
        {entry.note && (isRedeploy || isMultisig) && (
          <div
            className={`text-[11px] mt-1 leading-relaxed ${isRedeploy ? 'text-orange-200/75' : 'text-sky-200/75'}`}
            style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}
          >
            {entry.note}
          </div>
        )}
      </div>
      {/* Mobile: explicit "Address:" label + ≥44px tap target on the copy control. */}
      <div className="flex items-center justify-between md:justify-end gap-3 md:contents">
        <span className="md:hidden text-white/50 text-[11px] uppercase tracking-wider">Address:</span>
        {isPending ? (
          <span
            className="font-mono text-[12px] text-white/40 inline-flex items-center justify-end px-2 md:px-0"
            title="Address not yet assigned — contract awaiting deployment"
          >
            {shortenAddress(entry.address, 6)}
          </span>
        ) : (
          <CopyButton
            text={entry.address}
            display={shortenAddress(entry.address, 6)}
            className="font-mono text-[12px] text-white/80 min-h-[44px] min-w-[44px] inline-flex items-center justify-end md:min-h-0 md:min-w-0 px-2 md:px-0"
          />
        )}
      </div>
      <div className="flex items-center justify-between md:justify-end gap-3 md:contents">
        <span className="md:hidden text-white/50 text-[11px] uppercase tracking-wider">Explorer:</span>
        {isPending ? (
          <span className="text-[11px] text-white/30 whitespace-nowrap inline-flex items-center justify-end px-2 md:px-0">
            —
          </span>
        ) : (
          <a
            href={`https://etherscan.io/address/${entry.address}#code`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-white/60 hover:text-white transition-colors whitespace-nowrap inline-flex items-center justify-end min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0 px-2 md:px-0"
            aria-label={`View ${entry.label} on Etherscan (opens in new tab)`}
          >
            Etherscan ↗
          </a>
        )}
      </div>
    </div>
  );
}

export default function ContractsPage() {
  // T3/F374: "verified" could imply Etherscan source-verification, which is still
  // pending (invalid key at deploy). Soften to "deployed" — the addresses are live
  // on mainnet and source is linked; we don't assert source-verification we can't back yet.
  usePageTitle('Contracts', 'Tegridy Farms smart contract addresses, deployed on Ethereum mainnet.');

  // Live Etherscan source-verification — one batched, throttled query for the
  // whole page. Only OUR OWN deployed contracts are queried: external deps
  // (Uniswap, WETH, Chainlink, the Safe) aren't our claim to make, and
  // zero-address entries keep their untouched "pending deploy" path — the same
  // gate ContractRow uses for `undeployed`. Results cache in localStorage for
  // days, so a repeat visit costs zero requests.
  const verifiableAddresses = useMemo(
    () =>
      GROUPS.flatMap((g) => g.entries)
        .filter((e) => !e.source.startsWith('external') && isDeployed(e.address))
        .map((e) => e.address),
    [],
  );
  const verification = useSourceVerification(verifiableAddresses);

  return (
    <div className="-mt-14 relative min-h-screen">
      {/* Full-bleed page art with scrim so mono text stays readable. */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="contracts" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(6,12,26,0.55) 0%, rgba(6,12,26,0.82) 45%, rgba(6,12,26,0.92) 100%)' }} />
      </div>

      <m.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-28 pb-20"
      >
        <header className="mb-8 md:mb-12">
          <h1 className="heading-luxury text-3xl md:text-5xl text-white mb-3" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>Contract Index</h1>
          <p className="text-white/75 text-[13px] md:text-[14px] max-w-[720px] leading-relaxed mb-5" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
            Canonical, on-chain addresses for every Tegridy Farms contract, grouped by role. Source
            for every contract is linked below. Source mirrored from the repo{' '}
            <a
              href={`${GITHUB_BASE}/CONTRACTS.md`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-white underline hover:text-white/70 transition-colors"
            >
              CONTRACTS.md
            </a>
            .
          </p>

          {/* Relaunch closure — outstanding deploy work. The June 6, 2026
              relaunch redeployed the live protocol from a fresh deployer and
              superseded the earlier "Wave 0" plan; the badges below map to what
              is still being finished after the relaunch. */}
          <div
            role="status"
            className="rounded-xl p-4 md:p-5 max-w-[860px]"
            style={{ border: '1px solid rgba(245, 158, 11, 0.35)', background: 'rgba(245, 158, 11, 0.07)' }}
          >
            <p className="text-amber-300 text-[13px] font-semibold mb-2" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>
              Relaunch closure — outstanding deploy work
            </p>
            <ul className="text-white/80 text-[12px] leading-relaxed space-y-1.5" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.85)' }}>
              <li className="flex items-start gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-300 mt-0.5 shrink-0">pending deploy</span>
                <span>Not part of the relaunch deployment. Reads are gated on <code className="font-mono text-white/90">isDeployed()</code> and each feature un-gates when its contract clears a pre-deploy audit wave and goes live.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-md border border-orange-500/40 bg-orange-500/10 text-orange-300 mt-0.5 shrink-0">redeploy queued</span>
                <span>Source has been patched for an audit finding and a redeploy is queued before the feature goes live.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-[10px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded-md border border-sky-500/40 bg-sky-500/10 text-sky-300 mt-0.5 shrink-0">awaiting multisig</span>
                <span>Address is live, but the protocol Safe still has to call <code className="font-mono text-white/90">acceptOwnership()</code> before any owner-only function works (2-step ownership transfer).</span>
              </li>
            </ul>
            <p className="text-white/60 text-[11px] mt-3 leading-relaxed">
              Full remaining-task checklist:{' '}
              <a
                href="https://github.com/fomotsar-commits/tegridy-farms/issues?q=is%3Aissue+is%3Aopen"
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/80 underline hover:text-white transition-colors"
              >
                tracked issues
              </a>
            </p>
          </div>
        </header>

        <div className="space-y-8 md:space-y-10">
          {GROUPS.map((group, groupIdx) => (
            <section key={group.title} aria-labelledby={`group-${group.title}`}>
              <div className="mb-4 flex items-baseline justify-between gap-4 flex-wrap">
                <h2
                  id={`group-${group.title}`}
                  className="heading-luxury text-xl md:text-2xl text-white"
                  style={{ textShadow: '0 1px 4px rgba(0,0,0,0.9)' }}
                >
                  {group.title}
                </h2>
                <span className="text-white/50 text-[11px] uppercase tracking-wider label-pill">
                  {group.entries.length} contract{group.entries.length === 1 ? '' : 's'}
                </span>
              </div>
              <p className="text-white/60 text-[12px] mb-4 max-w-[680px]" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.8)' }}>{group.description}</p>
              <div
                className="relative overflow-hidden rounded-xl px-4 md:px-5 py-1"
                style={{
                  border: '1px solid var(--color-purple-12)',
                }}
              >
                <div className="absolute inset-0">
                  <ArtImg pageId="contracts" idx={groupIdx + 1} alt="" loading="lazy" className="w-full h-full object-cover" />
                  <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.80)' }} />
                </div>
                <div className="relative z-10">
                  {group.entries.map((entry) => (
                    <ContractRow
                      key={entry.address + entry.label}
                      entry={entry}
                      verification={verification[entry.address.toLowerCase()] ?? 'unchecked'}
                    />
                  ))}
                </div>
              </div>
            </section>
          ))}
        </div>

        <div className="mt-12 text-center text-white/35 text-[11px]">
          Chain ID 1 (Ethereum mainnet). Last regenerated from{' '}
          <code className="font-mono text-white/55">frontend/src/lib/constants.ts</code>.
          {' '}Last reviewed: July 2026.
        </div>
      </m.div>
    </div>
  );
}
