// memetics.finance: compute_swap's rule for each of the four swap kinds. It replaces upstream's
// compute_swap_step_test, which solana-ci.yml skips: for an exact output with the fee on the
// output coin, that test adds the fee to what the user received and expects the amount asked,
// which holds only at a zero fee. swap_math.rs stays byte for byte upstream's.
use proptest::prelude::*;
use proptest::test_runner::{Config, TestRunner};
use raydium_clmm::error::ErrorCode;
use raydium_clmm::libraries::swap_math::compute_swap;
use raydium_clmm::libraries::tick_math::{
    get_sqrt_price_at_tick, MAX_SQRT_PRICE_X64, MAX_TICK, MIN_SQRT_PRICE_X64, MIN_TICK,
};
use raydium_clmm::states::config::FEE_RATE_DENOMINATOR_VALUE;
use raydium_clmm::states::pool_fee::MAX_FEE_RATE_NUMERATOR;
use std::sync::atomic::{AtomicU32, Ordering};

const D: u128 = FEE_RATE_DENOMINATOR_VALUE as u128;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    Short,
    Reached,
    /// The amounts would not fit a u64, so the swap is refused and no coin moves.
    Refused,
}

/// One step of `asked`, checked against the rule for its kind. Err names the broken line.
fn rule(
    current: u128,
    target: u128,
    liquidity: u128,
    asked: u64,
    fee_rate: u32,
    is_base_input: bool,
    is_fee_on_input: bool,
) -> Result<Step, String> {
    let zero_for_one = current > target;
    let s = match compute_swap(
        current,
        target,
        liquidity,
        asked,
        fee_rate,
        is_base_input,
        zero_for_one,
        is_fee_on_input,
    ) {
        Ok(s) => s,
        Err(e)
            if e == ErrorCode::MaxTokenOverflow.into()
                || e == ErrorCode::CalculateOverflow.into() =>
        {
            return Ok(Step::Refused)
        }
        Err(e) => return Err(format!("compute_swap failed: {e:?}")),
    };
    let (amount_in, amount_out, fee) = (
        u128::from(s.amount_in),
        u128::from(s.amount_out),
        u128::from(s.fee_amount),
    );
    let (asked, r) = (u128::from(asked), u128::from(fee_rate));
    let reached = s.sqrt_price_next_x64 == target;
    let fail = |what: &str| {
        Err(format!(
            "{what}: in {amount_in}, out {amount_out}, fee {fee}, asked {asked}, reached {reached}"
        ))
    };

    if s.sqrt_price_next_x64 < current.min(target) || s.sqrt_price_next_x64 > current.max(target) {
        return fail("the next price is outside the step");
    }
    // What the user's amount pays for: the coin taken in, or the coin paid out to the user.
    let used = match (is_base_input, is_fee_on_input) {
        (true, true) => amount_in + fee,
        (true, false) => amount_in,
        (false, _) => amount_out,
    };
    if !reached && used != asked {
        return fail("a step short of its target uses all of the amount");
    }
    if reached && used > asked {
        return fail("a step that reaches its target uses at most the amount");
    }
    // The fee rounds the pool's way: at least fee_rate of the gross on the side it is taken from.
    if is_fee_on_input {
        if fee * (D - r) < amount_in * r {
            return fail("the fee is at least fee_rate of the gross input");
        }
    } else {
        let gross = amount_out + fee;
        if fee * D < gross * r {
            return fail("the fee is at least fee_rate of the gross output");
        }
        if gross * (D - r) < amount_out * D {
            return fail("the gross output covers the net output and the fee");
        }
    }
    Ok(if reached { Step::Reached } else { Step::Short })
}

fn log_uniform_u64(max_bits: u32) -> impl Strategy<Value = u64> {
    (1..=max_bits).prop_flat_map(|bits| (1u64 << (bits - 1))..=(u64::MAX >> (64 - bits)))
}

fn log_uniform_u128(max_bits: u32) -> impl Strategy<Value = u128> {
    (1..=max_bits).prop_flat_map(|bits| (1u128 << (bits - 1))..=(u128::MAX >> (128 - bits)))
}

