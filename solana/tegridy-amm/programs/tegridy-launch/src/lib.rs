//! # Tegridy Launch — bonding curve
//!
//! The launch rail that feeds the Tegridy CP-AMM: a virtual-reserve constant
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
//! 6. **There is exactly ONE pricing curve.** A second "segmented" (Meteora-shaped)
//!    mode was removed before it priced a lamport; `GlobalConfig` no longer carries a
//!    shape and `create_launch` no longer takes a mode. See the note on
//!    [`state::GlobalConfig`] for the evidence — two proven failures with no economic
//!    gate between them and the venue, and a fix that would have meant bespoke core
//!    math on the money path for a feature nobody used.
//!
//! 7. **LP tokens are BURNED at migration.** Operator decision, 2026-07-29. It is
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
//! It depends on `raydium-cp-swap` with the `cpi` feature so the 21-account call
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
// For `.data()` on cp-swap's generated instruction args. `migrate_to_amm` hand-builds
// that one instruction so it can mark `pool_state` as a signer, which Anchor's typed
// CPI cannot express — see the comment at the invoke site.
use anchor_lang::InstructionData;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};
use anchor_spl::token::spl_token::instruction::AuthorityType;

pub mod curve;
pub mod errors;
pub mod state;

use crate::curve::{
    graduation_price_ratio_bps, lamports_until_target, max_reachable_real_sol, quote_buy,
    quote_sell, split_fee, BPS_DENOMINATOR, MAX_FEE_BPS, PRICE_CONTINUITY_BAND_BPS,
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
    // PLACEHOLDER, and deliberately NOT the program-id value above — see
    // bayla-ladder's audit note (L-5, 2026-09-06), where the two were identical and
    // the initializer became uncallable. `launch-constraints` overwrites this with a
    // fresh CI wallet before every build, so the committed value is never the one
    // tested; but a placeholder equal to the program id reads as intentional and
    // produces an uncallable initializer for anyone building `--features devnet`
    // outside CI.
    //
    // KEEP THIS COMMENT ABOVE THE `cfg` ATTRIBUTE. The patcher in solana-ci.yml
    // matches the attribute and the `pub const` on consecutive lines, and it asserts
    // the program-id macro name never appears after `pub mod deployer {`.
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("EMQVYMPe2UffGAVNYK6ZveCFM2tHjc5DBiXGKYFE6DXA");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("11111111111111111111111111111111"); // SENTINEL (fail-closed)
}

/// Every economic sanity check a launch configuration must pass.
///
/// ONE function, called by both `initialize_global` and `update_global`, on purpose.
/// The last time these validations were written separately, `update_global`'s comment
/// claimed to be "the same reachability check as initialize_global" while silently
/// omitting the migration reserve. Anything added here is added to both by
/// construction.
fn check_launch_economics(
    virtual_sol: u64,
    virtual_token: u64,
    token_supply: u64,
    graduation_target: u64,
    migration_reserve: u64,
) -> Result<()> {
    // The reserve must at least cover the rent cp-swap charges the creator. It is
    // snapshotted onto every curve at creation, so setting it too low does not fail
    // here — it fails at the finish line of every launch created afterwards, with
    // the pool already half-built and no way back. See MIN_MIGRATION_RESERVE_LAMPORTS
    // for why this is a floor rather than the full requirement.
    require!(
        migration_reserve >= MIN_MIGRATION_RESERVE_LAMPORTS,
        LaunchError::MigrationReserveTooLow
    );

    let ratio = graduation_price_ratio_bps(
        virtual_sol,
        virtual_token,
        token_supply,
        graduation_target,
        migration_reserve,
    )
    .map_err(LaunchError::from)?;
    let lo = BPS_DENOMINATOR.saturating_sub(PRICE_CONTINUITY_BAND_BPS);
    let hi = BPS_DENOMINATOR.saturating_add(PRICE_CONTINUITY_BAND_BPS);
    require!(
        (lo..=hi).contains(&ratio),
        LaunchError::GraduationPriceGap
    );
    Ok(())
}

/// Decide what the creator can actually be paid on this trade, folding the
/// remainder into the protocol leg.
///
/// ## Why this exists — the creator wallet is otherwise a kill switch on SELLS
///
/// `curve.creator` is an arbitrary key the creator chose, and paying it makes it
/// a WRITABLE account of every trade. Solana verifies the rent state of every
/// writable account at the end of the instruction and REJECTS a transition into
/// the rent-paying band: an account at 0 lamports that receives less than
/// `minimum_balance(data_len)` (890,880 for a 0-byte account) fails the whole
/// transaction with `InsufficientFundsForRent`.
///
/// So a creator who drains their wallet to 0 — legal, since 0 is the
/// Uninitialized state — makes EVERY trade whose creator leg lands under that
/// floor revert. At a 1% fee and a 50% share that is every trade below ~0.178
/// SOL, **including sells**, which is the holders' only exit and the one thing
/// design note 2 promises can never be blocked. Worse, it is profitable and
/// repeatable: anyone can unbrick the curve by donating the rent-exempt minimum
/// to the creator address, and the creator can pocket it and re-drain.
///
/// Folding is the fix that keeps the trade path total-conserving and
/// non-custodial. We never hold a creator's money for later (that is the
/// Believe-style custody failure), we never revert their holders' exit, and the
/// protocol leg absorbs what could not be delivered — which is exactly where the
/// whole fee went before the split existed, so this can never be worse than the
/// pre-split behaviour for `fee_recipient`.
///
/// Self-healing: the moment the creator's wallet is rent-exempt (it was, when
/// they paid rent for `create_launch`), every trade pays them again in full.
fn payable_creator_split(
    creator_ai: &AccountInfo,
    fs: crate::curve::FeeSplit,
) -> Result<(u64, u64)> {
    if fs.creator_lamports == 0 {
        return Ok((0, fs.protocol_lamports));
    }
    // Measured against the creator account's OWN data length: a data-carrying
    // account (another program's PDA can sign `create_launch` via CPI) has a
    // proportionally higher floor.
    let floor = Rent::get()?.minimum_balance(creator_ai.data_len());
    if curve::lands_in_rent_band(creator_ai.lamports(), fs.creator_lamports, floor)
        .map_err(LaunchError::from)?
    {
        let protocol = fs
            .protocol_lamports
            .checked_add(fs.creator_lamports)
            .ok_or(LaunchError::Overflow)?;
        return Ok((0, protocol));
    }
    Ok((fs.creator_lamports, fs.protocol_lamports))
}

