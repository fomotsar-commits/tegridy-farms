pub mod curve;
pub mod error;
pub mod instructions;
pub mod states;
pub mod utils;
use crate::curve::fees::FEE_RATE_DENOMINATOR_VALUE;
use crate::error::ErrorCode;
use crate::states::{
    AmmConfig, FeesSwept, KeeperChanged, PoolState, MAX_CREATE_POOL_FEE, MAX_FEE_RATE_NUMERATOR,
    MAX_PROTOCOL_AND_FUND_FEE_RATE,
};
use crate::utils::token::transfer_from_pool_vault_to_user;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::metadata::{
    create_metadata_accounts_v3, mpl_token_metadata::types::DataV2, CreateMetadataAccountsV3,
    Metadata,
};
use anchor_spl::token::Token;
use anchor_spl::token_interface::{Mint, Token2022, TokenAccount};
use instructions::*;
pub use states::CreatorFeeOn;

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "tegridy-cp-amm",
    project_url: "https://memetics.finance",
    contacts: "email:fomotsar@gmail.com,link:https://memetics.finance/.well-known/security.txt",
    policy: "https://memetics.finance/source/solana/tegridy-amm/SECURITY.md",
    source_code: "https://memetics.finance/source/solana/tegridy-amm",
    preferred_languages: "en"
    // AUDITORS line intentionally REMOVED (was upstream's Raydium/MadShield audit):
    // this fork's diff-audit is PENDING; the upstream audit does NOT cover it, so
    // claiming it on-chain would be false. Every link above is on our own domain:
    // never put a git-host URL in this macro (docs/TODO_OPERATOR.md O-0929-10).
}

