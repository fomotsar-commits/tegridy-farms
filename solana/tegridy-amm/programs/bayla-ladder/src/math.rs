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
//!    [`fundable`] + [`payable`] plus the caller's solvency check, and the tests here
//!    assert it as arithmetic rather than as intent.
//!
//!    CORRECTED 2026-09-06 (audit L-3). This used to name [`emission_within_funding`]
//!    as the third leg. It is NOT the enforced bound — it has zero call sites. What
//!    the program actually enforces is stronger and lives in `notify_reward`:
//!    `rewards_emitted - rewards_paid <= reward_vault.amount`, i.e. every token of
//!    outstanding liability must be PHYSICALLY PRESENT, checked at the only
//!    instruction that can create emission capacity. `emission_within_funding` is
//!    retained as a monitoring predicate for off-chain use, and is labelled as such.
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
    reward_per_weight_with_residue(
        stored,
        0,
        last_update,
        applicable,
        rate,
        total_weighted,
        floor,
    )
    .0
}

/// The same accumulator step, CARRYING THE TRUNCATION REMAINDER (audit M-2).
///
/// `add = dt x rate x PRECISION / total_weighted` floors on every interval, and
/// `checkpoint` advances `last_update_time` whether or not `add` came out non-zero.
/// Checkpoint cadence therefore decides the loss, and cadence is not the operator's to
/// control — `claim` is a cheap poke and organic traffic drives it as readily as an
/// attacker. Measured pre-fix at one checkpoint per second: **7.43% of a 100k BAYLA
/// window destroyed** at full participation, with a *total* silent burn below
/// `rate < total_weighted / PRECISION`, where a successful `RewardAdded` fires and the
/// pool emits exactly nothing.
///
/// Carrying `num % total_weighted` into the next interval bounds the lifetime loss at
/// one sub-unit rather than one per interval.
///
/// THE RESIDUE IS DROPPED, NOT BANKED, when the interval is burned. I-11 burns the
/// dust-divisor and empty-pool windows deliberately; banking their remainder would leak
/// it to whoever staked next, which is the attack I-11 exists to prevent. Hence
/// `(stored, 0)` on both branches rather than `(stored, residue)`.
///
/// Rejected alternative, recorded so it is not re-proposed: do NOT instead skip
/// advancing `last_update_time` when `add == 0`. From `checkpoint`'s vantage a burned
/// interval and a truncated-to-zero interval are indistinguishable, so that guard would
/// bank the burned ones too.
pub fn reward_per_weight_with_residue(
    stored: u128,
    residue: u128,
    last_update: i64,
    applicable: i64,
    rate: u128,
    total_weighted: u128,
    floor: u128,
) -> (u128, u128) {
    if total_weighted == 0 || total_weighted < floor {
        return (stored, 0);
    }
    let dt = applicable.saturating_sub(last_update).max(0) as u128;
    let num = residue.saturating_add(dt.saturating_mul(rate).saturating_mul(PRECISION));
    (
        stored.saturating_add(num / total_weighted),
        num % total_weighted,
    )
}

/// What one checkpoint EMITTED to the whole pool: `(rpw_now - rpw_stored) x
/// total_weighted / PRECISION`. Banked into `rewards_emitted` BEFORE the checkpoint
/// moves (AUDIT C2), using the weight in force across the window just closed.
pub fn emitted_delta(rpw_now: u128, rpw_stored: u128, total_weighted: u128) -> u128 {
    emitted_delta_with_residue(rpw_now, rpw_stored, total_weighted, 0).0
}

