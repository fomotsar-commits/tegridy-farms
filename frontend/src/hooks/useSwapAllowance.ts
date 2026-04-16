import { useCallback, useState } from 'react';
import { useReadContracts } from 'wagmi';
import { maxUint256 } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI } from '../lib/contracts';
import { WETH_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, TEGRIDY_ROUTER_ADDRESS } from '../lib/constants';
import { type TokenInfo } from '../lib/tokenList';
import type { RouteSource } from './useSwapQuote';

export interface SwapAllowanceResult {
  needsApproval: boolean;
  approve: () => void;
  unlimitedApproval: boolean;
  toggleUnlimitedApproval: (val: boolean) => void;
  refetchAllowance: () => void;
}

export function useSwapAllowance(
  fromToken: TokenInfo | null,
  parsedAmount: bigint,
  selectedRoute: RouteSource,
  address: `0x${string}` | undefined,
  writeContract: (args: {
    address: `0x${string}`;
    abi: readonly unknown[];
    functionName: string;
    args: readonly unknown[];
  }) => void,
): SwapAllowanceResult {
  const [unlimitedApproval, setUnlimitedApproval] = useState(false);

  // Check both routers in parallel
  const { data: allowanceData, refetch: refetchAllowance } = useReadContracts({
    contracts: [
      {
        address: (fromToken?.address ?? WETH_ADDRESS) as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address!, SWAP_FEE_ROUTER_ADDRESS],
      },
      {
        address: (fromToken?.address ?? WETH_ADDRESS) as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address!, TEGRIDY_ROUTER_ADDRESS],
      },
    ],
    query: { enabled: !!address && !!fromToken && !fromToken.isNative },
  });

  const uniAllowance = allowanceData?.[0]?.status === 'success' ? allowanceData[0].result as bigint : 0n;
  const tegridyAllowance = allowanceData?.[1]?.status === 'success' ? allowanceData[1].result as bigint : 0n;

  // Allowance: target the correct router based on selected route
  const activeAllowance = selectedRoute === 'tegridy' ? tegridyAllowance : uniAllowance;

  const needsApproval = !!fromToken && !fromToken.isNative && parsedAmount > 0n && activeAllowance < parsedAmount;

  const approve = useCallback(() => {
    if (!fromToken || fromToken.isNative) return;
    const approvalAmount = unlimitedApproval ? maxUint256 : parsedAmount;
    // Approve the correct router based on selected route
    const spender = selectedRoute === 'tegridy' ? TEGRIDY_ROUTER_ADDRESS : SWAP_FEE_ROUTER_ADDRESS;
    writeContract({
      address: fromToken.address as `0x${string}`,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, approvalAmount],
    });
  }, [fromToken, parsedAmount, unlimitedApproval, selectedRoute, writeContract]);

  const toggleUnlimitedApproval = useCallback((val: boolean) => {
    if (val) {
      toast.warning('Unlimited approval enabled', {
        description: 'This approves unlimited tokens to the router contract. If the contract is ever compromised, all approved tokens could be at risk. Use exact approvals for maximum safety.',
        duration: 8000,
      });
    }
    setUnlimitedApproval(val);
  }, []);

  return {
    needsApproval,
    approve,
    unlimitedApproval,
    toggleUnlimitedApproval,
    refetchAllowance,
  };
}
