//! # Tegridy Launch — bonding curve
//!
//! The launch rail that feeds the Tegridy CP-AMM: a pump.fun-shaped constant
//! product over virtual reserves. A token bonds here, and on reaching its
//! graduation target its liquidity migrates into a **Tegridy CP-AMM pool** — the
//! venue the protocol owns — rather than a third party's.
//!
//! ## Verification status — read this before trusting anything here
//!
//! [`curve`] (the pricing surface and every rounding decision) is dependency-free
//! and **proven on the host**: `rustc --edition 2021 --test src/curve.rs`, 14
//! tests. Everything else in this file is **CI-compiled only** — see the local
//! build limitation below. Treat the Anchor layer as unreviewed until CI is green
//! AND a human has read it.
//!
//! ## Design decisions worth not re-deriving
//!
//! 1. **Launch terms are snapshotted onto the curve at creation.** `trade_fee_bps`
//!    and `graduation_target_lamports` are copied from [`GlobalConfig`] into each
//!    [`BondingCurve`], so a later governance change cannot retroactively rewrite
//!    the economics of a launch people have already bought into.
//! 2. **Pause blocks buys, never sells.** A halt must not trap holders in a
//!    position they cannot exit.
//! 3. **Mint authority is revoked at creation.** The full supply is minted onto
//!    the curve once and the authority set to `None`, so no further supply can
//!    ever appear. This is the single most important anti-rug property here.
//! 4. **A buy that would overshoot the graduation target is CAPPED, not
//!    rejected.** Rejecting would stall a curve one lamport short of graduating;
//!    letting it overshoot would let the last buyer size the migrated pool. The
//!    excess is refunded in the same instruction.
//! 5. **Graduation and migration MUST be atomic.** An earlier version split them
//!    — a permissionless `graduate` flipped `complete` and moved no funds — on the
//!    theory that isolating the state change shrank the blast radius of the risky
//!    part. It did the opposite: `buy` and `sell` both require `!complete`, `sell`
//!    is the only exit for SOL, and the migration instruction did not exist, so
//!    flipping the flag stranded every lamport raised, permanently, for anyone who
//!    cared to call it. That instruction has been REMOVED. Nothing may set
//!    `complete` until it can move the liquidity in the same breath.
//!
//! 6. **LP tokens are BURNED at migration.** Operator decision, 2026-07-29. It is
//!    the only option that makes "liquidity permanently locked" unconditionally
//!    true: holding the LP in the curve PDA leaves it reachable by a program
//!    upgrade, and handing it to the creator is a rug vector. Burning forecloses
//!    ever reclaiming that capital — accepted cost, not an oversight.
//!
//! ## `migrate_to_amm` — the highest-risk instruction here
//!
//! CPIs `raydium_cp_swap::initialize` to open the pool, seeds it, burns the LP,
//! and sets `complete` + `pool` — **all in one instruction**, per point 5. It
//! moves the entire raised balance at once and, unlike the AMM it calls into, has
//! no audited upstream to diff against. See MIGRATE_DESIGN.md for every decision
//! behind it, with the cp-swap facts marked VERIFIED against source.
//!
//! It depends on `raydium-cp-swap` with the `cpi` feature so the 20-account call
//! is type-checked rather than a hand-packed `invoke_signed`. That does not touch
//! the fork's audit story — `diff-guard` compares `programs/cp-swap/src` against
//! pinned upstream, and depending on a crate does not modify it.
//!
//! ## Constraints that are not negotiable
//!
//! - **This must stay a SEPARATE program from `cp-swap`.** `solana-ci.yml`'s
//!   `diff-guard` asserts `programs/cp-swap/src` differs from audited upstream in
//!   exactly two authority files. Folding launch logic in there breaks that and
//!   turns a cheap four-constant diff-audit into a full from-scratch AMM audit.
//! - **No TOWELI on Solana.** Standing doctrine, untouched by the own-venue
//!   decision. Nothing here mints, bridges, or references TOWELI.
//!
//! ## Local build limitation (environment, not code)
//!
//! SBF builds cannot run on the current Windows dev box: `cargo build-sbf` fails
//! installing platform-tools with `os error 1314` (symlink privilege), and cargo
//! build scripts are blocked by Application Control (`os error 4551`). Both hit
//! the *existing* cp-swap identically, so they are environmental. **CI
//! (`solana-ci.yml`, Ubuntu) is the compile gate for this program.**

use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};
use anchor_spl::token::spl_token::instruction::AuthorityType;

pub mod curve;
pub mod errors;
pub mod state;

use crate::curve::{
    lamports_until_target, max_reachable_real_sol, quote_buy, quote_sell, MAX_FEE_BPS,
};
use crate::errors::LaunchError;
use crate::state::*;

