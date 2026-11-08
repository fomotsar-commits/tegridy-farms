use crate::error::ErrorCode;
use crate::states::*;
use anchor_lang::{prelude::*, system_program};
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{
        transfer_fee::{TransferFeeConfig, MAX_FEE_BASIS_POINTS},
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
};
use anchor_spl::{
    token::{Token, TokenAccount},
    token_2022::{self},
    token_interface::{initialize_account3, InitializeAccount3, Mint},
};

pub fn transfer_from_user_to_pool_vault<'a>(
    authority: AccountInfo<'a>,
    from: AccountInfo<'a>,
    to_vault: AccountInfo<'a>,
    mint: AccountInfo<'a>,
    token_program: AccountInfo<'a>,
    amount: u64,
    mint_decimals: u8,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_2022::transfer_checked(
        CpiContext::new(
            token_program.to_account_info(),
            token_2022::TransferChecked {
                from,
                to: to_vault,
                authority,
                mint,
            },
        ),
        amount,
        mint_decimals,
    )
}

pub fn transfer_from_pool_vault_to_user<'a>(
    authority: AccountInfo<'a>,
    from_vault: AccountInfo<'a>,
    to: AccountInfo<'a>,
    mint: AccountInfo<'a>,
    token_program: AccountInfo<'a>,
    amount: u64,
    mint_decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    token_2022::transfer_checked(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            token_2022::TransferChecked {
                from: from_vault,
                to,
                authority,
                mint,
            },
            signer_seeds,
        ),
        amount,
        mint_decimals,
    )
}

/// Issue a spl_token `MintTo` instruction.
pub fn token_mint_to<'a>(
    authority: AccountInfo<'a>,
    token_program: AccountInfo<'a>,
    mint: AccountInfo<'a>,
    destination: AccountInfo<'a>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    token_2022::mint_to(
        CpiContext::new_with_signer(
            token_program,
            token_2022::MintTo {
                to: destination,
                authority,
                mint,
            },
            signer_seeds,
        ),
        amount,
    )
}

pub fn token_burn<'a>(
    authority: AccountInfo<'a>,
    token_program: AccountInfo<'a>,
    mint: AccountInfo<'a>,
    from: AccountInfo<'a>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    token_2022::burn(
        CpiContext::new_with_signer(
            token_program.to_account_info(),
            token_2022::Burn {
                from,
                authority,
                mint,
            },
            signer_seeds,
        ),
        amount,
    )
}

/// Calculate the fee for output amount
pub fn get_transfer_inverse_fee(mint_info: &AccountInfo, post_fee_amount: u64) -> Result<u64> {
    if *mint_info.owner == Token::id() {
        return Ok(0);
    }
    if post_fee_amount == 0 {
        return err!(ErrorCode::InvalidInput);
    }
    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

    let fee = if let Ok(transfer_fee_config) = mint.get_extension::<TransferFeeConfig>() {
        let epoch = Clock::get()?.epoch;

        let transfer_fee = transfer_fee_config.get_epoch_fee(epoch);
        if u16::from(transfer_fee.transfer_fee_basis_points) == MAX_FEE_BASIS_POINTS {
            u64::from(transfer_fee.maximum_fee)
        } else {
            let transfer_fee = transfer_fee_config
                .calculate_inverse_epoch_fee(epoch, post_fee_amount)
                .unwrap();
            let transfer_fee_for_check = transfer_fee_config
                .calculate_epoch_fee(epoch, post_fee_amount.checked_add(transfer_fee).unwrap())
                .unwrap();
            if transfer_fee != transfer_fee_for_check {
                return err!(ErrorCode::TransferFeeCalculateNotMatch);
            }
            transfer_fee
        }
    } else {
        0
    };
    Ok(fee)
}

/// Calculate the fee for input amount
pub fn get_transfer_fee(mint_info: &AccountInfo, pre_fee_amount: u64) -> Result<u64> {
    if *mint_info.owner == Token::id() {
        return Ok(0);
    }
    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;

    let fee = if let Ok(transfer_fee_config) = mint.get_extension::<TransferFeeConfig>() {
        transfer_fee_config
            .calculate_epoch_fee(Clock::get()?.epoch, pre_fee_amount)
            .unwrap()
    } else {
        0
    };
    Ok(fee)
}

