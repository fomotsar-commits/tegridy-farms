import { useMemo } from 'react';
import { m } from 'framer-motion';
import { useBalance, useReadContract } from 'wagmi';
import { formatEther } from 'viem';
import { usePageTitle } from '../hooks/usePageTitle';
import { usePoolTVL } from '../hooks/usePoolTVL';
import { useTOWELIPrice } from '../contexts/PriceContext';
import {
  TREASURY_ADDRESS,
  POL_ACCUMULATOR_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS,
  TOWELI_WETH_LP_ADDRESS,
} from '../lib/constants';
import { SWAP_FEE_ROUTER_ABI } from '../lib/contracts';
import { shortenAddress } from '../lib/formatting';
import { CopyButton } from '../components/ui/CopyButton';
import { ArtImg } from '../components/ArtImg';

const fade = { hidden: { opacity: 0, y: 24 }, visible: { opacity: 1, y: 0 } };
// Cards sit on a darkened glass layer so stat text stays readable against
// the fullbleed page art; the inner ArtImg gives each tile its own accent.
const glass = { background: 'rgba(13, 21, 48, 0.78)', border: '1px solid var(--color-purple-12)' };

// AUDIT TREASURY-FIX: the page used to hardcode a 70/20/10 split that
// disagreed with the actual on-chain defaults (currently 100/0/0 per
// SwapFeeRouter.sol; the 50/25/25 ceilings are policy bounds, not the
// active numbers). Now we read stakerShareBps / polShareBps live and
// compute treasury as the remainder. If the read fails, the page falls
// back to the live contract default (100% stakers) which is honest if
// uninformative — strictly better than the old lie.
const SHARE_ABI = [
  { type: 'function', name: 'stakerShareBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'polShareBps',    inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

const SPLIT_COLORS = {
  stakers: '#22c55e',
  pol: '#8b5cf6',
  treasury: '#eab308',
} as const;

const ERC20_BAL_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

function formatUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n > 0) return `$${n.toFixed(2)}`;
  return '–';
}

function formatEth(wei: bigint): string {
  const n = parseFloat(formatEther(wei));
  if (n >= 1) return `${n.toFixed(3)} ETH`;
  if (n > 0) return `${n.toFixed(5)} ETH`;
  return '0 ETH';
}

