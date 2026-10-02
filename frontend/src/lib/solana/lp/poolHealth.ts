import { depositEnabled, swapEnabled, withdrawEnabled } from '../cpswap/program';
import type { PoolSnapshot } from '../cpswap/read';
import type { OutsidePrice } from './outsidePrice';
import { ownAveragePrice, type OwnPrice } from './ownPrice';
import type { PoolView } from './poolFinder';
import type { TokenSafety } from './tokenSafety';
import { WSOL_MINT } from './tokenSafety';

/**
 * Is this pool safe to deposit into right now? Pure: every input was read elsewhere.
 *
 * A deposit is REFUSED when:
 *   - ANY of the pool's status bits is set, not only the deposit one. The pool program
 *     checks only the deposit bit on a deposit (deposit.rs 96), so a pool with
 *     withdrawals switched off still takes deposits, and that money could not come back
 *     out. A bit this site does not know is refused too;
 *   - a pool vault is frozen (the token's issuer can do that to USDC and USDT): nothing
 *     can move in or out;
 *   - the pool is not open for swaps yet. A stranger can open the standard address for a
 *     pair first with an open time years away; swaps are then blocked (swap_base_input.rs
 *     79-80) while deposits still go through (deposit.rs 96), so liquidity added there
 *     can never earn a fee;
 *   - its price is more than 3% from the reference price: the difference goes to the
 *     first arbitrage trade, paid out of the depositor's share;
 *   - the pool is empty on either side (no price at all);
 *   - the token itself is blocked (tokenSafety.ts).
 *
 * THE REFERENCE PRICE. The outside price (Jupiter) when there is one. A launch pool,
 * which only the launch program can open, usually has none (it is the token's only
 * market). When Jupiter ANSWERS that it has no route (`no-route`, never a failed read),
 * a launch pool is checked against its OWN average over the last half hour instead
 * (ownPrice.ts): someone who pushes its price just before a deposit is caught. A pool
 * anyone could have opened is never checked against its own history, because its opener
 * wrote that history.
 *
 * A deposit is UNCHECKED (never "allowed") when something that decides it was not read:
 * the chain clock, the reference price, the pool's fee settings, or the token.
 */

export const PRICE_TOLERANCE = 0.03;
/** An open time this far ahead is not a launch delay; it is a pool that will not trade. */
export const FAR_FUTURE_SECS = 7n * 24n * 3600n;
/** The status bits this site knows (PoolStatusBitIndex): deposit, withdraw, swap. */
const KNOWN_STATUS_BITS = 0b111;

export type SwapState =
  | { state: 'open' }
  | { state: 'switched-off' }
  | { state: 'not-open-yet'; opensAt: bigint; farFuture: boolean }
  | { state: 'unread'; detail: string };

export type PriceReference = 'outside' | 'own-average';

export type PriceCheck =
  | { state: 'agrees'; pool: number; reference: number; against: PriceReference; diff: number }
  | { state: 'disagrees'; pool: number; reference: number; against: PriceReference; diff: number }
  /** A launch pool that has never traded: its price is still the one the launch program set. */
  | { state: 'no-trades-yet'; pool: number }
  | { state: 'empty-pool' }
  /** Not compared on purpose (the token is blocked, so nothing here will be deposited). */
  | { state: 'skipped'; pool: number | null; detail: string }
  | { state: 'unread'; pool: number | null; detail: string };

export type WithdrawalsState = 'open' | 'switched-off' | 'vault-frozen';

export interface PoolHealth {
  swaps: SwapState;
  withdrawals: WithdrawalsState;
  price: PriceCheck;
  deposits: { verdict: 'allowed' | 'refused' | 'unchecked'; reasons: string[] };
}

