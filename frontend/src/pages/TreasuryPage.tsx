import { useMemo, useState, useEffect } from 'react';
import { m } from 'framer-motion';
import { useBalance, useBlockNumber, useReadContract } from 'wagmi';
import { formatEther } from 'viem';
import { usePageTitle } from '../hooks/usePageTitle';
import { usePoolTVL } from '../hooks/usePoolTVL';
import { useTOWELIPrice } from '../contexts/PriceContext';
import {
  TREASURY_ADDRESS,
  POL_ACCUMULATOR_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS,
  REFERRAL_SPLITTER_ADDRESS,
  REVENUE_DISTRIBUTOR_ADDRESS,
  TOWELI_WETH_LP_ADDRESS,
  CHAIN_ID,
} from '../lib/constants';
import { SWAP_FEE_ROUTER_ABI, REVENUE_DISTRIBUTOR_ABI } from '../lib/contracts';
import { shortenAddress, formatTimeAgo } from '../lib/formatting';
import { getAddressUrl, getTxUrl } from '../lib/explorer';
import { fetchAddressTxList, type TxRecord } from '../lib/txHistory';
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

/**
 * 🔄 2026-08-12 — THE OMISSION THIS PAGE WAS BUILT ON.
 *
 * The split above (stakers / POL / treasury) is real, but it is the SECOND
 * stage of the fee pipeline, and this page rendered it as if it were the whole
 * of it. Stage one is ReferralSplitter, which was not on this page at all —
 * not in the bar, not in the legend, not in the address list. That is the
 * contract holding 100% of every fee the protocol has ever collected.
 *
 * Read from mainnet 2026-08-12, and re-read live by this page:
 *   SwapFeeRouter.totalETHFees()        = 3,000,000,000,000 wei  (all of it)
 *   SwapFeeRouter.accumulatedETHFees()  = 0                      (stage two has never had anything to split)
 *   ReferralSplitter balance            = 3,000,000,000,000 wei  (all of it, still there)
 *     ├ callerCredit[SwapFeeRouter]     = 2,400,000,000,000 wei  (80% — owed back to the router, never pulled)
 *     └ accumulatedTreasuryETH          =   600,000,000,000 wei  (20% referral slice, no qualified referrer)
 *   RevenueDistributor.totalDistributed = 0                      (stakers have received nothing, ever)
 *
 * Every swap fee is forwarded to ReferralSplitter.recordFee() BEFORE it can
 * reach `accumulatedETHFees` (SwapFeeRouter.sol:571-593). The splitter keeps
 * `referralFeeBps` for the referrer and books the remainder as a pull-pattern
 * credit back to the router. Nobody has pulled it: `recoverCallerCredit()` is
 * permissionless with a 30s cooldown and `lastCallerCreditAt` is still 0. So
 * the stakers-get-100% bar was, in the only sense a visitor cares about,
 * describing a pipeline that has moved zero wei.
 *
 * The fix is additive: both stages are now shown, in order, with a live
 * reconciliation underneath that says where the money physically is. The
 * original bar is kept and relabelled, not replaced.
 */
const SPLIT_COLORS = {
  stakers: '#22c55e',
  pol: '#8b5cf6',
  treasury: '#eab308',
  /** Stage one: the referrer's slice, held inside ReferralSplitter. */
  referral: '#f472b6',
  /** Stage one: the remainder, credited back to the router but not yet pulled. */
  credit: '#38bdf8',
} as const;

