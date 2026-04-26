import { useState, useEffect, useCallback, useMemo } from 'react';
import { useAccount, useReadContracts, usePublicClient } from 'wagmi';
import { parseAbiItem } from 'viem';
import {
  getPointsData, recordAction,
  getTier, getNextTier, getStreakMultiplier, getEarnedBadges,
  computeOnChainPoints, reconcilePoints,
  type PointsData, type OnChainMetrics,
} from '../lib/pointsEngine';
import { TEGRIDY_STAKING_ABI, ERC20_ABI, REFERRAL_SPLITTER_ABI } from '../lib/contracts';
import {
  TEGRIDY_STAKING_ADDRESS, TOWELI_WETH_LP_ADDRESS,
  SWAP_FEE_ROUTER_ADDRESS, REFERRAL_SPLITTER_ADDRESS,
  isDeployed as checkDeployed,
} from '../lib/constants';

const ZERO_ADDR = '0x0000000000000000000000000000000000000001' as const;

const SWAP_EXECUTED_EVENT = parseAbiItem(
  'event SwapExecuted(address indexed user, address tokenIn, address tokenOut, uint256 amountIn, uint256 fee)'
);

export function usePoints() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const [data, setData] = useState<PointsData | null>(null);
  const [swapCount, setSwapCount] = useState(0);
  const [onChainMetrics, setOnChainMetrics] = useState<OnChainMetrics | null>(null);

  const userAddr = address ?? ZERO_ADDR;
  const stakingDeployed = checkDeployed(TEGRIDY_STAKING_ADDRESS);
  const enabled = stakingDeployed && !!address;

  const { data: contractData } = useReadContracts({
    contracts: [
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'userTokenId', args: [userAddr] },
      { address: TOWELI_WETH_LP_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr] },
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'getReferralInfo', args: [userAddr] },
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
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'getPosition', args: [hasTokenId ? tokenId : 1n] },
    ],
    query: { enabled: enabled && hasTokenId, refetchInterval: 30_000 },
  });

  const position = posData?.[0]?.status === 'success'
    ? posData[0].result as readonly [bigint, bigint, bigint, bigint, boolean, boolean]
    : undefined;
  const stakedAmount = position ? position[0] : 0n;
  const lockDuration = position ? Number(position[3]) : 0;

  useEffect(() => {
    if (!address || !publicClient || !checkDeployed(SWAP_FEE_ROUTER_ADDRESS)) {
      setSwapCount(0);
      return;
    }
    let cancelled = false;
    publicClient.getLogs({
      address: SWAP_FEE_ROUTER_ADDRESS,
      event: SWAP_EXECUTED_EVENT,
      args: { user: address },
      fromBlock: 18000000n,
      toBlock: 'latest',
    }).then(logs => {
      if (!cancelled) setSwapCount(logs.length);
    }).catch(() => {
      if (!cancelled) setSwapCount(0);
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

  useEffect(() => {
    if (!address) return;
    const params = new URLSearchParams(window.location.search);
    const ref = params.get('ref');
    if (ref && ref.startsWith('0x') && ref.length === 42) {
      try {
        const checksummed = getAddress(ref);
        setReferrer(address, checksummed);
      } catch {
        // Invalid address
      }
    }
  }, [address]);

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

  const referralLink = address ? `${window.location.origin}/swap?ref=${address}` : '';

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
    // Points are computed client-side with localStorage — not cryptographically verified.
    // Display a disclaimer if points are used for any material purpose (leaderboards, eligibility).
    disclaimer: 'Community score — not verified on-chain. Points, streaks, and badges are stored locally in your browser.',
  };
}
