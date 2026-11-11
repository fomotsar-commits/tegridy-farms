use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT;

pub const AMM_CONFIG_SEED: &str = "amm_config";

/// memetics.finance: a tier's trade and creator fees together are at most 4% of a swap.
pub const MAX_FEE_RATE_NUMERATOR: u64 = 40_000;

/// memetics.finance: a tier's protocol and fund rates together are at most 20% of its trade
/// fee. They are shares of the trade fee only; the creator fee is the creator's alone.
pub const MAX_PROTOCOL_AND_FUND_FEE_RATE: u64 = 200_000;

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
    /// guard is on. The all-zero key, which every tier starts with, is nobody.
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
        self.swap_guard != 0
            && stack_height > TRANSACTION_LEVEL_STACK_HEIGHT
            && (self.keeper == Pubkey::default() || self.keeper != *payer)
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