const ERC20_BAL_ABI = [
  { type: 'function', name: 'balanceOf', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

/** Reads that make the stage-one omission visible. Declared locally for the same
 *  reason SHARE_ABI is: contracts.ts's shared ABIs do not carry these selectors. */
const SPLITTER_ABI = [
  { type: 'function', name: 'referralFeeBps', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'callerCredit', inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'accumulatedTreasuryETH', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
  { type: 'function', name: 'totalPendingETH', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;
const ROUTER_ACCRUAL_ABI = [
  { type: 'function', name: 'accumulatedETHFees', inputs: [], outputs: [{ name: '', type: 'uint256' }], stateMutability: 'view' },
] as const;

// F451: distinguish "no data yet / read failed" (undefined → "–") from a
// successful read of zero (0 → "$0.00"). Previously a real zero rendered "–",
// which read as a failed load and disagreed with sibling cells.
function formatUsd(n: number | undefined): string {
  if (n === undefined) return '–';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function formatEth(wei: bigint): string {
  const n = parseFloat(formatEther(wei));
  if (n >= 1) return `${n.toFixed(3)} ETH`;
  if (n > 0) return `${n.toFixed(5)} ETH`;
  return '0 ETH';
}

/**
 * Same idea as formatEth, but it never renders a real non-zero balance as
 * "0.00000 ETH". The protocol's entire lifetime fee take is 3e12 wei — five
 * decimals of ETH rounds that to zero, which is exactly the reading error this
 * page exists to prevent. Below 0.0001 ETH we switch to gwei, and below a gwei
 * to raw wei, so a tiny number reads as tiny rather than as nothing.
 * `undefined` (read pending / failed) stays distinct from a true zero.
 */
function formatEthFine(wei: bigint | undefined): string {
  if (wei === undefined) return '–';
  if (wei === 0n) return '0 ETH';
  const n = parseFloat(formatEther(wei));
  if (n >= 1) return `${n.toFixed(3)} ETH`;
  if (n >= 0.0001) return `${n.toFixed(5)} ETH`;
  if (wei >= 1_000_000_000n) {
    const gwei = Number(wei) / 1e9;
    return `${gwei >= 100 ? gwei.toFixed(0) : gwei.toFixed(2)} gwei`;
  }
  return `${wei.toString()} wei`;
}

/** Percent of `total` that `part` represents, as a display string. '' when unknown. */
function pctOf(part: bigint | undefined, total: bigint | undefined): string {
  if (part === undefined || total === undefined || total === 0n) return '';
  return `${((Number(part) / Number(total)) * 100).toFixed(0)}%`;
}

/**
 * R070: small inline component for "view source on Etherscan" links next to
 * any on-chain-derived stat. Centralised so every link shares the same
 * visual pattern (faint underline + arrow icon) and chain-aware URL.
 */
function SourceLink({ chainId, address, label }: { chainId: number | undefined; address: string; label?: string }) {
  return (
    <a
      href={getAddressUrl(chainId, address)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`View source contract for ${label ?? 'this stat'} on block explorer (opens in new tab)`}
      className="text-white/55 hover:text-white text-[10px] underline underline-offset-2 transition-colors"
    >
      source ↗
    </a>
  );
}

export default function TreasuryPage() {
  usePageTitle('Treasury', 'On-chain memetics.finance treasury holdings and protocol revenue flows.');

  // F390: all reads on this page are mainnet (treasury balance, fee router,
  // /api/etherscan feed) — pin the canonical chain so explorer links never
  // resolve to a wrong-chain explorer when the wallet is on another network.
  const chainId = CHAIN_ID;
  const price = useTOWELIPrice();
  const pool = usePoolTVL();
  // R070: every reading on this page is "as of block N" — surface the latest
  // block so a user can verify or pin a snapshot.
  // F404: poll on the same 60s cadence as the data reads instead of holding a
  // per-block (~12s) subscription just to render one caption line.
  const { data: latestBlock } = useBlockNumber({ chainId: CHAIN_ID, query: { refetchInterval: 60_000 } });

  // Treasury ETH balance
  const { data: treasuryBal } = useBalance({
    address: TREASURY_ADDRESS,
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });

  // POL LP holdings (LP tokens held by POL accumulator)
  const { data: polLpBal } = useReadContract({
    address: TOWELI_WETH_LP_ADDRESS,
    abi: ERC20_BAL_ABI,
    functionName: 'balanceOf',
    args: [POL_ACCUMULATOR_ADDRESS],
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });

  // Lifetime fees (SwapFeeRouter.totalETHFees)
  const { data: totalFeesWei } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SWAP_FEE_ROUTER_ABI,
    functionName: 'totalETHFees',
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });

  // Live revenue split. Defaults match SwapFeeRouter.sol initial state
  // (stakerShareBps=10_000, polShareBps=0) so the page stays coherent
  // before the first read resolves.
  const { data: stakerShareData } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SHARE_ABI,
    functionName: 'stakerShareBps',
    chainId: CHAIN_ID,
    query: { refetchInterval: 300_000, staleTime: 60_000 },
  });
  const { data: polShareData } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SHARE_ABI,
    functionName: 'polShareBps',
    chainId: CHAIN_ID,
    query: { refetchInterval: 300_000, staleTime: 60_000 },
  });

  // ── Stage one: ReferralSplitter. The contract this page used to omit. ──
  // Every swap fee lands here first, so these six reads are what turn
  // "how we intend to split revenue" into "where the revenue actually is".
  const { data: referralBpsData } = useReadContract({
    address: REFERRAL_SPLITTER_ADDRESS,
    abi: SPLITTER_ABI,
    functionName: 'referralFeeBps',
    chainId: CHAIN_ID,
    query: { refetchInterval: 300_000, staleTime: 60_000 },
  });
  const { data: splitterBal } = useBalance({
    address: REFERRAL_SPLITTER_ADDRESS,
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });
  const { data: routerCredit } = useReadContract({
    address: REFERRAL_SPLITTER_ADDRESS,
    abi: SPLITTER_ABI,
    functionName: 'callerCredit',
    args: [SWAP_FEE_ROUTER_ADDRESS],
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });
  const { data: splitterTreasuryEth } = useReadContract({
    address: REFERRAL_SPLITTER_ADDRESS,
    abi: SPLITTER_ABI,
    functionName: 'accumulatedTreasuryETH',
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });
  const { data: splitterPendingRef } = useReadContract({
    address: REFERRAL_SPLITTER_ADDRESS,
    abi: SPLITTER_ABI,
    functionName: 'totalPendingETH',
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });
  const { data: routerAccrued } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: ROUTER_ACCRUAL_ABI,
    functionName: 'accumulatedETHFees',
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });
  const { data: lifetimeDistributed } = useReadContract({
    address: REVENUE_DISTRIBUTOR_ADDRESS,
    abi: REVENUE_DISTRIBUTOR_ABI,
    functionName: 'totalDistributed',
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });

  // R070: surface SwapFeeRouter.paused() with an amber banner so users see
  // when fee routing is halted (no stakers/POL/treasury distribution while
  // paused). Surface treasury() vs the hardcoded TREASURY_ADDRESS with a RED
  // banner if they disagree — that means the on-chain treasury rotated and
  // the frontend constant is stale.
  const { data: routerPaused } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SWAP_FEE_ROUTER_ABI,
    functionName: 'paused',
    chainId: CHAIN_ID,
    query: { refetchInterval: 60_000 },
  });
  const { data: routerTreasury } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SWAP_FEE_ROUTER_ABI,
    functionName: 'treasury',
    chainId: CHAIN_ID,
    query: { refetchInterval: 300_000, staleTime: 60_000 },
  });
  const treasuryRotationPending = useMemo(() => {
    if (!routerTreasury || typeof routerTreasury !== 'string') return false;
    return routerTreasury.toLowerCase() !== TREASURY_ADDRESS.toLowerCase();
  }, [routerTreasury]);
  const stakerBps = stakerShareData !== undefined ? Number(stakerShareData as bigint) : 10_000;
  const polBps = polShareData !== undefined ? Number(polShareData as bigint) : 0;
  const treasuryBps = Math.max(0, 10_000 - stakerBps - polBps);
  const split = [
    { label: 'Stakers', bps: stakerBps, color: SPLIT_COLORS.stakers },
    { label: 'Protocol-Owned Liquidity', bps: polBps, color: SPLIT_COLORS.pol },
    { label: 'Treasury', bps: treasuryBps, color: SPLIT_COLORS.treasury },
  ];

  // Stage one. Defaults match the live contract (referralFeeBps = 2000) so the
  // card is coherent before the read resolves rather than briefly claiming 0%.
  const referralBps = referralBpsData !== undefined ? Number(referralBpsData as bigint) : 2_000;
  const routerCreditBps = Math.max(0, 10_000 - referralBps);
  const stageOne = [
    {
      label: 'Referrer share — held in ReferralSplitter',
      bps: referralBps,
      color: SPLIT_COLORS.referral,
      note: 'Paid to the swapper’s referrer if they hold enough voting power. Unattributed shares stay in the splitter as treasury-claimable ETH.',
    },
    {
      label: 'Credited back to SwapFeeRouter',
      bps: routerCreditBps,
      color: SPLIT_COLORS.credit,
      note: 'The remainder is booked as a pull-pattern credit, not sent. It stays in the splitter until recoverCallerCredit() moves it into the Stage 2 pool.',
    },
  ];

  const creditWei = routerCredit as bigint | undefined;
  const splitterTreasuryWei = splitterTreasuryEth as bigint | undefined;
  const splitterPendingWei = splitterPendingRef as bigint | undefined;
  const accruedWei = routerAccrued as bigint | undefined;
  const distributedWei = lifetimeDistributed as bigint | undefined;
  const lifetimeWei = totalFeesWei as bigint | undefined;
  const splitterHeldWei = splitterBal?.value;

  // The reconciliation. Order follows the money, not the org chart.
  // `id` doubles as the React key and as a data-testid, so a test can assert on
  // the AMOUNT in a specific row rather than on the prose around it.
  const ledger: {
    id: string;
    label: string;
    wei: bigint | undefined;
    note: string;
    source?: string;
    pct?: string;
    indent?: boolean;
    emphasis?: boolean;
  }[] = [
    {
      id: 'collected',
      label: 'Collected, lifetime',
      wei: lifetimeWei,
      note: 'SwapFeeRouter.totalETHFees()',
      source: SWAP_FEE_ROUTER_ADDRESS,
    },
    {
      id: 'splitter-held',
      label: 'Held by ReferralSplitter right now',
      wei: splitterHeldWei,
      note: 'ETH balance of the splitter contract',
      source: REFERRAL_SPLITTER_ADDRESS,
      pct: pctOf(splitterHeldWei, lifetimeWei),
    },
    {
      id: 'router-credit',
      label: 'of which: owed back to the router, not yet pulled',
      wei: creditWei,
      note: 'ReferralSplitter.callerCredit(SwapFeeRouter) — released by the permissionless recoverCallerCredit()',
      pct: pctOf(creditWei, lifetimeWei),
      indent: true,
      emphasis: creditWei !== undefined && creditWei > 0n,
    },
    {
      id: 'splitter-treasury',
      label: 'of which: referral slice with no qualified referrer',
      wei: splitterTreasuryWei,
      note: 'ReferralSplitter.accumulatedTreasuryETH() — treasury-claimable, still inside the splitter',
      pct: pctOf(splitterTreasuryWei, lifetimeWei),
      indent: true,
    },
    {
      id: 'referrer-pending',
      label: 'of which: claimable by referrers',
      wei: splitterPendingWei,
      note: 'ReferralSplitter.totalPendingETH()',
      pct: pctOf(splitterPendingWei, lifetimeWei),
      indent: true,
    },
    {
      id: 'router-accrued',
      label: 'Waiting in the router to be split',
      wei: accruedWei,
      note: 'SwapFeeRouter.accumulatedETHFees() — the pool the Stage 2 percentages divide',
      source: SWAP_FEE_ROUTER_ADDRESS,
    },
    {
      id: 'distributed',
      label: 'Distributed to stakers, lifetime',
      wei: distributedWei,
      note: 'RevenueDistributor.totalDistributed()',
      source: REVENUE_DISTRIBUTOR_ADDRESS,
    },
  ];

  // Fees were collected but nothing ever completed the pipeline. Stated only
  // when both reads have resolved, so a pending read never accuses the protocol.
  const stakersNeverPaid =
    lifetimeWei !== undefined && lifetimeWei > 0n && distributedWei !== undefined && distributedWei === 0n;

  // F451: keep the underlying read's loaded/undefined state distinct so a
  // successful zero shows "$0.00"/"0 ETH" and only a pending/failed read shows
  // "–". `totalFeesWei`/`treasuryBal` are undefined until their read resolves.
  const lifetimeFeesEth = totalFeesWei !== undefined ? parseFloat(formatEther(totalFeesWei as bigint)) : 0;
  const lifetimeFeesUsd = totalFeesWei !== undefined ? lifetimeFeesEth * (price.ethUsd || 0) : undefined;

  const treasuryEthFormatted = treasuryBal ? formatEth(treasuryBal.value) : '–';
  const treasuryUsd = treasuryBal ? parseFloat(formatEther(treasuryBal.value)) * (price.ethUsd || 0) : undefined;

  // POL LP value estimate: share of pool TVL owned by accumulator
  const polShare = useMemo(() => {
    if (!polLpBal || !pool.lpSupply || pool.lpSupply === 0n) return 0;
    return Number(polLpBal as bigint) / Number(pool.lpSupply);
  }, [polLpBal, pool.lpSupply]);
  const polUsd = polLpBal !== undefined ? polShare * pool.tvl : undefined;

  const stats: { label: string; value: string; sub: string; idx: number }[] = [
    { label: 'Total Value Locked', value: pool.tvlFormatted, sub: 'TOWELI/WETH pool', idx: 1 },
    // `${lifetimeFeesEth.toFixed(4)} ETH routed` rendered the protocol's entire
    // 3e12-wei take as "0.0000 ETH routed" — a real number displayed as nothing.
    // formatEthFine steps down to gwei/wei so the sub-line can never do that.
    { label: 'Lifetime Fees', value: formatUsd(lifetimeFeesUsd), sub: `${formatEthFine(totalFeesWei as bigint | undefined)} routed`, idx: 2 },
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
        <div className="mb-6">
          <p className="text-white/65 text-[11px] uppercase tracking-[0.2em] label-pill mb-3">Public Transparency</p>
          <h1 className="heading-luxury text-4xl md:text-5xl text-white mb-3" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.9)' }}>Treasury</h1>
          <p className="text-white/80 text-[14px] max-w-[640px] leading-relaxed" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
            Live, on-chain view of protocol treasury, protocol-owned liquidity, lifetime fees, and how
            revenue is distributed. All figures are read directly from Ethereum mainnet.
          </p>
          {/* R070: as-of block — every read on this page reflects state at the
              latest block number. Live ticker via useBlockNumber({ watch:true }). */}
          {latestBlock !== undefined && (
            <p className="text-white/50 text-[11px] mt-2 font-mono" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
              as of block #{latestBlock.toString()}
            </p>
          )}
        </div>

        {/* R070: status banners. Order matters — the rotation banner is most
            severe (frontend lying about treasury), the paused banner is amber
            (informational), the oracleStale banner is purple (price-derived
            stats fall back to on-chain values). */}
        {treasuryRotationPending && routerTreasury && (
          <div role="alert"
            className="mb-4 rounded-xl border px-4 py-3 text-[13px]"
            style={{ background: 'rgba(239,68,68,0.12)', borderColor: 'rgba(239,68,68,0.45)', color: '#fecaca' }}>
            <strong className="font-semibold">Treasury rotation pending.</strong> The on-chain SwapFeeRouter
            treasury is{' '}
            <span className="font-mono">{shortenAddress(routerTreasury as string, 6)}</span>{' '}
            but this page still references{' '}
            <span className="font-mono">{shortenAddress(TREASURY_ADDRESS, 6)}</span>. Treat balances on
            this page as <em>frontend-state</em> until the constants update.
          </div>
        )}
        {routerPaused === true && (
          <div role="status"
            className="mb-4 rounded-xl border px-4 py-3 text-[13px]"
            style={{ background: 'rgba(245,158,11,0.12)', borderColor: 'rgba(245,158,11,0.4)', color: '#fde68a' }}>
            <strong className="font-semibold">Fee routing paused.</strong> SwapFeeRouter is currently
            paused; new swap fees are not being distributed to stakers, POL, or treasury until it resumes.
          </div>
        )}
        {price.oracleStale && (
          <div role="status"
            className="mb-6 rounded-xl border px-4 py-3 text-[13px]"
            style={{ background: 'rgba(139,92,246,0.10)', borderColor: 'rgba(139,92,246,0.40)', color: '#ddd6fe' }}>
            <strong className="font-semibold">Price oracle is stale.</strong> USD figures shown derive
            from a delayed price feed; ETH amounts on-chain are authoritative.
          </div>
        )}

        {/* Top stats — each tile overlays its own ArtImg so the grid feels art-first. */}
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-10">
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

        {/* Treasury-by-design note: a near-zero treasury balance is intentional.
            Design intent (docs/OPEX.md self-sustain bar, decided 2026-06-07) is to
            fund off-chain opex from ETH swap + marketplace fees before any
            ETH-outflow feature ships — no pre-funded war chest, no ETH held or
            spent ahead of the revenue meant to back it. Additive copy only. */}
        <p className="text-white/55 text-[12px] max-w-[720px] leading-relaxed mb-10" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>
          A near-zero treasury is by design — the protocol is built to fund its operating costs from ETH swap and marketplace fees rather than a pre-funded war chest, so no ETH is held or spent ahead of the revenue meant to back it.
        </p>

        {/* Distribution split — inner card layer over the page art. */}
        <div className="relative overflow-hidden rounded-xl p-6 md:p-8 mb-10" style={glass}>
          <div className="absolute inset-0 opacity-30">
            <ArtImg pageId="treasury" idx={5} alt="" loading="lazy" className="w-full h-full object-cover" />
          </div>
          <div className="relative z-10">
        <div className="flex items-baseline justify-between mb-2">
          <h2 className="heading-luxury text-xl text-white">Revenue Distribution</h2>
          <span className="text-white/40 text-[11px]">Per swap fee</span>
        </div>
        <p className="text-white/60 text-[12px] leading-relaxed mb-6 max-w-[640px]">
          A swap fee passes through two contracts, in this order. Both stages are shown
          because only showing the second one made it look as though fees reach stakers —
          they have not.
        </p>

        {/* ── STAGE ONE — the contract this card used to leave out entirely. ── */}
        <p className="text-white/75 text-[11px] uppercase tracking-[0.16em] mb-1">Stage 1 · at collection — ReferralSplitter</p>
        <p className="text-white/50 text-[11px] leading-relaxed mb-3 max-w-[640px]">
          100% of every swap fee is forwarded to <span className="text-white/75">ReferralSplitter</span> before
          it can reach the pool that Stage 2 divides. This is where the money is today.
        </p>
        <div
          className="flex h-3 rounded-full overflow-hidden mb-4"
          role="img"
          aria-label={`Stage 1 split at collection: ${stageOne.filter(s => s.bps > 0).map(s => `${(s.bps / 100).toFixed(0)}% ${s.label}`).join(', ')}`}
        >
          {stageOne.filter(s => s.bps > 0).map((s) => (
            <div key={s.label} style={{ width: `${s.bps / 100}%`, background: s.color }} />
          ))}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
          {stageOne.map((s) => (
            <div key={s.label} className="flex items-start gap-3" style={{ opacity: s.bps === 0 ? 0.45 : 1 }}>
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0 mt-1.5" style={{ background: s.color }} />
              <div>
                <p className="text-white text-[13px]">{s.label}</p>
                <p className="text-white/50 text-[11px]">{(s.bps / 100).toFixed(0)}% ({s.bps} bps){s.bps === 0 ? ' · inactive' : ''}</p>
                <p className="text-white/45 text-[11px] leading-relaxed mt-0.5">{s.note}</p>
              </div>
            </div>
          ))}
        </div>

        {/* ── STAGE TWO — the original bar. Unchanged in what it renders; the
             heading and the caption below it are what changed, so nobody reads
             "100% stakers" as "stakers were paid". ── */}
        <p className="text-white/75 text-[11px] uppercase tracking-[0.16em] mb-1">Stage 2 · after recovery — SwapFeeRouter</p>
        <p className="text-white/50 text-[11px] leading-relaxed mb-3 max-w-[640px]">
          How the router divides whatever has actually reached its distributable pool
          (<span className="font-mono">accumulatedETHFees</span>). Stage 1&apos;s credit has to be
          pulled back with a <span className="font-mono">recoverCallerCredit()</span> call before
          anything lands here.
        </p>

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

        {/* The percentages above are a policy. This is the outcome. */}
        <div className="mt-8 pt-6 border-t border-white/10">
          <h3 className="text-white text-[14px] font-medium mb-1">Where the money actually is</h3>
          <p className="text-white/50 text-[11px] leading-relaxed mb-4 max-w-[640px]">
            Live balances, not intentions. Every row is a single contract read; follow the
            source link to check any of them yourself.
          </p>
          <div className="space-y-2.5">
            {ledger.map((row) => (
              <div
                key={row.id}
                data-testid={`ledger-${row.id}`}
                className={`flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1 ${row.indent ? 'sm:pl-5' : ''}`}
              >
                <div className="min-w-0">
                  <p className={`text-[13px] ${row.emphasis ? 'text-amber-200' : 'text-white/80'}`}>
                    {row.indent ? <span className="text-white/30 mr-1.5">└</span> : null}
                    {row.label}
                  </p>
                  <p className="text-white/40 text-[11px] leading-relaxed">
                    {row.note}
                    {row.source ? <> <SourceLink chainId={chainId} address={row.source} label={row.label} /></> : null}
                  </p>
                </div>
                <p className={`font-mono text-[13px] tabular-nums shrink-0 ${row.emphasis ? 'text-amber-200' : 'text-white'}`}>
                  {formatEthFine(row.wei)}
                  {row.pct ? <span className="text-white/40"> · {row.pct}</span> : null}
                </p>
              </div>
            ))}
          </div>
          {stakersNeverPaid && (
            <p role="status" className="mt-5 rounded-xl border px-4 py-3 text-[12px] leading-relaxed"
              style={{ background: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.35)', color: '#fde68a' }}>
              <strong className="font-semibold">Stakers have not been paid any swap-fee revenue yet.</strong>{' '}
              Fees were collected, but none has completed the pipeline: the Stage 1 credit is
              still sitting in ReferralSplitter, so the Stage 2 split above has had nothing to
              divide. The recovery call that moves it is permissionless — anyone can trigger
              it — which is why it is worth saying out loud rather than leaving it as a
              100%-to-stakers bar that has never paid out.
            </p>
          )}
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
                // 🔄 2026-08-12: added. A transparency page that lists three fee
                // contracts and omits the two that the money is actually sitting
                // in (splitter) or is supposed to end up in (distributor) is not
                // a complete list. Both are read live in the card above.
                { label: 'Referral Splitter', addr: REFERRAL_SPLITTER_ADDRESS },
                { label: 'Revenue Distributor', addr: REVENUE_DISTRIBUTOR_ADDRESS },
              ].map((row) => (
                <div key={row.label} className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 py-2 border-b border-white/5 last:border-b-0">
                  <span className="text-white/75 text-[13px]">{row.label}</span>
                  <div className="flex items-center gap-3">
                    <CopyButton
                      text={row.addr}
                      display={shortenAddress(row.addr, 6)}
                      className="font-mono text-[12px] text-white"
                    />
                    {/* R070: chain-aware explorer URL via SourceLink — was
                        hardcoded to etherscan.io (broken on testnets / L2s). */}
                    <SourceLink chainId={chainId} address={row.addr} label={row.label} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Recent treasury transactions — real on-chain feed */}
        <RecentTreasuryTransactions chainId={chainId} />
      </m.section>
    </div>
  );
}

