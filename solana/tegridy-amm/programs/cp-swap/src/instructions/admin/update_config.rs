use crate::curve::fees::FEE_RATE_DENOMINATOR_VALUE;
use crate::error::ErrorCode;
use crate::states::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateAmmConfig<'info> {
    /// The amm config owner or admin
    #[account(address = crate::admin::ID @ ErrorCode::InvalidOwner)]
    pub owner: Signer<'info>,

    /// Amm config account to be changed
    #[account(mut)]
    pub amm_config: Account<'info, AmmConfig>,
}

pub fn update_amm_config(ctx: Context<UpdateAmmConfig>, param: u8, value: u64) -> Result<()> {
    let amm_config = &mut ctx.accounts.amm_config;
    let match_param = Some(param);
    match match_param {
        Some(0) => update_trade_fee_rate(amm_config, value),
        Some(1) => update_protocol_fee_rate(amm_config, value),
        Some(2) => update_fund_fee_rate(amm_config, value),
        Some(3) => {
            let new_procotol_owner = *ctx.remaining_accounts.iter().next().unwrap().key;
            set_new_protocol_owner(amm_config, new_procotol_owner)?;
        }
        Some(4) => {
            let new_fund_owner = *ctx.remaining_accounts.iter().next().unwrap().key;
            set_new_fund_owner(amm_config, new_fund_owner)?;
        }
        Some(5) => amm_config.create_pool_fee = value,
        Some(6) => amm_config.disable_create_pool = if value == 0 { false } else { true },
        Some(7) => update_creator_fee_rate(amm_config, value),
        _ => return err!(ErrorCode::InvalidInput),
    }

    Ok(())
}

fn update_protocol_fee_rate(amm_config: &mut Account<AmmConfig>, protocol_fee_rate: u64) {
    assert!(protocol_fee_rate <= FEE_RATE_DENOMINATOR_VALUE);
    assert!(protocol_fee_rate + amm_config.fund_fee_rate <= MAX_PROTOCOL_AND_FUND_FEE_RATE);
    amm_config.protocol_fee_rate = protocol_fee_rate;
}

fn update_trade_fee_rate(amm_config: &mut Account<AmmConfig>, trade_fee_rate: u64) {
    // memetics.finance: never 0, as in create_amm_config (lib.rs).
    assert!(trade_fee_rate > 0);
    assert!(trade_fee_rate + amm_config.creator_fee_rate <= MAX_FEE_RATE_NUMERATOR);
    amm_config.trade_fee_rate = trade_fee_rate;
}

fn update_fund_fee_rate(amm_config: &mut Account<AmmConfig>, fund_fee_rate: u64) {
    assert!(fund_fee_rate <= FEE_RATE_DENOMINATOR_VALUE);
    assert!(fund_fee_rate + amm_config.protocol_fee_rate <= MAX_PROTOCOL_AND_FUND_FEE_RATE);
    amm_config.fund_fee_rate = fund_fee_rate;
}

fn update_creator_fee_rate(amm_config: &mut Account<AmmConfig>, creator_fee_rate: u64) {
    assert!(creator_fee_rate + amm_config.trade_fee_rate <= MAX_FEE_RATE_NUMERATOR);
    amm_config.creator_fee_rate = creator_fee_rate;
}

fn set_new_protocol_owner(amm_config: &mut Account<AmmConfig>, new_owner: Pubkey) -> Result<()> {
    require_keys_neq!(new_owner, Pubkey::default());
    #[cfg(feature = "enable-log")]
    msg!(
        "amm_config, old_protocol_owner:{}, new_owner:{}",
        amm_config.protocol_owner.to_string(),
        new_owner.key().to_string()
    );
    amm_config.protocol_owner = new_owner;
    Ok(())
}

fn set_new_fund_owner(amm_config: &mut Account<AmmConfig>, new_fund_owner: Pubkey) -> Result<()> {
    // memetics.finance: the admin hands a tier's fund fee over once, while it still holds it
    // (create_amm_config makes it the fund owner); after that only a program upgrade can move it.
    require_keys_eq!(amm_config.fund_owner, crate::admin::ID, ErrorCode::InvalidOwner);
    require_keys_neq!(new_fund_owner, Pubkey::default());
    #[cfg(feature = "enable-log")]
    msg!(
        "amm_config, old_fund_owner:{}, new_fund_owner:{}",
        amm_config.fund_owner.to_string(),
        new_fund_owner.key().to_string()
    );
    amm_config.fund_owner = new_fund_owner;
    Ok(())
}

/// A fee tier as the update helpers take it.
#[cfg(test)]
fn test_tier(config: AmmConfig) -> Account<'static, AmmConfig> {
    let mut data = Vec::new();
    config.try_serialize(&mut data).unwrap();
    let info: &'static AccountInfo<'static> = Box::leak(Box::new(AccountInfo::new(
        Box::leak(Box::new(Pubkey::new_unique())),
        false,
        true,
        Box::leak(Box::new(1_000_000u64)),
        Box::leak(data.into_boxed_slice()),
        Box::leak(Box::new(crate::id())),
        false,
        0,
    )));
    Account::try_from(info).unwrap()
}

#[cfg(test)]
mod fee_ceiling_test {
    use super::*;

