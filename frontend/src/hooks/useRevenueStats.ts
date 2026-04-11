import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { REVENUE_DISTRIBUTOR_ABI, REFERRAL_SPLITTER_ABI } from '../lib/contracts';
import { REVENUE_DISTRIBUTOR_ADDRESS, REFERRAL_SPLITTER_ADDRESS } from '../lib/constants';

export function useRevenueStats() {
  const { address } = useAccount();
  const userAddr = address ?? '0x0000000000000000000000000000000000000000';

  const { writeContract: writeClaim, data: claimHash, isPending: isClaimPending, reset: resetClaim, error: claimError } = useWriteContract();

  const hash = claimHash;
  const isPending = isClaimPending;
  const writeError = claimError;

  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  const { data, refetch } = useReadContracts({
    contracts: [
      // Revenue Distributor — global
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'totalDistributed' },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'totalClaimed' },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'epochCount' },
      // Revenue Distributor — user (no registration needed — checkpoint-based)
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'pendingETH', args: [userAddr] },
      // Referral Splitter — user
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'getReferralInfo', args: [userAddr] },
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'pendingETH', args: [userAddr] },
      // Referral Splitter — global
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'totalReferralsPaid' },
    ],
    query: { enabled: !!address, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  // Revenue Distributor
  const totalDistributed = data?.[0]?.status === 'success' ? (data[0].result as bigint) : 0n;
  const totalClaimed = data?.[1]?.status === 'success' ? (data[1].result as bigint) : 0n;
  const epochCount = data?.[2]?.status === 'success' ? Number(data[2].result as bigint) : 0;
  const pendingRevenue = data?.[3]?.status === 'success' ? (data[3].result as bigint) : 0n;

  // Referral
  const referralInfo = data?.[4]?.status === 'success'
    ? (data[4].result as [bigint, bigint, bigint])
    : null;
  const referredCount = referralInfo ? Number(referralInfo[0]) : 0;
  const referralEarned = referralInfo ? referralInfo[1] : 0n;
  const referralPendingFromInfo = referralInfo ? referralInfo[2] : 0n;
  const referralPending = data?.[5]?.status === 'success' ? (data[5].result as bigint) : referralPendingFromInfo;
  const totalReferralsPaid = data?.[6]?.status === 'success' ? (data[6].result as bigint) : 0n;

  // Actions — no registration needed, just claim
  function claimRevenue() {
    writeClaim({
      address: REVENUE_DISTRIBUTOR_ADDRESS,
      abi: REVENUE_DISTRIBUTOR_ABI,
      functionName: 'claim',
    });
  }

  function claimReferralRewards() {
    writeClaim({
      address: REFERRAL_SPLITTER_ADDRESS,
      abi: REFERRAL_SPLITTER_ABI,
      functionName: 'claimReferralRewards',
    });
  }

  // Toast feedback — defer reset to next tick so isSuccess is readable by consumers this render
  useEffect(() => {
    if (isSuccess) {
      toast.success('Transaction confirmed!');
      refetch();
      const t = setTimeout(resetClaim, 0);
      return () => clearTimeout(t);
    }
    if (isTxError || writeError) {
      toast.error('Transaction failed');
      const t = setTimeout(resetClaim, 0);
      return () => clearTimeout(t);
    }
  }, [isSuccess, isTxError, writeError, refetch, resetClaim]);

  return {
    // Revenue Distribution
    totalDistributed: Number(formatEther(totalDistributed)),
    totalClaimed: Number(formatEther(totalClaimed)),
    unclaimed: Number(formatEther(totalDistributed > totalClaimed ? totalDistributed - totalClaimed : 0n)),
    epochCount,
    pendingRevenue: Number(formatEther(pendingRevenue)),
    pendingRevenueBig: pendingRevenue,
    // Referrals
    referredCount,
    referralEarned: Number(formatEther(referralEarned)),
    referralPending: Number(formatEther(referralPending)),
    referralPendingBig: referralPending,
    totalReferralsPaid: Number(formatEther(totalReferralsPaid)),
    // Actions
    claimRevenue,
    claimReferralRewards,
    // TX
    isPending,
    isConfirming,
    isSuccess,
    refetch,
  };
}
