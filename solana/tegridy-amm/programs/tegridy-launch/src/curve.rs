//! Bonding-curve math — pure, `no_std`-friendly, and deliberately free of any
//! Solana or Anchor dependency so it can be unit-tested on the host with a plain
//! `cargo test` rather than a validator.
//!
//! # Model
//!
//! Constant product over *virtual* reserves, the pump.fun shape:
//!
//! ```text
//!     k = sol_reserves * token_reserves
//! ```
//!
//! "Virtual" means the curve is seeded with reserves that do not correspond to
//! deposited capital. That is what gives a launch a sane opening price without
//! anyone having to provide liquidity first. Real deposits accumulate alongside
//! and are what actually back redemptions.
//!
//! # Rounding
//!
//! Every rounding decision favours the curve, never the trader:
//!   - tokens out on a buy  → round DOWN
//!   - lamports out on a sell → round DOWN
//!   - fees → round UP
//!
//! A trader can therefore never extract a wei of value by splitting an order into
//! many small ones; each split loses at least as much to truncation as it saves.
//! This is the standard defence against the "grind the rounding" attack and it is
//! the reason the tests below include a round-trip and a splitting property.

/// Basis-points denominator.
pub const BPS_DENOMINATOR: u64 = 10_000;

/// Hard ceiling on the trade fee, enforced at config time as well as here.
/// 10% is far above anything sane (pump.fun sits at 100 bps); this is a
/// backstop against a fat-fingered or hostile config, not a target.
pub const MAX_FEE_BPS: u64 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurveError {
    /// Arithmetic overflowed. Never expected — u128 intermediates make this
    /// unreachable for any realistic reserve size — but we surface it rather
    /// than wrap.
    Overflow,
    /// The curve cannot fill this trade (would drain a reserve to zero).
    InsufficientLiquidity,
    /// A zero-sized trade. Rejected so it cannot be used to spam state writes.
    ZeroAmount,
    /// Fee configured above `MAX_FEE_BPS`.
    FeeTooHigh,
}

/// The result of quoting a buy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuyQuote {
    /// Fee skimmed off the incoming lamports, before the curve sees them.
    pub fee_lamports: u64,
    /// Lamports that actually move along the curve (`lamports_in - fee`).
    pub lamports_to_curve: u64,
    /// Tokens the trader receives.
    pub tokens_out: u64,
}

/// The result of quoting a sell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SellQuote {
    /// Gross lamports the curve gives up, before fee.
    pub gross_lamports: u64,
    /// Fee skimmed from the proceeds.
    pub fee_lamports: u64,
    /// Lamports the trader actually receives (`gross - fee`).
    pub lamports_out: u64,
}

/// Fee, rounded UP so the protocol never loses a lamport to truncation.
///
/// Rounding up is the correct direction here: rounding down would let a trader
/// split one order into many sub-fee-sized orders and pay nothing at all.
#[inline]
fn fee_up(amount: u64, fee_bps: u64) -> Result<u64, CurveError> {
    if fee_bps > MAX_FEE_BPS {
        return Err(CurveError::FeeTooHigh);
    }
    if fee_bps == 0 {
        return Ok(0);
    }
    let num = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(CurveError::Overflow)?;
    let d = BPS_DENOMINATOR as u128;
    // ceil(num / d) without a second division.
    let fee = num.div_ceil(d);
    u64::try_from(fee).map_err(|_| CurveError::Overflow)
}

