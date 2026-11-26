import type { PoolSnapshot } from '../cpswap/read';
import { LOCKED_LP, NO_FEES, planDeposit, planWithdrawShares, tooFewShares, type DepositPlan, type PlanProblem, type PoolFees, type WithdrawPlan } from './liquidityMath';
import { afterFee, preFeeAmountOf } from './transferFee';

const BPS = 10_000n;

/**
 * RESTARTING AN ALMOST EMPTY POOL AT THE MARKET PRICE (owner, 2026-11-26: "allow the new
 * person to use market price").
 *
 * A pool everyone has left holds the 100 shares the pool program locks forever and a few
 * units of each coin. Its price is whatever those few units say, and anyone can move it
 * for next to nothing, so no ordinary deposit goes in (poolHealth.ts `NEARLY_EMPTY`, audit
 * CM-2). A restart is ONE transaction of three steps, worked out here and built by the
 * write layer (`prepareLpRestart`):
 *
 *   1. THE TOP-UP. A few more units of the short side are sent straight into its vault, so
 *      the pool's two sides stand at the market price (`restartTargets`). They stay in the
 *      pool for good: they belong to the locked 100 shares, which nobody can take out.
 *   2. THE DEPOSIT, at the pool as the top-up leaves it (`planDeposit`, unchanged). Its
 *      maxima hold what each share may cost from ABOVE.
 *   3. THE CHECK-BACK. A sliver of the new shares is taken straight back out
 *      (`planWithdrawShares`, unchanged), and its minima hold what each share is worth
 *      from BELOW.
 *
 * Why the third step. If someone changes the pool between the read and the transaction,
 * the top-up no longer lands it on the market price. A trade or a gift into a vault makes a
 * share cost MORE on a side, and the deposit's maximum refuses it. But a deposit of their
 * own at the old price adds shares, so the top-up is spread over more of them and a share
 * costs LESS on its side: every maximum still passes, the deposit goes in at a price
 * between the old one and the market's, and whoever trades it back takes the difference.
 * Only a floor catches that, and the pool program's floor is a withdrawal's minimum. With
 * both, each share's two sides are held to within the tolerance of what was worked out
 * here, so the deposit goes in at the market price or the whole transaction fails and only
 * the network fee is spent. What someone who moved the pool first can still take is at
 * most the top-up, which is said on the review.
 *
 * ONLY A POOL NOBODY OWNS ANY OF: its share count is exactly the locked 100 (`LOCKED_LP`).
 * The top-up then belongs to those 100 shares, which nobody can take out, and the rule that
 * the restart must lift the pool past 100,000 shares caps it at about 0.1% of the deposit.
 * With any other share outstanding, the top-up would be its holder's to withdraw, and a
 * holder can make it as large as they like by sending coins into the pool first: the review
 * of 2026-11-26 ran one where a 0.05 SOL restart handed another holder about 1 SOL. The
 * pool program counts every share ever minted and not withdrawn in `lp_supply` (shares
 * burned without a withdrawal included), so a count of exactly 100 means no one holds any.
 */

/** The fewest units the side worked out from the price holds after the top-up: its rounding moves the price at most 0.05%. */
export const RESTART_PRICE_UNITS = 1_000n;
/** The check-back pays at least this many units on each side, so its rounding is at most 0.1% of what its minimum holds. */
export const CHECK_BACK_UNITS = 1_000n;
/** The check-back takes back at most this share of the shares the deposit buys: 10%. */
export const CHECK_BACK_MAX_BPS = 1_000n;

/** The pool's two sides after the top-up, token0 first, and what the top-up adds to each, as the pool counts them. */
export interface RestartTargets {
  reserve0: bigint;
  reserve1: bigint;
  topUp0: bigint;
  topUp1: bigint;
}

export interface RestartPrice {
  quoteIsToken0: boolean;
  quoteDecimals: number;
  tokenDecimals: number;
  /** The market price: whole pairing coins per whole token (poolHealth.ts `restart.perToken`). */
  perToken: number;
}

/**
 * Where the top-up must leave the pool's two sides so they stand at `perToken`. Only ever
 * more of a side, never less: the side worth more at the market price stays as it is, and
 * the other is raised to match it. When that side would hold fewer than
 * `RESTART_PRICE_UNITS`, both are raised together, so one unit of rounding cannot move the
 * price by much. Null when the pool is empty on a side or the price is not a positive number.
 */
