import { SWAP_FEE_ROUTER_ADDRESS, UNISWAP_V2_ROUTER } from './constants';
import type { RouteSource } from '../hooks/useSwapQuote';

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
 */
export function swapSpenderFor(
  selectedRoute: RouteSource,
  onChainSource: 'tegridy' | 'uniswap',
): `0x${string}` {
  const venue = selectedRoute === 'aggregator' ? onChainSource : selectedRoute;
  return venue === 'tegridy' ? SWAP_FEE_ROUTER_ADDRESS : UNISWAP_V2_ROUTER;
}
