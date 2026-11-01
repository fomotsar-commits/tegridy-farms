import type { TokenInfo } from '../tokenList';
import { evmBasketFor } from '../islandBasket';
import { uniswapOn } from './islandBasketEvm';
import { universalRouterOn } from './universalRouter';

/**
 * The swap form's third route on a chain with Uniswap's Universal Router (Base): an island
 * coin bought with ETH, or sold for ETH, in that coin's own Uniswap V3 pool, with the
 * venue's fee taken by the router (lib/evm/universalRouter.ts).
 *
 * Only the pools lib/islandBasket.ts lists, each read on chain: a coin the site does not
 * name gets no V3 route, so nobody is routed into a pool an attacker deployed beside it.
 * Only ETH on the other side: the router pays the venue in ETH either way.
 *
 * 2026-11-01: Base's V2 pairs for BNKR, DRB and QR hold dust, and the swap compared only
 * V2 and our pools, so 1.75M BNKR quoted 0.0000011 ETH while its V3 pool paid 0.22 ETH.
 */
export interface IslandV3Leg {
  side: 'buy' | 'sell';
  coin: `0x${string}`;
  pool: `0x${string}`;
  poolFee: number;
  quoterV2: `0x${string}`;
  router: `0x${string}`;
}

export function islandV3LegFor(chainId: number, from: TokenInfo, to: TokenInfo): IslandV3Leg | null {
  const router = universalRouterOn(chainId);
  const quoterV2 = uniswapOn(chainId)?.quoterV2;
  if (!router || !quoterV2 || !!from.isNative === !!to.isNative) return null;
  const side = from.isNative ? 'buy' : 'sell';
  const coinAddr = (side === 'buy' ? to : from).address.toLowerCase();
  const coin = evmBasketFor(chainId)?.find((c) => c.token.toLowerCase() === coinAddr);
  const pool = coin?.pools.find((p) => p.dex === 'uniswap-v3');
  if (!coin || !pool || pool.dex !== 'uniswap-v3') return null;
  return { side, coin: coin.token, pool: pool.address, poolFee: pool.fee, quoterV2, router };
}

/**
 * What `amountIn` is worth at the pool's current price, before any fee: the mid-price the
 * fill is measured against. Uniswap orders a pool's tokens by address, so the coin is
 * token0 exactly when its address sorts below WETH's.
 */
export function v3MidOut(amountIn: bigint, sqrtPriceX96: bigint, tokenIn: `0x${string}`, tokenOut: `0x${string}`): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const priceX192 = sqrtPriceX96 * sqrtPriceX96; // token1 per token0, scaled by 2^192
  return tokenIn.toLowerCase() < tokenOut.toLowerCase()
    ? (amountIn * priceX192) >> 192n
    : (amountIn << 192n) / priceX192;
}

/**
 * QuoterV2.quoteExactInputSingle, typed `view` so it reads like any other quote. It is an
 * eth_call either way: the quoter runs the swap and reverts with the result, writing nothing.
 */
export const QUOTER_V2_READ_ABI = [
  {
    type: 'function', name: 'quoteExactInputSingle', stateMutability: 'view',
    inputs: [{
      name: 'params', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' }, { name: 'amountIn', type: 'uint256' },
        { name: 'fee', type: 'uint24' }, { name: 'sqrtPriceLimitX96', type: 'uint160' },
      ],
    }],
    outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'sqrtPriceX96After', type: 'uint160' }, { name: 'initializedTicksCrossed', type: 'uint32' }, { name: 'gasEstimate', type: 'uint256' }],
  },
] as const;

export const V3_POOL_SLOT0_ABI = [
  {
    type: 'function', name: 'slot0', stateMutability: 'view', inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' }, { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' }, { name: 'unlocked', type: 'bool' },
    ],
  },
] as const;

/** Where SwapFeeRouter sends the venue fee; the router route pays the same address. */
export const REVENUE_DISTRIBUTOR_ABI = [
  { type: 'function', name: 'revenueDistributor', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] },
] as const;