/// Quote a buy: lamports in, tokens out.
///
/// `sol_reserves` / `token_reserves` are the *effective* (virtual + real)
/// reserves the curve is currently priced on.
pub fn quote_buy(
    sol_reserves: u64,
    token_reserves: u64,
    lamports_in: u64,
    fee_bps: u64,
) -> Result<BuyQuote, CurveError> {
    if lamports_in == 0 {
        return Err(CurveError::ZeroAmount);
    }
    if sol_reserves == 0 || token_reserves == 0 {
        return Err(CurveError::InsufficientLiquidity);
    }

    let fee_lamports = fee_up(lamports_in, fee_bps)?;
    // A trade so small the fee eats all of it would mint zero tokens while still
    // charging — reject rather than silently take the fee for nothing.
    let lamports_to_curve = lamports_in
        .checked_sub(fee_lamports)
        .ok_or(CurveError::Overflow)?;
    if lamports_to_curve == 0 {
        return Err(CurveError::ZeroAmount);
    }

    let x = sol_reserves as u128;
    let y = token_reserves as u128;
    let dx = lamports_to_curve as u128;

    // k = x*y ; y' = k / (x+dx) ; out = y - y'
    // Computed as out = (y * dx) / (x + dx), which is algebraically identical and
    // avoids forming k explicitly (k can be huge; this keeps intermediates small).
    let new_x = x.checked_add(dx).ok_or(CurveError::Overflow)?;
    let numerator = y.checked_mul(dx).ok_or(CurveError::Overflow)?;
    // Truncating division = rounds DOWN = favours the curve.
    let tokens_out_u128 = numerator / new_x;

    let tokens_out = u64::try_from(tokens_out_u128).map_err(|_| CurveError::Overflow)?;
    if tokens_out == 0 {
        return Err(CurveError::ZeroAmount);
    }
    // Cannot hand out the entire reserve — that would leave k undefined.
    if tokens_out >= token_reserves {
        return Err(CurveError::InsufficientLiquidity);
    }

    Ok(BuyQuote {
        fee_lamports,
        lamports_to_curve,
        tokens_out,
    })
}

/// Quote a sell: tokens in, lamports out.
pub fn quote_sell(
    sol_reserves: u64,
    token_reserves: u64,
    tokens_in: u64,
    fee_bps: u64,
) -> Result<SellQuote, CurveError> {
    if tokens_in == 0 {
        return Err(CurveError::ZeroAmount);
    }
    if sol_reserves == 0 || token_reserves == 0 {
        return Err(CurveError::InsufficientLiquidity);
    }

    let x = sol_reserves as u128;
    let y = token_reserves as u128;
    let dy = tokens_in as u128;

    // out = (x * dy) / (y + dy) — the mirror of the buy branch.
    let new_y = y.checked_add(dy).ok_or(CurveError::Overflow)?;
    let numerator = x.checked_mul(dy).ok_or(CurveError::Overflow)?;
    let gross_u128 = numerator / new_y; // rounds DOWN, favours the curve

    let gross_lamports = u64::try_from(gross_u128).map_err(|_| CurveError::Overflow)?;
    if gross_lamports == 0 {
        return Err(CurveError::ZeroAmount);
    }
    if gross_lamports >= sol_reserves {
        return Err(CurveError::InsufficientLiquidity);
    }

    let fee_lamports = fee_up(gross_lamports, fee_bps)?;
    let lamports_out = gross_lamports
        .checked_sub(fee_lamports)
        .ok_or(CurveError::Overflow)?;

    Ok(SellQuote {
        gross_lamports,
        fee_lamports,
        lamports_out,
    })
}

/// The largest `lamports_in` that moves real SOL reserves exactly to
/// `target_real_sol` and no further.
///
/// This exists for the graduation edge: a buy that would push the curve past its
/// graduation threshold must be CAPPED at the threshold, not rejected and not
/// allowed to overshoot. Rejecting would make the final buy unfillable (a
/// permanent stall one lamport from graduating); overshooting would let the last
/// buyer size the migrated pool. The caller fills `capped` and refunds the rest.
///
/// Returns `None` when the curve has already reached the target.
pub fn lamports_until_target(
    real_sol_reserves: u64,
    target_real_sol: u64,
    fee_bps: u64,
) -> Result<Option<u64>, CurveError> {
    if real_sol_reserves >= target_real_sol {
        return Ok(None);
    }
    let remaining_to_curve = target_real_sol
        .checked_sub(real_sol_reserves)
        .ok_or(CurveError::Overflow)?;

    // `remaining_to_curve` is post-fee. Gross it back up so the caller charges the
    // fee on the full amount: gross = ceil(net * BPS / (BPS - fee_bps)).
    if fee_bps >= BPS_DENOMINATOR {
        return Err(CurveError::FeeTooHigh);
    }
    let denom = (BPS_DENOMINATOR - fee_bps) as u128;
    let gross = (remaining_to_curve as u128)
        .checked_mul(BPS_DENOMINATOR as u128)
        .ok_or(CurveError::Overflow)?
        .div_ceil(denom);

    Ok(Some(u64::try_from(gross).map_err(|_| CurveError::Overflow)?))
}

