import { describe, it, expect } from 'vitest';
import {
  FEE_RATE_DENOMINATOR,
  U128_MAX,
  ceilDiv,
  floorDiv,
  tradingFee,
  protocolFee,
  fundFee,
  creatorFee,
  splitCreatorFee,
  swapBaseInputWithoutFees,
  swapBaseOutputWithoutFees,
  swapBaseInput,
  lpTokensToTradingTokens,
  vaultAmountWithoutFee,
  ratePercent,
} from './math';

/**
 * DIFFERENTIAL TEST against the program's own Rust test vectors.
 *
 * Every vector in `constant_product_swap_rounding`, `trading_token_conversion`
 * and `fail_trading_token_conversion` below is copied verbatim out of
 * `solana/tegridy-amm/programs/cp-swap/src/curve/constant_product.rs`. They were
 * chosen by Raydium precisely because they sit on truncation boundaries — the
 * places a re-implementation drifts by one unit and starts quoting a price the
 * program will not honour.
 *
 * If someone re-syncs the fork to a newer upstream and the curve maths change,
 * these fail here rather than on a user's trade.
 */

describe('fee primitives (fees.rs)', () => {
  it('ceil_div rounds the fees a trader PAYS up', () => {
    // 1 unit of fee on anything non-zero: the program never rounds a fee to zero
    // for a non-zero rate.
    expect(ceilDiv(1n, 1n, FEE_RATE_DENOMINATOR)).toBe(1n);
    expect(ceilDiv(0n, 2500n, FEE_RATE_DENOMINATOR)).toBe(0n);
    expect(ceilDiv(1_000_000n, 2500n, FEE_RATE_DENOMINATOR)).toBe(2500n);
    expect(ceilDiv(1_000_001n, 2500n, FEE_RATE_DENOMINATOR)).toBe(2501n);
    expect(ceilDiv(5n, 1n, 0n)).toBe(null);
  });

  it('floor_div rounds the SPLITS out of that fee down', () => {
    expect(floorDiv(1n, 1n, FEE_RATE_DENOMINATOR)).toBe(0n);
    expect(floorDiv(2500n, 120_000n, FEE_RATE_DENOMINATOR)).toBe(300n);
    expect(floorDiv(5n, 1n, 0n)).toBe(null);
  });

  it('the venue cut comes OUT of the trade fee, it is not added to it', () => {
    // 0.25% trade fee on 1 SOL, 12% protocol / 4% fund of that fee.
    const fee = tradingFee(1_000_000_000n, 2500n)!;
    expect(fee).toBe(2_500_000n);
    expect(protocolFee(fee, 120_000n)).toBe(300_000n);
    expect(fundFee(fee, 40_000n)).toBe(100_000n);
    // LPs keep the remainder — 2.5m - 300k - 100k.
    expect(fee - protocolFee(fee, 120_000n)! - fundFee(fee, 40_000n)!).toBe(2_100_000n);
  });

  it('split_creator_fee divides by trade+creator, NOT by the fee denominator', () => {
    // The easiest transcription error in the file: a plausible-looking
    // FEE_RATE_DENOMINATOR here would understate the creator's cut ~400x.
    expect(splitCreatorFee(1000n, 2500n, 2500n)).toBe(500n);
    expect(splitCreatorFee(1000n, 3000n, 1000n)).toBe(250n);
  });

  it('creator_fee is a CEILING like the trade fee', () => {
    expect(creatorFee(1n, 1n)).toBe(1n);
    expect(creatorFee(1_000_001n, 2500n)).toBe(2501n);
  });
});

