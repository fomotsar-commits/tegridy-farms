pub mod curve;
pub mod error;
pub mod instructions;
pub mod states;
pub mod utils;
use crate::curve::fees::FEE_RATE_DENOMINATOR_VALUE;
use anchor_lang::prelude::*;
use instructions::*;
pub use states::CreatorFeeOn;

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "tegridy-cp-amm",
    project_url: "https://memetic.fun",
    contacts: "link:https://memetic.fun/trust",
    policy: "https://github.com/fomotsar-commits/tegridy-farms/blob/main/SECURITY.md",
    source_code: "https://github.com/fomotsar-commits/tegridy-farms/tree/main/solana/tegridy-amm",
    preferred_languages: "en"
    // AUDITORS line intentionally REMOVED (was upstream's Raydium/MadShield audit):
    // this fork's diff-audit is PENDING; the upstream audit does NOT cover it, so
    // claiming it on-chain would be false. ⚠️ OPERATOR: add a dedicated security
    // disclosure email here before mainnet.
}

// ─── TEGRIDY FORK CHANGES (2026-07-11) ────────────────────────────────────────
// The ENTIRE code delta from upstream raydium-cp-swap (Apache-2.0) is 4 authority/
// identity constants (3 here + create_support_mint_associated_owner in
// instructions/admin/create_support_mint_associated.rs). Every line of swap/curve/
// fee logic is byte-identical to the audited upstream. The per-swap PROTOCOL fee is
// NOT here: it accrues per `amm_config.protocol_fee_rate` and is collected by
// `amm_config.protocol_owner` (which create_config sets = the admin caller).
//
// (Two header paragraphs deleted 2026-08-24: one claimed the non-devnet authority
// constants were fail-closed all-1s sentinels — false, the real values below are
// live keys — and one instructed "admin = Squads MULTISIG", the exact compile-time
// mistake that shipped 2026-08-08 and bricked graduation. The authoritative
// guidance is the admin module's own comment below: the constant must be a
// SIGNABLE, SYSTEM-OWNED, rent-paying account, never the Squads multisig account.)
#[cfg(feature = "devnet")]
declare_id!("BvBkt84ZiKmiPSuWrdefxbxPTX5YiLnU6YEGtY6pDodL");
#[cfg(not(feature = "devnet"))]
declare_id!("3ZvZXEBr21Kz7JeWFCeKv8Hyy8AzHqCSXNjif8QHPM9y");

pub mod admin {
    use super::{pubkey, Pubkey};
    // Admin authority: create_config / update_config / update_pool_status AND a
    // fallback collector on collect_protocol_fee / collect_fund_fee (can sweep accrued
    // protocol+fund fees to any recipient) — a fund-touching, top-tier key.
    //
    // ─── THIS MUST BE A SIGNABLE, RENT-PAYING ACCOUNT ──────────────────────────
    // It was the Squads MULTISIG account (EVGSnRZFWqjCaWR7z2xKbSXnuddY8upevEQK5HFmj6NK),
    // which is neither. That shipped to mainnet on 2026-08-08 and made
    // `create_amm_config` UNCALLABLE, which in turn left tegridy-launch's
    // `migrate_to_amm` permanently on AmmNotConfigured (6015) — tokens could trade
    // but never graduate.
    //
    // The multisig ACCOUNT and the vault PDA are different things:
    //   EVGSnRZ… multisig  owner = Squads program, 495 bytes of data
    //   GRMtSxgs… vault    owner = System Program, 0 bytes
    // Squads v4 signs CPIs as the VAULT, so nothing can ever sign as the multisig.
    // And `CreateAmmConfig` has `payer = owner`, so even a signature would not be
    // enough: the System Program can only debit an account it owns with no data.
    //
    // So whatever goes here must be system-owned and fundable. Currently the deploy
    // authority, a single operator-held key — chosen deliberately to unblock
    // graduation and prove migration end-to-end before locking AMM admin behind a
    // 2-of-N ceremony. Moving `protocol_owner`/`fund_owner` to the vault later is a
    // plain `update_config` (params 3 and 4); moving THIS constant needs another
    // program upgrade, because it is resolved at compile time.
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7");
}

pub mod create_pool_fee_reveiver {
    use super::{pubkey, Pubkey};
    // Flat pool-creation fee recipient. This account is consumed as a native-SOL
    // (WSOL) SPL TOKEN ACCOUNT — the create path deserializes it as
    // InterfaceAccount<TokenAccount> and calls sync_native — so it MUST be a WSOL
    // token account (e.g. the treasury's WSOL ATA), NOT a wallet. Devnet = the
    // treasury/admin's WSOL ATA (created before deploy; see deploy-devnet.sh).
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("27AC7YwwAULHQcQXGErV7rHMsLZAUBWF6ozDNhSpTQE9");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("2sa31zceMSTAAbSu5wfSnNA6sBYzS7r97nvZYaQouEXa");
}