/// The most real SOL a curve can EVER accumulate, given its opening parameters.
///
/// This bound exists because the curve prices on `virtual + real` reserves on
/// **both** legs. Starting from `k = V_s · (V_t + S)`, the token leg bottoms out
/// at `V_t` once the whole supply `S` has been bought, so the SOL leg tops out at
/// `k / V_t` — i.e. real SOL is capped at:
///
/// ```text
///     V_s · S / V_t
/// ```
///
/// The true ceiling is strictly BELOW this: `quote_buy` refuses to hand out the
/// entire token reserve, so the last fraction is unreachable. Treat the returned
/// value as an exclusive upper bound.
///
/// # Why this is a safety check, not a curiosity
///
/// A graduation target set above this bound produces a launch that can **never
/// graduate**. Buyers keep paying in until the token reserve runs down, `buy`
/// then fails on the reserve check, and `graduate` never qualifies. Holders can
/// still sell out, so it is not a fund-loss bug — but the launch is permanently
/// dead and can never reach the AMM, which is the entire point of the product.
/// Configuration must be rejected up front rather than discovered by a launch
/// that silently cannot finish.
pub fn max_reachable_real_sol(
    virtual_sol: u64,
    virtual_token: u64,
    token_supply: u64,
) -> Result<u64, CurveError> {
    if virtual_sol == 0 || virtual_token == 0 || token_supply == 0 {
        return Err(CurveError::ZeroAmount);
    }
    let numerator = (virtual_sol as u128)
        .checked_mul(token_supply as u128)
        .ok_or(CurveError::Overflow)?;
    // Round DOWN: this is used as a ceiling to compare a target against, so
    // understating it keeps the check conservative.
    let max = numerator / (virtual_token as u128);
    u64::try_from(max).map_err(|_| CurveError::Overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u64 = 1_000_000_000;
    // A plausible opening book: 30 virtual SOL against 1.07B tokens.
    const V_SOL: u64 = 30 * SOL;
    const V_TOK: u64 = 1_073_000_000_000_000;

    #[test]
    fn buy_returns_tokens_and_charges_fee() {
        let q = quote_buy(V_SOL, V_TOK, SOL, 100).unwrap();
        assert_eq!(q.fee_lamports, SOL / 100);
        assert_eq!(q.lamports_to_curve, SOL - q.fee_lamports);
        assert!(q.tokens_out > 0);
        assert!(q.tokens_out < V_TOK);
    }

    #[test]
    fn zero_fee_sends_everything_to_the_curve() {
        let q = quote_buy(V_SOL, V_TOK, SOL, 0).unwrap();
        assert_eq!(q.fee_lamports, 0);
        assert_eq!(q.lamports_to_curve, SOL);
    }

    #[test]
    fn price_rises_as_the_curve_fills() {
        // The same spend must buy strictly fewer tokens once reserves have moved.
        let first = quote_buy(V_SOL, V_TOK, SOL, 0).unwrap();
        let later = quote_buy(V_SOL + 10 * SOL, V_TOK - first.tokens_out, SOL, 0).unwrap();
        assert!(
            later.tokens_out < first.tokens_out,
            "price must increase along the curve: {} !< {}",
            later.tokens_out,
            first.tokens_out
        );
    }

    /// The core anti-extraction property. Buying then immediately selling back
    /// must never return more than was put in — with zero fee it may at best
    /// break even minus truncation dust.
    #[test]
    fn round_trip_never_profits() {
        for spend in [SOL / 1000, SOL, 5 * SOL, 25 * SOL] {
            let buy = quote_buy(V_SOL, V_TOK, spend, 0).unwrap();
            let sol_after = V_SOL + buy.lamports_to_curve;
            let tok_after = V_TOK - buy.tokens_out;
            let sell = quote_sell(sol_after, tok_after, buy.tokens_out, 0).unwrap();
            assert!(
                sell.lamports_out <= spend,
                "round trip profited: put in {}, got back {}",
                spend,
                sell.lamports_out
            );
        }
    }

    /// Splitting a buy into many small buys must not beat one large buy. If it
    /// did, the curve would be farmable by order-slicing.
    #[test]
    fn splitting_a_buy_never_beats_one_shot() {
        let total = 10 * SOL;
        let one_shot = quote_buy(V_SOL, V_TOK, total, 0).unwrap().tokens_out;

        let mut sol = V_SOL;
        let mut tok = V_TOK;
        let mut acc: u64 = 0;
        for _ in 0..10 {
            let q = quote_buy(sol, tok, total / 10, 0).unwrap();
            sol += q.lamports_to_curve;
            tok -= q.tokens_out;
            acc += q.tokens_out;
        }
        assert!(
            acc <= one_shot,
            "slicing beat one-shot: {} > {}",
            acc,
            one_shot
        );
    }

    /// Fees round up, so slicing cannot dodge them either.
    #[test]
    fn fee_rounds_up_so_dust_trades_still_pay() {
        // 1 lamport at 1 bps would be 0.0001 → must still charge 1.
        assert_eq!(fee_up(1, 1).unwrap(), 1);
        assert_eq!(fee_up(0, 100).unwrap(), 0);
        assert_eq!(fee_up(10_000, 100).unwrap(), 100);
        // Exactly divisible must NOT be pushed to the next lamport.
        assert_eq!(fee_up(20_000, 100).unwrap(), 200);
    }

    #[test]
    fn fee_above_ceiling_is_rejected() {
        assert_eq!(fee_up(SOL, MAX_FEE_BPS + 1), Err(CurveError::FeeTooHigh));
        assert_eq!(
            quote_buy(V_SOL, V_TOK, SOL, MAX_FEE_BPS + 1),
            Err(CurveError::FeeTooHigh)
        );
    }

    #[test]
    fn zero_and_empty_are_rejected() {
        assert_eq!(quote_buy(V_SOL, V_TOK, 0, 0), Err(CurveError::ZeroAmount));
        assert_eq!(quote_sell(V_SOL, V_TOK, 0, 0), Err(CurveError::ZeroAmount));
        assert_eq!(
            quote_buy(0, V_TOK, SOL, 0),
            Err(CurveError::InsufficientLiquidity)
        );
        assert_eq!(
            quote_sell(V_SOL, 0, 1, 0),
            Err(CurveError::InsufficientLiquidity)
        );
    }

    /// A buy whose entire input is consumed by the fee must revert, not silently
    /// pocket the fee and mint nothing.
    #[test]
    fn dust_buy_fully_eaten_by_fee_reverts() {
        assert_eq!(quote_buy(V_SOL, V_TOK, 1, 10_000), Err(CurveError::FeeTooHigh));
        // At the max legal fee, 1 lamport rounds entirely to fee → nothing reaches
        // the curve → reject.
        assert_eq!(quote_buy(V_SOL, V_TOK, 1, MAX_FEE_BPS), Err(CurveError::ZeroAmount));
    }

    /// The reserve can never be fully drained — but NOT because the guard trips.
    /// `out = y*dx/(x+dx)` approaches `y` asymptotically and never reaches it, so
    /// the protection is the curve itself. (An earlier version of this test
    /// asserted `InsufficientLiquidity` on a huge buy; that was wrong — a spend of
    /// u64::MAX/4 against a 1,000-token reserve legitimately returns 999. The
    /// `tokens_out >= token_reserves` check in `quote_buy` is therefore
    /// belt-and-braces against a future change to the formula or its rounding,
    /// not a live branch. Kept deliberately: it is nearly free and this is a
    /// fund-holding path.)
    #[test]
    fn can_never_take_the_entire_token_reserve() {
        for reserves in [1_000u64, 1_000_000, V_TOK] {
            for spend in [u64::MAX / 4, u64::MAX / 2] {
                let q = quote_buy(V_SOL, reserves, spend, 0).unwrap();
                assert!(
                    q.tokens_out < reserves,
                    "drained the reserve: took {} of {}",
                    q.tokens_out,
                    reserves
                );
            }
        }
    }

    #[test]
    fn extreme_reserves_do_not_overflow() {
        // u64::MAX-scale reserves must still resolve through the u128 intermediates.
        let q = quote_buy(u64::MAX / 2, u64::MAX / 2, SOL, 0);
        assert!(q.is_ok(), "large reserves overflowed: {q:?}");
    }

    #[test]
    fn target_cap_grosses_up_the_fee() {
        // 10 SOL still needed, 1% fee → gross must exceed 10 SOL so that the
        // post-fee amount lands exactly on target.
        let gross = lamports_until_target(0, 10 * SOL, 100).unwrap().unwrap();
        assert!(gross > 10 * SOL);
        let fee = fee_up(gross, 100).unwrap();
        assert!(
            gross - fee >= 10 * SOL,
            "net {} fell short of target {}",
            gross - fee,
            10 * SOL
        );
    }

    #[test]
    fn target_cap_is_none_once_reached() {
        assert_eq!(lamports_until_target(10 * SOL, 10 * SOL, 100).unwrap(), None);
        assert_eq!(lamports_until_target(11 * SOL, 10 * SOL, 100).unwrap(), None);
    }

    /// The bound must be real: drive a curve to exhaustion with repeated buys and
    /// confirm accumulated real SOL never exceeds what `max_reachable_real_sol`
    /// predicts. This is the property the config check depends on.
    #[test]
    fn max_reachable_sol_is_a_true_ceiling() {
        let supply: u64 = 1_000_000_000_000_000;
        let predicted = max_reachable_real_sol(V_SOL, V_TOK, supply).unwrap();

        let mut eff_sol = V_SOL;
        let mut eff_tok = V_TOK + supply;
        let mut real_sol: u64 = 0;
        let mut real_tok = supply;

        // Step size matters: a quote is computed against EFFECTIVE (virtual+real)
        // token reserves but can only be paid out of REAL ones, so an over-large
        // buy quotes more tokens than exist and is rejected outright. Walk the
        // curve in small steps instead — which is also how it fills in practice.
        for _ in 0..5_000 {
            let spend = SOL / 10;
            let q = match quote_buy(eff_sol, eff_tok, spend, 0) {
                Ok(q) => q,
                Err(_) => break,
            };
            if q.tokens_out > real_tok {
                break;
            }
            eff_sol += q.lamports_to_curve;
            eff_tok -= q.tokens_out;
            real_sol += q.lamports_to_curve;
            real_tok -= q.tokens_out;
        }

        assert!(
            real_sol <= predicted,
            "accumulated {} exceeded the predicted ceiling {}",
            real_sol,
            predicted
        );
        // And the bound should be tight enough to be useful, not vacuous.
        assert!(
            real_sol * 2 > predicted,
            "ceiling {} is far above what is actually reachable ({}) — too loose to be a useful check",
            predicted,
            real_sol
        );
    }

    #[test]
    fn max_reachable_sol_scales_as_the_formula_says() {
        // Use a supply that divides exactly, so the relationship is not obscured
        // by truncation. (Asserting floor(2x) == 2*floor(x) on arbitrary inputs
        // is simply false — an earlier version of this test made that mistake and
        // failed 55 vs 54.)
        let v_tok: u64 = 1_000_000_000_000;
        let v_sol: u64 = 10 * SOL;
        let supply: u64 = 2_000_000_000_000;

        let a = max_reachable_real_sol(v_sol, v_tok, supply).unwrap();
        assert_eq!(a, v_sol * 2, "V_s * S / V_t with S = 2*V_t must be 2*V_s");

        // Doubling the virtual SOL leg doubles the ceiling.
        assert_eq!(max_reachable_real_sol(v_sol * 2, v_tok, supply).unwrap(), a * 2);
        // Doubling the virtual TOKEN leg halves it.
        assert_eq!(max_reachable_real_sol(v_sol, v_tok * 2, supply).unwrap(), a / 2);
    }

    #[test]
    fn max_reachable_sol_rejects_degenerate_input() {
        assert_eq!(
            max_reachable_real_sol(0, V_TOK, 1),
            Err(CurveError::ZeroAmount)
        );
        assert_eq!(
            max_reachable_real_sol(V_SOL, 0, 1),
            Err(CurveError::ZeroAmount)
        );
        assert_eq!(
            max_reachable_real_sol(V_SOL, V_TOK, 0),
            Err(CurveError::ZeroAmount)
        );
    }

    #[test]
    fn sell_mirrors_buy_direction() {
        // Selling into a bigger token reserve yields less per token.
        let a = quote_sell(V_SOL, V_TOK, 1_000_000_000, 0).unwrap();
        let b = quote_sell(V_SOL, V_TOK * 2, 1_000_000_000, 0).unwrap();
        assert!(b.lamports_out < a.lamports_out);
    }
}
