import { useEffect, useMemo } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts, useChainId } from 'wagmi';
import { parseEther, formatEther } from 'viem';
import { toast } from 'sonner';
import { LP_FARMING_ABI, ERC20_ABI } from '../lib/contracts';
import { LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';
import { getTxUrl } from '../lib/explorer';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

export function useLPFarming() {
  const { address } = useAccount();
  const chainId = useChainId();
  const userAddr = address ?? ZERO_ADDR;
  const isDeployed = checkDeployed(LP_FARMING_ADDRESS);

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // Batch read: global stats + user data
  const { data, refetch, isLoading: isReadLoading } = useReadContracts({
    contracts: [
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'totalSupply' },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rewardRate' },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'periodFinish' },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rewardsDuration' },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'totalRewardsFunded' },
      // User-specific
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'balanceOf', args: [userAddr] },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'earned', args: [userAddr] },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr] },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, LP_FARMING_ADDRESS] },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'totalSupply' },
    ],
    query: { enabled: isDeployed, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  const totalStaked = data?.[0]?.status === 'success' ? data[0].result as bigint : 0n;
  const rewardRate = data?.[1]?.status === 'success' ? data[1].result as bigint : 0n;
  const periodFinish = data?.[2]?.status === 'success' ? Number(data[2].result) : 0;
  const rewardsDuration = data?.[3]?.status === 'success' ? Number(data[3].result) : 0;
  const totalRewardsFunded = data?.[4]?.status === 'success' ? data[4].result as bigint : 0n;
  const stakedBalance = data?.[5]?.status === 'success' ? data[5].result as bigint : 0n;
  const pendingReward = data?.[6]?.status === 'success' ? data[6].result as bigint : 0n;
  const walletLPBalance = data?.[7]?.status === 'success' ? data[7].result as bigint : 0n;
  const lpAllowance = data?.[8]?.status === 'success' ? data[8].result as bigint : 0n;
  const lpTotalSupply = data?.[9]?.status === 'success' ? data[9].result as bigint : 0n;

  const isActive = periodFinish > Math.floor(Date.now() / 1000);

  // APR calculation (needs external price data — computed by consumer)
  const rewardRatePerDay = useMemo(() => {
    if (rewardRate === 0n) return 0;
    return parseFloat(formatEther(rewardRate)) * 86400;
  }, [rewardRate]);

  const rewardRatePerYear = rewardRatePerDay * 365;

  // Toasts
  useEffect(() => {
    if (isSuccess && hash) {
      toast.success('Transaction confirmed!', {
        id: hash,
        action: { label: 'Explorer', onClick: () => window.open(getTxUrl(chainId, hash), '_blank') },
      });
      refetch();
      setTimeout(() => reset(), 4000);
    }
  }, [isSuccess, hash, refetch]);

  useEffect(() => {
    if (isTxError && hash) {
      toast.error('Transaction failed', { id: `err-${hash}` });
      setTimeout(() => reset(), 4000);
    }
  }, [isTxError, hash]);

  useEffect(() => {
    if (writeError) {
      toast.error(writeError.message?.slice(0, 120) ?? 'Unknown error', { id: 'write-error' });
      setTimeout(() => reset(), 4000);
    }
  }, [writeError]);

  // Actions
  function approveLP(amount: string) {
    writeContract({
      address: TEGRIDY_LP_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [LP_FARMING_ADDRESS, parseEther(amount)],
    });
  }

  function stake(amount: string) {
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'stake',
      args: [parseEther(amount)],
    });
  }

  function withdraw(amount: string) {
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'withdraw',
      args: [parseEther(amount)],
    });
  }

  function claim() {
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'getReward',
    });
  }

  function exit() {
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'exit',
    });
  }

  function emergencyWithdraw() {
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'emergencyWithdraw',
    });
  }

  return {
    // Global stats
    totalStaked,
    totalStakedFormatted: formatEther(totalStaked),
    rewardRate,
    rewardRatePerDay,
    rewardRatePerYear,
    periodFinish,
    rewardsDuration,
    totalRewardsFunded,
    totalRewardsFundedFormatted: formatEther(totalRewardsFunded),
    isActive,
    lpTotalSupply,
    // User data
    stakedBalance,
    stakedBalanceFormatted: formatEther(stakedBalance),
    pendingReward,
    pendingRewardFormatted: formatEther(pendingReward),
    walletLPBalance,
    walletLPBalanceFormatted: formatEther(walletLPBalance),
    lpAllowance,
    // Actions
    approveLP,
    stake,
    withdraw,
    claim,
    exit,
    emergencyWithdraw,
    // State
    isDeployed,
    isReadLoading,
    isPending,
    isConfirming,
    isSuccess,
    hash,
    reset,
    refetch,
  };
}
