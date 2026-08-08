//! Segmented bonding curve — the Meteora-shaped mode.
//!
//! # What this is
//!
//! Instead of one constant-product invariant over virtual reserves (see [`crate::curve`],
//! the pump.fun shape), a launch may price against **up to 16 liquidity segments**. Each
//! segment is a `(sqrt_price_upper, liquidity)` pair; the curve starts at
//! `sqrt_price_start` and walks upward through segments as buyers arrive. Making early
//! segments thin and later ones thick gives steep initial price discovery that flattens
//! out — which is the shape Meteora's DBC exposes and the reason creators ask for it.
//!
//! This is the concentrated-liquidity formula, identical in form to Uniswap V3 and
//! Raydium CLMM. **Every piece of arithmetic below is delegated to
//! [`crate::vendor`]** — Raydium CLMM's Apache-2.0 math, pinned and diff-guarded. The
//! only thing this module contributes is the *loop*: which segment we are in, when to
//! cross, and when to stop. No fixed-point maths is written here, on purpose.
//!
//! # Provenance and the licence line
//!
//! The segmented *shape* is implemented from Meteora's **public documentation**, which
//! describes a 16-point `(sqrt_price, liquidity)` curve. Nothing here is derived from
//! Meteora's program source: that source is under a non-commercial licence
//! (`docs/CURVE_FORK_EVALUATION.md`), so paraphrasing it would risk a derivative-work
//! claim. Concepts are not protectable; their expression is. The expression here is
//! Raydium's Apache-2.0 maths plus our own loop.
//!
//! # Token orientation
//!
//! Throughout: **token0 = the launch token, token1 = SOL**. Price therefore means SOL
//! per launch token, and buying (SOL in, tokens out) moves the price UP — that is
//! `zero_for_one = false` in the vendored helpers.
//!
//! # Rounding
//!
//! Same rule as the constant-product curve, and for the same reason: every rounding
//! decision favours the curve, never the trader. Tokens out round DOWN, SOL owed on a
//! sell rounds DOWN, SOL required to cross a segment rounds UP. A trader can therefore
//! never profit by splitting one order into many.

// TARGETED imports, not `prelude::*`. The glob exports Anchor's own `Result<T>`
// (one generic parameter), which shadows `core::result::Result<T, E>` and breaks
// every signature in this file. Only the derives need Anchor at all; the math below
// touches nothing from it.
use anchor_lang::prelude::borsh;
use anchor_lang::{AnchorDeserialize, AnchorSerialize, InitSpace};

use crate::vendor::{liquidity_math, sqrt_price_math, tick_math};

/// Hard ceiling on segments per curve.
///
/// Matches the 16 that Meteora's documentation describes. It is also a compute bound:
/// a buy may cross every segment in one instruction, so the worst-case loop length is
/// fixed and small. Raising it raises the worst-case CU of `buy`/`sell`, which is
/// already the tightest budget in the program — do not raise it without re-measuring
/// (see the compute test in tests/).
pub const MAX_SEGMENTS: usize = 16;

/// Hard ceiling on a segment's liquidity: 2^48.
///
/// A SAFETY bound, not a product preference, and the number is MEASURED rather than
/// derived. The vendored `MulDiv for U256` no longer widens to U512 on overflow — it
/// fails closed (see `vendor/full_math.rs`), because U512's macro-generated `pow` blew
/// SBF's 4 KB stack frame. So the segment math must never form a product that
/// overflows U256, or a legitimate trade would revert instead of computing.
///
/// I first reasoned my way to `u64::MAX` from the widest product the walk forms, and
/// it was WRONG — a probe across the liquidity/amount space showed overflow at 2^56
/// liquidity once a trade exceeds ~2^50 lamports. The measured result:
///
/// ```text
///   liquidity 2^40 .. 2^48  ->  no overflow at ANY u64 amount
///   liquidity 2^56 and up   ->  overflows once the trade exceeds ~2^50 lamports
/// ```
///
/// 2^48 is the largest power of two the probe cleared across the whole u64 amount
/// range, so it is the cap. Enforcing it at config time turns "the overflow path is
/// unreachable" from an argument into an invariant, checked once and off the hot path.
///
/// ⚠️ This IS a real constraint on configuration: 2^48 is ~2.8e14. Launches around
/// 1e12-1e14 liquidity are unaffected; anything at 1e15 or above will be rejected and
/// must be expressed with a different sqrt-price span instead.
pub const MAX_SEGMENT_LIQUIDITY: u128 = 1u128 << 48;

