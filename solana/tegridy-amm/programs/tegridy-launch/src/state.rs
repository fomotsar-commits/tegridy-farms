use anchor_lang::prelude::*;

/// PDA seed prefixes. Changing any of these is an account-layout break.
pub const GLOBAL_SEED: &[u8] = b"global";
pub const CURVE_SEED: &[u8] = b"curve";
pub const VAULT_SEED: &[u8] = b"vault";
/// Seed for the per-launch migration authority.
///
/// This PDA is deliberately DATA-LESS, which makes it System-owned — and that is
/// the whole point. cp-swap's `initialize` declares five accounts as `init` with
/// `payer = creator`, and `init` funds rent through the System program's
/// `CreateAccount`, which requires a System-owned payer. The curve PDA holds
/// `BondingCurve` data, so it is owned by THIS program and can never be that
/// payer. An earlier version made the curve the creator and failed at runtime on
/// the System program's "`from` must not carry data" check.
///
/// A data-less PDA can do both jobs: sign via seeds (it is derived from this
/// program) and pay rent (it is System-owned). Never allocate data to it — the
/// reconciliation barrier in `migrate_to_amm` also System-transfers FROM it, so
/// allocating data breaks two things at once. The handler asserts it.
pub const MIGRATION_AUTH_SEED: &[u8] = b"migauth";

/// Seed for the cp-swap pool a launch graduates into.
///
/// The pool address is OURS, not cp-swap's canonical derivation, and that is a
/// security property rather than a preference.
///
/// cp-swap's `initialize` is permissionless — its `creator` is documented "Can be
/// anyone" — and `create_pool` rejects any `pool_state` that is not System-owned
/// (initialize.rs:372-374). So the canonical pool PDA,
/// [POOL_SEED, amm_config, token_0_mint, token_1_mint], can be OCCUPIED by anyone:
/// buy a single token off a curve, wrap dust SOL, call cp-swap directly, and that
/// launch can never graduate. Not a theft — holders keep selling while `complete`
/// is false — but a permanent brick for the price of one transaction.
///
/// `create_pool` accepts a second shape: a `pool_state` that is not the canonical
/// PDA but IS a signer (initialize.rs:386-388). Signer privilege propagates through
/// CPI, so a PDA of THIS program qualifies and nobody else can ever sign for it.
/// cp-swap then derives `lp_mint`, both vaults and `observation_state` from
/// whatever `pool_state` it was given, so the whole pool hangs off this seed
/// consistently.
pub const LAUNCH_POOL_SEED: &[u8] = b"launchpool";

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
    /// Real lamports a curve must accumulate before it may graduate. This is the
    /// amount DEPOSITED as pool liquidity — it excludes the migration reserve.
    pub graduation_target_lamports: u64,

    /// Lamports raised ON TOP of the target, kept back to pay for migration.
    ///
    /// Migrating is not free: cp-swap's `initialize` charges `create_pool_fee` as a
    /// NATIVE SOL transfer from the creator (initialize.rs:318-325) and rent-funds
    /// five new accounts (pool_state, both vaults, lp_mint, observation_state) —
    /// and the creator is the curve PDA. A curve that raised exactly the target and
    /// deposited all of it could not afford to migrate, stranding the launch at the
    /// finish line.
    ///
    /// Raised by traders and fixed before anyone buys, so the Fact Sheet can state
    /// it. See MIGRATE_DESIGN.md decision 1.
    pub migration_reserve_lamports: u64,

    /// The cp-swap program this launch graduates into, and the AmmConfig it uses.
    ///
    /// Neither is derivable, and neither may be hardcoded: the AmmConfig is created
    /// by a cp-swap admin action AFTER deploy. `migrate_to_amm` must check the
    /// accounts it is handed against these, or a caller substitutes a hostile AMM
    /// and the launch graduates into someone else's pool.
    pub cp_swap_program: Pubkey,
    pub amm_config: Pubkey,
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
    /// Migration reserve, snapshotted for the same reason.
    ///
    /// Buys are capped at `target + reserve`, NOT at the target alone. An earlier
    /// version capped at the target and then rejected further buys, which made the
    /// reserve unraisable — so migration could never afford its own costs, the
    /// exact failure the reserve exists to prevent. Found by the CI rehearsal.
    pub migration_reserve_lamports: u64,

    /// Set once the curve graduates. Terminal: buys and sells both stop, and the
    /// reserves are handed to the AMM pool. Never unset.
    ///
    /// ⚠️ ONLY `migrate_to_amm` may write this, in the SAME instruction that moves
    /// the liquidity. A removed `graduate` instruction set it on its own and
    /// permanently locked every lamport raised, because `buy` and `sell` both
    /// require `!complete` and `sell` was the only exit. A flag that closes the
    /// only exit must be written by the instruction that opens the new one.
    pub complete: bool,

    /// The cp-swap pool this curve graduated into. Zero until migration.
    ///
    /// Not cosmetic: without it nothing off-chain can find where a launch went, so
    /// the Fact Sheet cannot link the pool and the frontend cannot route to it.
    pub pool: Pubkey,

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
