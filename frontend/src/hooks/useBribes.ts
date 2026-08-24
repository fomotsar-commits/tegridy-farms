import { useAccount, useChainId, useReadContracts, useReadContract, useWriteContract, useWaitForTransactionReceipt, useWatchContractEvent } from 'wagmi';
import { formatEther, type Address, type Hex } from 'viem';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { VOTE_INCENTIVES_ABI, ERC20_ABI } from '../lib/contracts';
import { VOTE_INCENTIVES_ADDRESS, TOWELI_WETH_LP_ADDRESS, TOWELI_ADDRESS, CHAIN_ID, isDeployed as checkDeployed } from '../lib/constants';
import { surfaceTxError } from '../lib/txErrors';

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
  const chainId = useChainId();
  const isDeployed = checkDeployed(VOTE_INCENTIVES_ADDRESS);

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { data: receipt, isLoading: isConfirming, isSuccess: isReceiptFetched, isError: isTxError } = useWaitForTransactionReceipt({ chainId: CHAIN_ID, hash });
  // AUDIT (receipt-status, 2026-08-24): wagmi's raw `isSuccess` only means "the
  // receipt was FETCHED" — it latches true for on-chain REVERTED txs too. Only
  // receipt.status === 'success' is a real success; the toasts below key off this.
  const isReverted = isReceiptFetched && !!receipt && receipt.status !== 'success';
  const isSuccess = isReceiptFetched && !isReverted;
  // 2026-07-26: an approval is a prerequisite, not the deposit. Track when the
  // in-flight tx is an approve so the toast says "approved — now confirm your
  // deposit" instead of a generic "confirmed". Reset to 'action' in both toast
  // terminal paths so a stale 'approve' can't mislabel a later deposit/vote/claim.
  const lastActionRef = useRef<'approve' | 'action'>('action');

  // Global stats + whitelist addresses + pending-fee + bond size + min-bribe floor.
  const { data: globalData, refetch } = useReadContracts({
    contracts: [
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'epochCount', chainId: CHAIN_ID },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'currentEpoch', chainId: CHAIN_ID },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'bribeFeeBps', chainId: CHAIN_ID },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'getWhitelistedTokens', chainId: CHAIN_ID },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'pendingFeeBps', chainId: CHAIN_ID },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'feeChangeTime', chainId: CHAIN_ID },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'commitRevealEnabled', chainId: CHAIN_ID },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'COMMIT_BOND', chainId: CHAIN_ID },
      { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'MIN_BRIBE_AMOUNT', chainId: CHAIN_ID },
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
        { address: t, abi: ERC20_ABI, functionName: 'symbol' as const, chainId: CHAIN_ID },
        { address: t, abi: ERC20_ABI, functionName: 'decimals' as const, chainId: CHAIN_ID },
        { address: t, abi: ERC20_ABI, functionName: 'balanceOf' as const, args: [userAddr] as const, chainId: CHAIN_ID },
        { address: t, abi: ERC20_ABI, functionName: 'allowance' as const, args: [userAddr, VOTE_INCENTIVES_ADDRESS] as const, chainId: CHAIN_ID },
        { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'minBribeAmounts' as const, args: [t] as const, chainId: CHAIN_ID },
        { address: VOTE_INCENTIVES_ADDRESS, abi: VOTE_INCENTIVES_ABI, functionName: 'pendingTokenWithdrawals' as const, args: [userAddr, t] as const, chainId: CHAIN_ID },
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
    chainId: CHAIN_ID,
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
    chainId: CHAIN_ID,
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
    chainId: CHAIN_ID,
    query: { enabled: !!address && isDeployed, refetchInterval: 30_000 },
  });

  // ─── Actions ──────────────────────────────────────────────────────
  function claimBribes(epoch: number, pair: string) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'claimBribes',
      args: [BigInt(epoch), pair as Address],
    });
  }

  function claimBribesBatch(epochStart: number, epochEnd: number, pair: string) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'claimBribesBatch',
      args: [BigInt(epochStart), BigInt(epochEnd), pair as Address],
    });
  }

  function advanceEpoch() {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'advanceEpoch',
    });
  }

  function vote(epoch: number, pair: string, power: bigint) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'vote',
      args: [BigInt(epoch), pair as Address, power],
    });
  }

  function commitVote(epoch: number, commitHash: Hex, power: bigint) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    // De-drift 2026-05-31: contract commitVote now takes (epoch, commitHash, power);
    // power = the committed voting weight, capped at the snapshot power on-chain.
    writeContract({
      chainId: CHAIN_ID,
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'commitVote',
      args: [BigInt(epoch), commitHash, power],
    });
  }

  function revealVote(epoch: number, commitIndex: number, pair: string, power: bigint, salt: Hex) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'revealVote',
      args: [BigInt(epoch), BigInt(commitIndex), pair as Address, power, salt],
    });
  }

  function depositBribeETH(pair: string, value: bigint) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'depositBribeETH',
      args: [pair as Address],
      value,
    });
  }

  function depositBribe(pair: string, token: string, amount: bigint) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
      address: VOTE_INCENTIVES_ADDRESS,
      abi: VOTE_INCENTIVES_ABI,
      functionName: 'depositBribe',
      args: [pair as Address, token as Address, amount],
    });
  }

  function approveToken(token: string, amount: bigint) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    lastActionRef.current = 'approve';
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
      address: token as Address,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [VOTE_INCENTIVES_ADDRESS, amount],
    });
  }

  function approveToweliForBond(amount: bigint) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    lastActionRef.current = 'approve';
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
      address: TOWELI_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [VOTE_INCENTIVES_ADDRESS, amount],
    });
  }

  function withdrawPendingToken(token: string) {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // AUDIT FIX M-8: pin chainId so wagmi rejects when wallet is on wrong chain.
    writeContract({
      chainId: CHAIN_ID,
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
    chainId: CHAIN_ID,
    onLogs: refetchAll,
    enabled: isDeployed,
  });
  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'BribeDepositedETH',
    chainId: CHAIN_ID,
    onLogs: refetchAll,
    enabled: isDeployed,
  });
  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'BribeClaimed',
    chainId: CHAIN_ID,
    onLogs: refetchAll,
    enabled: isDeployed,
  });
  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'GaugeVoted',
    chainId: CHAIN_ID,
    onLogs: refetchAll,
    enabled: isDeployed,
  });
  useWatchContractEvent({
    address: VOTE_INCENTIVES_ADDRESS,
    abi: VOTE_INCENTIVES_ABI,
    eventName: 'EpochAdvanced',
    chainId: CHAIN_ID,
    onLogs: refetchAll,
    enabled: isDeployed,
  });

  // Toast feedback — defer reset() to next tick so isSuccess is readable by consumers this render
  useEffect(() => {
    if (isSuccess) {
      if (lastActionRef.current === 'approve') {
        toast.success('Token approved — now confirm your deposit', {
          description: 'That was just the approval — confirm the deposit transaction to finish.',
        });
      } else {
        toast.success('Transaction confirmed!');
      }
      lastActionRef.current = 'action';
      refetchAll();
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
    if (isTxError || writeError) {
      // F474: classify a wallet rejection (writeError) as "Cancelled"; keep the
      // generic message for a bare on-chain revert.
      if (writeError) surfaceTxError(writeError, toast, { component: 'useBribes' });
      else toast.error('Transaction failed');
      lastActionRef.current = 'action';
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
  }, [isSuccess, isTxError, writeError, refetchAll, reset]);

  // On-chain revert: the receipt fetch succeeded (so isTxError stays false) but
  // the tx failed — honest error instead of "Transaction confirmed!" (see derivation above).
  useEffect(() => {
    if (isReverted) {
      toast.error('Transaction reverted on-chain', {
        description: 'It was mined but the contract rejected it — no tokens moved and nothing changed.',
      });
      lastActionRef.current = 'action';
      const t = setTimeout(reset, 0);
      return () => clearTimeout(t);
    }
  }, [isReverted, reset]);

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
