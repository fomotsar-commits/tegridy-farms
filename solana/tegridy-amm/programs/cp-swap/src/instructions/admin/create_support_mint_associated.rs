use crate::error::ErrorCode;
use crate::states::*;
use anchor_lang::prelude::*;
use anchor_spl::{token_2022, token_interface::Mint};
use std::ops::DerefMut;

// TEGRIDY FORK CHANGE (2026-07-10): upstream this alternate authority for the
// Token-2022 support-mint allowlist was a Raydium-controlled key. Pointed at the
// Tegridy admin so NO external party retains any authority on this program. This
// is the 4th (and final) hardcoded-authority change; the other three are in lib.rs.
// ⚠️ OPERATOR: replace the mainnet value with the Squads multisig before mainnet.
pub mod create_support_mint_associated_owner {
    use super::{pubkey, Pubkey};
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK");
}

#[derive(Accounts)]
pub struct CreateSupportMintAssociated<'info> {
    /// Address to be set as protocol owner.
    #[account(
        mut,
        constraint = (owner.key() == crate::admin::ID || owner.key() == crate::create_support_mint_associated_owner::ID) @ ErrorCode::NotApproved
    )]
    pub owner: Signer<'info>,
    /// Support token mint
    #[account(
        owner = token_2022::ID @ ErrorCode::NotApproved
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,
    /// Initialize support mint state account to store support mint address and bump.
    #[account(
        init,
        seeds = [
            SUPPORT_MINT_SEED.as_bytes(),
            token_mint.key().as_ref(),
        ],
        bump,
        payer = owner,
        space = SupportMintAssociated::LEN
    )]
    pub support_mint_associated: Account<'info, SupportMintAssociated>,

    pub system_program: Program<'info, System>,
}

pub fn create_support_mint_associated(ctx: Context<CreateSupportMintAssociated>) -> Result<()> {
    let support_mint_state = ctx.accounts.support_mint_associated.deref_mut();
    support_mint_state.bump = ctx.bumps.support_mint_associated;
    support_mint_state.mint = ctx.accounts.token_mint.key();

    Ok(())
}
