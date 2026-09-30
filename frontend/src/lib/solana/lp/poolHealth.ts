import { depositEnabled, swapEnabled, withdrawEnabled } from '../cpswap/program';
import type { PoolSnapshot } from '../cpswap/read';
import type { OutsidePrice } from './outsidePrice';
import type { TokenSafety } from './tokenSafety';
import { WSOL_MINT } from './tokenSafety';

/**
 * Is this pool safe to deposit into right now? Pure: every input was read elsewhere.
 *
 * A deposit is REFUSED when:
 *   - the pool has deposits switched off (status bit 1);
 *   - the pool is not open for swaps yet. A stranger can open the standard address for a
 *     pair first with an open time years away; swaps are then blocked (swap_base_input.rs
 *     79-80) while deposits still go through (deposit.rs 96), so liquidity added there
 *     can never earn a fee;
 *   - its price is more than 3% from the outside price: the difference goes to the first
 *     arbitrage trade, paid out of the depositor's share;
 *   - the pool is empty on either side (no price at all);
 *   - the token itself is blocked (tokenSafety.ts).
 *
 * A deposit is UNCHECKED (never "allowed") when something that decides it was not read:
 * the chain clock, the outside price, or the token. The one exception is the price of a
 * launch pool, which only the launch program can create: nobody can have opened it at a
 * made-up price, so its price IS the token's market, and a missing outside price is said
 * plainly but does not hold the deposit.
 */

export const PRICE_TOLERANCE = 0.03;
/** An open time this far ahead is not a launch delay; it is a pool that will not trade. */
export const FAR_FUTURE_SECS = 7n * 24n * 3600n;

export type SwapState =
  | { state: 'open' }
  | { state: 'switched-off' }
  | { state: 'not-open-yet'; opensAt: bigint; farFuture: boolean }
  | { state: 'unread'; detail: string };

export type PriceCheck =
  | { state: 'agrees'; pool: number; outside: number; diff: number }
  | { state: 'disagrees'; pool: number; outside: number; diff: number }
  | { state: 'empty-pool' }
  | { state: 'unread'; pool: number | null; detail: string };

export interface PoolHealth {
  swaps: SwapState;
  withdrawals: 'open' | 'switched-off';
  price: PriceCheck;
  deposits: { verdict: 'allowed' | 'refused' | 'unchecked'; reasons: string[] };
}

/** SOL per whole token from the pool's tradeable reserves, or null (empty / not a SOL pair). */
export function poolSolPerToken(snapshot: PoolSnapshot, tokenMint: string, tokenDecimals: number): number | null {
  const { pool } = snapshot;
  let solRes: bigint;
  let tokRes: bigint;
  if (pool.token0Mint === WSOL_MINT && pool.token1Mint === tokenMint) {
    solRes = snapshot.reserve0;
    tokRes = snapshot.reserve1;
  } else if (pool.token1Mint === WSOL_MINT && pool.token0Mint === tokenMint) {
    solRes = snapshot.reserve1;
    tokRes = snapshot.reserve0;
  } else {
    return null;
  }
  if (solRes <= 0n || tokRes <= 0n) return null;
  const p = (Number(solRes) / 1e9) / (Number(tokRes) / 10 ** tokenDecimals);
  return Number.isFinite(p) && p > 0 ? p : null;
}

export function formatWhen(unixSecs: bigint): string {
  const ms = Number(unixSecs) * 1000;
  if (!Number.isFinite(ms) || ms > 8.64e15) return `unix time ${unixSecs.toString()} (beyond any calendar date)`;
  return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export function assessPool(input: {
  snapshot: PoolSnapshot;
  tokenMint: string;
  tokenDecimals: number | null;
  /** The cluster's clock, or null when it was not read. */
  chainNow: bigint | null;
  outside: OutsidePrice | null;
  safety: TokenSafety | null;
  isLaunchPool: boolean;
}): PoolHealth {
  const { snapshot, tokenMint, tokenDecimals, chainNow, outside, safety, isLaunchPool } = input;
  const { pool } = snapshot;
  const refused: string[] = [];
  const unchecked: string[] = [];

  let swaps: SwapState;
  if (!swapEnabled(pool)) swaps = { state: 'switched-off' };
  else if (chainNow === null) swaps = { state: 'unread', detail: 'the network clock was not read' };
  else if (chainNow < pool.openTime) swaps = { state: 'not-open-yet', opensAt: pool.openTime, farFuture: pool.openTime - chainNow > FAR_FUTURE_SECS };
  else swaps = { state: 'open' };

  if (!depositEnabled(pool)) refused.push('Deposits are switched off on this pool.');
  if (swaps.state === 'not-open-yet') {
    refused.push(
      swaps.farFuture
        ? `Swaps are blocked until ${formatWhen(swaps.opensAt)}. Liquidity added before then earns nothing.`
        : `Swaps open at ${formatWhen(swaps.opensAt)}. Deposits wait until then.`,
    );
  } else if (swaps.state === 'switched-off') {
    refused.push('Swaps are switched off on this pool, so liquidity here earns nothing.');
  } else if (swaps.state === 'unread') {
    unchecked.push('We could not read the network clock, so we cannot tell whether this pool is open.');
  }

  const poolPrice = tokenDecimals === null ? null : poolSolPerToken(snapshot, tokenMint, tokenDecimals);
  let price: PriceCheck;
  if (tokenDecimals === null) {
    price = { state: 'unread', pool: null, detail: 'the token’s decimals were not read' };
  } else if (poolPrice === null) {
    price = { state: 'empty-pool' };
  } else if (!outside || outside.kind === 'unread') {
    price = { state: 'unread', pool: poolPrice, detail: outside?.detail ?? 'not asked yet' };
  } else {
    const diff = poolPrice / outside.solPerToken - 1;
    price = { state: Math.abs(diff) > PRICE_TOLERANCE ? 'disagrees' : 'agrees', pool: poolPrice, outside: outside.solPerToken, diff };
  }
  if (price.state === 'empty-pool') refused.push('The pool is empty on one side, so it has no price.');
  if (price.state === 'disagrees') {
    refused.push(
      `Its price is ${(Math.abs(price.diff) * 100).toFixed(1)}% ${price.diff > 0 ? 'above' : 'below'} the outside price. A deposit here would hand that gap to the first arbitrage trade.`,
    );
  }
  if (price.state === 'unread' && !isLaunchPool) {
    unchecked.push(`We could not check its price against an outside price (${price.detail}).`);
  }

  if (!safety || safety.kind === 'unread') unchecked.push('We could not read the token, so we cannot say whether it is safe.');
  else if (safety.kind === 'absent') refused.push('The token does not exist.');
  else if (safety.verdict === 'blocked') refused.push('This token is blocked on this site (see why above).');

  return {
    swaps,
    withdrawals: withdrawEnabled(pool) ? 'open' : 'switched-off',
    price,
    deposits: refused.length
      ? { verdict: 'refused', reasons: [...refused, ...unchecked] }
      : unchecked.length
        ? { verdict: 'unchecked', reasons: unchecked }
        : { verdict: 'allowed', reasons: [] },
  };
}