// ─── TEGRIDY FORK CHANGES (2026-07-11) ────────────────────────────────────────
// The ENTIRE code delta from upstream raydium-cp-swap (Apache-2.0) is 4 authority/
// identity constants (3 here + create_support_mint_associated_owner in
// instructions/admin/create_support_mint_associated.rs) plus THREE added instructions:
// `create_lp_metadata` (since 2026-10-06), which gives a pool's lp token a name record,
// `resign_keeper` (since 2026-11-14, below) and `sweep_fees` (since 2026-11-15, below),
// each a "TEGRIDY FORK ADDITION" at the bottom of this file, plus these rules:
//   - 2026-10-19, initialize.rs: a public pool cannot open on the launch tier (index 0).
//   - 2026-11-03, the range-pool program's fee rules: only a tier's fund owner collects
//     the fund fee (collect_fund_fee.rs); a tier charges a trader more than 0 and at most
//     4% (its keeper apart, since 2026-11-11: below), and keeps at most 20% of its trade fee
//     for the protocol and fund owners together (here and update_config.rs; constants in
//     states/config.rs).
//   - 2026-11-03, update_config.rs: the admin hands a tier's fund fee over once, while it
//     still holds it, and can never point it anywhere else after that.
//   - 2026-11-03, utils/token.rs: MINT_WHITELIST deleted, as upstream itself deleted it
//     (59fb845); a support-mint record no longer skips the Token-2022 extension check.
//   - 2026-11-10, the swap guard: on a tier the admin has switched it on for, a swap that
//     another program calls is refused unless the tier's keeper signs it; a wallet's own
//     swap never is. Off on every tier until then (states/config.rs `swap_guard`, `keeper`
//     and `refuses_swap`; checked first in swap_base_input.rs and swap_base_output.rs; set
//     by update_config.rs params 8 and 9; error.rs `SwapNotDirect`).
//   - 2026-11-11, the keeper's fee: a tier's keeper (param 9 above) swaps on that tier free
//     of the trade fee and the creator fee, so it pays no protocol or fund share either.
//     Everyone else pays as upstream. With no keeper named, nobody is free. The rates are
//     chosen in states/config.rs `swap_fee_rates`, used in swap_base_input.rs and
//     swap_base_output.rs; the curve and fee arithmetic is not touched.
//   - 2026-11-14, the keeper resigns: a tier's keeper can give the role up itself, at once,
//     signing alone (`resign_keeper`, the second instruction this fork adds, at the bottom of
//     this file), so a stolen keeper key is switched off without waiting on the admin's
//     proposal and its lock. Only a wallet's key may be named keeper (update_config.rs param 9,
//     states/config.rs `may_name_keeper`), and every change of keeper or guard is logged.
//   - 2026-11-15, the sweep: anyone may move a pool's whole protocol share to the protocol
//     owner's own token accounts and its whole fund share to the fund owner's (`sweep_fees`,
//     the third instruction this fork adds, at the bottom of this file). The program derives
//     every destination itself, so the caller chooses nothing; the hand collects are untouched.
// The security.txt above is ours too, on our own domain since 2026-10-06. Every line of
// swap/curve/fee arithmetic is byte-identical to the audited upstream; since 2026-11-11 the
// swaps hand it rates of 0 when a tier's keeper signs. The per-swap
// PROTOCOL fee is NOT here: it accrues per `amm_config.protocol_fee_rate` and is
// collected by `amm_config.protocol_owner` (which create_config sets = the admin caller),
// or swept to that owner's own token accounts by anyone (`sweep_fees`).
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
    // fallback collector on collect_protocol_fee (can sweep accrued protocol fees to any
    // recipient) — a fund-touching, top-tier key. Since 2026-11-03 it is not one on
    // collect_fund_fee: only the tier's fund owner collects the fund fee, and the admin
    // hands that role over only once (update_config.rs).
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
    // it is resolved at compile time. Before moving it, hand over every tier whose fund
    // owner is still this key: update_config.rs lets only the running build's admin hand
    // a fund fee over, so a tier left on the old key could not be handed over again.
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
        // memetics.finance: a trade fee of 0 makes every swap into a public pool revert
        // (split_creator_fee divides by the two rates' sum), so it is refused.
        assert!(trade_fee_rate > 0);
        assert!(trade_fee_rate + creator_fee_rate <= MAX_FEE_RATE_NUMERATOR);
        assert!(protocol_fee_rate <= FEE_RATE_DENOMINATOR_VALUE);
        assert!(fund_fee_rate <= FEE_RATE_DENOMINATOR_VALUE);
        assert!(fund_fee_rate + protocol_fee_rate <= MAX_PROTOCOL_AND_FUND_FEE_RATE);
        assert!(create_pool_fee <= MAX_CREATE_POOL_FEE);
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
    /// * memetics.finance, 2026-11-10: `param` 8 sets the tier's swap guard to `value` (0 off,
    ///   1 on, anything else is refused); `param` 9 sets the tier's keeper to the first
    ///   remaining account (the System Program's address clears it). Since 2026-11-11 the
    ///   keeper also swaps on the tier free of the trade and creator fees. Since 2026-11-14 a
    ///   keeper must be a wallet's key (a program's address is refused, 6017
    ///   `KeeperNotAWallet`), and params 8 and 9 log `SwapGuardChanged` and `KeeperChanged`
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

    /// The tier's keeper gives the role up, signing alone: the tier is left with no keeper
    /// (the all-zero key), as the admin's `update_amm_config` param 9 would leave it, but at
    /// once, with no proposal and no lock. Anyone else is refused (6016 `NotKeeper`), and so is
    /// a resignation another program calls, even with the keeper's signature.
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    ///
    pub fn resign_keeper(ctx: Context<ResignKeeper>) -> Result<()> {
        // memetics.finance, 2026-11-15: sent directly, the swap guard's own test, so no program
        // the keeper hands its signature to can end the role.
        require!(
            anchor_lang::solana_program::instruction::get_stack_height()
                <= anchor_lang::solana_program::instruction::TRANSACTION_LEVEL_STACK_HEIGHT,
            ErrorCode::NotKeeper
        );
        let amm_config = &mut ctx.accounts.amm_config;
        let old_keeper = amm_config.keeper;
        amm_config.keeper = Pubkey::default();
        emit!(KeeperChanged {
            amm_config: amm_config.key(),
            old_keeper,
            new_keeper: Pubkey::default(),
            resigned: true,
        });
        Ok(())
    }

    /// Move a pool's whole protocol share to the protocol owner's own token accounts and its
    /// whole fund share to the fund owner's, in one call anyone may make. The program derives
    /// each destination from the pool's fee tier (that owner's associated token account for the
    /// coin) and refuses any other (6018 `NotFeeOwnersAccount`). Nothing else moves, and the
    /// pool's price does not: the curve never counts the shares set aside.
    ///
    /// # Arguments
    ///
    /// * `ctx`- The context of accounts
    ///
    pub fn sweep_fees(ctx: Context<SweepFees>) -> Result<()> {
        sweep_pool_fees(ctx)
    }
}