export default function TreasuryPage() {
  usePageTitle('Treasury — Tegridy Farms');

  const price = useTOWELIPrice();
  const pool = usePoolTVL();

  // Treasury ETH balance
  const { data: treasuryBal } = useBalance({
    address: TREASURY_ADDRESS,
    query: { refetchInterval: 60_000 },
  });

  // POL LP holdings (LP tokens held by POL accumulator)
  const { data: polLpBal } = useReadContract({
    address: TOWELI_WETH_LP_ADDRESS,
    abi: ERC20_BAL_ABI,
    functionName: 'balanceOf',
    args: [POL_ACCUMULATOR_ADDRESS],
    query: { refetchInterval: 60_000 },
  });

  // Lifetime fees (SwapFeeRouter.totalETHFees)
  const { data: totalFeesWei } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SWAP_FEE_ROUTER_ABI,
    functionName: 'totalETHFees',
    query: { refetchInterval: 60_000 },
  });

  // Live revenue split. Defaults match SwapFeeRouter.sol initial state
  // (stakerShareBps=10_000, polShareBps=0) so the page stays coherent
  // before the first read resolves.
  const { data: stakerShareData } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SHARE_ABI,
    functionName: 'stakerShareBps',
    query: { refetchInterval: 300_000, staleTime: 60_000 },
  });
  const { data: polShareData } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SHARE_ABI,
    functionName: 'polShareBps',
    query: { refetchInterval: 300_000, staleTime: 60_000 },
  });
  const stakerBps = stakerShareData !== undefined ? Number(stakerShareData as bigint) : 10_000;
  const polBps = polShareData !== undefined ? Number(polShareData as bigint) : 0;
  const treasuryBps = Math.max(0, 10_000 - stakerBps - polBps);
  const split = [
    { label: 'Stakers', bps: stakerBps, color: SPLIT_COLORS.stakers },
    { label: 'Protocol-Owned Liquidity', bps: polBps, color: SPLIT_COLORS.pol },
    { label: 'Treasury', bps: treasuryBps, color: SPLIT_COLORS.treasury },
  ];

  const lifetimeFeesEth = totalFeesWei ? parseFloat(formatEther(totalFeesWei as bigint)) : 0;
  const lifetimeFeesUsd = lifetimeFeesEth * (price.ethUsd || 0);

  const treasuryEthFormatted = treasuryBal ? formatEth(treasuryBal.value) : '–';
  const treasuryUsd = treasuryBal ? parseFloat(formatEther(treasuryBal.value)) * (price.ethUsd || 0) : 0;

  // POL LP value estimate: share of pool TVL owned by accumulator
  const polShare = useMemo(() => {
    if (!polLpBal || !pool.lpSupply || pool.lpSupply === 0n) return 0;
    return Number(polLpBal as bigint) / Number(pool.lpSupply);
  }, [polLpBal, pool.lpSupply]);
  const polUsd = polShare * pool.tvl;

  const stats: { label: string; value: string; sub: string; idx: number }[] = [
    { label: 'Total Value Locked', value: pool.tvlFormatted, sub: 'TOWELI/WETH pool', idx: 1 },
    { label: 'Lifetime Fees', value: formatUsd(lifetimeFeesUsd), sub: `${lifetimeFeesEth.toFixed(4)} ETH routed`, idx: 2 },
    { label: 'Treasury Balance', value: treasuryEthFormatted, sub: formatUsd(treasuryUsd), idx: 3 },
    { label: 'POL Holdings', value: formatUsd(polUsd), sub: `${(polShare * 100).toFixed(2)}% of LP supply`, idx: 4 },
  ];

  return (
    <div className="-mt-14 relative min-h-screen">
      {/* Full-bleed page art with a scrim so the stat text stays legible. */}
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="treasury" idx={0} alt="" loading="lazy" className="w-full h-full object-cover" />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(6,12,26,0.50) 0%, rgba(6,12,26,0.78) 40%, rgba(6,12,26,0.90) 100%)' }} />
      </div>

      <m.section
        className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-8 pt-28 pb-20"
        initial="hidden"
        animate="visible"
        variants={fade}
        transition={{ duration: 0.5 }}
      >
        {/* Header */}
        <div className="mb-10">
          <p className="text-white/65 text-[11px] uppercase tracking-[0.2em] label-pill mb-3">Public Transparency</p>
          <h1 className="heading-luxury text-4xl md:text-5xl text-white mb-3" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>Treasury</h1>
          <p className="text-white/80 text-[14px] max-w-[640px] leading-relaxed" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
            Live, on-chain view of protocol treasury, protocol-owned liquidity, lifetime fees, and how
            revenue is distributed. All figures are read directly from Ethereum mainnet.
          </p>
        </div>

        {/* Top stats — each tile overlays its own ArtImg so the grid feels art-first. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 mb-10">
          {stats.map((s) => (
            <div key={s.label} className="relative overflow-hidden rounded-xl" style={{ border: '1px solid var(--color-purple-12)' }}>
              <div className="absolute inset-0">
                <ArtImg pageId="treasury" idx={s.idx} alt="" loading="lazy" className="w-full h-full object-cover" />
                <div className="absolute inset-0" style={{ background: 'rgba(6,12,26,0.72)' }} />
              </div>
              <div className="relative z-10 p-5">
                <p className="text-white/65 text-[10px] uppercase tracking-wider label-pill mb-2" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.9)' }}>{s.label}</p>
                <p className="heading-luxury text-2xl text-white" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{s.value}</p>
                <p className="text-white/55 text-[11px] mt-2" style={{ textShadow: '0 1px 3px rgba(0,0,0,0.85)' }}>{s.sub}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Distribution split — inner card layer over the page art. */}
        <div className="relative overflow-hidden rounded-xl p-6 md:p-8 mb-10" style={glass}>
          <div className="absolute inset-0 opacity-30">
            <ArtImg pageId="treasury" idx={5} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10">
        <div className="flex items-baseline justify-between mb-5">
          <h2 className="heading-luxury text-xl text-white">Revenue Distribution</h2>
          <span className="text-white/40 text-[11px]">Per swap fee</span>
        </div>

        {/* Stacked bar — rendered from the live on-chain split. Zero-width
            segments are skipped so the rounded corners stay clean when
            polBps or treasuryBps is 0. */}
        <div
          className="flex h-3 rounded-full overflow-hidden mb-5"
          role="img"
          aria-label={`Revenue distribution split: ${split.filter(s => s.bps > 0).map(s => `${(s.bps / 100).toFixed(0)}% ${s.label}`).join(', ')}`}
        >
          {split.filter(s => s.bps > 0).map((s) => (
            <div key={s.label} style={{ width: `${s.bps / 100}%`, background: s.color }} />
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {split.map((s) => (
            <div key={s.label} className="flex items-center gap-3" style={{ opacity: s.bps === 0 ? 0.45 : 1 }}>
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: s.color }} />
              <div>
                <p className="text-white text-[13px]">{s.label}</p>
                <p className="text-white/50 text-[11px]">{(s.bps / 100).toFixed(0)}% ({s.bps} bps){s.bps === 0 ? ' · inactive' : ''}</p>
              </div>
            </div>
          ))}
        </div>
          </div>
        </div>

        {/* Addresses */}
        <div className="relative overflow-hidden rounded-xl p-6 md:p-8 mb-10" style={glass}>
          <div className="absolute inset-0 opacity-25">
            <ArtImg pageId="treasury" idx={6} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10">
            <h2 className="heading-luxury text-xl text-white mb-5" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>On-chain Addresses</h2>
            <div className="space-y-3">
              {[
                { label: 'Treasury', addr: TREASURY_ADDRESS },
                { label: 'POL Accumulator', addr: POL_ACCUMULATOR_ADDRESS },
                { label: 'Swap Fee Router', addr: SWAP_FEE_ROUTER_ADDRESS },
              ].map((row) => (
                <div key={row.label} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 border-b border-white/5 last:border-b-0">
                  <span className="text-white/75 text-[13px]">{row.label}</span>
                  <div className="flex items-center gap-3">
                    <CopyButton
                      text={row.addr}
                      display={shortenAddress(row.addr, 6)}
                      className="font-mono text-[12px] text-white"
                    />
                    <a
                      href={`https://etherscan.io/address/${row.addr}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-white/55 hover:text-white text-[12px]"
                      aria-label={`View ${row.label} on Etherscan (opens in new tab)`}
                    >
                      Etherscan ↗
                    </a>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Recent transactions placeholder */}
        <div className="relative overflow-hidden rounded-xl p-6 md:p-8" style={glass}>
          <div className="absolute inset-0 opacity-25">
            <ArtImg pageId="treasury" idx={7} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10">
            <h2 className="heading-luxury text-xl text-white mb-3" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>Recent Treasury Transactions</h2>
            <p className="text-white/70 text-[13px] leading-relaxed">
              Coming soon — an indexed feed of the latest 10 inflows and outflows will appear here once the
              indexer is live. In the meantime, all activity is auditable on-chain:{' '}
              <a
                href={`https://etherscan.io/address/${TREASURY_ADDRESS}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white underline hover:text-white/80"
                aria-label="View treasury on Etherscan (opens in new tab)"
              >
                View on Etherscan ↗
              </a>
            </p>
          </div>
        </div>
      </m.section>
    </div>
  );
}
