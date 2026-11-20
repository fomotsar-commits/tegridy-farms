use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT;

pub const AMM_CONFIG_SEED: &str = "amm_config";

/// memetics.finance: a tier's trade and creator fees together are at most 4% of a swap.
pub const MAX_FEE_RATE_NUMERATOR: u64 = 40_000;

/// memetics.finance: a tier's protocol and fund rates together are at most 20% of its trade
/// fee. They are shares of the trade fee only; the creator fee is the creator's alone.
pub const MAX_PROTOCOL_AND_FUND_FEE_RATE: u64 = 200_000;

/// memetics.finance, 2026-11-15: a tier charges at most 1 SOL (in lamports) to open a pool.
pub const MAX_CREATE_POOL_FEE: u64 = 1_000_000_000;

/// Holds the current owner of the factory
#[account]
#[derive(Default, Debug)]
pub struct AmmConfig {
    /// Bump to identify PDA
    pub bump: u8,
    /// Status to control if new pool can be create
    pub disable_create_pool: bool,
    /// Config index
    pub index: u16,
    /// The trade fee, denominated in hundredths of a bip (10^-6)
    pub trade_fee_rate: u64,
    /// The protocol fee
    pub protocol_fee_rate: u64,
    /// The fund fee, denominated in hundredths of a bip (10^-6)
    pub fund_fee_rate: u64,
    /// Fee for create a new pool
    pub create_pool_fee: u64,
    /// Address of the protocol fee owner
    pub protocol_owner: Pubkey,
    /// Address of the fund fee owner
    pub fund_owner: Pubkey,
    /// The pool creator fee, denominated in hundredths of a bip (10^-6)
    pub creator_fee_rate: u64,
    /// memetics.finance: the swap guard. 0, a swap on this tier runs wherever it is called
    /// from, as upstream. 1, a swap must be an instruction of the transaction itself: one that
    /// another program calls is refused (`refuses_swap`). On 2026-11-10 every arbitrage bot in
    /// these pools traded from inside its own program, and every wallet's swap was direct.
    /// Taken from upstream's padding, which every tier holds as zeros: off until the admin sets it.
    pub swap_guard: u64,
    /// memetics.finance: the one signer whose swaps another program may still call while the
    /// guard is on, and who, since 2026-11-11, swaps on this tier free of the trade and creator
    /// fees (`swap_fee_rates`). The all-zero key, which every tier starts with, is nobody. Since
    /// 2026-11-14 only a wallet's key may be named, and the keeper may give the role up at once
    /// (`resign_keeper`).
    pub keeper: Pubkey,
    /// padding
    pub padding: [u64; 10],
}

impl AmmConfig {
    // The same 236 bytes as upstream: the guard and the keeper take 40 of its 120 of padding.
    pub const LEN: usize = 8 + 1 + 1 + 2 + 4 * 8 + 32 * 2 + 8 + 8 + 32 + 8 * 10;

    /// memetics.finance: whether this tier refuses a swap that `payer` signs at `stack_height`:
    /// 1 for an instruction of the transaction itself, more for one another program calls.
    pub fn refuses_swap(&self, stack_height: usize, payer: &Pubkey) -> bool {
        self.swap_guard != 0 && stack_height > TRANSACTION_LEVEL_STACK_HEIGHT && !self.is_keeper(payer)
    }

    /// memetics.finance: whether `payer` is this tier's keeper. With no keeper named (the
    /// all-zero key) nobody is, not even the all-zero key.
    pub fn is_keeper(&self, payer: &Pubkey) -> bool {
        self.keeper != Pubkey::default() && self.keeper == *payer
    }

    /// memetics.finance, 2026-11-11: the trade fee rate, the creator fee rate, and whether the
    /// creator fee is taken on the input, for a swap `payer` signs on a pool whose own creator
    /// fee rate is `pool_creator_fee_rate` and whose creator fee is on the input when
    /// `creator_fee_on_input`. Everyone pays the tier's trade fee and the pool's creator fee,
    /// as upstream, except the tier's keeper, who pays neither (and so no protocol or fund
    /// share, which are parts of the trade fee).
    ///
    /// The keeper's (zero) creator fee is taken on the output. Upstream's on-input path splits
    /// the fee by the sum of the two rates (curve/fees.rs split_creator_fee), so with both at 0
    /// it divides by 0 and every swap would fail, on every public pool (their creator fee is on
    /// both tokens, so on the input). On the output, a rate of 0 takes 0. No line of the fee
    /// arithmetic changes.
    pub fn swap_fee_rates(
        &self,
        payer: &Pubkey,
        pool_creator_fee_rate: u64,
        creator_fee_on_input: bool,
    ) -> (u64, u64, bool) {
        if self.is_keeper(payer) {
            (0, 0, false)
        } else {
            (self.trade_fee_rate, pool_creator_fee_rate, creator_fee_on_input)
        }
    }
}

