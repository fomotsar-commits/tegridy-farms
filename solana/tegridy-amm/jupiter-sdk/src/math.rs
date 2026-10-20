//! The program's ExactIn swap, as arithmetic.
//!
//! Transcribed from raydium-io/raydium-cp-swap @ 78f254e1 (Apache-2.0, Copyright Raydium),
//! the files our program carries byte for byte (solana-ci.yml `diff-guard`):
//!   programs/cp-swap/src/curve/fees.rs              ceil_div, floor_div, the fee splits
//!   programs/cp-swap/src/curve/constant_product.rs  swap_base_input_without_fees
//!   programs/cp-swap/src/curve/calculator.rs        CurveCalculator::swap_base_input
//!   programs/cp-swap/src/states/pool.rs             vault_amount_without_fee,
//!                                                   is_creator_fee_on_input,
//!                                                   adjust_creator_fee_rate
//!   programs/cp-swap/src/instructions/swap_base_input.rs  the checks around them
//! The one change: where upstream unwraps (a panic, which on chain fails the transaction),
//! this returns a refusal, so a quote never panics in Jupiter's router.

use crate::state::{AmmConfig, PoolState};

/// fees.rs `FEE_RATE_DENOMINATOR_VALUE`: rates are hundredths of a bip.
pub const FEE_RATE_DENOMINATOR_VALUE: u64 = 1_000_000;

/// Why the program would refuse a swap, so no quote is given for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// `NotApproved`: the pool's swap switch is off, or it has not opened yet.
    NotApproved,
    /// `require_gt!(actual_amount_in, 0)`.
    ZeroAmountIn,
    /// `InvalidFeeModel`: a `creator_fee_on` value the program does not know.
    InvalidFeeModel,
    /// `InsufficientVault`: fees booked to the venue and the creator exceed a vault.
    InsufficientVault,
    /// `ZeroTradingTokens`, or arithmetic the program aborts on.
    ZeroTradingTokens,
    /// `require_gt!(amount_received, 0)`: the trade pays out nothing.
    ZeroAmountOut,
}

/// What one ExactIn swap moves, in the program's own terms.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SwapResult {
    /// What the trader receives.
    pub output_amount: u64,
    /// The trade fee, in the input token. The venue's cut comes out of it, not on top.
    pub trade_fee: u64,
    /// The venue's cut of `trade_fee` (protocol_fee_rate), booked to the venue in the pool.
    pub protocol_fee: u64,
    /// The venue's second cut of `trade_fee` (fund_fee_rate), booked the same way.
    pub fund_fee: u64,
    /// The pool creator's cut: in the input token when `creator_fee_on_input`, else the output.
    pub creator_fee: u64,
    pub creator_fee_on_input: bool,
}

/// fees.rs `ceil_div`: the fees a trader PAYS round up.
fn ceil_div(amount: u128, numerator: u128, denominator: u128) -> Option<u128> {
    if denominator == 0 {
        return None;
    }
    amount
        .checked_mul(numerator)?
        .checked_add(denominator)?
        .checked_sub(1)?
        .checked_div(denominator)
}

/// fees.rs `floor_div`: the splits taken out of a fee round down.
fn floor_div(amount: u128, numerator: u128, denominator: u128) -> Option<u128> {
    if denominator == 0 {
        return None;
    }
    amount.checked_mul(numerator)?.checked_div(denominator)
}

/// calculator.rs `CurveCalculator::swap_base_input`, with constant_product.rs
/// `swap_base_input_without_fees` inline.
#[allow(clippy::too_many_arguments)]
fn curve_swap_base_input(
    input_amount: u128,
    input_vault_amount: u128,
    output_vault_amount: u128,
    trade_fee_rate: u64,
    creator_fee_rate: u64,
    protocol_fee_rate: u64,
    fund_fee_rate: u64,
    is_creator_fee_on_input: bool,
) -> Option<(u128, u128, u128, u128, u128)> {
    let denominator = u128::from(FEE_RATE_DENOMINATOR_VALUE);
    let mut creator_fee = 0;
    let trade_fee: u128;

    let input_amount_less_fees = if is_creator_fee_on_input {
        let total_fee = ceil_div(
            input_amount,
            u128::from(trade_fee_rate.checked_add(creator_fee_rate)?),
            denominator,
        )?;
        // Fees::split_creator_fee: the denominator is the two rates together.
        creator_fee = floor_div(
            total_fee,
            u128::from(creator_fee_rate),
            u128::from(trade_fee_rate.checked_add(creator_fee_rate)?),
        )?;
        trade_fee = total_fee.checked_sub(creator_fee)?;
        input_amount.checked_sub(total_fee)?
    } else {
        trade_fee = ceil_div(input_amount, u128::from(trade_fee_rate), denominator)?;
        input_amount.checked_sub(trade_fee)?
    };
    let protocol_fee = floor_div(trade_fee, u128::from(protocol_fee_rate), denominator)?;
    let fund_fee = floor_div(trade_fee, u128::from(fund_fee_rate), denominator)?;

    // (x + delta_x) * (y - delta_y) = x * y  =>  delta_y = (delta_x * y) / (x + delta_x)
    let output_amount_swapped = input_amount_less_fees
        .checked_mul(output_vault_amount)?
        .checked_div(input_vault_amount.checked_add(input_amount_less_fees)?)?;

    let output_amount = if is_creator_fee_on_input {
        output_amount_swapped
    } else {
        creator_fee = ceil_div(
            output_amount_swapped,
            u128::from(creator_fee_rate),
            denominator,
        )?;
        output_amount_swapped.checked_sub(creator_fee)?
    };
    // `new_output_vault_amount` must not underflow, or the program returns None.
    output_vault_amount.checked_sub(output_amount_swapped)?;

    Some((
        output_amount,
        trade_fee,
        protocol_fee,
        fund_fee,
        creator_fee,
    ))
}