describe('constant_product.rs :: constant_product_swap_rounding — verbatim vectors', () => {
  // (source_amount, swap_source_amount, swap_destination_amount, expected_dest)
  const vectors: [bigint, bigint, bigint, bigint][] = [
    // spot: 10 * 70b / ~4m = 174,999.99
    [10n, 4_000_000n, 70_000_000_000n, 174_999n],
    // spot: 20 * 1 / 3.000 = 6.6667 (source can be 18 to get 6 dest.)
    [20n, 30_000n - 20n, 10_000n, 6n],
    // spot: 19 * 1 / 2.999 = 6.3334
    [19n, 30_000n - 20n, 10_000n, 6n],
    // spot: 18 * 1 / 2.999 = 6.0001
    [18n, 30_000n - 20n, 10_000n, 6n],
    // spot: 10 * 3 / 2.0010 = 14.99
    [10n, 20_000n, 30_000n, 14n],
    // spot: 10 * 3 / 2.0001 = 14.999
    [10n, 20_000n - 9n, 30_000n, 14n],
    // spot: 10 * 3 / 2.0000 = 15
    [10n, 20_000n - 10n, 30_000n, 15n],
    // spot: 100 * 3 / 6.001 = 49.99
    [100n, 60_000n, 30_000n, 49n],
    [99n, 60_000n, 30_000n, 49n],
    [98n, 60_000n, 30_000n, 48n],
  ];

  for (const [src, srcVault, dstVault, expected] of vectors) {
    it(`${src} in against ${srcVault}/${dstVault} → ${expected}`, () => {
      expect(swapBaseInputWithoutFees(src, srcVault, dstVault)).toBe(expected);
    });
  }

  it('never decreases the invariant — the property the Rust proptest asserts', () => {
    for (const [src, srcVault, dstVault] of vectors) {
      const out = swapBaseInputWithoutFees(src, srcVault, dstVault)!;
      expect((srcVault + src) * (dstVault - out)).toBeGreaterThanOrEqual(srcVault * dstVault);
    }
  });
});

describe('constant_product.rs :: trading_token_conversion — verbatim vectors', () => {
  // check_pool_token_rate(token_a, token_b, deposit, supply, expected_a, expected_b)
  const vectors: [bigint, bigint, bigint, bigint, bigint, bigint][] = [
    [2n, 49n, 5n, 10n, 1n, 25n],
    [100n, 202n, 5n, 101n, 5n, 10n],
    [5n, 501n, 2n, 10n, 1n, 101n],
  ];
  for (const [a, b, deposit, supply, expA, expB] of vectors) {
    it(`${deposit}/${supply} of ${a}+${b} → ${expA}+${expB} (ceiling)`, () => {
      expect(lpTokensToTradingTokens(deposit, supply, a, b, 'ceiling')).toEqual({
        token0Amount: expA, token1Amount: expB,
      });
    });
  }

  it('refuses where Rust returns None — fail_trading_token_conversion', () => {
    // BigInt has no u128 ceiling, so without the explicit guard this would
    // return a quote for an input the program aborts on.
    expect(lpTokensToTradingTokens(5n, 10n, U128_MAX, 0n, 'floor')).toBe(null);
    expect(lpTokensToTradingTokens(5n, 10n, 0n, U128_MAX, 'floor')).toBe(null);
    expect(lpTokensToTradingTokens(5n, 0n, 10n, 10n, 'floor')).toBe(null);
  });

  it('does not round a zero side up to one', () => {
    // "if someone asks for 1 pool token, which is worth 0.01 token A, we avoid
    // the ceiling of taking 1 token A" — constant_product.rs
    expect(lpTokensToTradingTokens(1n, 1000n, 10n, 1_000_000n, 'ceiling')).toEqual({
      token0Amount: 0n, token1Amount: 1000n,
    });
  });
});

describe('swap_base_output_without_fees', () => {
  it('ceilings the input, so the pool is never short-changed', () => {
    // The inverse of the base-input vector above, and the Rust comment on that
    // vector states the answer outright: "source can be 18 to get 6 dest".
    expect(swapBaseOutputWithoutFees(6n, 29_980n, 10_000n)).toBe(18n);
    // Exact division — 19_990 * 15 / 29_985 is 10 with no remainder, so the
    // ceiling must NOT push it to 11.
    expect(swapBaseOutputWithoutFees(15n, 19_990n, 30_000n)).toBe(10n);
    // …and one unit of remainder must.
    expect(swapBaseOutputWithoutFees(14n, 19_990n, 30_000n)).toBe(10n);
  });
  it('refuses to drain the whole output vault', () => {
    expect(swapBaseOutputWithoutFees(10_000n, 29_980n, 10_000n)).toBe(null);
    expect(swapBaseOutputWithoutFees(10_001n, 29_980n, 10_000n)).toBe(null);
  });
});

