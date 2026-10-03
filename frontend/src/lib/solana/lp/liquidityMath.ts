import { lpTokensToTradingTokens } from '../cpswap/math';
import type { PoolSnapshot } from '../cpswap/read';

/**
 * The numbers a deposit or a withdrawal carries, worked out from one pool snapshot.
 *
 * Pure bigint. Every function answers a number, `null`, or a problem object; never a 0
 * that means "unknown". `S` is ALWAYS the pool's own `lp_supply` (`pool.lpSupply`), never
 * the LP mint's supply: a launch pool burns the launch's own shares at graduation, so its
 * mint supply is far below `lp_supply`, and the program values every share against
 * `lp_supply` (deposit.rs, withdraw.rs).
 *
 * THE PROGRAM'S RULES THIS FOLLOWS (constant_product.rs, deposit.rs, withdraw.rs):
 *   - a deposit of `lp` shares costs `ceil(lp·R/S)` on each side, except that a side
 *     that comes out at 0 stays 0, and then the program refuses it (6006);
 *   - a withdrawal of `lp` shares pays `floor(lp·R/S)` on each side, and a 0 side is
 *     refused the same way (6006);
 *   - so both directions need `lp ≥ max(ceil(S/R0), ceil(S/R1))` (`minLpForBothSides`);
 *   - a deposit is refused when a cost is above its maximum (6005), a withdrawal when a
 *     payout is below its minimum (6005).
 *
 * THE TWO SIDES are `quote` (the pool's pairing coin: SOL, USDC or BAYLA, in that
 * coin's own base units) and `token`. Nothing here knows which coin it is: the maths is
 * the same, and only the caller knows what the wallet can spend of it (for SOL, the
 * rent band below; for any other coin, its token balance).
 *
 * BOUNDS. A deposit's maxima round UP (`maxInFor`) and are never u64::MAX (which would
 * mean "no limit"). A withdrawal's minima round DOWN and are never below 1 (`minOutFor`).
 * `minimumOutFor` (cpswap/ix.ts) is NOT used for a deposit: it rounds down, so it would
 * refuse an honest deposit.
 */

export const U64_MAX = (1n << 64n) - 1n;
const BPS = 10_000n;

/**
 * The shares a deposit can buy so that the most leaving on the driving side is exactly
 * `maxIn`: `floor(maxIn·S·10000 / (R·(10000+bps)))`. Its cost `ceil(lp·R/S)` is then at
 * most `maxIn`, and `maxIn − cost` is the tolerance less at most one base unit.
 * `null` when the pool has no price on that side.
 */
export function lpForMaxIn(maxIn: bigint, reserve: bigint, lpSupply: bigint, bps: bigint): bigint | null {
  if (reserve <= 0n || lpSupply <= 0n || maxIn < 0n || bps < 0n) return null;
  return (maxIn * lpSupply * BPS) / (reserve * (BPS + bps));
}

/** A deposit side's maximum: `ceil(cost·(10000+bps)/10000)`. Never below the cost. */
export function maxInFor(cost: bigint, bps: bigint): bigint {
  return (cost * (BPS + bps) + BPS - 1n) / BPS;
}

/** A withdrawal side's minimum: `max(1, floor(out·(10000−bps)/10000))`. Call it with `out ≥ 1`. */
export function minOutFor(out: bigint, bps: bigint): bigint {
  const m = (out * (BPS - bps)) / BPS;
  return m < 1n ? 1n : m;
}

/** The fewest shares that give both sides at least 1: `max(ceil(S/R0), ceil(S/R1))`. `null` with no price. */
export function minLpForBothSides(s: PoolSnapshot): bigint | null {
  const S = s.pool.lpSupply;
  if (S <= 0n || s.reserve0 <= 0n || s.reserve1 <= 0n) return null;
  const c = (r: bigint) => (S + r - 1n) / r;
  const a = c(s.reserve0);
  const b = c(s.reserve1);
  return a > b ? a : b;
}

export type PlanProblem =
  | { problem: 'no-price' }
  | { problem: 'overflow' }
  | { problem: 'too-small'; minLp: bigint | null }
  | { problem: 'over-balance'; side: 'quote' | 'token'; need: bigint; have: bigint; mostBoth: bigint | null }
  | { problem: 'dust-remainder'; keep: bigint; minLp: bigint }
  | { problem: 'bad-percent' }
  | { problem: 'nothing-held' };

