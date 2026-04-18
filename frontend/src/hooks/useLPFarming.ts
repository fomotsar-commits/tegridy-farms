import { useEffect, useMemo } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts, useChainId } from 'wagmi';
import { parseEther, formatEther } from 'viem';
import { toast } from 'sonner';
import { LP_FARMING_ABI, ERC20_ABI } from '../lib/contracts';
import { LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
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
  // parseEther is correct here: Uniswap V2 LP tokens are always 18 decimals (see
  // UniswapV2ERC20: `uint8 public constant decimals = 18`), and TegridyLP is a V2 clone.
  // If this hook is ever reused against a non-standard LP (e.g., V3 NFT), switch to
  // parseUnits(amount, decimals) with the token's actual decimals field.

  function approveLP(amount: string) {
    if (chainId !== CHAIN_ID) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    writeContract({
      address: TEGRIDY_LP_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [LP_FARMING_ADDRESS, parseEther(amount)],
    });
  }

  function stake(amount: string) {
    if (chainId !== CHAIN_ID) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    // Proactive approval guard — reverts before a failed-tx gas burn if allowance
    // is insufficient. Consumers should still call approveLP first if lpAllowance < amount.
    const want = parseEther(amount);
    if (lpAllowance < want) {
      toast.error('Approve LP token first (Allowance too low)');
      return;
    }
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'stake',
      args: [want],
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
