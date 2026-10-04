import { depositEnabled, swapEnabled, withdrawEnabled } from '../cpswap/program';
import type { PoolSnapshot } from '../cpswap/read';
import type { OutsidePrice } from './outsidePrice';
import { ownAveragePrice, recordSilence, type OwnPrice } from './ownPrice';
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
 *   - the token itself is blocked (tokenSafety.ts), or it copies a well-known token's
 *     name from a different mint.
 *
 * THE REFERENCE PRICE. The outside price (Jupiter) when there is one. A launch pool,
 * which only the launch program can open, usually has none (it is the token's only
 * market). When Jupiter ANSWERS that it has no route (`no-route`, never a failed read),
 * a launch pool is checked against ITSELF instead (`launchOwnPriceCheck`, the one rule
 * the swap route uses too): it has never traded and still holds exactly what its shares
 * account for, or it traded steadily through the last half hour and agrees with that
 * average. Its price can be moved WITHOUT a trade, by sending tokens or SOL straight
 * into a vault, and one dust swap then writes the moved price across the whole quiet
 * stretch of its price record; so a pool topped up by a plain transfer, and a quiet
 * one, are REFUSED, each with its own sentence, and a record shorter than
 * `LAUNCH_MIN_WINDOW_SECS` is UNCHECKED. That holds UNTIL the pool has traded steadily
 * for the whole window at the moved price: after that the moved price is the pool's
 * price, and nothing on chain tells it from one reached by trading. What the rule buys
 * is that the move must survive that long with anyone free to trade against it. A pool
 * anyone could have opened is never checked against its own history, because its opener
 * wrote that history.
 *
 * WITHDRAWALS do not read any of this: `withdrawals` comes from the status bit and the
 * vaults alone (the leave rule: money already in a pool can always be taken out here).
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
  /** A launch pool that has never traded AND still holds what its shares account for: its price is still the one the launch program set. */
  | { state: 'no-trades-yet'; pool: number }
  /** A launch pool that has never traded, yet its two sides no longer match its shares: something was sent straight into a vault. */
  | { state: 'reserves-moved'; pool: number }
  /** A launch pool within 3% of its own average, but that average has a long stretch with no trade in it, so it proves nothing. */
  | { state: 'too-quiet'; pool: number; reference: number; diff: number }
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

