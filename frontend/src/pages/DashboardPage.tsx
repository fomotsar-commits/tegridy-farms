import { useMemo, useEffect, useRef, useState } from 'react';
import { m } from 'framer-motion';
import { useAccount, useBalance, useChainId, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { Link, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { TOWELI_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, POL_ACCUMULATOR_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';
import { ERC20_ABI, REVENUE_DISTRIBUTOR_ABI } from '../lib/contracts';
import { useUserPosition } from '../hooks/useUserPosition';
import { useLpPosition } from '../hooks/useLpPosition';
import { usePoolData } from '../hooks/usePoolData';
import { useTOWELIPrice } from '../contexts/PriceContext';
import { useFarmActions } from '../hooks/useFarmActions';
import { useNFTBoost } from '../hooks/useNFTBoost';
import { useDCA } from '../hooks/useDCA';
import { useLimitOrders } from '../hooks/useLimitOrders';
import { useMyLoans } from '../hooks/useMyLoans';
import { pageArt, artStyle } from '../lib/artConfig';
import { formatTokenAmount, formatCurrency, formatWholeNumber, formatWei, formatTimeAgo } from '../lib/formatting';
import { Skeleton } from '../components/ui/Skeleton';
import { AnimatedCounter } from '../components/AnimatedCounter';
import { Sparkline } from '../components/Sparkline';
import { PulseDot } from '../components/PulseDot';
import { TegridyScoreMini } from '../components/TegridyScoreMini';
import { usePriceHistory } from '../hooks/usePriceHistory';
import { FlashValue } from '../components/FlashValue';
import { PriceChart } from '../components/chart/PriceChart';
import { ErrorBoundary } from '../components/ui/ErrorBoundary';
import { ConnectPrompt } from '../components/ui/ConnectPrompt';
import { usePageTitle } from '../hooks/usePageTitle';
import { useNetworkCheck } from '../hooks/useNetworkCheck';
import { useRevenueStats } from '../hooks/useRevenueStats';
import { ReferralWidget } from '../components/ReferralWidget';
import { PriceAlertWidget } from '../components/PriceAlertWidget';
import { ArtImg } from '../components/ArtImg';
import { useTowelie } from '../hooks/useTowelie';
import { useTabListKeys } from '../hooks/useTabListKeys';

// AUDIT DASH-UX: tabbed view promised by commit b21fed0 but never shipped.
// Header + summary stats stay above the tabs so at-a-glance portfolio value
// is always in view; the rest of the page is split by concern.
type DashTab = 'overview' | 'positions' | 'loans' | 'rewards';
const DASH_TABS: { key: DashTab; label: string }[] = [
  { key: 'overview',  label: 'Overview' },
  { key: 'positions', label: 'Positions' },
  { key: 'loans',     label: 'Loans' },
  { key: 'rewards',   label: 'Rewards' },
];
const VALID_DASH_TABS: DashTab[] = ['overview', 'positions', 'loans', 'rewards'];
function dashTabFromQuery(v: string | null): DashTab | null {
  if (!v) return null;
  return (VALID_DASH_TABS as string[]).includes(v) ? (v as DashTab) : null;
}

export default function DashboardPage() {
  usePageTitle('Dashboard', 'Real-time protocol analytics, TVL, and TOWELI token metrics.');
  const { isConnected, address, isReconnecting, isConnecting } = useAccount();
  const { isWrongNetwork } = useNetworkCheck();
  const [searchParams, setSearchParams] = useSearchParams();
  // R007 Pattern A — derive `tab` directly from ?tab=. URL is source of truth.
  const tab: DashTab = dashTabFromQuery(searchParams.get('tab')) ?? 'overview';
  const handleTabChange = (next: DashTab) => {
    const params = new URLSearchParams(searchParams);
    if (next === 'overview') params.delete('tab');
    else params.set('tab', next);
    setSearchParams(params, { replace: true });
  };
  // T10 (F145): WAI-ARIA tabs roving-focus + arrow-key navigation.
  const tabKeys = useTabListKeys(VALID_DASH_TABS, tab, handleTabChange);
  // R047 M1: chain-pin balance reads so a wrong-network wallet doesn't price
  // another chain's native balance as mainnet ETH in the Portfolio Value.
  const { data: ethBalance, isLoading: isEthLoading, error: ethError } = useBalance({ address, chainId: CHAIN_ID });
  // useToweliPrice already fetches from GeckoTerminal as fallback — no duplicate fetch needed
  const price = useTOWELIPrice();
  const farmActions = useFarmActions();
  const nft = useNFTBoost();
  const dca = useDCA();
  const limitOrders = useLimitOrders();
  const myLoans = useMyLoans();
  const pos = useUserPosition();
  const lpPos = useLpPosition(address);
  const pool = usePoolData();
  const { history: priceHistory } = usePriceHistory();
  const revenueStats = useRevenueStats();

  const { data: toweliBalance, isLoading: isToweliLoading, error: toweliError } = useReadContract({
    address: TOWELI_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    chainId: CHAIN_ID,
    query: { enabled: !!address },
  });

  const walletToweli = useMemo(() => toweliBalance ? Number(formatEther(toweliBalance)) : 0, [toweliBalance]);
  const pendingTotal = Number(pos.pendingFormatted);
  const stakedTotal = Number(pos.stakedFormatted);

  // Portfolio value in USD
  const ethBal = useMemo(() => ethBalance ? Number(formatEther(ethBalance.value)) : 0, [ethBalance]);
  // USD value of the user's LP position (redeemable TOWELI + WETH).
  const lpUsd = useMemo(() => price.isLoaded
    ? (lpPos.toweliAmount * price.priceInUsd) + (price.oracleStale ? 0 : lpPos.wethAmount * price.ethUsd)
    : 0, [lpPos.toweliAmount, lpPos.wethAmount, price.isLoaded, price.priceInUsd, price.ethUsd, price.oracleStale]);
  // F153: claimable legs shown elsewhere on this same page but previously omitted
  // from Portfolio Value — pending ETH revenue + referral ETH (ETH-denominated,
  // zeroed when the oracle is stale like the other ETH legs) and unsettled TOWELI.
  const unsettledTotal = useMemo(() => Number(pos.unsettledFormatted) || 0, [pos.unsettledFormatted]);
  const claimableUsd = useMemo(() => price.isLoaded ? (
    (price.oracleStale ? 0 : (revenueStats.pendingRevenue + revenueStats.referralPending) * price.ethUsd) +
    (unsettledTotal * price.priceInUsd)
  ) : 0, [revenueStats.pendingRevenue, revenueStats.referralPending, unsettledTotal, price.isLoaded, price.priceInUsd, price.ethUsd, price.oracleStale]);
  const portfolioUsd = useMemo(() => price.isLoaded ? (
    (walletToweli * price.priceInUsd) +
    (stakedTotal * price.priceInUsd) +
    (pendingTotal * price.priceInUsd) +
    (price.oracleStale ? 0 : ethBal * price.ethUsd) +
    lpUsd +
    (lpPos.pendingRewards * price.priceInUsd) +
    claimableUsd
  ) : 0, [walletToweli, stakedTotal, pendingTotal, ethBal, lpUsd, lpPos.pendingRewards, claimableUsd, price.isLoaded, price.priceInUsd, price.ethUsd, price.oracleStale]);

  // F155: manual refresh affordance + "updated Xs ago" stamp. The page already
  // polls in the background; this gives the user an explicit re-read and a sense
  // of data freshness. `nowTick` re-renders the relative label ~every 10s so the
  // stamp doesn't sit stale between background polls.
  const [lastRefreshed, setLastRefreshed] = useState(() => Math.floor(Date.now() / 1000));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [, setNowTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 10_000);
    return () => clearInterval(id);
  }, []);
  const handleRefresh = async () => {
    if (isRefreshing) return;
    setIsRefreshing(true);
    try {
      await Promise.all([pos.refetchAll(), revenueStats.refetch()]);
    } finally {
      setLastRefreshed(Math.floor(Date.now() / 1000));
      setIsRefreshing(false);
    }
  };

  // Claim handler
  const handleClaim = () => {
    if (isWrongNetwork || pendingTotal < 0.01 || !pos.hasPosition) return;
    farmActions.claim(pos.tokenId);
  };

  // Show success toast after claim confirms.
  // R047 M2: dedup by tx hash so a wagmi cache rehydration that surfaces
  // `isSuccess: true` on remount can't fire a second toast for the same tx.
  const claimToastFiredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!farmActions.isSuccess) return;
    const key = farmActions.hash ?? '__no_hash__';
    if (claimToastFiredRef.current.has(key)) return;
    claimToastFiredRef.current.add(key);
    toast.success('Rewards claimed successfully!');
    // F137 (T5): refetch the position immediately so the Claimable card and the
    // Claim button drop to ~0 within a block instead of staying re-clickable for
    // up to 30s. Gated once-per-hash by claimToastFiredRef above.
    pos.refetchAll();
    revenueStats.refetch();
  }, [farmActions.isSuccess, farmActions.hash]); // eslint-disable-line react-hooks/exhaustive-deps -- pos/revenueStats refetch handles are stable; intentionally fire once per confirmed hash

  // Towelie nudge: surface unclaimed yield. Dedup by `key` so the bubble
  // doesn't re-fire on every price tick or remount — once per page load.
  // R047 H1: depend on `nudgeKey = round(pendingTotal*100)` so sub-cent
  // floating-point churn from the position hook doesn't re-fire the effect
  // on every price tick. `say` is stable from `TowelieProvider` (useCallback).
  const { say } = useTowelie();
  const nudgeKey = Math.round(pendingTotal * 100);
  useEffect(() => {
    if (!isConnected || isWrongNetwork) return;
    if (!pos.hasPosition || nudgeKey < 1) return;
    const amount = (nudgeKey / 100).toFixed(2);
    say(`You've got ${amount} TOWELI waiting. Claim it.`, { key: 'unclaimed-yield' });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- say is stable; nudgeKey is the de-floated dep
  }, [isConnected, isWrongNetwork, pos.hasPosition, nudgeKey]);

  // Price change indicator
  const priceChangeStr = price.priceChange !== 0
    ? `${price.priceChange > 0 ? '+' : ''}${(price.priceChange ?? 0).toFixed(2)}%`
    : '';

  // F173 (T11): during wallet auto-reconnect on cold reload, `isConnected` is
  // briefly false-then-true (or true-then-false), which made the connected
  // skeleton grid flash and collapse to the connect gate — a bait-and-switch.
  // Gate on the resolving signal: while reconnecting/connecting and not yet
  // connected, show a neutral resolving state instead of either extreme.
  if (!isConnected && (isReconnecting || isConnecting)) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <ArtImg pageId="dashboard" idx={0} fallbackPosition="center 5%" alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 min-h-screen flex items-center justify-center px-6" role="status" aria-label="Reconnecting wallet">
          <div className="flex flex-col items-center gap-3 px-6 py-8 rounded-2xl" style={{ background: 'rgba(6, 12, 26, 0.82)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', border: '1px solid rgba(245, 228, 184, 0.12)' }}>
            <div className="w-6 h-6 rounded-full border-2 border-white/20 border-t-white/70 animate-spin" />
            <p className="text-white/70 text-[13px]">Reconnecting your wallet…</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="-mt-14 relative min-h-screen">
        <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
          <ArtImg pageId="dashboard" idx={0} fallbackPosition="center 5%" alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        {/* F138 / F170 (T7): render the wallet-independent protocol data for
            logged-out visitors instead of an empty connect void. TOWELI price,
            TVL, APR and lifetime ETH distributed all read from connection-
            independent hooks; the price chart needs no account. Additive over
            the camo art — the ConnectPrompt stays as the action slot below. */}
        <div className="relative z-10 max-w-[1100px] mx-auto px-4 md:px-6 pt-20 pb-10">
          <m.div className="mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
            <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">Dashboard</h1>
            <p className="text-white text-[13px]">Live protocol metrics &middot; connect to track your position</p>
          </m.div>

          {/* Public protocol-stats strip — same data the connected dashboard shows. */}
          <div className="flex flex-wrap gap-3 mb-6">
            {([
              { l: 'TOWELI Price', v: price.isLoaded && price.priceInUsd > 0 ? formatCurrency(price.priceInUsd, 6) : '–', showSparkline: true },
              { l: 'TVL', v: pool.isDeployed && Number(pool.totalStaked) > 0 ? `${formatWholeNumber(Number(pool.totalStaked))} TOWELI` : '–' },
              { l: 'Base APR', v: pool.isDeployed && pool.aprNum > 0 ? `${pool.apr}%` : '–' },
              { l: 'ETH Distributed', v: revenueStats.isDataLoading ? null : `${revenueStats.totalDistributed.toFixed(4)} ETH` },
            ] as { l: string; v: string | null; showSparkline?: boolean }[]).map((s) => (
              <div key={s.l} className="flex items-center gap-3 px-4 py-2.5 rounded-lg"
                style={{ background: 'rgba(0,0,0,0.78)', border: '1px solid rgba(76,175,80,0.35)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}>
                <span className="text-[12px]" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{s.l}</span>
                <span className="stat-value text-[13px]" style={{ color: 'var(--color-kyle)', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
                  {s.v === null ? <span className="inline-block w-16 h-4 rounded bg-black/60 shimmer" /> : s.v}
                </span>
                {s.showSparkline && priceHistory.length > 1 && (
                  <Sparkline data={priceHistory} width={48} height={16} />
                )}
              </div>
            ))}
          </div>

          {/* TOWELI price chart — wallet-independent. */}
          <div className="rounded-xl glass-card-animated p-4 mb-2" style={{ border: '1px solid var(--color-purple-75)', background: 'rgba(6,12,26,0.72)' }}>
            <div className="h-[260px]">
              <ErrorBoundary fallback={<div className="flex items-center justify-center h-full text-white text-[13px]">Chart unavailable</div>}><PriceChart /></ErrorBoundary>
            </div>
          </div>
        </div>

        {/* F519: use the shared dark-card ConnectPrompt (same as /farm) so the
            wallet-gate stays legible over the busy camo art instead of the bare
            text-center block that dissolved into the camouflage at 820px+. */}
        <div className="relative z-10 flex items-center justify-center px-6 pb-16">
          <ConnectPrompt surface="dashboard" />
        </div>
      </div>
    );
  }

  return (
    <div className="-mt-14 relative min-h-screen">
      <div className="fixed inset-0 z-0" style={{ background: '#060c1a' }}>
        <ArtImg pageId="dashboard" idx={1} fallbackPosition="center 85%" alt="" loading="lazy" className="w-full h-full object-cover" />
      </div>

      <ErrorBoundary>
      <div className="relative z-10 max-w-[1200px] mx-auto px-4 md:px-6 pt-20 pb-28 md:pb-12">
        {isWrongNetwork && (
          <div role="alert" aria-live="assertive" className="mb-4 px-4 py-3 rounded-xl bg-warning/10 border border-warning/30 text-warning text-[13px] text-center">
            Wrong network detected. Please switch to Ethereum Mainnet.
          </div>
        )}
        {/* Header with Portfolio Value */}
        <m.div className="mb-8" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <h1 className="heading-luxury text-2xl md:text-3xl lg:text-4xl text-white tracking-tight mb-1">Dashboard</h1>
              {nft.boostLabel && (
                <span className="badge badge-warning text-[10px]">{nft.boostLabel}</span>
              )}
            </div>
            <div className="flex items-center gap-3">
              <Link to="/leaderboard" className="text-[12px] text-white/70 hover:text-white transition-colors">
                Points &#8594;
              </Link>
              <Link to="/history" className="text-[12px] text-white/70 hover:text-white transition-colors">
                History &#8594;
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-3 mt-2">
            {price.isLoaded ? (
              <AnimatedCounter value={portfolioUsd} prefix="$" decimals={2} className="stat-value text-2xl md:text-3xl text-white" />
            ) : (
              <Skeleton width={120} height={32} />
            )}
            <span className="text-white text-[13px]">Portfolio Value</span>
            {/* F135: when the oracle is stale the ETH/WETH legs are zeroed out of
                the total — flag it so the user doesn't read the drop as a real
                portfolio loss. Reuses the "Stale" chip from the price card. */}
            {price.isLoaded && price.oracleStale && (
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold"
                style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}
                title="ETH price oracle is stale — ETH-denominated value is temporarily excluded"
              >
                Stale · excl. ETH
              </span>
            )}
            {/* F155: manual refresh + last-updated stamp. */}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={isRefreshing}
              aria-label="Refresh portfolio data"
              title="Refresh"
              className="text-white/55 hover:text-white transition-colors disabled:opacity-50"
            >
              <svg
                className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`}
                viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <polyline points="21 3 21 9 15 9" />
              </svg>
            </button>
            <span className="text-white/45 text-[10px]" aria-live="polite">updated {formatTimeAgo(lastRefreshed)}</span>
          </div>
          {/* F153: surface the claimable legs now folded into Portfolio Value. */}
          {price.isLoaded && claimableUsd > 0.005 && (
            <p className="text-white/50 text-[11px] mt-1">incl. {formatCurrency(claimableUsd)} claimable</p>
          )}
        </m.div>

        {/* Summary Stats */}
        <m.div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
          {[
            { l: 'TOWELI Balance', numVal: walletToweli, decimals: 0, sub: price.isLoaded ? formatCurrency(walletToweli * price.priceInUsd) : '–', art: pageArt('dashboard', 2), loading: isToweliLoading, error: toweliError },
            { l: 'ETH Balance', numVal: ethBal, decimals: 4, sub: ethBalance && price.ethUsd > 0 ? formatCurrency(ethBal * price.ethUsd) : '–', art: pageArt('dashboard', 3), loading: isEthLoading, error: ethError },
            // F141: the claimable TOWELI amount comes from useUserPosition, not
            // the price feed — gate the value's skeleton on pos.isLoading so it
            // doesn't flash "0.00" while the position loads, nor spin forever when
            // only the price feed is unavailable (the USD sub-line still uses price).
            { l: 'Claimable', numVal: pendingTotal, decimals: 2, sub: price.isLoaded ? formatCurrency(pendingTotal * price.priceInUsd) : '–', accent: true, art: pageArt('dashboard', 4), loading: pos.isLoading },
            { l: 'TOWELI Price', numVal: price.priceInUsd, decimals: price.priceInUsd < 0.01 ? 8 : 6, prefix: '$', sub: priceChangeStr || (price.priceInUsd > 0 ? 'Live' : (price.oracleStale ? 'Stale' : '–')), priceUp: price.priceChange > 0, priceDown: price.priceChange < 0, stale: price.oracleStale, art: pageArt('dashboard', 5), showSparkline: true, isPrice: true, loading: !price.isLoaded },
          ].map((s) => (
            <div key={s.l} className="relative overflow-hidden rounded-xl glass-card-animated card-hover" style={{ border: '1px solid var(--color-purple-75)' }}>
              <div className="absolute inset-0">
                <img src={s.art.src} alt="" loading="lazy" className="w-full h-full object-cover" style={artStyle(s.art)} />
              </div>
              {/* Semi-transparent content panel — art bleeds through while kyle-green stat
                  text stays readable against the dimmed backdrop. */}
              <div className="relative z-10 m-2 md:m-3 rounded-lg p-3 md:p-4 pt-6 pb-5" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}>
              <div className="flex items-center gap-1.5">
                <p className="text-[11px] uppercase tracking-wider label-pill mb-2" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>{s.l}</p>
                {s.error && (
                  <span className="w-2 h-2 rounded-full bg-danger mb-2 shrink-0" title="Failed to load" />
                )}
              </div>
              <div className="flex items-center gap-2">
                {s.loading ? (
                  <Skeleton width={80} height={24} />
                ) : s.isPrice ? (
                  <FlashValue value={s.numVal}>
                    <AnimatedCounter value={s.numVal} prefix={s.prefix} decimals={s.decimals} className="stat-value text-2xl" style={{ color: '#22c55e', textShadow: '0 1px 8px rgba(0,0,0,0.95)' }} />
                  </FlashValue>
                ) : (
                  <AnimatedCounter value={s.numVal} prefix={s.prefix} decimals={s.decimals} className="stat-value text-2xl" style={{ color: '#22c55e', textShadow: '0 1px 8px rgba(0,0,0,0.95)' }} />
                )}
                {s.showSparkline && priceHistory.length > 1 && (
                  <Sparkline data={priceHistory} width={48} height={18} />
                )}
              </div>
              <p className="text-[12px] mt-1.5" style={{ color: '#22c55e', textShadow: '0 1px 6px rgba(0,0,0,0.95)' }}>
                {s.priceUp && '▲ '}{s.priceDown && '▼ '}
                {s.stale ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold" style={{ background: 'rgba(245,158,11,0.15)', color: '#f59e0b' }}>Stale</span>
                  </span>
                ) : s.sub === 'Live' ? <span className="inline-flex items-center gap-1">Live <PulseDot size={5} /></span> : s.sub}
                {(s.priceUp || s.priceDown) && <span className="text-[10px] ml-1" style={{ color: '#22c55e' }}>since session start</span>}
              </p>
              </div>
            </div>
          ))}
        </m.div>

        {/* AUDIT DASH-UX: tab bar — Header + Summary Stats above the bar stay
            visible on every tab so portfolio value is always in frame; tabs
            partition the rest of the page by concern. ?tab= deep-links come
            from Dashboard → History link and from external pages. */}
        <div
          className="flex gap-1.5 mb-6 p-1 rounded-2xl overflow-x-auto"
          style={{ background: 'rgba(13,21,48,0.4)', border: '1px solid rgba(255,255,255,0.20)' }}
          role="tablist"
          aria-label="Dashboard sections"
          onKeyDown={tabKeys.onKeyDown}
        >
          {DASH_TABS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              id={`dash-tab-${key}`}
              aria-selected={tab === key}
              aria-controls={`dash-panel-${key}`}
              tabIndex={tabKeys.tabIndex(key)}
              ref={tabKeys.ref(key)}
              onClick={() => handleTabChange(key)}
              className={`flex-1 px-3 md:px-4 py-2.5 min-h-[44px] rounded-xl text-[13px] md:text-sm font-medium transition-all whitespace-nowrap ${
                tab === key ? 'text-white' : 'text-white/70 hover:text-white'
              }`}
              style={tab === key ? {
                background: 'var(--color-stan)',
                boxShadow: '0 4px 12px var(--color-stan-40)',
              } : undefined}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Overview */}
        {tab === 'overview' && (
          <m.div role="tabpanel" id="dash-panel-overview" aria-labelledby="dash-tab-overview" tabIndex={0} className="outline-none" key="overview"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            {/* Tegridy Score */}
            <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-6" style={{ border: '1px solid var(--color-purple-75)' }}
              initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
              <div className="absolute inset-0">
                <ArtImg pageId="dashboard" idx={6} alt="" loading="lazy" className="w-full h-full object-cover" />
              </div>
              <div className="relative z-10 m-2 md:m-3 rounded-lg p-3 md:p-4 flex items-center justify-between flex-wrap gap-2" style={{ background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(2px)', border: '1px solid rgba(255,255,255,0.08)' }}>
                <TegridyScoreMini />
                <Link to="/leaderboard" className="text-[11px] text-white/70 hover:text-white transition-colors">
                  View Breakdown &#8594;
                </Link>
              </div>
            </m.div>

            {/* DCA Due Alerts */}
            {dca.dueSchedules.length > 0 && (
              <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-5" style={{ border: '1px solid var(--color-purple-75)' }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="absolute inset-0">
                  <ArtImg pageId="dashboard" idx={9} alt="" loading="lazy" className="w-full h-full object-cover" />
                </div>
                <div className="relative z-10 p-4 flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="text-warning text-[13px] font-medium">{dca.dueSchedules.length} DCA swap{dca.dueSchedules.length > 1 ? 's' : ''} due</p>
                    <p className="text-white text-[11px]">Go to Swap to execute</p>
                  </div>
                  <Link to="/swap" className="btn-secondary px-4 py-2 text-[12px]">Execute &#8594;</Link>
                </div>
              </m.div>
            )}

            {/* Active Limit Orders */}
            {limitOrders.activeOrders.length > 0 && (
              <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-5" style={{ border: '1px solid var(--color-purple-75)' }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="absolute inset-0">
                  <ArtImg pageId="dashboard" idx={10} alt="" loading="lazy" className="w-full h-full object-cover" />
                </div>
                <div className="relative z-10 p-4">
                  <p className="text-white text-[13px] font-medium mb-1">{limitOrders.activeOrders.length} active limit order{limitOrders.activeOrders.length > 1 ? 's' : ''}</p>
                  <p className="text-white text-[11px]">Check Swap for details</p>
                </div>
              </m.div>
            )}

            {/* Price Alerts */}
            <m.div className="mb-6" initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <PriceAlertWidget />
            </m.div>

            {/* Chart */}
            <m.div initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
              <h3 className="heading-luxury text-[16px] text-white mb-3">Price Chart</h3>
              <div className="relative rounded-xl overflow-hidden glass-card-animated h-[280px] md:h-[400px]" style={{ background: '#000', border: '1px solid var(--color-purple-75)' }}>
                <ErrorBoundary fallback={<div className="flex items-center justify-center h-full text-white text-[13px]">Chart unavailable</div>}><PriceChart /></ErrorBoundary>
              </div>
            </m.div>
          </m.div>
        )}

        {/* Positions */}
        {tab === 'positions' && (
          <m.div role="tabpanel" id="dash-panel-positions" aria-labelledby="dash-tab-positions" tabIndex={0} className="outline-none" key="positions"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            {/* Claim Button */}
            {pendingTotal >= 0.01 && pos.hasPosition && (
              <m.div className="mb-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <button onClick={handleClaim}
                  disabled={farmActions.isPending || farmActions.isConfirming}
                  className="btn-primary px-6 py-2.5 text-[13px] disabled:opacity-70 disabled:cursor-not-allowed">
                  {farmActions.isPending || farmActions.isConfirming
                    ? 'Claiming...'
                    : `Claim Rewards (${formatTokenAmount(pendingTotal.toString(), 2)} TOWELI)`}
                </button>
              </m.div>
            )}

            {/* POL Accumulator */}
            {!isDeployed(POL_ACCUMULATOR_ADDRESS) && (
              <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-5" style={{ border: '1px solid var(--color-purple-75)' }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="absolute inset-0">
                  <ArtImg pageId="dashboard" idx={8} alt="" loading="lazy" className="w-full h-full object-cover" />
                </div>
                <div className="relative z-10 p-5">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-white text-[15px] font-medium">POL Accumulator</span>
                    <span className="px-2 py-0.5 rounded text-[9px] font-semibold tracking-wider uppercase" style={{ background: 'var(--color-purple-75)', color: '#000000', border: '1px solid var(--color-purple-20)' }}>Coming Soon</span>
                  </div>
                  <p className="text-white text-[12px] leading-relaxed max-w-lg">
                    Protocol-Owned Liquidity will automatically accumulate LP positions from a share of swap fees, deepening TOWELI liquidity permanently and reducing reliance on external LPs.
                  </p>
                </div>
              </m.div>
            )}

            {/* Position */}
            <h2 className="heading-luxury text-[16px] text-white mb-4">Your Position</h2>
            {pos.hasPosition ? (
              <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-10 card-hover" style={{ border: '1px solid var(--color-purple-75)' }}
                initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
                <div className="absolute inset-0">
                  <ArtImg pageId="dashboard" idx={12} alt="" loading="lazy" className="w-full h-full object-cover" />
                </div>
                <div className="relative z-10 p-5">
                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
                    <div>
                      <p className="text-white text-[10px] mb-0.5">Staked</p>
                      <AnimatedCounter value={stakedTotal} decimals={2} className="stat-value text-[16px] text-white" />
                    </div>
                    <div>
                      <p className="text-white text-[10px] mb-0.5">Boost</p>
                      <AnimatedCounter value={pos.boostMultiplier} decimals={2} suffix="x" className="stat-value text-[16px] text-white" />
                    </div>
                    <div>
                      <p className="text-white text-[10px] mb-0.5">Lock Expires</p>
                      <p className="stat-value text-[14px] text-white">
                        {pos.autoMaxLock ? 'Auto-Max (Forever)' : pos.isLocked ? new Date(pos.lockEnd * 1000).toLocaleDateString() : 'Unlocked'}
                      </p>
                    </div>
                    <div>
                      <p className="text-white text-[10px] mb-0.5">Voting Power</p>
                      <AnimatedCounter value={pos.isLocked ? stakedTotal * pos.boostMultiplier : 0} decimals={0} className="stat-value text-[14px] text-white" />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 mt-4 flex-wrap">
                    {pos.isLocked && (
                      <span className="badge badge-warning text-[10px]">
                        {pos.autoMaxLock ? 'Auto-Max Lock' : `Locked until ${new Date(pos.lockEnd * 1000).toLocaleDateString()}`}
                      </span>
                    )}
                    {nft.boostLabel && (
                      <span className="badge badge-primary text-[10px]">{nft.boostLabel}</span>
                    )}
                    <Link to="/farm" className="text-[11px] text-white/70 hover:text-white transition-colors ml-auto">
                      Restake for bonus yield &#8594;
                    </Link>
                  </div>
                </div>
              </m.div>
            ) : (
              <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-10" style={{ border: '1px solid var(--color-purple-75)' }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="absolute inset-0">
                  <ArtImg pageId="dashboard" idx={13} fallbackPosition="center 20%" alt="" loading="lazy" className="w-full h-full object-cover" />
                </div>
                <div className="relative z-10 p-8 py-12 text-center">
                  <p className="text-white text-[15px] mb-4">No staking position yet</p>
                  <Link to="/farm" className="btn-primary px-8 py-3 text-[14px]">Start Staking &#8594;</Link>
                </div>
              </m.div>
            )}

            {/* Projections */}
            {pos.hasPosition && (
              <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
                <h3 className="heading-luxury text-[16px] text-white mb-4">Earnings Projection</h3>
                <Projections staked={stakedTotal} apr={pool.aprNum || 0} price={price.priceInUsd} boost={pos.boostMultiplier} secondsRemaining={pool.secondsRemaining} aprDisclaimer={pool.aprDisclaimer} />
              </m.div>
            )}

            {/* Liquidity position (LP) — surfaces TGLP that wallets otherwise hide */}
            {lpPos.hasPosition && (
              <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
                <h3 className="heading-luxury text-[16px] text-white mb-4">Your Liquidity</h3>
                <div className="relative overflow-hidden rounded-xl glass-card-animated card-hover" style={{ border: '1px solid var(--color-purple-75)' }}>
                  <div className="absolute inset-0">
                    <ArtImg pageId="dashboard" idx={14} fallbackPosition="center 30%" alt="" loading="lazy" className="w-full h-full object-cover" />
                  </div>
                  <div className="relative z-10 p-5">
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                      <div>
                        <p className="text-white text-[10px] mb-0.5">LP Tokens</p>
                        <p className="stat-value text-[16px] text-white">{formatTokenAmount(lpPos.lpBalanceFormatted, 4)} <span className="text-white/50 text-[11px]">TGLP</span></p>
                        {lpPos.stakedLp > 0n && (
                          <p className="text-white/45 text-[10px]">{formatTokenAmount(lpPos.stakedLpFormatted, 4)} staked</p>
                        )}
                      </div>
                      <div>
                        <p className="text-white text-[10px] mb-0.5">Pool Share</p>
                        <p className="stat-value text-[16px] text-white">{lpPos.sharePct < 0.01 ? '<0.01' : lpPos.sharePct.toFixed(2)}%</p>
                      </div>
                      <div>
                        <p className="text-white text-[10px] mb-0.5">Redeemable</p>
                        <p className="text-white text-[12px]">{formatTokenAmount(lpPos.wethAmount.toString(), 4)} ETH</p>
                        <p className="text-white text-[12px]">{formatWholeNumber(lpPos.toweliAmount)} TOWELI</p>
                      </div>
                      <div>
                        <p className="text-white text-[10px] mb-0.5">Value</p>
                        <p className="stat-value text-[16px] text-white">{formatCurrency(lpUsd)}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-4 flex-wrap">
                      <span className="text-white/50 text-[11px]">
                        {lpPos.farmingDeployed && (lpPos.stakedLp > 0n || lpPos.pendingRewards > 0)
                          ? `Staked & earning · ${formatTokenAmount(lpPos.pendingRewards.toString(), 4)} TOWELI pending`
                          : 'Held in your wallet as the TGLP token · earns a cut of swap fees'}
                      </span>
                      {lpPos.farmingDeployed && lpPos.stakedLp > 0n ? (
                        <Link to="/farm" className="text-[11px] text-white/70 hover:text-white transition-colors ml-auto">
                          Manage on Farm &#8594;
                        </Link>
                      ) : (
                        <Link to="/liquidity" className="text-[11px] text-white/70 hover:text-white transition-colors ml-auto">
                          Manage liquidity &#8594;
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              </m.div>
            )}
          </m.div>
        )}

        {/* Loans */}
        {tab === 'loans' && (
          <m.div role="tabpanel" id="dash-panel-loans" aria-labelledby="dash-tab-loans" tabIndex={0} className="outline-none" key="loans"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            {myLoans.isLoading && myLoans.loans.length === 0 ? (
              // F136: the chunked loan scan takes seconds — show a skeleton instead
              // of flashing the "No outstanding loans" empty state + borrow CTAs.
              <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-10" style={{ border: '1px solid var(--color-purple-75)' }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="relative z-10 p-5">
                  <Skeleton width={180} height={20} />
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-4">
                    {[...Array(4)].map((_, i) => (
                      <div key={i}>
                        <Skeleton width={60} height={12} />
                        <div className="mt-2"><Skeleton width={80} height={22} /></div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 space-y-2">
                    {[...Array(2)].map((_, i) => (
                      <Skeleton key={i} width="100%" height={44} />
                    ))}
                  </div>
                </div>
              </m.div>
            ) : myLoans.loans.length > 0 ? (
              <OutstandingLoans loans={myLoans.loans} />
            ) : (
              <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-10" style={{ border: '1px solid var(--color-purple-75)' }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="absolute inset-0">
                  <ArtImg pageId="dashboard" idx={11} fallbackPosition="center 30%" alt="" loading="lazy" className="w-full h-full object-cover" />
                </div>
                <div className="relative z-10 p-8 py-12 text-center">
                  <p className="text-white text-[15px] mb-2">No outstanding loans</p>
                  <p className="text-white/70 text-[12px] mb-4 max-w-sm mx-auto">
                    Borrow ETH against staking positions or NFTs, or lend to earn interest.
                  </p>
                  <div className="flex items-center justify-center gap-3 flex-wrap">
                    <Link to="/nft-finance?section=nftlending" className="btn-primary px-5 py-2.5 text-[13px]">NFT Lending &#8594;</Link>
                    <Link to="/nft-finance?section=lending" className="btn-secondary px-5 py-2.5 text-[13px]">Token Lending &#8594;</Link>
                  </div>
                </div>
              </m.div>
            )}
          </m.div>
        )}

        {/* Rewards */}
        {tab === 'rewards' && (
          <m.div role="tabpanel" id="dash-panel-rewards" aria-labelledby="dash-tab-rewards" tabIndex={0} className="outline-none" key="rewards"
            initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
            {/* Claim staking rewards — primary action if pending */}
            {pendingTotal >= 0.01 && pos.hasPosition && (
              <m.div className="mb-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <button onClick={handleClaim}
                  disabled={farmActions.isPending || farmActions.isConfirming}
                  className="btn-primary px-6 py-2.5 text-[13px] disabled:opacity-70 disabled:cursor-not-allowed">
                  {farmActions.isPending || farmActions.isConfirming
                    ? 'Claiming...'
                    : `Claim Staking Rewards (${formatTokenAmount(pendingTotal.toString(), 2)} TOWELI)`}
                </button>
              </m.div>
            )}

            {/* F148: Unsettled rewards — surfaced here too (was Farm-page only).
                On breach/rounding the staking contract can hold rewards that
                getReward() won't sweep; claimUnsettled() recovers them. */}
            {pos.unsettledRewards > 0n && (
              <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-5" style={{ border: '1px solid var(--color-purple-75)' }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="relative z-10 p-4 flex items-center justify-between flex-wrap gap-2">
                  <div>
                    <p className="text-white text-[13px] font-medium">Unsettled Rewards</p>
                    <span className="stat-value text-[16px] text-white">{formatTokenAmount(pos.unsettledFormatted)} TOWELI</span>
                  </div>
                  <button onClick={() => farmActions.claimUnsettled()}
                    disabled={farmActions.isPending || farmActions.isConfirming || isWrongNetwork}
                    className="btn-secondary px-5 py-2.5 text-[13px] disabled:opacity-70">
                    {farmActions.isPending || farmActions.isConfirming ? 'Claiming...' : 'Claim Unsettled'}
                  </button>
                </div>
              </m.div>
            )}

            {/* ETH Revenue Sharing (only renders when pending > 0) */}
            {address && <ETHRevenueClaim address={address} isWrongNetwork={isWrongNetwork} />}

            {/* F148: friendly "all claimed" empty state when there's nothing
                outstanding across staking, unsettled, ETH revenue, and referrals. */}
            {pendingTotal < 0.01 && pos.unsettledRewards <= 0n && revenueStats.pendingRevenue < 0.000001 && revenueStats.referralPending < 0.000001 && (
              <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-5" style={{ border: '1px solid var(--color-purple-75)' }}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="relative z-10 p-6 text-center">
                  <p className="text-white text-[14px] mb-1">All caught up — nothing to claim right now</p>
                  <p className="text-white/60 text-[12px]">
                    {pos.hasPosition
                      ? 'Your staking rewards keep accruing. Check back as they build up.'
                      : <>Stake TOWELI on the <Link to="/farm" className="underline hover:text-white">Farm</Link> to start earning claimable rewards.</>}
                  </p>
                </div>
              </m.div>
            )}

            {/* Referral Widget */}
            {address && (
              <ReferralWidget
                address={address}
                referredCount={revenueStats.referredCount}
                referralEarned={revenueStats.referralEarned}
                referralPending={revenueStats.referralPending}
                referralPendingBig={revenueStats.referralPendingBig}
                hasReferrer={revenueStats.hasReferrer}
                referrer={revenueStats.referrer}
                onClaim={revenueStats.claimReferralRewards}
                onSetReferrer={revenueStats.setReferrer}
                isPending={revenueStats.isPending}
                isConfirming={revenueStats.isConfirming}
              />
            )}
          </m.div>
        )}

      </div>
      </ErrorBoundary>
    </div>
  );
}

function ETHRevenueClaim({ address, isWrongNetwork }: { address: string; isWrongNetwork: boolean }) {
  // R047 M1: pin chainId on the read so a wallet on the wrong chain can't
  // surface stale 0 ETH from a different network. Wrong-chain UI surfaces
  // the page-level "Wrong network detected" banner instead.
  const chainId = useChainId();
  const onCorrectChain = chainId === CHAIN_ID;

  const { data: pendingETH, error: pendingError, refetch: refetchPendingETH } = useReadContract({
    address: REVENUE_DISTRIBUTOR_ADDRESS,
    abi: REVENUE_DISTRIBUTOR_ABI,
    functionName: 'pendingETH',
    args: [address as `0x${string}`],
    chainId: CHAIN_ID,
    query: { enabled: !!address && onCorrectChain },
  });

  const { writeContract, data: hash, isPending } = useWriteContract();
  const { isLoading: isConfirming, isSuccess: isClaimSuccess } = useWaitForTransactionReceipt({ hash });

  const pending = pendingETH ? Number(formatEther(pendingETH as bigint)) : 0;

  // Show success toast after ETH claim confirms.
  // R047 M2: dedup keyed on tx hash; effect early-returns when no hash so a
  // cache-rehydrated `isSuccess: true` from a stale render can't toast.
  const ethToastFiredRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isClaimSuccess || !hash) return;
    if (ethToastFiredRef.current.has(hash)) return;
    ethToastFiredRef.current.add(hash);
    toast.success('ETH revenue claimed successfully!');
    // F137 (T5): refetch pendingETH so the claimable amount drops to 0 and the
    // claim card collapses immediately, rather than the button staying clickable
    // until the next background poll. Gated once-per-hash by ethToastFiredRef.
    refetchPendingETH();
  }, [isClaimSuccess, hash]); // eslint-disable-line react-hooks/exhaustive-deps -- refetchPendingETH is stable; fire once per confirmed hash

  // F142: a failed pendingETH read leaves `pending === 0`, which is otherwise
  // indistinguishable from "nothing to claim" — the card would silently vanish.
  // Surface a small error row so an RPC failure can't hide claimable ETH.
  if (pendingError && !pending) {
    return (
      <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-5" style={{ border: '1px solid rgba(239,68,68,0.25)' }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <div className="relative z-10 p-4 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-danger shrink-0" aria-hidden="true" />
          <div>
            <p className="text-white text-[13px] font-medium">ETH Revenue</p>
            <p className="text-white/70 text-[11px]">Couldn&rsquo;t load your claimable ETH — retrying. Refresh if it persists.</p>
          </div>
        </div>
      </m.div>
    );
  }

  if (pending > 0) {
    return (
      <m.div className="relative overflow-hidden rounded-xl glass-card-animated mb-5" style={{ border: '1px solid var(--color-purple-75)' }}
        initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
        <div className="absolute inset-0">
          <ArtImg pageId="dashboard" idx={7} fallbackPosition="center 55%" alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 p-4 flex items-center justify-between flex-wrap gap-2">
          <div>
            <div className="flex items-center gap-1.5">
              <p className="text-white text-[13px] font-medium">ETH Revenue</p>
              {pendingError && (
                <span className="w-2 h-2 rounded-full bg-danger shrink-0" title="Failed to load" />
              )}
            </div>
            <span className="stat-value text-[16px] text-success"><AnimatedCounter value={pending} decimals={6} suffix=" ETH" /></span>
          </div>
          <button onClick={() => writeContract({ chainId: CHAIN_ID, address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'claim' })}
            disabled={isPending || isConfirming || isWrongNetwork}
            className="btn-primary px-5 py-2.5 text-[13px] disabled:opacity-70">
            {isPending || isConfirming ? 'Claiming...' : 'Claim ETH'}
          </button>
        </div>
      </m.div>
    );
  }

  return null;
}

function OutstandingLoans({ loans }: { loans: import('../hooks/useMyLoans').MyLoan[] }) {
  const borrower = loans.filter(l => l.role === 'borrower');
  const lender = loans.filter(l => l.role === 'lender');
  const overdue = loans.filter(l => l.status === 'overdue').length;
  const owed = borrower.reduce((acc, l) => acc + l.principal, 0n);
  const earning = lender.reduce((acc, l) => acc + l.principal, 0n);
  return (
    <m.div className="mb-10" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}>
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <h2 className="heading-luxury text-[16px] text-white">
          Outstanding Loans
          {overdue > 0 && (
            <span className="ml-2 align-middle badge badge-warning text-[10px]">
              {overdue} overdue
            </span>
          )}
        </h2>
        <Link to="/nft-finance" className="text-[12px] text-white/70 hover:text-white transition-colors">
          Manage in NFT Finance &#8594;
        </Link>
      </div>
      <div className="relative overflow-hidden rounded-xl glass-card-animated" style={{ border: '1px solid var(--color-purple-75)' }}>
        <div className="absolute inset-0">
          <ArtImg pageId="dashboard" idx={11} fallbackPosition="center 45%" alt="" loading="lazy" className="w-full h-full object-cover" />
        </div>
        <div className="relative z-10 p-5">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4 pb-4" style={{ borderBottom: '1px solid var(--color-purple-20)' }}>
            <div>
              <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1">Open</p>
              <p className="stat-value text-[18px] text-white">{loans.length}</p>
            </div>
            <div>
              <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1">Borrowing</p>
              <p className="stat-value text-[18px] text-white">{borrower.length}</p>
              {/* F140: bound decimals via formatWei and label as "principal" — the
                  figure is loan principal only (accrued interest not summed here). */}
              <p className="text-[10px] text-white/55 font-mono">{formatWei(owed, 18, 4)} ETH principal</p>
            </div>
            <div>
              <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1">Lending</p>
              <p className="stat-value text-[18px] text-success">{lender.length}</p>
              <p className="text-[10px] text-success/70 font-mono">{formatWei(earning, 18, 4)} ETH out</p>
            </div>
            <div>
              <p className="text-white/60 text-[10px] uppercase tracking-wider mb-1">Overdue</p>
              <p className={`stat-value text-[18px] ${overdue > 0 ? 'text-warning' : 'text-white'}`}>{overdue}</p>
            </div>
          </div>
          <div className="space-y-2">
            {loans.slice(0, 5).map(loan => (
              <LoanRow key={`${loan.source}-${loan.id}`} loan={loan} />
            ))}
            {loans.length > 5 && (
              <Link to="/nft-finance"
                className="block text-center text-[12px] text-white/70 hover:text-white py-2 rounded-lg transition-colors"
                style={{ background: 'rgba(255,255,255,0.03)' }}>
                View {loans.length - 5} more &#8594;
              </Link>
            )}
          </div>
        </div>
      </div>
    </m.div>
  );
}

function LoanRow({ loan }: { loan: import('../hooks/useMyLoans').MyLoan }) {
  // Tick once per minute so the countdown stays accurate without an impure
  // Date.now() read during render.
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);
  const remaining = Number(loan.deadline) - nowSec;
  // F146: derive overdue locally from the live `remaining` (defense-in-depth) so
  // a loan crossing its deadline while mounted flips to "Overdue" even before the
  // useMyLoans status refreshes; show minutes under an hour instead of "0h".
  const isOverdue = loan.status === 'overdue' || remaining <= 0;
  const days = Math.max(0, Math.floor(remaining / 86400));
  const hours = Math.max(0, Math.floor((remaining % 86400) / 3600));
  const minutes = Math.max(0, Math.floor((remaining % 3600) / 60));
  const countdown = isOverdue
    ? 'Overdue'
    : days > 0 ? `${days}d ${hours}h` : remaining < 3600 ? `${minutes}m` : `${hours}h`;
  const isUrgent = !isOverdue && remaining < 86400;
  const roleLabel = loan.role === 'borrower' ? 'You owe' : 'You lent';
  const roleColor = loan.role === 'borrower' ? 'text-white' : 'text-success';
  const sourceBadge = loan.source === 'nft' ? 'NFT' : 'Token';
  const sourceBadgeClass = loan.source === 'nft'
    ? 'bg-purple-500/20 text-purple-200 border-purple-500/40'
    : 'bg-blue-500/20 text-blue-200 border-blue-500/40';
  const roleBadgeClass = loan.role === 'borrower'
    ? 'bg-orange-500/15 text-orange-200 border-orange-500/35'
    : 'bg-emerald-500/15 text-emerald-200 border-emerald-500/35';
  const linkTo = loan.source === 'nft' ? '/nft-finance?section=nftlending' : '/nft-finance?section=lending';
  return (
    <Link to={linkTo} className="flex items-center justify-between gap-3 p-3 rounded-lg hover:bg-white/5 transition-colors"
      style={{ background: 'rgba(255,255,255,0.02)' }}>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
          <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wider ${sourceBadgeClass}`}>{sourceBadge}</span>
          <span className={`text-[9px] px-1.5 py-0.5 rounded border font-semibold uppercase tracking-wider ${roleBadgeClass}`}>{loan.role}</span>
          <span className="text-white text-[13px] font-semibold">#{loan.id}</span>
          <span className="text-white/60 text-[11px]">·</span>
          <span className={`stat-value text-[13px] ${roleColor}`}>{roleLabel} {formatWei(loan.principal, 18, 4)} ETH</span>
          <span className="text-white/60 text-[11px]">@ {(Number(loan.aprBps) / 100).toFixed(2)}% APR</span>
        </div>
        <p className="text-white/70 text-[11px]">Token #{loan.tokenId.toString()}</p>
      </div>
      <div className={`text-right shrink-0 ${isOverdue ? 'text-warning' : isUrgent ? 'text-warning' : 'text-white'}`}>
        <p className="text-[10px] uppercase tracking-wider opacity-60">
          {isOverdue ? 'Overdue' : 'Due in'}
        </p>
        <p className="stat-value text-[13px]">{countdown}</p>
      </div>
    </Link>
  );
}

