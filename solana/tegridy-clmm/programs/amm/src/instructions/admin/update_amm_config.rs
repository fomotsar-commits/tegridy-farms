use crate::error::ErrorCode;
use crate::states::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct UpdateAmmConfig<'info> {
    /// The amm config owner or admin
    #[account(address = crate::admin::ID @ ErrorCode::NotApproved)]
    pub owner: Signer<'info>,

    /// Amm config account to be changed
    #[account(mut)]
    pub amm_config: Account<'info, AmmConfig>,
}

pub fn update_amm_config(ctx: Context<UpdateAmmConfig>, param: u8, value: u32) -> Result<()> {
    let amm_config = &mut ctx.accounts.amm_config;
    let match_param = Some(param);
    match match_param {
        Some(0) => update_trade_fee_rate(amm_config, value)?,
        Some(1) => update_protocol_fee_rate(amm_config, value)?,
        Some(2) => update_fund_fee_rate(amm_config, value)?,
        // memetics.finance: param 3, a second fee collector beside the vault, is deleted
        // (2026-11-15 audit, RNG-09): only the vault collects the venue's share.
        Some(4) => {
            let new_fund_owner = *ctx
                .remaining_accounts
                .iter()
                .next()
                .ok_or(ErrorCode::AccountLack)?
                .key;
            // memetics.finance: a tier's island share is handed over once, while the vault still
            // holds it, and never moved again; only a program upgrade can (the owner's ruling,
            // 2026-11-03). Never to the all-zero key (2026-11-15 audit, XCH-08). Swap pools hold
            // the same rules.
            require_keys_eq!(amm_config.fund_owner, crate::admin::ID, ErrorCode::NotApproved);
            require_keys_neq!(new_fund_owner, Pubkey::default());
            set_new_fund_owner(amm_config, new_fund_owner);
        }
        _ => return err!(ErrorCode::InvalidUpdateConfigFlag),
    }

    emit!(ConfigChangeEvent {
        index: amm_config.index,
        owner: amm_config.owner,
        trade_fee_rate: amm_config.trade_fee_rate,
        protocol_fee_rate: amm_config.protocol_fee_rate,
        tick_spacing: amm_config.tick_spacing,
        fund_fee_rate: amm_config.fund_fee_rate,
        fund_owner: amm_config.fund_owner,
    });

    Ok(())
}

fn update_protocol_fee_rate(
    amm_config: &mut Account<AmmConfig>,
    protocol_fee_rate: u32,
) -> Result<()> {
    require_gte!(FEE_RATE_DENOMINATOR_VALUE, protocol_fee_rate);
    require_gte!(
        MAX_PROTOCOL_AND_FUND_FEE_RATE,
        protocol_fee_rate + amm_config.fund_fee_rate
    );
    amm_config.protocol_fee_rate = protocol_fee_rate;
    Ok(())
}

fn update_trade_fee_rate(amm_config: &mut Account<AmmConfig>, trade_fee_rate: u32) -> Result<()> {
    require_gte!(MAX_FEE_RATE_NUMERATOR, trade_fee_rate);
    amm_config.trade_fee_rate = trade_fee_rate;
    Ok(())
}

fn update_fund_fee_rate(amm_config: &mut Account<AmmConfig>, fund_fee_rate: u32) -> Result<()> {
    require_gte!(FEE_RATE_DENOMINATOR_VALUE, fund_fee_rate);
    require_gte!(
        MAX_PROTOCOL_AND_FUND_FEE_RATE,
        fund_fee_rate + amm_config.protocol_fee_rate
    );
    amm_config.fund_fee_rate = fund_fee_rate;
    Ok(())
}

fn set_new_fund_owner(amm_config: &mut Account<AmmConfig>, new_fund_owner: Pubkey) {
    #[cfg(feature = "enable-log")]
    msg!(
        "amm_config, old_fund_owner:{}, new_fund_owner:{}",
        amm_config.fund_owner.to_string(),
        new_fund_owner.key().to_string()
    );
    amm_config.fund_owner = new_fund_owner;
}

#[cfg(test)]
mod tier_settings_test {
    use super::*;
    use anchor_lang::{system_program, Discriminator};

    fn info(key: Pubkey, owner: Pubkey, data: Vec<u8>, signer: bool) -> &'static AccountInfo<'static> {
        Box::leak(Box::new(AccountInfo::new(
            Box::leak(Box::new(key)),
            signer,
            true,
            Box::leak(Box::new(1_000_000_000u64)),
            Box::leak(data.into_boxed_slice()),
            Box::leak(Box::new(owner)),
            false,
        )))
    }

    /// The vault calls update_amm_config with `param` on a tier whose island share it still
    /// holds, naming `named` as the one extra account.
    fn update(param: u8, named: Pubkey) -> Result<()> {
        let mut data = AmmConfig::DISCRIMINATOR.to_vec();
        AmmConfig {
            owner: crate::admin::ID,
            fund_owner: crate::admin::ID,
            ..Default::default()
        }
        .serialize(&mut data)
        .unwrap();
        let accounts = Box::leak(Box::new(UpdateAmmConfig {
            owner: Signer::try_from(info(crate::admin::ID, system_program::ID, vec![], true)).unwrap(),
            amm_config: Account::try_from(info(Pubkey::new_unique(), crate::ID, data, false)).unwrap(),
        }));
        let remaining = Box::leak(vec![info(named, system_program::ID, vec![], false).clone()].into_boxed_slice());
        update_amm_config(
            Context::new(&crate::ID, accounts, remaining, UpdateAmmConfigBumps::default()),
            param,
            0,
        )
    }

    /// memetics.finance (2026-11-15 audit, RNG-09 and XCH-08): param 3 no longer names a second
    /// fee collector, and the island's one hand-over refuses the all-zero key.
    #[test]
    fn no_second_collector_and_no_zero_island_test() {
        assert_eq!(
            update(3, Pubkey::new_unique()).unwrap_err(),
            ErrorCode::InvalidUpdateConfigFlag.into()
        );
        assert_eq!(
            update(4, Pubkey::default()).unwrap_err(),
            anchor_lang::error::ErrorCode::RequireKeysNeqViolated.into()
        );
        assert!(update(4, Pubkey::new_unique()).is_ok());
    }
}
