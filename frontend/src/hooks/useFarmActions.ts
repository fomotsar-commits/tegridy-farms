import { useEffect, useRef } from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { formatEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_STAKING_ABI, ERC20_ABI, REVENUE_DISTRIBUTOR_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, CHAIN_ID } from '../lib/constants';
import { trackStake } from '../lib/analytics';
import { getTxUrl } from '../lib/explorer';
import { safeParseEtherPositive } from '../lib/safeParseEther';

export function useFarmActions() {
  const chainId = useChainId();
  const { address } = useAccount();
  const onRightChain = chainId === CHAIN_ID;

  const { data: pendingEthRaw } = useReadContract({
    address: REVENUE_DISTRIBUTOR_ADDRESS,
    abi: REVENUE_DISTRIBUTOR_ABI,
    functionName: 'pendingETH',
    args: address ? [address] : undefined,
    chainId: CHAIN_ID,
    query: { enabled: !!address && onRightChain, refetchInterval: 15_000 },
  });
  const pendingEth = (pendingEthRaw as bigint | undefined) ?? 0n;
  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const pendingStakeRef = useRef<{ amount: string; lockDuration: string } | null>(null);
  // R034 H1: snapshot of the wallet that submitted the current tx so the
  // receipt effect doesn't fire trackStake for a different wallet that
  // reconnected mid-flight.
  const txAddressRef = useRef<`0x${string}` | undefined>(undefined);

  // R034 H1: account-switch reset block — wipe all in-flight refs so a new
  // wallet doesn't inherit the previous wallet's pending state.
  useEffect(() => {
    pendingStakeRef.current = null;
    txAddressRef.current = undefined;
  }, [address]);

  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({
    hash,
  });

  useEffect(() => {
    if (isSuccess && hash) {
      // R034 H1: drop trackStake / toast for a wallet swap that landed
      // between submit and confirm.
      if (txAddressRef.current && txAddressRef.current !== address) {
        pendingStakeRef.current = null;
        txAddressRef.current = undefined;
        return;
      }
      toast.success('Transaction confirmed', {
        id: hash,
        action: {
          label: 'Explorer',
          onClick: () => window.open(getTxUrl(chainId, hash), '_blank'),
        },
      });
      if (pendingStakeRef.current) {
        trackStake(pendingStakeRef.current.amount, Number(pendingStakeRef.current.lockDuration));
        pendingStakeRef.current = null;
      }
      txAddressRef.current = undefined;
    }
  }, [isSuccess, hash, address, chainId]);

  useEffect(() => {
    if (isTxError && hash) {
      toast.error('Transaction failed', { id: `err-${hash}` });
    }
  }, [isTxError, hash]);

  useEffect(() => {
    if (writeError) {
      const msg = (writeError.message ?? 'Unknown error').replace(/https?:\/\/\S+/g, '').slice(0, 120);
      toast.error(msg, { id: 'write-error' });
    }
  }, [writeError]);

  const approve = (amount: string) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // R034 H4: safeParseEtherPositive — silent fail instead of ErrorBoundary nuke.
    const approveAmount = safeParseEtherPositive(amount);
    if (approveAmount === null) return;
    txAddressRef.current = address;
    writeContract({
      address: TOWELI_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [TEGRIDY_STAKING_ADDRESS, approveAmount],
    });
  };

  const stake = (amount: string, lockDurationSeconds: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    const wei = safeParseEtherPositive(amount);
    if (wei === null) throw new Error('Invalid amount');
    pendingStakeRef.current = { amount, lockDuration: lockDurationSeconds.toString() };
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'stake',
      args: [wei, lockDurationSeconds],
    });
  };

  const pendingEthGuard = (force: boolean): boolean => {
    if (force) return true;
    if (pendingEth > 0n) {
      toast.error(
        `You have ${Number(formatEther(pendingEth)).toFixed(6)} ETH unclaimed. ` +
        `Claim ETH revenue first — withdrawing now forfeits it.`,
        { duration: 8000 }
      );
      return false;
    }
    return true;
  };

  const withdraw = (tokenId: bigint, force: boolean = false) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!pendingEthGuard(force)) return;
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'withdraw',
      args: [tokenId],
    });
  };

  const earlyWithdraw = (tokenId: bigint, force: boolean = false) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!pendingEthGuard(force)) return;
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'earlyWithdraw',
      args: [tokenId],
    });
  };

  const claim = (tokenId: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'getReward',
      args: [tokenId],
    });
  };

  const toggleAutoMaxLock = (tokenId: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'toggleAutoMaxLock',
      args: [tokenId],
    });
  };

  const extendLock = (tokenId: bigint, newDuration: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'extendLock',
      args: [tokenId, newDuration],
    });
  };

  const emergencyExit = (tokenId: bigint, force: boolean = false) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!pendingEthGuard(force)) return;
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'emergencyExitPosition',
      args: [tokenId],
    });
  };

  const claimUnsettled = () => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'claimUnsettled',
    });
  };

  const revalidateBoost = (tokenId: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    txAddressRef.current = address;
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'revalidateBoost',
      args: [tokenId],
    });
  };

  return {
    approve,
    stake,
    withdraw,
    earlyWithdraw,
    claim,
    toggleAutoMaxLock,
    extendLock,
    emergencyExit,
    claimUnsettled,
    revalidateBoost,
    pendingEth,
    isPending,
    isConfirming,
    isSuccess,
    isTxError,
    writeError,
    hash,
    reset,
  };
}
