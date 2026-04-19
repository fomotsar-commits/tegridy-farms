import { useAccount, useReadContracts, useReadContract, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { formatEther, type Address } from 'viem';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { VOTE_INCENTIVES_ABI, ERC20_ABI } from '../lib/contracts';
import { VOTE_INCENTIVES_ADDRESS, TOWELI_WETH_LP_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

export interface WhitelistedToken {
  address: Address;
  symbol: string;
  decimals: number;
  balance: bigint;
  allowance: bigint;
}

export function useBribes() {
  const { address } = useAccount();
  const isDeployed = checkDeployed(VOTE_INCENTIVES_ADDRESS);

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // Global stats + whitelist addresses
  const { data: globalData, refetch } = useReadContracts({
    contracts: [
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'epochCount' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'currentEpoch' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'bribeFeeBps' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'getWhitelistedTokens' },
    ],
    query: { enabled: isDeployed, refetchInterval: 60_000 },
  });

  const epochCount = globalData?.[0]?.status === 'success' ? Number(globalData[0].result as bigint) : 0;
  const currentEpoch = globalData?.[1]?.status === 'success' ? Number(globalData[1].result as bigint) : 0;
  const bribeFeeBps = globalData?.[2]?.status === 'success' ? Number(globalData[2].result as bigint) : 300;
  const whitelistAddrs = globalData?.[3]?.status === 'success' ? (globalData[3].result as Address[]) : [];

  // Per-token metadata + user balance/allowance. 4 reads each (symbol, decimals,
  // balanceOf, allowance). All batched via multicall.
  const userAddr = address ?? ('0x0000000000000000000000000000000000000000' as Address);
  const whitelistReads = useMemo(
    () =>
      whitelistAddrs.flatMap((t) => [
        { address: t, abi: ERC20_ABI, functionName: 'symbol' as const },
        { address: t, abi: ERC20_ABI, functionName: 'decimals' as const },
        { address: t, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [userAddr] as const },
        { address: t, abi: ERC20_ABI, functionName: 'allowance' as const, args: [userAddr, VOTE_INCENTIVES_ADDRESS] as const },
      ]),
    [whitelistAddrs, userAddr],
  );

  const { data: whitelistData, refetch: refetchWhitelist } = useReadContracts({
    contracts: whitelistReads,
    query: { enabled: whitelistAddrs.length > 0, refetchInterval: 60_000 },
  });

  const whitelistedTokens = useMemo<WhitelistedToken[]>(
    () =>
      whitelistAddrs.map((addr, i) => {
        const base = i * 4;
        const symbol = whitelistData?.[base]?.status === 'success' ? (whitelistData[base]!.result as string) : '';
        const decimals = whitelistData?.[base + 1]?.status === 'success' ? Number(whitelistData[base + 1]!.result as number) : 18;
        const balance = whitelistData?.[base + 2]?.status === 'success' ? (whitelistData[base + 2]!.result as bigint) : 0n;
        const allowance = whitelistData?.[base + 3]?.status === 'success' ? (whitelistData[base + 3]!.result as bigint) : 0n;
        return { address: addr, symbol, decimals, balance, allowance };
      }),
    [whitelistAddrs, whitelistData],
  );

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

  // Legacy single-pair claimable read — kept for back-compat. New code should
  // query claimables per pair directly using `useReadContracts`.
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
      args: [BigInt(epoch), pair as Address],
    });
  }

  function claimBribesBatch(epochStart: number, epochEnd: number, pair: string) {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'claimBribesBatch',
      args: [BigInt(epochStart), BigInt(epochEnd), pair as Address],
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
      args: [pair as Address],
      value,
    });
  }

  function depositBribe(pair: string, token: string, amount: bigint) {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'depositBribe',
      args: [pair as Address, token as Address, amount],
    });
  }

  function approveToken(token: string, amount: bigint) {
    writeContract({
      address: token as Address,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [VOTE_INCENTIVES_ADDRESS, amount],
    });
  }

  // Toast feedback — defer reset() to next tick so isSuccess is readable by consumers this render
  useEffect(() => {
    if (isSuccess) {
      toast.success('Transaction confirmed!');
      refetch();
      refetchWhitelist();
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
    if (isTxError || writeError) {
      toast.error('Transaction failed');
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
  }, [isSuccess, isTxError, writeError, refetch, refetchWhitelist, reset]);

  return {
    isDeployed,
    epochCount,
    currentEpoch,
    bribeFeeBps,
    latestEpoch,
    whitelistedTokens,
    claimableTokens,
    // Actions
    claimBribes,
    claimBribesBatch,
    advanceEpoch,
    depositBribeETH,
    depositBribe,
    approveToken,
    // TX state
    isPending,
    isConfirming,
    isSuccess,
    hash,
    cooldownRemaining,
    refetch,
    refetchWhitelist,
  };
}