// ─── TEGRIDY FORK ADDITION (2026-11-14): resign_keeper ────────────────────────
// The second instruction this fork adds: a tier's keeper (update_config.rs param 9) ends its
// own role at once, where the admin's change waits on a 48-hour proposal. WHO MAY CALL IT: the
// keeper the tier names, as the signer, in an instruction of the transaction itself (the
// handler reads the stack height as the swap guard does). It sets that one tier's keeper to the
// all-zero key; no account is created or closed, no lamport or token moves.
#[derive(Accounts)]
pub struct ResignKeeper<'info> {
    /// The tier's keeper, the only signer
    pub keeper: Signer<'info>,

    /// The fee tier it gives up
    #[account(mut, constraint = amm_config.is_keeper(keeper.key) @ ErrorCode::NotKeeper)]
    pub amm_config: Account<'info, AmmConfig>,
}

// ─── TEGRIDY FORK ADDITION (2026-11-15): sweep_fees ───────────────────────────
// The third instruction this fork adds. Every swap sets aside the protocol's and the fund's
// shares of its fee inside the pool's own vaults (`protocol_fees_token_*` and
// `fund_fees_token_*`, states/pool.rs), and upstream lets only their owners collect them, by
// hand, to any account they choose. On mainnet the protocol owner is the Squads vault (2 of 2,
// 48-hour lock), so the venue's share sat in every pool until someone proposed a collect. The
// owner's ruling of 2026-11-15: every fee of the venue lands in the treasury by itself, and
// the island's share in the island's own wallet.
//
// WHO MAY CALL IT: anyone, who pays the network fee and signs nothing else. That is safe
// because the caller chooses nothing. The pool's own fee tier names both owners; each
// destination must be that owner's associated token account for that coin, under the token
// program that owns the coin, derived here; and it must still belong to that owner (a classic
// token account's owner can be handed over, and a handed-over one is refused). Anything else:
// 6018 `NotFeeOwnersAccount`.
// WHAT IT MOVES: the four amounts set aside, each to its owner, and the four counts to zero.
// Nothing else: the creator fee, the curve's tokens, the lp supply and the tier are untouched.
// The price does not move, since the curve reads the vaults less every share set aside
// (pool.rs `vault_amount_without_fee`). An amount of 0 moves nothing (utils/token.rs). The
// hand collects, `collect_protocol_fee` and `collect_fund_fee`, are unchanged.
// THE DESTINATIONS MUST ALREADY EXIST: the caller first creates any that do not, with the
// associated token account program's CreateIdempotent, which anyone may pay for. This program
// creates no account.
// STACK: the tier and every token account are boxed, the pool is an `AccountLoader`, and the
// transfers run in their own frame (`sweep_pool_fees`).
#[derive(Accounts)]
pub struct SweepFees<'info> {
    /// CHECK: pool vault and lp mint authority
    #[account(
        seeds = [
            crate::AUTH_SEED.as_bytes(),
        ],
        bump,
    )]
    pub authority: UncheckedAccount<'info>,

    /// The pool whose set-aside shares are swept
    #[account(mut)]
    pub pool_state: AccountLoader<'info, PoolState>,

    /// The pool's fee tier: it names the protocol owner and the fund owner
    #[account(address = pool_state.load()?.amm_config)]
    pub amm_config: Box<Account<'info, AmmConfig>>,

    /// The pool's vault of token_0
    #[account(
        mut,
        constraint = token_0_vault.key() == pool_state.load()?.token_0_vault
    )]
    pub token_0_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The pool's vault of token_1
    #[account(
        mut,
        constraint = token_1_vault.key() == pool_state.load()?.token_1_vault
    )]
    pub token_1_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The mint of token_0 vault
    #[account(address = token_0_vault.mint)]
    pub vault_0_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The mint of token_1 vault
    #[account(address = token_1_vault.mint)]
    pub vault_1_mint: Box<InterfaceAccount<'info, Mint>>,

    /// The protocol owner's own token_0 account
    #[account(
        mut,
        address = owners_account(&amm_config.protocol_owner, &vault_0_mint) @ ErrorCode::NotFeeOwnersAccount,
        constraint = protocol_token_0_account.owner == amm_config.protocol_owner @ ErrorCode::NotFeeOwnersAccount
    )]
    pub protocol_token_0_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The protocol owner's own token_1 account
    #[account(
        mut,
        address = owners_account(&amm_config.protocol_owner, &vault_1_mint) @ ErrorCode::NotFeeOwnersAccount,
        constraint = protocol_token_1_account.owner == amm_config.protocol_owner @ ErrorCode::NotFeeOwnersAccount
    )]
    pub protocol_token_1_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The fund owner's own token_0 account
    #[account(
        mut,
        address = owners_account(&amm_config.fund_owner, &vault_0_mint) @ ErrorCode::NotFeeOwnersAccount,
        constraint = fund_token_0_account.owner == amm_config.fund_owner @ ErrorCode::NotFeeOwnersAccount
    )]
    pub fund_token_0_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The fund owner's own token_1 account
    #[account(
        mut,
        address = owners_account(&amm_config.fund_owner, &vault_1_mint) @ ErrorCode::NotFeeOwnersAccount,
        constraint = fund_token_1_account.owner == amm_config.fund_owner @ ErrorCode::NotFeeOwnersAccount
    )]
    pub fund_token_1_account: Box<InterfaceAccount<'info, TokenAccount>>,

    /// The SPL program to perform token transfers
    pub token_program: Program<'info, Token>,

    /// The SPL program 2022 to perform token transfers
    pub token_program_2022: Program<'info, Token2022>,
}

