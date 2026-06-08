import { useMemo } from 'react';
import { useReadContracts, useChainId } from 'wagmi';
import { formatUnits } from 'viem';
import { ERC20_ABI, UNISWAP_V2_PAIR_ABI } from '../lib/contracts';
import { TEGRIDY_LP_ADDRESS, TOWELI_ADDRESS, CHAIN_ID } from '../lib/constants';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

export interface LpPosition {
  /** True if the wallet holds any of the canonical Tegridy TOWELI/WETH LP. */
  hasPosition: boolean;
  lpBalance: bigint;
  lpBalanceFormatted: string;
  /** % of the pool this position represents. */
  sharePct: number;
  /** Redeemable underlying (pro-rata share of reserves). */
  toweliAmount: number;
  wethAmount: number;
  isLoading: boolean;
}

/**
 * Read a wallet's position in the canonical Tegridy TOWELI/WETH pool: LP balance,
 * pool share, and the underlying TOWELI/WETH it's redeemable for. Surfaces LP holdings
 * that are otherwise invisible (the LP token isn't on wallet token lists). Reads on-chain
 * so it reflects fees compounding into the position over time.
 */
export function useLpPosition(address?: `0x${string}`): LpPosition {
  const chainId = useChainId();
  const onRightChain = chainId === CHAIN_ID;
  const lp = TEGRIDY_LP_ADDRESS as `0x${string}`;

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: lp, abi: ERC20_ABI, functionName: 'balanceOf', args: [address ?? ZERO], chainId: CHAIN_ID },
      { address: lp, abi: ERC20_ABI, functionName: 'totalSupply', chainId: CHAIN_ID },
      { address: lp, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves', chainId: CHAIN_ID },
      { address: lp, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0', chainId: CHAIN_ID },
    ],
    query: { enabled: !!address && onRightChain && lp !== ZERO, refetchInterval: 30_000 },
  });

  return useMemo<LpPosition>(() => {
    const lpBalance = data?.[0]?.status === 'success' ? (data[0].result as bigint) : 0n;
    const totalSupply = data?.[1]?.status === 'success' ? (data[1].result as bigint) : 0n;
    const reserves = data?.[2]?.status === 'success' ? (data[2].result as readonly [bigint, bigint, number]) : undefined;
    const token0 = data?.[3]?.status === 'success' ? (data[3].result as string).toLowerCase() : undefined;

    if (lpBalance === 0n || totalSupply === 0n || !reserves || !token0) {
      return {
        hasPosition: false,
        lpBalance,
        lpBalanceFormatted: formatUnits(lpBalance, 18),
        sharePct: 0,
        toweliAmount: 0,
        wethAmount: 0,
        isLoading,
      };
    }

    const isToken0Toweli = token0 === TOWELI_ADDRESS.toLowerCase();
    const toweliReserve = isToken0Toweli ? reserves[0] : reserves[1];
    const wethReserve = isToken0Toweli ? reserves[1] : reserves[0];
    const myToweliWei = (toweliReserve * lpBalance) / totalSupply;
    const myWethWei = (wethReserve * lpBalance) / totalSupply;
    // 4-dp percentage without floating-point on the bigint division.
    const sharePct = Number((lpBalance * 1_000_000n) / totalSupply) / 10_000;

    return {
      hasPosition: true,
      lpBalance,
      lpBalanceFormatted: formatUnits(lpBalance, 18),
      sharePct,
      toweliAmount: Number(formatUnits(myToweliWei, 18)),
      wethAmount: Number(formatUnits(myWethWei, 18)),
      isLoading,
    };
  }, [data, isLoading]);
}
