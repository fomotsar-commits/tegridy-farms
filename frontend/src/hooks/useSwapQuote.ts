import { useMemo, useEffect, useState, useRef, useCallback } from 'react';
import { useReadContract, useChainId } from 'wagmi';
import { formatUnits } from 'viem';
import { UNISWAP_V2_ROUTER_ABI, UNISWAP_V2_FACTORY_ABI, UNISWAP_V2_PAIR_ABI, TEGRIDY_ROUTER_ABI, TEGRIDY_FACTORY_ABI, SWAP_FEE_ROUTER_ABI } from '../lib/contracts';
import { UNISWAP_V2_ROUTER, WETH_ADDRESS, UNISWAP_V2_FACTORY, TEGRIDY_FACTORY_ADDRESS, TEGRIDY_ROUTER_ADDRESS, SWAP_FEE_ROUTER_ADDRESS, CHAIN_ID, SWAP_FEE_BPS, isDeployed } from '../lib/constants';
import { type TokenInfo } from '../lib/tokenList';
import { getAggregatorPrice, calculateAggregatorSpread, AGGREGATOR_NAMES, type AggregatorQuote, type AggregatorSource } from '../lib/aggregator';

export type RouteSource = 'tegridy' | 'uniswap' | 'aggregator';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;
// Stable empty-path reference so the path memo (and the return-object memo that
// depends on it) keep a constant identity when no tokens are selected.
const EMPTY_PATH: `0x${string}`[] = [];

// The native ('tegridy') route executes through SwapFeeRouter, which deducts a protocol
// fee from the input. We compare and quote the native route NET of that fee, so it's
// only selected when it genuinely beats Uniswap for the user (i.e. when the deep native
// pool's lower slippage outweighs the fee) — never worse than going direct to Uniswap.
const SWAP_FEE_BPS_BI = BigInt(SWAP_FEE_BPS);

// R033 H-02: max age of an outstanding quote before we force a refresh.
// Matches the Uniswap Interface gate; 30s is well under the 5min default
// router deadline but still long enough to not flap on slow networks.
export const QUOTE_MAX_AGE_MS = 30_000;

// Build the swap path: always route through WETH if neither token is WETH/ETH
export function buildPath(fromToken: TokenInfo, toToken: TokenInfo): `0x${string}`[] {
  const fromAddr = fromToken.isNative ? WETH_ADDRESS : fromToken.address as `0x${string}`;
  const toAddr = toToken.isNative ? WETH_ADDRESS : toToken.address as `0x${string}`;

  // Direct pair (one of them is WETH or they share a direct pair)
  if (fromAddr.toLowerCase() === WETH_ADDRESS.toLowerCase() || toAddr.toLowerCase() === WETH_ADDRESS.toLowerCase()) {
    return [fromAddr, toAddr];
  }

  // Route through WETH as intermediate
  return [fromAddr, WETH_ADDRESS, toAddr];
}

export interface SwapQuoteResult {
  outputAmount: bigint;
  outputFormatted: string;
  priceImpact: number;
  minimumReceived: bigint;
  minimumReceivedFormatted: string;
  isQuoteLoading: boolean;
  selectedRoute: RouteSource;
  selectedOnChainRoute: { source: 'tegridy' | 'uniswap'; output: bigint };
  hasTegridyPair: boolean;
  tegridyOutputFormatted: string | null;
  uniOutputFormatted: string | null;
  aggBetter: boolean;
  aggOutputFormatted: string | null;
  bestAggregatorName: string | null;
  allAggQuotes: AggregatorQuote[];
  routeDescription: string[];
  routeLabel: string;
  hasDirectPair: boolean;
  intermediateAmount: bigint | undefined;
  path: `0x${string}`[];
  activeAmountsOut: readonly bigint[] | undefined;
  // R033 H-02: quote freshness surface
  quoteFetchedAt: number;
  isQuoteStale: boolean;
  refreshQuote: () => void;
}