pub fn support_mint_associated_is_initialized(
    remaining_accounts: &[AccountInfo],
    token_mint: &InterfaceAccount<Mint>,
) -> Result<bool> {
    if remaining_accounts.len() == 0 {
        return Ok(false);
    }
    let (expect_mint_associated, __bump) = Pubkey::find_program_address(
        &[SUPPORT_MINT_SEED.as_bytes(), token_mint.key().as_ref()],
        &crate::id(),
    );
    let mut mint_associated_is_initialized = false;
    for mint_associated_info in remaining_accounts.into_iter() {
        if *mint_associated_info.owner != crate::id()
            || mint_associated_info.key() != expect_mint_associated
        {
            continue;
        }
        let mint_associated = SupportMintAssociated::try_deserialize(
            &mut mint_associated_info.data.borrow().as_ref(),
        )?;
        if mint_associated.mint == token_mint.key() {
            mint_associated_is_initialized = true;
            break;
        }
    }
    return Ok(mint_associated_is_initialized);
}

// memetics.finance: a support-mint record no longer lets a Token-2022 coin skip the
// extension check below. It did, for every extension, a permanent delegate or a transfer
// hook included, and the vault could make one for any coin. The record and its two
// instructions stay, so the program's interface is upstream's, but nothing reads it here.
pub fn is_supported_mint(
    mint_account: &InterfaceAccount<Mint>,
    _mint_associated_is_initialized: bool,
) -> Result<bool> {
    let mint_info = mint_account.to_account_info();
    if *mint_info.owner == Token::id() {
        return Ok(true);
    }
    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;
    let extensions = mint.get_extension_types()?;
    for e in extensions {
        if e != ExtensionType::TransferFeeConfig
            && e != ExtensionType::MetadataPointer
            && e != ExtensionType::TokenMetadata
            && e != ExtensionType::InterestBearingConfig
            && e != ExtensionType::ScaledUiAmount
        {
            return Ok(false);
        }
    }
    Ok(true)
}

pub fn create_token_account<'a>(
    authority: &AccountInfo<'a>,
    payer: &AccountInfo<'a>,
    token_account: &AccountInfo<'a>,
    mint_account: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    signer_seeds: &[&[u8]],
) -> Result<()> {
    let space = {
        let mint_info = mint_account.to_account_info();
        if *mint_info.owner == token_2022::Token2022::id() {
            let mint_data = mint_info.try_borrow_data()?;
            let mint_state =
                StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;
            let mint_extensions = mint_state.get_extension_types()?;
            let required_extensions =
                ExtensionType::get_required_init_account_extensions(&mint_extensions);
            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
                &required_extensions,
            )?
        } else {
            TokenAccount::LEN
        }
    };
    create_or_allocate_account(
        token_program.key,
        payer.to_account_info(),
        system_program.to_account_info(),
        token_account.to_account_info(),
        signer_seeds,
        space,
    )?;
    initialize_account3(CpiContext::new(
        token_program.to_account_info(),
        InitializeAccount3 {
            account: token_account.to_account_info(),
            mint: mint_account.to_account_info(),
            authority: authority.to_account_info(),
        },
    ))
}

pub fn create_or_allocate_account<'a>(
    program_id: &Pubkey,
    payer: AccountInfo<'a>,
    system_program: AccountInfo<'a>,
    target_account: AccountInfo<'a>,
    siger_seed: &[&[u8]],
    space: usize,
) -> Result<()> {
    let rent = Rent::get()?;
    let current_lamports = target_account.lamports();

    if current_lamports == 0 {
        let lamports = rent.minimum_balance(space);
        let cpi_accounts = system_program::CreateAccount {
            from: payer,
            to: target_account.clone(),
        };
        let cpi_context = CpiContext::new(system_program.clone(), cpi_accounts);
        system_program::create_account(
            cpi_context.with_signer(&[siger_seed]),
            lamports,
            u64::try_from(space).unwrap(),
            program_id,
        )?;
    } else {
        let required_lamports = rent
            .minimum_balance(space)
            .max(1)
            .saturating_sub(current_lamports);
        if required_lamports > 0 {
            let cpi_accounts = system_program::Transfer {
                from: payer.to_account_info(),
                to: target_account.clone(),
            };
            let cpi_context = CpiContext::new(system_program.clone(), cpi_accounts);
            system_program::transfer(cpi_context, required_lamports)?;
        }
        let cpi_accounts = system_program::Allocate {
            account_to_allocate: target_account.clone(),
        };
        let cpi_context = CpiContext::new(system_program.clone(), cpi_accounts);
        system_program::allocate(
            cpi_context.with_signer(&[siger_seed]),
            u64::try_from(space).unwrap(),
        )?;

        let cpi_accounts = system_program::Assign {
            account_to_assign: target_account.clone(),
        };
        let cpi_context = CpiContext::new(system_program.clone(), cpi_accounts);
        system_program::assign(cpi_context.with_signer(&[siger_seed]), program_id)?;
    }
    Ok(())
}

