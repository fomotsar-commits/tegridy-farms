// The port against the contract's own tests: every vector in math.ak's `test` blocks
// (cardano/minswap-dex-v2/lib/amm_dex_v2/math.ak), reproduced exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ContractFailure,
  calculateAmountIn,
  calculateAmountOut,
  calculateDepositAmount,
  calculateDepositSwapAmount,
  calculateEarnedFeeIn,
  calculateEarnedFeeInFraction,
  calculateInitialLiquidity,
  calculateMaxInSwap,
  calculateSqrt,
  calculateWithdraw,
  div,
} from '../src/math.ts';

test('div rounds toward negative infinity, as Plutus divideInteger', () => {
  assert.equal(div(7n, 2n), 3n);
  assert.equal(div(-7n, 2n), -4n);
  assert.equal(div(7n, -2n), -4n);
  assert.equal(div(-7n, -2n), 3n);
  assert.equal(div(-6n, 2n), -3n);
  assert.throws(() => div(1n, 0n));
});

test('math.ak test_calculate_sqrt', () => {
  for (const [a, b] of [[0n, 0n], [1n, 1n], [2n, 1n], [3n, 1n], [4n, 2n], [9n, 3n], [16n, 4n], [17n, 4n]] as const) {
    assert.equal(calculateSqrt(a), b, `sqrt(${a})`);
  }
  assert.throws(() => calculateSqrt(-1n), ContractFailure);
});

test('math.ak test_calculate_initial_liquidity', () => {
  assert.equal(calculateInitialLiquidity(1_000_000n, 1_000_000n), 1_000_000n);
  assert.equal(calculateInitialLiquidity(1_000n, 1_000_000n), 31_623n);
});

test('math.ak test_calculate_earned_fee_in', () => {
  assert.equal(calculateEarnedFeeIn(100000000n, 30n, 1666n), 49980n);
  assert.equal(calculateEarnedFeeInFraction(100000000n, 1n, 30n, 1666n), 49980n);
  assert.equal(calculateEarnedFeeIn(100000000n, 30n, null), 0n);
});

test('math.ak test_calculate_amount_out', () => {
  assert.equal(calculateAmountOut(25434557769208n, 413300185707175n, 1000000000n, 30n), 16200168971n);
});

test('math.ak test_calculate_max_in_swap', () => {
  assert.equal(calculateMaxInSwap(1_000_000_000n, 1_000_000_000n, 30n, 10n, 9n), 108102084n);
});

test('math.ak test_calculate_amount_in', () => {
  assert.equal(calculateAmountIn(1_000_000_000n, 1_000_000_000n, 1_000n, 30n), 1004n);
  assert.throws(() => calculateAmountIn(10n, 10n, 10n, 30n), ContractFailure);
});

test('math.ak test_calculate_deposit_swap_amount', () => {
  assert.deepEqual(calculateDepositSwapAmount(5000n, 2000n, 1_000_000n, 1_000_000n, 30n), [29932544594688n, 19979880000n]);
});

test('math.ak test_calculate_deposit_amount', () => {
  assert.deepEqual(calculateDepositAmount(5000n, 2000n, 1_000_000n, 1_000_000n, 1_000_000n, 30n, 100n, 5000n), [2n, 0n, 3496n]);
  assert.deepEqual(calculateDepositAmount(2000n, 5000n, 1_000_000n, 1_000_000n, 1_000_000n, 30n, 100n, 5000n), [0n, 7n, 3491n]);
});

test('math.ak test_calculate_withdraw', () => {
  assert.deepEqual(calculateWithdraw(1_000_000n, 213_231_211n, 123_456n, 12_345_678n), [9999n, 2132298n]);
});

// The venue's real ADA/MIN buy on 2026-10-24, filled by Minswap's batcher in
// 075110cd90ac76195e150de862ccfd48659e2e5f2c4338f0aa5b175fdff121e2: 25 ADA in, exactly
// 1,580,426,944 MIN units out, from the pool's datum reserves at the time.
test('a real mainnet fill: 25 ADA for 1,580.426944 MIN', () => {
  assert.equal(calculateAmountOut(3077452617980n, 195134540787495n, 25_000_000n, 30n), 1_580_426_944n);
});
