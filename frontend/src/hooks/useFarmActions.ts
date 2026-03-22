import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseEther } from 'viem';
import { TEGRIDY_FARM_ABI, ERC20_ABI } from '../lib/contracts';
import { TEGRIDY_FARM_ADDRESS, TOWELI_ADDRESS, TOWELI_WETH_LP_ADDRESS } from '../lib/constants';

// Only allow approvals for known pool tokens
const ALLOWED_TOKENS: readonly string[] = [TOWELI_ADDRESS, TOWELI_WETH_LP_ADDRESS];

export function useFarmActions() {
  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();

  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({
    hash,
  });

  const approve = (tokenAddress: `0x${string}`, amount?: string) => {
    // Validate token is in allowlist to prevent approving arbitrary tokens
    if (!ALLOWED_TOKENS.includes(tokenAddress.toLowerCase())) {
      throw new Error(`Token ${tokenAddress} is not an allowed pool token`);
    }
    // If amount provided, approve that exact amount; otherwise approve 1T as bounded fallback
    const approveAmount = amount ? parseEther(amount) : parseEther('1000000000000');
    writeContract({
      address: tokenAddress,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [TEGRIDY_FARM_ADDRESS, approveAmount],
    });
  };

  const deposit = (pid: bigint, amount: string, lockTier: bigint = 0n) => {
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) throw new Error('Invalid deposit amount');
    writeContract({
      address: TEGRIDY_FARM_ADDRESS,
      abi: TEGRIDY_FARM_ABI,
      functionName: 'deposit',
      args: [pid, parseEther(amount), lockTier],
    });
  };

  const withdraw = (pid: bigint, amount: string) => {
    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) throw new Error('Invalid withdraw amount');
    writeContract({
      address: TEGRIDY_FARM_ADDRESS,
      abi: TEGRIDY_FARM_ABI,
      functionName: 'withdraw',
      args: [pid, parseEther(amount)],
    });
  };

  const claim = (pid: bigint) => {
    writeContract({
      address: TEGRIDY_FARM_ADDRESS,
      abi: TEGRIDY_FARM_ABI,
      functionName: 'claim',
      args: [pid],
    });
  };

  const emergencyWithdraw = (pid: bigint) => {
    writeContract({
      address: TEGRIDY_FARM_ADDRESS,
      abi: TEGRIDY_FARM_ABI,
      functionName: 'emergencyWithdraw',
      args: [pid],
    });
  };

  return {
    approve,
    deposit,
    withdraw,
    claim,
    emergencyWithdraw,
    isPending,
    isConfirming,
    isSuccess,
    isTxError,
    writeError,
    hash,
    reset,
  };
}
