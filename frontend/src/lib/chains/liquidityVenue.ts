import type { Address } from './types';
import { getChainConfig } from './registry';

/**
 * The router, factory and WETH for ONE chain, resolved together.
 *
 * 🔴 WHY THIS IS ONE OBJECT AND NOT THREE LOOKUPS. Seven addresses in this repo
 * are a different, LIVE contract on a different chain — deterministic CREATE
 * reused nonces across deploys. Two of them are exactly the constants the
 * liquidity path used to import:
 *
 *   TEGRIDY_ROUTER_ADDRESS  0xe9f83a07…  is Robinhood's swapFeeRouter
 *   TEGRIDY_FACTORY_ADDRESS 0xa24c7287…  is Base's swapFeeRouter AND RH's twap
 *
 * So the bug this shape prevents is not "forgot to look up an address". It is
 * "took the address from one chain and the chainId from another", which does not
 * revert — it approves and then calls a real contract of the wrong type. Binding
 * `chainId` INTO the same object as the addresses means a call site cannot hold a
 * mismatched pair: there is no lone address in scope to pass.
 *
 * MAINNET MUST RESOLVE TO EXACTLY WHAT THE CONSTANTS SAID. That is the whole
 * safety case for swapping the constants out, and liquidityVenue.test.ts asserts
 * it against `lib/constants` rather than against a copied literal — a copy would
 * drift silently and prove nothing.
 *
 * NOT GATED ON `capabilities.ammSwap`, deliberately. That flag says "a swap can
 * happen here", and today it is false on both L2s because neither factory holds
 * a pair. But `addLiquidity` is the call that CREATES the first pair — gating it
 * on pairs existing is the deadlock that keeps both L2s empty forever. Liquidity
 * is available wherever the router and factory are deployed; swapping waits for
 * the pool that this creates.
 */
export interface LiquidityVenue {
  /** The chain these addresses belong to. Never pass one without the others. */
  readonly chainId: number;
  readonly name: string;
  readonly router: Address;
  readonly factory: Address;
  readonly weth: Address;
}

/**
 * Resolve the liquidity venue for a chain, or null where we cannot serve one.
 *
 * Null means "do not build a transaction" — an unconfigured chain, or a
 * configured chain whose router/factory are not deployed. Callers must render
 * that as a refusal, never fall back to a default chain: falling back is how a
 * wallet on Robinhood signs a mainnet-addressed approval.
 */
export function liquidityVenueOn(chainId: number | undefined | null): LiquidityVenue | null {
  const config = getChainConfig(chainId);
  if (!config) return null;

  const { router, factory, weth } = config.contracts;
  if (!router || !factory || !weth) return null;

  return {
    chainId: config.id,
    name: config.name,
    router,
    factory,
    weth,
  };
}