// PLACEHOLDER program id — a throwaway keypair generated only so the crate has a
// syntactically valid base58 id to compile against. It corresponds to no key
// anybody holds, and it MUST be replaced with a dedicated keypair before any
// deploy (devnet or mainnet), exactly as cp-swap's is. See MAINNET_RUNBOOK.md.
declare_id!("8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8");

/// The only key permitted to call [`tegridy_launch::initialize_global`].
///
/// Without this, `initialize_global` is a classic unprotected initializer: the
/// `global` PDA is a singleton at `[GLOBAL_SEED]`, so whoever calls it first owns
/// the protocol and receives every trade fee, permanently. Anyone watching the
/// deploy could take it in the block after the program lands.
///
/// Fail-closed by default, matching cp-swap's authority pattern: a non-devnet
/// build embeds the System Program id, which no one can sign for, so a mainnet
/// binary refuses to initialize until an operator sets a real key here. That is
/// deliberate — a placeholder that *works* is how this hole gets shipped.
/// NOTE: `pubkey!`, NOT `declare_id!`. `declare_id!` emits a whole program-identity
/// surface (`ID`, `id()`, `check_id()`), and a second one in the crate makes the
/// program's address ambiguous — Anchor's IDL generator picked THIS key as the
/// program address instead of the real one, which then failed at runtime as an
/// opaque "failed to sanitize accounts offsets" error. cp-swap's `mod admin` uses
/// `pubkey!` for exactly this reason; match it.
pub mod deployer {
    // Pulled from the parent scope (lib.rs does `use anchor_lang::prelude::*`),
    // exactly as cp-swap's `mod admin` does it. Importing
    // `anchor_lang::solana_program::pubkey` instead brings in the MODULE, not the
    // macro, and fails with "cannot find macro `pubkey` in this scope".
    use super::{pubkey, Pubkey};
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("8YVjjc5ibXQRewh7xtUQMTVR9rrBJjBj4kBMLpbr3kV8");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("11111111111111111111111111111111"); // SENTINEL (fail-closed)
}

#[program]
pub mod tegridy_launch {
    use super::*;

    /// One-time protocol configuration.
    ///
    /// `migration_reserve_lamports` is raised on top of the graduation target and
    /// kept back to pay migration costs — cp-swap's `initialize` charges
    /// `create_pool_fee` as a native SOL transfer from the creator and rent-funds
    /// five accounts, and the creator is the curve PDA. See MIGRATE_DESIGN.md.
    ///
    /// `cp_swap_program` / `amm_config` may both be zero here: the AmmConfig is
    /// created by a cp-swap admin action AFTER this program is deployed. They are
    /// configured rather than hardcoded, and `migrate_to_amm` must refuse to run
    /// while either is zero.
    pub fn initialize_global(
        ctx: Context<InitializeGlobal>,
        trade_fee_bps: u64,
        initial_virtual_sol: u64,
        initial_virtual_token: u64,
        token_total_supply: u64,
        graduation_target_lamports: u64,
        migration_reserve_lamports: u64,
        cp_swap_program: Pubkey,
        amm_config: Pubkey,
    ) -> Result<()> {
        require!(trade_fee_bps <= MAX_FEE_BPS, LaunchError::FeeTooHigh);
        // Zero virtual reserves would make the opening price undefined (division
        // by zero in the curve); zero supply or target would make a launch that
        // can never trade or never graduate.
        require!(initial_virtual_sol > 0, LaunchError::InvalidParameter);
        require!(initial_virtual_token > 0, LaunchError::InvalidParameter);
        require!(token_total_supply > 0, LaunchError::InvalidParameter);
        require!(graduation_target_lamports > 0, LaunchError::InvalidParameter);

        // A target above the curve's own reachable ceiling produces launches that
        // can NEVER graduate: buyers pay in until the token reserve runs down,
        // `buy` then fails its reserve check, and the curve never qualifies. That
        // is not fund loss (holders can still sell out) but the launch is dead and
        // can never reach the AMM, which is the whole point. Reject the config
        // rather than let it be discovered by a launch that silently cannot finish.
        //
        // Checked against target PLUS reserve, not the target alone: the reserve is
        // also raised by traders, so it counts toward the ceiling. Validating only
        // the target would let a reserve push the real requirement past what the
        // curve can ever produce — reintroducing the exact bug this guards.
        let required = graduation_target_lamports
            .checked_add(migration_reserve_lamports)
            .ok_or(LaunchError::Overflow)?;
        let ceiling = max_reachable_real_sol(
            initial_virtual_sol,
            initial_virtual_token,
            token_total_supply,
        )
        .map_err(LaunchError::from)?;
        require!(required < ceiling, LaunchError::GraduationTargetUnreachable);

        let g = &mut ctx.accounts.global;
        g.authority = ctx.accounts.authority.key();
        g.fee_recipient = ctx.accounts.fee_recipient.key();
        g.trade_fee_bps = trade_fee_bps;
        g.initial_virtual_sol = initial_virtual_sol;
        g.initial_virtual_token = initial_virtual_token;
        g.token_total_supply = token_total_supply;
        g.graduation_target_lamports = graduation_target_lamports;
        g.migration_reserve_lamports = migration_reserve_lamports;
        // MAY be zero at init: the AmmConfig is created by a cp-swap admin action
        // after this program is deployed, so it is set later via update_global.
        // migrate_to_amm must refuse to run while either is zero.
        g.cp_swap_program = cp_swap_program;
        g.amm_config = amm_config;
        g.paused = false;
        g.bump = ctx.bumps.global;
        Ok(())
    }