/** Whether money can come out of this pool, from its status bit and its vaults. */
export function withdrawalsState(view: Pick<PoolView, 'vaultsFrozen'> & { snapshot: Pick<PoolSnapshot, 'pool'> }): WithdrawalsState {
  if (view.vaultsFrozen) return 'vault-frozen';
  return withdrawEnabled(view.snapshot.pool) ? 'open' : 'switched-off';
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

function compare(pool: number, reference: number, against: PriceReference): PriceCheck {
  const diff = pool / reference - 1;
  return { state: Math.abs(diff) > PRICE_TOLERANCE ? 'disagrees' : 'agrees', pool, reference, against, diff };
}

/** The launch pool's own average, when its record was read; the reason when not. */
function ownPriceOf(view: PoolView, tokenDecimals: number, chainNow: bigint | null): OwnPrice {
  if (view.history.kind === 'not-read') return { kind: 'unread', detail: 'its price record was not read' };
  if (view.history.kind === 'unread') return { kind: 'unread', detail: view.history.detail };
  if (chainNow === null) return { kind: 'unread', detail: 'the network clock was not read' };
  return ownAveragePrice({
    obs: view.history.obs,
    tokenIsToken0: !view.solIsToken0,
    solReserve: view.solReserve,
    tokenReserve: view.tokenReserve,
    tokenDecimals,
    now: chainNow,
  });
}

export function assessPool(input: {
  view: PoolView;
  tokenDecimals: number | null;
  /** The cluster's clock, or null when it was not read. */
  chainNow: bigint | null;
  outside: OutsidePrice | null;
  safety: TokenSafety | null;
}): PoolHealth {
  const { view, tokenDecimals, chainNow, outside, safety } = input;
  const { snapshot } = view;
  const { pool } = snapshot;
  const isLaunchPool = view.origin === 'launch-pool';
  const tokenBlocked = safety?.kind === 'read' && safety.verdict === 'blocked';
  const refused: string[] = [];
  const unchecked: string[] = [];

  let swaps: SwapState;
  if (!swapEnabled(pool)) swaps = { state: 'switched-off' };
  else if (chainNow === null) swaps = { state: 'unread', detail: 'the network clock was not read' };
  else if (chainNow < pool.openTime) swaps = { state: 'not-open-yet', opensAt: pool.openTime, farFuture: pool.openTime - chainNow > FAR_FUTURE_SECS };
  else swaps = { state: 'open' };
  const withdrawals = withdrawalsState(view);

  if (!depositEnabled(pool)) refused.push('Deposits are switched off on this pool.');
  if (!withdrawEnabled(pool)) refused.push('Withdrawals are switched off on this pool, so money put in now could not be taken out.');
  if ((pool.status & ~KNOWN_STATUS_BITS) !== 0) refused.push(`The pool has a status setting this site does not know (${pool.status}).`);
  if (view.vaultsFrozen) refused.push('One of this pool’s vaults is frozen by the token’s issuer, so nothing can move in or out of it.');
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

  const poolPrice = tokenDecimals === null ? null : poolSolPerToken(snapshot, view.tokenMint, tokenDecimals);
  let price: PriceCheck;
  if (tokenDecimals === null) {
    price = { state: 'unread', pool: null, detail: 'the token’s decimals were not read' };
  } else if (poolPrice === null) {
    price = { state: 'empty-pool' };
  } else if (outside?.kind === 'ok') {
    price = compare(poolPrice, outside.solPerToken, 'outside');
  } else if (tokenBlocked) {
    price = { state: 'skipped', pool: poolPrice, detail: 'not compared, because the token is blocked' };
  } else if (isLaunchPool && outside?.kind === 'no-route') {
    // Only when Jupiter ANSWERED "no route". A failed read is not "no outside market":
    // the token may trade elsewhere at another price, so it stays unread below.
    const own = ownPriceOf(view, tokenDecimals, chainNow);
    price =
      own.kind === 'ok'
        ? compare(poolPrice, own.solPerToken, 'own-average')
        : own.kind === 'no-trades'
          ? { state: 'no-trades-yet', pool: poolPrice }
          : { state: 'unread', pool: poolPrice, detail: `no outside price (${outside?.detail ?? 'not asked'}), and its own price history could not be used: ${own.detail}` };
  } else {
    price = { state: 'unread', pool: poolPrice, detail: outside?.detail ?? 'not asked' };
  }
  if (price.state === 'empty-pool') refused.push('The pool is empty on one side, so it has no price.');
  if (price.state === 'disagrees') {
    refused.push(
      price.against === 'outside'
        ? `Its price is ${(Math.abs(price.diff) * 100).toFixed(1)}% ${price.diff > 0 ? 'above' : 'below'} the outside price. A deposit here would hand that gap to the first arbitrage trade.`
        : `Its price is ${(Math.abs(price.diff) * 100).toFixed(1)}% ${price.diff > 0 ? 'above' : 'below'} its own average over the last half hour. Someone may have just pushed it; a deposit now would pay for that.`,
    );
  }
  if (price.state === 'unread') {
    unchecked.push(isLaunchPool ? `We could not check its price (${price.detail}).` : `We could not check its price against an outside price (${price.detail}).`);
  }

  if (view.config === null) unchecked.push('We could not read this pool’s fee settings.');

  if (!safety || safety.kind === 'unread') unchecked.push('We could not read the token, so we cannot say whether it is safe.');
  else if (safety.kind === 'absent') refused.push('The token does not exist.');
  else if (safety.verdict === 'blocked') refused.push('This token is blocked on this site (see why above).');

  return {
    swaps,
    withdrawals,
    price,
    deposits: refused.length
      ? { verdict: 'refused', reasons: [...refused, ...unchecked] }
      : unchecked.length
        ? { verdict: 'unchecked', reasons: unchecked }
        : { verdict: 'allowed', reasons: [] },
  };
}
