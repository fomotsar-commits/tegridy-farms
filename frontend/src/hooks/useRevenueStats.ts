import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { useEffect } from 'react';
import { toast } from 'sonner';
import { REVENUE_DISTRIBUTOR_ABI, REFERRAL_SPLITTER_ABI } from '../lib/contracts';
import { REVENUE_DISTRIBUTOR_ADDRESS, REFERRAL_SPLITTER_ADDRESS, CHAIN_ID } from '../lib/constants';
import { formatWei } from '../lib/formatting';

export function useRevenueStats() {
  const { address } = useAccount();
  const chainId = useChainId();
  const userAddr = address ?? '0x0000000000000000000000000000000000000000';

  const { writeContract: writeClaim, data: claimHash, isPending: isClaimPending, reset: resetClaim, error: claimError } = useWriteContract();

  const hash = claimHash;
  const isPending = isClaimPending;
  const writeError = claimError;

  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // R043 H-062-02: chainId pin on every entry — matches useFarmActions /
  // ETHRevenueClaim so the pendingETH read dedupes to one cache schedule and a
  // wrong-chain wallet can't surface another chain's revenue figures.
  const { data, refetch, isLoading: isDataLoading, isError: isDataError, error: dataError } = useReadContracts({
    contracts: [
      // Revenue Distributor — global
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'totalDistributed', chainId: CHAIN_ID },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'totalClaimed', chainId: CHAIN_ID },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'epochCount', chainId: CHAIN_ID },
      // Revenue Distributor — user (no registration needed — checkpoint-based)
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'pendingETH', args: [userAddr], chainId: CHAIN_ID },
      // Referral Splitter — user
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'getReferralInfo', args: [userAddr], chainId: CHAIN_ID },
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'pendingETH', args: [userAddr], chainId: CHAIN_ID },
      // Referral Splitter — global
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'totalReferralsPaid', chainId: CHAIN_ID },
      // Referral Splitter — who referred this user (null if unset)
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'referrerOf', args: [userAddr], chainId: CHAIN_ID },
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
  const referrer = data?.[7]?.status === 'success' ? (data[7].result as string) : null;
  const hasReferrer = !!referrer && referrer !== '0x0000000000000000000000000000000000000000';

  // Actions — no registration needed, just claim
  function claimRevenue() {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    writeClaim({
      chainId: CHAIN_ID,
      address: REVENUE_DISTRIBUTOR_ADDRESS,
      abi: REVENUE_DISTRIBUTOR_ABI,
      functionName: 'claim',
    });
  }

  function claimReferralRewards() {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    writeClaim({
      chainId: CHAIN_ID,
      address: REFERRAL_SPLITTER_ADDRESS,
      abi: REFERRAL_SPLITTER_ABI,
      functionName: 'claimReferralRewards',
    });
  }

  function setReferrer(referrerAddress: `0x${string}`) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (hasReferrer) { toast.info('Referrer already set'); return; }
    writeClaim({
      chainId: CHAIN_ID,
      address: REFERRAL_SPLITTER_ADDRESS,
      abi: REFERRAL_SPLITTER_ABI,
      functionName: 'setReferrer',
      args: [referrerAddress],
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
    totalDistributed: Number(formatWei(totalDistributed, 18, 6)),
    totalClaimed: Number(formatWei(totalClaimed, 18, 6)),
    unclaimed: Number(formatWei(totalDistributed > totalClaimed ? totalDistributed - totalClaimed : 0n, 18, 6)),
    epochCount,
    pendingRevenue: Number(formatWei(pendingRevenue, 18, 6)),
    pendingRevenueBig: pendingRevenue,
    // Referrals
    referredCount,
    referralEarned: Number(formatWei(referralEarned, 18, 6)),
    referralPending: Number(formatWei(referralPending, 18, 6)),
    referralPendingBig: referralPending,
    totalReferralsPaid: Number(formatWei(totalReferralsPaid, 18, 6)),
    referrer,
    hasReferrer,
    // Actions
    claimRevenue,
    claimReferralRewards,
    setReferrer,
    // TX
    hash: claimHash,
    isPending,
    isConfirming,
    isSuccess,
    // Data loading / error
    isDataLoading,
    isDataError,
    dataError,
    refetch,
  };
}