/// Decide what the PROTOCOL leg can actually be paid on this trade.
///
/// ## Why this exists — the treasury is otherwise a kill switch on SELLS
///
/// The exact hazard [`payable_creator_split`] documents for the creator wallet, on
/// the other leg: `fee_recipient` is a WRITABLE account of every trade, and Solana
/// rejects an Uninitialized -> RentPaying transition, so a treasury sitting at 0
/// lamports makes every trade whose protocol leg lands under
/// `minimum_balance(data_len)` revert with `InsufficientFundsForRent` — a runtime
/// fault with no error code of ours, which reads as an RPC or wallet problem. At a
/// 1% fee and a 48% creator share that is every trade below ~0.171 SOL, **including
/// sells**, which design note 2 promises can never be blocked.
///
/// It is reachable by ordinary operations, not just by attack: rotating
/// `fee_recipient` to a fresh address with `update_global` produces it immediately,
/// and so does sweeping the treasury to zero.
///
/// ## Why this WAIVES rather than folds
///
/// The creator leg has somewhere to go — its remainder folds into the protocol leg,
/// so the trade's total is unchanged. The protocol leg has nowhere. The three
/// candidates were:
///
///   - **revert** — the current behaviour, and the bug.
///   - **fold into the curve** — desynchronises the quote from the deposit. The buy
///     cap (`lamports_until_target`) sizes the raise to land exactly on
///     `target + reserve`; crediting a waived fee to the curve as well overshoots
///     that ceiling, and `tokens_out` was priced for the un-folded amount.
///   - **waive** — the trader simply is not charged the undeliverable leg.
///
/// Waiving keeps the path total-conserving with no accounting to reconcile, and it
/// cannot be turned into an extraction: it fires only while the treasury is below
/// its own rent floor, it pays nobody but the trader who was going to be blocked,
/// and it self-heals the moment the treasury is funded. Losing a fee is strictly
/// better than losing the exit.
///
/// Returns the deliverable protocol amount; the difference is never collected.
fn payable_protocol_leg(fee_recipient_ai: &AccountInfo, protocol_lamports: u64) -> Result<u64> {
    if protocol_lamports == 0 {
        return Ok(0);
    }
    // Measured against the recipient account's OWN data length, matching the creator
    // leg: a treasury that is a data-carrying PDA has a proportionally higher floor.
    let floor = Rent::get()?.minimum_balance(fee_recipient_ai.data_len());
    if curve::lands_in_rent_band(fee_recipient_ai.lamports(), protocol_lamports, floor)
        .map_err(LaunchError::from)?
    {
        return Ok(0);
    }
    Ok(protocol_lamports)
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
        creator_fee_share_bps: u64,
        initial_virtual_sol: u64,
        initial_virtual_token: u64,
        token_total_supply: u64,
        graduation_target_lamports: u64,
        migration_reserve_lamports: u64,
        cp_swap_program: Pubkey,
        amm_config: Pubkey,
    ) -> Result<()> {
        require!(trade_fee_bps <= MAX_FEE_BPS, LaunchError::FeeTooHigh);
        // A share of the FEE, so 100% is the natural bound — anything above it
        // would pay the creator more than the trade charged.
        require!(
            creator_fee_share_bps <= BPS_DENOMINATOR,
            LaunchError::InvalidParameter
        );
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

        // The launch must LIST at roughly the price its last curve buyer paid.
        //
        // The curve prices on virtual+real; the pool is seeded with real reserves
        // only. Those agree at exactly one target, and away from it the token gaps
        // the moment it lists — this repo's original parameters opened the pool at
        // 14% of the curve's final price, a ~7x drop with nothing stolen and no
        // instruction at fault. Checked here because it is a property of the
        // CONFIGURATION, and by migration time it is far too late.
        //
        // This constrains nothing that matters: the continuity target scales with
        // virtual SOL, so any target stays reachable by scaling the opening book.
        // `curve::continuity_target` computes the exact value.
        check_launch_economics(
            initial_virtual_sol,
            initial_virtual_token,
            token_total_supply,
            graduation_target_lamports,
            migration_reserve_lamports,
        )?;

        let g = &mut ctx.accounts.global;
        g.authority = ctx.accounts.authority.key();
        g.fee_recipient = ctx.accounts.fee_recipient.key();
        g.trade_fee_bps = trade_fee_bps;
        g.creator_fee_share_bps = creator_fee_share_bps;
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
        migration_reserve_lamports: Option<u64>,
        new_cp_swap_program: Option<Pubkey>,
        new_amm_config: Option<Pubkey>,
        new_initial_virtual_sol: Option<u64>,
        new_creator_fee_share_bps: Option<u64>,
    ) -> Result<()> {
        let g = &mut ctx.accounts.global;
        if let Some(f) = trade_fee_bps {
            require!(f <= MAX_FEE_BPS, LaunchError::FeeTooHigh);
            g.trade_fee_bps = f;
        }
        // Future launches only — every live curve snapshotted its own share at
        // creation, exactly like the fee itself.
        if let Some(s) = new_creator_fee_share_bps {
            require!(s <= BPS_DENOMINATOR, LaunchError::InvalidParameter);
            g.creator_fee_share_bps = s;
        }

        // Target and reserve are validated TOGETHER, and either may change here.
        //
        // Both are raised by traders, so both count toward the curve's ceiling. An
        // earlier version checked only the incoming target — its comment claimed to
        // be "the same reachability check as initialize_global" while omitting the
        // reserve, so raising the target could push `target + reserve` past the
        // ceiling and start minting launches that can never graduate. That is
        // exactly the bug initialize_global's check exists to prevent.
        //
        // Resolve the post-update pair, then validate the SUM once.
        // `initial_virtual_sol` is retunable HERE and nowhere else, because the
        // continuity target is proportional to it: without this, a target could never
        // be changed at all once set — every alternative value would gap. Each launch
        // snapshots its own virtual reserves at `create_launch` (lib.rs:361), so this
        // moves future launches only and can never reprice a live curve.
        if graduation_target_lamports.is_some()
            || migration_reserve_lamports.is_some()
            || new_initial_virtual_sol.is_some()
        {
            let new_target = graduation_target_lamports.unwrap_or(g.graduation_target_lamports);
            let new_reserve = migration_reserve_lamports.unwrap_or(g.migration_reserve_lamports);
            let new_vsol = new_initial_virtual_sol.unwrap_or(g.initial_virtual_sol);
            require!(
                new_target > 0 && new_vsol > 0,
                LaunchError::InvalidParameter
            );
            let required = new_target
                .checked_add(new_reserve)
                .ok_or(LaunchError::Overflow)?;
            let ceiling = max_reachable_real_sol(
                new_vsol,
                g.initial_virtual_token,
                g.token_total_supply,
            )
            .map_err(LaunchError::from)?;
            require!(
                required < ceiling,
                LaunchError::GraduationTargetUnreachable
            );
            // Same continuity gate as initialize_global — actually shared this time,
            // via one helper, rather than a comment claiming the checks match while
            // one of them quietly omits a term.
            check_launch_economics(
                new_vsol,
                g.initial_virtual_token,
                g.token_total_supply,
                new_target,
                new_reserve,
            )?;
            g.graduation_target_lamports = new_target;
            g.migration_reserve_lamports = new_reserve;
            g.initial_virtual_sol = new_vsol;
        }

        // The AMM addresses MUST be settable after initialization.
        //
        // `initialize_global` accepts them as zero on purpose — the cp-swap AmmConfig
        // is created by a cp-swap admin action AFTER this program is deployed. But
        // `global` is a singleton PDA, so `initialize_global` runs exactly once, and
        // `migrate_to_amm` refuses to run while either address is zero. Without a
        // setter here, following that documented order left migration PERMANENTLY
        // disabled, fixable only by a program upgrade. CI never caught it because the
        // tests create the AmmConfig first and pass real values at initialization.
        //
        // Zero is rejected rather than accepted as a "disable" value: a silent zero
        // would surface later as `AmmNotConfigured` and read like a setup mistake.
        // `paused` is the intended kill switch — it blocks `migrate_to_amm` too.
        if let Some(p) = new_cp_swap_program {
            require!(p != Pubkey::default(), LaunchError::InvalidParameter);
            g.cp_swap_program = p;
        }
        if let Some(c) = new_amm_config {
            require!(c != Pubkey::default(), LaunchError::InvalidParameter);
            g.amm_config = c;
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
    ///
    /// Takes no curve parameters. Every economic term — fee, creator share, virtual
    /// reserves, supply, target, reserve — is copied from [`GlobalConfig`], which has
    /// already passed [`check_launch_economics`]. A creator chooses WHETHER to launch,
    /// never on what shape, so no launch can exist whose economics were not gated.
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
        c.creator_fee_share_bps = g.creator_fee_share_bps;
        c.graduation_target_lamports = g.graduation_target_lamports;
        c.migration_reserve_lamports = g.migration_reserve_lamports;
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

        // Cap at target + RESERVE, not the target alone — see design note 4.
        //
        // Capping at the target made the migration reserve unraisable: buys stopped
        // dead on the target and every further one was rejected, so the curve could
        // never accumulate what migration costs. Migration would then fail for
        // insufficient lamports — the precise failure the reserve exists to
        // prevent. Caught by the CI rehearsal, which could not fund the reserve.
        let raise_ceiling = curve
            .graduation_target_lamports
            .checked_add(curve.migration_reserve_lamports)
            .ok_or(LaunchError::Overflow)?;
        let capped_in =
            match lamports_until_target(curve.real_sol_reserves, raise_ceiling, fee_bps)
                .map_err(LaunchError::from)?
            {
                Some(limit) => core::cmp::min(max_lamports_in, limit),
                // Fully funded and waiting on migration — NOT the same thing as
                // graduated. Returning AlreadyComplete here (as an earlier version
                // did) tells a caller the curve has moved to an AMM pool when it
                // has not, and makes the two states indistinguishable.
                None => return Err(LaunchError::AwaitingMigration.into()),
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

        // The fee splits creator/protocol per the share snapshotted on the curve.
        // Splitting the FEE (not the trade) keeps the curve math untouched: the
        // principal leg and the total charged are identical to the unsplit case.
        let fs = split_fee(q.fee_lamports, curve.creator_fee_share_bps)
            .map_err(LaunchError::from)?;
        // A credit that would strand the creator account in the rent-paying band
        // folds into the protocol leg rather than reverting the trade. See
        // `payable_creator_split`.
        let (creator_pay, folded_protocol_pay) =
            payable_creator_split(&ctx.accounts.creator.to_account_info(), fs)?;
        // ...and a protocol credit that would strand the TREASURY in the same band is
        // waived rather than reverting the trade. See `payable_protocol_leg`. The
        // waived amount is never taken from the trader, so `max_lamports_in` remains
        // an upper bound and the curve's principal leg is untouched.
        let protocol_pay = payable_protocol_leg(
            &ctx.accounts.fee_recipient.to_account_info(),
            folded_protocol_pay,
        )?;

        // Move SOL first: buyer -> curve (principal), buyer -> creator (their
        // fee share), buyer -> treasury (the rest). All plain system transfers
        // signed by the buyer — non-custodial by construction: the creator's cut
        // never rests in a protocol-controlled account.
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
        if creator_pay > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.trader.to_account_info(),
                        to: ctx.accounts.creator.to_account_info(),
                    },
                ),
                creator_pay,
            )?;
        }
        if protocol_pay > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.trader.to_account_info(),
                        to: ctx.accounts.fee_recipient.to_account_info(),
                    },
                ),
                protocol_pay,
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
            // What was ACTUALLY collected, not what the fee schedule implies. A
            // waived protocol leg must not be reported to indexers as revenue —
            // an outage of the fee path has to read as an outage, never as income.
            fee_lamports: creator_pay
                .checked_add(protocol_pay)
                .ok_or(LaunchError::Overflow)?,
            // What the creator was ACTUALLY paid, not what the share implies —
            // a folded credit must not be reported to indexers as earnings.
            creator_fee_lamports: creator_pay,
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
        //
        // The debit is `lamports_out + creator_pay + protocol_pay`, and the two fee
        // legs are resolved BEFORE it is computed, because either may be reduced:
        // the creator's cut folds into the protocol's when it would strand the
        // creator in the rent-paying band, and the protocol's is waived when it would
        // strand the treasury there. Both keep the holders' exit open — see
        // `payable_creator_split` and `payable_protocol_leg`. A waived leg simply
        // stays on the curve, so the path is total-conserving either way.
        //
        // All four touched accounts are instruction accounts and NO CPI follows these
        // writes, so route (a) — the end-of-instruction flush — reconciles every half
        // together. Appending any CPI after this block reintroduces the
        // UnbalancedInstruction defect documented in `migrate_to_amm`.
        let fs = split_fee(q.fee_lamports, curve.creator_fee_share_bps)
            .map_err(LaunchError::from)?;
        let (creator_pay, folded_protocol_pay) =
            payable_creator_split(&ctx.accounts.creator.to_account_info(), fs)?;
        let protocol_pay = payable_protocol_leg(
            &ctx.accounts.fee_recipient.to_account_info(),
            folded_protocol_pay,
        )?;

        // What actually leaves the curve. Never more than `q.gross_lamports`, which
        // the reserve check above already cleared.
        let debit = q
            .lamports_out
            .checked_add(creator_pay)
            .ok_or(LaunchError::Overflow)?
            .checked_add(protocol_pay)
            .ok_or(LaunchError::Overflow)?;

        // Rent must survive the debit or the account would be purged mid-launch.
        let curve_ai = ctx.accounts.curve.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(curve_ai.data_len());
        let balance = curve_ai.lamports();
        require!(
            balance
                .checked_sub(debit)
                .ok_or(LaunchError::Overflow)?
                >= rent_floor,
            LaunchError::InsufficientRentExemptBalance
        );

        **curve_ai.try_borrow_mut_lamports()? = balance
            .checked_sub(debit)
            .ok_or(LaunchError::Overflow)?;
        **ctx.accounts.trader.to_account_info().try_borrow_mut_lamports()? = ctx
            .accounts
            .trader
            .to_account_info()
            .lamports()
            .checked_add(q.lamports_out)
            .ok_or(LaunchError::Overflow)?;
        // Creator first, then protocol — each read-then-write completes before
        // the next begins, so the sums stay correct even when creator aliases
        // trader or fee_recipient (the same account passed under two names).
        if creator_pay > 0 {
            **ctx
                .accounts
                .creator
                .to_account_info()
                .try_borrow_mut_lamports()? = ctx
                .accounts
                .creator
                .to_account_info()
                .lamports()
                .checked_add(creator_pay)
                .ok_or(LaunchError::Overflow)?;
        }
        if protocol_pay > 0 {
            **ctx
                .accounts
                .fee_recipient
                .to_account_info()
                .try_borrow_mut_lamports()? = ctx
                .accounts
                .fee_recipient
                .to_account_info()
                .lamports()
                .checked_add(protocol_pay)
                .ok_or(LaunchError::Overflow)?;
        }

        let curve = &mut ctx.accounts.curve;
        // Debited by what LEFT, not by what was quoted. A waived protocol leg stays
        // on the curve, and the accounting must agree with the balance or the next
        // sell's reserve check is measuring a number the account does not hold.
        curve.real_sol_reserves = curve
            .real_sol_reserves
            .checked_sub(debit)
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
            // Collected, not scheduled — see the buy path.
            fee_lamports: creator_pay
                .checked_add(protocol_pay)
                .ok_or(LaunchError::Overflow)?,
            creator_fee_lamports: creator_pay,
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

        // Gate on the ACCOUNTING quantity, because that is what the debit at the end
        // of this instruction uses.
        //
        // This used to read `real_sol_reserves >= graduation_target_lamports`, which
        // omitted the reserve — while the `spendable` check below measured the PDA's
        // actual lamports, which anyone can inflate by sending it a donation. One
        // lamport into the curve address turned a genuinely under-raised launch into
        // a migration that ran the whole sequence — five account creations, the WSOL
        // wrap, cp-swap's pool build, the LP burn, ~250k CU — and then underflowed the
        // subtraction at the very end and returned `Overflow` (6000). Atomic, so
        // nothing was lost; but a keeper reading 6000 on the highest-stakes
        // instruction in the system has no way to learn the curve was simply short.
        //
        // Checking the sum here makes that subtraction unreachable by construction and
        // gives one honest error code. It costs nothing: `buy` caps the raise at
        // exactly `target + reserve`, so no legitimately funded curve is affected.
        // The `spendable` check stays as the independent rent-survival guard it was
        // always meant to be, rather than doubling as the funding test.
        let move_lamports = curve
            .graduation_target_lamports
            .checked_add(curve.migration_reserve_lamports)
            .ok_or(LaunchError::Overflow)?;
        require!(
            curve.real_sol_reserves >= move_lamports,
            LaunchError::NotReadyToGraduate
        );

        let deposit_lamports = curve.graduation_target_lamports;
        let deposit_tokens = curve.real_token_reserves;
        let mint_key = curve.mint;
        let curve_bump = curve.bump;
        // The launch creator's own wallet, snapshotted at `create_launch` and pinned
        // by the `address = curve.creator` constraint on the account. It becomes the
        // cp-swap pool's `pool_creator`, which is written ONCE and is the only key
        // `collect_creator_fee` will ever accept — see the CPI comment below.
        let pool_creator_key = curve.creator;

        // The curve PDA must retain enough lamports beyond the deposit to cover
        // cp-swap's create_pool_fee (charged as a NATIVE SOL transfer from the payer,
        // in `initialize_with_permission`) plus rent on five accounts it creates.
        // Checked BEFORE anything moves: discovering the shortfall mid-migration
        // would leave the curve half-graduated.
        let curve_ai = ctx.accounts.curve.to_account_info();
        let rent_floor = Rent::get()?.minimum_balance(curve_ai.data_len());
        let spendable = curve_ai
            .lamports()
            .checked_sub(rent_floor)
            .ok_or(LaunchError::InsufficientRentExemptBalance)?;
        require!(spendable >= move_lamports, LaunchError::MigrationReserveTooLow);

        // ── The cp-swap permission account ───────────────────────────────────
        //
        // `initialize_with_permission` declares `permission` as an existing
        // `Account<Permission>` at ["permission", payer] — cp-swap validates the
        // seeds itself, so this check is not a security control and does not pretend
        // to be one. It exists so a missing permission account surfaces as a NAMED
        // error here instead of Anchor's `AccountNotInitialized` from inside a CPI,
        // 250k CU deep, on the one instruction in this program that moves an entire
        // launch's raised balance. That is precisely the shape that gets misdiagnosed
        // as "the launch program is broken".
        //
        // Creating it is a one-time cp-swap ADMIN action (`create_permission_pda` is
        // gated on `admin::ID`), against the program-wide migration authority. Until
        // it is done, no launch can graduate — fail-closed, loudly, and before
        // anything moves.
        let permission_ai = ctx.accounts.cp_swap_permission.to_account_info();
        require!(
            !permission_ai.data_is_empty()
                && permission_ai.owner == &ctx.accounts.cp_swap_program.key(),
            LaunchError::MigrationPermissionMissing
        );

        let seeds: &[&[u8]] = &[CURVE_SEED, mint_key.as_ref(), &[curve_bump]];
        let signer: &[&[&[u8]]] = &[seeds];

        // ── 1. Fund the migration authority and stage both legs on it ────────
        //
        // cp-swap's `payer` must be BOTH the signer and the rent payer for five
        // `init` accounts. Rent goes through the System program's `CreateAccount`,
        // which demands a System-owned payer — so it cannot be the curve PDA, which
        // holds this program's data. The data-less `migration_authority` PDA
        // satisfies both roles.
        //
        // The curve cannot System-transfer to the authority either: `transfer`
        // rejects a `from` that carries data ("Transfer: `from` must not carry
        // data", system_processor.rs:193-196). So the bulk MUST move by direct
        // lamport mutation — and that is where the runtime bites.
        //
        // ## READ THIS BEFORE REORDERING ANYTHING BELOW
        //
        // A `try_borrow_mut_lamports` write lands in the SBF *input buffer*, NOT in
        // the runtime's TransactionContext. It reaches the runtime by exactly two
        // routes:
        //
        //   a) at instruction END, for EVERY instruction account, via the loader's
        //      `deserialize_parameters_aligned`; or
        //   b) at each CPI — but ONLY for the accounts named in THAT CPI's
        //      AccountMeta list, via `translate_and_update_accounts` ->
        //      `update_callee_account` (bpf_loader syscalls/cpi.rs:818-896), which
        //      runs BEFORE the callee is dispatched (cpi.rs:1044 precedes :1055).
        //
        // `TransactionContext::push()` then re-sums the lamports of ALL of THIS
        // instruction's accounts and compares against the value recorded at entry
        // (transaction-context lib.rs:351-360). So a CPI that flushes ONE half of a
        // manual move and not the other aborts with `UnbalancedInstruction` — "sum
        // of account balances before and after instruction do not match" — before
        // the callee ever emits its `invoke [2]` log line.
        //
        // Two earlier versions died on exactly this, and the difference in WHERE
        // they died is the proof:
        //   - mutate curve/-X + auth/+X, then transfer auth -> auth_wsol. Metas are
        //     [auth, auth_wsol]: auth's +X flushed, the curve's -X did not. Failed
        //     at the WSOL transfer, on every launch.
        //   - `payer` fronts the full amount, curve manually reimburses `payer`
        //     mid-sequence. Metas of the WSOL transfer and `sync_native` name
        //     neither account, so those passed; it failed at the first CPI that DID
        //     name one — the vault `token::transfer`, whose metas include `curve`.
        //
        // THE INVARIANT: the first CPI after a manual lamport move must name EVERY
        // account that move touched, or none of them. `sell` (lib.rs:484-506)
        // satisfies it the other way — nothing follows its mutation, so route (a)
        // flushes both halves together. Here something must follow, so we insert an
        // explicit barrier CPI. Note that `CpiContext::with_remaining_accounts`
        // CANNOT widen a meta list on these helpers: anchor-lang's and anchor-spl's
        // hand-build their instruction and silently drop remaining_accounts
        // (anchor-lang system_program.rs:298-313, anchor-spl token.rs:11-29).
        let auth_ai = ctx.accounts.migration_authority.to_account_info();

        // The barrier below is a System transfer with the authority as `from`, so
        // the authority must stay System-owned and data-less. That is already
        // required for it to pay cp-swap's rent — asserted here so a future change
        // that allocates data to it fails loudly instead of bricking graduation.
        require!(
            auth_ai.data_is_empty() && auth_ai.owner == &system_program::ID,
            LaunchError::InvalidParameter
        );

        // Program-wide, NOT per-mint — see [`MIGRATION_AUTH_SEED`]. The mint used to
        // be in these seeds; cp-swap's permission account is derived from the payer,
        // so keeping it there would have made every single graduation wait on its own
        // admin-signed permission PDA.
        let auth_seeds: &[&[u8]] = &[MIGRATION_AUTH_SEED, &[ctx.bumps.migration_authority]];
        let auth_signer: &[&[&[u8]]] = &[auth_seeds];

        // The pool address is ours and we must SIGN for it, because it is not
        // cp-swap's canonical derivation — that is what makes it un-occupiable. See
        // [`LAUNCH_POOL_SEED`]. cp-swap's `create_or_allocate_account` signs the
        // System `CreateAccount` with the canonical seeds, which do not match this
        // address; the call still succeeds because System requires the NEW ACCOUNT to
        // sign and that privilege propagates down from this `invoke_signed`. Drop
        // these seeds and cp-swap's `require_eq!(pool_state.is_signer, true)` rejects
        // the migration.
        let pool_seeds: &[&[u8]] = &[
            LAUNCH_POOL_SEED,
            mint_key.as_ref(),
            &[ctx.bumps.pool_state],
        ];
        let init_signer: &[&[&[u8]]] = &[auth_seeds, pool_seeds];

        // Top the authority up to the rent-exempt floor for a zero-data account.
        //
        // NOT for account creation — a direct credit to a zero-lamport,
        // System-owned, zero-data address is a legal `set_lamports` target and
        // materialises the account at commit. It is for the END-OF-TRANSACTION rent
        // check: `migration_authority` is writable, so the SVM verifies its
        // rent-state transition, and a residual strictly between 1 lamport and
        // `minimum_balance(0)` is rejected with `InsufficientFundsForRent` — AFTER
        // the pool has already been created. Seeding to the floor makes the residual
        // (floor + reserve - cp-swap's costs) unconditionally rent-exempt.
        //
        // Topped up rather than skipped when non-zero: this address is derivable, so
        // anyone can send it 1 lamport, and an `== 0` guard would let them push the
        // residual into that rejected band and brick graduation for the price of a
        // transaction.
        let seed_lamports = Rent::get()?.minimum_balance(0);
        let seed_topup = seed_lamports.saturating_sub(auth_ai.lamports());
        if seed_topup > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.payer.to_account_info(),
                        to: auth_ai.clone(),
                    },
                ),
                seed_topup,
            )?;
        }

        // The bulk, curve -> authority. Both halves legal: we own the curve, so the
        // debit passes `set_lamports`' ExternalAccountLamportSpend guard, and a
        // credit to a System-owned account is never blocked. INVISIBLE to the
        // runtime until reconciled — see the block above.
        **curve_ai.try_borrow_mut_lamports()? = curve_ai
            .lamports()
            .checked_sub(move_lamports)
            .ok_or(LaunchError::Overflow)?;
        **auth_ai.try_borrow_mut_lamports()? = auth_ai
            .lamports()
            .checked_add(move_lamports)
            .ok_or(LaunchError::Overflow)?;

        // ── RECONCILIATION BARRIER — LOAD-BEARING, NOT DEAD CODE ─────────────
        //
        // A zero-lamport System transfer whose metas are exactly
        // [migration_authority (writable, signer), curve (writable)] — precisely the
        // two accounts the mutation above touched. `translate_and_update_accounts`
        // flushes BOTH halves into TransactionContext before System is dispatched,
        // so `push()` sees the entry sum restored and every later CPI starts from a
        // consistent world.
        //
        // None of these arguments is interchangeable:
        //   - It MUST be the FIRST CPI after the mutation. Put anything in front of
        //     it — the WSOL transfer, `sync_native`, the vault `token::transfer` —
        //     and that CPI names one half and reverts.
        //   - Direction MUST be authority -> curve. Flipping it hits System's
        //     "`from` must not carry data" check and reverts with InvalidArgument.
        //   - Zero lamports is deliberate and sufficient. `checked_sub_lamports(0)`
        //     and `checked_add_lamports(0)` both short-circuit inside `set_lamports`
        //     (transaction-context lib.rs:865), and the flush that matters happens
        //     in the loader before System runs at all — so the transfer needs to
        //     move nothing in order to do its job.
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: auth_ai.clone(),
                    to: curve_ai.clone(),
                },
                auth_signer,
            ),
            0,
        )?;

        // The authority IS System-owned, so a plain system transfer works here —
        // and is the correct way to fund a WSOL account it owns.
        //
        // `auth_wsol` is now a PERMANENT, publicly derivable address (the authority is
        // program-wide), so anyone may pre-create it and donate to it. Harmless in
        // both directions: cp-swap pulls exactly `init_amount`, never the balance, and
        // the account is native, so `close_account` ignores any residue and returns it
        // to whoever paid for this migration. A donor funds the caller, not the pool.
        let wsol_ai = ctx.accounts.auth_wsol.to_account_info();
        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: auth_ai.clone(),
                    to: wsol_ai.clone(),
                },
                auth_signer,
            ),
            deposit_lamports,
        )?;

        // Lamports alone are not a WSOL balance — sync_native converts them. Without
        // it cp-swap would see a zero-balance account and seed the pool with nothing.
        token::sync_native(CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::SyncNative {
                account: wsol_ai.clone(),
            },
        ))?;

        // Launch tokens: curve vault -> authority, signed by the curve (it owns the
        // vault). cp-swap requires payer_token_* to be owned by the payer.
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.curve_vault.to_account_info(),
                    to: ctx.accounts.auth_token.to_account_info(),
                    authority: curve_ai.clone(),
                },
                signer,
            ),
            deposit_tokens,
        )?;

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
        //
        // `initialize_with_permission`, NOT the permissionless `initialize`. Two
        // things follow from that choice, and both are unfixable per pool once the
        // pool exists — `pool_state.initialize` writes them once, at creation, and no
        // cp-swap instruction rewrites either.
        //
        //  1. ENABLE_CREATOR_FEE. `initialize` hardcodes `false`
        //     (initialize.rs, the final `pool_state.initialize(...)` argument);
        //     `initialize_with_permission` hardcodes `true`. It is the ONLY entry
        //     point that does. Every pool this program has ever been able to create
        //     was therefore permanently creator-fee-less, and "creators earn forever"
        //     could never have been true of any of them.
        //
        //  2. POOL_CREATOR. `initialize` sets it to the CPI's signing `creator`, which
        //     here is `migration_authority` — a PDA of this program that no instruction
        //     can make sign `collect_creator_fee`. So even a pool that accrued creator
        //     fees would have locked them in the vaults forever.
        //     `initialize_with_permission` takes `creator` as a separate non-signing
        //     account, so `pool_creator` becomes the LAUNCH CREATOR's own wallet, read
        //     off the curve's snapshot. That is the account `collect_creator_fee`
        //     requires as a signer, and it is a key that actually exists.
        //
        // This does NOT turn a fee on. `enable_creator_fee = true` only makes the
        // pool ELIGIBLE; the rate lives in `creator_fee_rate` on the AmmConfig, which
        // is a cp-swap admin decision and is zero until an operator sets it. What the
        // switch buys is that the decision remains AVAILABLE — under `initialize` it
        // was foreclosed, silently, at every graduation.
        //
        // Cost: it needs a `permission` account that only a cp-swap admin can create,
        // checked above with a named error.
        let cpi_accounts = raydium_cp_swap::cpi::accounts::InitializeWithPermission {
            payer: auth_ai.clone(),
            creator: ctx.accounts.creator.to_account_info(),
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
            payer_token_0: if wsol_is_0 {
                ctx.accounts.auth_wsol.to_account_info()
            } else {
                ctx.accounts.auth_token.to_account_info()
            },
            payer_token_1: if wsol_is_0 {
                ctx.accounts.auth_token.to_account_info()
            } else {
                ctx.accounts.auth_wsol.to_account_info()
            },
            payer_lp_token: ctx.accounts.auth_lp.to_account_info(),
            token_0_vault: ctx.accounts.token_0_vault.to_account_info(),
            token_1_vault: ctx.accounts.token_1_vault.to_account_info(),
            create_pool_fee: ctx.accounts.create_pool_fee.to_account_info(),
            observation_state: ctx.accounts.observation_state.to_account_info(),
            permission: permission_ai.clone(),
            token_program: ctx.accounts.token_program.to_account_info(),
            token_0_program: ctx.accounts.token_program.to_account_info(),
            token_1_program: ctx.accounts.token_program.to_account_info(),
            associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        // Hand-invoked rather than `raydium_cp_swap::cpi::initialize_with_permission`,
        // for ONE reason.
        //
        // Anchor derives a CPI's AccountMetas from the CALLEE's account struct, and
        // cp-swap declares `pool_state` as `#[account(mut)]` — writable, not a signer.
        // `invoke_signed` cannot confer privilege on an account whose meta does not
        // request it: seeds only prove you MAY sign for an address the instruction
        // already asks to be signed. So cp-swap saw `is_signer == false` and
        // `require_eq!(pool_account_info.is_signer, true)` (initialize.rs:387) rejected
        // our non-canonical pool address — the very branch that makes the address
        // un-squattable (see LAUNCH_POOL_SEED).
        //
        // Keep the typed struct, because it is what keeps this 21-account call ordered
        // and type-checked against the fork, and flip exactly that ONE flag. The
        // promotion count is asserted: if a cp-swap bump ever renames or reorders the
        // account, this fails loudly instead of quietly reverting to a non-signer and
        // taking the squattable path.
        let mut metas = cpi_accounts.to_account_metas(None);
        let pool_key = ctx.accounts.pool_state.key();
        let mut promoted = 0usize;
        for m in metas.iter_mut() {
            if m.pubkey == pool_key {
                m.is_signer = true;
                promoted += 1;
            }
        }
        require!(promoted == 1, LaunchError::InvalidParameter);

        let account_infos = cpi_accounts.to_account_infos();
        anchor_lang::solana_program::program::invoke_signed(
            &anchor_lang::solana_program::instruction::Instruction {
                program_id: ctx.accounts.cp_swap_program.key(),
                accounts: metas,
                data: raydium_cp_swap::instruction::InitializeWithPermission {
                    init_amount_0: amount_0,
                    init_amount_1: amount_1,
                    // Open immediately. A future open_time would leave the pool
                    // un-tradeable while the curve is already closed — a dead window
                    // with no exit, which is the failure mode this program keeps
                    // guarding.
                    open_time: 0,
                    // Creator fees accrue in SOL, never in the launch token.
                    //
                    // `CreatorFeeOn::OnlyTokenN` means the creator's cut is always
                    // DENOMINATED in tokenN — taken off the input when the input is
                    // tokenN, off the output otherwise (cp-swap
                    // `PoolState::is_creator_fee_on_input`). So this must track the
                    // same mint sort as the amounts above, or every creator on the
                    // venue is paid in the illiquid side of their own pool and has to
                    // sell it back through that pool to realise anything.
                    //
                    // `BothToken` was the other option and is what `initialize`
                    // hardcodes; it would pay creators in whatever a trader happened
                    // to sell, which is the same problem half the time.
                    creator_fee_on: if wsol_is_0 {
                        raydium_cp_swap::CreatorFeeOn::OnlyToken0
                    } else {
                        raydium_cp_swap::CreatorFeeOn::OnlyToken1
                    },
                }
                .data(),
            },
            &account_infos,
            init_signer,
        )?;

        // ── 4. BURN the LP ───────────────────────────────────────────────────
        // The LP account was created by the CPI, so read it now rather than via
        // `reload()` on a typed account that did not exist at validation time.
        // `token::accessor::amount` reads the balance straight out of the account
        // data. Deserializing into `Account<'info, TokenAccount>` instead does not
        // compile here: that type requires the AccountInfo to live for 'info, and
        // an AccountInfo produced inside this function cannot.
        let lp_ai = ctx.accounts.auth_lp.to_account_info();
        let lp_amount = token::accessor::amount(&lp_ai)?;
        if lp_amount > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    token::Burn {
                        mint: ctx.accounts.lp_mint.to_account_info(),
                        from: lp_ai.clone(),
                        authority: auth_ai.clone(),
                    },
                    auth_signer,
                ),
                lp_amount,
            )?;
        }
        // Assert the burn actually emptied it. "Liquidity permanently locked" is a
        // published claim; leaving any LP behind would make it false, and a
        // silently-partial burn is exactly the kind of thing nobody notices.
        let lp_after = token::accessor::amount(&lp_ai)?;
        require!(lp_after == 0, LaunchError::LpNotBurned);

        // ── 5. Return every recoverable lamport to whoever paid for migration ─
        //
        // Migration is permissionless and `payer` fronts real money for it: rent on
        // `auth_wsol` and `auth_token`, plus the authority's rent-exempt floor. The
        // authority additionally ends up holding however much
        // `migration_reserve_lamports` over-provisioned cp-swap's real costs.
        //
        // None of that is reachable afterwards. Only this program can sign for the
        // authority, no instruction moves lamports out of a curve once `complete` is
        // set, and this instruction cannot run twice. So leaving it behind is a
        // permanent leak — and worse, it means calling this instruction always loses
        // money, which is a poor foundation for a step anyone is allowed to trigger.
        //
        // ⚠️ DRAIN BEFORE CLOSING — this is a permanent-brick guard, not tidiness.
        //
        // SPL Token REFUSES to close a NON-NATIVE account holding any balance
        // (`TokenError::NonNativeHasBalance`). `auth_token`'s address is derivable
        // from the mint the moment `create_launch` lands, and the Associated Token
        // Program lets anyone create an ATA for any owner, PDA or not. So an attacker
        // could buy one token unit, create `auth_token`, donate that unit, and wait:
        // cp-swap pulls exactly `deposit_tokens`, the donated unit survives, and an
        // unconditional close reverts the whole instruction. Forever — nothing in
        // this program can move tokens out of that ATA by any other path.
        //
        // That is the same permissionless one-transaction brick the LAUNCH_POOL_SEED
        // fix exists to prevent, reached through a different door. Cost to attacker:
        // ~0.002 SOL.
        //
        // Only `auth_token` needs this. `auth_wsol` is native, so the close ignores
        // its balance and any donated WSOL simply returns to `payer`; `auth_lp`
        // cannot be pre-created because its mint does not exist until cp-swap makes
        // it inside this very instruction.
        let auth_token_ai = ctx.accounts.auth_token.to_account_info();
        let residual_tokens = token::accessor::amount(&auth_token_ai)?;
        if residual_tokens > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: auth_token_ai.clone(),
                        to: ctx.accounts.curve_vault.to_account_info(),
                        authority: auth_ai.clone(),
                    },
                    auth_signer,
                ),
                residual_tokens,
            )?;
        }

        // The closes MUST follow the burn: `auth_lp` has to be empty first, and SPL
        // Token refuses to close a non-native account holding a balance. They send
        // rent to `payer` directly, not via the authority, so they do not change what
        // the sweep below forwards. All four are CPIs and reconcile normally — no
        // manual lamport mutation survives past the barrier above.
        for account in [
            ctx.accounts.auth_wsol.to_account_info(),
            ctx.accounts.auth_token.to_account_info(),
            lp_ai.clone(),
        ] {
            token::close_account(CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                token::CloseAccount {
                    account,
                    destination: ctx.accounts.payer.to_account_info(),
                    authority: auth_ai.clone(),
                },
                auth_signer,
            ))?;
        }

        // Sweeping to zero retires the authority entirely, which is why the
        // rent-band hazard the seed top-up guards against cannot bite here. Keep
        // that top-up anyway: it is what makes this safe if the sweep is ever
        // removed.
        //
        // ── WHO GETS THE RESIDUAL, AND WHY IT IS NOT THE CALLER ──────────────
        // This used to pay `payer`. It is NOT the caller's money: `move_lamports`
        // is `deposit + reserve` (above) and only `deposit` goes into the pool, so
        // `residual` is the unspent migration reserve — which buyers funded, because
        // the reserve is raised ON TOP of the graduation target and `buy` caps the
        // raise at `target + reserve`.
        //
        // Migration is deliberately permissionless, so paying it to `payer` made
        // graduation a standing MEV bounty: watch for `real_sol_reserves == target +
        // reserve`, call this instruction, collect the surplus. With the runbook's
        // recommended 0.25 SOL reserve that is roughly 0.06 SOL of traders' money per
        // graduation to whoever wins the race, and ~0.21 SOL if the operator ever
        // sets `create_pool_fee = 0`.
        //
        // `payer` is still made whole and then some: the three `close_account` calls
        // above return 3x ATA rent to it, against the 2x ATA rent + seed top-up it
        // fronted. It does not need — and must not get — the reserve as well.
        let residual = auth_ai.lamports();
        if residual > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: auth_ai.clone(),
                        to: ctx.accounts.fee_recipient.to_account_info(),
                    },
                    auth_signer,
                ),
                residual,
            )?;
        }

        // ── 5. Close the curve, atomically with all of the above ─────────────
        let pool = ctx.accounts.pool_state.key();
        let curve = &mut ctx.accounts.curve;
        // Subtract EVERYTHING that left, not just the deposit. `move_lamports` is
        // deposit + reserve and all of it went to the migration authority, so
        // subtracting only the deposit left a migrated curve reporting a balance of
        // exactly `migration_reserve_lamports` that it does not hold. Harmless
        // on-chain — nothing reads it once `complete` is set — but every indexer,
        // Fact Sheet and explorer reading curve state would have shown a number that
        // is simply false.
        curve.real_sol_reserves = curve
            .real_sol_reserves
            .checked_sub(move_lamports)
            .ok_or(LaunchError::Overflow)?;
        curve.real_token_reserves = 0;
        curve.complete = true;
        curve.pool = pool;

        emit!(Graduated {
            mint: mint_key,
            sol_reserves: deposit_lamports,
            token_reserves: deposit_tokens,
            pool_creator: pool_creator_key,
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
    ///
    /// The default pubkey is rejected here because `update_global` rejects it there
    /// (lib.rs, `new_fee_recipient`), and one path validating a field the other does
    /// not is how this crate got `check_launch_economics`. `Pubkey::default()` is the
    /// System Program: rent-exempt, executable, and unsignable, so every protocol fee
    /// would burn until an `update_global` noticed.
    #[account(constraint = fee_recipient.key() != Pubkey::default() @ LaunchError::InvalidParameter)]
    pub fee_recipient: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + GlobalConfig::INIT_SPACE,
        seeds = [GLOBAL_SEED],
        bump
    )]
    pub global: Box<Account<'info, GlobalConfig>>,
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
    // BOXED. Anchor's generated `try_accounts` deserializes accounts onto the STACK,
    // and SBF gives each function a hard 4,096-byte frame that the linker only WARNS
    // about — the program builds and then dies on chain with an access violation. This
    // struct has been over that line before. Box every sizeable `Account<T>` you add
    // here, and read solana-ci.yml's "exceeded max offset" gate before assuming a
    // local `cargo check` proves anything: it does not compile for SBF at all.
    pub curve: Box<Account<'info, BondingCurve>>,

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
/// Large because cp-swap's `initialize_with_permission` takes 21 accounts and we must
/// forward all of them. The PDAs cp-swap derives itself (pool_state, vaults, lp_mint,
/// observation_state, its authority) are passed as `UncheckedAccount` — cp-swap
/// validates each against its own seeds, so re-deriving them here would duplicate
/// its logic with no added safety and a real chance of drifting from it.
#[derive(Accounts)]
pub struct MigrateToAmm<'info> {
    /// Funds rent for the accounts created along the way. Any caller may pay.
    ///
    /// It buys them the rent back and nothing more. That used to be untrue: the
    /// residual sweep below sent the ENTIRE unspent migration reserve here, and since
    /// the reserve is raised from buyers on top of the graduation target
    /// (`state.rs` / lib.rs:245), a bot watching for funded curves could call this and
    /// take ~0.06 SOL of traders' money per graduation for a ~5,000-lamport fee. The
    /// comment that used to sit here — "it buys them nothing" — is why nobody caught
    /// it, and MAINNET_RUNBOOK then advised over-provisioning the reserve BECAUSE the
    /// surplus came back to the caller, which made the leak bigger. The surplus now
    /// goes to `fee_recipient`.
    #[account(mut)]
    pub payer: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, GlobalConfig>>,

    /// CHECK: receives the unspent migration reserve. Pinned to the config so the
    /// caller cannot name themselves. Declared AFTER `global` because Anchor
    /// evaluates constraints in field order and this one reads back into it — the
    /// same ordering requirement `Trade::creator` documents.
    #[account(mut, address = global.fee_recipient @ LaunchError::Unauthorized)]
    pub fee_recipient: UncheckedAccount<'info>,

    pub launch_mint: Box<Account<'info, Mint>>,

    #[account(
        mut,
        seeds = [CURVE_SEED, launch_mint.key().as_ref()],
        bump = curve.bump,
        constraint = curve.mint == launch_mint.key() @ LaunchError::InvalidParameter
    )]
    pub curve: Box<Account<'info, BondingCurve>>,

    /// The curve's token vault — drained into `auth_token`, which becomes cp-swap's
    /// `payer_token_*` for the launch-token leg.
    #[account(
        mut,
        seeds = [VAULT_SEED, launch_mint.key().as_ref()],
        bump,
        constraint = curve_vault.mint == launch_mint.key() @ LaunchError::InvalidParameter
    )]
    pub curve_vault: Box<Account<'info, TokenAccount>>,

    /// Native mint. Address-checked so a fake "WSOL" cannot be substituted.
    #[account(address = anchor_spl::token::spl_token::native_mint::ID @ LaunchError::InvalidParameter)]
    pub wsol_mint: Box<Account<'info, Mint>>,

    /// CHECK: receives the cp-swap pool's `pool_creator` role, and is the only key
    /// that will ever be able to call `collect_creator_fee` on the resulting pool.
    ///
    /// Pinned to the curve's own snapshot, so neither the caller nor the protocol can
    /// redirect a creator's post-graduation income — the same reasoning, and the same
    /// field-ordering requirement, as `Trade::creator`. Declared AFTER `curve`.
    ///
    /// Not `mut`: cp-swap only reads its key. Not a `Signer` either — under
    /// `initialize_with_permission` the pool creator does not sign, which is exactly
    /// what lets a permissionless migration name someone other than itself.
    #[account(address = curve.creator @ LaunchError::CreatorMismatch)]
    pub creator: UncheckedAccount<'info>,

    /// CHECK: The migration authority — a DATA-LESS PDA, PROGRAM-WIDE, and it must
    /// stay both.
    ///
    /// It exists because cp-swap's pool-creating instruction needs one account to be
    /// both the signing `payer` AND the rent source for five `init` accounts. Rent is
    /// funded through the System program's `CreateAccount`, which requires a
    /// System-owned payer — and the curve PDA holds `BondingCurve` data, so it is
    /// owned by this program and can never serve.
    ///
    /// A data-less PDA satisfies both: System-owned so it can pay, derived from
    /// this program so it can sign via seeds. Allocating any data to it would break
    /// the payer half AND the reconciliation barrier in `migrate_to_amm`, which
    /// System-transfers FROM this account; the handler asserts `data_is_empty()` so
    /// that change fails loudly rather than silently bricking graduation.
    ///
    /// Seeded WITHOUT the mint — see [`MIGRATION_AUTH_SEED`] for why cp-swap's
    /// permission derivation forces that, and what it costs.
    ///
    /// The alternative — making the arbitrary `payer` signer cp-swap's payer — would
    /// have an untrusted caller briefly holding the launch's entire liquidity in
    /// their own token accounts, and would need a permission account per caller.
    #[account(mut, seeds = [MIGRATION_AUTH_SEED], bump)]
    pub migration_authority: UncheckedAccount<'info>,

    /// The SOL leg, wrapped and held by the migration authority so cp-swap sees a
    /// `payer_token_*` its payer actually owns.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = wsol_mint,
        associated_token::authority = migration_authority
    )]
    pub auth_wsol: Box<Account<'info, TokenAccount>>,

    /// The launch-token leg, moved out of the curve vault for the same reason.
    #[account(
        init_if_needed,
        payer = payer,
        associated_token::mint = launch_mint,
        associated_token::authority = migration_authority
    )]
    pub auth_token: Box<Account<'info, TokenAccount>>,

    /// CHECK: Receives the LP that is then burned.
    ///
    /// UncheckedAccount, and NOT `init_if_needed`, for two reasons — both of which
    /// made an earlier version fail at runtime with the Associated Token Program
    /// reporting `IncorrectProgramId`:
    ///
    ///   1. Anchor runs `init_if_needed` during ACCOUNT VALIDATION, before the
    ///      instruction body. At that point `lp_mint` does not exist — cp-swap
    ///      creates it inside the CPI — so deriving an ATA for it asks the Token
    ///      program for the data size of a System-owned account.
    ///   2. cp-swap `init`s `payer_lp_token` itself, so creating it here would
    ///      collide anyway.
    ///
    /// It is therefore created BY the CPI and read afterwards for the burn. Owned
    /// by the migration authority, since that is cp-swap's creator.
    #[account(mut)]
    pub auth_lp: UncheckedAccount<'info>,

    // ── cp-swap ──────────────────────────────────────────────────────────────
    /// CHECK: matched against `global.cp_swap_program` in the handler.
    pub cp_swap_program: UncheckedAccount<'info>,
    /// CHECK: matched against `global.amm_config` in the handler.
    pub amm_config: UncheckedAccount<'info>,
    /// CHECK: cp-swap's `Permission` PDA at ["permission", migration_authority],
    /// created once by a cp-swap admin. cp-swap re-derives and validates it; the
    /// handler only checks that it EXISTS, so the failure mode is a named error
    /// rather than an `AccountNotInitialized` from inside the CPI.
    ///
    /// Deliberately no `seeds =` constraint. Anchor's generated `try_accounts`
    /// evaluates seeds on the STACK, and this struct has already overflowed SBF's
    /// 4 KB frame once from exactly that (see `pool_state`, and solana-ci.yml's
    /// "exceeded max offset" gate). The derivation this program relies on is
    /// [`CP_SWAP_PERMISSION_SEED`], pinned in a test.
    pub cp_swap_permission: UncheckedAccount<'info>,
    /// CHECK: cp-swap's vault/LP-mint authority PDA; it validates its own seeds.
    pub amm_authority: UncheckedAccount<'info>,
    /// CHECK: created by cp-swap, but at an address THIS program owns and signs for.
    ///
    /// Deliberately NOT cp-swap's canonical
    /// [POOL_SEED, amm_config, token_0_mint, token_1_mint] derivation. That address
    /// is reachable by anyone — cp-swap's pool creation is permissionless and
    /// `create_pool` refuses a `pool_state` that is already owned by cp-swap
    /// (initialize.rs:372-374), so occupying it bricks a launch's graduation
    /// permanently. cp-swap's own second branch accepts a non-canonical
    /// `pool_state` that signs (initialize.rs:386-388), and only this program can
    /// sign for this PDA. See [`LAUNCH_POOL_SEED`].
    ///
    /// Constrained here rather than left free so the CALLER cannot choose where a
    /// launch's liquidity lands either.
    #[account(mut, seeds = [LAUNCH_POOL_SEED, launch_mint.key().as_ref()], bump)]
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
    // No `rent` sysvar. `initialize` took one; `initialize_with_permission` does not,
    // and nothing else here reads it. Carrying a dead account on the instruction that
    // already sits near SBF's stack ceiling is cost with no purpose.
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub trader: Signer<'info>,

    #[account(seeds = [GLOBAL_SEED], bump = global.bump)]
    pub global: Box<Account<'info, GlobalConfig>>,

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
    // BOXED. Anchor's generated `try_accounts` deserializes accounts onto the STACK,
    // and SBF gives each function a hard 4,096-byte frame that the linker only WARNS
    // about — the program builds and then dies on chain with an access violation. This
    // struct has been over that line before. Box every sizeable `Account<T>` you add
    // here, and read solana-ci.yml's "exceeded max offset" gate before assuming a
    // local `cargo check` proves anything: it does not compile for SBF at all.
    pub curve: Box<Account<'info, BondingCurve>>,

    /// CHECK: must be the creator recorded on the curve at `create_launch`;
    /// receives the creator's share of the trade fee, instantly and
    /// non-custodially, on every buy and sell. Pinned to the curve's snapshot so
    /// neither the trader nor the protocol can redirect a creator's income.
    /// Declared AFTER `curve` — Anchor evaluates constraints in field order, so
    /// the reference must point backwards.
    #[account(mut, address = curve.creator @ LaunchError::CreatorMismatch)]
    pub creator: UncheckedAccount<'info>,

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


