import { useState, useMemo, useEffect, useCallback } from 'react';
import { useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt, useAccount, useBalance } from 'wagmi';
import { parseUnits, formatUnits, maxUint256 } from 'viem';
import { toast } from 'sonner';
import { UNISWAP_V2_ROUTER_ABI, UNISWAP_V2_FACTORY_ABI, ERC20_ABI, UNISWAP_V2_PAIR_ABI, SWAP_FEE_ROUTER_ABI, TEGRIDY_ROUTER_ABI, TEGRIDY_FACTORY_ABI } from '../lib/contracts';
import { UNISWAP_V2_ROUTER, WETH_ADDRESS, UNISWAP_V2_FACTORY, SWAP_FEE_ROUTER_ADDRESS, TEGRIDY_FACTORY_ADDRESS, TEGRIDY_ROUTER_ADDRESS } from '../lib/constants';
import { type TokenInfo } from '../lib/tokenList';
import { getAggregatorPrice, calculateAggregatorSpread, AGGREGATOR_NAMES, type AggregatorSpread, type AggregatorQuote, type AggregatorSource } from '../lib/aggregator';

// Which router function to use based on input/output token types
type SwapType = 'ethForTokens' | 'tokensForEth' | 'tokensForTokens';

// Route source for smart routing
export type RouteSource = 'tegridy' | 'uniswap' | 'aggregator';

function getSwapType(fromToken: TokenInfo, toToken: TokenInfo): SwapType {
  if (fromToken.isNative) return 'ethForTokens';
  if (toToken.isNative) return 'tokensForEth';
  return 'tokensForTokens';
}

// Build the swap path: always route through WETH if neither token is WETH/ETH
function buildPath(fromToken: TokenInfo, toToken: TokenInfo): `0x${string}`[] {
  const fromAddr = fromToken.isNative ? WETH_ADDRESS : fromToken.address as `0x${string}`;
  const toAddr = toToken.isNative ? WETH_ADDRESS : toToken.address as `0x${string}`;

  // Direct pair (one of them is WETH or they share a direct pair)
  if (fromAddr.toLowerCase() === WETH_ADDRESS.toLowerCase() || toAddr.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    return [fromAddr, toAddr];
  }

  // Route through WETH as intermediate
  return [fromAddr, WETH_ADDRESS, toAddr];
}

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

// 0.5% tolerance favoring own pools — keeps volume on our DEX for revenue
const TEGRIDY_PREFERENCE_BPS = 50n;

