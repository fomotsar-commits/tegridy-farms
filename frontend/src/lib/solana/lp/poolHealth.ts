import { depositEnabled, swapEnabled, withdrawEnabled } from '../cpswap/program';
import type { PoolSnapshot } from '../cpswap/read';
import { priceInQuote, type OutsidePrice } from './outsidePrice';
import { ownAveragePrice, type OwnPrice } from './ownPrice';
import type { PoolView } from './poolFinder';
import { readPair, type QuoteCoin } from './quotes';
import { TOKEN_2022_NATIVE_MINT, type SafetyReason, type TokenSafety } from './tokenSafety';

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
 *   - the pool is empty on either side (no price at all);
 *   - the token itself is blocked (tokenSafety.ts).
 *
 * A deposit is WARNED ABOUT, and allowed (owner ruling 2026-10-04), when:
 *   - its price is more than 3% from the reference price: the difference goes to the
 *     first arbitrage trade, paid out of the depositor's share;
 *   - Jupiter ANSWERED that the token has no market, and the pool is one anyone could
 *     open: its price was checked against nothing (`no-market`);
 *   - the token copies a well-known name, can be frozen by its creator, or shows a
 *     changing amount in a wallet (`tokenReasons`).
 * The warnings are sentences for the person about to sign, and `allowed` may carry them.
 *
 * EVERY PRICE HERE IS IN THE POOL'S OWN PAIRING COIN (quotes.ts): SOL per token for a
 * SOL pool, USDC per token for a USDC pool, BAYLA per token for a BAYLA pool. Jupiter is
 * only ever asked for SOL prices; a USDC or BAYLA pool's reference is the token's SOL
 * price over that coin's own SOL price (`priceInQuote`), and when the coin's price
 * could not be read the pool is unchecked.
 *
 * THE REFERENCE PRICE. The outside price (Jupiter) when there is one. A launch pool,
 * which only the launch program can open, usually has none (it is the token's only
 * market). When Jupiter ANSWERS that it has no route (`no-route`, never a failed read),
 * a launch pool is checked against its OWN average over the last half hour instead
 * (ownPrice.ts): someone who pushes its price just before a deposit is caught. A pool
 * anyone could have opened is never checked against its own history, because its opener
 * wrote that history. With no route it has no reference at all, and says so.
 *
 * A deposit is UNCHECKED (never "allowed", and never a warning) when something that
 * decides it was not read: the chain clock, the reference price (Jupiter failing to
 * answer is not "no route"), a launch pool's own price record, the pairing coin's own
 * price when a comparison needs it, the pool's fee settings, or the token.
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
  /**
   * Jupiter ANSWERED that the token has no market, and nothing else can stand in for one:
   * the price was compared with nothing. Read, not unread: a warning, never a refusal.
   */
  | { state: 'no-market'; pool: number; detail: string }
  /** Not compared on purpose (the token is blocked, so nothing here will be deposited). */
  | { state: 'skipped'; pool: number | null; detail: string }
  | { state: 'unread'; pool: number | null; detail: string };

export type WithdrawalsState = 'open' | 'switched-off' | 'vault-frozen';

export interface PoolHealth {
  swaps: SwapState;
  withdrawals: WithdrawalsState;
  price: PriceCheck;
  /**
   * `reasons` say why a deposit is refused or unchecked. `warnings` are always there
   * (empty when there are none) and do not change the verdict: `allowed` may carry them.
   */
  deposits: { verdict: 'allowed' | 'refused' | 'unchecked'; reasons: string[]; warnings: string[] };
}

/**
 * Who can have frozen one of a pool's vaults. A SOL pool has one vault anyone can freeze,
 * the token's. A pool paired with a coin whose issuer can freeze accounts (USDC) has two,
 * and the read does not say which is frozen, so the words must not blame the token for it.
 *
 * A coin says that its issuer can freeze a pool's account in its own `risk` line
 * (quotes.ts), and is named here only then. BAYLA is not SOL, but its mint has no freeze
 * authority: on a BAYLA pool a frozen vault can only be the token's, and BAYLA's issuer
 * is not named for it. A test pins the two together.
 */
export function vaultFreezer(quote: Pick<QuoteCoin, 'risk' | 'symbol'>): string {
  return quote.risk === null ? 'the token’s issuer' : `the token’s issuer or ${quote.symbol}’s`;
}

/** Whether money can come out of this pool, from its status bit and its vaults. */
export function withdrawalsState(view: Pick<PoolView, 'vaultsFrozen'> & { snapshot: Pick<PoolSnapshot, 'pool'> }): WithdrawalsState {
  if (view.vaultsFrozen) return 'vault-frozen';
  return withdrawEnabled(view.snapshot.pool) ? 'open' : 'switched-off';
}

