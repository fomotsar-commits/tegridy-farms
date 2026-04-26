import { useEffect, useMemo, useRef } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { LP_FARMING_ABI, ERC20_ABI } from '../lib/contracts';
import { LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
import { getTxUrl } from '../lib/explorer';
import { safeParseEtherPositive } from '../lib/safeParseEther';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

export function useLPFarming() {
  const { address } = useAccount();
  const chainId = useChainId();
  const userAddr = address ?? ZERO_ADDR;
  const isDeployed = checkDeployed(LP_FARMING_ADDRESS);
  const onMainnet = chainId === CHAIN_ID;

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // R034 H2: address-snapshot + last-handled-hash refs to drop receipt-effect
  // for a wallet that swapped between submit and confirm.
  const txAddressRef = useRef<`0x${string}` | undefined>(undefined);
  const lastHandledHashRef = useRef<`0x${string}` | undefined>(undefined);

  // R034 H2: account-switch reset block.
  useEffect(() => {
    txAddressRef.current = undefined;
    lastHandledHashRef.current = undefined;
  }, [address]);

  // Batch read: global stats + user data
  // R043 H-062-02 + H-062-04: chainId pin on every contract entry, 60s poll
  // (was 30s — TVL/rewards don't move per-block), gate on onMainnet.
  const { data, refetch, isLoading: isReadLoading } = useReadContracts({
    contracts: [
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'totalSupply', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rewardRate', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'periodFinish', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rewardsDuration', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'totalRewardsFunded', chainId: CHAIN_ID },
      // User-specific
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'earned', args: [userAddr], chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, LP_FARMING_ADDRESS], chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'totalSupply', chainId: CHAIN_ID },
    ],
    query: { enabled: isDeployed && onMainnet, refetchInterval: 60_000, refetchOnWindowFocus: true },
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

  const rewardRatePerDay = useMemo(() => {
    if (rewardRate === 0n) return 0;
    return parseFloat(formatEther(rewardRate)) * 86400;
  }, [rewardRate]);

  const rewardRatePerYear = rewardRatePerDay * 365;

  // Toasts — R034 H2 drops on address mismatch.
  useEffect(() => {
    if (!isSuccess || !hash) return;
    if (lastHandledHashRef.current === hash) return;
    if (txAddressRef.current && txAddressRef.current !== address) {
      lastHandledHashRef.current = hash;
      txAddressRef.current = undefined;
      return;
    }
    lastHandledHashRef.current = hash;
    toast.success('Transaction confirmed!', {
      id: hash,
      action: { label: 'Explorer', onClick: () => window.open(getTxUrl(chainId, hash), '_blank') },
    });
    // R043 H-062-04: removed manual refetch() here — 60s poll drives convergence.
    setTimeout(() => reset(), 4000);
  }, [isSuccess, hash, address, chainId, reset]);

  useEffect(() => {
    if (!isTxError || !hash) return;
    if (lastHandledHashRef.current === hash) return;
    if (txAddressRef.current && txAddressRef.current !== address) {
      lastHandledHashRef.current = hash;
      return;
    }
    lastHandledHashRef.current = hash;
    toast.error('Transaction failed', { id: `err-${hash}` });
    setTimeout(() => reset(), 4000);
  }, [isTxError, hash, address, reset]);

  useEffect(() => {
    if (writeError) {
      toast.error(writeError.message?.slice(0, 120) ?? 'Unknown error', { id: 'write-error' });
      setTimeout(() => reset(), 4000);
    }
  }, [writeError, reset]);

  // Actions — R034 H4 safeParseEther replaces raw parseEther.
  function approveLP(amount: string) {
    if (chainId !== CHAIN_ID) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    const wei = safeParseEtherPositive(amount);
    if (wei === null) return;
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_LP_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [LP_FARMING_ADDRESS, wei],
    });
  }

  function stake(amount: string) {
    if (chainId !== CHAIN_ID) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    const want = safeParseEtherPositive(amount);
    if (want === null) return;
    if (lpAllowance < want) {
      toast.error('Approve LP token first (Allowance too low)');
      return;
    }
    txAddressRef.current = address;
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'stake',
      args: [want],
    });
  }

  function withdraw(amount: string) {
    const wei = safeParseEtherPositive(amount);
    if (wei === null) return;
    txAddressRef.current = address;
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'withdraw',
      args: [wei],
    });
  }

  function claim() {
    txAddressRef.current = address;
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'getReward',
    });
  }

  function exit() {
    txAddressRef.current = address;
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'exit',
    });
  }

  function emergencyWithdraw() {
    txAddressRef.current = address;
    writeContract({
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'emergencyWithdraw',
    });
  }

  return {
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
    stakedBalance,
    stakedBalanceFormatted: formatEther(stakedBalance),
    pendingReward,
    pendingRewardFormatted: formatEther(pendingReward),
    walletLPBalance,
    walletLPBalanceFormatted: formatEther(walletLPBalance),
    lpAllowance,
    approveLP,
    stake,
    withdraw,
    claim,
    exit,
    emergencyWithdraw,
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