/// memetics.finance, 2026-11-14: whether `keeper` may be named a tier's keeper: the all-zero
/// key, which names nobody, or a wallet's key, which is a point on the curve. A program's own
/// address (a PDA) is never a point, and naming one would let every caller that program lets
/// through swap free and pass the guard, since the program signs for it.
pub fn may_name_keeper(keeper: &Pubkey) -> bool {
    *keeper == Pubkey::default()
        || solana_curve25519::edwards::validate_edwards(&solana_curve25519::edwards::PodEdwardsPoint(
            keeper.to_bytes(),
        ))
}

/// memetics.finance, 2026-11-14: logged when the admin sets a tier's swap guard
/// (update_config.rs param 8).
#[event]
pub struct SwapGuardChanged {
    pub amm_config: Pubkey,
    pub swap_guard: u64,
}

/// memetics.finance, 2026-11-14: logged when a tier's keeper changes: named or cleared by the
/// admin (update_config.rs param 9), or given up by the keeper itself (lib.rs `resign_keeper`).
#[event]
pub struct KeeperChanged {
    pub amm_config: Pubkey,
    pub old_keeper: Pubkey,
    pub new_keeper: Pubkey,
    /// true when the keeper itself resigned, false when the admin set it
    pub resigned: bool,
}

/// memetics.finance, 2026-11-15: logged by lib.rs `sweep_fees` for one owner's share of a pool:
/// the fund owner's when `fund`, else the protocol owner's. In each token's base units, what
/// moved to the owner's own account.
#[event]
pub struct FeesSwept {
    pub pool_state: Pubkey,
    pub fund: bool,
    pub owner: Pubkey,
    pub token_0_amount: u64,
    pub token_1_amount: u64,
}

#[cfg(test)]
mod may_name_keeper_test {
    use super::*;

    // On chain the check is the runtime's curve syscall; here it is solana-curve25519's host
    // code. solana-pubkey's own `is_on_curve` (host only: it panics on chain, which is why the
    // program cannot use it) is an independent reading of the same rule, so the two must agree
    // on every key, wallets and non-wallets alike. tests/cp-swap-keeper-resign.test.ts names a
    // real wallet (a generated keypair) on a validator.
    #[test]
    fn it_agrees_with_solana_pubkey_on_a_thousand_keys_on_and_off_the_curve() {
        let (mut on, mut off) = (0, 0);
        for _ in 0..1000 {
            let k = Pubkey::new_unique();
            assert_eq!(may_name_keeper(&k), k.is_on_curve(), "{k}");
            if k.is_on_curve() { on += 1 } else { off += 1 }
        }
        assert!(on > 100 && off > 100, "both kinds were tried: {on} on, {off} off");
    }

    #[test]
    fn the_all_zero_key_may_be_named_it_names_nobody() {
        assert!(may_name_keeper(&Pubkey::default()));
    }

    #[test]
    fn a_program_address_may_not_be_named() {
        for seed in 0u8..64 {
            let (pda, _) = Pubkey::find_program_address(&[b"anything", &[seed]], &crate::id());
            assert!(!may_name_keeper(&pda), "{pda} is a program's address");
        }
        // This program's own signer, which owns every pool vault, above all.
        let (authority, _) = Pubkey::find_program_address(&[crate::AUTH_SEED.as_bytes()], &crate::id());
        assert!(!may_name_keeper(&authority));
        // And the admin itself on mainnet, the Squads vault, which is a Squads PDA.
        assert!(!may_name_keeper(&crate::admin::ID));
    }
}

#[cfg(test)]
mod swap_guard_test {
    use super::*;

    const DIRECT: usize = TRANSACTION_LEVEL_STACK_HEIGHT;
    const CALLED: usize = TRANSACTION_LEVEL_STACK_HEIGHT + 1;

    fn tier(swap_guard: u64, keeper: Pubkey) -> AmmConfig {
        AmmConfig {
            swap_guard,
            keeper,
            ..Default::default()
        }
    }

