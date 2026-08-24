import { useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_RESTAKING_ABI, TEGRIDY_STAKING_ABI } from '../lib/contracts';
import { TEGRIDY_RESTAKING_ADDRESS, TEGRIDY_STAKING_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
import { surfaceTxError } from '../lib/txErrors';

export function useRestaking() {
  const chainId = useChainId();
  const { address } = useAccount();
  const userAddr = address ?? '0x0000000000000000000000000000000000000000';
  // M1 fix: gate all reads/writes — restaking is deferred (TEGRIDY_RESTAKING_ADDRESS == address(0)).
  const isDeployed = checkDeployed(TEGRIDY_RESTAKING_ADDRESS);

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { data: receipt, isLoading: isConfirming, isSuccess: isReceiptFetched, isError: isTxError } = useWaitForTransactionReceipt({ chainId: CHAIN_ID, hash });
  // AUDIT (receipt-status, 2026-08-24): wagmi's raw `isSuccess` only means "the
  // receipt was FETCHED" — it latches true for on-chain REVERTED txs too. Only
  // receipt.status === 'success' is a real success; the toasts below key off this.
  const isReverted = isReceiptFetched && !!receipt && receipt.status !== 'success';
  const isSuccess = isReceiptFetched && !isReverted;

  // Read user's staking position + restaking state in parallel.
  // R043 H-062-02: chainId pin on every entry, gate on the canonical chain.
  const onMainnet = chainId === CHAIN_ID;
  const { data, refetch, isLoading: isDataLoading } = useReadContracts({
    contracts: [
      // Staking: get user's tokenId
      { address: TEGRIDY_STAKING_ADDRESS, abi: TEGRIDY_STAKING_ABI, functionName: 'userTokenId', args: [userAddr], chainId: CHAIN_ID },
      // Restaking: user's restaker info
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'restakers', args: [userAddr], chainId: CHAIN_ID },
      // Restaking: pending rewards
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'pendingTotal', args: [userAddr], chainId: CHAIN_ID },
      // Global stats
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'totalRestaked', chainId: CHAIN_ID },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'totalBonusFunded', chainId: CHAIN_ID },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'totalBonusDistributed', chainId: CHAIN_ID },
      { address: TEGRIDY_RESTAKING_ADDRESS, abi: TEGRIDY_RESTAKING_ABI, functionName: 'bonusRewardPerSecond', chainId: CHAIN_ID },
    ],
    query: { enabled: !!address && isDeployed && onMainnet, refetchInterval: 30_000 },
  });

  // Parse results
  const userTokenId = data?.[0]?.status === 'success' ? (data[0].result as bigint) : 0n;
  const hasStakingPosition = userTokenId > 0n;

  const restakerData = data?.[1]?.status === 'success'
    ? (data[1].result as readonly [bigint, bigint, bigint, bigint, bigint, bigint])
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
    if (!isDeployed) { toast.error('Restaking is not live yet'); return; }
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!hasStakingPosition) { toast.error('You need a staking position first'); return; }
    if (isRestaked) { toast.error('Already restaked'); return; }
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_RESTAKING_ADDRESS,
      abi: TEGRIDY_RESTAKING_ABI,
      functionName: 'restake',
      args: [userTokenId],
    });
  }

  function unrestake() {
    if (!isDeployed) { toast.error('Restaking is not live yet'); return; }
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!isRestaked) return;
    writeContract({
      chainId: CHAIN_ID,
      address: TEGRIDY_RESTAKING_ADDRESS,
      abi: TEGRIDY_RESTAKING_ABI,
      functionName: 'unrestake',
    });
  }

  function claimAll() {
    if (!isDeployed) { toast.error('Restaking is not live yet'); return; }
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (pendingTotal === 0n) { toast.info('No rewards to claim'); return; }
    writeContract({
      chainId: CHAIN_ID,
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

  // On-chain revert: the receipt fetch succeeded (so isTxError stays false) but
  // the tx failed — honest error instead of the success toast (see derivation above).
  useEffect(() => {
    if (isReverted) {
      toast.error('Transaction reverted on-chain', {
        description: 'Nothing was restaked, unrestaked, or claimed — your position is unchanged.',
      });
    }
  }, [isReverted]);

  useEffect(() => {
    // F474: classify wallet cancellations as a soft "Cancelled" info toast.
    if (writeError) surfaceTxError(writeError, toast, { component: 'useRestaking' });
  }, [writeError]);

  return {
    // Deploy gate (M1): restaking deferred to Phase 7 — UI hides the section when false.
    isDeployed,
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