/// One liquidity segment: constant `liquidity` up to `sqrt_price_upper_x64`.
///
/// Q64.64 sqrt price, matching the vendored math's representation exactly so no
/// conversion is ever needed at the boundary.
/// Serialization is derived UNCONDITIONALLY. It used to sit behind
/// `#[cfg_attr(feature = "anchor", ...)]`, which never fired — this crate has no
/// `anchor` feature, so the derives were silently absent and the type could not have
/// been stored on-chain at all. `anchor_lang` is a hard dependency here; there is
/// nothing to gate on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, AnchorSerialize, AnchorDeserialize, InitSpace)]
pub struct Segment {
    /// Upper sqrt-price bound of this segment, Q64.64. Strictly greater than the
    /// previous segment's bound.
    pub sqrt_price_upper_x64: u128,
    /// Liquidity active while price is inside this segment. Must be non-zero.
    pub liquidity: u128,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmentError {
    /// No segments, or more than [`MAX_SEGMENTS`].
    BadSegmentCount,
    /// Bounds not strictly ascending, or a zero-liquidity segment, or a start price
    /// at/above the first bound.
    BadSegments,
    /// A sqrt price outside the range the vendored math supports.
    SqrtPriceOutOfRange,
    /// The vendored math reported an overflow.
    Overflow,
    /// The curve cannot fill this trade — price would run past the final segment.
    InsufficientLiquidity,
    /// A zero-sized trade, or one that rounds to zero output.
    ZeroAmount,
}

/// Result of pricing a buy against the segmented curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentedBuy {
    /// Launch tokens the buyer receives.
    pub tokens_out: u64,
    /// SOL actually consumed. May be LESS than requested when the curve tops out —
    /// the caller must debit this, never the requested amount.
    pub lamports_in: u64,
    /// Where the curve ends up.
    pub sqrt_price_after_x64: u128,
}

/// Result of pricing a sell against the segmented curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmentedSell {
    pub lamports_out: u64,
    /// Tokens actually consumed; may be less than offered if the curve bottoms out.
    pub tokens_in: u64,
    pub sqrt_price_after_x64: u128,
}

/// Validate a segment array. **Call at config time, never in the trade hot path.**
///
/// Rejects: an empty or oversized array; non-ascending bounds (which would make the
/// walk ill-defined); zero liquidity (which would divide by zero); and any bound
/// outside the vendored math's supported sqrt-price range.
pub fn validate_segments(
    segments: &[Segment],
    sqrt_price_start_x64: u128,
) -> Result<(), SegmentError> {
    if segments.is_empty() || segments.len() > MAX_SEGMENTS {
        return Err(SegmentError::BadSegmentCount);
    }
    if sqrt_price_start_x64 < tick_math::MIN_SQRT_PRICE_X64
        || sqrt_price_start_x64 >= tick_math::MAX_SQRT_PRICE_X64
    {
        return Err(SegmentError::SqrtPriceOutOfRange);
    }
    let mut prev = sqrt_price_start_x64;
    for s in segments {
        if s.liquidity == 0 || s.liquidity > MAX_SEGMENT_LIQUIDITY {
            return Err(SegmentError::BadSegments);
        }
        // Strictly ascending: equal bounds would be a zero-width segment that can
        // never be crossed, and descending bounds would walk the wrong way.
        if s.sqrt_price_upper_x64 <= prev {
            return Err(SegmentError::BadSegments);
        }
        if s.sqrt_price_upper_x64 > tick_math::MAX_SQRT_PRICE_X64 {
            return Err(SegmentError::SqrtPriceOutOfRange);
        }
        prev = s.sqrt_price_upper_x64;
    }
    Ok(())
}

/// Index of the segment containing `sqrt_price_x64`, or `None` if price is at/above
/// the top of the last segment (the curve is exhausted).
fn active_segment(segments: &[Segment], sqrt_price_x64: u128) -> Option<usize> {
    segments
        .iter()
        .position(|s| sqrt_price_x64 < s.sqrt_price_upper_x64)
}

