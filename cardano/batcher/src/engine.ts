// What a batch must do to a pool and to each order, as the pool contract computes it:
// a port of `apply_orders` and the per-type validate_* functions in
// cardano/minswap-dex-v2/lib/amm_dex_v2/order_validation.ak. Given the pool's state and the
// orders in processing order, it returns the pool's next state and, for each order, the
// exact output the contract will demand (receiver, datum rule, value), or it throws:
//   - ContractFailure: the contract would reject the whole batch with this order in it;
//   - Unsupported: an order type this batcher does not build (left for its owner to cancel).
// It never "rounds to fit": the contract compares values exactly.
import {
  ContractFailure,
  calculateAmountIn,
  calculateAmountOut,
  calculateDepositAmount,
  calculateEarnedFeeIn,
  calculateWithdraw,
  div,
} from './math.ts';
import { ADA, isAda, sameAsset, type Address, type AmountOption, type Asset, type ExtraOrderDatum, type OrderDatum } from './types.ts';
import { add, hasNegative, quantityOf, type Value } from './value.ts';

export class Unsupported extends Error {
  readonly kind: string;
  constructor(kind: string, message = `order type ${kind} is not built by this batcher`) {
    super(message);
    this.kind = kind;
  }
}

/** The pool's numbers the contract threads through a batch (types.ak PoolState). */
export interface PoolState {
  datumReserveA: bigint;
  datumReserveB: bigint;
  valueReserveA: bigint;
  valueReserveB: bigint;
  totalLiquidity: bigint;
}

/** What stays fixed for one pool across the batch (types.ak BatchingPool, less the states). */
export interface PoolContext {
  assetA: Asset;
  assetB: Asset;
  lpAsset: Asset;
  tradingFeeA: bigint;
  tradingFeeB: bigint;
  feeSharing: bigint | null;
}

export interface OrderInput {
  value: Value;
  datum: OrderDatum;
}

/** The output the contract demands for one order. */
export interface OrderOutput {
  receiver: Address;
  receiverDatum: ExtraOrderDatum;
  value: Value;
  /** True when the order was filled, false when the batcher returned it (price check failed, killable). */
  filled: boolean;
}

function expect(ok: boolean, where: string): void {
  if (!ok) throw new ContractFailure(where);
}

function amountFrom(option: AmountOption, inValue: Value, asset: Asset, what: string): bigint {
  if (option.kind === 'specific') return option.amount;
  expect(option.deducted >= 0n, `${what}: deducted amount negative`);
  return quantityOf(inValue, asset) - option.deducted;
}

/** order_validation.ak get_returnable_value: the whole order back, less the batcher fee. */
function returnable(inValue: Value, usedFee: bigint): Value {
  return add(inValue, ADA, -usedFee);
}

function refund(order: OrderInput, usedFee: bigint, killable: boolean, state: PoolState, what: string): { state: PoolState; output: OrderOutput } {
  expect(killable, `${what}: price check failed and the order is not killable`);
  const value = returnable(order.value, usedFee);
  expect(!hasNegative(value), `${what}: the refund would be negative`);
  return { state, output: { receiver: order.datum.refundReceiver, receiverDatum: order.datum.refundReceiverDatum, value, filled: false } };
}

function success(order: OrderInput, value: Value, what: string): OrderOutput {
  expect(!hasNegative(value), `${what}: the output would hold a negative amount`);
  return { receiver: order.datum.successReceiver, receiverDatum: order.datum.successReceiverDatum, value, filled: true };
}

/** order_validation.ak get_swap_output_value. */
function swapOutputValue(inValue: Value, usedFee: bigint, assetIn: Asset, assetOut: Asset, amountIn: bigint, amountOut: bigint): Value {
  if (isAda(assetIn)) return add(add(inValue, ADA, -(usedFee + amountIn)), assetOut, amountOut);
  if (isAda(assetOut)) return add(add(inValue, ADA, amountOut - usedFee), assetIn, -amountIn);
  return add(add(add(inValue, ADA, -usedFee), assetIn, -amountIn), assetOut, amountOut);
}

