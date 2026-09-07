//! Token-2022-capable transfer helpers and the mint gate.
//!
//! The two transfer functions are `programs/cp-swap/src/utils/token.rs`'s
//! `transfer_from_user_to_pool_vault` / `transfer_from_pool_vault_to_user`, copied
//! verbatim (minus cp-swap's fee-on-transfer arithmetic, which this pool refuses at
//! the door instead). `transfer_checked` with the mint's own decimals is what makes
//! them program-agnostic: legacy SPL and Token-2022 both accept it.

use anchor_lang::prelude::*;
use anchor_spl::token_2022;
use anchor_spl::token_2022::spl_token_2022::{
    self,
    extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions},
};
use anchor_spl::token_interface::Mint;

use crate::errors::LadderError;

pub fn transfer_from_user_to_vault<'a>(
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

pub fn transfer_from_vault<'a>(
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

/// The mint gate, run ONCE at `initialize_pool`.
///
/// An ALLOWLIST, not a denylist — an extension type invented after this ships is
/// rejected by default. Exactly the two inert pump.fun metadata extensions BAYLA
/// carries (read on-chain 2026-09-06) are admitted; legacy SPL mints, which have no
/// extensions at all, pass trivially so BOBO/SOY/BRAINLET/RIZZ can use this program.
///
/// REFUSED, and why:
/// - `TransferFeeConfig`: the fee is charged on the vault→user leg, so THE PRINCIPAL
///   PROMISE ("you get back exactly what you put in") becomes false by design. That
///   is a different product with `principal_shares` accounting and a different
///   disclosure — a new pool type, not a flag on this one.
/// - `TransferHook`: unbounded CPI into third-party code on the principal path is a
///   larger surface than the rest of this program.
/// - `PermanentDelegate`, `DefaultAccountState`, and anything else: a third party
///   with power over the vault's balance or state defeats I-1 from outside.
///
/// A FREEZE AUTHORITY is refused separately: it can freeze the vault's own token
/// account and trap every staker's principal, defeating I-1 from outside the
/// program entirely.
///
/// A LIVE MINT AUTHORITY is refused for the same reason and is strictly worse
/// (AUDIT M-1, 2026-09-06 — the check was simply absent; `grep -rn mint_authority`
/// returned nothing crate-wide, while the freeze rationale above covered it word for
/// word). Because stake mint == reward mint, a minter can conjure the exact asset
/// this ladder prices. Concretely: mint `deposit_cap`, stake it in one call, become
/// ~100% of `total_weighted` — the accumulator's only divisor — take the entire
/// funded window, and recover the principal penalty-free at maturity, at zero capital
/// cost, while every other wallet is refused with `DepositCapExceeded`. It also
/// removes the mitigating argument for M-4 (that occupying the cap costs the griefer
/// the whole cap in locked capital).
///
/// Both checks sit ABOVE the legacy short-circuit deliberately. For a Tokenkeg mint
/// the function returns immediately after them, so they are the entire gate.
///
/// WHAT THIS FORECLOSES, as a written decision rather than a side effect: an
/// inflationary-rewards pool, where an authority mints emissions on demand instead of
/// pre-funding them. The venue has already rejected that model, so refusing it here
/// is the right trade — but it is a trade, and a future pool that wants it needs a
/// different gate and a different disclosure, not a relaxed constant.
pub fn assert_mint_admissible(mint_account: &InterfaceAccount<Mint>) -> Result<()> {
    require!(
        mint_account.mint_authority.is_none(),
        LadderError::MintHasMintAuthority
    );
    require!(
        mint_account.freeze_authority.is_none(),
        LadderError::MintHasFreezeAuthority
    );
    let mint_info = mint_account.to_account_info();
    // Legacy SPL: no extensions are possible.
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
        require!(allowed, LadderError::UnsupportedMintExtension);
    }
    Ok(())
}
