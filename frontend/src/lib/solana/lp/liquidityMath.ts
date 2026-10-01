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
  | { problem: 'over-balance'; side: 'sol' | 'token'; need: bigint; have: bigint; mostBoth: bigint | null }
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
  limitedByBalance: 'none' | 'sol' | 'token';
}

/**
 * A deposit where the person typed the most that may leave on one side (`driving`).
 * `availableSol` / `availableToken` are null when not known; then no balance rule runs.
 */
export function planDeposit(
  s: PoolSnapshot,
  a: { solIsToken0: boolean; driving: 'sol' | 'token'; maxIn: bigint; bps: bigint; availableSol: bigint | null; availableToken: bigint | null },
): DepositPlan | PlanProblem {
  const S = s.pool.lpSupply;
  const R0 = s.reserve0;
  const R1 = s.reserve1;
  // 1. No price on either side.
  if (S <= 0n || R0 <= 0n || R1 <= 0n) return { problem: 'no-price' };

  const drivingIs0 = (a.driving === 'sol') === a.solIsToken0;
  const rDriving = drivingIs0 ? R0 : R1;
  const rOther = drivingIs0 ? R1 : R0;
  const availDriving = a.driving === 'sol' ? a.availableSol : a.availableToken;
  const availOther = a.driving === 'sol' ? a.availableToken : a.availableSol;
  const otherSide: 'sol' | 'token' = a.driving === 'sol' ? 'token' : 'sol';
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

/**
 * The most SOL a deposit may take from this wallet (section 3.8, the rent band):
 * `max(0, lamports − feeReserve − lpAccountRent − max(wsolCreateRent, walletFloor))`.
 *   - during the transaction the wallet pays the WSOL account's rent (when it is
 *     created), the LP account's rent and the wrapped amount;
 *   - at the end it must keep its own rent floor even if all of that amount is used;
 *   - `wsolCreateRent` is 0 when the WSOL account already exists.
 */
export function spendableSol(a: { lamports: bigint; walletFloor: bigint; feeReserve: bigint; lpAccountRent: bigint; wsolCreateRent: bigint }): bigint {
  const hold = a.wsolCreateRent > a.walletFloor ? a.wsolCreateRent : a.walletFloor;
  const left = a.lamports - a.feeReserve - a.lpAccountRent - hold;
  return left > 0n ? left : 0n;
}