// Real "Recent Treasury Transactions" feed. Reuses the hardened, schema-
// validated Etherscan path (lib/txHistory) and merges normal + internal
// transfers so contract-routed fee inflows show alongside direct in/outflows.
// Scoped to ETH value flows; the full ledger (incl. token transfers) stays one
// click away on the block explorer.
function RecentTreasuryTransactions({ chainId }: { chainId: number }) {
  const [rows, setRows] = useState<TxRecord[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    Promise.allSettled([
      fetchAddressTxList(TREASURY_ADDRESS, controller.signal, 'txlist'),
      fetchAddressTxList(TREASURY_ADDRESS, controller.signal, 'txlistinternal'),
    ])
      .then((results) => {
        if (controller.signal.aborted) return;
        const ok = results.filter(
          (r): r is PromiseFulfilledResult<TxRecord[]> => r.status === 'fulfilled',
        );
        if (ok.length === 0) {
          setError('Treasury activity is momentarily unavailable.');
          setRows([]);
          return;
        }
        const seen = new Set<string>();
        const merged = ok
          .flatMap((r) => r.value)
          // Value-bearing ETH flows only; token transfers live on the explorer.
          .filter((tx) => tx.value && tx.value !== '0')
          .sort((a, b) => Number(b.timeStamp) - Number(a.timeStamp))
          .filter((tx) => {
            const k = `${tx.hash}-${tx.from ?? ''}-${tx.to}-${tx.value}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .slice(0, 10);
        setRows(merged);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  const treasury = TREASURY_ADDRESS.toLowerCase();

  return (
    <div className="relative overflow-hidden rounded-xl p-6 md:p-8" style={glass}>
      <div className="absolute inset-0 opacity-25">
        <ArtImg pageId="treasury" idx={7} alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>
      <div className="relative z-10">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 className="heading-luxury text-xl text-white" style={{ textShadow: '0 1px 4px rgba(0,0,0,0.85)' }}>Recent Treasury Transactions</h2>
          <a
            href={getAddressUrl(chainId, TREASURY_ADDRESS)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-white/70 hover:text-white text-[12px] underline shrink-0"
            aria-label="View full treasury ledger on block explorer (opens in new tab)"
          >
            Full ledger ↗
          </a>
        </div>

        {loading ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded-lg bg-black/30 border border-white/10 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <p className="text-white/70 text-[13px] leading-relaxed">
            {error} All activity remains auditable on the{' '}
            <a href={getAddressUrl(chainId, TREASURY_ADDRESS)} target="_blank" rel="noopener noreferrer" className="text-white underline hover:text-white/80">block explorer ↗</a>.
          </p>
        ) : rows && rows.length > 0 ? (
          <div className="divide-y divide-white/10">
            {rows.map((tx, i) => {
              const inflow = tx.to.toLowerCase() === treasury;
              const counterparty = inflow ? (tx.from ?? tx.to) : tx.to;
              const eth = Number(formatEther(BigInt(tx.value)));
              const ethShort = eth.toLocaleString(undefined, { maximumFractionDigits: 4 });
              return (
                <a
                  key={`${tx.hash}-${i}`}
                  href={getTxUrl(chainId, tx.hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-between gap-3 py-2.5 -mx-2 px-2 rounded hover:bg-white/5 transition-colors"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 ${inflow ? 'text-emerald-300 bg-emerald-500/15' : 'text-amber-300 bg-amber-500/15'}`}>
                      {inflow ? 'IN' : 'OUT'}
                    </span>
                    <span className="text-white/80 text-[12px] font-mono truncate">
                      {inflow ? 'from' : 'to'} {shortenAddress(counterparty)}
                    </span>
                    {tx.isError !== '0' && <span className="text-danger text-[10px] shrink-0">failed</span>}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className={`text-[12px] font-mono tabular-nums ${inflow ? 'text-emerald-300' : 'text-white'}`}>
                      {inflow ? '+' : '−'}{ethShort} <span className="text-white/50">ETH</span>
                    </span>
                    <span className="text-white/45 text-[11px] tabular-nums w-16 text-right">{formatTimeAgo(Number(tx.timeStamp))}</span>
                  </div>
                </a>
              );
            })}
          </div>
        ) : (
          <p className="text-white/70 text-[13px] leading-relaxed">
            No ETH transfers recorded yet — inflows and outflows will appear here as they happen. The full ledger is on the{' '}
            <a href={getAddressUrl(chainId, TREASURY_ADDRESS)} target="_blank" rel="noopener noreferrer" className="text-white underline hover:text-white/80">block explorer ↗</a>.
          </p>
        )}
      </div>
    </div>
  );
}