    /// Update mutable protocol parameters. Never affects a live curve — each
    /// launch snapshots its own terms at creation.
    /// `new_authority` / `new_fee_recipient` exist so neither is a one-shot
    /// decision baked in at initialization. Without them a fat-fingered
    /// `fee_recipient` would send every trade fee to the wrong address forever,
    /// and authority could never be rotated onto a rebuilt multisig.
    pub fn update_global(
        ctx: Context<UpdateGlobal>,
        trade_fee_bps: Option<u64>,
        graduation_target_lamports: Option<u64>,
        paused: Option<bool>,
        new_authority: Option<Pubkey>,
        new_fee_recipient: Option<Pubkey>,
    ) -> Result<()> {
        let g = &mut ctx.accounts.global;
        if let Some(f) = trade_fee_bps {
            require!(f <= MAX_FEE_BPS, LaunchError::FeeTooHigh);
            g.trade_fee_bps = f;
        }
        if let Some(t) = graduation_target_lamports {
            require!(t > 0, LaunchError::InvalidParameter);
            // Same reachability check as initialize_global — the curve parameters
            // are immutable, so a later target change can just as easily land
            // above the ceiling and start minting unfinishable launches.
            let ceiling = max_reachable_real_sol(
                g.initial_virtual_sol,
                g.initial_virtual_token,
                g.token_total_supply,
            )
            .map_err(LaunchError::from)?;
            require!(t < ceiling, LaunchError::GraduationTargetUnreachable);
            g.graduation_target_lamports = t;
        }
        if let Some(p) = paused {
            g.paused = p;
        }
        // Rotating to the default pubkey would brick the protocol irrecoverably —
        // no one can sign for the System Program id, so authority would be lost
        // and fees would burn. Reject rather than trust the caller.
        if let Some(a) = new_authority {
            require!(a != Pubkey::default(), LaunchError::InvalidParameter);
            g.authority = a;
        }
        if let Some(r) = new_fee_recipient {
            require!(r != Pubkey::default(), LaunchError::InvalidParameter);
            g.fee_recipient = r;
        }
        Ok(())
    }