export function useSwap() {
  const { address } = useAccount();
  const [fromToken, setFromToken] = useState<TokenInfo | null>(null);
  const [toToken, setToToken] = useState<TokenInfo | null>(null);
  const [inputAmount, setInputAmount] = useState('');
  const [slippageRaw, setSlippageRaw] = useState(0.5);
  const slippage = Math.min(Math.max(slippageRaw, 0), 49);
  const setSlippage = useCallback((val: number) => {
    setSlippageRaw(Math.min(Math.max(val, 0), 49));
  }, []);
  const [deadline, setDeadline] = useState(5);
  const [customTokens, setCustomTokens] = useState<TokenInfo[]>([]);
  const [unlimitedApproval, setUnlimitedApproval] = useState(false);

  const { data: ethBalance } = useBalance({ address, chainId: 1, query: { refetchInterval: 30_000 } });

  // Derived values
  const swapType = fromToken && toToken ? getSwapType(fromToken, toToken) : null;
  const path = fromToken && toToken ? buildPath(fromToken, toToken) : [];
  const fromDecimals = fromToken?.decimals ?? 18;
  const toDecimals = toToken?.decimals ?? 18;

  const parsedAmount = useMemo(() => {
    try {
      const val = parseFloat(inputAmount);
      if (isNaN(val) || val <= 0) return 0n;
      return parseUnits(inputAmount, fromDecimals);
    } catch {
      return 0n;
    }
  }, [inputAmount, fromDecimals]);

  // ─── Uniswap V2 quote (existing) ──────────────────────────────
  const { data: uniAmountsOut, isLoading: isUniQuoteLoading } = useReadContract({
    address: UNISWAP_V2_ROUTER,
    abi: UNISWAP_V2_ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [parsedAmount, path],
    query: { enabled: parsedAmount > 0n && path.length >= 2 },
  });

  // ─── Tegridy DEX: check own pools ─────────────────────────────
  const fromAddrForPair = fromToken?.isNative ? WETH_ADDRESS : (fromToken?.address ?? WETH_ADDRESS);
  const toAddrForPair = toToken?.isNative ? WETH_ADDRESS : (toToken?.address ?? WETH_ADDRESS);
  const pairsEnabled = !!fromToken && !!toToken && fromAddrForPair.toLowerCase() !== toAddrForPair.toLowerCase();

  // Check if Tegridy Factory has a pair for these tokens
  const { data: tegridyPairAddr } = useReadContract({
    address: TEGRIDY_FACTORY_ADDRESS,
    abi: TEGRIDY_FACTORY_ABI,
    functionName: 'getPair',
    args: [fromAddrForPair as `0x${string}`, toAddrForPair as `0x${string}`],
    query: { enabled: pairsEnabled },
  });

  const hasTegridyPair = !!tegridyPairAddr && tegridyPairAddr !== ZERO_ADDR;

  // Get quote from Tegridy Router (only if own pair exists)
  const { data: tegridyAmountsOut, isLoading: isTegridyQuoteLoading } = useReadContract({
    address: TEGRIDY_ROUTER_ADDRESS,
    abi: TEGRIDY_ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [parsedAmount, path],
    query: { enabled: hasTegridyPair && parsedAmount > 0n && path.length >= 2 },
  });

  // Also check Uniswap factory for direct pair (for routing info display)
  const { data: directPair } = useReadContract({
    address: UNISWAP_V2_FACTORY,
    abi: UNISWAP_V2_FACTORY_ABI,
    functionName: 'getPair',
    args: [fromAddrForPair as `0x${string}`, toAddrForPair as `0x${string}`],
    query: { enabled: pairsEnabled },
  });

  const hasDirectPair = directPair && directPair !== ZERO_ADDR;

  // For direct swaps, use the directPair; for multi-hop, look up both leg pairs
  const isMultiHop = path.length > 2;
  const primaryPairAddr = !isMultiHop ? directPair : undefined;

  const { data: leg1Pair } = useReadContract({
    address: UNISWAP_V2_FACTORY,
    abi: UNISWAP_V2_FACTORY_ABI,
    functionName: 'getPair',
    args: [path[0] as `0x${string}`, WETH_ADDRESS],
    query: { enabled: isMultiHop && path.length === 3 && parsedAmount > 0n },
  });

  const { data: leg2Pair } = useReadContract({
    address: UNISWAP_V2_FACTORY,
    abi: UNISWAP_V2_FACTORY_ABI,
    functionName: 'getPair',
    args: [WETH_ADDRESS, path[2] as `0x${string}`],
    query: { enabled: isMultiHop && path.length === 3 && parsedAmount > 0n },
  });

  const validLeg1 = leg1Pair && leg1Pair !== ZERO_ADDR;
  const validLeg2 = leg2Pair && leg2Pair !== ZERO_ADDR;

  const { data: reserves } = useReadContract({
    address: primaryPairAddr as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'getReserves',
    query: { enabled: !!primaryPairAddr && primaryPairAddr !== ZERO_ADDR && parsedAmount > 0n, refetchInterval: 15_000 },
  });

  const { data: token0 } = useReadContract({
    address: primaryPairAddr as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'token0',
    query: { enabled: !!primaryPairAddr && primaryPairAddr !== ZERO_ADDR },
  });

  const { data: leg1Reserves } = useReadContract({
    address: leg1Pair as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'getReserves',
    query: { enabled: !!validLeg1 && parsedAmount > 0n, refetchInterval: 15_000 },
  });

  const { data: leg1Token0 } = useReadContract({
    address: leg1Pair as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'token0',
    query: { enabled: !!validLeg1 && parsedAmount > 0n },
  });

  const { data: leg2Reserves } = useReadContract({
    address: leg2Pair as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'getReserves',
    query: { enabled: !!validLeg2 && parsedAmount > 0n, refetchInterval: 15_000 },
  });

  const { data: leg2Token0 } = useReadContract({
    address: leg2Pair as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'token0',
    query: { enabled: !!validLeg2 && parsedAmount > 0n },
  });

  // Token balances
  const { data: fromTokenBalance, refetch: refetchFromBalance } = useReadContract({
    address: (fromToken && !fromToken.isNative ? fromToken.address : WETH_ADDRESS) as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    chainId: 1,
    query: { enabled: !!address && !!fromToken && !fromToken.isNative, refetchInterval: 30_000 },
  });

  const { data: toTokenBalance } = useReadContract({
    address: (toToken && !toToken.isNative ? toToken.address : WETH_ADDRESS) as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    chainId: 1,
    query: { enabled: !!address && !!toToken && !toToken.isNative, refetchInterval: 30_000 },
  });

  // ─── Allowance: check both routers in parallel ────────────────
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

  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // Refetch allowance and balances after successful tx + toast + auto-reset
  useEffect(() => {
    if (isSuccess && hash) {
      refetchAllowance();
      refetchFromBalance();
      toast.success('WAGMI! Swap confirmed', {
        description: `${fromToken?.symbol} → ${toToken?.symbol}`,
        action: {
          label: 'View on Etherscan',
          onClick: () => window.open(`https://etherscan.io/tx/${hash}`, '_blank'),
        },
      });
      const t = setTimeout(() => { reset(); setInputAmount(''); }, 4000);
      return () => clearTimeout(t);
    }
  }, [isSuccess, hash]); // eslint-disable-line react-hooks/exhaustive-deps

  // Meta-aggregator: queries 7 DEX aggregators in parallel (DefiLlama-style)
  const [aggQuoteResult, setAggQuoteResult] = useState<{ amountOut: string; priceImpact: number; source: AggregatorSource; allQuotes: AggregatorQuote[] } | null>(null);
  const [useAggregator, setUseAggregator] = useState(false);

  useEffect(() => {
    if (!fromToken || !toToken || parsedAmount === 0n || !address) {
      setAggQuoteResult(null);
      return;
    }
    let cancelled = false;
    const sellToken = fromToken.isNative ? 'ETH' : fromToken.address;
    const buyToken = toToken.isNative ? 'ETH' : toToken.address;
    const timer = setTimeout(() => {
      getAggregatorPrice(sellToken, buyToken, parsedAmount.toString(), address, fromDecimals)
        .then(q => { if (!cancelled) setAggQuoteResult(q); })
        .catch(() => { if (!cancelled) setAggQuoteResult(null); });
    }, 800);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [fromToken, toToken, parsedAmount, address, fromDecimals]);

  // ─── Smart Route Selection ────────────────────────────────────
  const uniOutputAmount = uniAmountsOut ? uniAmountsOut[uniAmountsOut.length - 1] : 0n;
  const tegridyOutputAmount = tegridyAmountsOut ? tegridyAmountsOut[tegridyAmountsOut.length - 1] : 0n;

  let aggOutputAmount = 0n;
  try {
    aggOutputAmount = aggQuoteResult?.amountOut ? BigInt(aggQuoteResult.amountOut) : 0n;
  } catch {
    // Invalid amountOut from aggregator — ignore
  }

  // Best aggregator source name for display
  const bestAggregatorName = aggQuoteResult?.source ? AGGREGATOR_NAMES[aggQuoteResult.source] : null;
  const allAggQuotes = aggQuoteResult?.allQuotes ?? [];

  // Select best on-chain route: Tegridy vs Uniswap
  // Give Tegridy a 0.5% preference to keep volume on our pools (revenue capture)
  const selectedOnChainRoute: { source: 'tegridy' | 'uniswap'; output: bigint } = useMemo(() => {
    if (tegridyOutputAmount > 0n && uniOutputAmount > 0n) {
      // Tegridy wins if its output + 0.5% tolerance >= Uniswap output
      const tegridyWithPreference = tegridyOutputAmount + (tegridyOutputAmount * TEGRIDY_PREFERENCE_BPS) / 10000n;
      if (tegridyWithPreference >= uniOutputAmount) {
        return { source: 'tegridy', output: tegridyOutputAmount };
      }
      // Uniswap is meaningfully better
      return { source: 'uniswap', output: uniOutputAmount };
    }
    if (tegridyOutputAmount > 0n) return { source: 'tegridy', output: tegridyOutputAmount };
    return { source: 'uniswap', output: uniOutputAmount };
  }, [tegridyOutputAmount, uniOutputAmount]);

  // Aggregator spread against the best on-chain route
  const aggSpread: AggregatorSpread = useMemo(
    () => calculateAggregatorSpread(selectedOnChainRoute.output, aggOutputAmount),
    [selectedOnChainRoute.output, aggOutputAmount],
  );

  const aggBetter = aggSpread.shouldUseAggregator;

  // Final route selection: automatically pick the best route across all 9 sources
  const selectedRoute: RouteSource = useMemo(() => {
    if (aggBetter) return 'aggregator';
    return selectedOnChainRoute.source;
  }, [aggBetter, selectedOnChainRoute.source]);

  // Best route output: aggregator (spread-adjusted) or on-chain winner
  const outputAmount = aggBetter ? aggSpread.userReceives : selectedOnChainRoute.output;
  const outputFormatted = formatUnits(outputAmount, toDecimals);

  // Use the correct amountsOut for the selected route (for price impact / intermediate display)
  const activeAmountsOut = selectedRoute === 'tegridy' ? tegridyAmountsOut : uniAmountsOut;

  // Intermediate amount (for multi-hop route display)
  const intermediateAmount = activeAmountsOut && activeAmountsOut.length === 3 ? activeAmountsOut[1] : undefined;

  // Allowance: target the correct router based on selected route
  const activeAllowance = selectedRoute === 'tegridy' ? tegridyAllowance : uniAllowance;

  const isQuoteLoading = isUniQuoteLoading || (hasTegridyPair && isTegridyQuoteLoading);

  // Price impact calculation
  const priceImpact = useMemo(() => {
    if (parsedAmount === 0n || outputAmount === 0n || !fromToken || !toToken) return 0;

    if (path.length > 2) {
      if (!activeAmountsOut || activeAmountsOut.length < 3) return 0;
      if (!leg1Reserves || !leg1Token0 || !leg2Reserves || !leg2Token0) return 0.5;

      try {
        const fromAddr = (fromToken.isNative ? WETH_ADDRESS : fromToken.address).toLowerCase();
        const isLeg1Token0From = leg1Token0.toLowerCase() === fromAddr;
        const r1In = isLeg1Token0From ? leg1Reserves[0] : leg1Reserves[1];
        const r1Out = isLeg1Token0From ? leg1Reserves[1] : leg1Reserves[0];
        if (r1In <= 0n || r1Out <= 0n) return 0.5;

        const midPrice1 = (r1Out * 10n ** 18n) / r1In;
        const execPrice1 = (activeAmountsOut[1] * 10n ** 18n) / activeAmountsOut[0];
        const ratio1 = midPrice1 > 0n ? (execPrice1 * 10n ** 18n) / midPrice1 : 10n ** 18n;

        const isLeg2Token0Weth = leg2Token0.toLowerCase() === WETH_ADDRESS.toLowerCase();
        const r2In = isLeg2Token0Weth ? leg2Reserves[0] : leg2Reserves[1];
        const r2Out = isLeg2Token0Weth ? leg2Reserves[1] : leg2Reserves[0];
        if (r2In <= 0n || r2Out <= 0n) return 0.5;

        const midPrice2 = (r2Out * 10n ** 18n) / r2In;
        const execPrice2 = (activeAmountsOut[2] * 10n ** 18n) / activeAmountsOut[1];
        const ratio2 = midPrice2 > 0n ? (execPrice2 * 10n ** 18n) / midPrice2 : 10n ** 18n;

        const combinedRatio = (ratio1 * ratio2) / 10n ** 18n;
        const impactBps = combinedRatio < 10n ** 18n
          ? ((10n ** 18n - combinedRatio) * 10000n) / 10n ** 18n
          : 0n;
        return Number(impactBps) / 100;
      } catch {
        return 0.5;
      }
    }

    if (!reserves || !token0) return 0;

    try {
      const fromAddr = fromToken.isNative ? WETH_ADDRESS : fromToken.address;
      const isToken0From = token0.toLowerCase() === fromAddr.toLowerCase();
      const reserveIn = isToken0From ? reserves[0] : reserves[1];
      const reserveOut = isToken0From ? reserves[1] : reserves[0];

      if (reserveIn <= 0n || reserveOut <= 0n) return 0;

      const midPriceScaled = (reserveOut * 10n ** 18n) / reserveIn;
      const execPriceScaled = (outputAmount * 10n ** 18n) / parsedAmount;
      const diff = midPriceScaled > execPriceScaled
        ? midPriceScaled - execPriceScaled
        : execPriceScaled - midPriceScaled;
      const impactBps = (diff * 10000n) / midPriceScaled;
      return Number(impactBps) / 100;
    } catch {
      return 0;
    }
  }, [reserves, token0, parsedAmount, outputAmount, fromToken, toToken, path, activeAmountsOut, leg1Reserves, leg1Token0, leg2Reserves, leg2Token0]);

  // Slippage-protected minimum
  const minimumReceived = useMemo(() => {
    if (outputAmount === 0n) return 0n;
    const slippageBps = BigInt(Math.round(slippage * 100));
    return outputAmount - (outputAmount * slippageBps) / 10000n;
  }, [outputAmount, slippage]);

  const needsApproval = !!fromToken && !fromToken.isNative && parsedAmount > 0n && activeAllowance < parsedAmount;

  // Balance
  const fromBalance = useMemo(() => {
    if (!fromToken) return '0';
    if (fromToken.isNative) return ethBalance ? formatUnits(ethBalance.value, 18) : '0';
    return formatUnits(fromTokenBalance ?? 0n, fromToken.decimals);
  }, [fromToken, ethBalance, fromTokenBalance]);

  const toBalance = useMemo(() => {
    if (!toToken) return '0';
    if (toToken.isNative) return ethBalance ? formatUnits(ethBalance.value, 18) : '0';
    return formatUnits(toTokenBalance ?? 0n, toToken.decimals);
  }, [toToken, ethBalance, toTokenBalance]);

  const insufficientBalance = useMemo(() => {
    if (parsedAmount === 0n || !fromToken) return false;
    if (fromToken.isNative) {
      return parsedAmount > (ethBalance?.value ?? 0n);
    }
    return parsedAmount > (fromTokenBalance ?? 0n);
  }, [parsedAmount, fromToken, ethBalance, fromTokenBalance]);

  // Route description for display
  const routeDescription = useMemo(() => {
    if (!fromToken || !toToken) return [];
    if (path.length === 2) {
      return [fromToken.symbol, toToken.symbol];
    }
    return [fromToken.symbol, 'WETH', toToken.symbol];
  }, [fromToken, toToken, path]);

  const routeLabel = useMemo(() => {
    if (selectedRoute === 'aggregator') return `Best rate via ${bestAggregatorName ?? 'Aggregator'}`;
    const dex = selectedRoute === 'tegridy' ? 'Tegridy DEX' : 'Uniswap V2';
    if (path.length <= 2) return `Direct swap via ${dex}`;
    return `Routed through WETH via ${dex}`;
  }, [path, selectedRoute, bestAggregatorName]);

  // ─── Actions ──────────────────────────────────────────────────
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
    setUnlimitedApproval(val);
  }, []);

  const executeSwap = useCallback(() => {
    if (!address || !fromToken || !toToken || parsedAmount === 0n || insufficientBalance || !swapType) return;
    // Prevent swapping a token for itself
    const fromAddr = fromToken.isNative ? WETH_ADDRESS : fromToken.address;
    const toAddr = toToken.isNative ? WETH_ADDRESS : toToken.address;
    if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
      toast.error('Cannot swap a token for itself');
      return;
    }
    // Prevent swaps with zero expected output
    if (outputAmount === 0n) {
      toast.error('No output quote available — try a different amount or pair');
      return;
    }
    const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + deadline * 60);

    if (selectedRoute === 'aggregator') {
      // Aggregator route: use the best on-chain route with on-chain minimumReceived
      // The aggregator is used for price discovery only — execution goes through our routers
      // Recalculate minimumReceived from the on-chain output to avoid reverts
      const onChainMin = (() => {
        const onChainOutput = selectedOnChainRoute.output;
        if (onChainOutput === 0n) return minimumReceived;
        const slippageBps = BigInt(Math.round(slippage * 100));
        return onChainOutput - (onChainOutput * slippageBps) / 10000n;
      })();
      if (selectedOnChainRoute.source === 'tegridy') {
        // Route through TegridyRouter (no maxFeeBps param)
        if (swapType === 'ethForTokens') {
          writeContract({ address: TEGRIDY_ROUTER_ADDRESS, abi: TEGRIDY_ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [onChainMin, path, address, deadlineTs], value: parsedAmount });
        } else if (swapType === 'tokensForEth') {
          writeContract({ address: TEGRIDY_ROUTER_ADDRESS, abi: TEGRIDY_ROUTER_ABI, functionName: 'swapExactTokensForETH', args: [parsedAmount, onChainMin, path, address, deadlineTs] });
        } else {
          writeContract({ address: TEGRIDY_ROUTER_ADDRESS, abi: TEGRIDY_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [parsedAmount, onChainMin, path, address, deadlineTs] });
        }
      } else {
        // Route through SwapFeeRouter (includes maxFeeBps)
        const maxFeeBps = 100n;
        if (swapType === 'ethForTokens') {
          writeContract({ address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [onChainMin, path, address, deadlineTs, maxFeeBps], value: parsedAmount });
        } else if (swapType === 'tokensForEth') {
          writeContract({ address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactTokensForETH', args: [parsedAmount, onChainMin, path, address, deadlineTs, maxFeeBps] });
        } else {
          writeContract({ address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [parsedAmount, onChainMin, path, address, deadlineTs, maxFeeBps] });
        }
      }
    } else if (selectedRoute === 'tegridy') {
      // Route through TegridyRouter (standard Uni V2 interface, no maxFeeBps)
      if (swapType === 'ethForTokens') {
        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS,
          abi: TEGRIDY_ROUTER_ABI,
          functionName: 'swapExactETHForTokens',
          args: [minimumReceived, path, address, deadlineTs],
          value: parsedAmount,
        });
      } else if (swapType === 'tokensForEth') {
        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS,
          abi: TEGRIDY_ROUTER_ABI,
          functionName: 'swapExactTokensForETH',
          args: [parsedAmount, minimumReceived, path, address, deadlineTs],
        });
      } else {
        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS,
          abi: TEGRIDY_ROUTER_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [parsedAmount, minimumReceived, path, address, deadlineTs],
        });
      }
    } else {
      // Route through SwapFeeRouter (wraps Uniswap V2 with 0.3% fee to treasury)
      // maxFeeBps = 100 (1%) protects against fee frontrunning during timelock changes
      const maxFeeBps = 100n;
      if (swapType === 'ethForTokens') {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS,
          abi: SWAP_FEE_ROUTER_ABI,
          functionName: 'swapExactETHForTokens',
          args: [minimumReceived, path, address, deadlineTs, maxFeeBps],
          value: parsedAmount,
        });
      } else if (swapType === 'tokensForEth') {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS,
          abi: SWAP_FEE_ROUTER_ABI,
          functionName: 'swapExactTokensForETH',
          args: [parsedAmount, minimumReceived, path, address, deadlineTs, maxFeeBps],
        });
      } else {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS,
          abi: SWAP_FEE_ROUTER_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [parsedAmount, minimumReceived, path, address, deadlineTs, maxFeeBps],
        });
      }
    }
  }, [address, fromToken, toToken, parsedAmount, insufficientBalance, swapType, deadline, minimumReceived, path, selectedRoute, selectedOnChainRoute, outputAmount, slippage, writeContract]);

  const flipDirection = useCallback(() => {
    const prev = fromToken;
    setFromToken(toToken);
    setToToken(prev);
    setInputAmount('');
    reset();
  }, [fromToken, toToken, reset]);

  const addCustomToken = useCallback((token: TokenInfo) => {
    setCustomTokens(prev => {
      if (prev.find(t => t.address.toLowerCase() === token.address.toLowerCase())) return prev;
      return [...prev, token];
    });
  }, []);

  return {
    fromToken,
    toToken,
    setFromToken,
    setToToken,
    inputAmount,
    setInputAmount,
    slippage,
    setSlippage,
    deadline,
    setDeadline,
    outputFormatted,
    outputAmount,
    priceImpact,
    minimumReceived: formatUnits(minimumReceived, toDecimals),
    needsApproval,
    insufficientBalance,
    approve,
    executeSwap,
    flipDirection,
    isPending,
    isConfirming,
    isSuccess,
    isTxError,
    writeError,
    reset,
    fromBalance,
    toBalance,
    refetchAllowance,
    isQuoteLoading,
    routeDescription,
    routeLabel,
    path,
    hasDirectPair,
    intermediateAmount,
    customTokens,
    addCustomToken,
    swapType,
    unlimitedApproval,
    toggleUnlimitedApproval,
    // Smart routing
    selectedRoute,
    hasTegridyPair,
    tegridyOutputFormatted: tegridyOutputAmount > 0n ? formatUnits(tegridyOutputAmount, toDecimals) : null,
    uniOutputFormatted: uniOutputAmount > 0n ? formatUnits(uniOutputAmount, toDecimals) : null,
    // Meta-aggregator (7 DEX aggregators queried in parallel)
    aggBetter,
    aggOutputFormatted: aggOutputAmount > 0n ? formatUnits(aggOutputAmount, toDecimals) : null,
    bestAggregatorName,
    allAggQuotes,
    useAggregator,
    setUseAggregator,
    txHash: hash,
    // Aggregator revenue spread info
    aggSpread,
    aggUserReceivesFormatted: aggSpread.shouldUseAggregator ? formatUnits(aggSpread.userReceives, toDecimals) : null,
    aggProtocolCaptureFormatted: aggSpread.protocolCapture > 0n ? formatUnits(aggSpread.protocolCapture, toDecimals) : null,
  };
}
