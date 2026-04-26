import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount, useBalance, useChainId } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI, SWAP_FEE_ROUTER_ABI, TEGRIDY_ROUTER_ABI } from '../lib/contracts';
import { WETH_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, TEGRIDY_ROUTER_ADDRESS, CHAIN_ID } from '../lib/constants';
import { type TokenInfo, DEFAULT_TOKENS } from '../lib/tokenList';
import { decodeRevertReason } from '../lib/revertDecoder';
import { trackSwap } from '../lib/analytics';
import { getTxUrl } from '../lib/explorer';
import { useSwapQuote, QUOTE_MAX_AGE_MS as _QUOTE_MAX_AGE_MS } from './useSwapQuote';
import { useSwapAllowance } from './useSwapAllowance';

// re-export so external consumers can read the constant.
export const QUOTE_MAX_AGE_MS = _QUOTE_MAX_AGE_MS;

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
  const slippage = Math.min(Math.max(slippageRaw, 0), 20);
  const setSlippage = useCallback((val: number) => {
    setSlippageRaw(Math.min(Math.max(val, 0), 20));
  }, []);
  const [deadline, setDeadline] = useState(5);
  const [supportsFeeOnTransfer, setSupportsFeeOnTransfer] = useState(false);
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

  const lastActionRef = useRef<'approve' | 'swap' | null>(null);
  // R033 H-04: in-flight ref guard prevents double-tap from firing two writeContracts.
  const isPendingRef = useRef(false);
  // R042 HIGH-1: snapshot input + route at submit so analytics doesn't read
  // the post-edit value if the user types between submit and confirm.
  const submittedInputAmountRef = useRef<string>('');
  const submittedRouteRef = useRef<string>('');

  const approveAndTag = useCallback(() => {
    if (isPendingRef.current) return;
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    lastActionRef.current = 'approve';
    isPendingRef.current = true;
    allowance.approve();
  }, [allowance, chainId]);

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

  const [fotRetryAttempted, setFotRetryAttempted] = useState(false);

  useEffect(() => {
    if (!isSuccess || !hash) return;
    allowance.refetchAllowance();
    refetchFromBalance();
    const action = lastActionRef.current;
    if (action === 'approve') {
      // R033 M-02: if a multi-step approve is in flight, the zero-write just
      // landed — kick off the second target-amount write. Keep lastActionRef
      // == 'approve' and isPendingRef == true through the second tx.
      const dispatched = allowance.continueMultiStepApprove();
      if (dispatched) {
        toast.info('Allowance reset — confirm the target approval in your wallet');
        return;
      }
      toast.success('Token approved', {
        description: `${fromToken?.symbol ?? 'Token'} ready — tap Swap when you're set.`,
      });
      lastActionRef.current = null;
      isPendingRef.current = false;
      return;
    }
    // Swap path.
    toast.success('WAGMI! Swap confirmed', {
      description: `${fromToken?.symbol} → ${toToken?.symbol}`,
      action: {
        label: 'View on Explorer',
        onClick: () => window.open(getTxUrl(chainId, hash), '_blank'),
      },
    });
    // R042 HIGH-1: read snapshots first, fall back to live closures defensively.
    const submittedInput = submittedInputAmountRef.current || inputAmount;
    const submittedRoute = submittedRouteRef.current || quote.selectedRoute;
    trackSwap(fromToken?.symbol ?? '', toToken?.symbol ?? '', submittedInput, submittedRoute);
    submittedInputAmountRef.current = '';
    submittedRouteRef.current = '';
    lastActionRef.current = null;
    isPendingRef.current = false;
    setFotRetryAttempted(false);
    const t = setTimeout(() => { reset(); setInputAmount(''); }, 4000);
    return () => clearTimeout(t);
  }, [isSuccess, hash, allowance, refetchFromBalance, fromToken, toToken, reset, chainId, inputAmount, quote.selectedRoute]);

  useEffect(() => {
    if (!writeError) return;
    // R033 H-04: clear in-flight on any write error (wallet reject / revert).
    isPendingRef.current = false;
    // R033 M-02: any failed approve (including rejected zero-write) clears
    // the multi-step machine.
    if (lastActionRef.current === 'approve') {
      allowance.resetMultiStepApprove();
    }
    const msg = decodeRevertReason(writeError);
    const raw = (writeError as { message?: string })?.message ?? String(writeError);
    const looksLikeFoT =
      !supportsFeeOnTransfer &&
      !fotRetryAttempted &&
      (raw.includes('InsufficientOutput') || raw.includes('INSUFFICIENT_OUTPUT_AMOUNT'));
    if (looksLikeFoT) {
      setFotRetryAttempted(true);
      setSupportsFeeOnTransfer(true);
      toast.info('Looks like a fee-on-transfer token', {
        description: 'Enabled FoT mode — tap Swap again to retry with the matching router path.',
        duration: 7000,
      });
      return;
    }
    toast.error(msg);
  }, [writeError, supportsFeeOnTransfer, fotRetryAttempted, allowance]);

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
    if (isPendingRef.current) return; // R033 H-04
    if (!address || !fromToken || !toToken || parsedAmount === 0n || insufficientBalance || !swapType) return;
    if (chainId !== CHAIN_ID) { toast.error('Please switch to Ethereum Mainnet'); return; }
    if (allowance.needsApproval) { toast.error('Please approve the token first'); return; }
    // R033 H-02: if the displayed quote is stale, force a refresh and bail.
    if (quote.isQuoteStale) {
      toast.error('Quote is stale — refreshing now');
      quote.refreshQuote();
      return;
    }
    // Tag the current tx as a swap so the receipt effect knows to fire the swap toast + analytics.
    lastActionRef.current = 'swap';
    isPendingRef.current = true;
    // R042 HIGH-1: snapshot at submit, BEFORE writeContract.
    submittedInputAmountRef.current = inputAmount;
    submittedRouteRef.current = quote.selectedRoute;
    // Prevent swapping a token for itself
    const fromAddr = fromToken.isNative ? WETH_ADDRESS : fromToken.address;
    const toAddr = toToken.isNative ? WETH_ADDRESS : toToken.address;
    if (fromAddr.toLowerCase() === toAddr.toLowerCase()) {
      toast.error('Cannot swap a token for itself');
      isPendingRef.current = false;
      return;
    }
    if (quote.outputAmount === 0n) {
      toast.error('No output quote available — try a different amount or pair');
      isPendingRef.current = false;
      return;
    }
    const deadlineTs = BigInt(Math.floor(Date.now() / 1000) + deadline * 60);
    const { path, selectedRoute, minimumReceived } = quote;
    // R033 H-01: bind the displayed minOut directly. Aggregator path now
    // submits `quote.minimumReceived` — the exact value rendered in the
    // "Min. Received" UI row — instead of re-deriving from the on-chain leg.
    // Trade-off: aggregator selected but execution still routes through an
    // on-chain router; if the on-chain leg returns less the swap reverts.
    // That's the desired contract — user gets the price they signed for or
    // no swap. Matches 1inch / Paraswap / Uniswap behaviour.
    const minReceivedRaw = minimumReceived;

    if (selectedRoute === 'aggregator') {
      const onChainMin = minReceivedRaw;
      const { selectedOnChainRoute } = quote;
      if (selectedOnChainRoute.source === 'tegridy') {
        if (swapType === 'ethForTokens') {
          writeContract({ address: TEGRIDY_ROUTER_ADDRESS, abi: TEGRIDY_ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [onChainMin, path, address, deadlineTs], value: parsedAmount });
        } else if (swapType === 'tokensForEth') {
          writeContract({ address: TEGRIDY_ROUTER_ADDRESS, abi: TEGRIDY_ROUTER_ABI, functionName: 'swapExactTokensForETH', args: [parsedAmount, onChainMin, path, address, deadlineTs] });
        } else {
          writeContract({ address: TEGRIDY_ROUTER_ADDRESS, abi: TEGRIDY_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [parsedAmount, onChainMin, path, address, deadlineTs] });
        }
      } else {
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
      if (swapType === 'ethForTokens') {
        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS, abi: TEGRIDY_ROUTER_ABI, functionName: 'swapExactETHForTokens',
          args: [minReceivedRaw, path, address, deadlineTs], value: parsedAmount,
        });
      } else if (swapType === 'tokensForEth') {
        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS, abi: TEGRIDY_ROUTER_ABI, functionName: 'swapExactTokensForETH',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs],
        });
      } else {
        writeContract({
          address: TEGRIDY_ROUTER_ADDRESS, abi: TEGRIDY_ROUTER_ABI, functionName: 'swapExactTokensForTokens',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs],
        });
      }
    } else {
      const maxFeeBps = 100n;
      if (supportsFeeOnTransfer) {
        if (swapType === 'ethForTokens') {
          writeContract({
            address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI,
            functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
            args: [minReceivedRaw, path, address, deadlineTs, maxFeeBps], value: parsedAmount,
          });
        } else if (swapType === 'tokensForEth') {
          writeContract({
            address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI,
            functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
            args: [parsedAmount, minReceivedRaw, path, address, deadlineTs, maxFeeBps],
          });
        } else {
          writeContract({
            address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI,
            functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
            args: [parsedAmount, minReceivedRaw, path, address, deadlineTs, maxFeeBps],
          });
        }
      } else if (swapType === 'ethForTokens') {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactETHForTokens',
          args: [minReceivedRaw, path, address, deadlineTs, maxFeeBps], value: parsedAmount,
        });
      } else if (swapType === 'tokensForEth') {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactTokensForETH',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs, maxFeeBps],
        });
      } else {
        writeContract({
          address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactTokensForTokens',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs, maxFeeBps],
        });
      }
    }
  }, [address, chainId, fromToken, toToken, parsedAmount, insufficientBalance, swapType, deadline, quote, writeContract, supportsFeeOnTransfer, allowance.needsApproval, inputAmount]);

  const flipDirection = useCallback(() => {
    const prev = fromToken;
    setFromToken(toToken);
    setToToken(prev);
    setInputAmount('');
    reset();
  }, [fromToken, toToken, reset]);

  const addCustomToken = useCallback((token: TokenInfo) => {
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
    approve: approveAndTag,
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
    isApprovingMultiStep: allowance.isApprovingMultiStep,
    selectedRoute: quote.selectedRoute,
    hasTegridyPair: quote.hasTegridyPair,
    tegridyOutputFormatted: quote.tegridyOutputFormatted,
    uniOutputFormatted: quote.uniOutputFormatted,
    aggBetter: quote.aggBetter,
    aggOutputFormatted: quote.aggOutputFormatted,
    bestAggregatorName: quote.bestAggregatorName,
    allAggQuotes: quote.allAggQuotes,
    txHash: hash,
    supportsFeeOnTransfer,
    setSupportsFeeOnTransfer,
    // R033 H-02: quote freshness surface
    isQuoteStale: quote.isQuoteStale,
    quoteFetchedAt: quote.quoteFetchedAt,
    refreshQuote: quote.refreshQuote,
  };
}