export function isPlanProblem<T extends object>(p: T | PlanProblem): p is PlanProblem {
  return 'problem' in p;
}

export interface DepositPlan {
  lp: bigint;
  /** What the deposit costs on each side at this snapshot (ceiling). */
  cost0: bigint;
  cost1: bigint;
  /** The maxima the transaction carries. */
  max0: bigint;
  max1: bigint;
  /** The other side's maximum was lowered to what the wallet holds. */
  limitedByBalance: 'none' | 'quote' | 'token';
}

/**
 * A deposit where the person typed the most that may leave on one side (`driving`).
 * `availableQuote` / `availableToken` are null when not known; then no balance rule runs.
 */
export function planDeposit(
  s: PoolSnapshot,
  a: { quoteIsToken0: boolean; driving: 'quote' | 'token'; maxIn: bigint; bps: bigint; availableQuote: bigint | null; availableToken: bigint | null },
): DepositPlan | PlanProblem {
  const S = s.pool.lpSupply;
  const R0 = s.reserve0;
  const R1 = s.reserve1;
  // 1. No price on either side.
  if (S <= 0n || R0 <= 0n || R1 <= 0n) return { problem: 'no-price' };

  const drivingIs0 = (a.driving === 'quote') === a.quoteIsToken0;
  const rDriving = drivingIs0 ? R0 : R1;
  const rOther = drivingIs0 ? R1 : R0;
  const availDriving = a.driving === 'quote' ? a.availableQuote : a.availableToken;
  const availOther = a.driving === 'quote' ? a.availableToken : a.availableQuote;
  const otherSide: 'quote' | 'token' = a.driving === 'quote' ? 'token' : 'quote';
  const mostBoth = availDriving !== null && availOther !== null
    ? (() => {
        const viaOther = (availOther * rDriving) / rOther;
        return availDriving < viaOther ? availDriving : viaOther;
      })()
    : null;

  // 2. The shares the driving side can buy.
  const lp = lpForMaxIn(a.maxIn, rDriving, S, a.bps);
  if (lp === null) return { problem: 'no-price' };
  if (lp === 0n) return { problem: 'too-small', minLp: minLpForBothSides(s) };

  // 3. What they cost, the program's way.
  const cost = lpTokensToTradingTokens(lp, S, R0, R1, 'ceiling');
  if (!cost) return { problem: 'overflow' };
  if (cost.token0Amount === 0n || cost.token1Amount === 0n) return { problem: 'too-small', minLp: minLpForBothSides(s) };
  const costDriving = drivingIs0 ? cost.token0Amount : cost.token1Amount;
  const costOther = drivingIs0 ? cost.token1Amount : cost.token0Amount;

  // 4. The driving side's maximum is exactly what was typed.
  if (costDriving > a.maxIn) throw new Error('planDeposit: the driving side costs more than its maximum');
  const maxDriving = a.maxIn;

  // 5. The other side's maximum, lowered to the balance when the cost still fits it.
  let maxOther = maxInFor(costOther, a.bps);
  let limitedByBalance: DepositPlan['limitedByBalance'] = 'none';
  if (availOther !== null) {
    if (costOther > availOther) return { problem: 'over-balance', side: otherSide, need: costOther, have: availOther, mostBoth };
    if (maxOther > availOther) {
      maxOther = availOther;
      limitedByBalance = otherSide;
    }
  }

  // 6. The driving side must fit its own balance.
  if (availDriving !== null && a.maxIn > availDriving) {
    return { problem: 'over-balance', side: a.driving, need: a.maxIn, have: availDriving, mostBoth };
  }

  // 7. Nothing past u64, no maximum of u64::MAX, and the supply after must fit.
  const max0 = drivingIs0 ? maxDriving : maxOther;
  const max1 = drivingIs0 ? maxOther : maxDriving;
  for (const v of [lp, cost.token0Amount, cost.token1Amount]) if (v > U64_MAX) return { problem: 'overflow' };
  if (max0 > U64_MAX - 1n || max1 > U64_MAX - 1n) return { problem: 'overflow' };
  if (S + lp > U64_MAX) return { problem: 'overflow' };

  return { lp, cost0: cost.token0Amount, cost1: cost.token1Amount, max0, max1, limitedByBalance };
}