/**
 * order_validation.ak get_optimized_swap_output_value's hard failures. For an ADA pair it
 * `fail`s, rather than returning None, when an ADA-only order swaps B to A, and when an order
 * holding ADA and B alone swaps more B than it holds. (Every other case it computes the same
 * value as get_swap_output_value, so the generic computation stands.)
 */
function swapOutputHardFailures(ctx: PoolContext, inValue: Value, aToB: boolean, amountIn: bigint, what: string): void {
  if (!isAda(ctx.assetA)) return;
  const others = [...inValue.keys()].filter((u) => u !== '');
  if (others.length === 0) expect(aToB, `${what}: an ADA-only order swapping B to A`);
  if (others.length === 1 && !aToB) {
    const onlyIsB = others[0] === `${ctx.assetB.policyId}.${ctx.assetB.assetName}`;
    if (onlyIsB) expect(quantityOf(inValue, ctx.assetB) >= amountIn, `${what}: swaps more B than it holds`);
  }
}

function swapExactIn(ctx: PoolContext, state: PoolState, order: OrderInput, usedFee: bigint, step: Extract<OrderDatum['step'], { kind: 'SwapExactIn' }>) {
  const what = 'SwapExactIn';
  expect(step.minimumReceive > 0n, `${what}: minimum_receive not positive`);
  const [assetIn, assetOut, reserveIn, reserveOut, fee] = step.aToB
    ? [ctx.assetA, ctx.assetB, state.datumReserveA, state.datumReserveB, ctx.tradingFeeA]
    : [ctx.assetB, ctx.assetA, state.datumReserveB, state.datumReserveA, ctx.tradingFeeB];
  const swapAmount = amountFrom(step.swapAmount, order.value, assetIn, what);
  expect(swapAmount > 0n, `${what}: swap amount not positive`);
  const amountOut = calculateAmountOut(reserveIn, reserveOut, swapAmount, fee);
  const earnedFeeIn = calculateEarnedFeeIn(swapAmount, fee, ctx.feeSharing);
  if (amountOut < step.minimumReceive) return refund(order, usedFee, step.killable, state, what);
  swapOutputHardFailures(ctx, order.value, step.aToB, swapAmount, what);
  const output = success(order, swapOutputValue(order.value, usedFee, assetIn, assetOut, swapAmount, amountOut), what);
  const next: PoolState = step.aToB
    ? { ...state, datumReserveA: state.datumReserveA + swapAmount - earnedFeeIn, datumReserveB: state.datumReserveB - amountOut, valueReserveA: state.valueReserveA + swapAmount, valueReserveB: state.valueReserveB - amountOut }
    : { ...state, datumReserveA: state.datumReserveA - amountOut, datumReserveB: state.datumReserveB + swapAmount - earnedFeeIn, valueReserveA: state.valueReserveA - amountOut, valueReserveB: state.valueReserveB + swapAmount };
  return { state: next, output };
}