/// `owner`'s associated token account for `mint`, under the token program that owns `mint`.
fn owners_account(owner: &Pubkey, mint: &InterfaceAccount<'_, Mint>) -> Pubkey {
    let info = mint.to_account_info();
    get_associated_token_address_with_program_id(owner, &mint.key(), info.owner)
}

/// The token program a mint belongs to: classic Token or Token-2022, as the hand collects choose.
fn token_program_of<'info>(
    mint: &AccountInfo<'info>,
    token_program: &Program<'info, Token>,
    token_program_2022: &Program<'info, Token2022>,
) -> AccountInfo<'info> {
    if mint.owner == token_program.key {
        token_program.to_account_info()
    } else {
        token_program_2022.to_account_info()
    }
}

#[inline(never)]
fn sweep_pool_fees(ctx: Context<SweepFees>) -> Result<()> {
    let (protocol_0, protocol_1, fund_0, fund_1, auth_bump) = {
        let mut pool_state = ctx.accounts.pool_state.load_mut()?;
        let set_aside = (
            pool_state.protocol_fees_token_0,
            pool_state.protocol_fees_token_1,
            pool_state.fund_fees_token_0,
            pool_state.fund_fees_token_1,
            pool_state.auth_bump,
        );
        pool_state.protocol_fees_token_0 = 0;
        pool_state.protocol_fees_token_1 = 0;
        pool_state.fund_fees_token_0 = 0;
        pool_state.fund_fees_token_1 = 0;
        pool_state.recent_epoch = Clock::get()?.epoch;
        set_aside
    };
    let a = &ctx.accounts;
    let seeds: &[&[&[u8]]] = &[&[crate::AUTH_SEED.as_bytes(), &[auth_bump]]];
    for (vault, mint, to, amount) in [
        (&a.token_0_vault, &a.vault_0_mint, &a.protocol_token_0_account, protocol_0),
        (&a.token_1_vault, &a.vault_1_mint, &a.protocol_token_1_account, protocol_1),
        (&a.token_0_vault, &a.vault_0_mint, &a.fund_token_0_account, fund_0),
        (&a.token_1_vault, &a.vault_1_mint, &a.fund_token_1_account, fund_1),
    ] {
        let mint_info = mint.to_account_info();
        transfer_from_pool_vault_to_user(
            a.authority.to_account_info(),
            vault.to_account_info(),
            to.to_account_info(),
            mint_info.clone(),
            token_program_of(&mint_info, &a.token_program, &a.token_program_2022),
            amount,
            mint.decimals,
            seeds,
        )?;
    }
    emit!(FeesSwept {
        pool_state: a.pool_state.key(),
        protocol_owner: a.amm_config.protocol_owner,
        fund_owner: a.amm_config.fund_owner,
        protocol_fees_token_0: protocol_0,
        protocol_fees_token_1: protocol_1,
        fund_fees_token_0: fund_0,
        fund_fees_token_1: fund_1,
    });
    Ok(())
}

