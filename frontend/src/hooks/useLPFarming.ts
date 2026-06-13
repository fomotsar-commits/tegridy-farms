import { useEffect, useMemo, useRef } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContracts, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { LP_FARMING_ABI, ERC20_ABI } from '../lib/contracts';
import { LP_FARMING_ADDRESS, TEGRIDY_LP_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
import { getTxUrl } from '../lib/explorer';
import { safeParseEtherPositive } from '../lib/safeParseEther';
import { surfaceTxError } from '../lib/txErrors';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

export function useLPFarming() {
  const { address } = useAccount();
  const chainId = useChainId();
  const userAddr = address ?? ZERO_ADDR;
  const isDeployed = checkDeployed(LP_FARMING_ADDRESS);
  const onMainnet = chainId === CHAIN_ID;

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  // AUDIT FIX FE-LOW-04: pin receipt resolution to CHAIN_ID. Without `chainId`,
  // the underlying viem call listens on the wallet's CURRENT chain — if the user
  // switched mid-flight (or clicked "switch network" right after submitting),
  // confirmation listens on the wrong chain and silently never fires.
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash, chainId: CHAIN_ID });

  // R034 H2: address-snapshot + last-handled-hash refs to drop receipt-effect
  // for a wallet that swapped between submit and confirm.
  const txAddressRef = useRef<`0x${string}` | undefined>(undefined);
  const lastHandledHashRef = useRef<`0x${string}` | undefined>(undefined);
  // F105 (T5): track which write is in flight so the section can clear the typed
  // amount only after stake/withdraw — not after an approve (where the user still
  // wants to stake next).
  const lastActionRef = useRef<'approve' | 'stake' | 'withdraw' | 'claim' | 'exit' | 'emergencyWithdraw' | 'refreshBoost' | null>(null);

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
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'totalRawSupply', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rewardRate', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'periodFinish', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rewardsDuration', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'totalRewardsFunded', chainId: CHAIN_ID },
      // User-specific
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'rawBalanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'earned', args: [userAddr], chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, LP_FARMING_ADDRESS], chainId: CHAIN_ID },
      { address: TEGRIDY_LP_ADDRESS, abi: ERC20_ABI, functionName: 'totalSupply', chainId: CHAIN_ID },
      { address: LP_FARMING_ADDRESS, abi: LP_FARMING_ABI, functionName: 'MIN_STAKE', chainId: CHAIN_ID },
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
  const minStake = data?.[10]?.status === 'success' ? data[10].result as bigint : 0n;

  const isActive = periodFinish > Math.floor(Date.now() / 1000);

  // F100: the raw Synthetix-style `rewardRate` storage value stays non-zero
  // after `periodFinish`, but the contract's earned() stops accruing then.
  // Zero the per-day/per-year figures once the period has lapsed so the UI
  // never advertises a live APR/reward-rate on a dead emission schedule.
  const rewardRatePerDay = useMemo(() => {
    if (rewardRate === 0n || !isActive) return 0;
    return parseFloat(formatEther(rewardRate)) * 86400;
  }, [rewardRate, isActive]);

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
    // F102 (T5): a single targeted refetch on confirmation, gated once-per-hash by
    // the lastHandledHashRef guard above. The 60s poll is the *background* refresh;
    // relying on it alone leaves the approve CTA, balances, and pending rewards
    // stale for up to a minute after a confirmed write. One read is not a poll storm.
    refetch();
    setTimeout(() => reset(), 4000);
  }, [isSuccess, hash, address, chainId, reset, refetch]);

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
      // F474: soft "Cancelled" for wallet rejections; classified message otherwise.
      surfaceTxError(writeError, toast, { component: 'useLPFarming' });
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
    lastActionRef.current = 'approve';
    writeContract({
      chainId: CHAIN_ID,
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
    lastActionRef.current = 'stake';
    writeContract({
      chainId: CHAIN_ID,
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'stake',
      args: [want],
    });
  }

  function withdraw(amount: string) {
    if (chainId !== CHAIN_ID) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    const wei = safeParseEtherPositive(amount);
    if (wei === null) return;
    txAddressRef.current = address;
    lastActionRef.current = 'withdraw';
    writeContract({
      chainId: CHAIN_ID,
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'withdraw',
      args: [wei],
    });
  }

  function claim() {
    if (chainId !== CHAIN_ID) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    txAddressRef.current = address;
    lastActionRef.current = 'claim';
    writeContract({
      chainId: CHAIN_ID,
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'getReward',
    });
  }

  function exit() {
    if (chainId !== CHAIN_ID) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    txAddressRef.current = address;
    lastActionRef.current = 'exit';
    writeContract({
      chainId: CHAIN_ID,
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'exit',
    });
  }

  function emergencyWithdraw() {
    if (chainId !== CHAIN_ID) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    txAddressRef.current = address;
    lastActionRef.current = 'emergencyWithdraw';
    writeContract({
      chainId: CHAIN_ID,
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'emergencyWithdraw',
    });
  }

  /// AUDIT F-7 (post-Batch-J sweep): refresh effective balance against the
  /// caller's current JBAC ownership. Required when a user acquires a JBAC
  /// NFT AFTER staking — without this their boost stays at the pre-acquisition
  /// rate. Permissionless on the contract side; UI exposes the action so users
  /// can trigger it manually, or `useAutoRefreshBoost` can fire it on detection.
  function refreshBoost(target?: `0x${string}`) {
    if (chainId !== CHAIN_ID) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    const acct = (target ?? address) as `0x${string}` | undefined;
    if (!acct) return;
    txAddressRef.current = address;
    lastActionRef.current = 'refreshBoost';
    writeContract({
      chainId: CHAIN_ID,
      address: LP_FARMING_ADDRESS,
      abi: LP_FARMING_ABI,
      functionName: 'refreshBoost',
      args: [acct],
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
    minStake,
    minStakeFormatted: formatEther(minStake),
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
    refreshBoost, // AUDIT F-7
    isDeployed,
    isReadLoading,
    isPending,
    isConfirming,
    isSuccess,
    hash,
    reset,
    refetch,
    // F105: the section reads this in its isSuccess effect to decide whether to
    // clear the typed amount (stake/withdraw) or keep it (approve).
    lastActionRef,
  };
}
