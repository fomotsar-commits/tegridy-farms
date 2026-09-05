import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useReadContracts, usePublicClient, useChainId } from 'wagmi';
import { parseAbiItem } from 'viem';
import {
  getPointsData, recordAction,
  getTier, getNextTier, getStreakMultiplier, getEarnedBadges,
  computeOnChainPoints, reconcilePoints,
  type PointsData, type OnChainMetrics,
} from '../lib/pointsEngine';
import { TEGRIDY_STAKING_ABI, ERC20_ABI, REFERRAL_SPLITTER_ABI } from '../lib/contracts';
import {
  TEGRIDY_STAKING_ADDRESS, STAKING_MONITOR_VIEW_ADDRESS, TEGRIDY_LP_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS, REFERRAL_SPLITTER_ADDRESS, CHAIN_ID, RELAUNCH_DEPLOY_BLOCK,
  isDeployed as checkDeployed, SITE_URL,
} from '../lib/constants';

const ZERO_ADDR = '0x0000000000000000000000000000000000000001' as const;

const SWAP_EXECUTED_EVENT = parseAbiItem(
  'event SwapExecuted(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 fee)'
);

export function usePoints() {
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;
  const [data, setData] = useState<PointsData | null>(null);
  const [swapCount, setSwapCount] = useState(0);
  const [swapCountUnread, setSwapCountUnread] = useState(false);
  const [onChainMetrics, setOnChainMetrics] = useState<OnChainMetrics | null>(null);

  const userAddr = address ?? ZERO_ADDR;
  const stakingDeployed = checkDeployed(TEGRIDY_STAKING_ADDRESS);
  const enabled = stakingDeployed && !!address && onMainnet;

  // R043 H-062-02: chainId pin on every entry so a wrong-chain wallet doesn't
  // read another chain's balances into the points computation.
  const { data: contractData } = useReadContracts({
    contracts: [
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'userTokenId', args: [userAddr], chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'getReferralInfo', args: [userAddr], chainId: CHAIN_ID },
    ],
    query: { enabled, refetchInterval: 30_000 },
  });

  const tokenId = contractData?.[0]?.status === 'success' ? contractData[0].result as bigint : 0n;
  const lpBalance = contractData?.[1]?.status === 'success' ? contractData[1].result as bigint : 0n;
  const referralInfo = contractData?.[2]?.status === 'success'
    ? contractData[2].result as readonly [bigint, bigint, bigint]
    : undefined;
  // Safely convert bigint referral count — clamp to prevent overflow
  const onChainReferralCount = referralInfo
    ? Math.min(Number(referralInfo[0] > 10000n ? 10000n : referralInfo[0]), 10_000)
    : 0;

  const hasTokenId = tokenId > 0n;
  const { data: posData } = useReadContracts({
    contracts: [
      { address: STAKING_MONITOR_VIEW_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'getPosition', args: [hasTokenId ? tokenId : 1n], chainId: CHAIN_ID },
    ],
    query: { enabled: enabled && hasTokenId, refetchInterval: 30_000 },
  });

  const position = posData?.[0]?.status === 'success'
    ? posData[0].result as readonly [bigint, bigint, bigint, bigint, boolean, boolean]
    : undefined;
  const stakedAmount = position ? position[0] : 0n;
  const lockDuration = position ? Number(position[3]) : 0;

  // OUTAGE-AS-ZERO. A refused getLogs scan set swapCount to 0, which is also the
  // honest "this wallet has never swapped here", so an RPC that would not answer
  // asserted that the user had made no swaps: 10 points per unseen swap gone, the
  // tier and its progress bar dropping with them, and the First Swap / Degen
  // badges quietly un-earning themselves. Keep the collapse so the panel still
  // paints; carry the failure next to it. Scoped to a scan we actually issued -
  // no wallet, no client, or an undeployed router never asked, and a
  // not-attempted read must not render as a failed one.
  useEffect(() => {
    if (!address || !publicClient || !checkDeployed(SWAP_FEE_ROUTER_ADDRESS)) {
      setSwapCount(0);
      setSwapCountUnread(false);
      return;
    }
    let cancelled = false;
    // In flight is not unread: clear the previous wallet's failure so the new
    // scan is judged on its own answer.
    setSwapCountUnread(false);
    publicClient.getLogs({
      address: SWAP_FEE_ROUTER_ADDRESS,
      event: SWAP_EXECUTED_EVENT,
      args: { user: address },
      // F469: start at the relaunch deploy block, not the stale 18,000,000n —
      // the ~7M-block span made public RPCs reject the scan and zero swapCount.
      fromBlock: RELAUNCH_DEPLOY_BLOCK,
      toBlock: 'latest',
    }).then(logs => {
      if (cancelled) return;
      setSwapCount(logs.length);
      setSwapCountUnread(false);
    }).catch(() => {
      if (cancelled) return;
      setSwapCount(0);
      setSwapCountUnread(true);
    });
    return () => { cancelled = true; };
  }, [address, publicClient]);

  useEffect(() => {
    if (!address) { setData(null); setOnChainMetrics(null); return; }

    const metrics: OnChainMetrics = {
      swapCount,
      stakedAmount,
      stakeDurationSec: lockDuration,
      lpBalance,
      referralCount: onChainReferralCount,
    };
    setOnChainMetrics(metrics);

    const onChainPts = computeOnChainPoints(metrics);
    const reconciled = reconcilePoints(address, onChainPts);
    // Points derived ONLY from on-chain metrics — no localStorage bonus
    reconciled.points = onChainPts;
    setData(reconciled);
  }, [address, swapCount, stakedAmount, lockDuration, lpBalance, onChainReferralCount]);

  // R037: removed silent localStorage setReferrer auto-write from `?ref=` URL.
  // The canonical user-initiated path is ReferralWidget (EOA check + URL
  // disclosure). A silent auto-write was a Sybil + disclosure surface.

  const logAction = useCallback((actionType: string, goldCardBoost = false) => {
    if (!address) return;
    const updated = recordAction(address, actionType, goldCardBoost);
    setData(prev => prev ? { ...prev, actions: updated.actions } : prev);
  }, [address]);

  const refresh = useCallback(() => {
    if (!address) return;
    setData({ ...getPointsData(address) });
  }, [address]);

  const tier = data ? getTier(data.points) : null;
  const nextTier = data ? getNextTier(data.points) : null;
  const streakMultiplier = data ? getStreakMultiplier(data.streak.current) : 1;
  const badges = useMemo(
    () => data ? getEarnedBadges(data, onChainMetrics ?? undefined) : [],
    [data, onChainMetrics]
  );

  // Must match ReferralWidget.tsx exactly: the ?ref= stash is captured only on
  // the home route ('/'), and SITE_URL (not window.location.origin) avoids the
  // origin-drift class where a link copied on a preview deploy points off-site.
  const referralLink = address ? `${SITE_URL}/?ref=${encodeURIComponent(address)}` : '';

  return {
    data,
    tier,
    nextTier,
    streakMultiplier,
    badges,
    logAction,
    refresh,
    referralLink,
    onChainMetrics,
    // OUTAGE-AS-ZERO. True only when a scan we issued came back refused: points,
    // tier and the swap badges are understated, not earned-and-zero.
    swapCountUnread,
    // R037: precise about which values are on-chain verified vs client estimates.
    disclaimer: 'On-chain: points + badges (derived from swap count, staking, LP balance, referral count). Client-side: streak counter (computed locally from your visit cadence).',
  };
}