// ─── TEGRIDY FORK ADDITION (2026-10-06): create_lp_metadata ───────────────────
// The first instruction this fork adds to upstream. A pool's lp token is a classic SPL
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

#[cfg(test)]
mod resign_keeper_test {
    use super::*;
    // Off chain, anchor-lang's get_stack_height asks solana-sysvar's stubs; anchor-spl's path is
    // the one this crate already has to them.
    use anchor_spl::associated_token::spl_associated_token_account::solana_program::program_stubs::{
        set_syscall_stubs, SyscallStubs,
    };
    use std::cell::Cell;

    std::thread_local!(static STACK_HEIGHT: Cell<u64> = Cell::new(1));

    /// The runtime's stack height as this test's thread sets it: 1 for an instruction of the
    /// transaction itself, 2 or more for one another program calls.
    struct StackHeight;
    impl SyscallStubs for StackHeight {
        fn sol_get_stack_height(&self) -> u64 {
            STACK_HEIGHT.with(Cell::get)
        }
    }

    fn account(key: Pubkey, is_signer: bool, data: Vec<u8>) -> &'static AccountInfo<'static> {
        Box::leak(Box::new(AccountInfo::new(
            Box::leak(Box::new(key)),
            is_signer,
            true,
            Box::leak(Box::new(1_000_000u64)),
            Box::leak(data.into_boxed_slice()),
            Box::leak(Box::new(crate::id())),
            false,
            0,
        )))
    }

    /// The tier's own keeper sends `resign_keeper` at `stack_height`: what the program answers,
    /// the keeper, and the tier's keeper afterwards.
    fn resign_at(stack_height: u64) -> (Result<()>, Pubkey, Pubkey) {
        set_syscall_stubs(Box::new(StackHeight));
        STACK_HEIGHT.with(|h| h.set(stack_height));
        let keeper = Pubkey::new_unique();
        let mut data = Vec::new();
        AmmConfig {
            swap_guard: 1,
            keeper,
            ..Default::default()
        }
        .try_serialize(&mut data)
        .unwrap();
        let mut accounts = ResignKeeper {
            keeper: Signer::try_from(account(keeper, true, Vec::new())).unwrap(),
            amm_config: Account::try_from(account(Pubkey::new_unique(), false, data)).unwrap(),
        };
        let answer = raydium_cp_swap::resign_keeper(Context::new(
            &crate::id(),
            &mut accounts,
            &[],
            ResignKeeperBumps {},
        ));
        (answer, keeper, accounts.amm_config.keeper)
    }

    #[test]
    fn the_keeper_resigns_in_an_instruction_of_the_transaction_itself() {
        let (answer, _, after) = resign_at(1);
        answer.unwrap();
        assert_eq!(after, Pubkey::default());
    }

    #[test]
    fn a_resignation_another_program_calls_is_refused_even_with_the_keepers_signature() {
        for height in [2, 3, 5] {
            let (answer, keeper, after) = resign_at(height);
            assert!(
                matches!(answer, Err(e) if format!("{e:?}").contains("NotKeeper")),
                "at stack height {height}"
            );
            assert_eq!(after, keeper, "the tier keeps its keeper");
        }
    }
}