/// The program's `swap_base_input` from the pool's switches to the amount the trader
/// receives, for a pool with no Token-2022 transfer fee on either mint.
///
/// `now` is the cluster's unix timestamp; `vault_0` and `vault_1` are the raw balances of
/// the pool's two token accounts.
pub fn swap_exact_in(
    pool: &PoolState,
    config: &AmmConfig,
    vault_0: u64,
    vault_1: u64,
    input_is_token_0: bool,
    amount_in: u64,
    now: i64,
) -> Result<SwapResult, Refusal> {
    // `block_timestamp < pool_state.open_time`, with the timestamp cast `as u64`.
    if !pool.swap_enabled() || (now as u64) < pool.open_time {
        return Err(Refusal::NotApproved);
    }
    if amount_in == 0 {
        return Err(Refusal::ZeroAmountIn);
    }

    // pool.rs `vault_amount_without_fee`: the curve trades against what is left after the
    // fees booked to the venue and the creator, which sit in the same token accounts.
    let booked_0 = pool
        .protocol_fees_token_0
        .checked_add(pool.fund_fees_token_0)
        .and_then(|f| f.checked_add(pool.creator_fees_token_0))
        .ok_or(Refusal::ZeroTradingTokens)?;
    let booked_1 = pool
        .protocol_fees_token_1
        .checked_add(pool.fund_fees_token_1)
        .and_then(|f| f.checked_add(pool.creator_fees_token_1))
        .ok_or(Refusal::ZeroTradingTokens)?;
    let reserve_0 = vault_0
        .checked_sub(booked_0)
        .ok_or(Refusal::InsufficientVault)?;
    let reserve_1 = vault_1
        .checked_sub(booked_1)
        .ok_or(Refusal::InsufficientVault)?;
    // `token_price_x32` divides by both reserves before the swap, a panic on an empty side.
    if reserve_0 == 0 || reserve_1 == 0 {
        return Err(Refusal::ZeroTradingTokens);
    }

    // pool.rs `is_creator_fee_on_input`: 0 BothToken, 1 OnlyToken0, 2 OnlyToken1.
    let creator_fee_on_input = match pool.creator_fee_on {
        0 => true,
        1 => input_is_token_0,
        2 => !input_is_token_0,
        _ => return Err(Refusal::InvalidFeeModel),
    };
    // pool.rs `adjust_creator_fee_rate`.
    let creator_fee_rate = if pool.enable_creator_fee {
        config.creator_fee_rate
    } else {
        0
    };

    let (reserve_in, reserve_out) = if input_is_token_0 {
        (reserve_0, reserve_1)
    } else {
        (reserve_1, reserve_0)
    };
    let (output_amount, trade_fee, protocol_fee, fund_fee, creator_fee) = curve_swap_base_input(
        u128::from(amount_in),
        u128::from(reserve_in),
        u128::from(reserve_out),
        config.trade_fee_rate,
        creator_fee_rate,
        config.protocol_fee_rate,
        config.fund_fee_rate,
        creator_fee_on_input,
    )
    .ok_or(Refusal::ZeroTradingTokens)?;

    let as_u64 = |v: u128| u64::try_from(v).map_err(|_| Refusal::ZeroTradingTokens);
    let output_amount = as_u64(output_amount)?;
    if output_amount == 0 {
        return Err(Refusal::ZeroAmountOut);
    }
    Ok(SwapResult {
        output_amount,
        trade_fee: as_u64(trade_fee)?,
        protocol_fee: as_u64(protocol_fee)?,
        fund_fee: as_u64(fund_fee)?,
        creator_fee: as_u64(creator_fee)?,
        creator_fee_on_input,
    })
}
