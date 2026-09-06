//! bayla-ladder math — pure, dependency-free, and proven on the host.
//!
//! ```text
//! rustc --edition 2021 --test src/math.rs -o /tmp/ladder_math && /tmp/ladder_math
//! ```
//!
//! This file knows nothing about Anchor or Solana, on purpose: SBF builds cannot run
//! on the Windows dev box (Application Control blocks `anchor` and `cargo build-sbf`
//! — see tegridy-launch's header), so the money math is kept where it CAN be proven,
//! and the Anchor layer in `lib.rs` is a thin caller that CI compiles. Do not add a
//! dependency here; it would take the tests with it.
//!
//! # What this is a port of
//!
//! `contracts/src/LighthouseLadder.sol` — the venue's reviewed EVM lighthouse, itself
//! a two-expression fork of the canonical Synthetix `StakingRewards`. The reward
//! engine is Synthetix's; the ladder is the same linear 0.40x→4.00x over 7d→4y that
//! TOWELI runs. Where this file DIFFERS from the Solidity, it says so and why.
//!
//! # The two lessons this file exists to encode
//!
//! 1. **A cumulative per-position counter that narrows to a fixed width WILL brick
//!    positions at scale.** Streamflow's classic reward program keeps
//!    `accountedAmount` as a lifetime u128 and narrows it to u64 on the claim path;
//!    past u64::MAX the claim reverts forever. 5,859 of 13,809 live entries (42.4%)
//!    were past it on 2026-09-06, including two on the venue's own pool. Here every
//!    cumulative quantity is u128, every operation saturates, and narrowing happens
//!    exactly ONCE — in [`payable`], at the transfer, bounded by what the vault holds.
//!
//! 2. **Rewards must never be paid out of principal.** The venue's last custom
//!    staking contract failed an audit on exactly this: an accumulator whose
//!    liability outran its backing (`docs/RESTAKING_BONUS_INSOLVENCY_2026_08_27.md`).
//!    The Solidity's answer is a surplus cap; with two vaults the same theorem is
//!    [`fundable`] + [`payable`] + [`emission_within_funding`], and the tests here
//!    assert it as arithmetic rather than as intent.
//!
//! # Precision
//!
//! `PRECISION = 1e12`, derived rather than inherited from the Solidity's 1e18.
//! Bounds, for a 6-decimal mint with a 9.92e14-raw supply (BAYLA):
//!
//! ```text
//! total_weighted        <= supply x 4.0      = 3.97e15
//! dt x rate x PRECISION <= 1e8 x 1.3e8 x 1e12 = 1.3e28   (u128 max 3.4e38)
//! weight x (rpw - paid) <= total_weighted x (rpw - paid) = emitted x PRECISION
//!                       <= 9.92e14 x 1e12    = 9.92e26
//! ```
//!
//! The last line holds ONLY because the caller checks `weight <= total_weighted`
//! before the multiply (invariant I-9 in `lib.rs`). At 1e18 the same product sits at
//! ~1e33 and overflows in the desynchronised case; that is why 1e18 was rejected.

/// Basis-points denominator.
pub const BPS: u64 = 10_000;

/// TOWELI PARITY — the same ladder `LighthouseLadder.sol` and `TegridyStaking` run:
/// seven days at the floor, four years at the top, 0.40x→4.00x, linear. A holder who
/// knows the TOWELI farm meets exactly this ladder here.
pub const MIN_LOCK_SECS: i64 = 7 * 86_400;
pub const MAX_LOCK_SECS: i64 = 4 * 365 * 86_400;
pub const MIN_BOOST_BPS: u64 = 4_000;
pub const MAX_BOOST_BPS: u64 = 40_000;

/// Flat, any-time, compile-time. There is deliberately NO setter and NO decay: a
/// penalty that decays to zero at maturity (kfarms) is not the product, and a penalty
/// an admin can retune is a surface an attacker who steals the key would want.
pub const EARLY_EXIT_PENALTY_BPS: u64 = 2_500;

/// Owner decision 2026-09-06: rewards are RELOADED every 90 days and DISTRIBUTED per
/// second. `notify_reward` sets a per-second rate over this window; a reload mid-window
/// folds the unspent remainder in, exactly as Synthetix does.
pub const REWARDS_DURATION_SECS: i64 = 90 * 86_400;