function swapExactOut(ctx: PoolContext, state: PoolState, order: OrderInput, usedFee: bigint, step: Extract<OrderDatum['step'], { kind: 'SwapExactOut' }>) {
  const what = 'SwapExactOut';
  expect(step.expectedReceive > 0n, `${what}: expected_receive not positive`);
  const [assetIn, assetOut, reserveIn, reserveOut, fee] = step.aToB
    ? [ctx.assetA, ctx.assetB, state.datumReserveA, state.datumReserveB, ctx.tradingFeeA]
    : [ctx.assetB, ctx.assetA, state.datumReserveB, state.datumReserveA, ctx.tradingFeeB];
  // Computed before the slippage check, as the contract does: an expected amount at or above
  // the reserve fails the whole batch, it is never a refund.
  const necessaryIn = calculateAmountIn(reserveIn, reserveOut, step.expectedReceive, fee);
  const earnedFeeIn = calculateEarnedFeeIn(necessaryIn, fee, ctx.feeSharing);
  const maximum = amountFrom(step.maximumSwapAmount, order.value, assetIn, what);
  expect(maximum > 0n, `${what}: maximum swap amount not positive`);
  if (necessaryIn > maximum) return refund(order, usedFee, step.killable, state, what);
  const output = success(order, swapOutputValue(order.value, usedFee, assetIn, assetOut, necessaryIn, step.expectedReceive), what);
  const next: PoolState = step.aToB
    ? { ...state, datumReserveA: state.datumReserveA + necessaryIn - earnedFeeIn, datumReserveB: state.datumReserveB - step.expectedReceive, valueReserveA: state.valueReserveA + necessaryIn, valueReserveB: state.valueReserveB - step.expectedReceive }
    : { ...state, datumReserveA: state.datumReserveA - step.expectedReceive, datumReserveB: state.datumReserveB + necessaryIn - earnedFeeIn, valueReserveA: state.valueReserveA - step.expectedReceive, valueReserveB: state.valueReserveB + necessaryIn };
  return { state: next, output };
}

function deposit(ctx: PoolContext, state: PoolState, order: OrderInput, usedFee: bigint, step: Extract<OrderDatum['step'], { kind: 'Deposit' }>) {
  const what = 'Deposit';
  expect(step.minimumLp > 0n, `${what}: minimum_lp not positive`);
  let a: bigint;
  let b: bigint;
  if (step.amount.kind === 'specific') {
    a = step.amount.a;
    b = step.amount.b;
  } else {
    expect(step.amount.deductedA >= 0n && step.amount.deductedB >= 0n, `${what}: deducted amount negative`);
    a = quantityOf(order.value, ctx.assetA) - step.amount.deductedA;
    b = quantityOf(order.value, ctx.assetB) - step.amount.deductedB;
  }
  expect(a >= 0n && b >= 0n && a + b > 0n, `${what}: amounts not valid`);
  const [earnedA, earnedB, lp] = calculateDepositAmount(a, b, state.datumReserveA, state.datumReserveB, state.totalLiquidity, ctx.tradingFeeA, ctx.tradingFeeB, ctx.feeSharing);
  if (lp < step.minimumLp) return refund(order, usedFee, step.killable, state, what);
  const value = add(add(add(add(order.value, ADA, -usedFee), ctx.assetA, -a), ctx.assetB, -b), ctx.lpAsset, lp);
  const output = success(order, value, what);
  return {
    state: {
      datumReserveA: state.datumReserveA + a - earnedA,
      datumReserveB: state.datumReserveB + b - earnedB,
      valueReserveA: state.valueReserveA + a,
      valueReserveB: state.valueReserveB + b,
      totalLiquidity: state.totalLiquidity + lp,
    },
    output,
  };
}

function withdraw(ctx: PoolContext, state: PoolState, order: OrderInput, usedFee: bigint, step: Extract<OrderDatum['step'], { kind: 'Withdraw' }>) {
  const what = 'Withdraw';
  expect(step.minimumA > 0n && step.minimumB > 0n, `${what}: minimums not positive`);
  const lpAmount = amountFrom(step.lpAmount, order.value, ctx.lpAsset, what);
  expect(lpAmount > 0n, `${what}: LP amount not positive`);
  const [outA, outB] = calculateWithdraw(state.datumReserveA, state.datumReserveB, lpAmount, state.totalLiquidity);
  if (!(outA >= step.minimumA && outB >= step.minimumB)) return refund(order, usedFee, step.killable, state, what);
  const value = add(add(add(add(order.value, ADA, -usedFee), ctx.lpAsset, -lpAmount), ctx.assetA, outA), ctx.assetB, outB);
  const output = success(order, value, what);
  return {
    state: {
      datumReserveA: state.datumReserveA - outA,
      datumReserveB: state.datumReserveB - outB,
      valueReserveA: state.valueReserveA - outA,
      valueReserveB: state.valueReserveB - outB,
      totalLiquidity: state.totalLiquidity - lpAmount,
    },
    output,
  };
}

