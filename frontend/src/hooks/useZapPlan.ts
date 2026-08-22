// Turning a zap request into a plan, using the quote machinery the swap page already uses.
//
// The zap does NOT get its own price discovery. It calls `useSwapQuote`, which is the
// 7-aggregator meta-router plus the two on-chain venues, and takes the floor that hook
// already computes from whichever route will actually execute. A second quoting path
// would eventually disagree with the first, and the disagreement would be invisible: both
// numbers look plausible and only one is what gets signed.
//
// Refusing is a first-class answer here. When a leg has no route — the meta-router is down,
// the pair is empty, the amount is dust — this hook hands the planner a null and reports
// the refusal, so the panel can send the user to the manual steps instead of offering a
// button that composes a floorless swap.

import { useMemo } from 'react';
import { useAccount, useChainId, useReadContract } from 'wagmi';
import { CHAIN_ID, SWAP_FEE_ROUTER_ADDRESS, TOWELI_ADDRESS, WETH_ADDRESS } from '../lib/constants';
import { SWAP_FEE_ROUTER_ABI } from '../lib/contracts';
import { DEFAULT_TOKENS, NATIVE_ETH_ADDRESS, type TokenInfo } from '../lib/tokenList';
import { zapFeeDisclosure, type ZapFeeDisclosure } from '../lib/zap/fee';
import { planZap, type ZapDescriptor, type ZapPlanResult, type ZapSwapRoute, type ZapRoutes } from '../lib/zap/planner';
import { venueAvailability, type ZapVenueId } from '../lib/zap/venues';
import { swapSpenderFor } from '../lib/swapRouting';
import { useSwapQuote } from './useSwapQuote';

const TOWELIE_TOKEN: TokenInfo =
  DEFAULT_TOKENS.find((t) => t.address.toLowerCase() === TOWELI_ADDRESS.toLowerCase()) ?? {
    address: TOWELI_ADDRESS,
    symbol: 'TOWELI',
    name: 'Towelie',
    decimals: 18,
    logoURI: '',
  };

const ETH_TOKEN: TokenInfo =
  DEFAULT_TOKENS.find((t) => t.isNative) ?? {
    address: NATIVE_ETH_ADDRESS,
    symbol: 'ETH',
    name: 'Ether',
    decimals: 18,
    logoURI: '',
    isNative: true,
  };

export interface UseZapPlanArgs {
  venueId: ZapVenueId;
  inputToken: TokenInfo | null;
  /** Base units of the input token. */
  amountIn: bigint;
  /** Per-leg tolerance, percent, as the swap page expresses it. */
  slippagePct: number;
  lockDurationSeconds?: bigint;
}

export interface UseZapPlan {
  result: ZapPlanResult | null;
  /** True while a leg's quote is still in flight. No refusal is reported yet. */
  isQuoting: boolean;
  fee: ZapFeeDisclosure;
  /** The venue's own on-chain rate, or null when the read did not answer. */
  routerFeeBps: number | null;
}

/** A quote is usable only when it produced BOTH an output and a floor to submit. */
function toRoute(
  quote: { minimumReceived: bigint; outputAmount: bigint; selectedRoute: string; selectedOnChainRoute: { source: 'tegridy' | 'uniswap' }; path: readonly `0x${string}`[] },
  amountIn: bigint,
  slippageBps: number,
): ZapSwapRoute | null {
  if (amountIn <= 0n || quote.outputAmount <= 0n || quote.minimumReceived <= 0n) return null;
  if (quote.path.length < 2) return null;
  const executor = swapSpenderFor(quote.selectedRoute as 'tegridy' | 'uniswap' | 'aggregator', quote.selectedOnChainRoute.source);
  return {
    executor,
    executorTakesMaxFee: executor.toLowerCase() === SWAP_FEE_ROUTER_ADDRESS.toLowerCase(),
    amountIn,
    minOut: quote.minimumReceived,
    path: quote.path,
    slippageBps,
  };
}