/// Fixed-point scale for the rewards-per-weight accumulator. See the module docs for
/// why 1e12 and not 1e18.
pub const PRECISION: u128 = 1_000_000_000_000;

/// Hard floor under the pool's configured `min_stake`, in raw base units.
///
/// THE DUST DIVISOR. `weight = amount x 4_000 / 10_000`, so THREE base units is the
/// smallest stake with non-zero weight. `total_weighted` is the accumulator's DIVISOR,
/// so with a lone 3-unit position the whole emission accrues to it. The defence
/// (invariant I-11) is to burn any interval in which `total_weighted` sits below the
/// floor derived from `min_stake` — so `min_stake` must be large enough that the floor
/// is a meaningful divisor. 10,000 raw is 0.01 BAYLA at six decimals; the operator
/// sets the real value (100 BAYLA = 100_000_000) at init, and it can only be higher.
pub const HARD_MIN_STAKE_RAW: u64 = 10_000;

/// Positions per wallet per pool. Bounds the client's enumeration.
pub const MAX_POSITIONS: u8 = 20;

/// A deposit-cap raise takes effect this long after it is proposed. The cap can only
/// ever go UP, so the timelock exists purely to make a raise visible before it lands.
pub const CAP_TIMELOCK_SECS: i64 = 48 * 3_600;

/* ───────────────────────────── the ladder ───────────────────────────── */

/// Boost in bps for a lock of `lock_secs`. Line for line the interpolation
/// `LighthouseLadder.boostFor` and `TegridyStaking.calculateBoost` use.
pub fn boost_bps(lock_secs: i64) -> u64 {
    if lock_secs <= MIN_LOCK_SECS {
        return MIN_BOOST_BPS;
    }
    if lock_secs >= MAX_LOCK_SECS {
        return MAX_BOOST_BPS;
    }
    let range = (MAX_LOCK_SECS - MIN_LOCK_SECS) as u128;
    let boost_range = (MAX_BOOST_BPS - MIN_BOOST_BPS) as u128;
    let elapsed = (lock_secs - MIN_LOCK_SECS) as u128;
    (MIN_BOOST_BPS as u128 + elapsed * boost_range / range) as u64
}

/// Weight of a position: `amount x boost / BPS`. Always computed from what ARRIVED
/// (invariant I-10), never from what was asked for.
pub fn weight_for(amount: u64, lock_secs: i64) -> u128 {
    (amount as u128) * (boost_bps(lock_secs) as u128) / (BPS as u128)
}

/// The divisor floor (I-11): the weight of the smallest admissible stake at the
/// smallest boost. Derived, never stored twice.
pub fn min_weight_floor(min_stake: u64) -> u128 {
    (min_stake as u128) * (MIN_BOOST_BPS as u128) / (BPS as u128)
}

/* ────────────────────────── the reward engine ───────────────────────── */

/// `min(now, period_finish)` — accrual stops at the end of the funded window.
pub fn last_time_applicable(now: i64, period_finish: i64) -> i64 {
    if now < period_finish {
        now
    } else {
        period_finish
    }
}

/// Rewards-per-weight, Synthetix `rewardPerToken` with boosted weight as the divisor.
///
/// SATURATES (I-6): an overflow here must degrade into under-payment, never into a
/// revert — a revert on the accrual path is the Streamflow failure, and it would
/// take the principal exit with it. BURNS the interval (I-11) when `total_weighted`
/// is below `floor`: a desynchronised ledger that leaves a dust residue must err
/// toward surplus, not pay that residue the whole pool's emission. `dt` is clamped
/// at zero (I-15): `unix_timestamp` is validator-reported and not monotone.
pub fn reward_per_weight(
    stored: u128,
    last_update: i64,
    applicable: i64,
    rate: u128,
    total_weighted: u128,
    floor: u128,
) -> u128 {
    if total_weighted == 0 || total_weighted < floor {
        return stored;
    }
    let dt = applicable.saturating_sub(last_update).max(0) as u128;
    let add = dt.saturating_mul(rate).saturating_mul(PRECISION) / total_weighted;
    stored.saturating_add(add)
}