pub const AUTH_SEED: &str = "vault_and_lp_mint_auth_seed";

#[program]
pub mod raydium_cp_swap {
    use super::*;

    // The configuration of AMM protocol, include trade fee and protocol fee
    /// # Arguments
    ///
    /// * `ctx`- The accounts needed by instruction.
    /// * `index` - The index of amm config, there may be multiple config.
    /// * `trade_fee_rate` - Trade fee rate, can be changed.
    /// * `protocol_fee_rate` - The rate of protocol fee within trade fee.
    /// * `fund_fee_rate` - The rate of fund fee within trade fee.
    ///
    pub fn create_amm_config(
        ctx: Context<CreateAmmConfig>,
        index: u16,
        trade_fee_rate: u64,
        protocol_fee_rate: u64,
        fund_fee_rate: u64,
        create_pool_fee: u64,
        creator_fee_rate: u64,
    ) -> Result<()> {
        assert!(trade_fee_rate + creator_fee_rate < FEE_RATE_DENOMINATOR_VALUE);
        assert!(protocol_fee_rate <= FEE_RATE_DENOMINATOR_VALUE);
        assert!(fund_fee_rate <= FEE_RATE_DENOMINATOR_VALUE);
        assert!(fund_fee_rate + protocol_fee_rate <= FEE_RATE_DENOMINATOR_VALUE);
        instructions::create_amm_config(
            ctx,
            index,
            trade_fee_rate,
            protocol_fee_rate,
            fund_fee_rate,
            create_pool_fee,
            creator_fee_rate,
        )
    }

    /// Updates the owner of the amm config
    /// Must be called by the current owner or admin
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    /// * `trade_fee_rate`- The new trade fee rate of amm config, be set when `param` is 0
    /// * `protocol_fee_rate`- The new protocol fee rate of amm config, be set when `param` is 1
    /// * `fund_fee_rate`- The new fund fee rate of amm config, be set when `param` is 2
    /// * `new_owner`- The config's new owner, be set when `param` is 3
    /// * `new_fund_owner`- The config's new fund owner, be set when `param` is 4
    /// * `param`- The value can be 0 | 1 | 2 | 3 | 4, otherwise will report a error
    ///
    pub fn update_amm_config(ctx: Context<UpdateAmmConfig>, param: u8, value: u64) -> Result<()> {
        instructions::update_amm_config(ctx, param, value)
    }

    /// Update pool status for given value
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    /// * `status` - The value of status
    ///
    pub fn update_pool_status(ctx: Context<UpdatePoolStatus>, status: u8) -> Result<()> {
        instructions::update_pool_status(ctx, status)
    }

    /// Collect the protocol fee accrued to the pool
    ///
    /// # Arguments
    ///
    /// * `ctx` - The context of accounts
    /// * `amount_0_requested` - The maximum amount of token_0 to send, can be 0 to collect fees in only token_1
    /// * `amount_1_requested` - The maximum amount of token_1 to send, can be 0 to collect fees in only token_0
    ///
    pub fn collect_protocol_fee(
        ctx: Context<CollectProtocolFee>,
        amount_0_requested: u64,
        amount_1_requested: u64,
    ) -> Result<()> {
        instructions::collect_protocol_fee(ctx, amount_0_requested, amount_1_requested)
    }

    /// Collect the fund fee accrued to the pool
    ///
    /// # Arguments
    ///
    /// * `ctx` - The context of accounts
    /// * `amount_0_requested` - The maximum amount of token_0 to send, can be 0 to collect fees in only token_1
    /// * `amount_1_requested` - The maximum amount of token_1 to send, can be 0 to collect fees in only token_0
    ///
    pub fn collect_fund_fee(
        ctx: Context<CollectFundFee>,
        amount_0_requested: u64,
        amount_1_requested: u64,
    ) -> Result<()> {
        instructions::collect_fund_fee(ctx, amount_0_requested, amount_1_requested)
    }

    /// Collect the creator fee
    ///
    /// # Arguments
    ///
    /// * `ctx` - The context of accounts
    ///
    pub fn collect_creator_fee(ctx: Context<CollectCreatorFee>) -> Result<()> {
        instructions::collect_creator_fee(ctx)
    }

