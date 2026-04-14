import { useAccount, useReadContracts, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther } from 'viem';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { VOTE_INCENTIVES_ABI } from '../lib/contracts';
import { VOTE_INCENTIVES_ADDRESS, TOWELI_WETH_LP_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

export function useBribes() {
  const { address } = useAccount();
  const isDeployed = checkDeployed(VOTE_INCENTIVES_ADDRESS);

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // Global stats
  const { data: globalData, refetch } = useReadContracts({
    contracts: [
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'epochCount' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'currentEpoch' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'bribeFeeBps' },
    ],
    query: { enabled: isDeployed, refetchInterval: 60_000 },
  });

  const epochCount = globalData?.[0]?.status === 'success' ? Number(globalData[0].result as bigint) : 0;
  const currentEpoch = globalData?.[1]?.status === 'success' ? Number(globalData[1].result as bigint) : 0;
  const bribeFeeBps = globalData?.[2]?.status === 'success' ? Number(globalData[2].result as bigint) : 300;

  // Get the most recent epoch's info (if any exist)
  const { data: latestEpochData } = useReadContract({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    functionName: 'epochs',
    args: [BigInt(Math.max(0, epochCount - 1))],
    query: { enabled: isDeployed && epochCount > 0 },
  });

  const latestEpoch = latestEpochData
    ? { totalPower: (latestEpochData as [bigint, bigint])[0], timestamp: Number((latestEpochData as [bigint, bigint])[1]) }
    : null;

  // Cooldown tracking for advance epoch (MIN_EPOCH_INTERVAL = 1 hour)
  const MIN_EPOCH_INTERVAL = 3600;
  const [cooldownRemaining, setCooldownRemaining] = useState(0);

  useEffect(() => {
    if (!latestEpoch) { setCooldownRemaining(0); return; }
    const update = () => {
      const elapsed = Math.floor(Date.now() / 1000) - latestEpoch.timestamp;
      setCooldownRemaining(Math.max(0, MIN_EPOCH_INTERVAL - elapsed));
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [latestEpoch?.timestamp]);

  // Check user's claimable bribes for the main TOWELI/WETH pair across recent epochs
  const { data: claimableData } = useReadContract({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    functionName: 'claimable',
    args: [address!, BigInt(Math.max(0, epochCount - 1)), TOWELI_WETH_LP_ADDRESS],
    query: { enabled: isDeployed && !!address && epochCount > 0 },
  });

  const claimableTokens = useMemo(() => {
    if (!claimableData) return [];
    const [tokens, amounts] = claimableData as [string[], bigint[]];
    return tokens.map((token, i) => ({
      token,
      amount: amounts[i],
      formatted: formatEther(amounts[i] ?? 0n),
      isETH: token === '0x0000000000000000000000000000000000000000',
    })).filter(t => (t.amount ?? 0n) > 0n);
  }, [claimableData]);

  // Actions
  function claimBribes(epoch: number, pair: string) {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'claimBribes',
      args: [BigInt(epoch), pair as `0x${string}`],
    });
  }

  function claimBribesBatch(epochStart: number, epochEnd: number, pair: string) {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'claimBribesBatch',
      args: [BigInt(epochStart), BigInt(epochEnd), pair as `0x${string}`],
    });
  }

  function advanceEpoch() {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'advanceEpoch',
    });
  }

  function depositBribeETH(pair: string, value: bigint) {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'depositBribeETH',
      args: [pair as `0x${string}`],
      value,
    });
  }

  // Toast feedback — defer reset() to next tick so isSuccess is readable by consumers this render
  useEffect(() => {
    if (isSuccess) {
      toast.success('Bribe transaction confirmed!');
      refetch();
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
    if (isTxError || writeError) {
      toast.error('Transaction failed');
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
  }, [isSuccess, isTxError, writeError, refetch, reset]);

  return {
    isDeployed,
    epochCount,
    currentEpoch,
    bribeFeeBps,
    latestEpoch,
    claimableTokens,
    // Actions
    claimBribes,
    claimBribesBatch,
    advanceEpoch,
    depositBribeETH,
    // TX state
    isPending,
    isConfirming,
    isSuccess,
    cooldownRemaining,
    refetch,
  };
}
