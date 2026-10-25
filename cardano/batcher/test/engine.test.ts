// The engine's refusals and refunds: the rules a valid batch never trips, so the replay of real
// batches cannot show them. Each case is the contract's (order_validation.ak apply_orders and
// the validate_* functions): one changed field from an order that fills.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Unsupported, applyOrder, currentTimeApproximation, tradingFeeNumerator, type OrderInput, type PoolContext, type PoolState } from '../src/engine.ts';
import { ContractFailure } from '../src/math.ts';
import { ADA, type Address, type Asset, type OrderDatum } from '../src/types.ts';
import { quantityOf, valueOf } from '../src/value.ts';

const MIN: Asset = { policyId: '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6', assetName: '4d494e' };
const LP: Asset = { policyId: 'f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c', assetName: '82e2b1fd27a7712a1a9cf750dfbea1a5778611b20e06dd6a611df7a643f8cb75' };
const TRADER: Address = { payment: { kind: 'key', hash: '02116dcc48a8db6b3321ea5be2012c4afc4bdbffb454b5ef5b9985d0' }, stake: null };
// The ADA/MIN pool as it stood before the venue's 25 ADA buy (fill 075110cd...21e2).
const ctx: PoolContext = { assetA: ADA, assetB: MIN, lpAsset: LP, tradingFeeA: 30n, tradingFeeB: 100n, feeSharing: 3333n };
const pool: PoolState = { datumReserveA: 3077452617980n, datumReserveB: 195134540787495n, valueReserveA: 3077486809819n - 4_500_000n, valueReserveB: 195136103738887n, totalLiquidity: 24_000_000_000_000n };
const NOW = 1_792_864_100_000n;

function buy(change: Partial<OrderDatum> = {}, step: Partial<Extract<OrderDatum['step'], { kind: 'SwapExactIn' }>> = {}): OrderInput {
  return {
    value: valueOf([[ADA, 29_000_000n]]),
    datum: {
      refundReceiver: TRADER,
      refundReceiverDatum: { kind: 'none' },
      successReceiver: TRADER,
      successReceiverDatum: { kind: 'none' },
      lpAsset: LP,
      step: { kind: 'SwapExactIn', aToB: true, swapAmount: { kind: 'specific', amount: 25_000_000n }, minimumReceive: 1_564_622_674n, killable: true, ...step },
      maxBatcherFee: 2_000_000n,
      expiry: null,
      ...change,
    },
  };
}

test('fills the real buy: 1,580,426,944 MIN out, 2 ADA deposit back, the fee share kept in the pool', () => {
  const r = applyOrder(ctx, pool, buy(), 2_000_000n, NOW);
  assert.equal(r.output.filled, true);
  assert.equal(quantityOf(r.output.value, MIN), 1_580_426_944n);
  assert.equal(quantityOf(r.output.value, ADA), 2_000_000n); // 29 - 25 swapped - 2 fee
  // The value reserve takes the whole 25 ADA; the datum reserve takes it less the venue's share.
  assert.equal(r.state.valueReserveA - pool.valueReserveA, 25_000_000n);
  assert.equal(r.state.datumReserveA - pool.datumReserveA, 25_000_000n - 24_997n); // 25e6 * 30 * 3333 / 1e8
});

test('refuses a fee above the trader’s maximum, and a zero fee', () => {
  assert.throws(() => applyOrder(ctx, pool, buy(), 2_000_001n, NOW), ContractFailure);
  assert.throws(() => applyOrder(ctx, pool, buy(), 0n, NOW), ContractFailure);
  assert.throws(() => applyOrder(ctx, pool, buy({ maxBatcherFee: 0n }), 1n, NOW), ContractFailure);
});

test('refuses an order for another pool', () => {
  assert.throws(() => applyOrder(ctx, pool, buy({ lpAsset: { ...LP, assetName: '00'.repeat(32) } }), 2_000_000n, NOW), ContractFailure);
});

test('refuses an expired order, and fills one still in time', () => {
  assert.throws(() => applyOrder(ctx, pool, buy({ expiry: { expiredTime: NOW - 1n, maxTip: 1n } }), 2_000_000n, NOW), ContractFailure);
  assert.equal(applyOrder(ctx, pool, buy({ expiry: { expiredTime: NOW, maxTip: 1n } }), 2_000_000n, NOW).output.filled, true);
});

test('a price miss on a killable order is a refund of everything less the fee, the pool untouched', () => {
  const r = applyOrder(ctx, pool, buy({}, { minimumReceive: 1_580_426_945n }), 1_500_000n, NOW);
  assert.equal(r.output.filled, false);
  assert.deepEqual([...r.output.value], [['', 27_500_000n]]);
  assert.deepEqual(r.state, pool);
});

test('a price miss on an order that is not killable fails the whole batch', () => {
  assert.throws(() => applyOrder(ctx, pool, buy({}, { minimumReceive: 1_580_426_945n, killable: false }), 2_000_000n, NOW), ContractFailure);
});

test('refuses a swap of nothing, and an ADA-only order swapping B to A', () => {
  assert.throws(() => applyOrder(ctx, pool, buy({}, { swapAmount: { kind: 'specific', amount: 0n } }), 2_000_000n, NOW), ContractFailure);
  assert.throws(() => applyOrder(ctx, pool, buy({}, { aToB: false, minimumReceive: 1n }), 2_000_000n, NOW), ContractFailure);
});

test('leaves alone an order paying a pointer address (the ledger bounds them, CSL does not)', () => {
  const pointer: Address = { ...TRADER, stake: { kind: 'pointer', slot: 1n << 40n, txIndex: 0n, certIndex: 0n } };
  assert.throws(() => applyOrder(ctx, pool, buy({ successReceiver: pointer }), 2_000_000n, NOW), Unsupported);
  assert.throws(() => applyOrder(ctx, pool, buy({ refundReceiver: pointer }), 2_000_000n, NOW), Unsupported);
});

test('the contract’s time: the midpoint of a window of at most 10 minutes, both ends set', () => {
  assert.equal(currentTimeApproximation(1_000n, 601_000n), 301_000n);
  assert.throws(() => currentTimeApproximation(1_000n, 601_001n), ContractFailure);
  assert.throws(() => currentTimeApproximation(null, 1_000n), ContractFailure);
});

test('the trading fee: base, plus a volatility fee only when the pool allows it, within 5..2000', () => {
  assert.equal(tradingFeeNumerator(30n, 50n, false), 30n);
  assert.equal(tradingFeeNumerator(30n, 50n, true), 80n);
  assert.throws(() => tradingFeeNumerator(30n, 201n, true), ContractFailure);
  assert.throws(() => tradingFeeNumerator(1990n, 20n, true), ContractFailure);
});