/// What one checkpoint EMITTED to the whole pool: `(rpw_now - rpw_stored) x
/// total_weighted / PRECISION`. Banked into `rewards_emitted` BEFORE the checkpoint
/// moves (AUDIT C2), using the weight in force across the window just closed.
pub fn emitted_delta(rpw_now: u128, rpw_stored: u128, total_weighted: u128) -> u128 {
    rpw_now
        .saturating_sub(rpw_stored)
        .saturating_mul(total_weighted)
        / PRECISION
}

/// A position's owed rewards: Synthetix `earned` with boosted weight as the
/// multiplier, plus what it was already owed. The caller MUST have checked
/// `weight <= total_weighted` (I-9) — that is what makes the product bounded.
pub fn earned(weight: u128, rpw_now: u128, rpw_paid: u128, already_owed: u128) -> u128 {
    let fresh = weight.saturating_mul(rpw_now.saturating_sub(rpw_paid)) / PRECISION;
    fresh.saturating_add(already_owed)
}

/// Invariant I-2, and THE ONE NARROWING in the program. Pay what the vault can cover;
/// the remainder STAYS OWED — never zeroed, never a revert. A revert here is exactly
/// Streamflow 6012/6013, the bug the venue routes around in production today.
pub fn payable(owed: u128, reward_vault: u64) -> (u64, u128) {
    let pay = if owed < reward_vault as u128 {
        owed as u64
    } else {
        reward_vault
    };
    (pay, owed - pay as u128)
}

/// The 25% early-exit penalty, exact. Rounds DOWN, so the leaver never pays a base
/// unit more than 25% and the pool never claims one it was not owed.
pub fn penalty_for(amount: u64) -> u64 {
    ((amount as u128) * (EARLY_EXIT_PENALTY_BPS as u128) / (BPS as u128)) as u64
}

/// Synthetix `notifyRewardAmount` rate: a reload after the window ends starts fresh;
/// a reload inside it folds the unspent remainder into the new window.
pub fn new_reward_rate(amount: u64, now: i64, period_finish: i64, old_rate: u128) -> u128 {
    let dur = REWARDS_DURATION_SECS as u128;
    if now >= period_finish {
        amount as u128 / dur
    } else {
        let remaining = (period_finish - now) as u128;
        let leftover = remaining.saturating_mul(old_rate);
        (amount as u128).saturating_add(leftover) / dur
    }
}

/// Invariant I-3 (AUDIT C2): what a NEW period may actually draw on — the vault after
/// reserving everything already emitted and not yet paid. Without this, rewards
/// accrued-but-unclaimed sit physically in the vault and get offered to a second
/// period: the same tokens pledged twice.
pub fn fundable(reward_vault: u64, emitted: u128, paid: u128) -> u128 {
    (reward_vault as u128).saturating_sub(emitted.saturating_sub(paid))
}

/// Invariant I-4, asserted on EVERY accrual: the pool has never emitted more than it
/// was funded plus what leavers left behind. This is the bound `TegridyRestaking`
/// never had — its liability outran its backing 4x in four windows with no attacker.
pub fn emission_within_funding(emitted: u128, funded: u128, penalties: u128) -> bool {
    emitted <= funded.saturating_add(penalties)
}

