import { useEffect } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_STAKING_ABI, ERC20_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS } from '../lib/constants';

export function useFarmActions() {
  // Audit #51: wagmi's useWriteContract internally runs simulateContract before
  // sending the transaction, providing automatic pre-flight revert detection.
  // No separate useSimulateContract call is needed.
  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();

  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({
    hash,
  });

  // Toast on success — must be in useEffect, not during render (#29 audit fix)
  useEffect(() => {
    if (isSuccess && hash) {
      toast.success('Transaction confirmed', {
        id: hash,
        action: {
          label: 'Etherscan',
          onClick: () => window.open(`https://etherscan.io/tx/${hash}`, '_blank'),
        },
      });
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
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) throw new Error('Invalid amount');
    // TOWELI uses 18 decimals; if token decimals change, use parseUnits(amount, decimals) instead
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'stake',
      args: [parseEther(amount), lockDurationSeconds],
    });
  };

  const withdraw = (tokenId: bigint) => {
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'withdraw',
      args: [tokenId],
    });
  };

  const earlyWithdraw = (tokenId: bigint) => {
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'earlyWithdraw',
      args: [tokenId],
    });
  };

  const claim = (tokenId: bigint) => {
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'getReward',
      args: [tokenId],
    });
  };

  const toggleAutoMaxLock = (tokenId: bigint) => {
    writeContract({
      address: TEGRIDY_STAKING_ADDRESS,
      abi: TEGRIDY_STAKING_ABI,
      functionName: 'toggleAutoMaxLock',
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
    isPending,
    isConfirming,
    isSuccess,
    isTxError,
    writeError,
    hash,
    reset,
  };
}