/// Price a buy: SOL in, launch tokens out, price moves UP.
///
/// `max_lamports_in` is an UPPER BOUND, mirroring the constant-product path's
/// semantics. If the curve tops out first, `lamports_in` in the result is what was
/// actually needed and the caller debits only that — the buyer is never charged for
/// liquidity that did not exist.
pub fn quote_buy(
    segments: &[Segment],
    sqrt_price_x64: u128,
    max_lamports_in: u64,
) -> Result<SegmentedBuy, SegmentError> {
    if max_lamports_in == 0 {
        return Err(SegmentError::ZeroAmount);
    }
    let mut remaining = max_lamports_in;
    let mut price = sqrt_price_x64;
    let mut tokens_out: u64 = 0;

    // Bounded by MAX_SEGMENTS: each iteration either exhausts `remaining` and returns,
    // or advances to a strictly higher segment. It cannot spin.
    let mut idx = active_segment(segments, price).ok_or(SegmentError::InsufficientLiquidity)?;
    while remaining > 0 && idx < segments.len() {
        let seg = segments[idx];

        // SOL needed to walk this segment to its upper bound. Round UP: the trader
        // must fully pay for a crossing, never get one a lamport cheap.
        let sol_to_cross =
            liquidity_math::get_delta_amount_1_unsigned(price, seg.sqrt_price_upper_x64, seg.liquidity, true)
                .map_err(|_| SegmentError::Overflow)?;

        if remaining < sol_to_cross {
            // Stops inside this segment.
            let next = sqrt_price_math::get_next_sqrt_price_from_input(
                price, seg.liquidity, remaining, false,
            )
            .map_err(|_| SegmentError::Overflow)?;
            // Round DOWN: the curve keeps the dust.
            let out = liquidity_math::get_delta_amount_0_unsigned(price, next, seg.liquidity, false)
                .map_err(|_| SegmentError::Overflow)?;
            tokens_out = tokens_out.checked_add(out).ok_or(SegmentError::Overflow)?;
            price = next;
            remaining = 0;
            break;
        }

        // Crosses the whole segment.
        let out = liquidity_math::get_delta_amount_0_unsigned(
            price,
            seg.sqrt_price_upper_x64,
            seg.liquidity,
            false,
        )
        .map_err(|_| SegmentError::Overflow)?;
        tokens_out = tokens_out.checked_add(out).ok_or(SegmentError::Overflow)?;
        remaining -= sol_to_cross;
        price = seg.sqrt_price_upper_x64;
        idx += 1;
    }

    let lamports_in = max_lamports_in - remaining;
    if lamports_in == 0 || tokens_out == 0 {
        // Either the trade was too small to move the curve, or the curve is exhausted.
        // Both are rejections rather than a silent no-op that still charges a fee.
        return Err(SegmentError::ZeroAmount);
    }
    Ok(SegmentedBuy {
        tokens_out,
        lamports_in,
        sqrt_price_after_x64: price,
    })
}

