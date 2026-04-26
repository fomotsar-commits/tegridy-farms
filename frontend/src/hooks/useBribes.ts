import { useAccount, useReadContracts, useReadContract, useWriteContract, useWaitForTransactionReceipt, useWatchContractEvent } from 'wagmi';
import { formatEther, type Address, type Hex } from 'viem';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { VOTE_INCENTIVES_ABI, ERC20_ABI } from '../lib/contracts';
import { VOTE_INCENTIVES_ADDRESS, TOWELI_WETH_LP_ADDRESS, TOWELI_ADDRESS, isDeployed as checkDeployed } from '../lib/constants';

export interface WhitelistedToken {
  address: Address;
  symbol: string;
  decimals: number;
  balance: bigint;
  allowance: bigint;
  /** Per-token spam floor set by governance (H-7 fix). Falls back to the
   *  global MIN_BRIBE_AMOUNT when unset for a token. */
  minBribe: bigint;
  /** ERC20 amount stuck in pendingTokenWithdrawals for the connected user. */
  pendingWithdrawal: bigint;
}

export function useBribes() {
  const { address } = useAccount();
  const isDeployed = checkDeployed(VOTE_INCENTIVES_ADDRESS);

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // Global stats + whitelist addresses + pending-fee + bond size + min-bribe floor.
  const { data: globalData, refetch } = useReadContracts({
    contracts: [
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'epochCount' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'currentEpoch' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'bribeFeeBps' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'getWhitelistedTokens' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'pendingFeeBps' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'feeChangeTime' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'commitRevealEnabled' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'COMMIT_BOND' },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'MIN_BRIBE_AMOUNT' },
    ],
    query: { enabled: isDeployed, refetchInterval: 60_000 },
  });

  const epochCount = globalData?.[0]?.status === 'success' ? Number(globalData[0].result as bigint) : 0;
  const currentEpoch = globalData?.[1]?.status === 'success' ? Number(globalData[1].result as bigint) : 0;
  const bribeFeeBps = globalData?.[2]?.status === 'success' ? Number(globalData[2].result as bigint) : 300;
  const whitelistAddrs = globalData?.[3]?.status === 'success' ? (globalData[3].result as Address[]) : [];
  const pendingFeeBps = globalData?.[4]?.status === 'success' ? Number(globalData[4].result as bigint) : 0;
  const feeChangeTime = globalData?.[5]?.status === 'success' ? Number(globalData[5].result as bigint) : 0;
  const commitRevealEnabled = globalData?.[6]?.status === 'success' ? Boolean(globalData[6].result) : false;
  const commitBond = globalData?.[7]?.status === 'success' ? (globalData[7].result as bigint) : 10n * 10n ** 18n;
  const minBribeGlobal = globalData?.[8]?.status === 'success' ? (globalData[8].result as bigint) : 10n ** 15n;

  // Per-token reads. 6 reads each: symbol, decimals, balanceOf, allowance,
  // minBribeAmounts, pendingTokenWithdrawals. All batched via multicall.
  const userAddr = address ?? ('0x0000000000000000000000000000000000000000' as Address);
  const whitelistReads = useMemo(
    () =>
      whitelistAddrs.flatMap((t) => [
        { address: t, abi: ERC20_ABI, functionName: 'symbol' as const },
        { address: t, abi: ERC20_ABI, functionName: 'decimals' as const },
        { address: t, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [userAddr] as const },
        { address: t, abi: ERC20_ABI, functionName: 'allowance' as const, args: [userAddr, VOTE_INCENTIVES_ADDRESS] as const },
        { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'minBribeAmounts' as const, args: [t] as const },
        { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'pendingTokenWithdrawals' as const, args: [userAddr, t] as const },
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
        const base = i * 6;
        const symbol = whitelistData?.[base]?.status === 'success' ? (whitelistData[base]!.result as string) : '';
        const decimals = whitelistData?.[base + 1]?.status === 'success' ? Number(whitelistData[base + 1]!.result as number) : 18;
        const balance = whitelistData?.[base + 2]?.status === 'success' ? (whitelistData[base + 2]!.result as bigint) : 0n;
        const allowance = whitelistData?.[base + 3]?.status === 'success' ? (whitelistData[base + 3]!.result as bigint) : 0n;
        const perTokenMin = whitelistData?.[base + 4]?.status === 'success' ? (whitelistData[base + 4]!.result as bigint) : 0n;
        const pendingWithdrawal = whitelistData?.[base + 5]?.status === 'success' ? (whitelistData[base + 5]!.result as bigint) : 0n;
        const minBribe = perTokenMin > 0n ? perTokenMin : minBribeGlobal;
        return { address: addr, symbol, decimals, balance, allowance, minBribe, pendingWithdrawal };
      }),
    [whitelistAddrs, whitelistData, minBribeGlobal],
  );

  // Most recent epoch info — 3-tuple now (totalPower, timestamp, usesCommitReveal).
  const { data: latestEpochData } = useReadContract({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    functionName: 'epochs',
    args: [BigInt(Math.max(0, epochCount - 1))],
    query: { enabled: isDeployed && epochCount > 0 },
  });

  const latestEpoch = latestEpochData
    ? {
        totalPower: (latestEpochData as readonly [bigint, bigint, boolean])[0],
        timestamp: Number((latestEpochData as readonly [bigint, bigint, boolean])[1]),
        usesCommitReveal: Boolean((latestEpochData as readonly [bigint, bigint, boolean])[2]),
      }
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

  // Legacy single-pair claimable read — kept for back-compat with the test
  // suite and any external consumer. The new UI batches per-pair claimables
  // directly in the section.
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

  // User's TOWELI allowance toward the bribe contract — gate for commitVote
  // which requires the contract to pull the bond up-front.
  const { data: toweliAllowance, refetch: refetchToweli } = useReadContract({
    address: TOWELI_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: address ? [address, VOTE_INCENTIVES_ADDRESS] : undefined,
    query: { enabled: !!address && isDeployed, refetchInterval: 30_000 },
  });

  // ─── Actions ──────────────────────────────────────────────────────
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

  function vote(epoch: number, pair: string, power: bigint) {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'vote',
      args: [BigInt(epoch), pair as Address, power],
    });
  }

  function commitVote(epoch: number, commitHash: Hex) {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'commitVote',
      args: [BigInt(epoch), commitHash],
    });
  }

  function revealVote(epoch: number, commitIndex: number, pair: string, power: bigint, salt: Hex) {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'revealVote',
      args: [BigInt(epoch), BigInt(commitIndex), pair as Address, power, salt],
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

  function approveToweliForBond(amount: bigint) {
    writeContract({
      address: TOWELI_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [VOTE_INCENTIVES_ADDRESS, amount],
    });
  }

  function withdrawPendingToken(token: string) {
    writeContract({
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'withdrawPendingToken',
      args: [token as Address],
    });
  }

  // R075: claimable / pendingTokenWithdrawals refresh on every bribe-side
  // event from any user. Without this the panel could lag chain state for
  // up to 60s after a peer's deposit / claim / vote.
  const refetchAll = useCallback(() => {
    refetch();
    refetchWhitelist();
    refetchToweli();
  }, [refetch, refetchWhitelist, refetchToweli]);

  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'BribeDeposited',
    onLogs: refetchAll,
    enabled: isDeployed,
  });
  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'BribeDepositedETH',
    onLogs: refetchAll,
    enabled: isDeployed,
  });
  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'BribeClaimed',
    onLogs: refetchAll,
    enabled: isDeployed,
  });
  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'GaugeVoted',
    onLogs: refetchAll,
    enabled: isDeployed,
  });
  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'EpochAdvanced',
    onLogs: refetchAll,
    enabled: isDeployed,
  });

  // Toast feedback — defer reset() to next tick so isSuccess is readable by consumers this render
  useEffect(() => {
    if (isSuccess) {
      toast.success('Transaction confirmed!');
      refetchAll();
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
    if (isTxError || writeError) {
      toast.error('Transaction failed');
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
  }, [isSuccess, isTxError, writeError, refetchAll, reset]);

  return {
    isDeployed,
    epochCount,
    currentEpoch,
    bribeFeeBps,
    pendingFeeBps,
    feeChangeTime,
    commitRevealEnabled,
    commitBond,
    minBribeGlobal,
    latestEpoch,
    whitelistedTokens,
    claimableTokens,
    toweliAllowance: (toweliAllowance as bigint | undefined) ?? 0n,
    // Actions
    claimBribes,
    claimBribesBatch,
    advanceEpoch,
    vote,
    commitVote,
    revealVote,
    depositBribeETH,
    depositBribe,
    approveToken,
    approveToweliForBond,
    withdrawPendingToken,
    // TX state
    isPending,
    isConfirming,
    isSuccess,
    hash,
    cooldownRemaining,
    refetch,
    refetchWhitelist,
    refetchToweli,
  };
}
