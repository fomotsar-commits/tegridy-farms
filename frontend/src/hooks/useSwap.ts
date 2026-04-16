import { useState, useMemo, useEffect, useCallback } from 'react';
import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount, useBalance, useChainId } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI, SWAP_FEE_ROUTER_ABI, TEGRIDY_ROUTER_ABI } from '../lib/contracts';
import { WETH_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, TEGRIDY_ROUTER_ADDRESS, CHAIN_ID } from '../lib/constants';
import { type TokenInfo, DEFAULT_TOKENS } from '../lib/tokenList';
import { decodeRevertReason } from '../lib/revertDecoder';
import { trackSwap } from '../lib/analytics';
import { useSwapQuote } from './useSwapQuote';
import { useSwapAllowance } from './useSwapAllowance';

// Re-export RouteSource so existing imports from useSwap keep working
export type { RouteSource } from './useSwapQuote';

// Which router function to use based on input/output token types
type SwapType = 'ethForTokens' | 'tokensForEth' | 'tokensForTokens';

function getSwapType(fromToken: TokenInfo, toToken: TokenInfo): SwapType {
  if (fromToken.isNative) return 'ethForTokens';
  if (toToken.isNative) return 'tokensForEth';
  return 'tokensForTokens';
}

export function useSwap() {
  const chainId = useChainId();
  const { address } = useAccount();
  const [fromToken, setFromToken] = useState<TokenInfo | null>(() =>
    DEFAULT_TOKENS.find(t => t.symbol === 'ETH') ?? null
  );
  const [toToken, setToToken] = useState<TokenInfo | null>(() =>
    DEFAULT_TOKENS.find(t => t.symbol === 'TOWELI') ?? null
  );
  const [inputAmount, setInputAmount] = useState('');
  const [slippageRaw, setSlippageRaw] = useState(1.0);
  // SECURITY FIX: Reduced max slippage from 49% to 20%.
  // 49% slippage allows users to lose nearly half their swap value to MEV/sandwich attacks.
  // 20% is already very generous -- most swaps should use 0.5-5%.
  const slippage = Math.min(Math.max(slippageRaw, 0), 20);
  const setSlippage = useCallback((val: number) => {
    setSlippageRaw(Math.min(Math.max(val, 0), 20));
  }, []);
  const [deadline, setDeadline] = useState(5);
  const [customTokens, setCustomTokens] = useState<TokenInfo[]>(() => {
    try {
      const stored = localStorage.getItem('tegridy_custom_tokens');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });
  // Persist custom tokens to localStorage
  useEffect(() => {
    try {
      localStorage.setItem('tegridy_custom_tokens', JSON.stringify(customTokens));
    } catch {
      // Storage full or unavailable -- ignore
    }
  }, [customTokens]);

  const { data: ethBalance } = useBalance({ address, chainId: CHAIN_ID, query: { refetchInterval: 30_000 } });

  // Derived values
  const swapType = fromToken && toToken ? getSwapType(fromToken, toToken) : null;
  const fromDecimals = fromToken?.decimals ?? 18;

  const parsedAmount = useMemo(() => {
    try {
      const val = parseFloat(inputAmount);
      if (isNaN(val) || val <= 0) return 0n;
      return parseUnits(inputAmount, fromDecimals);
    } catch {
      return 0n;
    }
  }, [inputAmount, fromDecimals]);

  // ---- Quote & Routing (delegated to useSwapQuote) ----
  const quote = useSwapQuote(fromToken, toToken, parsedAmount, slippage, address);

  // ---- Transaction writing ----
  const { writeContract, data: hash, isPending, reset, error: writeError } = useWriteContract();

  // ---- Allowance (delegated to useSwapAllowance) ----
  const allowance = useSwapAllowance(fromToken, parsedAmount, quote.selectedRoute, address, writeContract);

  // Refetch allowance and balances after successful tx + toast + auto-reset
  const { data: fromTokenBalance, refetch: refetchFromBalance } = useReadContract({
    address: (fromToken && !fromToken.isNative ? fromToken.address : WETH_ADDRESS) as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!fromToken && !fromToken.isNative, refetchInterval: 30_000 },
  });

  const { data: toTokenBalance } = useReadContract({
    address: (toToken && !toToken.isNative ? toToken.address : WETH_ADDRESS) as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address!],
    chainId: CHAIN_ID,
    query: { enabled: !!address && !!toToken && !toToken.isNative, refetchInterval: 30_000 },
  });

  const { isLoading: isConfirming, isSuccess, isError: isTxError } = useWaitForTransactionReceipt({ hash });

  // Refetch allowance and balances after successful tx + toast + auto-reset
  useEffect(() => {
    if (isSuccess && hash) {
      allowance.refetchAllowance();
      refetchFromBalance();
      toast.success('WAGMI! Swap confirmed', {
        description: `${fromToken?.symbol} → ${toToken?.symbol}`,
        action: {
          label: 'View on Etherscan',
          onClick: () => window.open(`https://etherscan.io/tx/${hash}`, '_blank'),
        },
      });
      trackSwap(fromToken?.symbol ?? '', toToken?.symbol ?? '', inputAmount, quote.selectedRoute);
      const t = setTimeout(() => { reset(); setInputAmount(''); }, 4000);
      return () => clearTimeout(t);
    }
  }, [isSuccess, hash, allowance.refetchAllowance, refetchFromBalance, fromToken, toToken, reset]);

  // Show user-friendly error toast when a write transaction fails
  useEffect(() => {
    if (writeError) {
      toast.error(decodeRevertReason(writeError));
    }
  }, [writeError]);

  // ---- Balances ----
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

  // ---- Actions ----
  const executeSwap = useCallback(() => {
    if (!address || !fromToken || !toToken || parsedAmount === 0n || insufficientBalance || !swapType) return;
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    // Prevent executing swap if approval is still needed
    if (allowance.needsApproval) { toast.error('Please approve the token first'); return; }
    // Prevent swapping a token for itself
    const fromAddr = fromToken.isNative ? WETH_ADDRESS : fromToken.address;
    const toAddr = toToken.isNative ? WETH_ADDRESS : toToken.address;
    if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
      toast.error('Cannot swap a token for itself');
      return;
    }
    // Prevent swaps with zero expected output
    if (quote.outputAmount === 0n) {
      toast.error('No output quote available — try a different amount or pair');
      return;
    }
    const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + deadline * 60);
    const { path, selectedRoute, selectedOnChainRoute, minimumReceived } = quote;
    const minReceivedRaw = minimumReceived;

    if (selectedRoute === 'aggregator') {
      // Aggregator route: use the best on-chain route with on-chain minimumReceived
      // The aggregator is used for price discovery only -- execution goes through our routers
      // Recalculate minimumReceived from the on-chain output to avoid reverts
      const onChainMin = (() => {
        const onChainOutput = selectedOnChainRoute.output;
        if (onChainOutput === 0n) return minReceivedRaw;
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
          args: [minReceivedRaw, path, address, deadlineTs],
          value: parsedAmount,
        });
      } else if (swapType === 'tokensForEth') {
        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS,
          abi: TEGRIDY_ROUTER_ABI,
          functionName: 'swapExactTokensForETH',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs],
        });
      } else {
        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS,
          abi: TEGRIDY_ROUTER_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs],
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
          args: [minReceivedRaw, path, address, deadlineTs, maxFeeBps],
          value: parsedAmount,
        });
      } else if (swapType === 'tokensForEth') {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS,
          abi: SWAP_FEE_ROUTER_ABI,
          functionName: 'swapExactTokensForETH',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs, maxFeeBps],
        });
      } else {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS,
          abi: SWAP_FEE_ROUTER_ABI,
          functionName: 'swapExactTokensForTokens',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs, maxFeeBps],
        });
      }
    }
  }, [address, chainId, fromToken, toToken, parsedAmount, insufficientBalance, swapType, deadline, quote, slippage, writeContract]);

  const flipDirection = useCallback(() => {
    const prev = fromToken;
    setFromToken(toToken);
    setToToken(prev);
    setInputAmount('');
    reset();
  }, [fromToken, toToken, reset]);

  const addCustomToken = useCallback((token: TokenInfo) => {
    // L-06: Warn users about risks of importing unverified tokens
    toast.warning('Unverified token', {
      description: `${token.symbol} is not on the default token list. Only import tokens you trust — scam tokens may steal your funds.`,
      duration: 8000,
    });
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
    outputFormatted: quote.outputFormatted,
    outputAmount: quote.outputAmount,
    priceImpact: quote.priceImpact,
    minimumReceived: quote.minimumReceivedFormatted,
    needsApproval: allowance.needsApproval,
    insufficientBalance,
    approve: allowance.approve,
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
    refetchAllowance: allowance.refetchAllowance,
    isQuoteLoading: quote.isQuoteLoading,
    routeDescription: quote.routeDescription,
    routeLabel: quote.routeLabel,
    path: quote.path,
    hasDirectPair: quote.hasDirectPair,
    intermediateAmount: quote.intermediateAmount,
    customTokens,
    addCustomToken,
    swapType,
    unlimitedApproval: allowance.unlimitedApproval,
    toggleUnlimitedApproval: allowance.toggleUnlimitedApproval,
    // Smart routing
    selectedRoute: quote.selectedRoute,
    hasTegridyPair: quote.hasTegridyPair,
    tegridyOutputFormatted: quote.tegridyOutputFormatted,
    uniOutputFormatted: quote.uniOutputFormatted,
    // Meta-aggregator (7 DEX aggregators queried in parallel)
    aggBetter: quote.aggBetter,
    aggOutputFormatted: quote.aggOutputFormatted,
    bestAggregatorName: quote.bestAggregatorName,
    allAggQuotes: quote.allAggQuotes,
    txHash: hash,
  };
}