/// Price a sell: launch tokens in, SOL out, price moves DOWN.
///
/// Walks segments downward. As on the buy side, `max_tokens_in` is an upper bound:
/// if the curve bottoms out, only `tokens_in` is consumed.
pub fn quote_sell(
    segments: &[Segment],
    sqrt_price_x64: u128,
    sqrt_price_floor_x64: u128,
    max_tokens_in: u64,
) -> Result<SegmentedSell, SegmentError> {
    if max_tokens_in == 0 {
        return Err(SegmentError::ZeroAmount);
    }
    let mut remaining = max_tokens_in;
    let mut price = sqrt_price_x64;
    let mut lamports_out: u64 = 0;

    // The segment we are in when selling is the one whose upper bound is strictly
    // above price; walking down, we exit at its LOWER bound, which is the previous
    // segment's upper bound (or the floor for segment 0).
    let mut idx = match active_segment(segments, price) {
        Some(i) => i,
        // Price sits at or above the top of the last segment: sell back into the last.
        None => segments.len().checked_sub(1).ok_or(SegmentError::BadSegmentCount)?,
    };

    loop {
        let seg = segments[idx];
        let lower = if idx == 0 {
            sqrt_price_floor_x64
        } else {
            segments[idx - 1].sqrt_price_upper_x64
        };
        if price <= lower {
            if idx == 0 {
                break;
            }
            idx -= 1;
            continue;
        }

        // Tokens needed to walk this segment down to `lower`. Round UP so the trader
        // must supply the full amount for a crossing.
        let tokens_to_cross =
            liquidity_math::get_delta_amount_0_unsigned(lower, price, seg.liquidity, true)
                .map_err(|_| SegmentError::Overflow)?;

        if remaining < tokens_to_cross {
            let next = sqrt_price_math::get_next_sqrt_price_from_input(
                price, seg.liquidity, remaining, true,
            )
            .map_err(|_| SegmentError::Overflow)?;
            // Round DOWN: the curve keeps the dust.
            let out = liquidity_math::get_delta_amount_1_unsigned(next, price, seg.liquidity, false)
                .map_err(|_| SegmentError::Overflow)?;
            lamports_out = lamports_out.checked_add(out).ok_or(SegmentError::Overflow)?;
            price = next;
            remaining = 0;
            break;
        }

        let out = liquidity_math::get_delta_amount_1_unsigned(lower, price, seg.liquidity, false)
            .map_err(|_| SegmentError::Overflow)?;
        lamports_out = lamports_out.checked_add(out).ok_or(SegmentError::Overflow)?;
        remaining -= tokens_to_cross;
        price = lower;
        if idx == 0 {
            break;
        }
        idx -= 1;
    }

    let tokens_in = max_tokens_in - remaining;
    if tokens_in == 0 || lamports_out == 0 {
        return Err(SegmentError::ZeroAmount);
    }
    Ok(SegmentedSell {
        lamports_out,
        tokens_in,
        sqrt_price_after_x64: price,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Q64.64 sqrt(1.0).
    const ONE: u128 = 1u128 << 64;

    /// `sqrt_price = ONE / n` represents price `1/n^2`. Using exact ratios avoids
    /// needing an integer-sqrt helper in the tests, which would be one more piece of
    /// hand-written maths standing between us and the property being checked.
    fn sp(n: u128) -> u128 {
        ONE / n
    }

    /// Three segments: thin early (steep discovery), thicker later (flatter) — the
    /// shape creators actually ask for, and the one the segmented mode exists to give.
    fn curve3() -> (Vec<Segment>, u128) {
        let start = sp(1000); // price 1e-6
        let segs = vec![
            Segment { sqrt_price_upper_x64: sp(300), liquidity: 1_000_000_000_000 },
            Segment { sqrt_price_upper_x64: sp(100), liquidity: 5_000_000_000_000 },
            Segment { sqrt_price_upper_x64: sp(30),  liquidity: 20_000_000_000_000 },
        ];
        (segs, start)
    }

    #[test]
    fn validates_a_good_curve() {
        let (segs, start) = curve3();
        assert_eq!(validate_segments(&segs, start), Ok(()));
    }

    #[test]
    fn rejects_malformed_curves() {
        let (segs, start) = curve3();
        assert_eq!(validate_segments(&[], start), Err(SegmentError::BadSegmentCount));
        assert_eq!(
            validate_segments(&vec![segs[0]; MAX_SEGMENTS + 1], start),
            Err(SegmentError::BadSegmentCount)
        );
        // Zero liquidity would divide by zero inside the vendored math.
        let zero_liq = vec![Segment { sqrt_price_upper_x64: segs[0].sqrt_price_upper_x64, liquidity: 0 }];
        assert_eq!(validate_segments(&zero_liq, start), Err(SegmentError::BadSegments));
        // Descending bounds would walk the wrong way.
        let mut desc = segs.clone();
        desc.swap(0, 2);
        assert_eq!(validate_segments(&desc, start), Err(SegmentError::BadSegments));
        // A start price already at the first bound leaves a zero-width first segment.
        assert_eq!(
            validate_segments(&segs, segs[0].sqrt_price_upper_x64),
            Err(SegmentError::BadSegments)
        );
    }

    #[test]
    fn a_buy_moves_price_up_and_returns_tokens() {
        let (segs, start) = curve3();
        let q = quote_buy(&segs, start, 1_000_000_000).expect("buy");
        assert!(q.tokens_out > 0);
        assert!(q.sqrt_price_after_x64 > start, "price must rise on a buy");
        assert!(q.lamports_in <= 1_000_000_000);
    }

    #[test]
    fn more_sol_buys_more_tokens() {
        let (segs, start) = curve3();
        let mut last_tokens = 0u64;
        let mut last_price = start;
        for sol in [1_000_000u64, 10_000_000, 100_000_000, 1_000_000_000] {
            let q = quote_buy(&segs, start, sol).expect("buy");
            assert!(q.tokens_out > last_tokens, "monotonicity broken at {} lamports", sol);
            assert!(q.sqrt_price_after_x64 >= last_price);
            last_tokens = q.tokens_out;
            last_price = q.sqrt_price_after_x64;
        }
    }

    /// THE VALUE-LEAK TEST. Buy, then immediately sell it all back. The trader must
    /// never end up with more SOL than they started with. If this fails the curve
    /// prints money, and every other property is irrelevant.
    #[test]
    fn round_trip_never_profits_the_trader() {
        let (segs, start) = curve3();
        for sol_in in [1_000_000u64, 50_000_000, 500_000_000, 2_000_000_000] {
            let b = quote_buy(&segs, start, sol_in).expect("buy");
            let s = quote_sell(&segs, b.sqrt_price_after_x64, start, b.tokens_out).expect("sell");
            assert!(
                s.lamports_out <= b.lamports_in,
                "ROUND-TRIP PROFIT: paid {} got back {} ({} tokens)",
                b.lamports_in, s.lamports_out, b.tokens_out
            );
        }
    }

    /// THE SPLITTING TEST. Chopping one order into many must never yield more tokens
    /// than doing it in one shot. If it does, the rounding favours the trader and can
    /// be ground for free value — the classic bonding-curve leak.
    #[test]
    fn splitting_an_order_never_beats_one_shot() {
        let (segs, start) = curve3();
        let total = 400_000_000u64;
        let one = quote_buy(&segs, start, total).expect("one-shot");

        for chunks in [2u64, 4, 8, 16] {
            let mut price = start;
            let mut got = 0u64;
            for _ in 0..chunks {
                let q = quote_buy(&segs, price, total / chunks).expect("chunk");
                got += q.tokens_out;
                price = q.sqrt_price_after_x64;
            }
            assert!(
                got <= one.tokens_out,
                "SPLITTING WINS with {} chunks: {} tokens vs {} one-shot",
                chunks, got, one.tokens_out
            );
        }
    }

    #[test]
    fn a_buy_lands_exactly_on_a_segment_boundary() {
        let (segs, start) = curve3();
        let to_edge = liquidity_math::get_delta_amount_1_unsigned(
            start, segs[0].sqrt_price_upper_x64, segs[0].liquidity, true,
        ).unwrap();
        let a = quote_buy(&segs, start, to_edge).expect("to edge");
        assert_eq!(
            a.sqrt_price_after_x64, segs[0].sqrt_price_upper_x64,
            "paying the exact crossing cost must land on the boundary, not past it"
        );
        // Two steps across the boundary must not beat one step over the same distance.
        let b = quote_buy(&segs, a.sqrt_price_after_x64, to_edge).expect("past edge");
        let one = quote_buy(&segs, start, to_edge * 2).expect("one-shot");
        assert!(a.tokens_out + b.tokens_out <= one.tokens_out);
    }

    #[test]
    fn exhaustion_charges_only_for_liquidity_that_existed() {
        let (segs, start) = curve3();
        let q = quote_buy(&segs, start, u64::MAX / 2).expect("buy");
        assert_eq!(q.sqrt_price_after_x64, segs[2].sqrt_price_upper_x64, "should top out");
        assert!(
            q.lamports_in < u64::MAX / 2,
            "must debit only what was filled, never the requested amount"
        );
        // At the top the curve must refuse rather than accept free money.
        assert!(quote_buy(&segs, q.sqrt_price_after_x64, 1_000_000).is_err());
    }

    #[test]
    fn zero_and_dust_are_rejected_not_silently_charged() {
        let (segs, start) = curve3();
        assert_eq!(quote_buy(&segs, start, 0), Err(SegmentError::ZeroAmount));
        assert_eq!(quote_sell(&segs, start, start, 0), Err(SegmentError::ZeroAmount));
        // Selling when already at the floor has nowhere to go.
        assert!(quote_sell(&segs, start, start, 1_000).is_err());
    }

    #[test]
    fn sell_moves_price_down_and_never_below_the_floor() {
        let (segs, start) = curve3();
        let b = quote_buy(&segs, start, 800_000_000).expect("buy");
        let s = quote_sell(&segs, b.sqrt_price_after_x64, start, u64::MAX / 2).expect("sell all");
        assert!(s.sqrt_price_after_x64 < b.sqrt_price_after_x64, "price must fall on a sell");
        assert!(s.sqrt_price_after_x64 >= start, "must never fall below the floor");
        assert!(s.tokens_in < u64::MAX / 2, "must consume only what the curve absorbed");
    }

    /// A 16-segment curve is the documented maximum and the worst case for the loop.
    #[test]
    fn the_maximum_segment_count_works_end_to_end() {
        let start = sp(2000);
        let segs: Vec<Segment> = (0..MAX_SEGMENTS)
            .map(|i| Segment {
                sqrt_price_upper_x64: sp(1900 - (i as u128) * 100),
                liquidity: 1_000_000_000_000 + (i as u128) * 100_000_000_000,
            })
            .collect();
        assert_eq!(validate_segments(&segs, start), Ok(()));
        let b = quote_buy(&segs, start, 5_000_000_000).expect("buy across many segments");
        assert!(b.tokens_out > 0);
        let s = quote_sell(&segs, b.sqrt_price_after_x64, start, b.tokens_out).expect("sell back");
        assert!(s.lamports_out <= b.lamports_in, "round-trip must not profit across 16 segments");
    }
    // ── SELL-SIDE LEAK TESTS ───────────────────────────────────────────────────
    //
    // Added after mutation testing. The buy-side properties above were caught by
    // `splitting_an_order_never_beats_one_shot` and the boundary test, but flipping
    // EITHER sell-side rounding direction — the SOL paid out on a partial sell, or
    // the tokens required to cross a segment downward — left every test green.
    // A curve that overpays on every sell would have shipped.
    //
    // The buy-side round-trip test could not catch it: it compares SOL out against
    // SOL in across a wide spread, so a one-lamport-per-step overpay hides inside
    // the margin. These isolate the sell path instead.

    /// Mirror of the buy-side splitting test, on the sell side. Chopping a sell into
    /// many small sells must never return more SOL than selling in one go.
    #[test]
    fn splitting_a_sell_never_beats_one_shot() {
        let (segs, start) = curve3();
        let b = quote_buy(&segs, start, 900_000_000).expect("buy");
        let top = b.sqrt_price_after_x64;
        let held = b.tokens_out;

        let one = quote_sell(&segs, top, start, held).expect("one-shot sell");

        for chunks in [2u64, 4, 8, 16, 32] {
            let mut price = top;
            let mut sol = 0u64;
            let mut sold = 0u64;
            for _ in 0..chunks {
                let part = held / chunks;
                if part == 0 {
                    break;
                }
                match quote_sell(&segs, price, start, part) {
                    Ok(q) => {
                        sol += q.lamports_out;
                        sold += q.tokens_in;
                        price = q.sqrt_price_after_x64;
                    }
                    Err(_) => break,
                }
            }
            assert!(
                sol <= one.lamports_out,
                "SPLITTING A SELL WINS with {} chunks: {} lamports for {} tokens vs {} for {}",
                chunks, sol, sold, one.lamports_out, one.tokens_in
            );
        }
    }

    /// Selling exactly the tokens needed to walk down to a segment boundary must land
    /// ON the boundary, and doing it in two steps must not beat doing it in one.
    /// This is what catches a flipped rounding on the downward crossing cost.
    #[test]
    fn a_sell_lands_exactly_on_a_segment_boundary() {
        let (segs, start) = curve3();
        // Park price strictly inside segment 1. Derive the amount rather than guessing
        // one: buy exactly to segment 0's upper bound, then a little further.
        let lower = segs[0].sqrt_price_upper_x64;
        let to_b0 = liquidity_math::get_delta_amount_1_unsigned(start, lower, segs[0].liquidity, true).unwrap();
        let into_b1 = liquidity_math::get_delta_amount_1_unsigned(lower, segs[1].sqrt_price_upper_x64, segs[1].liquidity, true).unwrap() / 4;
        let b = quote_buy(&segs, start, to_b0 + into_b1).expect("buy into segment 1");
        let price = b.sqrt_price_after_x64;
        assert!(price > lower, "test setup: price must be above the boundary");
        assert!(price < segs[1].sqrt_price_upper_x64, "test setup: price must be inside segment 1");

        let to_edge =
            liquidity_math::get_delta_amount_0_unsigned(lower, price, segs[1].liquidity, true)
                .unwrap();
        let a = quote_sell(&segs, price, start, to_edge).expect("sell to edge");
        assert_eq!(
            a.sqrt_price_after_x64, lower,
            "supplying the exact crossing amount must land on the boundary"
        );

        // Two steps down across the boundary must not out-earn one step.
        let step = to_edge / 2;
        let s1 = quote_sell(&segs, price, start, step).expect("half");
        let s2 = quote_sell(&segs, s1.sqrt_price_after_x64, start, step).expect("half again");
        assert!(
            s1.lamports_out + s2.lamports_out <= a.lamports_out,
            "two-step sell out-earned one step: {} + {} > {}",
            s1.lamports_out, s2.lamports_out, a.lamports_out
        );
    }

    /// The tightest possible round trip: buy a small amount and immediately sell the
    /// exact tokens back, repeated from several starting prices. With no spread to
    /// hide in, a single lamport of sell-side overpay shows up.
    #[test]
    fn tight_round_trips_never_profit_at_any_price() {
        let (segs, start) = curve3();
        let mut price = start;
        // Walk up the curve, doing a tight round trip at each stop.
        for step in 0..8u64 {
            let b = quote_buy(&segs, price, 20_000_000).expect("advance");
            price = b.sqrt_price_after_x64;

            let probe = quote_buy(&segs, price, 5_000_000).expect("probe buy");
            let back = quote_sell(&segs, probe.sqrt_price_after_x64, start, probe.tokens_out)
                .expect("probe sell");
            assert!(
                back.lamports_out <= probe.lamports_in,
                "TIGHT ROUND-TRIP PROFIT at step {}: paid {} got {} ({} tokens)",
                step, probe.lamports_in, back.lamports_out, probe.tokens_out
            );
        }
    }

    /// Selling into the curve and buying straight back must not leave the trader with
    /// more tokens than they started with — the mirror of the round-trip property,
    /// entered from the sell side so it exercises the downward walk first.
    #[test]
    fn sell_then_rebuy_never_gains_tokens() {
        let (segs, start) = curve3();
        let setup = quote_buy(&segs, start, 900_000_000).expect("setup");
        let price = setup.sqrt_price_after_x64;

        for tokens in [setup.tokens_out / 8, setup.tokens_out / 4, setup.tokens_out / 2] {
            let s = quote_sell(&segs, price, start, tokens).expect("sell");
            let b = quote_buy(&segs, s.sqrt_price_after_x64, s.lamports_out).expect("rebuy");
            assert!(
                b.tokens_out <= s.tokens_in,
                "SELL/REBUY GAINED TOKENS: sold {} for {} lamports, rebought {}",
                s.tokens_in, s.lamports_out, b.tokens_out
            );
        }
    }
    /// Buy up through every segment, then sell all the way back to the floor, and
    /// check the VALUE. Added after mutation testing: inflating the payout on a FULL
    /// downward segment crossing slipped past every other test, because the partial-
    /// crossing tests never exercise that branch and the splitting tests inflate both
    /// sides equally. This is the only property that pins the full-crossing payout.
    #[test]
    fn full_round_trip_across_every_segment_never_profits() {
        let (segs, start) = curve3();
        // Enough to top the curve out, so the sell has to cross all three segments.
        let b = quote_buy(&segs, start, u64::MAX / 2).expect("buy to the top");
        assert_eq!(b.sqrt_price_after_x64, segs[2].sqrt_price_upper_x64);

        let s = quote_sell(&segs, b.sqrt_price_after_x64, start, b.tokens_out).expect("sell it all");
        assert!(
            s.lamports_out <= b.lamports_in,
            "FULL ROUND-TRIP PROFIT across all segments: paid {} got back {}",
            b.lamports_in, s.lamports_out
        );
    }
    /// SOLVENCY. The curve may never pay out more SOL than it has taken in — not to
    /// one trader, not to all of them.
    ///
    /// This is the only test that exercises the FULL downward segment crossing.
    /// Everything else sells back exactly what was bought, and because buys round
    /// tokens DOWN while a crossing requires them rounded UP, that amount is always a
    /// hair short of a full crossing — so the full-crossing branch never ran and its
    /// rounding was completely unpinned. Selling MORE than was bought is what reaches
    /// it, and solvency is the property that makes the payout wrong if it inflates.
    #[test]
    fn the_curve_can_never_pay_out_more_than_it_took_in() {
        let (segs, start) = curve3();
        let b = quote_buy(&segs, start, u64::MAX / 2).expect("buy to the top");
        let taken_in = b.lamports_in;

        // Offer far more tokens than were ever minted by this curve, so the sell walks
        // every segment down to the floor through the full-crossing branch.
        let s = quote_sell(&segs, b.sqrt_price_after_x64, start, u64::MAX / 2).expect("dump");
        assert!(
            s.lamports_out <= taken_in,
            "INSOLVENT: curve took in {} but paid out {}",
            taken_in, s.lamports_out
        );
        assert_eq!(s.sqrt_price_after_x64, start, "a full dump must land on the floor");
    }
    /// GOLDEN VALUES — the only thing that can pin a one-lamport rounding decision.
    ///
    /// Every inequality above is blind to a small leak: the natural buy/sell spread on
    /// this fixture is about 6 lamports (one per segment, each way), so flipping the
    /// full-crossing payout to round UP — worth 3 lamports — stays comfortably inside
    /// "did not profit" and "still solvent" and ships green. Mutation testing found
    /// exactly that hole.
    ///
    /// So these assert the EXACT payout for a full dump down each segment. The numbers
    /// are floor(L * (sqrtB - sqrtA) / 2^64) per segment, which is the rounding the
    /// curve must use — every lamport of truncation belongs to the curve, not the
    /// seller. If a value here changes, a rounding direction changed with it: work out
    /// which before re-pinning, because that is the whole reason this test exists.
    #[test]
    fn full_crossing_payouts_are_exact_to_the_lamport() {
        let (segs, start) = curve3();

        // Per-segment floor payouts, bottom to top.
        const SEG0: u64 = 2_333_333_333;
        const SEG1: u64 = 33_333_333_333;
        const SEG2: u64 = 466_666_666_666;

        let b = quote_buy(&segs, start, u64::MAX / 2).expect("buy to the top");
        assert_eq!(b.sqrt_price_after_x64, segs[2].sqrt_price_upper_x64);

        let s = quote_sell(&segs, b.sqrt_price_after_x64, start, u64::MAX / 2).expect("dump");
        assert_eq!(
            s.lamports_out,
            SEG0 + SEG1 + SEG2,
            "full-dump payout changed — a rounding direction moved in the sell path"
        );
        assert_eq!(s.sqrt_price_after_x64, start, "a full dump must land on the floor");
    }
    /// The buy-side mirror of [`full_crossing_payouts_are_exact_to_the_lamport`].
    /// Mutation testing showed the buy full-crossing branch had the same hole: every
    /// inequality tolerated a few tokens of over-issuance, so only an exact value
    /// pins it.
    ///
    /// Note `lamports_in` here (502,333,333,335) is 3 MORE than the full-dump payout
    /// (502,333,333,332). That 3-lamport gap IS the rounding spread — one lamport per
    /// segment, charged on the way up and withheld on the way down. It is the curve's
    /// margin against round-tripping, and if it ever reaches zero the curve can be
    /// cycled for free.
    #[test]
    fn full_buy_to_the_top_is_exact_to_the_token() {
        let (segs, start) = curve3();
        let b = quote_buy(&segs, start, u64::MAX / 2).expect("buy to the top");
        assert_eq!(b.tokens_out, 3_100_000_000_000_000, "token issuance changed — a buy rounding moved");
        assert_eq!(b.lamports_in, 502_333_333_335, "cost to top out changed — a buy rounding moved");

        let s = quote_sell(&segs, b.sqrt_price_after_x64, start, u64::MAX / 2).expect("dump");
        assert!(
            b.lamports_in > s.lamports_out,
            "the curve must keep a rounding margin: in {} out {}",
            b.lamports_in, s.lamports_out
        );
    }
    /// The vendored `MulDiv for U256` now FAILS CLOSED where upstream widened to
    /// U512 (U512 was deleted — its macro-generated `pow` blew SBF's 4 KB stack
    /// frame). That is a real behavioural difference, so it needs to be shown inert
    /// for the inputs this curve actually produces.
    ///
    /// The removed branch runs only when `self.overflowing_mul(num)` overflows U256.
    /// The largest product the segment math forms is
    /// `(liquidity << 64) * (sqrt_b - sqrt_a)`, and U256::MAX is ~1.16e77. This walks
    /// a maximal curve — 16 segments, the largest liquidity we permit, the widest
    /// legal sqrt-price span — and asserts every quote still succeeds. A hit on the
    /// removed path would surface as `Overflow`, not a wrong number, because
    /// `mul_div_*` returning None maps to `CalculateOverflow` and reverts.
    #[test]
    fn realistic_inputs_never_reach_the_removed_u512_path() {
        // Liquidity far above anything a launch would configure, across 16 segments
        // spanning most of the supported sqrt-price range.
        let start = sp(4000);
        let segs: Vec<Segment> = (0..MAX_SEGMENTS)
            .map(|i| Segment {
                sqrt_price_upper_x64: sp(3900 - (i as u128) * 240),
                liquidity: MAX_SEGMENT_LIQUIDITY,
            })
            .collect();
        assert_eq!(validate_segments(&segs, start), Ok(()));

        // Every amount a real trade could carry. Solana's entire supply is ~6e17
        // lamports, so u64::MAX/4 (4.6e18) is already beyond physically possible —
        // included anyway, because the bound should hold for any u64 a caller can pass.
        for sol in [1u64, 1_000, 1_000_000_000, u64::MAX / 4, u64::MAX / 2] {
            let b = quote_buy(&segs, start, sol);
            assert!(
                !matches!(b, Err(SegmentError::Overflow)),
                "buy of {} lamports hit an overflow — the fail-closed U256 path is REACHABLE                  with realistic inputs, so removing U512 is not safe",
                sol
            );
            if let Ok(q) = b {
                let s = quote_sell(&segs, q.sqrt_price_after_x64, start, q.tokens_out);
                assert!(
                    !matches!(s, Err(SegmentError::Overflow)),
                    "sell after a {} lamport buy hit an overflow",
                    sol
                );
            }
        }
    }
    // ── Properties the WIRING depends on ──────────────────────────────────────
    // These pin behaviour the instruction layer now relies on. They live here
    // because they are properties of the curve, not of Anchor.

    /// The dispatcher persists `sqrt_price_after_x64` back onto the curve after every
    /// trade. If that write were ever dropped, each trade would re-price from the
    /// opening price and a buyer could drain the curve at launch price. This pins the
    /// precondition that makes the write meaningful: consecutive buys MUST return
    /// strictly increasing prices, so a stalled price is observable.
    #[test]
    fn consecutive_buys_strictly_advance_the_price() {
        let (segs, start) = curve3();
        let mut price = start;
        for i in 0..6 {
            let q = quote_buy(&segs, price, 20_000_000).expect("buy");
            assert!(
                q.sqrt_price_after_x64 > price,
                "buy {} did not advance the price ({} -> {})",
                i, price, q.sqrt_price_after_x64
            );
            price = q.sqrt_price_after_x64;
        }
    }

    /// The dispatcher refuses a partial fill rather than reconciling it against a fee
    /// already computed on the full amount. This pins that a partial fill is a real,
    /// reachable outcome — so the refusal is doing something, not guarding a case
    /// that cannot happen.
    #[test]
    fn a_partial_fill_is_reachable_and_reports_less_than_offered() {
        let (segs, start) = curve3();
        let huge = u64::MAX / 2;
        let q = quote_buy(&segs, start, huge).expect("buy");
        assert!(
            q.lamports_in < huge,
            "expected a partial fill so the dispatcher's refusal has something to catch"
        );
    }

    /// A launch snapshots its opening price and sells price down to THAT, never
    /// below. Pins that the floor is honoured even when the sell is larger than the
    /// curve holds.
    #[test]
    fn sells_stop_at_the_opening_price_not_below_it() {
        let (segs, start) = curve3();
        let b = quote_buy(&segs, start, 600_000_000).expect("buy");
        let s = quote_sell(&segs, b.sqrt_price_after_x64, start, u64::MAX / 2).expect("dump");
        assert_eq!(
            s.sqrt_price_after_x64, start,
            "a full dump must land exactly on the opening price"
        );
    }
}
