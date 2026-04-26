import { useCallback, useState, useRef } from 'react';
import { useReadContracts, useChainId } from 'wagmi';
import { maxUint256 } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI } from '../lib/contracts';
import { WETH_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, TEGRIDY_ROUTER_ADDRESS, CHAIN_ID } from '../lib/constants';
import { type TokenInfo } from '../lib/tokenList';
import type { RouteSource } from './useSwapQuote';

export interface SwapAllowanceResult {
  needsApproval: boolean;
  approve: () => void;
  unlimitedApproval: boolean;
  toggleUnlimitedApproval: (val: boolean) => void;
  refetchAllowance: () => void;
  /** R033 M-02: true while the two-step USDT-style approve is in flight. */
  isApprovingMultiStep: boolean;
  /** Internal: useSwap calls after a successful zero-approve to dispatch the
   *  follow-up target-amount approve. */
  continueMultiStepApprove: () => boolean;
  /** Internal: clear the multi-step state after a writeError so we don't
   *  leave the state machine half-set. */
  resetMultiStepApprove: () => void;
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
  const chainId = useChainId();
  const onRightChain = chainId === CHAIN_ID;

  // R033 M-02: USDT (and other reflection-style tokens) revert on `approve`
  // when existing allowance > 0 AND new amount > 0. Canonical defence is OZ
  // SafeERC20.forceApprove (write 0 first, then write target).
  const [isApprovingMultiStep, setIsApprovingMultiStep] = useState(false);
  const pendingTargetAmountRef = useRef<bigint | null>(null);
  const pendingSpenderRef = useRef<`0x${string}` | null>(null);
  const pendingTokenRef = useRef<`0x${string}` | null>(null);

  // Check both routers in parallel
  const { data: allowanceData, refetch: refetchAllowance } = useReadContracts({
    contracts: [
      {
        address: (fromToken?.address ?? WETH_ADDRESS) as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address!, SWAP_FEE_ROUTER_ADDRESS],
        chainId: CHAIN_ID,
      },
      {
        address: (fromToken?.address ?? WETH_ADDRESS) as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address!, TEGRIDY_ROUTER_ADDRESS],
        chainId: CHAIN_ID,
      },
    ],
    // R042 MED-3: gate reads on chain match — wrong-chain returns 0 garbage
    // and would trigger an approve targeting mainnet addresses on L2.
    query: { enabled: onRightChain && !!address && !!fromToken && !fromToken.isNative },
  });

  const uniAllowance = allowanceData?.[0]?.status === 'success' ? allowanceData[0].result as bigint : 0n;
  const tegridyAllowance = allowanceData?.[1]?.status === 'success' ? allowanceData[1].result as bigint : 0n;

  // Allowance: target the correct router based on selected route
  const activeAllowance = selectedRoute === 'tegridy' ? tegridyAllowance : uniAllowance;

  const needsApproval = !!fromToken && !fromToken.isNative && parsedAmount > 0n && activeAllowance < parsedAmount;

  const approve = useCallback(() => {
    if (!fromToken || fromToken.isNative) return;
    if (!onRightChain) {
      toast.error('Wrong network — switch to Ethereum mainnet');
      return;
    }
    const approvalAmount = unlimitedApproval ? maxUint256 : parsedAmount;
    // Approve the correct router based on selected route
    const spender = selectedRoute === 'tegridy' ? TEGRIDY_ROUTER_ADDRESS : SWAP_FEE_ROUTER_ADDRESS;
    const tokenAddr = fromToken.address as `0x${string}`;

    // R033 M-02: USDT-style two-step. If allowance is already non-zero AND
    // less than what we need, write 0 first; the receipt-success effect in
    // useSwap will then dispatch the target-amount approve via
    // continueMultiStepApprove() below.
    if (activeAllowance > 0n && activeAllowance < approvalAmount) {
      pendingTargetAmountRef.current = approvalAmount;
      pendingSpenderRef.current = spender;
      pendingTokenRef.current = tokenAddr;
      setIsApprovingMultiStep(true);
      writeContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [spender, 0n],
      });
      return;
    }

    // Fresh-token / already-zero path: write target directly.
    writeContract({
      address: tokenAddr,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, approvalAmount],
    });
  }, [fromToken, parsedAmount, unlimitedApproval, selectedRoute, activeAllowance, onRightChain, writeContract]);

  const continueMultiStepApprove = useCallback((): boolean => {
    const target = pendingTargetAmountRef.current;
    const spender = pendingSpenderRef.current;
    const tokenAddr = pendingTokenRef.current;
    if (target === null || spender === null || tokenAddr === null) {
      // Not in multi-step. No-op so callers can call unconditionally.
      setIsApprovingMultiStep(false);
      return false;
    }
    pendingTargetAmountRef.current = null;
    pendingSpenderRef.current = null;
    pendingTokenRef.current = null;
    // Keep isApprovingMultiStep = true through the second tx.
    writeContract({
      address: tokenAddr,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, target],
    });
    return true;
  }, [writeContract]);

  const resetMultiStepApprove = useCallback(() => {
    pendingTargetAmountRef.current = null;
    pendingSpenderRef.current = null;
    pendingTokenRef.current = null;
    setIsApprovingMultiStep(false);
  }, []);

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
    isApprovingMultiStep,
    continueMultiStepApprove,
    resetMultiStepApprove,
  };
}