export function useZapPlan({
  venueId,
  inputToken,
  amountIn,
  slippagePct,
  lockDurationSeconds,
}: UseZapPlanArgs): UseZapPlan {
  const { address } = useAccount();
  const chainId = useChainId();
  const slippageBps = Math.round(slippagePct * 100);

  const inputIsTowelie =
    !!inputToken && !inputToken.isNative && inputToken.address.toLowerCase() === TOWELI_ADDRESS.toLowerCase();
  const isLpFarm = venueId === 'lp-farm';

  // Which halves need a swap. Mirrors planner.ts, and is asserted against it by
  // useZapPlan.test.ts — a drift here would quote one size and submit another.
  const swapHalf = amountIn / 2n;
  const keptHalf = amountIn - swapHalf;
  const toweliLegAmount = inputIsTowelie ? 0n : isLpFarm ? swapHalf : amountIn;
  const ethLegAmount = !isLpFarm || inputToken?.isNative ? 0n : inputIsTowelie ? swapHalf : keptHalf;

  const toweliQuote = useSwapQuote(inputToken, TOWELIE_TOKEN, toweliLegAmount, slippagePct, address);
  const ethQuote = useSwapQuote(inputToken, ETH_TOKEN, ethLegAmount, slippagePct, address);

  // The venue's live fee. `null` on a failed or pending read — never coerced to zero.
  const { data: routerFee, isError: routerFeeError } = useReadContract({
    address: SWAP_FEE_ROUTER_ADDRESS,
    abi: SWAP_FEE_ROUTER_ABI,
    functionName: 'feeBps',
    chainId: CHAIN_ID,
    query: { enabled: chainId === CHAIN_ID },
  });
  const routerFeeBps =
    !routerFeeError && typeof routerFee === 'bigint' && routerFee <= 10_000n ? Number(routerFee) : null;

  const needsToweliLeg = toweliLegAmount > 0n;
  const needsEthLeg = ethLegAmount > 0n;
  const isQuoting =
    (needsToweliLeg && toweliQuote.isQuoteLoading) || (needsEthLeg && ethQuote.isQuoteLoading);

  const toweliRoute = useMemo(
    () => (needsToweliLeg ? toRoute(toweliQuote, toweliLegAmount, slippageBps) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needsToweliLeg, toweliLegAmount, slippageBps, toweliQuote.minimumReceived, toweliQuote.outputAmount, toweliQuote.selectedRoute, toweliQuote.path],
  );
  const ethRoute = useMemo(
    () => (needsEthLeg ? toRoute(ethQuote, ethLegAmount, slippageBps) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needsEthLeg, ethLegAmount, slippageBps, ethQuote.minimumReceived, ethQuote.outputAmount, ethQuote.selectedRoute, ethQuote.path],
  );

  const result = useMemo<ZapPlanResult | null>(() => {
    if (!address || !inputToken || amountIn <= 0n) return null;
    // A venue this build cannot reach is reported before a quote is even attempted.
    const availability = venueAvailability(venueId);
    if (!availability.available) {
      return { ok: false, code: 'venue-unavailable', detail: availability.reason };
    }
    if (isQuoting) return null;
    const descriptor: ZapDescriptor = {
      venueId,
      account: address,
      chainId,
      inputToken: (inputToken.isNative ? WETH_ADDRESS : inputToken.address) as `0x${string}`,
      inputSymbol: inputToken.symbol,
      inputIsNative: !!inputToken.isNative,
      amountIn: amountIn.toString(),
      slippageBps,
      lockDurationSeconds: lockDurationSeconds?.toString(),
    };
    const routes: ZapRoutes = { toTowelie: toweliRoute, toEth: ethRoute };
    return planZap(descriptor, routes, chainId);
  }, [
    address,
    inputToken,
    amountIn,
    venueId,
    chainId,
    slippageBps,
    lockDurationSeconds,
    toweliRoute,
    ethRoute,
    isQuoting,
  ]);

  const fee = useMemo(() => {
    const swapStep = result?.ok ? result.plan.steps.find((s) => s.kind === 'swap') : null;
    if (!swapStep?.route) return zapFeeDisclosure({ executor: null, routerFeeBps });
    return zapFeeDisclosure({
      executor: swapStep.route.executorTakesMaxFee ? 'swap-fee-router' : 'uniswap-v2',
      routerFeeBps,
    });
  }, [result, routerFeeBps]);

  return { result, isQuoting, fee, routerFeeBps };
}