    // What every tier on mainnet holds until the admin sets it: zeros where the padding was.
    #[test]
    fn a_tier_as_upstream_left_it_refuses_nothing() {
        let t = AmmConfig::default();
        assert_eq!((t.swap_guard, t.keeper), (0, Pubkey::default()));
        let anyone = Pubkey::new_unique();
        assert!(!t.refuses_swap(DIRECT, &anyone));
        assert!(!t.refuses_swap(CALLED, &anyone));
        assert!(!t.refuses_swap(CALLED + 3, &anyone));
    }

    #[test]
    fn the_guard_takes_every_direct_swap_and_refuses_one_another_program_calls() {
        let t = tier(1, Pubkey::default());
        let anyone = Pubkey::new_unique();
        assert!(!t.refuses_swap(DIRECT, &anyone));
        assert!(t.refuses_swap(CALLED, &anyone));
        assert!(t.refuses_swap(CALLED + 3, &anyone));
    }

    #[test]
    fn with_no_keeper_set_nobody_is_let_through_not_even_the_all_zero_key() {
        let t = tier(1, Pubkey::default());
        assert!(t.refuses_swap(CALLED, &Pubkey::default()));
    }

    #[test]
    fn the_keeper_alone_may_be_called_by_another_program() {
        let keeper = Pubkey::new_unique();
        let t = tier(1, keeper);
        assert!(!t.refuses_swap(CALLED, &keeper));
        assert!(!t.refuses_swap(DIRECT, &keeper));
        assert!(t.refuses_swap(CALLED, &Pubkey::new_unique()));
    }

    // A keeper set while the guard is off changes nothing.
    #[test]
    fn the_guard_off_refuses_nothing_whatever_the_keeper() {
        let t = tier(0, Pubkey::new_unique());
        assert!(!t.refuses_swap(CALLED, &Pubkey::new_unique()));
    }

    #[test]
    fn the_account_is_the_size_upstream_made_it() {
        assert_eq!(AmmConfig::LEN, 236);
        let mut data = Vec::new();
        tier(1, Pubkey::new_unique()).try_serialize(&mut data).unwrap();
        assert_eq!(data.len(), AmmConfig::LEN);
        // The guard sits where the padding began (byte 116), the keeper right after it (124).
        assert_eq!(data[116..124], 1u64.to_le_bytes());
        assert!(data[156..].iter().all(|b| *b == 0));
    }
}

#[cfg(test)]
mod keeper_fee_test {
    use super::*;
    use crate::curve::CurveCalculator;

    // The 1% tier's shape (fee setting 1 on mainnet), and the launch tier's creator fee.
    fn tier(keeper: Pubkey) -> AmmConfig {
        AmmConfig {
            trade_fee_rate: 10_000,
            protocol_fee_rate: 104_000,
            fund_fee_rate: 56_000,
            creator_fee_rate: 5_000,
            keeper,
            ..Default::default()
        }
    }

    const X: u128 = 1_000_000_000_000;
    const Y: u128 = 2_000_000_000_000;

    #[test]
    fn with_no_keeper_named_everyone_pays_as_upstream_even_the_all_zero_key() {
        let t = tier(Pubkey::default());
        for who in [Pubkey::new_unique(), Pubkey::default()] {
            assert!(!t.is_keeper(&who));
            assert_eq!(t.swap_fee_rates(&who, 5_000, true), (10_000, 5_000, true));
            assert_eq!(t.swap_fee_rates(&who, 0, false), (10_000, 0, false));
        }
    }

    #[test]
    fn the_keeper_alone_pays_no_trade_fee_and_no_creator_fee() {
        let keeper = Pubkey::new_unique();
        let t = tier(keeper);
        assert!(t.is_keeper(&keeper));
        assert_eq!(t.swap_fee_rates(&keeper, 5_000, true), (0, 0, false));
        assert_eq!(t.swap_fee_rates(&keeper, 0, false), (0, 0, false));
        let anyone = Pubkey::new_unique();
        assert!(!t.is_keeper(&anyone));
        assert_eq!(t.swap_fee_rates(&anyone, 5_000, true), (10_000, 5_000, true));
    }

    // Why the keeper's creator fee is taken on the output: on the input, both rates at 0 make
    // upstream's split divide by 0, and the swap fails (the program answers ZeroTradingTokens).
    #[test]
    fn both_rates_at_0_on_the_input_fail_in_upstream_arithmetic_so_the_keeper_never_goes_there() {
        assert!(CurveCalculator::swap_base_input(1_000_000, X, Y, 0, 0, 104_000, 56_000, true).is_none());
        assert!(CurveCalculator::swap_base_output(1_000_000, X, Y, 0, 0, 104_000, 56_000, true).is_none());
    }