/** A price against its reference: more than `PRICE_TOLERANCE` apart disagrees; exactly 3% agrees. */
export function comparePrice(pool: number, reference: number, against: PriceReference): PriceCheck {
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

/**
 * A launch pool that has never traded must still hold what its shares account for.
 * The pool program opens a pool with `lp_supply = floor(sqrt(side0 x side1))`, and a
 * deposit or a withdrawal moves both sides and the shares together, so until the first
 * swap `side0 x side1` stays at `lp_supply^2` (a hair above, from rounding in the pool's
 * favour). Tokens or SOL sent STRAIGHT into a vault raise the product and move the
 * price without a trade; this tolerance is the most such a transfer may have moved it.
 */
export const UNTRADED_RESERVES_TOLERANCE_BPS = 10n;

export function reservesMatchShares(view: PoolView): boolean {
  const lp = view.snapshot.pool.lpSupply;
  if (lp <= 0n || view.solReserve <= 0n || view.tokenReserve <= 0n) return false;
  const product = view.solReserve * view.tokenReserve;
  const shares = lp * lp;
  // Below the shares is a state the pool program never produces: unread, not fine.
  return product >= shares && product * 10_000n <= shares * (10_000n + UNTRADED_RESERVES_TOLERANCE_BPS);
}

/**
 * A traded launch pool's average counts only while it traded steadily: no stretch
 * without a recorded swap longer than a sixth of the window (5 minutes of 30). A price
 * moved inside such a stretch is then at most a sixth of the average, so a move past
 * about 3.6% still shows as more than the 3% tolerance (ownPrice.ts recordSilence).
 */

/**
 * The least price record a launch pool's average needs before MONEY rests on it.
 *
 * The record starts at the pool's FIRST swap (oracle.rs skips the opening price). A
 * pool whose price was moved by a transfer before it ever traded therefore has a record
 * written wholly at the moved price, and dust swaps every few minutes make it "steady".
 * Ten minutes of that (ownPrice.ts MIN_HISTORY_SECS) is not evidence; the moved price
 * must survive open trading for the whole window, as it must on an older pool.
 *
 * Why 24 minutes and not the full 30: the record is a ring of 100 slots at least 15 s
 * apart, so a pool that trades every block never shows more than 99 x 15 s = 24 m 45 s.
 * A full half hour here would refuse the busiest pools for as long as they stay busy.
 */
export const LAUNCH_MIN_WINDOW_SECS = 24n * 60n;
export const LAUNCH_MAX_SILENCE_DIVISOR = 6n;

/**
 * A launch pool's price against the pool itself, for when Jupiter ANSWERED "no route".
 * ONE rule for every place money rests on it: the deposit check below (on the card and
 * again at prepare time, liquidity.ts) and the swap route (swap/ownRoute.ts
 * launchPriceProblem reads this answer).
 *
 * With no outside price, the only evidence that the pool's price is honest is the pool
 * itself, and its price can be moved WITHOUT a trade: its reserves are its vaults' live
 * balances, and a plain transfer into a vault leaves no mark in its price record. So
 * "agrees with its own average" and "has never traded" are not enough on their own:
 *   - never traded: its two sides must still match its shares (`reservesMatchShares`),
 *     else 'reserves-moved';
 *   - traded: within 3% of its half-hour average ('disagrees' otherwise), AND that
 *     average must reach back far enough (`LAUNCH_MIN_WINDOW_SECS`, else 'unread'), AND
 *     be made of steady trading (`LAUNCH_MAX_SILENCE_DIVISOR`), else 'too-quiet'. Time with no recorded swap is not evidence: the average fills it with
 *     whatever the price is now, and a dust swap after a transfer writes the moved price
 *     over the whole quiet stretch.
 * Anything not read is 'unread', never a pass.
 */
export function launchOwnPriceCheck(view: PoolView, a: { poolPrice: number; tokenDecimals: number; chainNow: bigint | null; noOutside: string }): PriceCheck {
  const own = ownPriceOf(view, a.tokenDecimals, a.chainNow);
  if (own.kind === 'no-trades') {
    return reservesMatchShares(view) ? { state: 'no-trades-yet', pool: a.poolPrice } : { state: 'reserves-moved', pool: a.poolPrice };
  }
  if (own.kind !== 'ok') {
    return { state: 'unread', pool: a.poolPrice, detail: `no outside price (${a.noOutside}), and its own price history could not be used: ${own.detail}` };
  }
  const compared = comparePrice(a.poolPrice, own.solPerToken, 'own-average');
  if (compared.state !== 'agrees') return compared;
  if (own.windowSecs < LAUNCH_MIN_WINDOW_SECS) {
    return {
      state: 'unread',
      pool: a.poolPrice,
      detail: `no outside price (${a.noOutside}), and it has only ${(own.windowSecs / 60n).toString()} minutes of price history since its first trade; its own average counts after ${(LAUNCH_MIN_WINDOW_SECS / 60n).toString()}`,
    };
  }
  // `own` is 'ok' only with a read record and a read clock; held again here so a future
  // change to ownPriceOf cannot turn "not read" into "steady".
  const quiet = view.history.kind === 'ok' && a.chainNow !== null ? recordSilence(view.history.obs, a.chainNow) : null;
  if (quiet === null) {
    return { state: 'unread', pool: a.poolPrice, detail: `no outside price (${a.noOutside}), and its own price record does not say how steadily it traded` };
  }
  if (quiet.longestSecs * LAUNCH_MAX_SILENCE_DIVISOR > quiet.windowSecs) {
    return { state: 'too-quiet', pool: a.poolPrice, reference: own.solPerToken, diff: compared.diff };
  }
  return compared;
}

/** The two refusals only a launch pool with no outside price can get, in the deposit check's words. */
export const DEPOSIT_RESERVES_MOVED =
  'Nobody has traded in this launch pool yet, but its two sides no longer match its shares. Someone may have moved its price by sending tokens or SOL straight into it, and there is no outside price to check it against. A deposit now would go in at that price.';
export const DEPOSIT_TOO_QUIET =
  'This launch pool has not traded steadily over the last half hour, so its own average cannot show that its price is honest, and there is no outside price to check it against. Deposits here wait until it trades steadily again or gets an outside price.';

/**
 * The token's part of the verdict, one function for deposits, for opening a pool AND for
 * routing a swap into a pool, so all three judge a token the same way. Unread is
 * unchecked, never a pass; an absent token, a blocked one, and one that copies a
 * well-known name from another mint are refused.
 * `action` changes only the copied-name sentence: what this site will not do with a copy.
 */
const COPY_REFUSAL: Record<'deposits' | 'pools' | 'swaps', string> = {
  deposits: 'This site does not take deposits into copies.',
  pools: 'This site does not open pools for copies.',
  swaps: 'This site does not send trades to pools of copies.',
};

export function tokenReasons(safety: TokenSafety | null, action: 'deposits' | 'pools' | 'swaps'): { refused: string[]; unchecked: string[] } {
  const refused: string[] = [];
  const unchecked: string[] = [];
  if (!safety || safety.kind === 'unread') unchecked.push('We could not read the token, so we cannot say whether it is safe.');
  else if (safety.kind === 'absent') refused.push('The token does not exist.');
  else if (safety.verdict === 'blocked') refused.push('This token is blocked on this site (see why above).');
  // A copied well-known name stays a warning on the token itself, but nobody adds
  // liquidity here to a token that poses as one on WELL_KNOWN_NAMES (SOL, USDC, USDT,
  // BAYLA, TOWELI and the island's Solana tokens).
  if (safety?.kind === 'read' && safety.warnings.some((w) => w.code === 'copies-known-name')) {
    refused.push(`It calls itself by a well-known token’s name but has a different mint. ${COPY_REFUSAL[action]}`);
  }
  return { refused, unchecked };
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
    price = comparePrice(poolPrice, outside.solPerToken, 'outside');
  } else if (tokenBlocked) {
    price = { state: 'skipped', pool: poolPrice, detail: 'not compared, because the token is blocked' };
  } else if (isLaunchPool && outside?.kind === 'no-route') {
    // Only when Jupiter ANSWERED "no route". A failed read is not "no outside market":
    // the token may trade elsewhere at another price, so it stays unread below.
    price = launchOwnPriceCheck(view, { poolPrice, tokenDecimals, chainNow, noOutside: outside.detail });
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
  if (price.state === 'reserves-moved') refused.push(DEPOSIT_RESERVES_MOVED);
  if (price.state === 'too-quiet') refused.push(DEPOSIT_TOO_QUIET);
  if (price.state === 'unread') {
    unchecked.push(isLaunchPool ? `We could not check its price (${price.detail}).` : `We could not check its price against an outside price (${price.detail}).`);
  }

  if (view.config === null) unchecked.push('We could not read this pool’s fee settings.');

  const token = tokenReasons(safety, 'deposits');
  refused.push(...token.refused);
  unchecked.push(...token.unchecked);

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