    fn tier(trade: u64, creator: u64, protocol: u64, fund: u64) -> Account<'static, AmmConfig> {
        test_tier(AmmConfig {
            trade_fee_rate: trade,
            creator_fee_rate: creator,
            protocol_fee_rate: protocol,
            fund_fee_rate: fund,
            ..Default::default()
        })
    }

    // The two tiers on mainnet: fee settings 0 and 1 in frontend/scripts/addresses.json.
    fn launch_tier() -> Account<'static, AmmConfig> {
        tier(2_500, 5_000, 130_000, 70_000)
    }
    fn public_tier() -> Account<'static, AmmConfig> {
        tier(10_000, 0, 104_000, 56_000)
    }

    #[test]
    #[should_panic(expected = "trade_fee_rate + amm_config.creator_fee_rate <= MAX_FEE_RATE_NUMERATOR")]
    fn a_trade_fee_above_4_percent_is_refused() {
        update_trade_fee_rate(&mut public_tier(), 40_001);
    }

    #[test]
    #[should_panic(expected = "creator_fee_rate + amm_config.trade_fee_rate <= MAX_FEE_RATE_NUMERATOR")]
    fn a_creator_fee_taking_the_total_above_4_percent_is_refused() {
        update_creator_fee_rate(&mut public_tier(), 30_001);
    }

    #[test]
    #[should_panic(expected = "trade_fee_rate > 0")]
    fn a_zero_trade_fee_is_refused() {
        update_trade_fee_rate(&mut public_tier(), 0);
    }

    #[test]
    #[should_panic(
        expected = "protocol_fee_rate + amm_config.fund_fee_rate <= MAX_PROTOCOL_AND_FUND_FEE_RATE"
    )]
    fn a_protocol_rate_taking_the_pair_above_20_percent_is_refused() {
        update_protocol_fee_rate(&mut public_tier(), 144_001);
    }

    #[test]
    #[should_panic(
        expected = "fund_fee_rate + amm_config.protocol_fee_rate <= MAX_PROTOCOL_AND_FUND_FEE_RATE"
    )]
    fn a_fund_rate_taking_the_pair_above_20_percent_is_refused() {
        update_fund_fee_rate(&mut public_tier(), 96_001);
    }

    // Controls: both live tiers can be set to their own values again, and each ceiling
    // itself is accepted (the launch tier sits exactly on the 20% one).
    #[test]
    fn the_live_tiers_and_each_ceiling_itself_are_accepted() {
        for mut t in [launch_tier(), public_tier()] {
            let (trade, creator) = (t.trade_fee_rate, t.creator_fee_rate);
            let (protocol, fund) = (t.protocol_fee_rate, t.fund_fee_rate);
            update_trade_fee_rate(&mut t, trade);
            update_creator_fee_rate(&mut t, creator);
            update_protocol_fee_rate(&mut t, protocol);
            update_fund_fee_rate(&mut t, fund);
        }
        let mut t = public_tier();
        update_trade_fee_rate(&mut t, 40_000);
        update_protocol_fee_rate(&mut t, 144_000);
        assert_eq!(t.trade_fee_rate, 40_000);
        assert_eq!(t.protocol_fee_rate + t.fund_fee_rate, 200_000);
        let mut c = public_tier();
        update_creator_fee_rate(&mut c, 30_000);
        update_fund_fee_rate(&mut c, 96_000);
        assert_eq!(c.trade_fee_rate + c.creator_fee_rate, 40_000);
        assert_eq!(c.protocol_fee_rate + c.fund_fee_rate, 200_000);
    }
}

#[cfg(test)]
mod fund_owner_test {
    use super::*;

    /// A tier whose fund fee belongs to `fund_owner`; its protocol owner is the admin, as on
    /// every real tier (create_amm_config sets both roles to the admin).
    fn owned_by(fund_owner: Pubkey) -> Account<'static, AmmConfig> {
        test_tier(AmmConfig {
            fund_owner,
            protocol_owner: crate::admin::ID,
            ..Default::default()
        })
    }

    fn refused_by_the_hand_over_rule(r: Result<()>) -> bool {
        matches!(r, Err(e) if format!("{e:?}").contains("InvalidOwner"))
    }

    // Both live tiers' fund fee belongs to the island's Workshop, not to the admin.
    #[test]
    fn the_admin_cannot_point_a_handed_over_fund_fee_back_at_itself() {
        let island = Pubkey::new_unique();
        let mut t = owned_by(island);
        assert!(refused_by_the_hand_over_rule(set_new_fund_owner(&mut t, crate::admin::ID)));
        assert_eq!(t.fund_owner, island);
    }

    #[test]
    fn the_admin_cannot_point_a_handed_over_fund_fee_at_another_wallet() {
        let island = Pubkey::new_unique();
        let mut t = owned_by(island);
        assert!(refused_by_the_hand_over_rule(set_new_fund_owner(&mut t, Pubkey::new_unique())));
        assert_eq!(t.fund_owner, island);
    }

    // The rule reads the admin key, not the tier's protocol owner: param 3 can move the protocol
    // role, so a tier whose two roles both sit with the island must refuse the admin too.
    #[test]
    fn the_rule_reads_the_admin_key_not_the_tiers_protocol_owner() {
        let island = Pubkey::new_unique();
        let mut t = test_tier(AmmConfig {
            fund_owner: island,
            protocol_owner: island,
            ..Default::default()
        });
        assert!(refused_by_the_hand_over_rule(set_new_fund_owner(&mut t, crate::admin::ID)));
        assert_eq!(t.fund_owner, island);
    }

    // Control: a new tier, whose fund owner create_amm_config makes the admin, is handed over.
    #[test]
    fn the_admin_hands_a_new_tiers_fund_fee_over() {
        let island = Pubkey::new_unique();
        let mut t = owned_by(crate::admin::ID);
        set_new_fund_owner(&mut t, island).unwrap();
        assert_eq!(t.fund_owner, island);
    }
}
