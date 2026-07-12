import { encodeFunctionData, type Address } from 'viem';
import { ERC20_ABI, TEGRIDY_STAKING_ABI } from './contracts';
import { TOWELI_ADDRESS, TEGRIDY_STAKING_ADDRESS } from './constants';
import type { WalletCall } from './eip5792';

/**
 * Build the EIP-5792 call batch for a one-click "approve + stake": approve exactly
 * `amountWei` TOWELI to the staking contract, then stake it for `lockDurationSeconds`.
 * Both amounts are known up front (no call-1-output dependency), so this is a clean
 * atomic batch — one wallet confirmation instead of two.
 *
 * Pure + unit-tested. `useOneClickStake` wraps it with capability detection and a
 * fall-back to the existing sequential approve→stake flow.
 */
export function buildApproveStakeCalls(amountWei: bigint, lockDurationSeconds: bigint): WalletCall[] {
  return [
    {
      to: TOWELI_ADDRESS as Address,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [TEGRIDY_STAKING_ADDRESS, amountWei],
      }),
    },
    {
      to: TEGRIDY_STAKING_ADDRESS as Address,
      data: encodeFunctionData({
        abi: TEGRIDY_STAKING_ABI,
        functionName: 'stake',
        args: [amountWei, lockDurationSeconds],
      }),
    },
  ];
}