describe('CurveCalculator::swap_base_input', () => {
  const pool = {
    inputVaultAmount: 1_000_000_000_000n, // 1,000 of a 9dp token
    outputVaultAmount: 2_000_000_000_000n,
    tradeFeeRate: 2500n,      // 0.25%
    protocolFeeRate: 120_000n, // 12% of the trade fee
    fundFeeRate: 40_000n,      // 4% of the trade fee
  };

  it('with no creator fee, the trade fee comes off the input', () => {
    const r = swapBaseInput({
      ...pool, inputAmount: 1_000_000_000n, creatorFeeRate: 0n, isCreatorFeeOnInput: false,
    })!;
    expect(r.tradeFee).toBe(2_500_000n);
    expect(r.protocolFee).toBe(300_000n);
    expect(r.fundFee).toBe(100_000n);
    expect(r.creatorFee).toBe(0n);
    // 997.5m in against the curve.
    const expected = swapBaseInputWithoutFees(997_500_000n, pool.inputVaultAmount, pool.outputVaultAmount);
    expect(r.outputAmount).toBe(expected);
    expect(r.newInputVaultAmount).toBe(pool.inputVaultAmount + 997_500_000n);
  });

  it('creator-fee-ON-INPUT shrinks the trade fee; ON-OUTPUT does not', () => {
    const onInput = swapBaseInput({
      ...pool, inputAmount: 1_000_000_000n, creatorFeeRate: 2500n, isCreatorFeeOnInput: true,
    })!;
    const onOutput = swapBaseInput({
      ...pool, inputAmount: 1_000_000_000n, creatorFeeRate: 2500n, isCreatorFeeOnInput: false,
    })!;

    // ON INPUT: one combined 0.5% fee, split half-half back out.
    expect(onInput.tradeFee + onInput.creatorFee).toBe(5_000_000n);
    expect(onInput.creatorFee).toBe(2_500_000n);
    expect(onInput.tradeFee).toBe(2_500_000n);

    // ON OUTPUT: the trade fee is the full 0.25% of input, and the creator's
    // cut is taken off the OUTPUT token instead — so the two modes do not
    // produce the same trade fee, and the protocol cut differs with it.
    expect(onOutput.tradeFee).toBe(2_500_000n);
    expect(onOutput.creatorFee).toBeGreaterThan(0n);
    expect(onInput.outputAmount).not.toBe(onOutput.outputAmount);
  });

  it('a zero creator rate makes the two modes agree exactly', () => {
    const a = swapBaseInput({ ...pool, inputAmount: 7_777n, creatorFeeRate: 0n, isCreatorFeeOnInput: true })!;
    const b = swapBaseInput({ ...pool, inputAmount: 7_777n, creatorFeeRate: 0n, isCreatorFeeOnInput: false })!;
    expect(a).toEqual(b);
  });

  it('refuses rather than quoting an empty or impossible pool', () => {
    const base = { ...pool, creatorFeeRate: 0n, isCreatorFeeOnInput: false };
    expect(swapBaseInput({ ...base, inputAmount: 0n })).toBe(null);
    expect(swapBaseInput({ ...base, inputAmount: 100n, inputVaultAmount: 0n })).toBe(null);
    expect(swapBaseInput({ ...base, inputAmount: 100n, outputVaultAmount: 0n })).toBe(null);
    // A fee rate above 100% would take more than the whole input.
    expect(swapBaseInput({ ...base, inputAmount: 100n, tradeFeeRate: 2_000_000n })).toBe(null);
  });
});

describe('vaultAmountWithoutFee (pool.rs)', () => {
  it('subtracts accrued fees, which are NOT tradable reserves', () => {
    // Quoting against the raw vault balance overstates liquidity and returns a
    // price the program will not honour.
    expect(vaultAmountWithoutFee(1_000n, 10n, 5n, 2n)).toBe(983n);
    expect(vaultAmountWithoutFee(1_000n, 0n, 0n, 0n)).toBe(1_000n);
  });
  it('is an outage, not a zero, when the fees exceed the vault', () => {
    expect(vaultAmountWithoutFee(10n, 20n, 0n, 0n)).toBe(null);
  });
});

describe('ratePercent', () => {
  it('reads a hundredths-of-a-bip rate as a human percentage', () => {
    expect(ratePercent(2500n)).toBe(0.25);
    expect(ratePercent(120_000n)).toBe(12);
    expect(ratePercent(0n)).toBe(0);
  });
});