    /// Create a permission account
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    ///
    pub fn create_permission_pda(ctx: Context<CreatePermissionPda>) -> Result<()> {
        instructions::create_permission_pda(ctx)
    }

    /// Close a permission account
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    ///
    pub fn close_permission_pda(ctx: Context<ClosePermissionPda>) -> Result<()> {
        instructions::close_permission_pda(ctx)
    }

    /// Creates a pool for the given token pair and the initial price
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    /// * `init_amount_0` - the initial amount_0 to deposit
    /// * `init_amount_1` - the initial amount_1 to deposit
    /// * `open_time` - the timestamp allowed for swap
    ///
    pub fn initialize(
        ctx: Context<Initialize>,
        init_amount_0: u64,
        init_amount_1: u64,
        open_time: u64,
    ) -> Result<()> {
        instructions::initialize(ctx, init_amount_0, init_amount_1, open_time)
    }

    /// Create a pool with permission
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    /// * `init_amount_0` - the initial amount_0 to deposit
    /// * `init_amount_1` - the initial amount_1 to deposit
    /// * `open_time` - the timestamp allowed for swap
    /// * `creator_fee_on` - creator fee model, 0：both token0 and token1 (depends on the input), 1: only token0, 2: only token1
    ///
    pub fn initialize_with_permission(
        ctx: Context<InitializeWithPermission>,
        init_amount_0: u64,
        init_amount_1: u64,
        open_time: u64,
        creator_fee_on: CreatorFeeOn,
    ) -> Result<()> {
        instructions::initialize_with_permission(
            ctx,
            init_amount_0,
            init_amount_1,
            open_time,
            creator_fee_on,
        )
    }

    /// Deposit lp token to the pool
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    /// * `lp_token_amount` - Increased number of LPs
    /// * `maximum_token_0_amount` -  Maximum token 0 amount to deposit, prevents excessive slippage
    /// * `maximum_token_1_amount` - Maximum token 1 amount to deposit, prevents excessive slippage
    ///
    pub fn deposit(
        ctx: Context<Deposit>,
        lp_token_amount: u64,
        maximum_token_0_amount: u64,
        maximum_token_1_amount: u64,
    ) -> Result<()> {
        instructions::deposit(
            ctx,
            lp_token_amount,
            maximum_token_0_amount,
            maximum_token_1_amount,
        )
    }

    /// Withdraw lp for token0 and token1
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    /// * `lp_token_amount` - Amount of pool tokens to burn. User receives an output of token a and b based on the percentage of the pool tokens that are returned.
    /// * `minimum_token_0_amount` -  Minimum amount of token 0 to receive, prevents excessive slippage
    /// * `minimum_token_1_amount` -  Minimum amount of token 1 to receive, prevents excessive slippage
    ///
    pub fn withdraw(
        ctx: Context<Withdraw>,
        lp_token_amount: u64,
        minimum_token_0_amount: u64,
        minimum_token_1_amount: u64,
    ) -> Result<()> {
        instructions::withdraw(
            ctx,
            lp_token_amount,
            minimum_token_0_amount,
            minimum_token_1_amount,
        )
    }

    /// Swap the tokens in the pool base input amount
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    /// * `amount_in` -  input amount to transfer, output to DESTINATION is based on the exchange rate
    /// * `minimum_amount_out` -  Minimum amount of output token, prevents excessive slippage
    ///
    pub fn swap_base_input(
        ctx: Context<Swap>,
        amount_in: u64,
        minimum_amount_out: u64,
    ) -> Result<()> {
        instructions::swap_base_input(ctx, amount_in, minimum_amount_out)
    }

    /// Swap the tokens in the pool base output amount
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    /// * `max_amount_in` -  input amount prevents excessive slippage
    /// * `amount_out` -  amount of output token
    ///
    pub fn swap_base_output(ctx: Context<Swap>, max_amount_in: u64, amount_out: u64) -> Result<()> {
        instructions::swap_base_output(ctx, max_amount_in, amount_out)
    }

    /// Create support token22 mint account which can create pool and send rewards while ignoring unsupported extensions.
    pub fn create_support_mint_associated(ctx: Context<CreateSupportMintAssociated>) -> Result<()> {
        instructions::create_support_mint_associated(ctx)
    }

    /// Close support token22 mint account which can create pool and send rewards while ignoring unsupported extensions.
    pub fn close_support_mint_associated(ctx: Context<CloseSupportMintAssociated>) -> Result<()> {
        instructions::close_support_mint_associated(ctx)
    }
}
