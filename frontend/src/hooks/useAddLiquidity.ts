import { useEffect, useMemo } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useReadContracts, useChainId } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_ROUTER_ABI, TEGRIDY_FACTORY_ABI, ERC20_ABI, UNISWAP_V2_PAIR_ABI } from '../lib/contracts';
import { TEGRIDY_ROUTER_ADDRESS, TEGRIDY_FACTORY_ADDRESS, WETH_ADDRESS } from '../lib/constants';
import { type TokenInfo } from '../lib/tokenList';
import { getTxUrl } from '../lib/explorer';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
const PLACEHOLDER_ADDR = '0x0000000000000000000000000000000000000001' as const;

export function useAddLiquidity(tokenA: TokenInfo | null, tokenB: TokenInfo | null) {
  const { address } = useAccount();
  const chainId = useChainId();
  const userAddr = address ?? PLACEHOLDER_ADDR;

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // Resolve addresses (substitute WETH for native ETH)
  const addrA = useMemo(() => {
    if (!tokenA) return ZERO_ADDR;
    return (tokenA.isNative ? WETH_ADDRESS : tokenA.address) as `0x${string}`;
  }, [tokenA]);

  const addrB = useMemo(() => {
    if (!tokenB) return ZERO_ADDR;
    return (tokenB.isNative ? WETH_ADDRESS : tokenB.address) as `0x${string}`;
  }, [tokenB]);

  const decimalsA = tokenA?.decimals ?? 18;
  const decimalsB = tokenB?.decimals ?? 18;
  const involvesETH = !!tokenA?.isNative || !!tokenB?.isNative;

  // Which token is the ERC20 and which is ETH (for ETH-pair calls)
  const ethSide: 'A' | 'B' | null = tokenA?.isNative ? 'A' : tokenB?.isNative ? 'B' : null;

  // Get pair address from Tegridy Factory
  const tokensSelected = !!tokenA && !!tokenB && addrA.toLowerCase() !== addrB.toLowerCase();

  const { data: pairAddress, refetch: refetchPair } = useReadContract({
    address: TEGRIDY_FACTORY_ADDRESS,
    abi: TEGRIDY_FACTORY_ABI,
    functionName: 'getPair',
    args: [addrA, addrB],
    query: { enabled: tokensSelected },
  });

  const pairExists = !!pairAddress && pairAddress !== ZERO_ADDR;
  const pairAddr = pairExists ? pairAddress as `0x${string}` : PLACEHOLDER_ADDR;

  // Fetch pair reserves + token0 + LP info + user balances + allowances
  const { data, refetch, isLoading: isLoadingPool } = useReadContracts({
    contracts: [
      // Pair info
      { address: pairAddr, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves' },
      { address: pairAddr, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0' },
      { address: pairAddr, abi: UNISWAP_V2_PAIR_ABI, functionName: 'totalSupply' },
      // LP balance + allowance
      { address: pairAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr] },
      { address: pairAddr, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, TEGRIDY_ROUTER_ADDRESS] },
      // Token A balance + allowance (only for ERC20, not native ETH)
      { address: addrA, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr] },
      { address: addrA, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, TEGRIDY_ROUTER_ADDRESS] },
      // Token B balance + allowance (only for ERC20, not native ETH)
      { address: addrB, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr] },
      { address: addrB, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, TEGRIDY_ROUTER_ADDRESS] },
    ],
    query: { enabled: !!address, refetchInterval: 30_000, refetchOnWindowFocus: true },
  });

  const reserves = data?.[0]?.status === 'success' ? data[0].result as readonly [bigint, bigint, number] : undefined;
  const token0 = data?.[1]?.status === 'success' ? (data[1].result as string).toLowerCase() : undefined;
  const lpTotalSupply = data?.[2]?.status === 'success' ? data[2].result as bigint : 0n;
  const lpBalance = data?.[3]?.status === 'success' ? data[3].result as bigint : 0n;
  const lpAllowance = data?.[4]?.status === 'success' ? data[4].result as bigint : 0n;
  const tokenABalance = data?.[5]?.status === 'success' ? data[5].result as bigint : 0n;
  const tokenAAllowance = data?.[6]?.status === 'success' ? data[6].result as bigint : 0n;
  const tokenBBalance = data?.[7]?.status === 'success' ? data[7].result as bigint : 0n;
  const tokenBAllowance = data?.[8]?.status === 'success' ? data[8].result as bigint : 0n;

  // Determine which reserve is tokenA and which is tokenB
  const isToken0A = token0 === addrA.toLowerCase();
  const reserveA = reserves ? (isToken0A ? reserves[0] : reserves[1]) : 0n;
  const reserveB = reserves ? (isToken0A ? reserves[1] : reserves[0]) : 0n;

  const isEmptyPool = !pairExists || (reserveA === 0n && reserveB === 0n);

  // Calculate price ratio (B per A)
  const priceRatio = useMemo(() => {
    if (reserveA === 0n || reserveB === 0n) return 0;
    return Number(formatUnits(reserveB, decimalsB)) / Number(formatUnits(reserveA, decimalsA));
  }, [reserveA, reserveB, decimalsA, decimalsB]);

  // Calculate optimal paired amounts
  function getAmountB(amountA: string): string {
    if (!amountA || reserveA === 0n || reserveB === 0n) return '';
    try {
      const amt = parseUnits(amountA, decimalsA);
      const bNeeded = (amt * reserveB) / reserveA;
      return formatUnits(bNeeded, decimalsB);
    } catch {
      // Pair contract may not exist yet — return empty to show "enter amount" state
      return '';
    }
  }

  function getAmountA(amountB: string): string {
    if (!amountB || reserveA === 0n || reserveB === 0n) return '';
    try {
      const amt = parseUnits(amountB, decimalsB);
      const aNeeded = (amt * reserveA) / reserveB;
      return formatUnits(aNeeded, decimalsA);
    } catch {
      // Pair contract may not exist yet — return empty to show "enter amount" state
      return '';
    }
  }

  // Calculate pool share
  function getPoolShare(amountA: string): number {
    if (!amountA) return 0;
    // First LP to an empty pool owns 100%
    if (lpTotalSupply === 0n || reserveA === 0n) {
      try {
        const amt = parseUnits(amountA, decimalsA);
        return amt > 0n ? 100 : 0;
      } catch { return 0; }
    }
    try {
      const amt = parseUnits(amountA, decimalsA);
      const newLp = (amt * lpTotalSupply) / reserveA;
      return Number(newLp * 10000n / (lpTotalSupply + newLp)) / 100;
    } catch { return 0; }
  }

  // Toasts
  useEffect(() => {
    if (isSuccess && hash) {
      toast.success('Liquidity operation confirmed!', {
        id: hash,
        action: { label: 'Explorer', onClick: () => window.open(getTxUrl(chainId, hash), '_blank') },
      });
      refetch();
      setTimeout(() => reset(), 4000);
    }
  }, [isSuccess, hash]);

  useEffect(() => {
    if (isTxError && hash) {
      toast.error('Transaction failed', { id: `err-${hash}` });
      setTimeout(() => reset(), 4000);
    }
  }, [isTxError, hash]);

  useEffect(() => {
    if (writeError) {
      toast.error(writeError.message?.slice(0, 120) ?? 'Unknown error', { id: 'write-error' });
      setTimeout(() => reset(), 4000);
    }
  }, [writeError]);

  // ─── Actions ──────────────────────────────────────────────────

  function approveTokenA(amount: string) {
    if (!tokenA || tokenA.isNative) return;
    try {
      writeContract({
        address: addrA,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [TEGRIDY_ROUTER_ADDRESS, parseUnits(amount, decimalsA)],
      });
    } catch {
      toast.error('Invalid amount for token A approval');
    }
  }

  function approveTokenB(amount: string) {
    if (!tokenB || tokenB.isNative) return;
    try {
      writeContract({
        address: addrB,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [TEGRIDY_ROUTER_ADDRESS, parseUnits(amount, decimalsB)],
      });
    } catch {
      toast.error('Invalid amount for token B approval');
    }
  }

  function approveLP(amount: string) {
    if (!pairExists) return;
    try {
      writeContract({
        address: pairAddr,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [TEGRIDY_ROUTER_ADDRESS, parseUnits(amount, 18)],
      });
    } catch {
      toast.error('Invalid LP amount for approval');
    }
  }

  // Add liquidity — dispatches to correct variant based on ETH involvement
  function addLiquidity(amountAStr: string, amountBStr: string, slippageBps = 50) {
    if (!address || !tokenA || !tokenB) return;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30min
    const slippageFactor = BigInt(10000 - slippageBps);

    try {
      if (involvesETH) {
        // One token is ETH — use addLiquidityETH
        const isAEth = ethSide === 'A';
        const tokenAddr = isAEth ? addrB : addrA;
        const tokenAmount = isAEth ? parseUnits(amountBStr, decimalsB) : parseUnits(amountAStr, decimalsA);
        const ethAmount = isAEth ? parseUnits(amountAStr, 18) : parseUnits(amountBStr, 18);
        const tokenMin = (tokenAmount * slippageFactor) / 10000n;
        const ethMin = (ethAmount * slippageFactor) / 10000n;

        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS,
          abi: TEGRIDY_ROUTER_ABI,
          functionName: 'addLiquidityETH',
          args: [tokenAddr, tokenAmount, tokenMin, ethMin, address, deadline],
          value: ethAmount,
        });
      } else {
        // Both are ERC20 tokens — use addLiquidity
        const amountAWei = parseUnits(amountAStr, decimalsA);
        const amountBWei = parseUnits(amountBStr, decimalsB);
        const amountAMin = (amountAWei * slippageFactor) / 10000n;
        const amountBMin = (amountBWei * slippageFactor) / 10000n;

        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS,
          abi: TEGRIDY_ROUTER_ABI,
          functionName: 'addLiquidity',
          args: [addrA, addrB, amountAWei, amountBWei, amountAMin, amountBMin, address, deadline],
        });
      }
    } catch {
      toast.error('Invalid amount entered');
    }
  }

  // Remove liquidity — dispatches to correct variant
  function removeLiquidity(lpAmount: string, slippageBps = 50) {
    if (!address || !tokenA || !tokenB || !pairExists) return;
    try {
      const lpWei = parseUnits(lpAmount, 18);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800);
      const slippageFactor = BigInt(10000 - slippageBps);

      // Calculate expected outputs from pool share
      const expectedA = lpTotalSupply > 0n ? (lpWei * reserveA) / lpTotalSupply : 0n;
      const expectedB = lpTotalSupply > 0n ? (lpWei * reserveB) / lpTotalSupply : 0n;

      if (involvesETH) {
        const isAEth = ethSide === 'A';
        const tokenAddr = isAEth ? addrB : addrA;
        const tokenOut = isAEth ? expectedB : expectedA;
        const ethOut = isAEth ? expectedA : expectedB;

        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS,
          abi: TEGRIDY_ROUTER_ABI,
          functionName: 'removeLiquidityETH',
          args: [
            tokenAddr,
            lpWei,
            (tokenOut * slippageFactor) / 10000n,
            (ethOut * slippageFactor) / 10000n,
            address, deadline,
          ],
        });
      } else {
        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS,
          abi: TEGRIDY_ROUTER_ABI,
          functionName: 'removeLiquidity',
          args: [
            addrA, addrB,
            lpWei,
            (expectedA * slippageFactor) / 10000n,
            (expectedB * slippageFactor) / 10000n,
            address, deadline,
          ],
        });
      }
    } catch {
      toast.error('Invalid LP amount entered');
    }
  }

  return {
    // Pair info
    pairAddress: pairExists ? pairAddress : null,
    pairExists,
    isEmptyPool,
    involvesETH,
    // Balances
    tokenABalance,
    tokenABalanceFormatted: formatUnits(tokenABalance, decimalsA),
    tokenBBalance,
    tokenBBalanceFormatted: formatUnits(tokenBBalance, decimalsB),
    // Allowances
    tokenAAllowance,
    tokenBAllowance,
    lpBalance,
    lpBalanceFormatted: formatUnits(lpBalance, 18),
    lpAllowance,
    lpTotalSupply,
    // Reserves
    reserveA,
    reserveB,
    priceRatio,
    // Helpers
    getAmountB,
    getAmountA,
    getPoolShare,
    // Actions
    approveTokenA,
    approveTokenB,
    approveLP,
    addLiquidity,
    removeLiquidity,
    // State
    isPending,
    isConfirming,
    isSuccess,
    isLoadingPool,
    hash,
    reset,
    refetch: () => { refetch(); refetchPair(); },
  };
}
