/**
 * A BigInt port of the cp-swap program's swap and LP maths.
 *
 * WHY THIS EXISTS AND WHY IT IS EXACT: the venue quotes a price before the user
 * signs. If this file and the program disagree by one unit, every trade that
 * lands on the boundary either fails on slippage or fills worse than quoted —
 * which is the lesson the bonding-curve client already carries in its header
 * ("four sources of truth for quote maths is a UI that quotes differently than
 * the program executes, which takes money from users on every trade").
 *
 * SOURCE OF TRUTH, line for line:
 *   solana/tegridy-amm/programs/cp-swap/src/curve/fees.rs
 *   solana/tegridy-amm/programs/cp-swap/src/curve/constant_product.rs
 *   solana/tegridy-amm/programs/cp-swap/src/curve/calculator.rs  (swap_base_input)
 *   solana/tegridy-amm/programs/cp-swap/src/states/pool.rs       (vault_amount_without_fee)
 *
 * That program is a VERBATIM fork of raydium-cp-swap @ 78f254e1; CI's
 * `diff-guard` hashes the delta and it contains no curve or fee code, so these
 * are Raydium's numbers, not ours.
 *
 * ROUNDING IS THE WHOLE JOB. Rust uses `ceil_div` for the fees a user PAYS and
 * `floor_div` for the splits taken out of them; u128 truncating division is
 * exactly BigInt division for non-negative values, so every `/` below is the
 * program's `checked_div`. Nothing here uses `number` — a u64 vault balance
 * exceeds Number.MAX_SAFE_INTEGER at ~9.007e15, which a 9-decimal token passes
 * at 9 million units.
 *
 * This module imports NOTHING, so it can be differentially tested against the
 * Rust vectors with no Solana runtime in the room.
 */

/** `FEE_RATE_DENOMINATOR_VALUE` — fees.rs:3. Rates are hundredths of a bip. */
export const FEE_RATE_DENOMINATOR = 1_000_000n;

/**
 * The program's arithmetic ceiling. BigInt has none, so without this the port
 * would happily return a quote for an input the program aborts on: Rust's
 * `checked_mul(...).unwrap()` in `swap_base_input_without_fees` PANICS on
 * overflow, and a panic is a failed transaction. Refusing is faithful; a
 * number that cannot be executed is not.
 */
export const U128_MAX = (1n << 128n) - 1n;

function mulChecked(a: bigint, b: bigint): bigint | null {
  const p = a * b;
  return p > U128_MAX ? null : p;
}

/** fees.rs `ceil_div`. Returns null where Rust returns None. */
export function ceilDiv(amount: bigint, numerator: bigint, denominator: bigint): bigint | null {
  if (denominator === 0n) return null;
  return (amount * numerator + denominator - 1n) / denominator;
}

/** fees.rs `floor_div`. */
export function floorDiv(amount: bigint, numerator: bigint, denominator: bigint): bigint | null {
  if (denominator === 0n) return null;
  return (amount * numerator) / denominator;
}

/** The fee the trader pays to the pool. `Fees::trading_fee` — CEILING. */
export function tradingFee(amount: bigint, tradeFeeRate: bigint): bigint | null {
  return ceilDiv(amount, tradeFeeRate, FEE_RATE_DENOMINATOR);
}

/** The venue's cut of the trade fee. `Fees::protocol_fee` — FLOOR. */
export function protocolFee(tradeFee: bigint, protocolFeeRate: bigint): bigint | null {
  return floorDiv(tradeFee, protocolFeeRate, FEE_RATE_DENOMINATOR);
}

/** The venue's second cut of the trade fee. `Fees::fund_fee` — FLOOR. */
export function fundFee(tradeFee: bigint, fundFeeRate: bigint): bigint | null {
  return floorDiv(tradeFee, fundFeeRate, FEE_RATE_DENOMINATOR);
}