/**
 * The pool's price: whole pairing coins per whole token, from its tradeable reserves.
 * Null when the pool is empty on a side, or is not `tokenMint` paired with a pairing
 * coin (`readPair`: BAYLA/SOL is BAYLA's pool, so it has no price as "SOL's pool").
 */
export function poolPricePerToken(snapshot: PoolSnapshot, tokenMint: string, tokenDecimals: number): number | null {
  const pair = readPair(snapshot.pool.token0Mint, snapshot.pool.token1Mint);
  if (!pair || pair.tokenMint !== tokenMint) return null;
  const quoteRes = pair.quoteIsToken0 ? snapshot.reserve0 : snapshot.reserve1;
  const tokRes = pair.quoteIsToken0 ? snapshot.reserve1 : snapshot.reserve0;
  if (quoteRes <= 0n || tokRes <= 0n) return null;
  const p = (Number(quoteRes) / 10 ** pair.quote.decimals) / (Number(tokRes) / 10 ** tokenDecimals);
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
    tokenIsToken0: !view.quoteIsToken0,
    solReserve: view.quoteReserve,
    tokenReserve: view.tokenReserve,
    tokenDecimals,
    now: chainNow,
  });
}

/**
 * The token's part of the verdict, one function for deposits AND for opening a pool, so
 * both judge a token the same way. Unread is unchecked, never a pass and never a warning;
 * an absent token and a blocked one are refused.
 *
 * `warned` is what the person must be told before they put money beside this token, and
 * may still go on: it copies a well-known name, its creator can freeze the pool's vault,
 * or a wallet displays a changing amount for it. Only the token warnings that change what
 * a deposit or an opening risks are repeated here; the rest stay on the token itself.
 * `action` names the pool in those sentences: the one being added to, or the one opened.
 */
export function tokenReasons(safety: TokenSafety | null, action: 'deposits' | 'pools'): { refused: string[]; unchecked: string[]; warned: string[] } {
  const refused: string[] = [];
  const unchecked: string[] = [];
  const warned: string[] = [];
  if (!safety || safety.kind === 'unread') unchecked.push('We could not read the token, so we cannot say whether it is safe.');
  else if (safety.kind === 'absent') refused.push('The token does not exist.');
  else {
    if (safety.verdict === 'blocked') refused.push('This token is blocked on this site (see why above).');
    const has = (code: SafetyReason['code']) => safety.warnings.some((w) => w.code === code);
    const pool = action === 'deposits' ? 'this pool' : 'the pool you open';
    // A name on WELL_KNOWN_NAMES (SOL, USDC, USDT, BAYLA, TOWELI and the island's Solana
    // tokens) claimed from another mint.
    if (has('copies-known-name')) {
      warned.push(
        `It calls itself by a well-known token’s name but has a different mint, so it is not that token. If the copy turns out to be worth nothing, so is your share of ${pool}.`,
      );
    }
    // USDC and USDT as the TOKEN are freezable like any other: the same line, said of their issuer.
    if (has('freeze-authority') || has('freeze-authority-accepted')) {
      warned.push(
        `Its ${has('freeze-authority') ? 'creator' : 'issuer'} can freeze the vault of ${pool}, and while it is frozen nobody can take liquidity out, you included. They can also freeze your own account for the token.`,
      );
    }
    if (has('interest-bearing') || has('scaled-amount')) {
      warned.push(
        'The amount a wallet displays for this token changes over time. This site shows and moves raw token units, so check the amounts against your wallet before you sign.',
      );
    }
  }
  return { refused, unchecked, warned };
}

