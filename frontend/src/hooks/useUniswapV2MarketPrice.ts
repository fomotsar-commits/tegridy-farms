import { useMemo } from 'react';
import { useReadContract, useReadContracts } from 'wagmi';
import { swapVenueOn } from '../lib/chains/swapVenue';
import { UNISWAP_V2_FACTORY_ABI, UNISWAP_V2_PAIR_ABI } from '../lib/contracts';
import type { TokenInfo } from '../lib/tokenList';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const;

/**
 * The market price a NEW pool can open at: the Uniswap V2 pool for the same two tokens on
 * the same chain (2026-10-20, owner: "setting the liquidity pool to market price isn't
 * available on Base and Robinhood"). Solana's Open a pool had it from Jupiter; the form for
 * Ethereum, Base and Robinhood Chain had nothing, so a first depositor typed a price blind.
 *
 * WHY UNISWAP V2 AND NOT A PRICE API. It is the market our own swap already weighs our pools
 * against on every one of these chains (lib/chains/swapVenue.ts): a pool opened at its price
 * is a pool the swap will not route straight past. It is read on chain, needs no key, and
 * works on Robinhood Chain, which GeckoTerminal does not cover. A pair with no Uniswap V2
 * pool has no price here, and the form says so instead of borrowing one from elsewhere.
 *
 * `none` is an ANSWER (the factory said no pool, or the pool is empty); `unread` is a failed
 * read. They render differently, and only `ok` can fill an amount.
 */
export type UniswapV2MarketPrice =
  | { kind: 'off' }
  | { kind: 'reading' }
  | { kind: 'none' }
  | { kind: 'unread' }
  | { kind: 'ok'; pair: `0x${string}`; reserveA: bigint; reserveB: bigint };

export function useUniswapV2MarketPrice(
  tokenA: TokenInfo | null,
  tokenB: TokenInfo | null,
  chainId: number,
  enabled: boolean,
): { price: UniswapV2MarketPrice; readAgain: () => void } {
  const venue = useMemo(() => swapVenueOn(chainId), [chainId]);
  // Uniswap V2 pairs hold WETH, never ETH: the native side is looked up as the chain's WETH.
  const addrA = !tokenA || !venue ? ZERO_ADDR : (tokenA.isNative ? venue.weth : tokenA.address) as `0x${string}`;
  const addrB = !tokenB || !venue ? ZERO_ADDR : (tokenB.isNative ? venue.weth : tokenB.address) as `0x${string}`;
  const on = enabled && !!venue && addrA !== ZERO_ADDR && addrB !== ZERO_ADDR
    && addrA.toLowerCase() !== addrB.toLowerCase();

  const pairRead = useReadContract({
    address: venue?.uniswapV2Factory ?? ZERO_ADDR,
    abi: UNISWAP_V2_FACTORY_ABI,
    functionName: 'getPair',
    args: [addrA, addrB],
    chainId: venue?.chainId ?? 0,
    query: { enabled: on },
  });
  const pair = pairRead.data as `0x${string}` | undefined;
  const hasPair = !!pair && pair !== ZERO_ADDR;

  const poolRead = useReadContracts({
    contracts: [
      { address: pair ?? ZERO_ADDR, abi: UNISWAP_V2_PAIR_ABI, functionName: 'getReserves', chainId: venue?.chainId ?? 0 },
      { address: pair ?? ZERO_ADDR, abi: UNISWAP_V2_PAIR_ABI, functionName: 'token0', chainId: venue?.chainId ?? 0 },
    ],
    query: { enabled: on && hasPair, refetchInterval: 30_000 },
  });

  const price = useMemo((): UniswapV2MarketPrice => {
    if (!on) return { kind: 'off' };
    if (pairRead.isError) return { kind: 'unread' };
    if (pair === undefined) return { kind: 'reading' };
    if (!hasPair) return { kind: 'none' };
    const rows = poolRead.data;
    if (!rows) return poolRead.isError ? { kind: 'unread' } : { kind: 'reading' };
    if (rows[0]?.status !== 'success' || rows[1]?.status !== 'success') return { kind: 'unread' };
    const [r0, r1] = rows[0].result as readonly [bigint, bigint, number];
    const aIs0 = (rows[1].result as string).toLowerCase() === addrA.toLowerCase();
    const reserveA = aIs0 ? r0 : r1;
    const reserveB = aIs0 ? r1 : r0;
    // An emptied pool has no price, only a pair address.
    if (reserveA === 0n || reserveB === 0n) return { kind: 'none' };
    return { kind: 'ok', pair, reserveA, reserveB };
  }, [on, pairRead.isError, pair, hasPair, poolRead.data, poolRead.isError, addrA]);

  const readAgain = () => {
    void pairRead.refetch();
    if (hasPair) void poolRead.refetch();
  };

  return { price, readAgain };
}

/**
 * The other side's amount at the market price, in base units: `amount × to ÷ from`.
 * Whole-number maths on the reserves, the same rounding as the router's own quote, so a
 * matched pair of amounts never drifts by a float.
 */
export function matchAtMarket(amount: bigint, fromReserve: bigint, toReserve: bigint): bigint {
  if (fromReserve === 0n) return 0n;
  return (amount * toReserve) / fromReserve;
}

/**
 * How far the price the two amounts set is from the market, in basis points: positive when
 * the amounts value token A ABOVE the market (more B per A), negative when below. Null when
 * either amount is zero, where the amounts set no price at all.
 */
export function gapFromMarketBps(
  amountA: bigint, amountB: bigint, reserveA: bigint, reserveB: bigint,
): number | null {
  if (amountA === 0n || amountB === 0n || reserveA === 0n || reserveB === 0n) return null;
  // (B/A) ÷ (rB/rA) − 1, scaled to basis points without a float.
  return Number((amountB * reserveA * 10_000n) / (amountA * reserveB)) - 10_000;
}

/** A price as people read it: significant digits below 1, never scientific notation. */
export function formatMarketPrice(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '–';
  return value < 1
    ? value.toLocaleString('en-US', { maximumSignificantDigits: 4 })
    : value.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