export interface WithdrawPlan {
  lp: bigint;
  /** What the withdrawal pays on each side at this snapshot (floor). */
  out0: bigint;
  out1: bigint;
  /** The minima the transaction carries. */
  min0: bigint;
  min1: bigint;
  /** Every share the account holds. */
  all: boolean;
  /** Shares left in the account afterwards. */
  keep: bigint;
}

/** A withdrawal of `pctBps` (1 to 10000) of `held`. 10000 is exactly `held`. */
export function planWithdraw(s: PoolSnapshot, a: { held: bigint; pctBps: bigint; bps: bigint }): WithdrawPlan | PlanProblem {
  // 1. Inputs.
  if (a.pctBps < 1n || a.pctBps > BPS) return { problem: 'bad-percent' };
  if (a.held < 1n) return { problem: 'nothing-held' };
  // 2. The shares.
  const lp = a.pctBps === BPS ? a.held : (a.held * a.pctBps) / BPS;
  const minLp = minLpForBothSides(s);
  if (lp < 1n) return { problem: 'too-small', minLp };
  // 3. What they pay, the program's way.
  const out = lpTokensToTradingTokens(lp, s.pool.lpSupply, s.reserve0, s.reserve1, 'floor');
  if (!out || out.token0Amount === 0n || out.token1Amount === 0n) return { problem: 'too-small', minLp };
  // 4. A remainder too small to ever take out.
  const keep = a.held - lp;
  if (keep > 0n && minLp !== null && keep < minLp) return { problem: 'dust-remainder', keep, minLp };
  // 5. The minima.
  return {
    lp,
    out0: out.token0Amount,
    out1: out.token1Amount,
    min0: minOutFor(out.token0Amount, a.bps),
    min1: minOutFor(out.token1Amount, a.bps),
    all: lp === a.held,
    keep,
  };
}

// ── opening a pool ────────────────────────────────────────────────────────────
//
// initialize.rs: the pool's whole share count is `isqrt(init0·init1)`, the program keeps
// `LOCKED_LP` of it in the pool forever, and the opener gets the rest. It refuses only
// BELOW 100 (`liquidity.checked_sub(100)`): at exactly 100 the opening LANDS and mints the
// opener nothing. This site's own rule steps over that trap and keeps the locked part
// at most 0.1% of the pool.

/** The pool shares cp-swap keeps in every new pool forever (initialize.rs). */
export const LOCKED_LP = 100n;
/**
 * The locked shares in words, as every share count on the site is written: in the share
 * token's 9 decimals, then in its smallest unit. "100 pool shares" would read a billion
 * times too large next to "You get". The page and the write layer both say it this way.
 */
export const LOCKED_SHARES_TEXT = `${(Number(LOCKED_LP) / 1e9).toFixed(9).replace(/0+$/, '')} pool shares (${LOCKED_LP.toString()} of the smallest unit)`;
/** The locked 100 may be at most this many basis points of the pool: 0.1%. */
export const MAX_LOCK_BPS = 10n;

/** Floor square root, exact for any size (Newton's method on bigint). RangeError below 0. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative number');
  if (n < 2n) return n;
  // Start at a power of two at or above the root, then step down to it.
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

export type CreateProblem =
  | { problem: 'empty-side' }
  | { problem: 'overflow' }
  /** supply ≤ 100: the program refuses it, or (at exactly 100) lands it and mints the opener nothing. */
  | { problem: 'too-small'; supply: bigint }
  /** 100 < supply < 100,000: the locked 100 would be more than 0.1% of the pool. */
  | { problem: 'lock-too-large'; supply: bigint }
  | { problem: 'over-balance'; side: 'quote' | 'token'; need: bigint; have: bigint };

/**
 * Why an opening with these amounts must not be built, or null. Order: an empty side,
 * a value past u64, a supply the program refuses or turns into nothing (≤ 100), and a
 * locked part above 0.1% of the pool.
 */
export function openingProblem(amount0: bigint, amount1: bigint): Exclude<CreateProblem, { problem: 'over-balance' }> | null {
  if (amount0 < 1n || amount1 < 1n) return { problem: 'empty-side' };
  if (amount0 > U64_MAX || amount1 > U64_MAX) return { problem: 'overflow' };
  const supply = isqrt(amount0 * amount1);
  if (supply <= LOCKED_LP) return { problem: 'too-small', supply };
  if (LOCKED_LP * BPS > supply * MAX_LOCK_BPS) return { problem: 'lock-too-large', supply };
  return null;
}