export function useSwapQuote(
  fromToken: TokenInfo | null,
  toToken: TokenInfo | null,
  parsedAmount: bigint,
  slippage: number,
  address: `0x${string}` | undefined,
): SwapQuoteResult {
  const fromDecimals = fromToken?.decimals ?? 18;
  const toDecimals = toToken?.decimals ?? 18;
  // R042 HIGH-2: memoise the path so it isn't a fresh array every render — a new
  // identity here was defeating the return-object memo (and routeDescription,
  // also path-deped) by flipping their identity on every render.
  const path = useMemo<`0x${string}`[]>(
    () => (fromToken && toToken ? buildPath(fromToken, toToken) : EMPTY_PATH),
    [fromToken, toToken],
  );

  // All configured contract addresses are for CHAIN_ID (Ethereum mainnet). On any other
  // chain, the wagmi read calls silently return garbage (either an empty 0x response from
  // a nonexistent contract or — worse — data from a different contract at the same address
  // on another chain). Gate every read with a chain match.
  const chainId = useChainId();
  const onRightChain = chainId === CHAIN_ID;

  // Track which inputAmount generated each aggregator quote to discard stale results
  const quoteRequestIdRef = useRef(0);
  // F467: a state-based counter included in the aggregator fetch-effect deps so
  // refreshQuote can actually re-fire the aggregator leg. (Bumping the ref alone
  // never re-ran the effect, so refresh silently lost the 7-aggregator
  // comparison.) The ref above still orders in-flight responses.
  const [aggRequestId, setAggRequestId] = useState(0);

  // F200: read the live protocol fee from SwapFeeRouter once (single cacheable
  // view, pinned to mainnet) so the netting + the "(incl. X% fee)" disclosure
  // track on-chain truth if the owner retunes feeBps. Falls back to the
  // SWAP_FEE_BPS constant when the read hasn't landed or the router isn't deployed.
  const { data: liveFeeBps } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SWAP_FEE_ROUTER_ABI,
    functionName: 'feeBps',
    chainId: CHAIN_ID,
    query: { enabled: isDeployed(SWAP_FEE_ROUTER_ADDRESS), staleTime: 5 * 60_000 },
  });
  // Sanity-clamp: a sane protocol fee is 0..1000 bps (≤10%). Outside that we
  // keep the audited constant rather than display/net on a garbage read.
  const feeBpsBi = (typeof liveFeeBps === 'bigint' && liveFeeBps >= 0n && liveFeeBps <= 1000n)
    ? liveFeeBps
    : SWAP_FEE_BPS_BI;
  const feeBpsNum = Number(feeBpsBi);

  // ---- Uniswap V2 quote ----
  const { data: uniAmountsOut, isLoading: isUniQuoteLoading, refetch: refetchUni } = useReadContract({
    address: UNISWAP_V2_ROUTER,
    abi: UNISWAP_V2_ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [parsedAmount, path],
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && parsedAmount > 0n && path.length >= 2 },
  });

  // ---- Tegridy DEX: check own pools ----
  const fromAddrForPair = fromToken?.isNative ? WETH_ADDRESS : (fromToken?.address ?? WETH_ADDRESS);
  const toAddrForPair = toToken?.isNative ? WETH_ADDRESS : (toToken?.address ?? WETH_ADDRESS);
  const pairsEnabled = onRightChain && !!fromToken && !!toToken && fromAddrForPair.toLowerCase() !== toAddrForPair.toLowerCase();

  // Check if Tegridy Factory has a pair for these tokens
  const { data: tegridyPairAddr } = useReadContract({
    address: TEGRIDY_FACTORY_ADDRESS,
    abi: TEGRIDY_FACTORY_ABI,
    functionName: 'getPair',
    args: [fromAddrForPair as `0x${string}`, toAddrForPair as `0x${string}`],
    chainId: CHAIN_ID,
    query: { enabled: pairsEnabled },
  });

  const hasTegridyPair = !!tegridyPairAddr && tegridyPairAddr !== ZERO_ADDR;

  // Get quote from Tegridy Router (only if own pair exists)
  const { data: tegridyAmountsOut, isLoading: isTegridyQuoteLoading, refetch: refetchTegridy } = useReadContract({
    address: TEGRIDY_ROUTER_ADDRESS,
    abi: TEGRIDY_ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [parsedAmount, path],
    chainId: CHAIN_ID,
    query: { enabled: hasTegridyPair && parsedAmount > 0n && path.length >= 2 },
  });

  // Also check Uniswap factory for direct pair (for routing info display)
  const { data: directPair } = useReadContract({
    address: UNISWAP_V2_FACTORY,
    abi: UNISWAP_V2_FACTORY_ABI,
    functionName: 'getPair',
    args: [fromAddrForPair as `0x${string}`, toAddrForPair as `0x${string}`],
    chainId: CHAIN_ID,
    query: { enabled: pairsEnabled },
  });

  const hasDirectPair = !!directPair && directPair !== ZERO_ADDR;

  // For direct swaps, use the directPair; for multi-hop, look up both leg pairs
  const isMultiHop = path.length > 2;
  const primaryPairAddr = !isMultiHop ? directPair : undefined;

  const { data: leg1Pair } = useReadContract({
    address: UNISWAP_V2_FACTORY,
    abi: UNISWAP_V2_FACTORY_ABI,
    functionName: 'getPair',
    args: [path[0] as `0x${string}`, WETH_ADDRESS],
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && isMultiHop && path.length === 3 && parsedAmount > 0n },
  });

  const { data: leg2Pair } = useReadContract({
    address: UNISWAP_V2_FACTORY,
    abi: UNISWAP_V2_FACTORY_ABI,
    functionName: 'getPair',
    args: [WETH_ADDRESS, path[2] as `0x${string}`],
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && isMultiHop && path.length === 3 && parsedAmount > 0n },
  });

  const validLeg1 = leg1Pair && leg1Pair !== ZERO_ADDR;
  const validLeg2 = leg2Pair && leg2Pair !== ZERO_ADDR;

  const { data: reserves } = useReadContract({
    address: primaryPairAddr as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'getReserves',
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && !!primaryPairAddr && primaryPairAddr !== ZERO_ADDR && parsedAmount > 0n, refetchInterval: 30_000 },
  });

  const { data: token0 } = useReadContract({
    address: primaryPairAddr as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'token0',
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && !!primaryPairAddr && primaryPairAddr !== ZERO_ADDR },
  });

  const { data: leg1Reserves } = useReadContract({
    address: leg1Pair as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'getReserves',
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && !!validLeg1 && parsedAmount > 0n, refetchInterval: 30_000 },
  });

  const { data: leg1Token0 } = useReadContract({
    address: leg1Pair as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'token0',
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && !!validLeg1 && parsedAmount > 0n },
  });

  const { data: leg2Reserves } = useReadContract({
    address: leg2Pair as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'getReserves',
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && !!validLeg2 && parsedAmount > 0n, refetchInterval: 30_000 },
  });

  const { data: leg2Token0 } = useReadContract({
    address: leg2Pair as `0x${string}`,
    abi: UNISWAP_V2_PAIR_ABI,
    functionName: 'token0',
    chainId: CHAIN_ID,
    query: { enabled: onRightChain && !!validLeg2 && parsedAmount > 0n },
  });

  // ---- Meta-aggregator: queries 7 DEX aggregators in parallel ----
  const [aggQuoteResult, setAggQuoteResult] = useState<{ amountOut: string; priceImpact: number; source: AggregatorSource; allQuotes: AggregatorQuote[] } | null>(null);

  // R033 H-02: stamp on every quote settle (success or failure path on either
  // aggregator OR on-chain leg). 0 means "no quote landed yet" — UI checks
  // staleness via isQuoteStale instead of inspecting this directly.
  const [quoteFetchedAt, setQuoteFetchedAt] = useState<number>(0);
  // 1s tick to flip isQuoteStale reactively past the 30s window.
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    if (!fromToken || !toToken || parsedAmount === 0n || !address) {
      setAggQuoteResult(null);
      return;
    }
    // Increment request ID so stale responses from prior inputs are discarded
    const currentRequestId = ++quoteRequestIdRef.current;
    const abortController = new AbortController();
    const sellToken = fromToken.isNative ? 'ETH' : fromToken.address;
    const buyToken = toToken.isNative ? 'ETH' : toToken.address;
    const timer = setTimeout(() => {
      // AUDIT R045 H1: pass the connected wallet's chainId so the meta-
      // aggregator short-circuits on unsupported chains (no HTTP calls go
      // out and "best route" never returns mainnet liquidity for an L2 user).
      // F199: forward the user's slippage tolerance to the aggregator quote
      // (was hardcoded undefined → always DEFAULT_MAX_SLIPPAGE_PCT). The
      // downstream clampSlippage bounds it, so venues that consume slippage at
      // quote time reflect the user's actual setting.
      getAggregatorPrice(sellToken, buyToken, parsedAmount.toString(), address, chainId, slippage, fromDecimals, abortController.signal)
        .then(q => {
          // Only apply if this is still the latest request
          if (!abortController.signal.aborted && quoteRequestIdRef.current === currentRequestId) {
            setAggQuoteResult(q);
            setQuoteFetchedAt(Date.now());
          }
        })
        .catch(() => {
          if (!abortController.signal.aborted && quoteRequestIdRef.current === currentRequestId) {
            setAggQuoteResult(null);
            // Stamp on failure too so the UI has an anchor — falling back to
            // on-chain leg is a successful "I have a quote" outcome.
            setQuoteFetchedAt(Date.now());
          }
        });
    }, 800);
    return () => { abortController.abort(); clearTimeout(timer); };
    // F467: aggRequestId in the deps lets refreshQuote re-fire this effect.
    // F199: slippage in the deps re-quotes when the user changes tolerance.
  }, [fromToken, toToken, parsedAmount, address, fromDecimals, chainId, aggRequestId, slippage]);

  // Stamp on every wagmi on-chain leg arrival.
  useEffect(() => {
    if (uniAmountsOut !== undefined || tegridyAmountsOut !== undefined) {
      setQuoteFetchedAt(Date.now());
    }
  }, [uniAmountsOut, tegridyAmountsOut]);

  // 1s ticker — only runs once a quote has landed, idle pre-input.
  useEffect(() => {
    if (quoteFetchedAt === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [quoteFetchedAt]);

  // ---- Smart Route Selection ----
  const uniOutputAmount = uniAmountsOut ? (uniAmountsOut[uniAmountsOut.length - 1] ?? 0n) : 0n;
  const tegridyOutputAmount = tegridyAmountsOut ? (tegridyAmountsOut[tegridyAmountsOut.length - 1] ?? 0n) : 0n;
  // Native route runs through SwapFeeRouter (fee deducted from input), so its effective
  // output to the user is reduced by SWAP_FEE_BPS. Quote and compare on this net figure.
  // (Linear haircut is conservative: the true output of swapping `in*(1-fee)` is slightly
  // higher than `out*(1-fee)` by AMM concavity, so the derived minOut never reverts.)
  const tegridyOutputAfterFee = tegridyOutputAmount > 0n
    ? (tegridyOutputAmount * (10000n - feeBpsBi)) / 10000n
    : 0n;

  let aggOutputAmount = 0n;
  try {
    aggOutputAmount = aggQuoteResult?.amountOut ? BigInt(aggQuoteResult.amountOut) : 0n;
  } catch {
    // Invalid amountOut from aggregator -- ignore
  }

  // Best aggregator source name for display
  const bestAggregatorName = aggQuoteResult?.source ? AGGREGATOR_NAMES[aggQuoteResult.source] : null;
  const allAggQuotes = aggQuoteResult?.allQuotes ?? [];

  // Select best on-chain route: native (NET of its protocol fee) vs Uniswap.
  const selectedOnChainRoute: { source: 'tegridy' | 'uniswap'; output: bigint } = useMemo(() => {
    if (tegridyOutputAfterFee > 0n && uniOutputAmount > 0n) {
      // Native wins only when, AFTER its protocol fee, it still delivers >= Uniswap.
      // No artificial preference — the deep POL has to earn the routing on price, so the
      // user is never worse off than going direct to Uniswap while the treasury earns.
      if (tegridyOutputAfterFee >= uniOutputAmount) {
        return { source: 'tegridy', output: tegridyOutputAfterFee };
      }
      return { source: 'uniswap', output: uniOutputAmount };
    }
    if (tegridyOutputAfterFee > 0n) return { source: 'tegridy', output: tegridyOutputAfterFee };
    return { source: 'uniswap', output: uniOutputAmount };
  }, [tegridyOutputAfterFee, uniOutputAmount]);

  // Aggregator comparison against the best on-chain route
  const aggComparison = useMemo(
    () => calculateAggregatorSpread(selectedOnChainRoute.output, aggOutputAmount),
    [selectedOnChainRoute.output, aggOutputAmount],
  );

  const aggBetter = aggComparison.shouldUseAggregator;

  // Final route selection: automatically pick the best route across all 9 sources
  const selectedRoute: RouteSource = useMemo(() => {
    if (aggBetter) return 'aggregator';
    return selectedOnChainRoute.source;
  }, [aggBetter, selectedOnChainRoute.source]);

  // R033 display==submit: this MUST be the output of the route that actually
  // executes. executeSwap never calls an aggregator — for selectedRoute
  // 'aggregator' it still submits `selectedOnChainRoute` via SwapFeeRouter or
  // Uniswap V2 (useSwap.ts). Previously this showed the aggregator's (higher)
  // quote as "You Receive" while signing the on-chain route, i.e. a number the
  // transaction could not deliver. The aggregator comparison is still surfaced
  // as context in routeLabel, but never as the headline figure.
  const outputAmount = selectedOnChainRoute.output;
  const outputFormatted = useMemo(
    () => formatUnits(outputAmount, toDecimals),
    [outputAmount, toDecimals],
  );

  // Use the correct amountsOut for the selected route (for price impact / intermediate display)
  const activeAmountsOut = selectedRoute === 'tegridy' ? tegridyAmountsOut : uniAmountsOut;

  // Intermediate amount (for multi-hop route display)
  const intermediateAmount = activeAmountsOut && activeAmountsOut.length === 3 ? activeAmountsOut[1] : undefined;

  const isQuoteLoading = isUniQuoteLoading || (hasTegridyPair && isTegridyQuoteLoading);

  // Price impact calculation
  const priceImpact = useMemo(() => {
    if (parsedAmount === 0n || outputAmount === 0n || !fromToken || !toToken) return 0;

    if (path.length > 2) {
      if (!activeAmountsOut || activeAmountsOut.length < 3) return 0;
      if (!leg1Reserves || !leg1Token0 || !leg2Reserves || !leg2Token0) return 0;

      try {
        const fromAddr = (fromToken.isNative ? WETH_ADDRESS : fromToken.address).toLowerCase();
        const isLeg1Token0From = leg1Token0.toLowerCase() === fromAddr;
        const r1In = isLeg1Token0From ? (leg1Reserves[0] ?? 0n) : (leg1Reserves[1] ?? 0n);
        const r1Out = isLeg1Token0From ? (leg1Reserves[1] ?? 0n) : (leg1Reserves[0] ?? 0n);
        if (r1In <= 0n || r1Out <= 0n) return 0.5;

        const midPrice1 = (r1Out * 10n ** 18n) / r1In;
        const execPrice1 = ((activeAmountsOut[1] ?? 0n) * 10n ** 18n) / (activeAmountsOut[0] ?? 1n);
        const ratio1 = midPrice1 > 0n ? (execPrice1 * 10n ** 18n) / midPrice1 : 10n ** 18n;

        const isLeg2Token0Weth = leg2Token0.toLowerCase() === WETH_ADDRESS.toLowerCase();
        const r2In = isLeg2Token0Weth ? (leg2Reserves[0] ?? 0n) : (leg2Reserves[1] ?? 0n);
        const r2Out = isLeg2Token0Weth ? (leg2Reserves[1] ?? 0n) : (leg2Reserves[0] ?? 0n);
        if (r2In <= 0n || r2Out <= 0n) return 0.5;

        const midPrice2 = (r2Out * 10n ** 18n) / r2In;
        const execPrice2 = ((activeAmountsOut[2] ?? 0n) * 10n ** 18n) / (activeAmountsOut[1] ?? 1n);
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
      // F197: derive the exec price from the EXECUTING on-chain route's own
      // output, not the headline `outputAmount` (which may be the higher,
      // unexecutable aggregator estimate). Mixing an aggregator price above the
      // pool mid-price with Uniswap reserves produced a positive "impact" for a
      // favorable quote. Fall back to outputAmount only when the on-chain leg
      // hasn't resolved.
      const execOut = activeAmountsOut && activeAmountsOut.length >= 2
        ? (activeAmountsOut[activeAmountsOut.length - 1] ?? outputAmount)
        : outputAmount;
      if (execOut === 0n) return 0;
      const execPriceScaled = (execOut * 10n ** 18n) / parsedAmount;
      // Clamp favorable diffs (exec better than mid) to 0 — only adverse
      // movement is "price impact".
      if (execPriceScaled >= midPriceScaled) return 0;
      const diff = midPriceScaled - execPriceScaled;
      const impactBps = (diff * 10000n) / midPriceScaled;
      return Number(impactBps) / 100;
    } catch {
      return 0;
    }
  }, [reserves, token0, parsedAmount, outputAmount, fromToken, toToken, path, activeAmountsOut, leg1Reserves, leg1Token0, leg2Reserves, leg2Token0]);

  // Slippage-protected minimum.
  // R033 H-01 (amended 2026-06-09): the floor derives from the venue that
  // EXECUTES. Aggregator-won quotes still execute on the on-chain fallback
  // (SFR / Uniswap), so basing the floor on the aggregator's higher estimate
  // guaranteed a revert whenever the spread exceeded slippage. The displayed
  // "Min. Received" and the submitted minOut (useSwap recomputes the same
  // formula) are both anchored to the on-chain route's own output —
  // display == submit holds, and the floor is actually fillable.
  const minimumReceived = useMemo(() => {
    const basis = aggBetter ? selectedOnChainRoute.output : outputAmount;
    if (basis === 0n) return 0n;
    const slippageBps = BigInt(Math.round(slippage * 100));
    return basis - (basis * slippageBps) / 10000n;
  }, [outputAmount, slippage, aggBetter, selectedOnChainRoute.output]);

  const minimumReceivedFormatted = useMemo(
    () => formatUnits(minimumReceived, toDecimals),
    [minimumReceived, toDecimals],
  );

  // Route description for display
  const routeDescription = useMemo(() => {
    if (!fromToken || !toToken) return [];
    if (path.length === 2) {
      return [fromToken.symbol, toToken.symbol];
    }
    return [fromToken.symbol, 'WETH', toToken.symbol];
  }, [fromToken, toToken, path]);

  const routeLabel = useMemo(() => {
    // Name the venue that ACTUALLY executes. When an aggregator quotes higher we
    // disclose that as context rather than claiming to route through it — the
    // swap is still submitted on-chain via SwapFeeRouter / Uniswap V2.
    if (selectedRoute === 'aggregator') {
      const execDex = selectedOnChainRoute.source === 'tegridy' ? 'Tegridy DEX' : 'Uniswap V2';
      const who = bestAggregatorName ?? 'An aggregator';
      return `Swapping via ${execDex} — ${who} quotes more, but isn't routable in-app`;
    }
    const dex = selectedRoute === 'tegridy' ? 'Tegridy DEX' : 'Uniswap V2';
    // Native route carries the protocol fee; disclose it (the shown output already nets it).
    const feeNote = selectedRoute === 'tegridy' ? ` (incl. ${feeBpsNum / 100}% fee)` : '';
    if (path.length <= 2) return `Direct swap via ${dex}${feeNote}`;
    return `Routed through WETH via ${dex}${feeNote}`;
  }, [path, selectedRoute, bestAggregatorName, feeBpsNum, selectedOnChainRoute.source]);

  // R033 H-02: stale flag flips reactively when (now - quoteFetchedAt) > MAX.
  const isQuoteStale = useMemo(
    () => quoteFetchedAt > 0 && (now - quoteFetchedAt) > QUOTE_MAX_AGE_MS,
    [now, quoteFetchedAt],
  );

  const refreshQuote = useCallback(() => {
    refetchUni();
    if (hasTegridyPair) refetchTegridy();
    // F467: the aggregator leg is a fetch effect keyed on aggRequestId — bump
    // the state counter so the effect actually re-runs (the old ref bump didn't
    // change any dep, so the aggregator leg was lost until the user re-typed).
    setAggQuoteResult(null);
    setAggRequestId((n) => n + 1);
    // Stamp now rather than 0: the on-chain stamp effect won't re-fire if the
    // refetched amounts are structurally identical, which would otherwise leave
    // quoteFetchedAt stuck at 0. A fresh stamp also resets the staleness window.
    setQuoteFetchedAt(Date.now());
  }, [refetchUni, refetchTegridy, hasTegridyPair]);

  // Net of the protocol fee — this is what the user actually receives on the native
  // route, so the route-comparison panel shows an honest (not pre-fee) number.
  const tegridyOutputFormatted = useMemo(
    () => tegridyOutputAfterFee > 0n ? formatUnits(tegridyOutputAfterFee, toDecimals) : null,
    [tegridyOutputAfterFee, toDecimals],
  );
  const uniOutputFormatted = useMemo(
    () => uniOutputAmount > 0n ? formatUnits(uniOutputAmount as bigint, toDecimals) : null,
    [uniOutputAmount, toDecimals],
  );
  const aggOutputFormatted = useMemo(
    () => aggOutputAmount > 0n ? formatUnits(aggOutputAmount, toDecimals) : null,
    [aggOutputAmount, toDecimals],
  );

  // R042 HIGH-2: wrap entire return in useMemo so consumers don't see a fresh
  // identity on every render. Deps are stable primitives + memoised pieces;
  // identity flips only when an actual quote field changes.
  return useMemo<SwapQuoteResult>(() => ({
    outputAmount,
    outputFormatted,
    priceImpact,
    minimumReceived,
    minimumReceivedFormatted,
    isQuoteLoading,
    selectedRoute,
    selectedOnChainRoute,
    hasTegridyPair,
    tegridyOutputFormatted,
    uniOutputFormatted,
    aggBetter,
    aggOutputFormatted,
    bestAggregatorName,
    allAggQuotes,
    routeDescription,
    routeLabel,
    hasDirectPair: !!hasDirectPair,
    intermediateAmount,
    path: path as `0x${string}`[],
    activeAmountsOut,
    quoteFetchedAt,
    isQuoteStale,
    refreshQuote,
  }), [
    outputAmount, outputFormatted, priceImpact, minimumReceived, minimumReceivedFormatted,
    isQuoteLoading, selectedRoute, selectedOnChainRoute, hasTegridyPair,
    tegridyOutputFormatted, uniOutputFormatted, aggBetter, aggOutputFormatted, bestAggregatorName,
    allAggQuotes, routeDescription, routeLabel, hasDirectPair, intermediateAmount,
    path, activeAmountsOut, quoteFetchedAt, isQuoteStale, refreshQuote,
  ]);
}