/** `Fees::creator_fee` — CEILING. */
export function creatorFee(amount: bigint, creatorFeeRate: bigint): bigint | null {
  return ceilDiv(amount, creatorFeeRate, FEE_RATE_DENOMINATOR);
}

/**
 * `Fees::split_creator_fee` — FLOOR, and note the denominator is
 * `trade_fee_rate + creator_fee_rate`, NOT FEE_RATE_DENOMINATOR.
 */
export function splitCreatorFee(
  totalFee: bigint,
  tradeFeeRate: bigint,
  creatorFeeRate: bigint,
): bigint | null {
  return floorDiv(totalFee, creatorFeeRate, tradeFeeRate + creatorFeeRate);
}

/** constant_product.rs `swap_base_input_without_fees`. */
export function swapBaseInputWithoutFees(
  inputAmount: bigint,
  inputVaultAmount: bigint,
  outputVaultAmount: bigint,
): bigint | null {
  const numerator = mulChecked(inputAmount, outputVaultAmount);
  if (numerator === null) return null;
  const denominator = inputVaultAmount + inputAmount;
  if (denominator === 0n) return null;
  return numerator / denominator;
}

/** constant_product.rs `swap_base_output_without_fees` — CEILING division. */
export function swapBaseOutputWithoutFees(
  outputAmount: bigint,
  inputVaultAmount: bigint,
  outputVaultAmount: bigint,
): bigint | null {
  const denominator = outputVaultAmount - outputAmount;
  if (denominator <= 0n) return null; // Rust: checked_sub then checked_ceil_div
  const numerator = mulChecked(inputVaultAmount, outputAmount);
  if (numerator === null) return null;
  return (numerator + denominator - 1n) / denominator;
}

export interface SwapResult {
  /** What the trader receives, before any Token-2022 transfer fee on the way out. */
  outputAmount: bigint;
  /** Amount of input tokens going to pool holders. */
  tradeFee: bigint;
  /** The venue's protocol cut, taken OUT of tradeFee (not added to it). */
  protocolFee: bigint;
  /** The venue's fund cut, also taken out of tradeFee. */
  fundFee: bigint;
  /** The pool creator's cut. Charged on the input or the output — see `isCreatorFeeOnInput`. */
  creatorFee: bigint;
  newInputVaultAmount: bigint;
  newOutputVaultAmount: bigint;
}

/**
 * `CurveCalculator::swap_base_input` — calculator.rs, transcribed branch for
 * branch.
 *
 * The two creator-fee modes are NOT symmetric and the difference is easy to get
 * wrong: when the fee is charged on the INPUT the creator's cut comes out of a
 * combined `trade_fee_rate + creator_fee_rate` fee and is split back out, so the
 * trade fee shrinks; when it is charged on the OUTPUT the trade fee is computed
 * alone and the creator's cut is taken off what the curve returned.
 *
 * Returns null wherever Rust returns None (an underflow the program would
 * refuse), so a caller can never render a fabricated quote.
 */
