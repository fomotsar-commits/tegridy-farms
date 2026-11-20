//! The coin gate and the transfer helper, copied from bayla-ladder's `token.rs` (itself
//! cp-swap's `utils/token.rs`): `transfer_checked` with the mint's own decimals serves both
//! the classic token program and Token-2022.

use anchor_lang::prelude::*;
use anchor_spl::token_2022;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
};
use anchor_spl::token_interface::Mint;

use crate::OrderError;

pub fn transfer<'a>(
    authority: AccountInfo<'a>,
    from: AccountInfo<'a>,
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
            token_program,
            token_2022::TransferChecked {
                from,
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

/// bayla-ladder's allowlist, word for word: a classic mint, or a Token-2022 mint whose only
/// extensions are the two inert metadata ones BAYLA and pump.fun coins carry. Refused: a
/// transfer fee (a slice would get less than the pool sent), a transfer hook (outside code
/// on every move), a permanent delegate (someone else could empty the escrow), and anything
/// newer. A freeze authority is NOT refused here: USDC has one, and it can freeze only the
/// person's own coin, as it could in their wallet.
pub fn assert_mint_admissible(mint_account: &InterfaceAccount<Mint>) -> Result<()> {
    let mint_info = mint_account.to_account_info();
    if *mint_info.owner == anchor_spl::token::ID {
        return Ok(());
    }
    let mint_data = mint_info.try_borrow_data()?;
    let mint = StateWithExtensions::<spl_token_2022::state::Mint>::unpack(&mint_data)?;
    for e in mint.get_extension_types()? {
        let allowed = matches!(
            e,
            ExtensionType::MetadataPointer | ExtensionType::TokenMetadata
        );
        require!(allowed, OrderError::UnsupportedMint);
    }
    Ok(())
}