#[cfg(test)]
mod is_supported_mint_test {
    use super::*;
    use spl_token_2022::extension::{
        metadata_pointer::MetadataPointer, permanent_delegate::PermanentDelegate,
        BaseStateWithExtensionsMut, StateWithExtensionsMut,
    };

    /// The program's own view of a mint account: `key`, owned by `owner`, holding `data`.
    fn mint_account(key: Pubkey, owner: Pubkey, data: Vec<u8>) -> InterfaceAccount<'static, Mint> {
        let info: &'static AccountInfo<'static> = Box::leak(Box::new(AccountInfo::new(
            Box::leak(Box::new(key)),
            false,
            false,
            Box::leak(Box::new(1_461_600u64)),
            Box::leak(data.into_boxed_slice()),
            Box::leak(Box::new(owner)),
            false,
            0,
        )));
        InterfaceAccount::<Mint>::try_from(info).unwrap()
    }

    /// A Token-2022 mint at `key` carrying `extensions`.
    fn token_2022_mint(key: Pubkey, extensions: &[ExtensionType]) -> InterfaceAccount<'static, Mint> {
        let len =
            ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(extensions)
                .unwrap();
        let mut data = vec![0u8; len];
        let mut state =
            StateWithExtensionsMut::<spl_token_2022::state::Mint>::unpack_uninitialized(&mut data)
                .unwrap();
        for e in extensions {
            match e {
                ExtensionType::PermanentDelegate => {
                    state.init_extension::<PermanentDelegate>(true).unwrap();
                }
                ExtensionType::MetadataPointer => {
                    state.init_extension::<MetadataPointer>(true).unwrap();
                }
                _ => unreachable!("add the extension here"),
            }
        }
        state.base.decimals = 6;
        state.base.is_initialized = true;
        state.pack_base();
        state.init_account_type().unwrap();
        mint_account(key, spl_token_2022::id(), data)
    }

    // The four stablecoins upstream's MINT_WHITELIST let in by name (USDP, GYEN, ZUSD, PYUSD).
    const DELETED_WHITELIST: [Pubkey; 4] = [
        pubkey!("HVbpJAQGNpkgBaYBZQBR1t7yFdvaYVp2vCQQfKKEN4tM"),
        pubkey!("Crn4x1Y2HUKko7ox2EZMT6N2t2ZyH7eKtwkBGVnhEq1g"),
        pubkey!("FrBfWJ4qE5sCzKm3k3JaAtqZcXUh4LvJygDeketsrsH4"),
        pubkey!("2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo"),
    ];

    #[test]
    fn the_four_stablecoins_meet_the_same_extension_check_as_every_coin() {
        for key in DELETED_WHITELIST {
            let mint = token_2022_mint(key, &[ExtensionType::PermanentDelegate]);
            assert!(!is_supported_mint(&mint, false).unwrap(), "{key} is let in by name");
        }
    }

    #[test]
    fn a_support_mint_record_does_not_skip_the_extension_check() {
        let mint = token_2022_mint(Pubkey::new_unique(), &[ExtensionType::PermanentDelegate]);
        assert!(!is_supported_mint(&mint, true).unwrap());
    }

    // Controls: what the program let in before still goes in, and what it refused still does.
    #[test]
    fn a_classic_mint_and_an_allowed_extension_still_go_in() {
        use anchor_lang::solana_program::program_pack::Pack;
        use anchor_spl::token::spl_token::state::Mint as ClassicMint;
        let mut data = vec![0u8; ClassicMint::LEN];
        ClassicMint::pack(
            ClassicMint {
                decimals: 9,
                is_initialized: true,
                ..Default::default()
            },
            &mut data,
        )
        .unwrap();
        let classic = mint_account(Pubkey::new_unique(), Token::id(), data);
        assert!(is_supported_mint(&classic, false).unwrap());
        let named = token_2022_mint(Pubkey::new_unique(), &[ExtensionType::MetadataPointer]);
        assert!(is_supported_mint(&named, false).unwrap());
    }

    #[test]
    fn a_permanent_delegate_without_a_record_is_still_refused() {
        let mint = token_2022_mint(Pubkey::new_unique(), &[ExtensionType::PermanentDelegate]);
        assert!(!is_supported_mint(&mint, false).unwrap());
    }
}
