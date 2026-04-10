import { useEffect } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { PREMIUM_ACCESS_ABI, ERC20_ABI } from '../lib/contracts';
import { PREMIUM_ACCESS_ADDRESS, TOWELI_ADDRESS } from '../lib/constants';

const ZERO_ADDR = '0x0000000000000000000000000000000000000001' as const;

export function usePremiumAccess() {
  const { address } = useAccount();
  const userAddr = address ?? ZERO_ADDR;

  const { writeContract: writeApprove, data: approveHash, isPending: isApprovePending, reset: resetApprove, error: approveError } = useWriteContract();
  const { writeContract: writeAction, data: actionHash, isPending: isActionPending, reset: resetAction, error: actionError } = useWriteContract();

  const hash = approveHash ?? actionHash;
  const isPending = isApprovePending || isActionPending;
  const writeError = approveError ?? actionError;

  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  const { data, refetch } = useReadContracts({
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
    query: { enabled: !!address, refetchInterval: 15_000, refetchOnWindowFocus: true },
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

  function claimNFTAccess() {
    writeAction({
      address: PREMIUM_ACCESS_ADDRESS,
      abi: PREMIUM_ACCESS_ABI,
      functionName: 'claimNFTAccess',
    });
  }

  // Toast feedback
  useEffect(() => {
    if (isSuccess) {
      toast.success('Transaction confirmed!');
      refetch();
      resetApprove();
      resetAction();
    }
    if (isTxError || writeError) {
      toast.error('Transaction failed');
      resetApprove();
      resetAction();
    }
  }, [isSuccess, isTxError, writeError, refetch, resetApprove, resetAction]);

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
    claimNFTAccess,
    refetch,
    // TX state
    hash,
    isPending,
    isConfirming,
    isSuccess,
    reset: () => { resetApprove(); resetAction(); },
  };
}
