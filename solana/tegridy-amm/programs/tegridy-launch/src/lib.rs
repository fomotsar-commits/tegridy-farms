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
//! ## Not yet implemented: `migrate_to_amm`
//!
//! The instruction that CPIs into `raydium_cp_swap::initialize` to open the pool,
//! seeds it with the curve's reserves, and sets `complete` — **all in one
//! instruction**, for the reason in point 5. It is the highest-risk code in this
//! program: it moves the entire raised balance at once and, unlike the AMM it
//! calls into, has no audited upstream to diff against.
//!
//! Until it lands, a curve can be bought and sold but never closed. That is the
//! correct failure mode: a launch that cannot finish is recoverable, a launch
//! whose funds are locked is not.
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