/// An amount up to `max`, half linear (large) and half log-uniform (everyday sizes).
fn amount(max: u64) -> impl Strategy<Value = u64> {
    let bits = 64 - max.leading_zeros();
    prop_oneof![1..=max, log_uniform_u64(bits).prop_map(move |a| a.min(max))]
}

/// Half linear in the price's square root (mostly near the top), half at a tick (every price
/// range alike), so the rounding the program caps (a unit or more) is reached.
fn sqrt_price() -> impl Strategy<Value = u128> {
    prop_oneof![
        MIN_SQRT_PRICE_X64..MAX_SQRT_PRICE_X64,
        (MIN_TICK..MAX_TICK).prop_map(|t| get_sqrt_price_at_tick(t).unwrap()),
    ]
}

/// Each kind drawn directly, with the amount bounds upstream's test put on it.
fn step() -> impl Strategy<Value = (u128, u128, u128, u64, u32, bool, bool)> {
    // Upstream's liquidity range, and deep pools up to 2^80 as its equivalence test samples.
    let liquidity = prop_oneof![1..u128::from(u32::MAX), log_uniform_u128(80)];
    // Half at the fees this program can charge, half over upstream's whole range.
    let fee_rate = prop_oneof![
        1..=MAX_FEE_RATE_NUMERATOR,
        1..(FEE_RATE_DENOMINATOR_VALUE - 1000)
    ];
    let kinds = prop_oneof![
        (amount(u64::MAX - 1), Just(true), Just(true)),
        (amount(u64::MAX - 1), Just(true), Just(false)),
        (amount(1_000_000_000), Just(false), Just(true)),
        (
            amount(u64::MAX / u64::from(FEE_RATE_DENOMINATOR_VALUE)),
            Just(false),
            Just(false)
        ),
    ];
    (sqrt_price(), sqrt_price(), liquidity, fee_rate, kinds)
        .prop_filter("a step moves the price", |(c, t, ..)| c != t)
        .prop_map(|(c, t, l, f, (a, base_in, fee_in))| (c, t, l, a, f, base_in, fee_in))
}

#[test]
fn compute_swap_keeps_its_rule_in_every_swap_kind() {
    const CASES: u32 = 65_536;
    let seen: [[AtomicU32; 3]; 4] = Default::default();
    let mut runner = TestRunner::new(Config {
        cases: CASES,
        ..Config::default()
    });
    runner
        .run(&step(), |(c, t, l, a, f, base_in, fee_in)| {
            let step = rule(c, t, l, a, f, base_in, fee_in).map_err(TestCaseError::fail)?;
            seen[usize::from(base_in) * 2 + usize::from(fee_in)][step as usize]
                .fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
        .unwrap();
    // Not met by refusing: every kind takes both branches often, and refusals stay rare.
    let n = |k: usize, s: Step| seen[k][s as usize].load(Ordering::Relaxed);
    let refused: u32 = (0..4).map(|k| n(k, Step::Refused)).sum();
    for k in 0..4 {
        assert!(
            n(k, Step::Short) >= 1000 && n(k, Step::Reached) >= 1000,
            "kind {k}: {seen:?}"
        );
    }
    assert!(refused <= CASES / 5, "{refused} refused: {seen:?}");
}

/// The input CI shrank upstream's test to (exact output, fee on output): the user asks for 1 and
/// gets 1, and 1 is booked as fee. Upstream's sum is 2; the rule above holds.
#[test]
fn upstream_rule_fails_where_this_one_holds() {
    let (c, t, l) = (23811435498481713585993821230u128, 4295048016u128, 11004u128);
    let s = compute_swap(c, t, l, 1, 1, false, true, false).unwrap();
    assert_ne!(
        s.sqrt_price_next_x64, t,
        "the step stops short of its target"
    );
    assert_eq!(
        (s.amount_out, s.fee_amount),
        (1, 1),
        "the user gets 1 and the fee is 1"
    );
    assert_ne!(s.amount_out + s.fee_amount, 1, "upstream's rule fails here");
    assert_eq!(rule(c, t, l, 1, 1, false, false), Ok(Step::Short));
}