    /// Open a launch: mint the whole supply onto a fresh curve and permanently
    /// revoke the mint authority.
    pub fn create_launch(ctx: Context<CreateLaunch>) -> Result<()> {
        let g = &ctx.accounts.global;
        require!(!g.paused, LaunchError::Paused);

        let supply = g.token_total_supply;

        // Mint the entire supply to the curve's vault while the creator still
        // holds the authority...
        token::mint_to(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_vault.to_account_info(),
                    authority: ctx.accounts.creator.to_account_info(),
                },
            ),
            supply,
        )?;

        // ...then destroy it. After this no further supply can EVER be created,
        // which is the property that makes the curve's token accounting sound.
        // Do it here, atomically with the mint, so there is no window in which a
        // launch exists with a live mint authority.
        token::set_authority(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.creator.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
            ),
            AuthorityType::MintTokens,
            None,
        )?;

        let c = &mut ctx.accounts.curve;
        c.mint = ctx.accounts.mint.key();
        c.creator = ctx.accounts.creator.key();
        c.virtual_sol_reserves = g.initial_virtual_sol;
        c.virtual_token_reserves = g.initial_virtual_token;
        c.real_sol_reserves = 0;
        c.real_token_reserves = supply;
        c.trade_fee_bps = g.trade_fee_bps;
        c.graduation_target_lamports = g.graduation_target_lamports;
        c.complete = false;
        c.bump = ctx.bumps.curve;

        emit!(LaunchCreated {
            mint: c.mint,
            creator: c.creator,
            virtual_sol_reserves: c.virtual_sol_reserves,
            virtual_token_reserves: c.virtual_token_reserves,
            token_total_supply: supply,
        });
        Ok(())
    }

    /// Spend lamports for tokens.
    ///
    /// `max_lamports_in` is an upper bound, not an exact amount: if the trade
    /// would carry the curve past its graduation target it is capped there and
    /// the remainder is simply never taken. `min_tokens_out` is the usual
    /// slippage floor.
    pub fn buy(ctx: Context<Trade>, max_lamports_in: u64, min_tokens_out: u64) -> Result<()> {
        require!(!ctx.accounts.global.paused, LaunchError::Paused);
        let curve = &ctx.accounts.curve;
        require!(!curve.complete, LaunchError::AlreadyComplete);

        let fee_bps = curve.trade_fee_bps;

        // Cap at the graduation target — see design note 4 in the module docs.
        let capped_in = match lamports_until_target(
            curve.real_sol_reserves,
            curve.graduation_target_lamports,
            fee_bps,
        )
        .map_err(LaunchError::from)?
        {
            Some(limit) => core::cmp::min(max_lamports_in, limit),
            // Already at/over target: the curve should have graduated.
            None => return Err(LaunchError::AlreadyComplete.into()),
        };
        require!(capped_in > 0, LaunchError::ZeroAmount);

        let q = quote_buy(
            curve.effective_sol()?,
            curve.effective_tokens()?,
            capped_in,
            fee_bps,
        )
        .map_err(LaunchError::from)?;

        require!(q.tokens_out >= min_tokens_out, LaunchError::SlippageExceeded);
        require!(
            q.tokens_out <= curve.real_token_reserves,
            LaunchError::InsufficientLiquidity
        );

        // Move SOL first: buyer -> curve (principal), buyer -> treasury (fee).
        // Both are plain system transfers signed by the buyer.
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.trader.to_account_info(),
                    to: ctx.accounts.curve.to_account_info(),
                },
            ),
            q.lamports_to_curve,
        )?;
        if q.fee_lamports > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.trader.to_account_info(),
                        to: ctx.accounts.fee_recipient.to_account_info(),
                    },
                ),
                q.fee_lamports,
            )?;
        }

        // Then tokens: curve vault -> buyer, signed by the curve PDA.
        let mint_key = ctx.accounts.mint.key();
        let seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[ctx.accounts.curve.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.curve_vault.to_account_info(),
                    to: ctx.accounts.trader_token_account.to_account_info(),
                    authority: ctx.accounts.curve.to_account_info(),
                },
                &[seeds],
            ),
            q.tokens_out,
        )?;

        let curve = &mut ctx.accounts.curve;
        curve.real_sol_reserves = curve
            .real_sol_reserves
            .checked_add(q.lamports_to_curve)
            .ok_or(LaunchError::Overflow)?;
        curve.real_token_reserves = curve
            .real_token_reserves
            .checked_sub(q.tokens_out)
            .ok_or(LaunchError::Overflow)?;

        emit!(Traded {
            mint: curve.mint,
            trader: ctx.accounts.trader.key(),
            is_buy: true,
            sol_amount: q.lamports_to_curve,
            token_amount: q.tokens_out,
            fee_lamports: q.fee_lamports,
            real_sol_reserves: curve.real_sol_reserves,
            real_token_reserves: curve.real_token_reserves,
        });
        Ok(())
    }

    /// Sell tokens back to the curve.
    ///
    /// Deliberately NOT gated on `global.paused` — see design note 2. A pause
    /// stops new money entering; it must never strand holders.
    pub fn sell(ctx: Context<Trade>, tokens_in: u64, min_lamports_out: u64) -> Result<()> {
        let curve = &ctx.accounts.curve;
        require!(!curve.complete, LaunchError::AlreadyComplete);
        require!(tokens_in > 0, LaunchError::ZeroAmount);

        let q = quote_sell(
            curve.effective_sol()?,
            curve.effective_tokens()?,
            tokens_in,
            curve.trade_fee_bps,
        )
        .map_err(LaunchError::from)?;

        require!(
            q.lamports_out >= min_lamports_out,
            LaunchError::SlippageExceeded
        );
        // The curve can only ever pay out REAL lamports; the virtual leg is
        // pricing fiction and must never be redeemable.
        require!(
            q.gross_lamports <= curve.real_sol_reserves,
            LaunchError::InsufficientLiquidity
        );

        // Tokens in first, signed by the seller.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.trader_token_account.to_account_info(),
                    to: ctx.accounts.curve_vault.to_account_info(),
                    authority: ctx.accounts.trader.to_account_info(),
                },
            ),
            tokens_in,
        )?;

        // Then lamports out. The curve PDA is program-owned, so its balance moves
        // by direct debit rather than a system transfer (a PDA cannot sign one).
        // Rent must survive the debit or the account would be purged mid-launch.
        let curve_ai = ctx.accounts.curve.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(curve_ai.data_len());
        let balance = curve_ai.lamports();
        require!(
            balance
                .checked_sub(q.gross_lamports)
                .ok_or(LaunchError::Overflow)?
                >= rent_floor,
            LaunchError::InsufficientRentExemptBalance
        );

        **curve_ai.try_borrow_mut_lamports()? = balance
            .checked_sub(q.gross_lamports)
            .ok_or(LaunchError::Overflow)?;
        **ctx.accounts.trader.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .trader
            .to_account_info()
            .lamports()
            .checked_add(q.lamports_out)
            .ok_or(LaunchError::Overflow)?;
        if q.fee_lamports > 0 {
            **ctx
                .accounts
                .fee_recipient
                .to_account_info()
                .try_borrow_mut_lamports()? = ctx
                .accounts
                .fee_recipient
                .to_account_info()
                .lamports()
                .checked_add(q.fee_lamports)
                .ok_or(LaunchError::Overflow)?;
        }

        let curve = &mut ctx.accounts.curve;
        curve.real_sol_reserves = curve
            .real_sol_reserves
            .checked_sub(q.gross_lamports)
            .ok_or(LaunchError::Overflow)?;
        curve.real_token_reserves = curve
            .real_token_reserves
            .checked_add(tokens_in)
            .ok_or(LaunchError::Overflow)?;

        emit!(Traded {
            mint: curve.mint,
            trader: ctx.accounts.trader.key(),
            is_buy: false,
            sol_amount: q.lamports_out,
            token_amount: tokens_in,
            fee_lamports: q.fee_lamports,
            real_sol_reserves: curve.real_sol_reserves,
            real_token_reserves: curve.real_token_reserves,
        });
        Ok(())
    }

    /// Graduate the curve into a Tegridy CP-AMM pool and BURN the LP.
    ///
    /// This is the single most dangerous instruction in the program: it moves the
    /// entire raised balance and closes the curve. Everything about it is designed
    /// so that either it all happens or none of it does.
    ///
    /// ## Why LP is burned
    ///
    /// Operator decision, 2026-07-29. Burning is the only option that makes a
    /// "liquidity permanently locked" claim unconditionally TRUE: holding the LP
    /// in the curve PDA leaves it reachable by a future program upgrade, and
    /// handing it to the creator is a rug vector. Burned LP survives even an
    /// upgrade-authority compromise. It also forecloses ever reclaiming that
    /// capital — that is the accepted cost, not an oversight.
    ///
    /// ## Why `complete` is set HERE and nowhere else
    ///
    /// `buy` and `sell` both require `!complete`, and `sell` is the only exit for
    /// SOL. A removed `graduate` instruction set the flag on its own and stranded
    /// every lamport of any launch that called it. A flag that closes the only
    /// exit must be written by the instruction that opens the new one — so this
    /// one, atomically with the pool being seeded.
    ///
    /// ## Permissionless, deliberately
    ///
    /// Takes no caller-chosen parameters, pays the caller nothing, and has exactly
    /// one legal outcome once the target is met. The `payer` funds account rent
    /// and is the only thing a caller contributes. Unlike the removed `graduate`,
    /// the outcome here is the DESIRED one, so anyone pushing a qualifying curve
    /// over the line is doing the protocol a favour.
    pub fn migrate_to_amm(ctx: Context<MigrateToAmm>) -> Result<()> {
        let g = &ctx.accounts.global;
        require!(!g.paused, LaunchError::Paused);

        // The AmmConfig is created by a cp-swap admin action AFTER this program
        // deploys, so both may legitimately be zero for a while. Refuse to run
        // rather than graduate into address(0).
        require!(
            g.cp_swap_program != Pubkey::default() && g.amm_config != Pubkey::default(),
            LaunchError::AmmNotConfigured
        );
        // Verify what we were HANDED against what was CONFIGURED. Without this a
        // caller substitutes a hostile AMM and the launch graduates into someone
        // else's pool with our liquidity.
        require!(
            ctx.accounts.cp_swap_program.key() == g.cp_swap_program
                && ctx.accounts.amm_config.key() == g.amm_config,
            LaunchError::AmmMismatch
        );

        let curve = &ctx.accounts.curve;
        require!(!curve.complete, LaunchError::AlreadyComplete);
        require!(
            curve.real_sol_reserves >= curve.graduation_target_lamports,
            LaunchError::NotReadyToGraduate
        );

        let deposit_lamports = curve.graduation_target_lamports;
        let deposit_tokens = curve.real_token_reserves;
        let mint_key = curve.mint;
        let curve_bump = curve.bump;

        // The curve PDA must retain enough lamports beyond the deposit to cover
        // cp-swap's create_pool_fee (charged as a NATIVE SOL transfer from the
        // creator, initialize.rs:318-325) plus rent on five accounts it creates.
        // Checked BEFORE anything moves: discovering the shortfall mid-migration
        // would leave the curve half-graduated.
        let curve_ai = ctx.accounts.curve.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(curve_ai.data_len());
        let spendable = curve_ai
            .lamports()
            .checked_sub(rent_floor)
            .ok_or(LaunchError::InsufficientRentExemptBalance)?;
        require!(
            spendable >= deposit_lamports.checked_add(g.migration_reserve_lamports).ok_or(LaunchError::Overflow)?,
            LaunchError::MigrationReserveTooLow
        );

        let seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[curve_bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        // ── 1. Wrap the deposit into WSOL ────────────────────────────────────
        // cp-swap takes both legs as TokenAccounts; our SOL leg is raw lamports.
        //
        // NOT a system_program::transfer. The System program requires the SOURCE
        // account to be System-owned, and the curve PDA holds this program's data
        // so it is owned by US — a system transfer from it fails at runtime, every
        // time. (`cargo check` accepts it happily, which is exactly why this
        // comment exists.) Move the lamports directly instead, the same way `sell`
        // pays out: a program may debit only accounts it owns, and may credit any
        // account, so debit-curve + credit-WSOL is permitted.
        let wsol_ai = ctx.accounts.curve_wsol.to_account_info();
        **curve_ai.try_borrow_mut_lamports()? = curve_ai
            .lamports()
            .checked_sub(deposit_lamports)
            .ok_or(LaunchError::Overflow)?;
        **wsol_ai.try_borrow_mut_lamports()? = wsol_ai
            .lamports()
            .checked_add(deposit_lamports)
            .ok_or(LaunchError::Overflow)?;

        // Lamports alone do not make a WSOL balance — sync_native is what turns
        // the account's lamports into its token amount. Without it cp-swap would
        // see a zero-balance token account and seed the pool with nothing.
        token::sync_native(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::SyncNative {
                account: wsol_ai.clone(),
            },
        ))?;

        // ── 2. Sort the mints ────────────────────────────────────────────────
        // cp-swap CONSTRAINS token_0_mint < token_1_mint, so getting this backwards
        // is a hard revert. Amounts and accounts must travel with their mint.
        let wsol_is_0 = ctx.accounts.wsol_mint.key() < ctx.accounts.launch_mint.key();
        let (amount_0, amount_1) = if wsol_is_0 {
            (deposit_lamports, deposit_tokens)
        } else {
            (deposit_tokens, deposit_lamports)
        };

        // ── 3. Open + seed the pool ──────────────────────────────────────────
        let cpi_accounts = raydium_cp_swap::cpi::accounts::Initialize {
            creator: curve_ai.clone(),
            amm_config: ctx.accounts.amm_config.to_account_info(),
            authority: ctx.accounts.amm_authority.to_account_info(),
            pool_state: ctx.accounts.pool_state.to_account_info(),
            token_0_mint: if wsol_is_0 {
                ctx.accounts.wsol_mint.to_account_info()
            } else {
                ctx.accounts.launch_mint.to_account_info()
            },
            token_1_mint: if wsol_is_0 {
                ctx.accounts.launch_mint.to_account_info()
            } else {
                ctx.accounts.wsol_mint.to_account_info()
            },
            lp_mint: ctx.accounts.lp_mint.to_account_info(),
            creator_token_0: if wsol_is_0 {
                ctx.accounts.curve_wsol.to_account_info()
            } else {
                ctx.accounts.curve_vault.to_account_info()
            },
            creator_token_1: if wsol_is_0 {
                ctx.accounts.curve_vault.to_account_info()
            } else {
                ctx.accounts.curve_wsol.to_account_info()
            },
            creator_lp_token: ctx.accounts.curve_lp.to_account_info(),
            token_0_vault: ctx.accounts.token_0_vault.to_account_info(),
            token_1_vault: ctx.accounts.token_1_vault.to_account_info(),
            create_pool_fee: ctx.accounts.create_pool_fee.to_account_info(),
            observation_state: ctx.accounts.observation_state.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
            token_0_program: ctx.accounts.token_program.to_account_info(),
            token_1_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            rent: ctx.accounts.rent.to_account_info(),
        };
        raydium_cp_swap::cpi::initialize(
            CpiContext::new_with_signer(
                ctx.accounts.cp_swap_program.to_account_info(),
                cpi_accounts,
                signer,
            ),
            amount_0,
            amount_1,
            // Open immediately. A future open_time would leave the pool
            // un-tradeable while the curve is already closed — a dead window with
            // no exit, which is the failure mode this program keeps guarding.
            0,
        )?;

        // ── 4. BURN the LP ───────────────────────────────────────────────────
        ctx.accounts.curve_lp.reload()?;
        let lp_amount = ctx.accounts.curve_lp.amount;
        if lp_amount > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::Burn {
                        mint: ctx.accounts.lp_mint.to_account_info(),
                        from: ctx.accounts.curve_lp.to_account_info(),
                        authority: curve_ai.clone(),
                    },
                    signer,
                ),
                lp_amount,
            )?;
        }
        // Assert the burn actually emptied it. "Liquidity permanently locked" is a
        // published claim; leaving any LP behind would make it false, and a
        // silently-partial burn is exactly the kind of thing nobody notices.
        ctx.accounts.curve_lp.reload()?;
        require!(ctx.accounts.curve_lp.amount == 0, LaunchError::LpNotBurned);

        // ── 5. Close the curve, atomically with all of the above ─────────────
        let pool = ctx.accounts.pool_state.key();
        let curve = &mut ctx.accounts.curve;
        curve.real_sol_reserves = curve
            .real_sol_reserves
            .checked_sub(deposit_lamports)
            .ok_or(LaunchError::Overflow)?;
        curve.real_token_reserves = 0;
        curve.complete = true;
        curve.pool = pool;

        emit!(Graduated {
            mint: mint_key,
            sol_reserves: deposit_lamports,
            token_reserves: deposit_tokens,
        });
        Ok(())
    }

    // ─────────────────────────────────────────────────────────────────────────
    // `graduate` REMOVED — it was a permissionless total-loss bug.
    //
    // It set `complete = true` and moved no funds, on the reasoning that
    // splitting the state transition from the fund movement would shrink the
    // blast radius of the risky part. The split CREATED the risk instead:
    //
    //   - `buy` and `sell` both require `!complete`
    //   - `sell` is the ONLY instruction that moves SOL out of a curve
    //   - `migrate_to_amm` does not exist yet
    //
    // so flipping `complete` stranded 100% of the raised SOL with no exit for
    // anyone, ever. And it was permissionless — I argued that was safe because
    // the instruction "takes no parameters and has exactly one legal outcome, so
    // there is nothing to choose or extract". Wrong: the outcome itself was the
    // attack. Any passer-by could brick any qualifying launch for the price of a
    // transaction.
    //
    // The lesson generalises: a state transition that CLOSES the only exit is
    // not made safer by separating it from the fund movement it depends on.
    // Graduation and migration must land ATOMICALLY, so there is no window in
    // which a curve is closed but its liquidity has not moved.
    //
    // `migrate_to_amm` will therefore do both in one instruction: seed the
    // cp-swap pool AND set `complete`. Until it exists, no instruction may set
    // `complete` — the `complete` field and the `Graduated` event are retained
    // for that future instruction to use.
    // ─────────────────────────────────────────────────────────────────────────
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    /// Must be the hardcoded [`deployer`] key — see that module for why an
    /// unconstrained signer here is a protocol-capture hole.
    #[account(mut, address = deployer::ID @ LaunchError::NotDeployAuthority)]
    pub authority: Signer<'info>,
    /// CHECK: destination for trade fees; validated only as an address. Mainnet
    /// this is the treasury's Squads vault.
    pub fee_recipient: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [GLOBAL_SEED],
        bump
    )]
    pub global: Account<'info, GlobalConfig>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateGlobal<'info> {
    #[account(
        mut,
        seeds = [GLOBAL_SEED],
        bump = global.bump,
        has_one = authority @ LaunchError::Unauthorized
    )]
    pub global: Account<'info, GlobalConfig>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct CreateLaunch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, GlobalConfig>,

    /// The launch token. Must still be mint-authority-held by the creator; this
    /// instruction mints the supply and then revokes that authority forever.
    ///
    /// ## The freeze-authority constraint is load-bearing — do not remove it
    ///
    /// Revoking the MINT authority alone does NOT make a launch rug-proof. A mint
    /// may also carry a **freeze authority**, and SPL Token lets its holder freeze
    /// any token account of that mint. A creator who kept one could:
    ///   - freeze `curve_vault` (a deterministic PDA at [VAULT_SEED, mint], so its
    ///     address is public from creation). The vault is the SOURCE of every buy
    ///     transfer and the DESTINATION of every sell transfer, so freezing it
    ///     bricks both at once and locks 100% of raised SOL forever — there is no
    ///     admin withdrawal and `graduate` moves no funds; or
    ///   - freeze holders' token accounts selectively, leaving their own liquid,
    ///     then sell into a curve nobody else can exit.
    ///
    /// Rejecting a mint that has one is the complete fix: SPL Token can never
    /// re-add a freeze authority once it is `None`, so a mint that passes here can
    /// never acquire one later. Revoking it instead would be strictly weaker — it
    /// only works when the creator IS the freeze authority, and silently fails to
    /// protect against a mint whose freeze authority is a third party.
    #[account(
        mut,
        constraint = mint.mint_authority == anchor_lang::solana_program::program_option::COption::Some(creator.key())
            @ LaunchError::Unauthorized,
        constraint = mint.supply == 0 @ LaunchError::InvalidParameter,
        constraint = mint.freeze_authority.is_none() @ LaunchError::MintHasFreezeAuthority,
    )]
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = creator,
        space = 8 + BondingCurve::INIT_SPACE,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump
    )]
    pub curve: Account<'info, BondingCurve>,

    #[account(
        init,
        payer = creator,
        token::mint = mint,
        token::authority = curve,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump
    )]
    pub curve_vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

