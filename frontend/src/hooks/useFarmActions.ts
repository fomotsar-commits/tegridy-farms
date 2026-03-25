import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_STAKING_ABI, ERC20_ABI } from '../lib/contracts';
import { TEGRIDY_STAKING_ADDRESS, TOWELI_ADDRESS } from '../lib/constants';

export function useFarmActions() {
  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();

  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({
    hash,
  });

  // Toast on success
  if (isSuccess && hash) {
    toast.success('Transaction confirmed', {
      id: hash,
      action: {
        label: 'Etherscan',
        onClick: () => window.open(`https://etherscan.io/tx/${hash}`, '_blank'),
      },
    });
  }

  const approve = (amount?: string) => {
    const approveAmount = amount ? parseEther(amount) : parseEther('1000000000000');
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
      functionName: 'claim',
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
