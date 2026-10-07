pub mod curve;
pub mod error;
pub mod instructions;
pub mod states;
pub mod utils;
use crate::curve::fees::FEE_RATE_DENOMINATOR_VALUE;
use crate::error::ErrorCode;
use crate::states::PoolState;
use anchor_lang::prelude::*;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
    Metadata,
};
use anchor_spl::token_interface::Mint;
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
// instructions/admin/create_support_mint_associated.rs) plus, since 2026-10-06, ONE
// added instruction: `create_lp_metadata`, which gives a pool's lp token a name
// record. The whole of it (accounts, handler, two helpers) is in this file, under
// the "TEGRIDY FORK ADDITION" heading at the bottom. Every line of swap/curve/
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
declare_id!("EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT");

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
    // So whatever goes here must be system-owned and fundable. Mainnet = the Squads
    // v4 VAULT PDA GRMtSxgs… (vault index 0 of multisig EVGSnRZ…, 2-of-2), by owner
    // ruling 2026-09-25. It replaces the single operator-held key the closed
    // 2026-08 binary carried. The vault is system-owned with no data, signs through
    // a Squads vault transaction, and pays `CreateAmmConfig`'s rent from its own
    // lamports — so fund it before `create_amm_config`. Every admin action is now a
    // 2-of-2 proposal. Moving THIS constant again needs a program upgrade, because
    // it is resolved at compile time.
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("GgE6AfEH2AVSrKGckyKMzC6mhtXWiAn39EzAikAsWq5a");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd");
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

    /// Create the Metaplex name record of a pool's lp token mint. Anyone may call it and
    /// the caller pays. It takes no arguments: the name, the symbol and the link are fixed
    /// by the program.
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    ///
    pub fn create_lp_metadata(ctx: Context<CreateLpMetadata>) -> Result<()> {
        let (name, symbol, uri) = get_lp_metadata_data(ctx.accounts.lp_mint.key());
        initialize_metadata_account(
            &ctx.accounts.payer,
            &ctx.accounts.authority.to_account_info(),
            &ctx.accounts.lp_mint.to_account_info(),
            &ctx.accounts.metadata,
            &ctx.accounts.update_authority.to_account_info(),
            &ctx.accounts.metadata_program,
            &ctx.accounts.system_program,
            &ctx.accounts.rent,
            name,
            symbol,
            uri,
            &[&[crate::AUTH_SEED.as_bytes(), &[ctx.bumps.authority]]],
        )
    }
}

// ─── TEGRIDY FORK ADDITION (2026-10-06): create_lp_metadata ───────────────────
// The one instruction this fork adds to upstream. A pool's lp token is a classic SPL
// mint with no name record, so a wallet lists it as an unknown token. Metaplex only
// creates that record when the mint authority signs, and the mint authority is this
// program's own address (AUTH_SEED), so no wallet can ask for it: this program must.
//
// The helpers are Raydium CLMM's `get_metadata_data` and `initialize_metadata_account`
// (raydium-io/raydium-clmm @ ed7c84a54ced59c55981780546adb0b4583dcf85,
// programs/amm/src/instructions/open_position.rs, Apache-2.0, same Anchor 0.32.1).
// What differs from that source: the words; the record's editor is `admin::ID` and
// not the signing address; the editor does not sign; the record is mutable; no
// creator is listed; and both helpers are `#[inline(never)]` (see the stack note).
//
// WHO MAY CALL IT: anyone. That is safe because the caller chooses nothing. The name
// and symbol are fixed in `get_lp_metadata_data` and the link is built there from the
// lp mint address.
// `lp_mint` must be the mint recorded in `pool_state` (IncorrectLpMint), and
// `pool_state` must be a pool account this program owns, so a stranger's own mint
// that merely names AUTH_SEED as its mint authority cannot be given our label.
// Metaplex refuses a second record for the same mint, so it runs once per pool.
//
// WHO CAN EDIT THE RECORD LATER: `admin::ID` only (the Squads vault on mainnet), with
// a plain Metaplex update. This program has no update path. The editor must be an
// address that can sign: see the note in `mod admin` above.
//
// FUND SAFETY: the AUTH_SEED address that signs the inner call also owns every pool
// vault. The inner call gets six accounts and no remaining account. Four are fixed by
// the checks below: the lp mint and AUTH_SEED (read-only in their own slots), the
// editor and the System program. The caller picks two: the payer, which must sign, and
// the record slot, which this program does NOT check. So at most one slot can hold a
// vault or the token program, never both, and a program can only call one it was handed.
//
// STACK: an SBF frame over 4,096 bytes is only a linker warning and then faults on
// chain. `lp_mint` is boxed, `pool_state` is an `AccountLoader` (no copy), and the
// string building and the inner call each keep their own small frame.
#[derive(Accounts)]
pub struct CreateLpMetadata<'info> {
    /// Pays the record's rent and Metaplex's creation fee
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: pool vault and lp mint authority
    #[account(
        seeds = [
            crate::AUTH_SEED.as_bytes(),
        ],
        bump,
    )]
    pub authority: UncheckedAccount<'info>,

    pub pool_state: AccountLoader<'info, PoolState>,

    /// Lp token mint
    #[account(
        address = pool_state.load()?.lp_mint @ ErrorCode::IncorrectLpMint
    )]
    pub lp_mint: Box<InterfaceAccount<'info, Mint>>,

    /// To store metaplex metadata
    /// CHECK: Metaplex checks it is the record address derived for `lp_mint`
    #[account(mut)]
    pub metadata: UncheckedAccount<'info>,

    /// CHECK: the record's editor, which does not sign here
    #[account(
        address = crate::admin::ID
    )]
    pub update_authority: UncheckedAccount<'info>,

    /// Program to create the metadata record
    pub metadata_program: Program<'info, Metadata>,

    pub system_program: Program<'info, System>,

    pub rent: Sysvar<'info, Rent>,
}

#[inline(never)]
fn get_lp_metadata_data(lp_mint: Pubkey) -> (String, String, String) {
    return (
        String::from("Memetics Pool Share"),
        String::from("MEM-LP"),
        format!("https://memetics.finance/mint/{}.json", lp_mint.to_string()),
    );
}

#[inline(never)]
fn initialize_metadata_account<'info>(
    payer: &Signer<'info>,
    authority: &AccountInfo<'info>,
    lp_mint: &AccountInfo<'info>,
    metadata_account: &UncheckedAccount<'info>,
    update_authority: &AccountInfo<'info>,
    metadata_program: &Program<'info, Metadata>,
    system_program: &Program<'info, System>,
    rent: &Sysvar<'info, Rent>,
    name: String,
    symbol: String,
    uri: String,
    signers_seeds: &[&[&[u8]]],
) -> Result<()> {
    create_metadata_accounts_v3(
        CpiContext::new_with_signer(
            metadata_program.to_account_info(),
            CreateMetadataAccountsV3 {
                metadata: metadata_account.to_account_info(),
                mint: lp_mint.to_account_info(),
                mint_authority: authority.to_account_info(),
                payer: payer.to_account_info(),
                update_authority: update_authority.to_account_info(),
                system_program: system_program.to_account_info(),
                rent: rent.to_account_info(),
            },
            signers_seeds,
        ),
        DataV2 {
            name,
            symbol,
            uri,
            seller_fee_basis_points: 0,
            creators: None,
            collection: None,
            uses: None,
        },
        true,
        false,
        None,
    )?;
    Ok(())
}