/// Accounts for [`tegridy_launch::migrate_to_amm`].
///
/// Large because cp-swap's `initialize` takes 20 accounts and we must forward all
/// of them. The PDAs cp-swap derives itself (pool_state, vaults, lp_mint,
/// observation_state, its authority) are passed as `UncheckedAccount` — cp-swap
/// validates each against its own seeds, so re-deriving them here would duplicate
/// its logic with no added safety and a real chance of drifting from it.
#[derive(Accounts)]
pub struct MigrateToAmm<'info> {
    /// Funds rent for the accounts created along the way. Any caller may pay;
    /// this is the only thing a caller contributes and it buys them nothing.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, GlobalConfig>,

    pub launch_mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [CURVE_SEED, launch_mint.key().as_ref()],
        bump = curve.bump,
        constraint = curve.mint == launch_mint.key() @ LaunchError::InvalidParameter
    )]
    pub curve: Account<'info, BondingCurve>,

    /// The curve's token vault — becomes cp-swap's `creator_token_*` for the
    /// launch-token leg.
    #[account(
        mut,
        seeds = [VAULT_SEED, launch_mint.key().as_ref()],
        bump,
        constraint = curve_vault.mint == launch_mint.key() @ LaunchError::InvalidParameter
    )]
    pub curve_vault: Account<'info, TokenAccount>,

    /// Native mint. Address-checked so a fake "WSOL" cannot be substituted.
    #[account(address = anchor_spl::token::spl_token::native_mint::ID @ LaunchError::InvalidParameter)]
    pub wsol_mint: Account<'info, Mint>,

    /// The curve's WSOL account — the SOL leg, wrapped in step 1.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = curve
    )]
    pub curve_wsol: Account<'info, TokenAccount>,

    /// Receives the LP that is then burned. Owned by the curve so the curve can
    /// authorize the burn.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = lp_mint,
        associated_token::authority = curve
    )]
    pub curve_lp: Account<'info, TokenAccount>,

    // ── cp-swap ──────────────────────────────────────────────────────────────
    /// CHECK: matched against `global.cp_swap_program` in the handler.
    pub cp_swap_program: UncheckedAccount<'info>,
    /// CHECK: matched against `global.amm_config` in the handler.
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: cp-swap's vault/LP-mint authority PDA; it validates its own seeds.
    pub amm_authority: UncheckedAccount<'info>,
    /// CHECK: cp-swap `init`s and validates this.
    #[account(mut)]
    pub pool_state: UncheckedAccount<'info>,
    /// CHECK: cp-swap `init`s and validates this.
    #[account(mut)]
    pub lp_mint: UncheckedAccount<'info>,
    /// CHECK: cp-swap `init`s and validates this.
    #[account(mut)]
    pub token_0_vault: UncheckedAccount<'info>,
    /// CHECK: cp-swap `init`s and validates this.
    #[account(mut)]
    pub token_1_vault: UncheckedAccount<'info>,
    /// CHECK: cp-swap constrains this to its own `create_pool_fee_reveiver::ID`,
    /// so we cannot redirect the fee even if we wanted to.
    #[account(mut)]
    pub create_pool_fee: UncheckedAccount<'info>,
    /// CHECK: cp-swap `init`s and validates this.
    #[account(mut)]
    pub observation_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Account<'info, GlobalConfig>,

    /// CHECK: must be the address the config designates; enforced below.
    #[account(mut, address = global.fee_recipient @ LaunchError::Unauthorized)]
    pub fee_recipient: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        seeds = [CURVE_SEED, mint.key().as_ref()],
        bump = curve.bump,
        has_one = mint @ LaunchError::InvalidParameter
    )]
    pub curve: Account<'info, BondingCurve>,

    #[account(
        mut,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
        constraint = curve_vault.mint == mint.key() @ LaunchError::InvalidParameter
    )]
    pub curve_vault: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = trader_token_account.mint == mint.key() @ LaunchError::InvalidParameter,
        constraint = trader_token_account.owner == trader.key() @ LaunchError::Unauthorized
    )]
    pub trader_token_account: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

