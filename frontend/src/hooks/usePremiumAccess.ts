import { useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts, useReadContract } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { PREMIUM_ACCESS_ABI, ERC20_ABI } from '../lib/contracts';
import { PREMIUM_ACCESS_ADDRESS, TOWELI_ADDRESS, JBAC_NFT_ADDRESS } from '../lib/constants';

export function usePremiumAccess() {
  const { address } = useAccount();
  const userAddr = address ?? '0x0000000000000000000000000000000000000000';

  const { writeContract: writeApprove, data: approveHash, isPending: isApprovePending, reset: resetApprove, error: approveError } = useWriteContract();
  const { writeContract: writeAction, data: actionHash, isPending: isActionPending, reset: resetAction, error: actionError } = useWriteContract();

  const isPending = isApprovePending || isActionPending;

  // Track each tx independently so approve doesn't shadow the subsequent action tx
  const { isLoading: isApproveConfirming, isSuccess: isApproveSuccess, isError: isApproveTxError } = useWaitForTransactionReceipt({ hash: approveHash });
  const { isLoading: isActionConfirming, isSuccess: isActionSuccess, isError: isActionTxError } = useWaitForTransactionReceipt({ hash: actionHash });

  const isConfirming = isApproveConfirming || isActionConfirming;
  const isSuccess = isApproveSuccess || isActionSuccess;
  void (isApproveTxError || isActionTxError);
  const hash = actionHash ?? approveHash;

  // Check if user holds a JBAC NFT
  const { data: jbacBalance } = useReadContract({
    address: JBAC_NFT_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [userAddr],
    query: { enabled: !!address },
  });
  const holdsJBAC = jbacBalance != null && (jbacBalance as bigint) > 0n;

  const { data, refetch, isLoading: isDataLoading, isError: isDataError, error: dataError } = useReadContracts({
    contracts: [
      // User subscription
      { address: PREMIUM_ACCESS_ADDRESS, abi: PREMIUM_ACCESS_ABI, functionName: 'hasPremium', args: [userAddr] },
      { address: PREMIUM_ACCESS_ADDRESS, abi: PREMIUM_ACCESS_ABI, functionName: 'getSubscription', args: [userAddr] },
      // Global stats
      { address: PREMIUM_ACCESS_ADDRESS, abi: PREMIUM_ACCESS_ABI, functionName: 'monthlyFeeToweli' },
      { address: PREMIUM_ACCESS_ADDRESS, abi: PREMIUM_ACCESS_ABI, functionName: 'totalSubscribers' },
      { address: PREMIUM_ACCESS_ADDRESS, abi: PREMIUM_ACCESS_ABI, functionName: 'totalRevenue' },
      // User TOWELI balance + allowance
      { address: TOWELI_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr] },
      { address: TOWELI_ADDRESS, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, PREMIUM_ACCESS_ADDRESS] },
    ],
    query: { enabled: !!address, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  // Parse results
  const hasPremium = data?.[0]?.status === 'success' ? (data[0].result as boolean) : false;

  const subscription = data?.[1]?.status === 'success'
    ? (data[1].result as [bigint, boolean, boolean])
    : null;
  const expiresAt = subscription ? Number(subscription[0]) : 0;
  const isLifetime = subscription ? subscription[1] : false;
  const isActive = subscription ? subscription[2] : false;

  const monthlyFee = data?.[2]?.status === 'success' ? (data[2].result as bigint) : 0n;
  const totalSubscribers = data?.[3]?.status === 'success' ? Number(data[3].result as bigint) : 0;
  const totalRevenue = data?.[4]?.status === 'success' ? (data[4].result as bigint) : 0n;
  const userBalance = data?.[5]?.status === 'success' ? (data[5].result as bigint) : 0n;
  const allowance = data?.[6]?.status === 'success' ? (data[6].result as bigint) : 0n;

  const monthlyFeeFormatted = Number(formatEther(monthlyFee));
  const totalRevenueFormatted = Number(formatEther(totalRevenue));
  const userBalanceFormatted = Number(formatEther(userBalance));

  // Days remaining
  const now = Math.floor(Date.now() / 1000);
  const daysRemaining = isLifetime ? Infinity : (expiresAt > now ? Math.ceil((expiresAt - now) / 86400) : 0);

  function needsApproval(months: number): boolean {
    const totalCost = monthlyFee * BigInt(months);
    return allowance < totalCost;
  }

  function approveToweli(months: number) {
    const totalCost = monthlyFee * BigInt(months);
    writeApprove({
      address: TOWELI_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [PREMIUM_ACCESS_ADDRESS, totalCost],
    });
  }

  function subscribe(months: number) {
    // AUDIT FIX H-02: Include maxCost to protect against fee frontrunning
    const maxCost = monthlyFee * BigInt(months);
    writeAction({
      address: PREMIUM_ACCESS_ADDRESS,
      abi: PREMIUM_ACCESS_ABI,
      functionName: 'subscribe',
      args: [BigInt(months), maxCost],
    });
  }

  function activateNFTPremium() {
    writeAction({
      address: PREMIUM_ACCESS_ADDRESS,
      abi: PREMIUM_ACCESS_ABI,
      functionName: 'activateNFTPremium',
    });
  }

  // Toast feedback — defer reset to next tick so isSuccess is readable by consumers this render
  useEffect(() => {
    if (isApproveSuccess) {
      toast.success('Approval confirmed!');
      refetch();
      const t = setTimeout(() => { resetApprove(); }, 0);
      return () => clearTimeout(t);
    }
  }, [isApproveSuccess, refetch, resetApprove]);

  useEffect(() => {
    if (isActionSuccess) {
      toast.success('Transaction confirmed!');
      refetch();
      const t = setTimeout(() => { resetAction(); }, 0);
      return () => clearTimeout(t);
    }
  }, [isActionSuccess, refetch, resetAction]);

  useEffect(() => {
    if (isApproveTxError) {
      toast.error('Approval transaction failed on-chain');
      const t = setTimeout(() => { resetApprove(); }, 0);
      return () => clearTimeout(t);
    }
  }, [isApproveTxError, resetApprove]);

  useEffect(() => {
    if (isActionTxError) {
      toast.error('Transaction failed on-chain');
      const t = setTimeout(() => { resetAction(); }, 0);
      return () => clearTimeout(t);
    }
  }, [isActionTxError, resetAction]);

  // Surface wallet/write errors (user rejection, gas estimation, etc.)
  useEffect(() => {
    if (approveError) {
      const msg = (approveError as Error)?.message?.split('\n')[0] ?? 'Approval failed';
      toast.error(msg);
      const t = setTimeout(() => { resetApprove(); }, 0);
      return () => clearTimeout(t);
    }
  }, [approveError, resetApprove]);

  useEffect(() => {
    if (actionError) {
      const msg = (actionError as Error)?.message?.split('\n')[0] ?? 'Transaction failed';
      toast.error(msg);
      const t = setTimeout(() => { resetAction(); }, 0);
      return () => clearTimeout(t);
    }
  }, [actionError, resetAction]);

  return {
    // Subscription status
    hasPremium,
    isActive,
    isLifetime,
    expiresAt,
    daysRemaining,
    // Global stats
    monthlyFee,
    monthlyFeeFormatted,
    totalSubscribers,
    totalRevenueFormatted,
    // User
    userBalance,
    userBalanceFormatted,
    allowance,
    needsApproval,
    // Actions
    approveToweli,
    subscribe,
    activateNFTPremium,
    holdsJBAC,
    refetch,
    // TX state
    hash,
    approveHash,
    actionHash,
    isPending,
    isConfirming,
    isSuccess,
    isApproveSuccess,
    isActionSuccess,
    // Data loading / error
    isDataLoading,
    isDataError,
    dataError,
    reset: () => { resetApprove(); resetAction(); },
  };
}