    #[test]
    fn a_keeper_swap_of_either_kind_moves_the_pool_along_its_curve_with_no_fee_at_all() {
        let keeper = Pubkey::new_unique();
        let t = tier(keeper);
        let (trade, creator, on_input) = t.swap_fee_rates(&keeper, t.creator_fee_rate, true);

        let r = CurveCalculator::swap_base_input(1_000_000_000, X, Y, trade, creator, t.protocol_fee_rate, t.fund_fee_rate, on_input).unwrap();
        assert_eq!((r.trade_fee, r.protocol_fee, r.fund_fee, r.creator_fee), (0, 0, 0, 0));
        assert_eq!(r.output_amount, 1_000_000_000 * Y / (X + 1_000_000_000));
        assert_eq!(r.new_input_vault_amount, X + 1_000_000_000);
        assert!(r.new_input_vault_amount * r.new_output_vault_amount >= X * Y);

        let r = CurveCalculator::swap_base_output(1_000_000_000, X, Y, trade, creator, t.protocol_fee_rate, t.fund_fee_rate, on_input).unwrap();
        assert_eq!((r.trade_fee, r.protocol_fee, r.fund_fee, r.creator_fee), (0, 0, 0, 0));
        assert_eq!(r.input_amount, (X * 1_000_000_000).div_ceil(Y - 1_000_000_000));
        assert_eq!(r.output_amount, 1_000_000_000);
        assert!(r.new_input_vault_amount * r.new_output_vault_amount >= X * Y);
    }

    // The control: the same swap by anyone else still pays the 1% fee and its shares.
    #[test]
    fn anyone_elses_swap_still_pays_the_tier_its_fee_and_its_shares() {
        let t = tier(Pubkey::new_unique());
        let (trade, creator, on_input) = t.swap_fee_rates(&Pubkey::new_unique(), 0, true);
        let r = CurveCalculator::swap_base_input(1_000_000_000, X, Y, trade, creator, t.protocol_fee_rate, t.fund_fee_rate, on_input).unwrap();
        assert_eq!((r.trade_fee, r.protocol_fee, r.fund_fee, r.creator_fee), (10_000_000, 1_040_000, 560_000, 0));
        assert!(r.output_amount < 1_000_000_000 * Y / (X + 1_000_000_000));
    }
}

#[cfg(test)]
mod live_tier_split_test {
    use crate::curve::CurveCalculator;

    // How each live tier (frontend/scripts/addresses.json, fee settings 0 and 1) splits a swap's
    // fee: the trader pays the trade fee, plus the creator fee on the launch tier; the protocol
    // (the venue) and the fund (the island) take their rates of the trade fee, rounded down; the
    // pool's LPs keep the rest of the trade fee. Returns (trade, protocol, fund, creator) fees.
    fn split(input: u128, trade: u64, creator: u64, protocol: u64, fund: u64) -> (u128, u128, u128, u128) {
        let r = CurveCalculator::swap_base_input(
            input,
            1_000_000_000_000,
            1_000_000_000_000,
            trade,
            creator,
            protocol,
            fund,
            true,
        )
        .unwrap();
        (r.trade_fee, r.protocol_fee, r.fund_fee, r.creator_fee)
    }

    #[test]
    fn the_1_percent_tier_sends_10_4_percent_of_its_fee_to_the_venue_and_5_6_to_the_island() {
        // 1,000 tokens in: 10 in fees; 1.04 to the venue, 0.56 to the island, 8.40 stays for LPs.
        assert_eq!(
            split(1_000_000_000, 10_000, 0, 104_000, 56_000),
            (10_000_000, 1_040_000, 560_000, 0)
        );
    }

    #[test]
    fn the_launch_tier_sends_13_and_7_percent_of_its_trade_fee_and_the_creator_keeps_the_creator_fee() {
        // 1,000 tokens in: 7.5 in fees, 5 of them the creator's. Of the 2.5 trade fee, 0.325 goes
        // to the venue (0.0325% of the swap) and 0.175 to the island.
        assert_eq!(
            split(1_000_000_000, 2_500, 5_000, 130_000, 70_000),
            (2_500_000, 325_000, 175_000, 5_000_000)
        );
    }

    #[test]
    fn the_venue_and_island_shares_round_down_and_the_lps_keep_the_dust() {
        // 99 units in on the 1% tier: a 1-unit fee (rounded up), and neither share reaches a unit.
        assert_eq!(split(99, 10_000, 0, 104_000, 56_000), (1, 0, 0, 0));
    }
}