export interface CreatePlan {
  /** What `initialize` carries, by side: token0 first. */
  init0: bigint;
  init1: bigint;
  /** isqrt(quote·token): the pool's whole share count. */
  supply: bigint;
  /** What the opener gets: supply − 100. */
  lp: bigint;
  /** What the 100 locked shares are worth at these amounts (floor; display). */
  locked: { quote: bigint; token: bigint };
}

/**
 * An opening of exactly `quote` (of the pairing coin) and `token`. The share rule first
 * (`openingProblem`), then each side against what the wallet can put in. A `null`
 * balance was not read: it runs no rule and is never treated as 0.
 */
export function planCreate(a: {
  quoteIsToken0: boolean;
  quote: bigint;
  token: bigint;
  availableQuote: bigint | null;
  availableToken: bigint | null;
}): CreatePlan | CreateProblem {
  const problem = openingProblem(a.quote, a.token);
  if (problem) return problem;
  if (a.availableQuote !== null && a.quote > a.availableQuote) return { problem: 'over-balance', side: 'quote', need: a.quote, have: a.availableQuote };
  if (a.availableToken !== null && a.token > a.availableToken) {
    return { problem: 'over-balance', side: 'token', need: a.token, have: a.availableToken };
  }
  const supply = isqrt(a.quote * a.token);
  return {
    init0: a.quoteIsToken0 ? a.quote : a.token,
    init1: a.quoteIsToken0 ? a.token : a.quote,
    supply,
    lp: supply - LOCKED_LP,
    locked: { quote: (LOCKED_LP * a.quote) / supply, token: (LOCKED_LP * a.token) / supply },
  };
}

/**
 * The network-fee reserve held back from what a transaction may spend: 5,000 lamports per
 * signature plus the most priority fee this site's own transactions carry (1,000,000).
 * Pinned by a test to `LAMPORTS_PER_SIGNATURE` and `MAX_OWN_PRIORITY_LAMPORTS` (write
 * layer, budget.ts), which this web3-free file does not import. An opening always uses
 * two signatures' worth, whichever address it ends up at.
 */
export function feeReserveFor(signatures: 1 | 2): bigint {
  return 5_000n * BigInt(signatures) + 1_000_000n;
}

/**
 * SOL POOLS ONLY. The most SOL a deposit may take from this wallet (section 3.8, the rent band):
 * `max(0, lamports − feeReserve − lpAccountRent − max(wsolCreateRent, walletFloor))`.
 *   - during the transaction the wallet pays the WSOL account's rent (when it is
 *     created), the LP account's rent and the wrapped amount;
 *   - at the end it must keep its own rent floor even if all of that amount is used;
 *   - `wsolCreateRent` is 0 when the WSOL account already exists;
 *   - `alsoPaid` is anything else the transaction takes for good: for an opening, the fee
 *     to open plus the deposits for the pool's own accounts. Without it, every deposit's
 *     answer is what it always was.
 *
 * A pool paired with USDC or BAYLA puts no SOL in: what it can take of the coin is the
 * wallet's balance of that coin, and the wallet's SOL only has to cover `solSetAside`
 * (with no wrapped-SOL account, so `wsolCreateRent` 0).
 */
export function spendableSol(a: {
  lamports: bigint;
  walletFloor: bigint;
  feeReserve: bigint;
  lpAccountRent: bigint;
  wsolCreateRent: bigint;
  alsoPaid?: bigint;
}): bigint {
  const left = a.lamports - solSetAside(a);
  return left > 0n ? left : 0n;
}

/**
 * What `spendableSol` takes off a wallet before any SOL can go into a pool: fees, the
 * deposits it pays, and what must stay in the wallet. A wallet holding no more than
 * this can put nothing in, and the panels say this figure when they tell it so.
 */
export function solSetAside(a: {
  walletFloor: bigint;
  feeReserve: bigint;
  lpAccountRent: bigint;
  wsolCreateRent: bigint;
  alsoPaid?: bigint;
}): bigint {
  const hold = a.wsolCreateRent > a.walletFloor ? a.wsolCreateRent : a.walletFloor;
  return a.feeReserve + a.lpAccountRent + (a.alsoPaid ?? 0n) + hold;
}