/// The same pool-side bank, CARRYING ITS OWN TRUNCATION REMAINDER (audit L-4).
///
/// A second, independent floor from [`reward_per_weight_with_residue`]'s: this one
/// divides by `PRECISION`, and it runs once per CHECKPOINT while a position's
/// [`earned`] floors once over its WHOLE accrual span. Sum-of-floors <= floor-of-sum,
/// so `rewards_emitted` under-counts the liability it is supposed to reserve — and
/// once `rewards_paid` crosses it, `outstanding` saturates to zero and the solvency
/// guard in `notify_reward` passes vacuously. Bounded at one raw unit per second of
/// pool life (a same-second second checkpoint has `dt = 0`, so it is not
/// attacker-amplifiable), which is ~7.78 BAYLA per 90-day window.
///
/// Do NOT `div_ceil` this instead: that creates a permanent over-reserve which
/// `rewards_paid` can never retire, ratcheting `outstanding` upward until the guard
/// bricks `notify_reward` forever.
pub fn emitted_delta_with_residue(
    rpw_now: u128,
    rpw_stored: u128,
    total_weighted: u128,
    residue: u128,
) -> (u128, u128) {
    let num = residue.saturating_add(
        rpw_now
            .saturating_sub(rpw_stored)
            .saturating_mul(total_weighted),
    );
    (num / PRECISION, num % PRECISION)
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

/// What a new window is allowed to SCHEDULE: freshly transferred tokens plus tokens
/// already sitting in the reward vault and not yet pledged.
///
/// AUDIT H-1 (2026-09-06) — this function is the fix, and it exists because the port
/// silently dropped a capability the reference has. `LighthouseLadder.notifyRewardAmount`
/// performs NO token transfer: it schedules against the balance already held, bounded by
/// `fundableBudget()`. The port fused the transfer into the instruction so
/// `reward_funded_cumulative` would be exact, and in doing so made the rate a pure
/// function of the freshly-transferred `amount`. Consequence: lifetime emission could
/// never exceed the sum of `notify_reward` amounts, so the retained 25% penalty, every
/// swept emergency-hatch penalty, every un-emitted second of a lapsed window and any
/// stranger's donation were **permanently unspendable by any key in the system** —
/// there is no `recover_tokens` and no `close_pool`, deliberately. One early exit of
/// 1,000,000 BAYLA stranded 250,000, and `sweep_orphaned_penalty` was an economic no-op.
///
/// The solvency bound does not weaken: the caller still checks the resulting rate
/// against [`fundable`], which subtracts everything already owed from the real vault
/// balance. `from_budget` cannot conjure tokens — it can only point the schedule at
/// tokens that are physically present and unpledged.
pub fn scheduled_total(fresh: u64, from_budget: u64) -> u64 {
    fresh.saturating_add(from_budget)
}

/// Invariant I-3 (AUDIT C2): what a NEW period may actually draw on — the vault after
/// reserving everything already emitted and not yet paid. Without this, rewards
/// accrued-but-unclaimed sit physically in the vault and get offered to a second
/// period: the same tokens pledged twice.
pub fn fundable(reward_vault: u64, emitted: u128, paid: u128) -> u128 {
    (reward_vault as u128).saturating_sub(emitted.saturating_sub(paid))
}

/// MONITORING PREDICATE — not an on-chain invariant. **This function has no call
/// sites in the program**, and its docstring used to claim it was "asserted on EVERY
/// accrual" (audit L-3). It was not, and it should not be: `checkpoint` runs inside
/// `emergency_withdraw`, so a `require!` there would put a reward-accounting
/// condition in front of the unconditional principal hatch — which is Streamflow
/// 6012, the exact failure this program exists to eliminate.
///
/// The enforced bound is in `notify_reward`: outstanding liability must be
/// physically present in the vault. That is strictly stronger than this comparison,
/// because it is anchored to a real balance rather than to two counters.
///
/// Kept because it is the only way an off-chain monitor can separate authority
/// funding from penalty inflow — `reward_funded_cumulative` and
/// `penalty_collected_cumulative` exist for exactly that, and are deliberately
/// write-only on-chain.
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
    fn per_second_checkpoints_do_not_shred_the_emission() {
        // AUDIT M-2. `add = dt*rate*PRECISION / total_weighted` floors EVERY interval,
        // and `checkpoint` advances `last_update_time` whether or not `add` was zero.
        // `claim` is a cheap poke, so cadence is not the operator's to control. Pre-fix
        // this destroyed 7.43% of a 100k BAYLA window at full participation; the
        // residue carry must bring it to ~0.
        let tw: u128 = 3_970_000_000_000_000; // full BAYLA supply at 4.00x
        let budget: u128 = 100_000_000_000; // 100k BAYLA at 6dp
        let rate = budget / (REWARDS_DURATION_SECS as u128);

        let (mut rpw, mut res) = (0u128, 0u128);
        for t in 0..20_000i64 {
            let (r2, e2) = reward_per_weight_with_residue(rpw, res, t, t + 1, rate, tw, 4_000);
            rpw = r2;
            res = e2;
        }
        let emitted = emitted_delta(rpw, 0, tw);
        let ideal = rate * 20_000;
        assert!(
            emitted * 1000 >= ideal * 999,
            "per-second checkpointing shredded the emission: {emitted} vs ideal {ideal}"
        );
    }

    #[test]
    fn the_pool_side_bank_does_not_under_count_the_liability() {
        // AUDIT L-4. `rewards_emitted` is the reserve `notify_reward` subtracts before
        // it will schedule anything. If it under-counts, the solvency guard eventually
        // passes vacuously. Pool-side banks once per checkpoint; a position's `earned`
        // floors once over its whole span — so without a residue the pool under-counts
        // by up to one unit per checkpoint.
        // PARAMETERS MATTER HERE, and my first attempt got them wrong: with
        // `tw = 4e12` both divisions come out exact, the truncation never happens, and
        // the test passed with the fix REMOVED. Picked deliberately so neither
        // `rate*PRECISION / tw` nor `dRpw*tw / PRECISION` divides evenly — ~250M tokens
        // staked at 4.00x on a 6-decimal mint, which is a realistic pool, not a corner.
        let tw: u128 = 999_999_999_999_983;
        let rate: u128 = 12_860;
        let (mut rpw, mut rres) = (0u128, 0u128);
        let (mut emitted, mut eres) = (0u128, 0u128);
        for t in 0..5_000i64 {
            let (r2, rr) = reward_per_weight_with_residue(rpw, rres, t, t + 1, rate, tw, 4_000);
            let (d, er) = emitted_delta_with_residue(r2, rpw, tw, eres);
            emitted += d;
            eres = er;
            rpw = r2;
            rres = rr;
        }
        // one position holding the entire weight: what it can claim must be covered
        let owed = earned(tw, rpw, 0, 0);
        assert!(
            emitted >= owed,
            "pool banked {emitted} but a position can claim {owed} — the reserve under-counts"
        );
    }

    #[test]
    fn the_residue_is_dropped_across_a_burned_or_empty_interval() {
        // The carry must NOT leak a burned interval back in later: I-11 burns the
        // dust-divisor and empty-pool windows on purpose, and banking their remainder
        // would pay it to whoever arrives next — the attack I-11 exists to prevent.
        let (rpw, res) =
            reward_per_weight_with_residue(100, 12_345, 0, 1_000, 1_000_000, 3_999, 4_000);
        assert_eq!(rpw, 100, "a burned interval must not move the accumulator");
        assert_eq!(res, 0, "a burned interval must not bank a residue");
        let (rpw2, res2) =
            reward_per_weight_with_residue(100, 12_345, 0, 1_000, 1_000_000, 0, 4_000);
        assert_eq!(
            (rpw2, res2),
            (100, 0),
            "an empty pool must not bank a residue"
        );
    }

    #[test]
    fn a_retained_penalty_is_schedulable_with_no_fresh_capital() {
        // AUDIT H-1, and the test the 19 originals could not see because none of them
        // modelled the vault across a notify. Reproduces the report's scenario: one
        // early exit of 1,000,000 BAYLA retains 250,000 in the pool as reward budget.
        let penalty = penalty_for(1_000_000_000_000);
        assert_eq!(penalty, 250_000_000_000);

        // Nothing has been emitted or paid; the vault holds exactly the penalty.
        let vault = penalty;
        let budget = fundable(vault, 0, 0);
        assert_eq!(budget, penalty as u128);

        // THE FIX: with ZERO fresh capital the operator can still schedule it.
        let scheduled = scheduled_total(0, penalty);
        assert_eq!(scheduled, penalty);
        let rate = new_reward_rate(scheduled, 0, 0, 0);
        assert!(
            rate > 0,
            "a retained penalty must be schedulable with no fresh tokens"
        );

        // ...and it fits under the solvency ceiling the caller enforces, so the fix
        // opens a door without widening what the pool may promise.
        assert!(rate <= budget / (REWARDS_DURATION_SECS as u128));

        // The ceiling still bites — but NOT at one raw unit over, and the difference
        // matters. `rate = floor(scheduled / DURATION)`, so `rate * DURATION <=
        // scheduled` always: a single extra unit is absorbed by the truncation and the
        // pool rounds in its own favour. It takes a materially larger over-schedule to
        // breach the budget, which is exactly what the caller's require! catches.
        let one_over = new_reward_rate(scheduled_total(0, penalty + 1), 0, 0, 0);
        assert!(
            one_over * (REWARDS_DURATION_SECS as u128) <= budget,
            "truncation must absorb a one-unit overage rather than over-promise"
        );
        let way_over = new_reward_rate(scheduled_total(0, penalty * 2), 0, 0, 0);
        assert!(
            way_over * (REWARDS_DURATION_SECS as u128) > budget,
            "a genuine over-schedule must exceed the fundable budget and be refused"
        );
    }

    #[test]
    fn scheduling_never_conjures_tokens_the_vault_does_not_hold() {
        // `from_budget` may only point at what is physically present. The caller's
        // ceiling is what enforces that; this pins the arithmetic it relies on.
        let vault = 10_000u64;
        let budget = fundable(vault, 3_000, 1_000); // 2,000 owed -> 8,000 fundable
        assert_eq!(budget, 8_000);
        let honest = new_reward_rate(scheduled_total(0, 8_000), 0, 0, 0);
        assert!(honest * (REWARDS_DURATION_SECS as u128) <= budget);
        // saturating, so a hostile pair cannot wrap to a small number
        assert_eq!(scheduled_total(u64::MAX, u64::MAX), u64::MAX);
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