#[cfg(test)]
mod layout_tests {
    use super::*;

    /// ACCOUNT SIZES ARE A CLIENT CONTRACT.
    ///
    /// Every off-chain decoder derives its field offsets and its rent floor from these
    /// numbers, and this repo has already shipped a decoder pinned to a stale one — a
    /// `BONDING_CURVE_SIZE` of 162 against 716-byte accounts, which made every launch
    /// on the venue's own rail render as `bad-length` while quietly understating the
    /// curve PDA's rent floor by 3,855,840 lamports.
    ///
    /// Pinned as literals rather than recomputed from the field list, because a test
    /// that re-derives the size from the struct agrees with the struct by construction
    /// and cannot notice that the struct moved.
    ///
    /// 716 was the size WITH the segmented curve's 16-entry table (546 bytes of mode,
    /// two sqrt-prices, a count and the table). With that mode removed it is 170.
    #[test]
    fn account_sizes_are_pinned() {
        assert_eq!(
            8 + BondingCurve::INIT_SPACE,
            170,
            "BondingCurve size moved — every off-chain decoder and rent-floor read must \
             move with it, in the same change"
        );
        assert_eq!(
            8 + GlobalConfig::INIT_SPACE,
            194,
            "GlobalConfig size moved — see above"
        );
    }