export function restartTargets(s: PoolSnapshot, a: RestartPrice): RestartTargets | null {
  const rq = a.quoteIsToken0 ? s.reserve0 : s.reserve1;
  const rt = a.quoteIsToken0 ? s.reserve1 : s.reserve0;
  if (rq <= 0n || rt <= 0n) return null;
  // Pairing-coin base units per token base unit.
  const r = a.perToken * 10 ** (a.quoteDecimals - a.tokenDecimals);
  if (!(r > 0) || !Number.isFinite(r)) return null;
  const keepQuote = Number(rq) / r >= Number(rt);
  const kept = keepQuote ? rq : rt;
  const otherOf = (k: bigint) => (keepQuote ? Number(k) / r : Number(k) * r);
  const first = otherOf(kept);
  if (!(first > 0) || !Number.isFinite(first)) return null;
  const scale = first >= Number(RESTART_PRICE_UNITS) ? 1 : Math.ceil(Number(RESTART_PRICE_UNITS) / first);
  if (!Number.isSafeInteger(scale)) return null;
  const keptAfter = kept * BigInt(scale);
  const other = otherOf(keptAfter);
  if (!Number.isFinite(other) || other > Number.MAX_SAFE_INTEGER) return null;
  const otherAfter = BigInt(Math.round(other));
  const [tq, tt] = keepQuote ? [keptAfter, otherAfter] : [otherAfter, keptAfter];
  if (tq < rq || tt < rt) return null;
  const [t0, t1] = a.quoteIsToken0 ? [tq, tt] : [tt, tq];
  return { reserve0: t0, reserve1: t1, topUp0: t0 - s.reserve0, topUp1: t1 - s.reserve1 };
}

export type RestartProblem =
  | PlanProblem
  /** No market price to restart at, or the pool is empty on a side. */
  | { problem: 'no-target' }
  /**
   * Too little goes in for the pool to stop being almost empty, or for the check-back to be
   * a sliver. `least`: the smallest amount on the side typed that would do, or null when
   * none would. That rule also caps the top-up: the locked 100 shares own it, and they may
   * be at most 0.1% of the pool, so it is never worth more than about 0.1% of what goes in.
   */
  | { problem: 'too-small-to-restart'; least: bigint | null };

export interface RestartPlan {
  targets: RestartTargets;
  /** What leaves the wallet for the top-up, token0 first: what reaches the vault, plus the token's transfer fee. 0 = that side is not topped up. */
  topUpSent0: bigint;
  topUpSent1: bigint;
  /** The deposit, worked out on the pool as the top-up leaves it. */
  deposit: DepositPlan;
  /** The check-back: `check.lp` of the new shares, straight back out, on the pool as the deposit leaves it. */
  check: WithdrawPlan;
  /** The shares the wallet keeps: `deposit.lp − check.lp`. */
  keep: bigint;
  /** The top-up's worth at the market price, in the pairing coin's base units, rounded up. Display only. */
  costQuote: bigint;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * A restart where the person typed the most that may leave on one side, as for a deposit
 * (`planDeposit`). `availableQuote` / `availableToken` are what the wallet can put in all
 * told: the top-up comes out of them first. Null balances run no balance rule.
 */
export type RestartArgs = RestartPrice & {
  driving: 'quote' | 'token';
  maxIn: bigint;
  bps: bigint;
  availableQuote: bigint | null;
  availableToken: bigint | null;
  fees?: PoolFees;
};

export function planRestart(s: PoolSnapshot, a: RestartArgs): RestartPlan | RestartProblem {
  const p = restartAt(s, a);
  if (!('problem' in p) || (p.problem !== 'too-small-to-restart' && p.problem !== 'too-small')) return p;
  return { problem: 'too-small-to-restart', least: leastRestart(s, a) };
}

/** Too small at `maxIn`, with no balance rule: the restart's own size rule, nothing else. */
const tooSmallAt = (s: PoolSnapshot, a: RestartArgs, maxIn: bigint) => {
  const p = restartAt(s, { ...a, maxIn, availableQuote: null, availableToken: null });
  return 'problem' in p && (p.problem === 'too-small-to-restart' || p.problem === 'too-small');
};

/**
 * The smallest amount on the side typed that is not too small to restart, found by halving
 * (the rule only ever eases as the amount grows). Null when nothing up to u64 would do.
 */
function leastRestart(s: PoolSnapshot, a: RestartArgs): bigint | null {
  let hi = 1n;
  while (tooSmallAt(s, a, hi)) {
    if (hi > 1n << 62n) return null;
    hi *= 2n;
  }
  let lo = hi / 2n;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (tooSmallAt(s, a, mid)) lo = mid;
    else hi = mid;
  }
  return hi;
}

