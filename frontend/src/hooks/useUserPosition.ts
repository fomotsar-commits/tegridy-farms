import { useEffect, useState } from 'react';
import { useAccount, useReadContracts, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { TEGRIDY_STAKING_ABI, ERC20_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, STAKING_MONITOR_VIEW_ADDRESS, TOWELI_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';

// Dummy address for disabled queries (wagmi needs valid args shape)
const ZERO_ADDR = '0x0000000000000000000000000000000000000001' as const;

// Hard ceiling on how far the live Claimable counter may extrapolate past the
// last confirmed on-chain read. The position refetches every 30s, so 45s of
// headroom covers normal jitter while bounding the error if a refetch stalls
// (backgrounded tab, RPC outage). Past the cap the counter parks rather than
// inventing unbounded rewards.
const MAX_ACCRUAL_DRIFT_SEC = 45;

export function useUserPosition() {
  const { address } = useAccount();
  const chainId = useChainId();
  const onMainnet = chainId === CHAIN_ID;
  const stakingAddr = TEGRIDY_STAKING_ADDRESS;
  const isDeployed = checkDeployed(stakingAddr);
  const enabled = isDeployed && !!address && onMainnet;
  const userAddr = address ?? ZERO_ADDR;

  // Batch read: tokenId, wallet balance, allowance.
  // R043 H-062-02: chainId pin on every entry so a wrong-chain wallet with a real
  // mainnet position never reads the wrong chain and renders the empty stake form.
  const { data, refetch, isLoading } = useReadContracts({
    contracts: [
      { address: stakingAddr, abi: TEGRIDY_STAKING_ABI, functionName: 'userTokenId', args: [userAddr], chainId: CHAIN_ID },
      { address: TOWELI_ADDRESS as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: TOWELI_ADDRESS as `0x${string}`, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, stakingAddr], chainId: CHAIN_ID },
      { address: stakingAddr, abi: TEGRIDY_STAKING_ABI, functionName: 'paused', chainId: CHAIN_ID },
      { address: stakingAddr, abi: TEGRIDY_STAKING_ABI, functionName: 'unsettledRewards', args: [userAddr], chainId: CHAIN_ID },
      // Live-accrual inputs. `rewardRate` is the global TOWELI/sec emission and
      // `totalBoostedStake` the denominator the contract divides it by — together
      // with this position's boostedAmount they reproduce the contract's own
      // per-second arithmetic exactly. Nothing here is estimated or invented.
      { address: stakingAddr, abi: TEGRIDY_STAKING_ABI, functionName: 'rewardRate', chainId: CHAIN_ID },
      { address: stakingAddr, abi: TEGRIDY_STAKING_ABI, functionName: 'totalBoostedStake', chainId: CHAIN_ID },
    ],
    query: { enabled, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  const tokenId = (data?.[0]?.status === 'success' ? data[0].result as bigint : 0n);
  const walletBalance = (data?.[1]?.status === 'success' ? data[1].result as bigint : 0n);
  const allowance = (data?.[2]?.status === 'success' ? data[2].result as bigint : 0n);
  const isPaused = (data?.[3]?.status === 'success' ? data[3].result as boolean : false);
  const unsettledRewards = (data?.[4]?.status === 'success' ? data[4].result as bigint : 0n);
  // Default 0n on a failed/disabled read so accrual silently switches off
  // rather than ticking from a made-up rate.
  const rewardRate = (data?.[5]?.status === 'success' ? data[5].result as bigint : 0n);
  const totalBoostedStake = (data?.[6]?.status === 'success' ? data[6].result as bigint : 0n);

  // Get position details + earned if user has a staking NFT
  const hasTokenId = tokenId > 0n;
  // EIP-170 split: getPosition + earned live on StakingMonitorView, not the host staking contract.
  const { data: posData, refetch: refetchPos } = useReadContracts({
    contracts: [
      { address: STAKING_MONITOR_VIEW_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'getPosition', args: [hasTokenId ? tokenId : 1n], chainId: CHAIN_ID },
      { address: STAKING_MONITOR_VIEW_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'earned', args: [hasTokenId ? tokenId : 1n], chainId: CHAIN_ID },
    ],
    query: { enabled: enabled && hasTokenId, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  const position = (posData?.[0]?.status === 'success'
    ? posData[0].result as readonly [bigint, bigint, bigint, bigint, boolean, boolean]
    : undefined);

  const pendingReward = (posData?.[1]?.status === 'success' ? posData[1].result as bigint : 0n);

  const stakedAmount = position ? position[0] : 0n;
  const boostBps = position ? Number(position[1]) : 0;
  const lockEnd = position ? Number(position[2]) : 0;
  const lockDuration = position ? Number(position[3]) : 0;
  const autoMaxLock = position ? position[4] : false;
  const canWithdraw = position ? position[5] : false;

  const hasPosition = hasTokenId && stakedAmount > 0n;
  const isLocked = lockEnd > 0 && lockEnd > Math.floor(Date.now() / 1000);
  const boostMultiplier = boostBps > 0 ? boostBps / 10000 : 0;
  function needsApproval(amount?: bigint): boolean {
    const required = amount ?? walletBalance;
    return required > 0n && allowance < required;
  }

  // ── Live claimable accrual ──────────────────────────────────────────────
  // `earned` only moves on the 30s refetch, so Claimable looks frozen. Between
  // refetches we interpolate it using the contract's OWN arithmetic:
  // rewardPerToken grows by rewardRate/totalBoostedStake per second, and this
  // position earns that times its boostedAmount — which is exactly
  // amount * boostBps / BOOST_PRECISION (TegridyStaking.sol:2258).
  // If any input is missing, the pool is paused, or the position is empty, the
  // rate is 0 and pendingLive stays pinned to the exact on-chain value.
  const boostedAmount = (stakedAmount * BigInt(boostBps)) / 10000n;
  const accrualPerSec = (!isPaused && rewardRate > 0n && totalBoostedStake > 0n && boostedAmount > 0n)
    ? Number(formatEther(rewardRate)) * (Number(boostedAmount) / Number(totalBoostedStake))
    : 0;

  const pendingNum = pendingReward ? Number(formatEther(pendingReward)) : 0;
  const [pendingLive, setPendingLive] = useState(0);
  useEffect(() => {
    // Reconcile first: whenever the true on-chain value (or the rate) changes we
    // snap the counter back onto it — including downwards after a claim — so the
    // display can never wander away from chain state.
    setPendingLive(pendingNum);
    if (accrualPerSec <= 0) return;
    const startedAt = Date.now();
    const id = setInterval(() => {
      const elapsed = Math.min((Date.now() - startedAt) / 1000, MAX_ACCRUAL_DRIFT_SEC);
      setPendingLive(pendingNum + elapsed * accrualPerSec);
    }, 1000);
    return () => clearInterval(id);
  }, [pendingNum, accrualPerSec]);

  const refetchAll = async () => {
    await Promise.all([refetch(), refetchPos()]);
  };

  return {
    tokenId,
    hasPosition,
    stakedAmount,
    stakedFormatted: formatEther(stakedAmount),
    pendingReward,
    pendingFormatted: pendingReward ? formatEther(pendingReward) : '0',
    /** Interpolated claimable, reconciled to `pendingReward` on every refetch.
     *  DISPLAY ONLY — never use for tx amounts, claim gating, or portfolio math;
     *  use `pendingReward` / `pendingFormatted` for those. */
    pendingLive,
    /** TOWELI/sec this position accrues. 0 when not derivable (paused, unread,
     *  or no position) — callers should fall back to the static value then. */
    accrualPerSec,
    walletBalance,
    walletBalanceFormatted: formatEther(walletBalance),
    allowance,
    needsApproval,
    boostBps,
    boostMultiplier,
    lockEnd,
    lockDuration,
    isLocked,
    canWithdraw,
    autoMaxLock,
    isPaused,
    unsettledRewards,
    unsettledFormatted: unsettledRewards ? formatEther(unsettledRewards) : '0',
    refetchAll,
    isDeployed,
    isLoading,
  };
}