    /// ERROR CODES ARE A CLIENT CONTRACT TOO. Anchor numbers `#[error_code]` variants
    /// by declaration order from 6000, so inserting one renumbers everything after it
    /// and every client error table starts naming the wrong failure. New variants go
    /// LAST; these anchors prove the ones already in circulation did not move.
    #[test]
    fn error_codes_are_stable() {
        assert_eq!(LaunchError::Overflow as u32 + 6000, 6000);
        assert_eq!(LaunchError::AmmNotConfigured as u32 + 6000, 6015);
        assert_eq!(LaunchError::CreatorMismatch as u32 + 6000, 6020);
        assert_eq!(LaunchError::MigrationPermissionMissing as u32 + 6000, 6021);
    }

    /// The migration authority is derivable WITHOUT the launch mint. That is the
    /// property cp-swap's permission account depends on: its PDA is seeded on the
    /// payer, so a per-mint authority would need a per-launch admin ceremony before
    /// any launch could graduate.
    #[test]
    fn the_migration_authority_is_program_wide() {
        let (a, _) = Pubkey::find_program_address(&[MIGRATION_AUTH_SEED], &crate::ID);
        let (b, _) = Pubkey::find_program_address(&[MIGRATION_AUTH_SEED], &crate::ID);
        assert_eq!(a, b);
        // ...and it is NOT the address a mint-seeded derivation produces, so a client
        // built against the old shape fails loudly rather than passing a stranger.
        let mint = Pubkey::new_unique();
        let (per_mint, _) =
            Pubkey::find_program_address(&[MIGRATION_AUTH_SEED, mint.as_ref()], &crate::ID);
        assert_ne!(a, per_mint);
    }

    /// The permission PDA's seed is cp-swap's, not ours. Restating it locally is what
    /// lets the derivation be read at the call site; this is what stops the restatement
    /// from rotting if a fork bump renames it.
    #[test]
    fn the_permission_seed_matches_cp_swap() {
        assert_eq!(
            CP_SWAP_PERMISSION_SEED,
            raydium_cp_swap::states::PERMISSION_SEED.as_bytes(),
            "cp-swap renamed its permission seed — migrate_to_amm would pass an address \
             cp-swap does not derive, and graduation would fail inside the CPI"
        );
    }
}
