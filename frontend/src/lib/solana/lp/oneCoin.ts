import type { AmmConfigView } from '../cpswap/program';
import { quoteOwnPool, type OwnPoolQuote, type PoolSnapshot } from '../cpswap/read';
import { isPlanProblem, planDeposit, type DepositPlan, type PlanProblem } from './liquidityMath';

/**
 * "Add with one coin", the arithmetic only: step 1 swaps part of one coin for the other,
 * step 2 deposits what was kept and what came back at the pool's ratio. Pure bigint.
 * `paid` is the side the person pays with; amounts are in each side's own base units.
 */

export type Side = 'quote' | 'token';
type FeeConfig = Pick<AmmConfigView, 'tradeFeeRate' | 'protocolFeeRate' | 'fundFeeRate' | 'creatorFeeRate'>;

/**
 * The pool as a deposit prices it right after `q`, a quote of `amountIn` in it
 * (cp-swap swap_base_input): the whole input lands in its vault less the fees the pool
 * books apart; the output side loses what was paid out and any creator fee taken off it.
 */
export function poolAfterSwap(s: PoolSnapshot, inputMint: string, amountIn: bigint, q: OwnPoolQuote): PoolSnapshot {
  const in0 = inputMint === s.pool.token0Mint;
  const r = q.result;
  const reserveIn = q.reserveIn + amountIn - r.protocolFee - r.fundFee - (q.creatorFeeOnInput ? r.creatorFee : 0n);
  const reserveOut = r.newOutputVaultAmount;
  const vaultIn = (in0 ? s.vault0Amount : s.vault1Amount) + amountIn;
  const vaultOut = (in0 ? s.vault1Amount : s.vault0Amount) - r.outputAmount;
  return in0
    ? { ...s, reserve0: reserveIn, reserve1: reserveOut, vault0Amount: vaultIn, vault1Amount: vaultOut }
    : { ...s, reserve0: reserveOut, reserve1: reserveIn, vault0Amount: vaultOut, vault1Amount: vaultIn };
}

export interface OwnShare {
  swapIn: bigint;
  out: bigint;
  quote: OwnPoolQuote;
  /** The pool after the swap: what step 2 is priced on. */
  after: PoolSnapshot;
}

/**
 * The part of `total` to swap in THIS pool: the largest swap after which what is kept
 * and what comes back still stand at least at the pool's own ratio after the swap (the
 * swap moves it). Anything left over is then on the paid side. Null when the pool cannot
 * price any part of it.
 */
export function ownPoolShare(s: PoolSnapshot, config: FeeConfig, inputMint: string, total: bigint, nowSecs: number): OwnShare | null {
  const in0 = inputMint === s.pool.token0Mint;
  const at = (swapIn: bigint): OwnShare | null => {
    const q = quoteOwnPool(s, config, inputMint, swapIn, nowSecs);
    return q && q.outAmount > 0n ? { swapIn, out: q.outAmount, quote: q, after: poolAfterSwap(s, inputMint, swapIn, q) } : null;
  };
  // kept / out >= reserveIn' / reserveOut'
  const keepsEnough = (x: OwnShare) => (total - x.swapIn) * (in0 ? x.after.reserve1 : x.after.reserve0) >= x.out * (in0 ? x.after.reserve0 : x.after.reserve1);
  let lo = 1n;
  let hi = total - 1n;
  let best: OwnShare | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) / 2n;
    const x = at(mid);
    if (x === null || keepsEnough(x)) {
      if (x) best = x;
      lo = mid + 1n;
    } else hi = mid - 1n;
  }
  return best;
}

/**
 * The part of `total` to swap somewhere else (this pool's ratio does not move), from a
 * quote that paid `quotedOut` for `quotedIn`: kept / out = reserveIn / reserveOut with
 * out read at that quote's rate. Null without a price on either side.
 */
export function outsideShare(total: bigint, quotedIn: bigint, quotedOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint | null {
  if (total <= 0n || quotedIn <= 0n || quotedOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) return null;
  return (total * reserveOut * quotedIn) / (reserveOut * quotedIn + quotedOut * reserveIn);
}

export interface StepTwo {
  /** The side whose amount is typed into the Add form, and that amount. */
  driving: Side;
  maxIn: bigint;
  plan: DepositPlan;
  /** What stays in the wallet of what step 1 left, at this deposit's own quote. */
  left: Record<Side, bigint>;
}

/**
 * Step 2 from what step 1 left and nothing more: `kept` of the paid side, `got` of the
 * other. The paid side drives unless it would need more of the other side than `got`;
 * then the other side drives at `got`.
 */
export function stepTwo(s: PoolSnapshot, a: { quoteIsToken0: boolean; paid: Side; kept: bigint; got: bigint; bps: bigint }): StepTwo | PlanProblem {
  const has = (side: Side) => (side === a.paid ? a.kept : a.got);
  const plan = (driving: Side) =>
    planDeposit(s, { quoteIsToken0: a.quoteIsToken0, driving, maxIn: has(driving), bps: a.bps, availableQuote: has('quote'), availableToken: has('token') });
  let driving: Side = a.paid;
  let p = plan(driving);
  if (isPlanProblem(p) && p.problem === 'over-balance') {
    driving = a.paid === 'quote' ? 'token' : 'quote';
    p = plan(driving);
  }
  if (isPlanProblem(p)) return p;
  const cost: Record<Side, bigint> = { quote: a.quoteIsToken0 ? p.cost0 : p.cost1, token: a.quoteIsToken0 ? p.cost1 : p.cost0 };
  return { driving, maxIn: has(driving), plan: p, left: { quote: has('quote') - cost.quote, token: has('token') - cost.token } };
}