/**
 * apply_orders for one order: the checks every order passes (fees, pool, expiry), then its
 * type. `nowMs` is the contract's time: the midpoint of the batch's validity window.
 */
export function applyOrder(ctx: PoolContext, state: PoolState, order: OrderInput, usedFee: bigint, nowMs: bigint): { state: PoolState; output: OrderOutput } {
  const d = order.datum;
  expect(d.maxBatcherFee > 0n, 'max_batcher_fee not positive');
  expect(usedFee > 0n, 'batcher fee not positive');
  expect(usedFee <= d.maxBatcherFee, 'batcher fee above the order maximum');
  expect(sameAsset(d.lpAsset, ctx.lpAsset), 'the order names another pool');
  if (d.expiry !== null) expect(nowMs <= d.expiry.expiredTime, 'the order has expired');
  // The ledger bounds pointer addresses (32-bit slot, 16-bit indexes) where CSL does not, so
  // an output to one may not read back as the datum names it: such orders are left alone.
  if (d.successReceiver.stake?.kind === 'pointer' || d.refundReceiver.stake?.kind === 'pointer') throw new Unsupported('a receiver with a pointer address');
  switch (d.step.kind) {
    case 'SwapExactIn':
      return swapExactIn(ctx, state, order, usedFee, d.step);
    case 'SwapExactOut':
      return swapExactOut(ctx, state, order, usedFee, d.step);
    case 'Deposit':
      return deposit(ctx, state, order, usedFee, d.step);
    case 'Withdraw':
      return withdraw(ctx, state, order, usedFee, d.step);
    case 'Unsupported':
      throw new Unsupported(d.step.name);
  }
}

/** apply_orders: every order in processing order, each with its fee; outputs in the same order. */
export function applyOrders(ctx: PoolContext, state: PoolState, orders: OrderInput[], fees: bigint[], nowMs: bigint): { state: PoolState; outputs: OrderOutput[] } {
  expect(orders.length > 0, 'no orders');
  expect(fees.length >= orders.length, 'fewer fees than orders');
  const outputs: OrderOutput[] = [];
  let s = state;
  orders.forEach((o, i) => {
    const r = applyOrder(ctx, s, o, fees[i]!, nowMs);
    s = r.state;
    outputs.push(r.output);
  });
  return { state: s, outputs };
}

/** utils.ak `min_pool_ada`: the lovelace a pool holds on top of its ADA reserve. */
export const MIN_POOL_ADA = 4_500_000n;

/**
 * pool_validation.ak get_trading_fee_numerator: the base fee, plus the batch's volatility fee
 * (0 to 200) only when the pool allows dynamic fees; the result must stay within 5 to 2000.
 */
export function tradingFeeNumerator(baseFee: bigint, volFee: bigint | null, allowDynamicFee: boolean): bigint {
  let fee = baseFee;
  if (allowDynamicFee && volFee !== null) {
    expect(volFee >= 0n && volFee <= 200n, 'volatility fee out of range');
    fee = volFee + baseFee;
  }
  expect(fee >= 5n && fee <= 2000n, 'trading fee out of range');
  return fee;
}

/** utils.ak must_get_current_time_approximation: both bounds set, at most 10 minutes apart, the midpoint. */
export function currentTimeApproximation(startMs: bigint | null, endMs: bigint | null): bigint {
  expect(startMs !== null && endMs !== null, 'the validity window must have both ends');
  expect(endMs! - startMs! <= 600_000n, 'the validity window is longer than 10 minutes');
  return div(endMs! - startMs!, 2n) + startMs!;
}