export function assessPool(input: {
  view: PoolView;
  tokenDecimals: number | null;
  /** The cluster's clock, or null when it was not read. */
  chainNow: bigint | null;
  /** The TOKEN's outside price, in SOL. */
  outside: OutsidePrice | null;
  /**
   * The pool's PAIRING COIN's own outside price, in SOL (USDC's, or BAYLA's). A SOL pool
   * never looks at it; any other pool is unchecked without it.
   */
  coinOutside?: OutsidePrice | null;
  safety: TokenSafety | null;
}): PoolHealth {
  const { view, tokenDecimals, chainNow, outside, safety } = input;
  // The token's outside price in THIS pool's coin; null when Jupiter was not asked at all.
  const reference = outside ? priceInQuote(outside, view.quote, input.coinOutside ?? null) : null;
  const { snapshot } = view;
  const { pool } = snapshot;
  const isLaunchPool = view.origin === 'launch-pool';
  const tokenBlocked = safety?.kind === 'read' && safety.verdict === 'blocked';
  const refused: string[] = [];
  const unchecked: string[] = [];
  const warnings: string[] = [];

  let swaps: SwapState;
  if (!swapEnabled(pool)) swaps = { state: 'switched-off' };
  else if (chainNow === null) swaps = { state: 'unread', detail: 'the network clock was not read' };
  else if (chainNow < pool.openTime) swaps = { state: 'not-open-yet', opensAt: pool.openTime, farFuture: pool.openTime - chainNow > FAR_FUTURE_SECS };
  else swaps = { state: 'open' };
  const withdrawals = withdrawalsState(view);

  if (!depositEnabled(pool)) refused.push('Deposits are switched off on this pool.');
  if (!withdrawEnabled(pool)) refused.push('Withdrawals are switched off on this pool, so money put in now could not be taken out.');
  if ((pool.status & ~KNOWN_STATUS_BITS) !== 0) refused.push(`The pool has a status setting this site does not know (${pool.status}).`);
  // SOL under the newer token program is not a token a pool here holds. An opening refuses
  // it by name (opening.ts); so does a deposit into a pool someone opened with another
  // tool, whatever its price check says (review, 2026-10-04).
  if (view.tokenMint === TOKEN_2022_NATIVE_MINT) refused.push('This is SOL under the newer token program. This site does not add to a pool for it.');
  if (view.vaultsFrozen) refused.push(`One of this pool’s vaults is frozen by ${vaultFreezer(view.quote)}, so nothing can move in or out of it.`);
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

  const poolPrice = tokenDecimals === null ? null : poolPricePerToken(snapshot, view.tokenMint, tokenDecimals);
  let price: PriceCheck;
  if (tokenDecimals === null) {
    price = { state: 'unread', pool: null, detail: 'the token’s decimals were not read' };
  } else if (poolPrice === null) {
    price = { state: 'empty-pool' };
  } else if (reference?.kind === 'ok') {
    price = comparePrice(poolPrice, reference.perToken, 'outside');
  } else if (tokenBlocked) {
    price = { state: 'skipped', pool: poolPrice, detail: 'not compared, because the token is blocked' };
  } else if (reference?.kind === 'no-route') {
    // Only when Jupiter ANSWERED "no route". A failed read is not "no outside market":
    // the token may trade elsewhere at another price, so it stays unread below.
    if (isLaunchPool) {
      const own = ownPriceOf(view, tokenDecimals, chainNow);
      price =
        own.kind === 'ok'
          ? comparePrice(poolPrice, own.solPerToken, 'own-average')
          : own.kind === 'no-trades'
            ? { state: 'no-trades-yet', pool: poolPrice }
            : { state: 'unread', pool: poolPrice, detail: `no outside price (${reference.detail}), and its own price history could not be used: ${own.detail}` };
    } else {
      // A pool anyone could open has no history worth trusting, so there is no reference
      // at all. That is an answer, said as a warning, and never "the checks pass" in silence.
      price = { state: 'no-market', pool: poolPrice, detail: reference.detail };
    }
  } else {
    price = { state: 'unread', pool: poolPrice, detail: reference?.detail ?? 'not asked' };
  }
  if (price.state === 'empty-pool') refused.push('The pool is empty on one side, so it has no price.');
  if (price.state === 'unread') {
    unchecked.push(isLaunchPool ? `We could not check its price (${price.detail}).` : `We could not check its price against an outside price (${price.detail}).`);
  }

  if (view.config === null) unchecked.push('We could not read this pool’s fee settings.');

  const token = tokenReasons(safety, 'deposits');
  refused.push(...token.refused);
  unchecked.push(...token.unchecked);
  warnings.push(...token.warned);
  if (price.state === 'disagrees') {
    warnings.push(
      price.against === 'outside'
        ? `Its price is ${(Math.abs(price.diff) * 100).toFixed(1)}% ${price.diff > 0 ? 'above' : 'below'} the outside price. A deposit here would hand that gap to the first arbitrage trade.`
        : `Its price is ${(Math.abs(price.diff) * 100).toFixed(1)}% ${price.diff > 0 ? 'above' : 'below'} its own average over the last half hour. Someone may have just pushed it; a deposit now would pay for that.`,
    );
  }
  if (price.state === 'no-market') {
    warnings.push(
      'Jupiter has no market price for this token, so this pool’s price was not checked against anything. If it is off, a deposit here hands the difference to whoever trades it back.',
    );
  }

  return {
    swaps,
    withdrawals,
    price,
    deposits: refused.length
      ? { verdict: 'refused', reasons: [...refused, ...unchecked], warnings }
      : unchecked.length
        ? { verdict: 'unchecked', reasons: unchecked, warnings }
        : { verdict: 'allowed', reasons: [], warnings },
  };
}
