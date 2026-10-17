import { SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER } from './constants';
import type { RouteSource } from '../hooks/useSwapQuote';
import type { SwapVenue } from './chains/swapVenue';

/** The two executors a swap can approve, on Ethereum unless a venue is passed. */
const MAINNET_EXECUTORS: Pick<SwapVenue, 'swapFeeRouter' | 'uniswapV2Router'> = {
  swapFeeRouter: SWAP_FEE_ROUTER_ADDRESS,
  uniswapV2Router: UNISWAP_V2_ROUTER,
};

/**
 * The contract a user must APPROVE to spend their input token for a swap — i.e.
 * the contract that calls `transferFrom(msg.sender)` in useSwap.ts's execution
 * path. This is the single source of truth shared by useSwap (executor) and
 * useSwapAllowance (approval spender): they MUST agree, or every ERC20-input
 * swap reverts at gas estimation. (F186 regression: the allowance hook approved
 * the bare TegridyRouter / SFR while useSwap executed via SFR / UniswapV2Router.)
 *
 * Venue → executor (mirrors the branch addresses in useSwap.ts:393-495):
 *   tegridy    → SwapFeeRouter (SFR forwards to the native TegridyRouter,
 *                pulling the input via transferFrom(msg.sender))
 *   uniswap    → UniswapV2Router (pulls the input directly)
 *   aggregator → its on-chain fallback venue, i.e. selectedOnChainRoute.source
 *
 * Keep `swapRouting.test.ts` in lockstep with the useSwap executor addresses.
 *
 * `executors` is the quoted chain's pair (a SwapVenue); omitted, Ethereum's, which
 * is what the zap plan uses.
 */
export function swapSpenderFor(
  selectedRoute: RouteSource,
  onChainSource: 'tegridy' | 'uniswap',
  executors: Pick<SwapVenue, 'swapFeeRouter' | 'uniswapV2Router'> = MAINNET_EXECUTORS,
): `0x${string}` {
  const route = selectedRoute === 'aggregator' ? onChainSource : selectedRoute;
  return route === 'tegridy' ? executors.swapFeeRouter : executors.uniswapV2Router;
}
