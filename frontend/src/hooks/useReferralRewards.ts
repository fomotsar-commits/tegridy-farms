import { useEffect, useCallback } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts, useChainId } from 'wagmi';
import { toast } from 'sonner';
import { REFERRAL_SPLITTER_ABI } from '../lib/contracts';
import { REFERRAL_SPLITTER_ADDRESS, CHAIN_ID } from '../lib/constants';
import { formatWei } from '../lib/formatting';

export function useReferralRewards() {
  const chainId = useChainId();
  const { address } = useAccount();
  const userAddr = address ?? '0x0000000000000000000000000000000000000000';

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  const { data, refetch, isLoading: isDataLoading } = useReadContracts({
    contracts: [
      // User's referral info (referred count, total earned, pending)
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'getReferralInfo', args: [userAddr] },
      // Who referred this user
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'referrerOf', args: [userAddr] },
      // Pending ETH to claim
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'pendingETH', args: [userAddr] },
      // Global stats
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'totalReferralsPaid' },
    ],
    query: { enabled: !!address, refetchInterval: 30_000 },
  });

  // Parse results
  const referralInfo = data?.[0]?.status === 'success'
    ? (data[0].result as readonly [bigint, bigint, bigint])
    : undefined;
  const referredCount = referralInfo ? Number(referralInfo[0] > 10000n ? 10000n : referralInfo[0]) : 0;
  const totalEarned = referralInfo ? referralInfo[1] : 0n;
  const pendingFromInfo = referralInfo ? referralInfo[2] : 0n;

  const referrer = data?.[1]?.status === 'success' ? (data[1].result as string) : null;
  const hasReferrer = !!referrer && referrer !== '0x0000000000000000000000000000000000000000';

  const pendingETH = data?.[2]?.status === 'success' ? (data[2].result as bigint) : pendingFromInfo;

  const totalReferralsPaid = data?.[3]?.status === 'success' ? (data[3].result as bigint) : 0n;

  // Formatted values
  const totalEarnedFormatted = Number(formatWei(totalEarned, 18, 6));
  const pendingETHFormatted = Number(formatWei(pendingETH, 18, 6));
  const totalReferralsPaidFormatted = Number(formatWei(totalReferralsPaid, 18, 6));

  // Actions
  const claimReferralRewards = useCallback(() => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (pendingETH === 0n) { toast.info('No referral rewards to claim'); return; }
    writeContract({
      address: REFERRAL_SPLITTER_ADDRESS,
      abi: REFERRAL_SPLITTER_ABI,
      functionName: 'claimReferralRewards',
    });
  }, [chainId, pendingETH, writeContract]);

  const setReferrer = useCallback((referrerAddress: string) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (hasReferrer) { toast.info('Referrer already set'); return; }
    writeContract({
      address: REFERRAL_SPLITTER_ADDRESS,
      abi: REFERRAL_SPLITTER_ABI,
      functionName: 'setReferrer',
      args: [referrerAddress as `0x${string}`],
    });
  }, [chainId, hasReferrer, writeContract]);

  // Toast feedback
  useEffect(() => {
    if (isSuccess) {
      toast.success('Referral rewards claimed!');
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
    // Referral stats
    referredCount,
    totalEarned,
    totalEarnedFormatted,
    pendingETH,
    pendingETHFormatted,
    hasReferrer,
    referrer,
    // Global
    totalReferralsPaid,
    totalReferralsPaidFormatted,
    // Actions
    claimReferralRewards,
    setReferrer,
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
