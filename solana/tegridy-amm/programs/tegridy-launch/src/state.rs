use anchor_lang::prelude::*;

/// PDA seed prefixes. Changing any of these is an account-layout break.
pub const GLOBAL_SEED: &[u8] = b"global";
pub const CURVE_SEED: &[u8] = b"curve";
pub const VAULT_SEED: &[u8] = b"vault";

/// Protocol-wide configuration. One per program, PDA at [`GLOBAL_SEED`].
///
/// Everything a launch needs is snapshotted onto the curve at creation time, so
/// changing this config never retroactively alters a live launch's economics.
/// That is deliberate: a launch's terms must not be mutable by governance after
/// people have bought into it.
#[account]
#[derive(InitSpace)]
pub struct GlobalConfig {
    /// Admin. Mainnet: the Squads multisig, threshold >= 2.
    pub authority: Pubkey,
    /// Where trade fees accrue. Mainnet: the treasury's Squads vault.
    pub fee_recipient: Pubkey,
    /// Trade fee in basis points, bounded by `curve::MAX_FEE_BPS`.
    pub trade_fee_bps: u64,
    /// Virtual reserves every new curve opens with — these set the opening price.
    pub initial_virtual_sol: u64,
    pub initial_virtual_token: u64,
    /// Token supply minted onto each curve.
    pub token_total_supply: u64,
    /// Real lamports a curve must accumulate before it may graduate.
    pub graduation_target_lamports: u64,
    /// Global halt. Blocks buys and graduation; **sells stay open** so a pause can
    /// never trap holders in a position they cannot exit.
    pub paused: bool,
    pub bump: u8,
}

/// One bonding curve per launched token. PDA at [`CURVE_SEED`, mint].
#[account]
#[derive(InitSpace)]
pub struct BondingCurve {
    pub mint: Pubkey,
    pub creator: Pubkey,

    /// Effective reserves are `virtual + real`; the virtual part is what gives a
    /// launch a sane opening price with no seeded capital. See `curve.rs`.
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64,

    /// Fee snapshotted at creation, so a later governance change cannot alter the
    /// terms of a launch that is already trading.
    pub trade_fee_bps: u64,
    /// Graduation target, snapshotted for the same reason.
    pub graduation_target_lamports: u64,

    /// Set once the curve graduates. Terminal: buys and sells both stop, and the
    /// reserves are handed to the AMM pool. Never unset.
    pub complete: bool,
    pub bump: u8,
}

impl BondingCurve {
    /// Reserves the pricing function actually sees.
    #[inline]
    pub fn effective_sol(&self) -> Result<u64> {
        self.virtual_sol_reserves
            .checked_add(self.real_sol_reserves)
            .ok_or_else(|| error!(crate::errors::LaunchError::Overflow))
    }

    #[inline]
    pub fn effective_tokens(&self) -> Result<u64> {
        self.virtual_token_reserves
            .checked_add(self.real_token_reserves)
            .ok_or_else(|| error!(crate::errors::LaunchError::Overflow))
    }
}

#[event]
pub struct LaunchCreated {
    pub mint: Pubkey,
    pub creator: Pubkey,
    pub virtual_sol_reserves: u64,
    pub virtual_token_reserves: u64,
    pub token_total_supply: u64,
}

#[event]
pub struct Traded {
    pub mint: Pubkey,
    pub trader: Pubkey,
    /// true = buy (SOL in, tokens out); false = sell.
    pub is_buy: bool,
    pub sol_amount: u64,
    pub token_amount: u64,
    pub fee_lamports: u64,
    pub real_sol_reserves: u64,
    pub real_token_reserves: u64,
}

#[event]
pub struct Graduated {
    pub mint: Pubkey,
    /// Lamports handed to the AMM pool seeding.
    pub sol_reserves: u64,
    /// Tokens handed to the AMM pool seeding.
    pub token_reserves: u64,
}
