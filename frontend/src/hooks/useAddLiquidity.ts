import { useEffect, useMemo, useRef } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt, useReadContract, useReadContracts, useChainId } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { toast } from 'sonner';
import { TEGRIDY_ROUTER_ABI, TEGRIDY_FACTORY_ABI, ERC20_ABI, UNISWAP_V2_PAIR_ABI } from '../lib/contracts';
import { TEGRIDY_ROUTER_ADDRESS, TEGRIDY_FACTORY_ADDRESS, WETH_ADDRESS, CHAIN_ID } from '../lib/constants';
import { type TokenInfo } from '../lib/tokenList';
import { getTxUrl } from '../lib/explorer';
import { surfaceTxError } from '../lib/txErrors';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
const PLACEHOLDER_ADDR = '0x0000000000000000000000000000000000000001' as const;

export function useAddLiquidity(tokenA: TokenInfo | null, tokenB: TokenInfo | null) {
  const { address } = useAccount();
  const chainId = useChainId();
  const userAddr = address ?? PLACEHOLDER_ADDR;

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });
  // 2026-07-26: an approval is a prerequisite, not the liquidity op. Track which
  // is in flight (set in every write fn below) so the toast can say "approved —
  // one more step" instead of "Liquidity operation confirmed!" after a mere approval.
  const lastActionRef = useRef<'approve' | 'liquidity'>('liquidity');

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

  // F201: pin reads to CHAIN_ID. Without this, a wrong-network wallet queries
  // TEGRIDY_FACTORY on the connected chain → getPair returns nothing →
  // LiquidityTab shows the misleading "No pool exists … plant one" + zero
  // balances instead of a switch-network prompt.
  const onRightChain = chainId === CHAIN_ID;

  const { data: pairAddress, refetch: refetchPair } = useReadContract({
    address: TEGRIDY_FACTORY_ADDRESS,
    abi: TEGRIDY_FACTORY_ABI,
    functionName: 'getPair',
    args: [addrA, addrB],
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && tokensSelected },
  });

  const pairExists = !!pairAddress && pairAddress !== ZERO_ADDR;
  const pairAddr = pairExists ? pairAddress as `0x${string}` : PLACEHOLDER_ADDR;

  // Fetch pair reserves + token0 + LP info + user balances + allowances
  const { data, refetch, isLoading: isLoadingPool } = useReadContracts({
    // chainId is pinned per-contract (useReadContracts has no top-level chainId
    // in this wagmi version) so every read targets mainnet regardless of the
    // wallet's network. [T9 read-layer pin]
    contracts: [
      // Pair info
      { address: pairAddr, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves', chainId: CHAIN_ID },
      { address: pairAddr, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0', chainId: CHAIN_ID },
      { address: pairAddr, abi: UNISWAP_V2_PAIR_ABI, functionName: 'totalSupply', chainId: CHAIN_ID },
      // LP balance + allowance
      { address: pairAddr, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: pairAddr, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, TEGRIDY_ROUTER_ADDRESS], chainId: CHAIN_ID },
      // Token A balance + allowance (only for ERC20, not native ETH)
      { address: addrA, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: addrA, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, TEGRIDY_ROUTER_ADDRESS], chainId: CHAIN_ID },
      // Token B balance + allowance (only for ERC20, not native ETH)
      { address: addrB, abi: ERC20_ABI, functionName: 'balanceOf', args: [userAddr], chainId: CHAIN_ID },
      { address: addrB, abi: ERC20_ABI, functionName: 'allowance', args: [userAddr, TEGRIDY_ROUTER_ADDRESS], chainId: CHAIN_ID },
    ],
    query: { enabled: onRightChain && !!address, refetchInterval: 30_000, refetchOnWindowFocus: true },
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

  // Toasts. F484: capture each reset() timer and clear it on cleanup so an
  // unmount mid-window doesn't leak a pending timer (mirrors useSwap's pattern).
  useEffect(() => {
    if (isSuccess && hash) {
      if (lastActionRef.current === 'approve') {
        toast.success('Token approved — one more step', {
          id: hash,
          description: 'That was just the approval — confirm the liquidity transaction to finish.',
          action: { label: 'Explorer', onClick: () => window.open(getTxUrl(chainId, hash), '_blank') },
        });
      } else {
        toast.success('Liquidity operation confirmed!', {
          id: hash,
          action: { label: 'Explorer', onClick: () => window.open(getTxUrl(chainId, hash), '_blank') },
        });
      }
      refetch();
      const t = setTimeout(() => reset(), 4000);
      return () => clearTimeout(t);
    }
  }, [isSuccess, hash]);

  useEffect(() => {
    if (isTxError && hash) {
      toast.error('Transaction failed', { id: `err-${hash}` });
      const t = setTimeout(() => reset(), 4000);
      return () => clearTimeout(t);
    }
  }, [isTxError, hash]);

  useEffect(() => {
    if (writeError) {
      // F474: soft "Cancelled" for wallet rejections; classified message otherwise.
      surfaceTxError(writeError, toast, { component: 'useAddLiquidity' });
      const t = setTimeout(() => reset(), 4000);
      return () => clearTimeout(t);
    }
  }, [writeError]);

  // ─── Actions ──────────────────────────────────────────────────

  // AUDIT FIX M-8: every action below short-circuits on wrong chain so the
  // user can't burn ETH approving / adding liquidity on a non-mainnet chain
  // where the router/factory addresses are unallocated or colliding.
  function _ensureChain(): boolean {
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return false; }
    return true;
  }

  function approveTokenA(amount: string) {
    if (!_ensureChain()) return;
    if (!tokenA || tokenA.isNative) return;
    lastActionRef.current = 'approve';
    try {
      writeContract({
        chainId: CHAIN_ID,
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
    if (!_ensureChain()) return;
    if (!tokenB || tokenB.isNative) return;
    lastActionRef.current = 'approve';
    try {
      writeContract({
        chainId: CHAIN_ID,
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
    if (!_ensureChain()) return;
    if (!pairExists) return;
    lastActionRef.current = 'approve';
    try {
      writeContract({
        chainId: CHAIN_ID,
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
    if (!_ensureChain()) return;
    if (!address || !tokenA || !tokenB) return;
    lastActionRef.current = 'liquidity';
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
          chainId: CHAIN_ID,
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
          chainId: CHAIN_ID,
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
    if (!_ensureChain()) return;
    if (!address || !tokenA || !tokenB || !pairExists) return;
    lastActionRef.current = 'liquidity';
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
          chainId: CHAIN_ID,
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
          chainId: CHAIN_ID,
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
    // F201: surface chain state so LiquidityTab can show a "switch network"
    // banner instead of the misleading "No pool exists" empty state.
    onRightChain,
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