function Projections({ staked, apr, price, boost = 1, secondsRemaining = 0, aprDisclaimer }: {
  staked: number; apr: number; price: number; boost?: number;
  // F131: emission runway + the disclaimer the hook already computes, so a 1-year
  // figure projected past the reward pool isn't presented as guaranteed.
  secondsRemaining?: number; aprDisclaimer?: string;
}) {
  const daily = (staked * apr / 100) / 365 * boost;
  // F131: flag any horizon longer than the funded runway at the current rate.
  const runwayDays = secondsRemaining > 0 ? secondsRemaining / 86400 : 0;
  return (
    <>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        {[{ l: '7 Days', m: 7 }, { l: '30 Days', m: 30 }, { l: '90 Days', m: 90 }, { l: '1 Year', m: 365 }].map(({ l, m }) => {
          const exceedsRunway = runwayDays > 0 && m > runwayDays;
          return (
            <div key={l} className="glass-card rounded-lg p-3 text-center card-hover" style={exceedsRunway ? { opacity: 0.6 } : undefined}>
              <p className="text-white text-[10px] mb-1">{l}</p>
              <AnimatedCounter value={daily * m} decimals={0} className="stat-value text-[14px] text-white" />
              <p className="text-white text-[9px]">~{formatCurrency(daily * m * price)}</p>
              {exceedsRunway && (
                <p className="text-amber-300/80 text-[8px] mt-0.5 leading-tight" title="Exceeds the funded reward runway at the current rate">
                  beyond ~{Math.round(runwayDays)}d runway
                </p>
              )}
            </div>
          );
        })}
      </div>
      {aprDisclaimer && (
        <p className="text-white/40 text-[10px] mt-2">{aprDisclaimer}. Projections assume the current rate holds.</p>
      )}
    </>
  );
}
