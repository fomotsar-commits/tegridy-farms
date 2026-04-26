import { useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_RESTAKING_ABI, TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { TEGRIDY_RESTAKING_ADDRESS, TEGRIDY_STAKING_ADDRESS, CHAIN_ID } from '../lib/constants';

export function useRestaking() {
  const chainId = useChainId();
  const { address } = useAccount();
  const userAddr = address ?? '0x0000000000000000000000000000000000000000';

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // Read user's staking position + restaking state in parallel
  const { data, refetch, isLoading: isDataLoading } = useReadContracts({
    contracts: [
      // Staking: get user's tokenId
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'userTokenId', args: [userAddr] },
      // Restaking: user's restaker info
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'restakers', args: [userAddr] },
      // Restaking: pending rewards
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'pendingTotal', args: [userAddr] },
      // Global stats
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'totalRestaked' },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'totalBonusFunded' },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'totalBonusDistributed' },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'bonusRewardPerSecond' },
    ],
    query: { enabled: !!address, refetchInterval: 30_000 },
  });

  // Parse results
  const userTokenId = data?.[0]?.status === 'success' ? (data[0].result as bigint) : 0n;
  const hasStakingPosition = userTokenId > 0n;

  const restakerData = data?.[1]?.status === 'success'
    ? (data[1].result as readonly [bigint, bigint, bigint, bigint, bigint])
    : undefined;
  const isRestaked = restakerData ? restakerData[0] > 0n : false; // tokenId > 0
  const restakedAmount = restakerData ? restakerData[1] : 0n;
  const restakedBoosted = restakerData ? restakerData[2] : 0n;

  const pendingRewards = data?.[2]?.status === 'success'
    ? (data[2].result as readonly [bigint, bigint])
    : undefined;
  const pendingBaseRaw = pendingRewards ? pendingRewards[0] : 0n;
  const pendingBonusRaw = pendingRewards ? pendingRewards[1] : 0n;

  const totalRestaked = data?.[3]?.status === 'success' ? (data[3].result as bigint) : 0n;
  const totalBonusFunded = data?.[4]?.status === 'success' ? (data[4].result as bigint) : 0n;
  const totalBonusDistributed = data?.[5]?.status === 'success' ? (data[5].result as bigint) : 0n;
  const bonusRewardPerSecond = data?.[6]?.status === 'success' ? (data[6].result as bigint) : 0n;

  // R075: RPC sanity bounds. A malicious upstream could quote rewards
  // larger than the contract budget and trick the user into signing a
  // claim that reverts (or worse, anchor a phantom number to the UI before
  // signing). Cap at on-chain budget × 2 to allow legitimate rounding /
  // rate-shift overshoot while stopping outright lies.
  //   pendingBonus ≤ (totalBonusFunded - totalBonusDistributed) × 2
  //   pendingBase  ≤ restakedAmount × 2
  const bonusBudget = totalBonusFunded > totalBonusDistributed
    ? totalBonusFunded - totalBonusDistributed
    : 0n;
  const bonusCap = bonusBudget * 2n;
  const baseCap = restakedAmount * 2n;
  const bonusBreach = bonusCap > 0n && pendingBonusRaw > bonusCap;
  const baseBreach = baseCap > 0n && pendingBaseRaw > baseCap;
  const pendingBonus = bonusBreach ? 0n : pendingBonusRaw;
  const pendingBase = baseBreach ? 0n : pendingBaseRaw;
  const pendingTotal = pendingBase + pendingBonus;
  const rewardSanityBreach = bonusBreach || baseBreach;

  // Formatted values
  const restakedFormatted = Number(formatEther(restakedAmount));
  const pendingTotalFormatted = Number(formatEther(pendingTotal));
  const pendingBaseFormatted = Number(formatEther(pendingBase));
  const pendingBonusFormatted = Number(formatEther(pendingBonus));
  const totalRestakedFormatted = Number(formatEther(totalRestaked));

  // Bonus APR estimate (annualized from per-second rate)
  const bonusAPR = totalRestaked > 0n
    ? Number(formatEther(bonusRewardPerSecond * 31536000n)) / Number(formatEther(totalRestaked)) * 100
    : 0;

  // Actions
  function restake() {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!hasStakingPosition) { toast.error('You need a staking position first'); return; }
    if (isRestaked) { toast.error('Already restaked'); return; }
    writeContract({
      address: TEGRIDY_RESTAKING_ADDRESS,
      abi: TEGRIDY_RESTAKING_ABI,
      functionName: 'restake',
      args: [userTokenId],
    });
  }

  function unrestake() {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!isRestaked) return;
    writeContract({
      address: TEGRIDY_RESTAKING_ADDRESS,
      abi: TEGRIDY_RESTAKING_ABI,
      functionName: 'unrestake',
    });
  }

  function claimAll() {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (pendingTotal === 0n) { toast.info('No rewards to claim'); return; }
    writeContract({
      address: TEGRIDY_RESTAKING_ADDRESS,
      abi: TEGRIDY_RESTAKING_ABI,
      functionName: 'claimAll',
    });
  }

  // Toast feedback
  useEffect(() => {
    if (isSuccess) {
      toast.success('Restaking transaction confirmed!');
      refetch();
    }
  }, [isSuccess, refetch]);

  useEffect(() => {
    if (isTxError) toast.error('Transaction failed on-chain');
  }, [isTxError]);

  useEffect(() => {
    if (writeError) {
      const msg = (writeError.message ?? 'Unknown error').replace(/https?:\/\/\S+/g, '').slice(0, 120);
      toast.error(msg);
    }
  }, [writeError]);

  return {
    // User state
    hasStakingPosition,
    isRestaked,
    restakedAmount,
    restakedFormatted,
    restakedBoosted,
    // Rewards (sanity-bounded — see R075)
    pendingBase,
    pendingBonus,
    pendingTotal,
    pendingBaseFormatted,
    pendingBonusFormatted,
    pendingTotalFormatted,
    /** R075: true when an RPC quoted impossible reward numbers — UI
     *  should prompt "Verify on-chain" instead of showing the values. */
    rewardSanityBreach,
    // Global stats
    totalRestaked,
    totalRestakedFormatted,
    totalBonusFunded,
    totalBonusDistributed,
    bonusRewardPerSecond,
    bonusAPR,
    // Actions
    restake,
    unrestake,
    claimAll,
    refetch,
    // TX state
    hash,
    isPending,
    isConfirming,
    isSuccess,
    isDataLoading,
    reset,
  };
}