/* ───────────────────────────────── tests ───────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;
    const U64_MAX: u128 = u64::MAX as u128;

    // ── the ladder ────────────────────────────────────────────────────────

    #[test]
    fn ladder_endpoints_are_toweli() {
        assert_eq!(boost_bps(7 * DAY), 4_000);
        assert_eq!(boost_bps(4 * 365 * DAY), 40_000);
        // clamped, never extrapolated
        assert_eq!(boost_bps(0), 4_000);
        assert_eq!(boost_bps(10 * 365 * DAY), 40_000);
    }

    #[test]
    fn ladder_is_linear_and_monotone() {
        // midpoint of the range lands at the midpoint of the boost
        let mid = MIN_LOCK_SECS + (MAX_LOCK_SECS - MIN_LOCK_SECS) / 2;
        assert_eq!(boost_bps(mid), 22_000);
        let mut last = 0;
        for d in 7..=(4 * 365) {
            let b = boost_bps(d * DAY);
            assert!(b >= last, "boost fell at day {d}");
            last = b;
        }
    }

    #[test]
    fn weight_is_amount_times_boost() {
        // 1,000,000 BAYLA at six decimals, four-year lock: x4.0
        assert_eq!(
            weight_for(1_000_000_000_000, 4 * 365 * DAY),
            4_000_000_000_000
        );
        // seven-day lock: x0.4
        assert_eq!(weight_for(1_000_000_000_000, 7 * DAY), 400_000_000_000);
    }

    #[test]
    fn three_base_units_is_the_smallest_non_zero_weight() {
        // the dust analysis behind HARD_MIN_STAKE_RAW
        assert_eq!(weight_for(1, 7 * DAY), 0);
        assert_eq!(weight_for(2, 7 * DAY), 0);
        assert_eq!(weight_for(3, 7 * DAY), 1);
        assert_eq!(min_weight_floor(HARD_MIN_STAKE_RAW), 4_000);
    }

    // ── the engine ────────────────────────────────────────────────────────

    #[test]
    fn accrual_stops_at_period_finish() {
        assert_eq!(last_time_applicable(100, 200), 100);
        assert_eq!(last_time_applicable(300, 200), 200);
    }

    #[test]
    fn reward_per_weight_matches_synthetix_by_hand() {
        // rate 1e6/sec, 1000 s, total weight 2e9 -> add = 1e6*1e3*1e12/2e9 = 5e11
        let rpw = reward_per_weight(0, 0, 1_000, 1_000_000, 2_000_000_000, 4_000);
        assert_eq!(rpw, 500_000_000_000);
    }

    #[test]
    fn a_dust_divisor_burns_the_interval_instead_of_paying_it_everything() {
        // I-11: total weight below the floor -> accumulator does not move
        let stored = 123;
        assert_eq!(
            reward_per_weight(stored, 0, 1_000, 1_000_000, 3_999, 4_000),
            stored
        );
        assert_eq!(
            reward_per_weight(stored, 0, 1_000, 1_000_000, 0, 4_000),
            stored
        );
        // at the floor it pays normally
        assert!(reward_per_weight(stored, 0, 1_000, 1_000_000, 4_000, 4_000) > stored);
    }

    #[test]
    fn a_clock_that_goes_backwards_accrues_nothing_and_does_not_panic() {
        // I-15
        let stored = 7;
        assert_eq!(
            reward_per_weight(stored, 1_000, 900, 1_000_000, 1_000_000, 4_000),
            stored
        );
    }

    #[test]
    fn earned_is_weight_times_delta_plus_owed() {
        // weight 4e12, delta 5e11 -> 4e12*5e11/1e12 = 2e12, plus 5 owed
        assert_eq!(
            earned(4_000_000_000_000, 500_000_000_000, 0, 5),
            2_000_000_000_005
        );
        // no delta -> just what was owed
        assert_eq!(earned(4_000_000_000_000, 9, 9, 42), 42);
    }

    #[test]
    fn emitted_delta_is_the_pool_wide_mirror_of_earned() {
        // C2: what the pool emitted equals the sum of what every unit of weight earned
        let delta = emitted_delta(500_000_000_000, 0, 4_000_000_000_000);
        assert_eq!(delta, earned(4_000_000_000_000, 500_000_000_000, 0, 0));
    }

    // ── the two lessons ───────────────────────────────────────────────────

    #[test]
    fn a_position_149x_past_u64_max_still_computes() {
        // THE STREAMFLOW LESSON. Their counter narrowed to u64 and bricked forever;
        // ours stays u128 and narrows only at the transfer. Feed the engine an
        // accumulator 149x past u64::MAX — the worst live dynamic entry observed on
        // mainnet — and every step must produce a number, not a panic.
        let rpw = U64_MAX * 149;
        let owed = earned(4_000_000_000_000, rpw, 0, 0);
        assert!(owed > 0);
        let (pay, rest) = payable(owed, 884_896_033_589);
        assert_eq!(pay, 884_896_033_589);
        assert_eq!(rest, owed - 884_896_033_589);
        // and the emitted mirror does not overflow either
        let _ = emitted_delta(rpw, 0, 4_000_000_000_000);
    }

    #[test]
    fn saturation_never_wraps() {
        // I-5/I-6: pathological inputs degrade, they do not wrap to a small number
        let r = reward_per_weight(u128::MAX - 1, 0, i64::MAX, u128::MAX, 1, 0);
        assert_eq!(r, u128::MAX);
        let e = earned(u128::MAX, u128::MAX, 0, u128::MAX);
        assert_eq!(e, u128::MAX);
        // MUTATION-FOUND (2026-09-06): the assertion above is satisfied by a WRAPPING
        // multiply too — MAX x MAX wraps to 1, 1/PRECISION is 0, and the final add
        // saturates to MAX either way. These two are the cases that actually differ:
        //
        // a bare overflow with nothing owed must saturate to a LARGE number, not wrap
        // to zero (wrapping: MAX*MAX = 1, /1e12 = 0)
        assert_eq!(earned(u128::MAX, u128::MAX, 0, 0), u128::MAX / PRECISION);
        // a paid-marker AHEAD of the accumulator (ledger desync) must earn zero, not a
        // wrapped-negative fortune (wrapping: 5 - 10 = 2^128 - 5)
        assert_eq!(earned(1_000, 5, 10, 0), 0);
    }

    #[test]
    fn payable_defers_and_never_forfeits() {
        // I-2: the vault is short -> pay what it has, the rest STAYS owed
        let (pay, rest) = payable(1_000, 400);
        assert_eq!((pay, rest), (400, 600));
        // fully covered
        let (pay, rest) = payable(1_000, 5_000);
        assert_eq!((pay, rest), (1_000, 0));
        // empty vault -> nothing moves, nothing lost
        let (pay, rest) = payable(1_000, 0);
        assert_eq!((pay, rest), (0, 1_000));
        // and the narrowing is bounded by the vault, so it cannot overflow u64
        let (pay, _) = payable(u128::MAX, u64::MAX);
        assert_eq!(pay, u64::MAX);
    }

    #[test]
    fn penalty_is_exactly_a_quarter_rounded_down() {
        assert_eq!(penalty_for(1_000_000_000_000), 250_000_000_000);
        assert_eq!(penalty_for(3), 0); // rounds down: the leaver is never over-charged
        assert_eq!(penalty_for(4), 1);
        assert_eq!(penalty_for(u64::MAX), u64::MAX / 4);
    }

    #[test]
    fn reload_after_the_window_starts_fresh() {
        let rate = new_reward_rate(7_776_000_000, 1_000, 500, 999);
        assert_eq!(rate, 1_000); // 7.776e9 over 90 days = 1000/sec, old rate ignored
    }

    #[test]
    fn reload_inside_the_window_folds_the_remainder_in() {
        // 1000/sec with 1000 s left = 1e6 leftover; add 7.775e9 -> (7.775e9+1e6)/7.776e6
        let rate = new_reward_rate(7_775_000_000, 0, 1_000, 1_000);
        assert_eq!(rate, (7_775_000_000u128 + 1_000_000) / 7_776_000);
    }

    #[test]
    fn fundable_reserves_what_is_already_owed() {
        // C2: 10,000 in the vault, 3,000 emitted of which 1,000 paid -> 2,000 owed -> 8,000 fundable
        assert_eq!(fundable(10_000, 3_000, 1_000), 8_000);
        // owed exceeds the vault -> nothing is fundable, and it does not go negative
        assert_eq!(fundable(1_000, 3_000, 0), 0);
    }

    #[test]
    fn the_prior_audit_failure_is_a_false_return_not_a_silent_pass() {
        // I-4: emitting more than funded + penalties must be REFUSED. This is the
        // TegridyRestaking bug as a boolean.
        assert!(emission_within_funding(100, 60, 40));
        assert!(!emission_within_funding(101, 60, 40));
        assert!(emission_within_funding(0, 0, 0));
    }

    #[test]
    fn a_full_window_emits_at_most_what_was_funded() {
        // Rate is integer-divided, so a whole window pays <= amount: the pool
        // rounds in its own favour, never the staker's.
        let amount = 7_776_000_123u64;
        let rate = new_reward_rate(amount, 0, 0, 0);
        assert!(rate * (REWARDS_DURATION_SECS as u128) <= amount as u128);
    }
}
