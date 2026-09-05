import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useReadContract, useWriteContract, useWaitForTransactionReceipt, useAccount, useBalance, useChainId, usePublicClient } from 'wagmi';
import { parseUnits, formatUnits } from 'viem';
import { toast } from 'sonner';
import { ERC20_ABI, SWAP_FEE_ROUTER_ABI, UNISWAP_V2_ROUTER_ABI } from '../lib/contracts';
import { WETH_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER, CHAIN_ID } from '../lib/constants';
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

/**
 * AUDIT FIX FE-HIGH-6: helper used both at import-time and on every page-load
 * rehydrate to confirm a localStorage entry actually matches the on-chain
 * `symbol()` and `decimals()` for the address. A phisher's localStorage write
 * could otherwise plant `{symbol:"USDC",address:"0xATTACKER",decimals:6}` and
 * the swap UI would route allowance + approve at the attacker contract.
 * Returns true if the token's on-chain shape matches the stored shape.
 */
async function verifyCustomTokenOnChain(
  token: TokenInfo,
  publicClient: ReturnType<typeof usePublicClient>,
): Promise<boolean> {
  if (!publicClient) return false;
  try {
    const [onChainSymbol, onChainDecimals] = await Promise.all([
      publicClient.readContract({
        address: token.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'symbol',
      }) as Promise<string>,
      publicClient.readContract({
        address: token.address as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }) as Promise<number>,
    ]);
    // Sanitize symbol the same way TokenSelectModal does at import-time so the
    // comparison is apples-to-apples after non-printable bytes are stripped.
    const sanitized = String(onChainSymbol ?? '').replace(/[^\x20-\x7E]/g, '').slice(0, 12);
    if (sanitized !== token.symbol) return false;
    if (Number(onChainDecimals) !== token.decimals) return false;
    return true;
  } catch {
    // RPC error / non-ERC20 / revert: treat as unverified rather than evict
    // the user's token on every flaky network blip. Caller decides whether
    // to evict or hold.
    return false;
  }
}