export function swapBaseInput(args: {
  inputAmount: bigint;
  inputVaultAmount: bigint;
  outputVaultAmount: bigint;
  tradeFeeRate: bigint;
  creatorFeeRate: bigint;
  protocolFeeRate: bigint;
  fundFeeRate: bigint;
  isCreatorFeeOnInput: boolean;
}): SwapResult | null {
  const {
    inputAmount, inputVaultAmount, outputVaultAmount,
    tradeFeeRate, creatorFeeRate, protocolFeeRate, fundFeeRate, isCreatorFeeOnInput,
  } = args;
  if (inputAmount <= 0n || inputVaultAmount <= 0n || outputVaultAmount <= 0n) return null;

  let creator = 0n;
  let trade: bigint;
  let inputAmountLessFees: bigint;

  if (isCreatorFeeOnInput) {
    const totalFee = tradingFee(inputAmount, tradeFeeRate + creatorFeeRate);
    if (totalFee === null) return null;
    const split = splitCreatorFee(totalFee, tradeFeeRate, creatorFeeRate);
    if (split === null) return null;
    creator = split;
    trade = totalFee - creator;
    inputAmountLessFees = inputAmount - totalFee;
    if (inputAmountLessFees < 0n) return null;
  } else {
    const t = tradingFee(inputAmount, tradeFeeRate);
    if (t === null) return null;
    trade = t;
    inputAmountLessFees = inputAmount - trade;
    if (inputAmountLessFees < 0n) return null;
  }

  const protocol = protocolFee(trade, protocolFeeRate);
  const fund = fundFee(trade, fundFeeRate);
  if (protocol === null || fund === null) return null;

  const outputAmountSwapped = swapBaseInputWithoutFees(
    inputAmountLessFees, inputVaultAmount, outputVaultAmount,
  );
  if (outputAmountSwapped === null) return null;

  let outputAmount: bigint;
  if (isCreatorFeeOnInput) {
    outputAmount = outputAmountSwapped;
  } else {
    const c = creatorFee(outputAmountSwapped, creatorFeeRate);
    if (c === null) return null;
    creator = c;
    outputAmount = outputAmountSwapped - creator;
    if (outputAmount < 0n) return null;
  }

  const newOutputVaultAmount = outputVaultAmount - outputAmountSwapped;
  if (newOutputVaultAmount < 0n) return null;

  return {
    outputAmount,
    tradeFee: trade,
    protocolFee: protocol,
    fundFee: fund,
    creatorFee: creator,
    newInputVaultAmount: inputVaultAmount + inputAmountLessFees,
    newOutputVaultAmount,
  };
}

export type RoundDirection = 'floor' | 'ceiling';

/**
 * constant_product.rs `lp_tokens_to_trading_tokens` — what a burn of
 * `lpTokenAmount` is worth, and (with `ceiling`) what a deposit must pay in.
 *
 * The ceiling branch deliberately does NOT round up a side that came out at
 * zero: "if someone asks for 1 pool token, which is worth 0.01 token A, we
 * avoid the ceiling of taking 1 token A".
 */
export function lpTokensToTradingTokens(
  lpTokenAmount: bigint,
  lpTokenSupply: bigint,
  token0VaultAmount: bigint,
  token1VaultAmount: bigint,
  roundDirection: RoundDirection,
): { token0Amount: bigint; token1Amount: bigint } | null {
  if (lpTokenSupply <= 0n) return null;
  // Rust computes `lp * vault` with checked_mul and returns None on overflow —
  // `fail_trading_token_conversion` pins exactly that against u128::MAX.
  const p0 = mulChecked(lpTokenAmount, token0VaultAmount);
  const p1 = mulChecked(lpTokenAmount, token1VaultAmount);
  if (p0 === null || p1 === null) return null;
  let token0Amount = p0 / lpTokenSupply;
  let token1Amount = p1 / lpTokenSupply;
  if (roundDirection === 'ceiling') {
    if (p0 % lpTokenSupply > 0n && token0Amount > 0n) token0Amount += 1n;
    if (p1 % lpTokenSupply > 0n && token1Amount > 0n) token1Amount += 1n;
  }
  return { token0Amount, token1Amount };
}

/**
 * pool.rs `vault_amount_without_fee` — the tradable reserves.
 *
 * A pool's token account holds accrued protocol, fund and creator fees that
 * are NOT part of the curve. Quoting against the raw vault balance overstates
 * liquidity and returns a price the program will not honour, so every quote
 * has to subtract them first.
 */
export function vaultAmountWithoutFee(
  vaultAmount: bigint,
  protocolFees: bigint,
  fundFees: bigint,
  creatorFees: bigint,
): bigint | null {
  const fees = protocolFees + fundFees + creatorFees;
  const out = vaultAmount - fees;
  return out < 0n ? null : out;
}

/** Human percentage for a rate quoted in hundredths of a bip. 2500 → 0.25. */
export function ratePercent(rate: bigint): number {
  return Number(rate) / Number(FEE_RATE_DENOMINATOR) * 100;
}
