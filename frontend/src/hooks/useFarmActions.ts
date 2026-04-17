import { useEffect, useRef } from 'react';
import { useAccount, useReadContract, useWriteContract, useWaitForTransactionReceipt, useChainId } from 'wagmi';
import { parseEther, formatEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_STAKING_ABI, ERC20_ABI, REVENUE_DISTRIBUTOR_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS, REVENUE_DISTRIBUTOR_ADDRESS, CHAIN_ID } from '../lib/constants';
import { trackStake } from '../lib/analytics';
import { getTxUrl } from '../lib/explorer';

export function useFarmActions() {
  const chainId = useChainId();
  const { address } = useAccount();
  // AUDIT Spartan TF-03: read pendingETH so withdraw paths can block the
  // user from burning their staking NFT with unclaimed revenue still on the
  // distributor — withdrawal sets userTokenId = 0, which collapses
  // _getUserLockState to (0, 0) and makes the grace-period claim check fail
  // forever. The ETH isn't destroyed (sits in totalEarmarked for admin
  // reclaim) but from the user's perspective it's gone.
  const { data: pendingEthRaw } = useReadContract({
    address: REVENUE_DISTRIBUTOR_ADDRESS,
    abi: REVENUE_DISTRIBUTOR_ABI,
    functionName: 'pendingETH',
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 15_000 },
  });
  const pendingEth = (pendingEthRaw as bigint | undefined) ?? 0n;
  // Audit #51: wagmi's useWriteContract internally runs simulateContract before
  // sending the transaction, providing automatic pre-flight revert detection.
  // No separate useSimulateContract call is needed.
  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const pendingStakeRef = useRef<{ amount: string; lockDuration: string } | null>(null);

  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({
    hash,
  });

  // Toast on success — must be in useEffect, not during render (#29 audit fix)
  useEffect(() => {
    if (isSuccess && hash) {
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
    }
  }, [isSuccess, hash]);

  // Toast on tx revert (#29 audit fix)
  useEffect(() => {
    if (isTxError && hash) {
      toast.error('Transaction failed', { id: `err-${hash}` });
    }
  }, [isTxError, hash]);

  // Toast on write error (#29 audit fix)
  useEffect(() => {
    if (writeError) {
      const msg = (writeError.message ?? 'Unknown error').replace(/https?:\/\/\S+/g, '').slice(0, 120);
      toast.error(msg, { id: 'write-error' });
    }
  }, [writeError]);

  const approve = (amount: string) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) return;
    // TOWELI uses 18 decimals; if token decimals change, use parseUnits(amount, decimals) instead
    const approveAmount = parseEther(amount);
    writeContract({
      address: TOWELI_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [TEGRIDY_STAKING_ADDRESS, approveAmount],
    });
  };

  const stake = (amount: string, lockDurationSeconds: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) throw new Error('Invalid amount');
    pendingStakeRef.current = { amount, lockDuration: lockDurationSeconds.toString() };
    // TOWELI uses 18 decimals; if token decimals change, use parseUnits(amount, decimals) instead
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'stake',
      args: [parseEther(amount), lockDurationSeconds],
    });
  };

  /**
   * AUDIT Spartan TF-03: guard returns false and toasts if the user has pending
   * ETH revenue that would be silently forfeited when the staking NFT burns.
   * Callers can pass `force=true` to bypass after an explicit user confirmation.
   */
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
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'earlyWithdraw',
      args: [tokenId],
    });
  };

  const claim = (tokenId: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'getReward',
      args: [tokenId],
    });
  };

  const toggleAutoMaxLock = (tokenId: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'toggleAutoMaxLock',
      args: [tokenId],
    });
  };

  const extendLock = (tokenId: bigint, newDuration: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
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
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'emergencyExitPosition',
      args: [tokenId],
    });
  };

  const claimUnsettled = () => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'claimUnsettled',
    });
  };

  const revalidateBoost = (tokenId: bigint) => {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
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
    // AUDIT Spartan TF-03: exposed so UI can render "claim ETH first" UX
    // proactively rather than relying on the guard-toast on click.
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