function restartAt(s: PoolSnapshot, a: RestartArgs): RestartPlan | RestartProblem {
  const fees = a.fees ?? NO_FEES;
  // A pool nobody owns any of, and nothing else (above).
  if (s.pool.lpSupply !== LOCKED_LP) return { problem: 'no-target' };
  const t = restartTargets(s, a);
  if (!t) return { problem: 'no-target' };

  // 1. The top-up, as it leaves the wallet: a side with a transfer fee sends the fee on top.
  const sentFor = (fee: PoolFees[number], reach: bigint) => (reach === 0n ? 0n : fee ? preFeeAmountOf(fee, reach) : reach);
  const sent0 = sentFor(fees[0], t.topUp0);
  const sent1 = sentFor(fees[1], t.topUp1);
  if (sent0 === null || sent1 === null) return { problem: 'transfer-fee' };
  // What actually reaches each vault: a fee can round in the pool's favour.
  const targets: RestartTargets = {
    reserve0: s.reserve0 + afterFee(fees[0], sent0),
    reserve1: s.reserve1 + afterFee(fees[1], sent1),
    topUp0: afterFee(fees[0], sent0),
    topUp1: afterFee(fees[1], sent1),
  };
  const sentQuote = a.quoteIsToken0 ? sent0 : sent1;
  const sentToken = a.quoteIsToken0 ? sent1 : sent0;

  // 2. The deposit, on the pool as the top-up leaves it, from what the top-up leaves the wallet.
  const less = (have: bigint | null, sent: bigint) => (have === null ? null : have > sent ? have - sent : 0n);
  const topped: PoolSnapshot = { ...s, reserve0: targets.reserve0, reserve1: targets.reserve1 };
  const deposit = planDeposit(topped, {
    quoteIsToken0: a.quoteIsToken0,
    driving: a.driving,
    maxIn: a.maxIn,
    bps: a.bps,
    availableQuote: less(a.availableQuote, sentQuote),
    availableToken: less(a.availableToken, sentToken),
    fees,
  });
  if ('problem' in deposit) {
    // Said as the wallet's own figures: what the side needs all told, against what it holds.
    if (deposit.problem === 'over-balance') {
      const sent = deposit.side === 'quote' ? sentQuote : sentToken;
      const have = deposit.side === 'quote' ? a.availableQuote : a.availableToken;
      return { ...deposit, need: deposit.need + sent, have: have ?? deposit.have };
    }
    return deposit;
  }

  // 3. The check-back, on the pool as the deposit leaves it: the fewest shares that pay at
  // least CHECK_BACK_UNITS on each side.
  const after: PoolSnapshot = {
    ...topped,
    pool: { ...s.pool, lpSupply: s.pool.lpSupply + deposit.lp },
    reserve0: targets.reserve0 + deposit.cost0 - deposit.fee0,
    reserve1: targets.reserve1 + deposit.cost1 - deposit.fee1,
  };
  const S = after.pool.lpSupply;
  const w0 = ceilDiv(CHECK_BACK_UNITS * S, after.reserve0);
  const w1 = ceilDiv(CHECK_BACK_UNITS * S, after.reserve1);
  const w = w0 > w1 ? w0 : w1;
  if (w * BPS > deposit.lp * CHECK_BACK_MAX_BPS) return { problem: 'too-small-to-restart', least: null };
  const check = planWithdrawShares(after, { held: deposit.lp, lp: w, bps: a.bps, fees });
  if ('problem' in check) return check.problem === 'overflow' ? check : { problem: 'too-small-to-restart', least: null };
  // The pool must stop being almost empty, or the next deposit is refused all over again.
  if (tooFewShares(S - check.lp)) return { problem: 'too-small-to-restart', least: null };

  // 4. The top-up's worth at the market price, in the coin's units: what the review says it costs.
  const r = a.perToken * 10 ** (a.quoteDecimals - a.tokenDecimals);
  const [tq, tt] = a.quoteIsToken0 ? [targets.topUp0, targets.topUp1] : [targets.topUp1, targets.topUp0];
  const costFloat = Number(tq) + Number(tt) * r;
  if (!Number.isFinite(costFloat)) return { problem: 'no-target' };
  const costQuote = BigInt(Math.ceil(costFloat));

  return { targets, topUpSent0: sent0, topUpSent1: sent1, deposit, check, keep: deposit.lp - check.lp, costQuote };
}