export function useSwap() {
  const chainId = useChainId();
  const { address } = useAccount();
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
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
    // AUDIT FIX D-FE-L1: chain-scope the storage key. Pre-fix, custom tokens
    // imported on Sepolia/test would leak into mainnet on next page load and
    // vice-versa. Address-only keys also opened a cross-chain typo path where
    // a token at the same address on a fork chain (e.g. an L2) impersonated
    // the mainnet token in the swap modal.
    const STORAGE_KEY = `tegridy_custom_tokens_v2_${CHAIN_ID}`;
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed)) return [];
      // AUDIT FIX D-FE-L2: validate every rehydrated entry against the
      // symbol-spoofing rule already enforced at import time in
      // TokenSelectModal. Without this, a malicious browser extension or a
      // separate tab could write `[{symbol:"ETH",address:"0xATTACKER",isNative:true}]`
      // and the next page load would route swap allowance + approval at the
      // attacker address. Drop any entry whose symbol collides with a
      // verified DEFAULT_TOKEN at a different address, or that fails basic
      // shape validation.
      const filtered: TokenInfo[] = [];
      for (const raw of parsed) {
        if (!raw || typeof raw !== 'object') continue;
        const t = raw as Record<string, unknown>;
        if (typeof t.symbol !== 'string' || typeof t.decimals !== 'number') continue;
        if (t.decimals < 0 || t.decimals > 18) continue;
        const sym = (t.symbol as string).toUpperCase();
        const addr = typeof t.address === 'string' ? (t.address as string).toLowerCase() : '';
        const isNative = t.isNative === true;
        // Reject native impostors entirely (only ETH is native and is in DEFAULT_TOKENS).
        if (isNative) continue;
        if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) continue;
        // Drop any entry whose symbol collides with a verified token at a
        // DIFFERENT address. Mirrors TokenSelectModal.tsx isSpoofedSymbol.
        const collides = DEFAULT_TOKENS.some(d =>
          d.symbol.toUpperCase() === sym && d.address.toLowerCase() !== addr
        );
        if (collides) continue;
        filtered.push(raw as TokenInfo);
      }
      return filtered;
    } catch {
      return [];
    }
  });
  // Persist custom tokens to localStorage
  useEffect(() => {
    const STORAGE_KEY = `tegridy_custom_tokens_v2_${CHAIN_ID}`;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(customTokens));
    } catch {
      // Storage full or unavailable -- ignore
    }
  }, [customTokens]);

  // AUDIT FIX FE-HIGH-6: re-verify every rehydrated custom token's symbol+decimals
  // against the on-chain ERC20 once we have a publicClient. The synchronous
  // localStorage filter above only catches obvious shape errors and known-
  // verified-symbol collisions; this catches an attacker that planted a
  // bespoke symbol like "USDCv2" pointing at their own contract. Any token
  // whose on-chain shape doesn't match its stored shape is dropped here so
  // the swap UI never lets the user approve against it. We only run this
  // once per address+chain so users don't get tokens evicted on every flaky
  // RPC tick.
  const verificationRanRef = useRef(false);
  useEffect(() => {
    if (verificationRanRef.current) return;
    if (!publicClient || customTokens.length === 0) return;
    if (chainId !== CHAIN_ID) return;
    verificationRanRef.current = true;
    let cancelled = false;
    (async () => {
      const verified: TokenInfo[] = [];
      const evicted: string[] = [];
      for (const token of customTokens) {
        const ok = await verifyCustomTokenOnChain(token, publicClient);
        if (cancelled) return;
        if (ok) verified.push(token);
        else evicted.push(token.symbol);
      }
      if (cancelled) return;
      if (evicted.length > 0) {
        // Only mutate if the count actually changed to avoid effect loops.
        setCustomTokens(verified);
        toast.warning(`Removed ${evicted.length} unverified token${evicted.length === 1 ? '' : 's'}`, {
          description: `On-chain symbol/decimals didn't match the stored entry for: ${evicted.join(', ')}. This can happen after a malicious browser extension or another tab tampers with storage.`,
          duration: 10_000,
        });
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicClient, chainId]);

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
  const allowance = useSwapAllowance(fromToken, parsedAmount, quote.selectedRoute, quote.selectedOnChainRoute.source, address, writeContract);

  const lastActionRef = useRef<'approve' | 'swap' | null>(null);
  // F465: guard the receipt-success effect so it handles each confirmed hash
  // exactly once. The effect re-runs every ~1s while isSuccess is latched (the
  // quote hook's staleness ticker forces re-renders), which otherwise re-fired
  // the swap toast + trackSwap repeatedly. Canonical pattern from useLPFarming.
  const lastHandledHashRef = useRef<string | null>(null);
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

  const {
    data: receipt,
    isLoading: isConfirming,
    isSuccess: isReceiptFetched,
    isError: isReceiptError,
  } = useWaitForTransactionReceipt({ chainId: CHAIN_ID, hash });
  // AUDIT (receipt-status): wagmi's `isSuccess` only means "the receipt was
  // FETCHED". A swap that REVERTED on-chain still produces a receipt, so this
  // latched true and we fired "WAGMI! Swap confirmed" + trackSwap for a trade
  // that never executed (and, on the approve leg, told the user the token was
  // approved when the allowance was unchanged). `receipt.status === 'success'`
  // is the only real success. The `!!receipt` guard is defensive: at runtime
  // wagmi always has the receipt once isSuccess is true, so it can never mask
  // a genuine revert.
  const isReverted = isReceiptFetched && !!receipt && receipt.status !== 'success';
  const isSuccess = isReceiptFetched && !isReverted;
  const isTxError = isReceiptError || isReverted;

  const [fotRetryAttempted, setFotRetryAttempted] = useState(false);

  useEffect(() => {
    if (!isSuccess || !hash) return;
    // F465: handle each confirmed hash exactly once. Without this the effect
    // re-ran every ~1s (quote staleness ticker) while isSuccess stayed latched,
    // re-firing the swap toast + trackSwap and even toasting a phantom swap
    // after a plain approve (lastActionRef was already nulled by the first run).
    if (lastHandledHashRef.current === hash) return;
    lastHandledHashRef.current = hash;
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
      // F465: id keyed on the hash so sonner de-dupes (defence in depth on top
      // of the lastHandledHashRef guard above).
      id: hash,
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

  // AUDIT (receipt-status): terminal handler for a receipt that came back
  // REVERTED. Shares `lastHandledHashRef` with the success effect so exactly
  // one of the two ever claims a given hash.
  useEffect(() => {
    if (!isReverted || !hash) return;
    if (lastHandledHashRef.current === hash) return;
    lastHandledHashRef.current = hash;
    const wasApprove = lastActionRef.current === 'approve';
    // The tx is terminal — release the in-flight latch so the user can retry,
    // and drop the submit-time snapshots so a later swap can't be tracked with
    // this dead trade's input/route.
    lastActionRef.current = null;
    isPendingRef.current = false;
    submittedInputAmountRef.current = '';
    submittedRouteRef.current = '';
    if (wasApprove) allowance.resetMultiStepApprove?.();
    // Allowance/balances may have moved even though this tx failed — re-read so
    // the CTA isn't left offering a stale next step.
    allowance.refetchAllowance();
    refetchFromBalance();
    toast.error(wasApprove ? 'Approval reverted on-chain' : 'Swap reverted on-chain', {
      id: `revert-${hash}`,
      description: wasApprove
        ? 'Your allowance was NOT changed (gas was still spent). Some tokens require resetting the allowance to 0 first — open it on the explorer for the reason, then try again.'
        : 'No tokens were swapped (gas was still spent). Usually the price moved past your slippage — raise slippage or refresh the quote and try again.',
      action: {
        label: 'View on Explorer',
        onClick: () => window.open(getTxUrl(chainId, hash), '_blank'),
      },
      duration: 10_000,
    });
  }, [isReverted, hash, allowance, refetchFromBalance, chainId]);

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
    // R033 H-01 (amended 2026-06-09): the floor must come from the venue that
    // EXECUTES. Aggregator-selected quotes still execute on the on-chain
    // fallback (SFR / Uniswap), and holding that leg to the aggregator-priced
    // minimum made the revert guaranteed-by-construction whenever the spread
    // exceeded slippage — wasted gas, never a fill. The submitted min is now
    // recomputed from the on-chain route's own output with the user's
    // slippage, and useSwapQuote displays the SAME on-chain-derived floor in
    // the "Min. Received" row, so R033's display==submit invariant holds.
    const minReceivedRaw = minimumReceived;

    if (selectedRoute === 'aggregator') {
      const { selectedOnChainRoute } = quote;
      const slippageBps = BigInt(Math.round(slippage * 100));
      const onChainMin =
        selectedOnChainRoute.output - (selectedOnChainRoute.output * slippageBps) / 10000n;
      if (selectedOnChainRoute.source === 'tegridy') {
        // FEE CAPTURE: the aggregator's on-chain fallback is the native pool — route it
        // through SwapFeeRouter so the protocol earns its fee on native execution.
        const maxFeeBps = 100n;
        if (swapType === 'ethForTokens') {
          writeContract({ chainId: CHAIN_ID, address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [onChainMin, path, address, deadlineTs, maxFeeBps], value: parsedAmount });
        } else if (swapType === 'tokensForEth') {
          writeContract({ chainId: CHAIN_ID, address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactTokensForETH', args: [parsedAmount, onChainMin, path, address, deadlineTs, maxFeeBps] });
        } else {
          writeContract({ chainId: CHAIN_ID, address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [parsedAmount, onChainMin, path, address, deadlineTs, maxFeeBps] });
        }
      } else {
        // AUDIT FIX (deep-pool routing): the on-chain fallback for an aggregator
        // quote is the real Uniswap V2 pool, so execute on the REAL Uniswap router.
        // Routing this leg through SWAP_FEE_ROUTER was wrong — SFR is wired to the
        // native TegridyRouter (our deep-POL venue), so a Uniswap-priced minOut sent
        // through it executes on the (currently thin) native pool and reverts.
        if (swapType === 'ethForTokens') {
          writeContract({ chainId: CHAIN_ID, address: UNISWAP_V2_ROUTER, abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactETHForTokens', args: [onChainMin, path, address, deadlineTs], value: parsedAmount });
        } else if (swapType === 'tokensForEth') {
          writeContract({ chainId: CHAIN_ID, address: UNISWAP_V2_ROUTER, abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactTokensForETH', args: [parsedAmount, onChainMin, path, address, deadlineTs] });
        } else {
          writeContract({ chainId: CHAIN_ID, address: UNISWAP_V2_ROUTER, abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactTokensForTokens', args: [parsedAmount, onChainMin, path, address, deadlineTs] });
        }
      }
    } else if (selectedRoute === 'tegridy') {
      // FEE CAPTURE: native-pool trades execute through SwapFeeRouter, which deducts
      // the protocol fee (SWAP_FEE_BPS) from the input before swapping on the native
      // pool. The quote already nets this fee (useSwapQuote), so minReceivedRaw is the
      // post-fee minimum and the route was only selected when it beats Uniswap net of
      // the fee — the user is never worse off than market.
      const maxFeeBps = 100n;
      if (swapType === 'ethForTokens') {
        writeContract({
          chainId: CHAIN_ID,
          address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactETHForTokens',
          args: [minReceivedRaw, path, address, deadlineTs, maxFeeBps], value: parsedAmount,
        });
      } else if (swapType === 'tokensForEth') {
        writeContract({
          chainId: CHAIN_ID,
          address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactTokensForETH',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs, maxFeeBps],
        });
      } else {
        writeContract({
          chainId: CHAIN_ID,
          address: SWAP_FEE_ROUTER_ADDRESS, abi: SWAP_FEE_ROUTER_ABI, functionName: 'swapExactTokensForTokens',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs, maxFeeBps],
        });
      }
    } else {
      // AUDIT FIX (deep-pool routing): a 'uniswap'-selected route means the real
      // Uniswap V2 pool gave the best price, so execute on the REAL Uniswap router.
      // Previously this routed through SWAP_FEE_ROUTER, which is wired to the native
      // TegridyRouter (our deep-POL venue) — so a Uniswap-priced minOut executed on
      // the thin native pool and reverted. Genuine-Uniswap trades carry no protocol
      // fee (you can't fee a trade you don't host); the protocol fee is captured on
      // native-pool ('tegridy') volume once the deep POL makes it the best venue.
      if (supportsFeeOnTransfer) {
        if (swapType === 'ethForTokens') {
          writeContract({
            chainId: CHAIN_ID,
            address: UNISWAP_V2_ROUTER, abi: UNISWAP_V2_ROUTER_ABI,
            functionName: 'swapExactETHForTokensSupportingFeeOnTransferTokens',
            args: [minReceivedRaw, path, address, deadlineTs], value: parsedAmount,
          });
        } else if (swapType === 'tokensForEth') {
          writeContract({
            chainId: CHAIN_ID,
            address: UNISWAP_V2_ROUTER, abi: UNISWAP_V2_ROUTER_ABI,
            functionName: 'swapExactTokensForETHSupportingFeeOnTransferTokens',
            args: [parsedAmount, minReceivedRaw, path, address, deadlineTs],
          });
        } else {
          writeContract({
            chainId: CHAIN_ID,
            address: UNISWAP_V2_ROUTER, abi: UNISWAP_V2_ROUTER_ABI,
            functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
            args: [parsedAmount, minReceivedRaw, path, address, deadlineTs],
          });
        }
      } else if (swapType === 'ethForTokens') {
        writeContract({
          chainId: CHAIN_ID,
          address: UNISWAP_V2_ROUTER, abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactETHForTokens',
          args: [minReceivedRaw, path, address, deadlineTs], value: parsedAmount,
        });
      } else if (swapType === 'tokensForEth') {
        writeContract({
          chainId: CHAIN_ID,
          address: UNISWAP_V2_ROUTER, abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactTokensForETH',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs],
        });
      } else {
        writeContract({
          chainId: CHAIN_ID,
          address: UNISWAP_V2_ROUTER, abi: UNISWAP_V2_ROUTER_ABI, functionName: 'swapExactTokensForTokens',
          args: [parsedAmount, minReceivedRaw, path, address, deadlineTs],
        });
      }
    }
  }, [address, chainId, fromToken, toToken, parsedAmount, insufficientBalance, swapType, deadline, quote, writeContract, supportsFeeOnTransfer, allowance.needsApproval, inputAmount]);

  const flipDirection = useCallback(() => {
    const prev = fromToken;
    setFromToken(toToken);
    setToToken(prev);
    // F240: carry the entered amount across the flip (Uniswap transposes it)
    // instead of clearing to placeholder. A fresh quote loads for the reversed
    // pair from the unchanged input. We still reset() the tx state.
    reset();
  }, [fromToken, toToken, reset]);

  const addCustomToken = useCallback(async (token: TokenInfo) => {
    // F198: refuse import on the wrong chain. The custom-token store is
    // mainnet-scoped and on-chain verification can't run, so previously a
    // wrong-chain import slipped an unverified entry into the mainnet list.
    if (chainId !== CHAIN_ID) {
      toast.error('Switch to Ethereum Mainnet to import tokens');
      return;
    }
    toast.warning('Unverified token', {
      description: `${token.symbol} is not on the default token list. Only import tokens you trust — scam tokens may steal your funds.`,
      duration: 8000,
    });
    // AUDIT FIX FE-HIGH-6: re-verify the token's symbol+decimals against the
    // on-chain ERC20 BEFORE we add it to state. TokenSelectModal already does
    // its own read via useReadContract, but a programmatic caller could skip
    // that path. Defensive double-check; mismatches are silently rejected
    // (TokenSelectModal already surfaced its own error UI in that case).
    if (publicClient) {
      const ok = await verifyCustomTokenOnChain(token, publicClient);
      if (!ok) {
        toast.error('Token verification failed', {
          description: `On-chain symbol/decimals don't match the import data for ${token.symbol}. Import refused.`,
          duration: 8000,
        });
        return;
      }
    }
    setCustomTokens(prev => {
      if (prev.find(t => t.address.toLowerCase() === token.address.toLowerCase())) return prev;
      return [...prev, token];
    });
  }, [publicClient, chainId]);

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
    // Travels WITH the number it qualifies: a consumer branching on a null impact
    // still needs to know whether it is unpriceable or simply unread.
    priceImpactUnread: quote.priceImpactUnread,
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
    // AUDIT FIX FE-HIGH-6: surface the custom-ness of the active from/to so
    // TradePage can render a permanent "unverified token" banner. Cheaper to
    // compute here once than to re-derive in the consumer.
    isFromTokenCustom: !!fromToken && !DEFAULT_TOKENS.some(d => d.address.toLowerCase() === fromToken.address.toLowerCase()),
    isToTokenCustom: !!toToken && !DEFAULT_TOKENS.some(d => d.address.toLowerCase() === toToken.address.toLowerCase()),
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
