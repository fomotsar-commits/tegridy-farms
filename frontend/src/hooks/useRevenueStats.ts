import { useAccount, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { useEffect, useCallback } from 'react';
import { toast } from 'sonner';
import { REVENUE_DISTRIBUTOR_ABI, REFERRAL_SPLITTER_ABI } from '../lib/contracts';
import { REVENUE_DISTRIBUTOR_ADDRESS, REFERRAL_SPLITTER_ADDRESS, CHAIN_ID } from '../lib/constants';
import { formatWei } from '../lib/formatting';
import { surfaceTxError } from '../lib/txErrors';

export function useRevenueStats() {
  const { address } = useAccount();
  const chainId = useChainId();
  const userAddr = address ?? '0x0000000000000000000000000000000000000000';

  const { writeContract: writeClaim, data: claimHash, isPending: isClaimPending, reset: resetClaim, error: claimError } = useWriteContract();

  const hash = claimHash;
  const isPending = isClaimPending;
  const writeError = claimError;

  const { data: receipt, isLoading: isConfirming, isSuccess: isReceiptFetched, isError: isTxError } = useWaitForTransactionReceipt({ hash });
  // AUDIT (receipt-status, 2026-08-24): wagmi's raw `isSuccess` only means "the
  // receipt was FETCHED" — it latches true for on-chain REVERTED txs too. Only
  // receipt.status === 'success' is a real success; the toasts below key off this.
  const isReverted = isReceiptFetched && !!receipt && receipt.status !== 'success';
  const isSuccess = isReceiptFetched && !isReverted;

  // F47 (T7): the global lifetime figures (totalDistributed / totalClaimed /
  // epochCount / totalReferralsPaid) are public protocol stats — they back the
  // "every fee flows on-chain, verifiable" pitch on the landing hero. Splitting
  // them into their own query that is NOT gated on `!!address` lets the
  // disconnected visitor see the real lifetime-ETH number (gate the action, not
  // the data). The user-arg reads stay gated on a connected wallet below.
  // R043 H-062-02: chainId pin on every entry — a wrong-chain wallet can't
  // surface another chain's revenue figures.
  const { data: globalData, refetch: refetchGlobal, isLoading: isGlobalLoading, isError: isGlobalError, error: globalError } = useReadContracts({
    contracts: [
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'totalDistributed', chainId: CHAIN_ID },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'totalClaimed', chainId: CHAIN_ID },
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'epochCount', chainId: CHAIN_ID },
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'totalReferralsPaid', chainId: CHAIN_ID },
    ],
    query: { refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  // User-arg reads — only meaningful for a connected wallet, kept gated.
  const { data, refetch: refetchUser, isError: isUserError, error: userError } = useReadContracts({
    contracts: [
      // Revenue Distributor — user (no registration needed — checkpoint-based)
      { address: REVENUE_DISTRIBUTOR_ADDRESS, abi: REVENUE_DISTRIBUTOR_ABI, functionName: 'pendingETH', args: [userAddr], chainId: CHAIN_ID },
      // Referral Splitter — user
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'getReferralInfo', args: [userAddr], chainId: CHAIN_ID },
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'pendingETH', args: [userAddr], chainId: CHAIN_ID },
      // Referral Splitter — who referred this user (null if unset)
      { address: REFERRAL_SPLITTER_ADDRESS, abi: REFERRAL_SPLITTER_ABI, functionName: 'referrerOf', args: [userAddr], chainId: CHAIN_ID },
    ],
    query: { enabled: !!address, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  const refetch = useCallback(() => { refetchGlobal(); refetchUser(); }, [refetchGlobal, refetchUser]);
  // isDataLoading reflects the GLOBAL query so consumers (the landing hero) can
  // tell "still loading" apart from "loaded and zero" without a wallet.
  const isDataLoading = isGlobalLoading;
  const isDataError = isGlobalError || isUserError;
  const dataError = globalError ?? userError;

  // Revenue Distributor — global (ungated)
  const totalDistributed = globalData?.[0]?.status === 'success' ? (globalData[0].result as bigint) : 0n;
  const totalClaimed = globalData?.[1]?.status === 'success' ? (globalData[1].result as bigint) : 0n;
  const epochCount = globalData?.[2]?.status === 'success' ? Number(globalData[2].result as bigint) : 0;
  const totalReferralsPaid = globalData?.[3]?.status === 'success' ? (globalData[3].result as bigint) : 0n;

  // Revenue Distributor — user
  const pendingRevenue = data?.[0]?.status === 'success' ? (data[0].result as bigint) : 0n;

  // Referral — user
  const referralInfo = data?.[1]?.status === 'success'
    ? (data[1].result as [bigint, bigint, bigint])
    : null;
  const referredCount = referralInfo ? Number(referralInfo[0]) : 0;
  const referralEarned = referralInfo ? referralInfo[1] : 0n;
  const referralPendingFromInfo = referralInfo ? referralInfo[2] : 0n;
  const referralPending = data?.[2]?.status === 'success' ? (data[2].result as bigint) : referralPendingFromInfo;
  const referrer = data?.[3]?.status === 'success' ? (data[3].result as string) : null;
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
      // F474: a writeError carries the wallet rejection — classify it (so a
      // cancel shows "Cancelled", not a scary "Transaction failed"). A bare
      // on-chain revert (isTxError, no writeError) keeps the generic message.
      if (writeError) surfaceTxError(writeError, toast, { component: 'useRevenueStats' });
      else toast.error('Transaction failed');
      const t = setTimeout(resetClaim, 0);
      return () => clearTimeout(t);
    }
  }, [isSuccess, isTxError, writeError, refetch, resetClaim]);

  // On-chain revert: the receipt fetch succeeded (so isTxError stays false) but
  // the tx failed — honest error instead of "Transaction confirmed!" (see derivation above).
  useEffect(() => {
    if (isReverted) {
      toast.error('Transaction reverted on-chain', {
        description: 'It was mined but the contract rejected it — no ETH moved and nothing changed.',
      });
      const t = setTimeout(resetClaim, 0);
      return () => clearTimeout(t);
    }
  }, [isReverted, resetClaim]);

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
