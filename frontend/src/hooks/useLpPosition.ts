import { useMemo } from 'react';
import { useReadContracts, useChainId } from 'wagmi';
import { formatUnits } from 'viem';
import { ERC20_ABI, UNISWAP_V2_PAIR_ABI, LP_FARMING_ABI } from '../lib/contracts';
import { TEGRIDY_LP_ADDRESS, TOWELI_ADDRESS, LP_FARMING_ADDRESS, CHAIN_ID, isDeployed } from '../lib/constants';

const ZERO = '0x0000000000000000000000000000000000000000' as const;

export interface LpPosition {
  /** True if the wallet holds OR has staked any of the canonical Tegridy TOWELI/WETH LP. */
  hasPosition: boolean;
  /** Total LP (wallet + staked). */
  lpBalance: bigint;
  lpBalanceFormatted: string;
  walletLp: bigint;
  walletLpFormatted: string;
  /** LP currently staked in LP farming (0 until the farm is deployed). */
  stakedLp: bigint;
  stakedLpFormatted: string;
  /** % of the pool the total position represents. */
  sharePct: number;
  /** Redeemable underlying for the TOTAL position (wallet + staked). */
  toweliAmount: number;
  wethAmount: number;
  /** TOWELI rewards pending in LP farming. */
  pendingRewards: number;
  farmingDeployed: boolean;
  isLoading: boolean;
}

/**
 * A wallet's complete position in the canonical Tegridy TOWELI/WETH pool: LP held in the
 * wallet PLUS LP staked in farming, the pool share, the redeemable TOWELI/WETH, and any
 * pending farm rewards. Surfaces LP that's otherwise invisible (the LP token isn't on wallet
 * token lists, and staked LP leaves the wallet entirely). The farming reads are inert until
 * `LP_FARMING_ADDRESS` is set — they fail closed to 0, so this is safe pre-deploy.
 */
export function useLpPosition(address?: `0x${string}`): LpPosition {
  const chainId = useChainId();
  const onRightChain = chainId === CHAIN_ID;
  const lp = TEGRIDY_LP_ADDRESS as `0x${string}`;
  const farm = LP_FARMING_ADDRESS as `0x${string}`;
  const farmingDeployed = isDeployed(LP_FARMING_ADDRESS);

  const { data, isLoading } = useReadContracts({
    contracts: [
      { address: lp, abi: ERC20_ABI, functionName: 'balanceOf', args: [address ?? ZERO], chainId: CHAIN_ID },
      { address: lp, abi: ERC20_ABI, functionName: 'totalSupply', chainId: CHAIN_ID },
      { address: lp, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves', chainId: CHAIN_ID },
      { address: lp, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0', chainId: CHAIN_ID },
      // Farming reads — fail to 0 until the farm is deployed (address is the zero sentinel).
      { address: farm, abi: LP_FARMING_ABI, functionName: 'rawBalanceOf', args: [address ?? ZERO], chainId: CHAIN_ID },
      { address: farm, abi: LP_FARMING_ABI, functionName: 'earned', args: [address ?? ZERO], chainId: CHAIN_ID },
    ],
    query: { enabled: !!address && onRightChain && lp !== ZERO, refetchInterval: 30_000 },
  });

  return useMemo<LpPosition>(() => {
    const walletLp = data?.[0]?.status === 'success' ? (data[0].result as bigint) : 0n;
    const totalSupply = data?.[1]?.status === 'success' ? (data[1].result as bigint) : 0n;
    const reserves = data?.[2]?.status === 'success' ? (data[2].result as readonly [bigint, bigint, number]) : undefined;
    const token0 = data?.[3]?.status === 'success' ? (data[3].result as string).toLowerCase() : undefined;
    const stakedLp = data?.[4]?.status === 'success' ? (data[4].result as bigint) : 0n;
    const earnedWei = data?.[5]?.status === 'success' ? (data[5].result as bigint) : 0n;

    const totalLp = walletLp + stakedLp;
    const pendingRewards = Number(formatUnits(earnedWei, 18));

    const base = {
      walletLp,
      walletLpFormatted: formatUnits(walletLp, 18),
      stakedLp,
      stakedLpFormatted: formatUnits(stakedLp, 18),
      lpBalance: totalLp,
      lpBalanceFormatted: formatUnits(totalLp, 18),
      pendingRewards,
      farmingDeployed,
      isLoading,
    };

    if (totalLp === 0n || totalSupply === 0n || !reserves || !token0) {
      return { ...base, hasPosition: pendingRewards > 0, sharePct: 0, toweliAmount: 0, wethAmount: 0 };
    }

    const isToken0Toweli = token0 === TOWELI_ADDRESS.toLowerCase();
    const toweliReserve = isToken0Toweli ? reserves[0] : reserves[1];
    const wethReserve = isToken0Toweli ? reserves[1] : reserves[0];
    const myToweliWei = (toweliReserve * totalLp) / totalSupply;
    const myWethWei = (wethReserve * totalLp) / totalSupply;
    const sharePct = Number((totalLp * 1_000_000n) / totalSupply) / 10_000;

    return {
      ...base,
      hasPosition: true,
      sharePct,
      toweliAmount: Number(formatUnits(myToweliWei, 18)),
      wethAmount: Number(formatUnits(myWethWei, 18)),
    };
  }, [data, isLoading, farmingDeployed]);
}
