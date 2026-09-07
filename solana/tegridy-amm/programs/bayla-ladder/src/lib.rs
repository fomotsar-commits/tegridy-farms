//! # bayla-ladder — lock-ladder staking with a flat 25% early exit
//!
//! The Solana port of `contracts/src/LighthouseLadder.sol`: Synthetix's reward
//! engine with boosted weight as its divisor and multiplier, a 7d→4y ladder at
//! 0.40x→4.00x (TOWELI parity), and THREE exits — matured, early (−25%, rewards
//! paid), and an emergency hatch that never touches the reward vault.
//!
//! ## Verification status — read this before trusting anything here
//!
//! [`math`] (the ladder, the accumulator, the penalty, the funding bound, and every
//! rounding and saturation decision) is dependency-free and **proven on the host**:
//! `rustc --edition 2021 --test src/math.rs`.
//!
//! CORRECTED 2026-09-06: this header used to say everything else was "CI-compiled
//! only". That is wrong and it cost real coverage. **`cargo test -p bayla-ladder
//! --lib` builds and runs on the dev box**, in both feature configs — only
//! `cargo build-sbf` and the `anchor` CLI are blocked by Application Control. So the
//! `layout_tests` pins, and any host-testable logic in this file, ARE locally
//! verifiable and locally mutation-checkable. Use it. What still cannot run locally
//! is the SBF artifact and anything needing a validator.
//! Treat the Anchor layer as unreviewed until CI is green AND a human has read it,
//! AND an external audit has been pointed at the failure mode below and told to
//! break the four properties that make it unreachable.
//!
//! ## Why this program exists at all
//!
//! The venue rents Streamflow for BAYLA staking. In one fortnight that rail produced
//! two distinct ways of holding principal hostage — error 6012 when the reward vault
//! runs dry, and error 6000 when a position's cumulative reward counter passes
//! u64::MAX (which 42.4% of all live entries on that program already had). Neither
//! can be fixed from outside the program, and the operator's one rate change per year
//! was already spent. Owning the program is what makes THE PRINCIPAL PROMISE a
//! property of the code instead of a hope about a vendor.
//!
//! ## THE PRINCIPAL PROMISE, and the four properties that hold it up
//!
//! The venue's last custom staking contract failed an audit on a confirmed HIGH:
//! `TegridyRestaking._accrueBonus()` offered the same backing to every window, and
//! liability outran funding 4x with no attacker required
//! (`docs/RESTAKING_BONUS_INSOLVENCY_2026_08_27.md`). Four of five internal review
//! lenses missed it. The properties below are the answer — and the honest version is
//! that **all four hold together or none of it holds**:
//!
//! - **I-1** `stake_vault.amount >= pool.total_principal` after every principal-moving
//!   instruction. `total_principal` is a tracked scalar and authoritative — never
//!   derived from the vault, which any stranger can transfer into. Note the check bounds
//!   only the PRINCIPAL claim: `orphaned_penalty` also sits in that vault and is
//!   deliberately outside `total_principal`, so the vault runs over-funded relative to
//!   this assertion. `sweep_orphaned_penalty` is the one site that asserts the strong
//!   form, because it zeroes the reserve first. Strengthening the others would brick the
//!   hatch on the first unit of drift, which is the opposite of what I-1 is for.
//! - **I-2** `payable = min(owed, reward_vault)`; the remainder STAYS OWED. Never zeroed,
//!   never a revert. A revert here is exactly Streamflow 6012.
//! - **I-3** A new period may only draw on `reward_vault − (emitted − paid)`: what is
//!   already owed is reserved before anything new is promised (AUDIT C2).
//! - **I-12** No reward instruction is ever handed the stake vault, and the emergency
//!   hatch is never handed the reward vault. Separate vaults make "rewards paid out of
//!   principal" a thing the account layout cannot express.
//!
//! Separate vaults alone (I-12) stop an over-mint REACHING principal; they do not stop
//! the over-mint. Without I-3 and I-2, a two-vault design just converts "paid out of
//! principal" into "the first claimants drain the reward vault and everyone else
//! reverts" — which is the Streamflow bug the venue already routes around.
//!
//! ## The other invariants, in the order the tests exercise them
//!
//! - **I-5/I-6** every cumulative counter is u128, every accrual saturates, and
//!   narrowing happens once — in `math::payable`, at the transfer.
//! - **I-7** a closed position is DELETED (`close = owner`). There is no `relock` and no
//!   permissionless `decay`; climbing the ladder is withdraw-then-stake. All three
//!   criticals in the EVM design review began with a record that outlived its close.
//! - **I-8** `saturating_sub` on every decrement, so a desynchronised ledger degrades
//!   into a boost error and never a panic on the principal path.
//! - **I-9** `position.weight <= pool.total_weighted` is checked before the accrual
//!   multiply. It is what makes the u128 headroom analysis in `math.rs` true rather
//!   than hopeful.
//! - **I-10** `received = post − pre`; the minimum stake and the weight are measured on
//!   what ARRIVED.
//! - **I-11** the accumulator burns any interval in which `total_weighted` sits below
//!   the floor derived from `min_stake` — the dust-divisor defence.
//! - **I-13** the deposit cap is raise-only, on a 48 h timelock.
//! - **I-14** pay before close, on every path that does both (AUDIT C1, proven by
//!   `contracts/test/vendor/LadderOrderingPoC.t.sol`).
//! - **I-15** every elapsed is `saturating_sub` and the checkpoint mark never moves
//!   backwards. CORRECTED 2026-09-06: this used to assert the Clock sysvar "is not
//!   monotone". It is — `Bank::update_clock` clamps to the ancestor timestamp
//!   unconditionally. The non-monotone thing is a validator's VOTE timestamp, which
//!   this program never reads. Kept as defence-in-depth, not as a live requirement.
//!
//! ## Deliberately absent
//!
//! `pause`, `sweep_penalty` (to a treasury), `recover_tokens`, `relock`, permissionless
//! `decay`/`kick`, `set_penalty_bps`, `set_ladder`, `close_pool`, and — load-bearing,
//! see below — `close_user_stats`. Retaining the penalty
//! in-pool removes an instruction, an address, and a whole class of admin discretion.
//! The penalty and the ladder are compile-time constants: a stolen authority key can
//! raise the cap (slowly, visibly), rotate itself, and declare the pool degraded —
//! which only ever frees stakers. It cannot move principal or retune the penalty.
//!
//! CORRECTED 2026-09-06 (audit M-3): this used to end "or change what anyone was
//! promised", which was false. `declare_degraded` cannot touch
//! `EARLY_EXIT_PENALTY_BPS`, but it zeroes the penalty on both exit doors and ends
//! penalty inflow permanently — and before this commit it left `stake` open too, so
//! the 4.00x rung could be bought with no lock at all. What is true is narrower and
//! worth saying exactly: the flag can only move in the direction that frees stakers
//! and closes the pool to new money.
//!
//! ## Two couplings a future change could break without noticing
//!
//! **POSITION REVIVAL is prevented by exactly one undefended property** (audit L-9).
//! Anchor 0.32.1's `close` drains lamports, assigns to the System Program and resizes
//! to zero — it writes NO closed-account discriminator. A closed `Position` is therefore
//! left in precisely the state `init` creates into. The only thing stopping a
//! close-and-recreate at the same nonce is that `stake` seeds the Position from
//! `user_stats.next_nonce`, which only ever increments — and that monotonicity is
//! protected solely by `UserStats` having NO `close` constraint, because
//! `init_if_needed` takes the create branch on a System-owned account and would reset
//! `next_nonce` to 0. Not exploitable today. But a `close_user_stats` rent-reclaim
//! instruction is the obvious thing a UX pass asks for, and adding one is a one-line
//! diff away from a double-withdraw. The ~0.00155 SOL of stranded rent per wallet is
//! the price of that, and it is worth paying. `close =` must appear exactly twice in
//! this file and only on `position`; CI greps for it.
//!
//! **TOKENS SENT DIRECTLY TO THE STAKE VAULT ARE UNRECOVERABLE** (audit L-10).
//! `sweep_orphaned_penalty` moves only `pool.orphaned_penalty`, and `stake` measures its
//! own delta, so anything above `total_principal + orphaned_penalty` is invariant across
//! every stake-vault outflow. Unlike the reference's single balance, where a mis-send
//! becomes staker surplus. Not reachable through any instruction — `NotifyReward` pins
//! `address = pool.reward_vault` — so it takes a raw out-of-band transfer. Never surface
//! the stake vault's address as a transfer destination. Do NOT "fix" this by widening
//! the sweep to `vault - total_principal`: that reintroduces balance-derived accounting
//! and lets an outsider choose when arbitrary tokens become reward budget, immediately
//! before a rate calculation.
//!
//! **ACCEPTED RISK — `TokenMetadata` is admitted and is the one post-gate-mutable
//! extension**, so the mint account stays reallocatable for the pool's life while every
//! token-touching Accounts struct deserializes it. The obvious break — sizing the mint
//! to exactly `Multisig::LEN` (355) so `check_min_len_and_not_multisig` fails on every
//! instruction including the hatch — does not work: spl-token-2022 8.0.1's
//! `try_get_new_account_len_for_extension_len` ends in `adjust_len_for_multisig`, which
//! pads 355 to 357. That is a VERSION PIN as much as a finding: a future spl-token-2022
//! bump must re-verify the padding.
//!
//! ## Where the penalty goes
//!
//! It stays in the pool as reward budget, exactly as the Solidity does. `early_exit`
//! moves it from the stake vault to the reward vault in the same instruction. The
//! emergency hatch cannot (I-12: it has no reward vault), so it leaves the penalty in
//! the stake vault, tracked as `orphaned_penalty`, until the permissionless
//! `sweep_orphaned_penalty` carries it across. `total_principal` never counts it, so
//! I-1 holds throughout.
//!
//! ## What is NOT ported from the Solidity, and why
//!
//! `LighthouseLadder.emergencyWithdraw` charges the 25% while locked, unconditionally.
//! Here BOTH early doors charge nothing once `declare_degraded` has been called — the
//! one-way flag that answers "what if the operator is the failure". Under the venue's
//! own upgrade authority, holders will want a hatch that works when the venue is the
//! problem, and charging them 25% then reads badly.
//!
//! Its cost is honest and belongs in the panel copy: it stops future penalty inflow,
//! transferring value from stayers to leavers, and it CLOSES THE POOL TO NEW STAKES
//! permanently. A terminal state, not a maintenance mode.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

pub mod errors;
pub mod math;
pub mod state;
pub mod token;

use crate::errors::LadderError;
use crate::math::*;
use crate::state::*;

// PLACEHOLDER program id — generated 2026-09-06 for the workspace to resolve, to be
// replaced with a dedicated keypair before any real deploy, exactly as tegridy-launch's
// was. The keypair lives outside the repo.
declare_id!("GKwgTQtVyPGxspxvciDAStY4Jq7rB1STuVvXic7EG6E4");

/// The only key permitted to call `initialize_pool`.
///
/// Without this, `initialize_pool` is an unprotected initializer: whoever calls it
/// first on a (mint, nonce) owns that pool's authority. Fail-closed by default,
/// matching tegridy-launch and cp-swap: a non-devnet build embeds the System Program
/// id, which no one can sign for, so a mainnet binary refuses to initialize until an
/// operator sets a real key here. A placeholder that *works* is how this hole ships.
///
/// `pubkey!`, NOT `declare_id!` — a second `declare_id!` in the crate makes the
/// program's own address ambiguous to the IDL generator. See tegridy-launch.
///
/// ⚠️ THE DEVNET VALUE MUST NEVER EQUAL `declare_id!`. Audit finding L-5
/// (2026-09-06): it did. Both constants held
/// `GKwgTQtVyPGxspxvciDAStY4Jq7rB1STuVvXic7EG6E4`, so the gate demanded a
/// signature from the PROGRAM'S OWN ADDRESS — a loader-owned account that is
/// demoted to read-only at message level and can never sign. `initialize_pool`
/// was uncallable in BOTH feature configurations, so no Pool could exist and
/// no instruction downstream of it was reachable. Not a security hole (mainnet
/// is correctly fail-closed) — the program was simply dead on arrival, and
/// nothing could have been tested until it was found.
///
/// `the_deployer_gate_is_not_the_program_itself` in `layout_tests` now pins it.
/// The value below is a PLACEHOLDER for local devnet work; the keypair lives
/// outside the repo. When this program gains a validator-test job, that job
/// should patch this constant from a freshly generated CI wallet exactly as
/// `launch-constraints` does for tegridy-launch (solana-ci.yml, "Pin the
/// program id and the devnet deployer") rather than trusting the committed one.
pub mod deployer {
    use super::{pubkey, Pubkey};
    #[cfg(feature = "devnet")]
    pub const ID: Pubkey = pubkey!("ASLXdST48ivBZ4xV7VjgD51FJ6rHH5CN5s8XS5TLwygP");
    #[cfg(not(feature = "devnet"))]
    pub const ID: Pubkey = pubkey!("11111111111111111111111111111111"); // SENTINEL (fail-closed)
}

/// Synthetix `updateReward(address(0))` — the pool-level checkpoint. Banks what the
/// window just closed EMITTED (AUDIT C2) before moving the checkpoint, using the
/// weight in force across that window. Pure state arithmetic: it performs no
/// transfer and reads no vault, so it cannot fail because a vault is empty or wedged
/// — which is what lets the emergency hatch run it safely (AUDIT C3).
fn checkpoint(pool: &mut Pool, now: i64) {
    let applicable = last_time_applicable(now, pool.period_finish);
    // Both divisions carry their remainder (audit M-2 and L-4). Without the first,
    // per-second checkpoint cadence destroyed 7.4% of a plausible window — and cadence
    // is not the operator's to control, because `claim` is a cheap poke. Without the
    // second, `rewards_emitted` under-counted the liability it exists to reserve, until
    // `outstanding` saturated to zero and the solvency guard passed vacuously.
    let (rpw, rpw_residue) = reward_per_weight_with_residue(
        pool.reward_per_weight_stored,
        pool.rpw_residue,
        pool.last_update_time,
        applicable,
        pool.reward_rate,
        pool.total_weighted,
        min_weight_floor(pool.min_stake),
    );
    let (delta, emitted_residue) = emitted_delta_with_residue(
        rpw,
        pool.reward_per_weight_stored,
        pool.total_weighted,
        pool.emitted_residue,
    );
    pool.rewards_emitted = pool.rewards_emitted.saturating_add(delta);
    pool.rpw_residue = rpw_residue;
    pool.emitted_residue = emitted_residue;
    pool.reward_per_weight_stored = rpw;
    // `.max(...)`: the READ is already clamped (math.rs), but nothing clamped the WRITE,
    // so a backwards clock would move the mark back and the next forward interval would
    // be emitted twice (reproduced at 1.988x in a harness). Unreachable — the Clock
    // sysvar is monotone — but it costs one comparison. See I-15.
    pool.last_update_time = applicable.max(pool.last_update_time);
}

/// Synthetix `updateReward(account)` for one position, AFTER the pool checkpoint.
/// I-9 is checked here because this is the one place the position's weight is
/// multiplied by an accumulator delta.
/// `strict = false` is used by the EMERGENCY HATCH ONLY.
///
/// I-9's `require!` is correct everywhere it can refuse without stranding anything —
/// but `emergency_withdraw` is not such a place. That instruction is the program's
/// central promise, and a `require!` on its path converts a survivable accounting
/// drift into permanently trapped principal. The reference floors here instead and
/// says why (LighthouseLadder.sol `_close`), which is the same reasoning that makes
/// every ledger decrement `saturating_sub` (I-8) — it is incoherent to tolerate a
/// desynchronised ledger everywhere and then assert against it on the exit.
///
/// Unreachable today: `total_weighted`'s only writers are the paired `saturating_add`
/// in `stake` and `saturating_sub` in `debit_closed`, and `total_weighted <=
/// 4 x u64::MAX ~ 7.4e19` cannot saturate a u128. This is defence-in-depth pointed the
/// right way round, not a live fix.
fn accrue_position_inner(pool: &Pool, position: &mut Position, strict: bool) -> Result<()> {
    if strict {
        require!(
            position.weight <= pool.total_weighted,
            LadderError::WeightInvariant
        );
    }
    // Clamped either way, so the multiply in `earned` stays bounded by the analysis in
    // math.rs whichever path got here.
    let weight = position.weight.min(pool.total_weighted);
    position.rewards_owed = earned(
        weight,
        pool.reward_per_weight_stored,
        position.reward_per_weight_paid,
        position.rewards_owed,
    );
    position.reward_per_weight_paid = pool.reward_per_weight_stored;
    Ok(())
}

/// Every path except the hatch: refuse a desynchronised ledger rather than paying on it.
fn accrue_position(pool: &Pool, position: &mut Position) -> Result<()> {
    accrue_position_inner(pool, position, true)
}

/// The hatch: clamp and continue. Principal must leave even if the reward ledger is wrong.
fn accrue_position_lenient(pool: &Pool, position: &mut Position) -> Result<()> {
    accrue_position_inner(pool, position, false)
}

/// Debit a closing position from the pool ledger. Every decrement is FLOORED (I-8).
fn debit_closed(pool: &mut Pool, user: &mut UserStats, position: &Position) {
    pool.total_principal = pool.total_principal.saturating_sub(position.amount);
    // AUDIT M-4: release the wallet's allocation. Omitting this would let a wallet stake
    // up to its share ONCE and then be refused forever, turning a fairness guard into a
    // denial of service against the honest users it protects. Floored, like every other
    // ledger decrement (I-8).
    user.principal = user.principal.saturating_sub(position.amount);
    pool.total_weighted = pool.total_weighted.saturating_sub(position.weight);
    user.open_positions = user.open_positions.saturating_sub(1);
}

fn pool_signer_seeds<'a>(mint: &'a Pubkey, nonce: &'a [u8; 1], bump: &'a [u8; 1]) -> [&'a [u8]; 4] {
    [POOL_SEED, mint.as_ref(), nonce, bump]
}

#[program]
pub mod bayla_ladder {
    use super::*;

    /// Create a pool for `mint`. Deployer-gated (see [`deployer`]). Runs the mint gate
    /// once, pins the token program to the mint's actual owner, and creates both vaults.
    pub fn initialize_pool(
        ctx: Context<InitializePool>,
        nonce: u8,
        min_stake: u64,
        deposit_cap: u64,
        max_wallet_principal: u64,
    ) -> Result<()> {
        // AUDIT L-6. `decimals` is bounded FIRST, and not for tidiness: the `10u64.pow`
        // below overflows above 19, and `overflow-checks = true` in the workspace
        // profile turns that into a panic. Nine is the ceiling Solana mints use.
        let decimals = ctx.accounts.mint.decimals;
        require!(decimals <= 9, LadderError::InvalidParameter);

        // AUDIT L-6, the substance. `HARD_MIN_STAKE_RAW` is decimals-BLIND: 10,000 raw
        // is 0.01 BAYLA at 6dp but 1e-14 tokens at 18dp — and there is no
        // `set_min_stake` anywhere, so a pool initialised at the floor is unfixable
        // except by migrating every staker. The reference spends 35 lines
        // (LighthouseLadder.sol:101-135) on why its floor had to be a real quantity
        // rather than a raw count. Bind it to the mint: 100 whole tokens, whatever the
        // decimals are.
        //
        // NOT made settable later, deliberately: raising `min_stake` lifts the I-11
        // burn threshold above the weight of already-open positions and starts burning
        // intervals for legitimate live stakers.
        let floor = 100u64
            .checked_mul(10u64.pow(decimals as u32))
            .ok_or(LadderError::Overflow)?;
        require!(
            min_stake >= HARD_MIN_STAKE_RAW,
            LadderError::InvalidParameter
        );
        require!(min_stake >= floor, LadderError::InvalidParameter);
        require!(deposit_cap >= min_stake, LadderError::InvalidParameter);
        // AUDIT M-4. Both bounds required, so the value cannot be reached by omission.
        require!(
            max_wallet_principal >= min_stake && max_wallet_principal <= deposit_cap,
            LadderError::InvalidParameter
        );
        token::assert_mint_admissible(&ctx.accounts.mint)?;
        // Pin to what ACTUALLY owns the mint. BAYLA is Token-2022; the first Streamflow
        // broadcast died with IncorrectProgramId for assuming legacy. Detect, never assume.
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            *ctx.accounts.mint.to_account_info().owner,
            LadderError::WrongTokenProgram
        );

        let pool = &mut ctx.accounts.pool;
        pool.bump = ctx.bumps.pool;
        pool.nonce = nonce;
        pool.mint = ctx.accounts.mint.key();
        pool.token_program = ctx.accounts.token_program.key();
        pool.decimals = ctx.accounts.mint.decimals;
        pool.authority = ctx.accounts.payer.key();
        pool.pending_authority = Pubkey::default();
        pool.stake_vault = ctx.accounts.stake_vault.key();
        pool.reward_vault = ctx.accounts.reward_vault.key();
        pool.min_stake = min_stake;
        pool.deposit_cap = deposit_cap;
        pool.max_wallet_principal = max_wallet_principal;
        // Everything else starts at zero, which is the correct initial state for a
        // Synthetix engine: no rate, no period, no emission, no liability.
        Ok(())
    }

    /// Open a position. Every stake is its OWN position: no top-up, so no boost
    /// blending and no way to buy a high multiplier for a short commitment.
    pub fn stake(ctx: Context<Stake>, amount: u64, lock_secs: i64) -> Result<()> {
        // AUDIT M-3, entry side. `degraded` used to be read in exactly ONE expression in
        // the whole program (the hatch's penalty), so after it fired anyone could open a
        // 4-year position, take the 4.00x weight, and close it in the next slot for full
        // principal and zero penalty — accrual preserved into `rewards_carried`. The
        // ladder prices exactly one thing, commitment, and the flag removed the
        // commitment while leaving the price. Honest stakers on short rungs were diluted
        // by an actor who posted no lock at all.
        //
        // THE TRADE-OFF, stated rather than glossed: this hands the authority an
        // IRREVERSIBLE deposit freeze, and `pause` is on the deliberately-absent list.
        // The objection is weaker than it looks. A pause is reversible and its abuse is
        // to TRAP people; this is one-way and can only ever RELEASE them — a stolen key
        // firing it gives the thief nothing and gives every staker a free exit. And a
        // pool whose operator has declared it broken should not be taking new money.
        require!(!ctx.accounts.pool.degraded, LadderError::PoolDegraded);
        require!(amount > 0, LadderError::ZeroAmount);
        require!(lock_secs >= MIN_LOCK_SECS, LadderError::LockTooShort);
        require!(lock_secs <= MAX_LOCK_SECS, LadderError::LockTooLong);
        require!(
            ctx.accounts.user_stats.open_positions < MAX_POSITIONS,
            LadderError::TooManyPositions
        );
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            ctx.accounts.pool.token_program,
            LadderError::WrongTokenProgram
        );
        let now = Clock::get()?.unix_timestamp;
        checkpoint(&mut ctx.accounts.pool, now);

        // I-10: credit only what ARRIVED. The mint gate refuses fee-on-transfer mints,
        // but the ledger must be right even if that gate is ever wrong.
        let before = ctx.accounts.stake_vault.amount;
        token::transfer_from_user_to_vault(
            ctx.accounts.owner.to_account_info(),
            ctx.accounts.owner_ata.to_account_info(),
            ctx.accounts.stake_vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            amount,
            ctx.accounts.pool.decimals,
        )?;
        ctx.accounts.stake_vault.reload()?;
        let received = ctx.accounts.stake_vault.amount.saturating_sub(before);
        require!(
            received >= ctx.accounts.pool.min_stake,
            LadderError::BelowMinStake
        );

        let pool = &mut ctx.accounts.pool;
        // I-13
        let new_principal = pool
            .total_principal
            .checked_add(received)
            .ok_or(LadderError::Overflow)?;
        require!(
            new_principal <= pool.deposit_cap,
            LadderError::DepositCapExceeded
        );
        // AUDIT M-4: the per-wallet share, against this wallet's LIVE principal — which
        // `debit_closed` decrements, so an exit frees the allocation again.
        let wallet_principal = ctx
            .accounts
            .user_stats
            .principal
            .checked_add(received)
            .ok_or(LadderError::Overflow)?;
        require!(
            wallet_principal <= pool.max_wallet_principal,
            LadderError::WalletCapExceeded
        );

        let weight = weight_for(received, lock_secs);
        let user = &mut ctx.accounts.user_stats;
        if user.owner == Pubkey::default() {
            user.bump = ctx.bumps.user_stats;
            user.pool = pool.key();
            user.owner = ctx.accounts.owner.key();
        }
        let nonce = user.next_nonce;

        let position = &mut ctx.accounts.position;
        position.bump = ctx.bumps.position;
        position.pool = pool.key();
        position.owner = ctx.accounts.owner.key();
        position.nonce = nonce;
        position.amount = received;
        position.weight = weight;
        position.lock_end = now.checked_add(lock_secs).ok_or(LadderError::Overflow)?;
        // A fresh position starts at the CURRENT accumulator, so it earns forward only.
        position.reward_per_weight_paid = pool.reward_per_weight_stored;
        position.rewards_owed = 0;

        pool.total_principal = new_principal;
        user.principal = wallet_principal;
        pool.total_weighted = pool.total_weighted.saturating_add(weight);
        user.next_nonce = nonce.checked_add(1).ok_or(LadderError::Overflow)?;
        user.open_positions = user.open_positions.saturating_add(1);

        // I-1, post-reload.
        require!(
            ctx.accounts.stake_vault.amount >= pool.total_principal,
            LadderError::PrincipalInvariant
        );

        emit!(Staked {
            pool: pool.key(),
            owner: ctx.accounts.owner.key(),
            nonce,
            amount: received,
            lock_secs,
            weight,
        });
        Ok(())
    }

    /// Claim rewards without closing anything. Pays what the reward vault can cover;
    /// the rest stays owed (I-2).
    pub fn claim(ctx: Context<Claim>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            ctx.accounts.pool.token_program,
            LadderError::WrongTokenProgram
        );
        let now = Clock::get()?.unix_timestamp;
        checkpoint(&mut ctx.accounts.pool, now);
        accrue_position(&ctx.accounts.pool, &mut ctx.accounts.position)?;

        let (pay, rest) = payable(
            ctx.accounts.position.rewards_owed,
            ctx.accounts.reward_vault.amount,
        );
        ctx.accounts.position.rewards_owed = rest;
        ctx.accounts.pool.rewards_paid = ctx.accounts.pool.rewards_paid.saturating_add(pay as u128);

        let pool = &ctx.accounts.pool;
        let nonce_b = [pool.nonce];
        let bump_b = [pool.bump];
        let seeds = pool_signer_seeds(&pool.mint, &nonce_b, &bump_b);
        token::transfer_from_vault(
            pool.to_account_info(),
            ctx.accounts.reward_vault.to_account_info(),
            ctx.accounts.owner_ata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            pay,
            pool.decimals,
            &[&seeds],
        )?;
        emit!(RewardPaid {
            pool: pool.key(),
            owner: ctx.accounts.owner.key(),
            nonce: ctx.accounts.position.nonce,
            amount: pay,
            deferred: rest,
        });
        Ok(())
    }

    /// Close a MATURED position: principal in full, rewards paid.
    pub fn withdraw_matured(ctx: Context<Exit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= ctx.accounts.position.lock_end,
            LadderError::StillLocked
        );
        exit_with_penalty(ctx, now, 0)
    }

    /// Leave BEFORE the lock ends: principal minus 25%, rewards paid. The penalty
    /// stays in the pool as reward budget.
    pub fn early_exit(ctx: Context<Exit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        // The reference's H-3: a matured position must never eat a penalty by
        // accident — send it to the free door instead of silently charging.
        require!(
            now < ctx.accounts.position.lock_end,
            LadderError::UseWithdrawMatured
        );
        // AUDIT M-3, exit side. This used to charge unconditionally, so in a degraded
        // pool `emergency_withdraw` STRICTLY DOMINATED the door named after what the
        // user is actually doing: 100% of principal against 75%, with `claim_carried`
        // delivering the identical reward payout. Nobody could be forced into the paying
        // door — `EmergencyWithdraw`'s account set is a strict subset of `Exit`'s — but
        // they could pick it by name and burn 25% for nothing. The doors now agree.
        let penalty = if ctx.accounts.pool.degraded {
            0
        } else {
            penalty_for(ctx.accounts.position.amount)
        };
        exit_with_penalty(ctx, now, penalty)
    }

    /// THE LAST RESORT. Principal only, at ANY time — including while locked (paying
    /// the 25% unless the pool is degraded) and including when the reward vault is
    /// empty, closed, or wedged. This instruction declares NO reward vault (I-12).
    ///
    /// AUDIT C3: it still checkpoints, because a checkpoint is pure accounting and
    /// cannot fail on a vault — and skipping it would shrink the accumulator's divisor
    /// without banking the window, repricing every other staker retroactively. The
    /// caller's own accrual is preserved in `UserStats.rewards_carried`, claimable
    /// later via `claim_carried`, rather than deleted with the position.
    pub fn emergency_withdraw(ctx: Context<EmergencyWithdraw>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            ctx.accounts.pool.token_program,
            LadderError::WrongTokenProgram
        );
        let now = Clock::get()?.unix_timestamp;
        checkpoint(&mut ctx.accounts.pool, now);
        // LENIENT on purpose — see `accrue_position_inner`. Nothing about the reward
        // ledger may stand between a staker and their principal.
        accrue_position_lenient(&ctx.accounts.pool, &mut ctx.accounts.position)?;

        let position = &ctx.accounts.position;
        let locked = now < position.lock_end;
        let penalty = if locked && !ctx.accounts.pool.degraded {
            penalty_for(position.amount)
        } else {
            0
        };
        let out = position.amount.saturating_sub(penalty);

        let user = &mut ctx.accounts.user_stats;
        user.rewards_carried = user.rewards_carried.saturating_add(position.rewards_owed);

        let pool = &mut ctx.accounts.pool;
        debit_closed(pool, user, position);
        // The penalty stays in the stake vault, un-principalled, until swept.
        pool.orphaned_penalty = pool.orphaned_penalty.saturating_add(penalty);

        let nonce_b = [pool.nonce];
        let bump_b = [pool.bump];
        let seeds = pool_signer_seeds(&pool.mint, &nonce_b, &bump_b);
        token::transfer_from_vault(
            pool.to_account_info(),
            ctx.accounts.stake_vault.to_account_info(),
            ctx.accounts.owner_ata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            out,
            pool.decimals,
            &[&seeds],
        )?;
        ctx.accounts.stake_vault.reload()?;
        require!(
            ctx.accounts.stake_vault.amount >= ctx.accounts.pool.total_principal,
            LadderError::PrincipalInvariant
        );
        emit!(Withdrawn {
            pool: ctx.accounts.pool.key(),
            owner: ctx.accounts.owner.key(),
            nonce: ctx.accounts.position.nonce,
            amount: out,
            penalty,
            emergency: true,
        });
        Ok(())
    }

    /// Pay out rewards a position carried into `UserStats` when it left through the
    /// emergency hatch. Same I-2 rule: pays what the vault holds, defers the rest.
    pub fn claim_carried(ctx: Context<ClaimCarried>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            ctx.accounts.pool.token_program,
            LadderError::WrongTokenProgram
        );
        let (pay, rest) = payable(
            ctx.accounts.user_stats.rewards_carried,
            ctx.accounts.reward_vault.amount,
        );
        ctx.accounts.user_stats.rewards_carried = rest;
        ctx.accounts.pool.rewards_paid = ctx.accounts.pool.rewards_paid.saturating_add(pay as u128);
        let pool = &ctx.accounts.pool;
        let nonce_b = [pool.nonce];
        let bump_b = [pool.bump];
        let seeds = pool_signer_seeds(&pool.mint, &nonce_b, &bump_b);
        token::transfer_from_vault(
            pool.to_account_info(),
            ctx.accounts.reward_vault.to_account_info(),
            ctx.accounts.owner_ata.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            pay,
            pool.decimals,
            &[&seeds],
        )?;
        emit!(RewardPaid {
            pool: pool.key(),
            owner: ctx.accounts.owner.key(),
            nonce: u32::MAX, // carried, not a live position
            amount: pay,
            deferred: rest,
        });
        Ok(())
    }

    /// Permissionless. Carries penalties the emergency hatch left in the stake vault
    /// across to the reward vault. Fixed destination — no discretion, nothing to steer.
    pub fn sweep_orphaned_penalty(ctx: Context<Sweep>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            ctx.accounts.pool.token_program,
            LadderError::WrongTokenProgram
        );
        let amount = ctx.accounts.pool.orphaned_penalty;
        require!(amount > 0, LadderError::NothingToSweep);
        let pool = &mut ctx.accounts.pool;
        pool.orphaned_penalty = 0;
        pool.penalty_collected_cumulative = pool
            .penalty_collected_cumulative
            .saturating_add(amount as u128);
        let nonce_b = [pool.nonce];
        let bump_b = [pool.bump];
        let seeds = pool_signer_seeds(&pool.mint, &nonce_b, &bump_b);
        token::transfer_from_vault(
            pool.to_account_info(),
            ctx.accounts.stake_vault.to_account_info(),
            ctx.accounts.reward_vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            amount,
            pool.decimals,
            &[&seeds],
        )?;
        ctx.accounts.stake_vault.reload()?;
        require!(
            ctx.accounts.stake_vault.amount >= ctx.accounts.pool.total_principal,
            LadderError::PrincipalInvariant
        );
        emit!(PenaltySwept {
            pool: ctx.accounts.pool.key(),
            amount,
        });
        Ok(())
    }

    /// Open a 90-day window. Owner decision 2026-09-06: reload every 90 days, distribute
    /// per second.
    ///
    /// TWO SOURCES, deliberately separated (AUDIT H-1):
    ///   `amount`      fresh tokens transferred in by the authority in THIS instruction.
    ///                 Counted into `reward_funded_cumulative`, which is why the transfer
    ///                 lives here rather than being inferred from a balance.
    ///   `from_budget` tokens ALREADY in the reward vault and not yet pledged — retained
    ///                 early-exit penalties, swept emergency-hatch penalties, the
    ///                 un-emitted tail of a lapsed window, a stranger's donation.
    ///
    /// Before the split, the rate was a pure function of `amount`, so every token in the
    /// second category was permanently unspendable: lifetime emission could not exceed
    /// the sum of the `amount`s, and there is no `recover_tokens` and no `close_pool`.
    /// The pool promised leavers' penalties to whoever stayed (`exit_with_penalty`) and
    /// could not deliver them. `sweep_orphaned_penalty` moved tokens into a vault they
    /// could never leave.
    ///
    /// Solvency is unchanged and is still what bounds this: the resulting rate is checked
    /// against `fundable()`, the real vault balance minus everything already owed. Naming
    /// `from_budget` cannot conjure a token — it can only point the schedule at one that
    /// is physically present and unpledged.
    pub fn notify_reward(ctx: Context<NotifyReward>, amount: u64, from_budget: u64) -> Result<()> {
        // Either source alone is a legitimate reload. Scheduling a retained penalty with
        // no fresh capital is the whole point of the split, so `amount` may be zero —
        // but a call that schedules nothing at all is still refused.
        require!(amount > 0 || from_budget > 0, LadderError::ZeroAmount);
        require_keys_eq!(
            ctx.accounts.token_program.key(),
            ctx.accounts.pool.token_program,
            LadderError::WrongTokenProgram
        );
        let now = Clock::get()?.unix_timestamp;
        checkpoint(&mut ctx.accounts.pool, now);

        token::transfer_from_user_to_vault(
            ctx.accounts.authority.to_account_info(),
            ctx.accounts.funder_ata.to_account_info(),
            ctx.accounts.reward_vault.to_account_info(),
            ctx.accounts.mint.to_account_info(),
            ctx.accounts.token_program.to_account_info(),
            amount,
            ctx.accounts.pool.decimals,
        )?;
        ctx.accounts.reward_vault.reload()?;
        let vault = ctx.accounts.reward_vault.amount;

        let pool = &mut ctx.accounts.pool;
        pool.reward_funded_cumulative =
            pool.reward_funded_cumulative.saturating_add(amount as u128);

        // I-4, in its solvent form: everything emitted and not yet paid must be
        // physically in the vault. This is the TegridyRestaking bug as a `require!`.
        let outstanding = pool.rewards_emitted.saturating_sub(pool.rewards_paid);
        require!(
            outstanding <= vault as u128,
            LadderError::EmissionExceedsFunding
        );

        // I-3 (AUDIT C2): the new rate may draw only on what is left after reserving
        // that liability. Upstream Synthetix compares against the whole balance; in a
        // same-token pool that counts staked principal as budget — the hazard named in
        // VENDOR.md — and even the surplus alone double-pledges what is already owed.
        let scheduled = scheduled_total(amount, from_budget);
        let rate = new_reward_rate(scheduled, now, pool.period_finish, pool.reward_rate);
        let budget = fundable(vault, pool.rewards_emitted, pool.rewards_paid);
        require!(
            rate <= budget / (REWARDS_DURATION_SECS as u128),
            LadderError::RewardTooHigh
        );
        // AUDIT L-1. `rate = scheduled / REWARDS_DURATION_SECS`, integer division, so a
        // small-but-real reload truncates to a rate of ZERO — the window is extended by
        // 90 days, `RewardAdded` fires with a healthy-looking payload, and the pool emits
        // nothing. Worse mid-window: the fold-in at math.rs:203 means a 1-unit top-up
        // against a live tail can truncate the WHOLE remaining schedule away.
        //
        // Cost of this guard, stated rather than discovered later: the minimum reload is
        // `REWARDS_DURATION_SECS` raw units — 7.776 whole tokens at 6 decimals, but
        // 7,776,000 WHOLE tokens on a 0-decimal mint, which such a mint may not have.
        // That is the right refusal: a per-second stream is not expressible there.
        require!(rate > 0, LadderError::RewardRateTooSmall);
        // AUDIT M-2, the total-burn half. Even a non-zero rate emits EXACTLY NOTHING
        // when `rate * PRECISION < total_weighted`, because the accumulator step floors
        // to zero every interval. At full participation that is any 90-day budget under
        // ~30,855 BAYLA — and it failed silently, with a healthy-looking `RewardAdded`
        // and no error. The residue carry softens it but cannot fix it: a permanent
        // sub-unit rate never accumulates past the divisor. Refuse the window instead.
        require!(
            pool.total_weighted == 0 || rate.saturating_mul(PRECISION) >= pool.total_weighted,
            LadderError::RewardRateTooSmall
        );

        pool.reward_rate = rate;
        pool.last_update_time = now;
        pool.period_finish = now
            .checked_add(REWARDS_DURATION_SECS)
            .ok_or(LadderError::Overflow)?;
        emit!(RewardAdded {
            pool: pool.key(),
            amount,
            from_budget,
            reward_rate: rate,
            period_finish: pool.period_finish,
        });
        Ok(())
    }

    pub fn propose_authority(ctx: Context<AuthorityOnly>, new_authority: Pubkey) -> Result<()> {
        ctx.accounts.pool.pending_authority = new_authority;
        emit!(AuthorityProposed {
            pool: ctx.accounts.pool.key(),
            current: ctx.accounts.pool.authority,
            proposed: new_authority,
        });
        Ok(())
    }

    pub fn accept_authority(ctx: Context<AcceptAuthority>) -> Result<()> {
        let previous = ctx.accounts.pool.authority;
        let pool = &mut ctx.accounts.pool;
        pool.authority = ctx.accounts.pending.key();
        pool.pending_authority = Pubkey::default();
        emit!(AuthorityAccepted {
            pool: pool.key(),
            previous,
            current: pool.authority,
        });
        Ok(())
    }

    /// I-13. Raise-only. Takes effect after `CAP_TIMELOCK_SECS` via `execute_cap_raise`.
    pub fn propose_cap_raise(ctx: Context<AuthorityOnly>, new_cap: u64) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(new_cap > pool.deposit_cap, LadderError::CapCanOnlyRaise);
        pool.pending_cap = new_cap;
        pool.pending_cap_ts = Clock::get()?.unix_timestamp;
        emit!(CapRaiseProposed {
            pool: pool.key(),
            current_cap: pool.deposit_cap,
            proposed_cap: new_cap,
            executable_at: pool.pending_cap_ts.saturating_add(CAP_TIMELOCK_SECS),
        });
        Ok(())
    }

    /// AUDIT L-7. `propose_cap_raise` requires `new_cap > deposit_cap`, so a pending
    /// proposal could be shrunk to +1 but never returned to zero — and
    /// `execute_cap_raise` is permissionless with no staleness check, so a proposal made
    /// a year ago stays executable on demand. This is the missing half: the authority
    /// can abandon its own proposal. Adds no Pool fields, so every pinned size holds.
    pub fn cancel_cap_raise(ctx: Context<AuthorityOnly>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.pending_cap > 0, LadderError::NoPendingChange);
        let abandoned = pool.pending_cap;
        pool.pending_cap = 0;
        pool.pending_cap_ts = 0;
        emit!(CapRaiseCancelled {
            pool: pool.key(),
            abandoned_cap: abandoned,
        });
        Ok(())
    }

    /// Permissionless once the timelock has elapsed.
    pub fn execute_cap_raise(ctx: Context<ExecuteCapRaise>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(pool.pending_cap > 0, LadderError::NoPendingChange);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now >= pool.pending_cap_ts.saturating_add(CAP_TIMELOCK_SECS),
            LadderError::TimelockNotElapsed
        );
        // Re-checked at execution: a raise proposed above the cap is still above it.
        require!(
            pool.pending_cap > pool.deposit_cap,
            LadderError::CapCanOnlyRaise
        );
        let previous = pool.deposit_cap;
        pool.deposit_cap = pool.pending_cap;
        pool.pending_cap = 0;
        pool.pending_cap_ts = 0;
        emit!(CapRaised {
            pool: pool.key(),
            previous_cap: previous,
            new_cap: pool.deposit_cap,
        });
        Ok(())
    }

    /// ONE-WAY. After this, the emergency hatch charges no penalty while locked.
    pub fn declare_degraded(ctx: Context<AuthorityOnly>) -> Result<()> {
        let pool = &mut ctx.accounts.pool;
        require!(!pool.degraded, LadderError::AlreadyDegraded);
        pool.degraded = true;
        emit!(Degraded { pool: pool.key() });
        Ok(())
    }
}

/// The shared body of `withdraw_matured` and `early_exit`. AUDIT C1 ordering, made
/// structural: rewards are settled and paid BEFORE the position is debited from the
/// ledger and closed.
fn exit_with_penalty(ctx: Context<Exit>, now: i64, penalty: u64) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.token_program.key(),
        ctx.accounts.pool.token_program,
        LadderError::WrongTokenProgram
    );
    checkpoint(&mut ctx.accounts.pool, now);
    accrue_position(&ctx.accounts.pool, &mut ctx.accounts.position)?;

    // I-14: pay first.
    let (pay, rest) = payable(
        ctx.accounts.position.rewards_owed,
        ctx.accounts.reward_vault.amount,
    );
    ctx.accounts.pool.rewards_paid = ctx.accounts.pool.rewards_paid.saturating_add(pay as u128);
    // A deferred balance on a CLOSING position is carried to the wallet, not lost.
    ctx.accounts.user_stats.rewards_carried =
        ctx.accounts.user_stats.rewards_carried.saturating_add(rest);
    ctx.accounts.position.rewards_owed = 0;

    let amount = ctx.accounts.position.amount;
    let out = amount.saturating_sub(penalty);
    let nonce_v = ctx.accounts.position.nonce;

    {
        let position = &ctx.accounts.position;
        let user = &mut ctx.accounts.user_stats;
        let pool = &mut ctx.accounts.pool;
        debit_closed(pool, user, position);
        pool.penalty_collected_cumulative = pool
            .penalty_collected_cumulative
            .saturating_add(penalty as u128);
    }

    let pool = &ctx.accounts.pool;
    let nonce_b = [pool.nonce];
    let bump_b = [pool.bump];
    let seeds = pool_signer_seeds(&pool.mint, &nonce_b, &bump_b);

    // Rewards, from the REWARD vault.
    token::transfer_from_vault(
        pool.to_account_info(),
        ctx.accounts.reward_vault.to_account_info(),
        ctx.accounts.owner_ata.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        pay,
        pool.decimals,
        &[&seeds],
    )?;
    // The penalty, stake vault -> reward vault, so it becomes budget for whoever stays.
    token::transfer_from_vault(
        pool.to_account_info(),
        ctx.accounts.stake_vault.to_account_info(),
        ctx.accounts.reward_vault.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        penalty,
        pool.decimals,
        &[&seeds],
    )?;
    // Principal, from the STAKE vault.
    token::transfer_from_vault(
        pool.to_account_info(),
        ctx.accounts.stake_vault.to_account_info(),
        ctx.accounts.owner_ata.to_account_info(),
        ctx.accounts.mint.to_account_info(),
        ctx.accounts.token_program.to_account_info(),
        out,
        pool.decimals,
        &[&seeds],
    )?;
    ctx.accounts.stake_vault.reload()?;
    require!(
        ctx.accounts.stake_vault.amount >= ctx.accounts.pool.total_principal,
        LadderError::PrincipalInvariant
    );
    emit!(RewardPaid {
        pool: pool.key(),
        owner: ctx.accounts.owner.key(),
        nonce: nonce_v,
        amount: pay,
        deferred: rest,
    });
    emit!(Withdrawn {
        pool: pool.key(),
        owner: ctx.accounts.owner.key(),
        nonce: nonce_v,
        amount: out,
        penalty,
        emergency: false,
    });
    Ok(())
}

/* ═══════════════════════════════ accounts ═══════════════════════════════ */

// EVERY Account / InterfaceAccount below is BOXED. First CI compile (2026-09-06):
// `Exit::try_accounts` came in at 4152 bytes against SBF's 4096-byte frame — over
// by 56 — and Stake / EmergencyWithdraw sit within a few bytes of the same line.
// cp-swap boxes all of its InterfaceAccounts for exactly this; the workspace's
// migration-rehearsal job even prints "Box large Account<T> fields" as the remedy.
// Boxing moves the deserialised account to the heap and changes nothing else:
// deref coercion carries every field access, method call and `&mut Pool` argument.

#[derive(Accounts)]
#[instruction(nonce: u8)]
pub struct InitializePool<'info> {
    #[account(mut, address = deployer::ID @ LadderError::NotDeployAuthority)]
    pub payer: Signer<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [POOL_SEED, mint.key().as_ref(), &[nonce]],
        bump,
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
        seeds = [STAKE_VAULT_SEED, pool.key().as_ref()],
        bump,
    )]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = payer,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
        seeds = [REWARD_VAULT_SEED, pool.key().as_ref()],
        bump,
    )]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// Declared BEFORE `position`: its `next_nonce` seeds the position, and Anchor
    /// evaluates constraints in declaration order.
    #[account(
        init_if_needed,
        payer = owner,
        space = 8 + UserStats::INIT_SPACE,
        seeds = [USER_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump,
    )]
    pub user_stats: Box<Account<'info, UserStats>>,
    #[account(
        init,
        payer = owner,
        space = 8 + Position::INIT_SPACE,
        seeds = [POSITION_SEED, pool.key().as_ref(), owner.key().as_ref(), &user_stats.next_nonce.to_le_bytes()],
        bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, constraint = owner_ata.mint == pool.mint && owner_ata.owner == owner.key())]
    pub owner_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// A reward-only path: it is handed the REWARD vault and nothing else (I-12).
#[derive(Accounts)]
pub struct Claim<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        has_one = pool,
        has_one = owner,
        seeds = [POSITION_SEED, pool.key().as_ref(), owner.key().as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, constraint = owner_ata.mint == pool.mint && owner_ata.owner == owner.key())]
    pub owner_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// `withdraw_matured` and `early_exit`. The position is DELETED on the way out (I-7).
#[derive(Accounts)]
pub struct Exit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        has_one = pool,
        has_one = owner,
        seeds = [USER_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump = user_stats.bump,
    )]
    pub user_stats: Box<Account<'info, UserStats>>,
    #[account(
        mut,
        close = owner,
        has_one = pool,
        has_one = owner,
        seeds = [POSITION_SEED, pool.key().as_ref(), owner.key().as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, constraint = owner_ata.mint == pool.mint && owner_ata.owner == owner.key())]
    pub owner_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// THE HATCH. Note what is missing: there is no `reward_vault` here, by design (I-12).
/// Nothing about the reward side — empty, closed, frozen, wedged — can stop it.
#[derive(Accounts)]
pub struct EmergencyWithdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        has_one = pool,
        has_one = owner,
        seeds = [USER_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump = user_stats.bump,
    )]
    pub user_stats: Box<Account<'info, UserStats>>,
    #[account(
        mut,
        close = owner,
        has_one = pool,
        has_one = owner,
        seeds = [POSITION_SEED, pool.key().as_ref(), owner.key().as_ref(), &position.nonce.to_le_bytes()],
        bump = position.bump,
    )]
    pub position: Box<Account<'info, Position>>,
    #[account(mut, constraint = owner_ata.mint == pool.mint && owner_ata.owner == owner.key())]
    pub owner_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ClaimCarried<'info> {
    pub owner: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        has_one = pool,
        has_one = owner,
        seeds = [USER_SEED, pool.key().as_ref(), owner.key().as_ref()],
        bump = user_stats.bump,
    )]
    pub user_stats: Box<Account<'info, UserStats>>,
    #[account(mut, constraint = owner_ata.mint == pool.mint && owner_ata.owner == owner.key())]
    pub owner_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Permissionless: anyone may pay the fee to carry orphaned penalties across.
#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = pool.stake_vault)]
    pub stake_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct NotifyReward<'info> {
    #[account(address = pool.authority @ LadderError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(address = pool.mint)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, constraint = funder_ata.mint == pool.mint && funder_ata.owner == authority.key())]
    pub funder_ata: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = pool.reward_vault)]
    pub reward_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AuthorityOnly<'info> {
    #[account(address = pool.authority @ LadderError::Unauthorized)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(Accounts)]
pub struct AcceptAuthority<'info> {
    #[account(address = pool.pending_authority @ LadderError::Unauthorized)]
    pub pending: Signer<'info>,
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(Accounts)]
pub struct ExecuteCapRaise<'info> {
    #[account(mut)]
    pub pool: Box<Account<'info, Pool>>,
}

/* ═════════════════════════════ layout tests ═════════════════════════════ */

#[cfg(test)]
mod layout_tests {
    use super::*;

    /// ACCOUNT SIZES ARE A CLIENT CONTRACT. Pinned as literals so a test cannot agree
    /// with the struct by construction — see tegridy-launch for the decoder that shipped
    /// against a stale size. Hand-summed from the field list; CI is the arbiter.
    #[test]
    fn account_sizes_are_pinned() {
        assert_eq!(
            8 + Pool::INIT_SPACE,
            508,
            "Pool size moved — every decoder moves with it"
        );
        // Pool STAYS 508: the two truncation residues were carved OUT of `_reserved`,
        // not appended, so no decoder and no rent floor moves for it.
        //
        // Position and UserStats grew ONCE, deliberately, to gain the upgrade padding
        // Pool already had (audit L-8): 141 -> 205 and 94 -> 126. Free now, IMPOSSIBLE
        // after deploy. Cost is +0.000445 and +0.000223 SOL of rent per account.
        assert_eq!(8 + Position::INIT_SPACE, 205, "Position size moved");
        assert_eq!(8 + UserStats::INIT_SPACE, 126, "UserStats size moved");
    }

    /// ERROR CODES ARE A CLIENT CONTRACT TOO. New variants go LAST.
    #[test]
    fn error_codes_are_stable() {
        assert_eq!(LadderError::Overflow as u32 + 6000, 6000);
        assert_eq!(LadderError::StillLocked as u32 + 6000, 6007);
        assert_eq!(LadderError::UseWithdrawMatured as u32 + 6000, 6008);
        assert_eq!(LadderError::PrincipalInvariant as u32 + 6000, 6021);
        assert_eq!(LadderError::NothingToSweep as u32 + 6000, 6023);
        assert_eq!(LadderError::RewardRateTooSmall as u32 + 6000, 6024);
        assert_eq!(LadderError::MintHasMintAuthority as u32 + 6000, 6025);
        assert_eq!(LadderError::PoolDegraded as u32 + 6000, 6026);
        assert_eq!(LadderError::WalletCapExceeded as u32 + 6000, 6027);
        // 14 instructions -> 15 with cancel_cap_raise; no new error variants needed.
    }

    /// THE DEPLOYER GATE MUST NOT BE THE PROGRAM ITSELF (audit L-5).
    ///
    /// A `const _: () = assert!(...)` cannot express this: `PartialEq` for `Pubkey`
    /// is not a const trait on stable, so the comparison has to happen in a test.
    /// Both arms are pinned, because each fails a different way — the devnet arm
    /// makes the program untestable, and a non-sentinel mainnet arm would make an
    /// unprotected initializer shippable.
    #[test]
    fn the_deployer_gate_is_not_the_program_itself() {
        #[cfg(feature = "devnet")]
        assert_ne!(
            deployer::ID,
            crate::ID,
            "devnet deployer == the program's own address: initialize_pool would demand a              signature from a loader-owned account and no Pool could ever be created"
        );
        #[cfg(not(feature = "devnet"))]
        assert_eq!(
            deployer::ID,
            Pubkey::default(),
            "a non-devnet build must keep the fail-closed System-program sentinel — a              placeholder that WORKS is how an unprotected initializer ships"
        );
    }

    /// THE HATCH MUST NOT REVERT ON A DESYNCHRONISED LEDGER.
    ///
    /// I-9 is a `require!` everywhere it can refuse without stranding anything. On
    /// `emergency_withdraw` it cannot: a revert there converts a survivable accounting
    /// drift into permanently trapped principal, which is the one outcome this program
    /// exists to prevent. This pins the asymmetry so a future edit cannot quietly make
    /// the hatch strict again.
    #[test]
    fn the_hatch_clamps_where_every_other_path_refuses() {
        let mut pool = Pool {
            total_weighted: 100, // ledger says less than the position claims
            min_stake: HARD_MIN_STAKE_RAW,
            ..Default::default()
        };
        pool.reward_per_weight_stored = 1_000_000_000_000_000;
        let mk = || Position {
            weight: 5_000, // > total_weighted: the desynchronised case
            ..Default::default()
        };

        // every other path REFUSES
        let mut p1 = mk();
        assert!(
            accrue_position(&pool, &mut p1).is_err(),
            "the strict paths must still refuse a desynchronised ledger"
        );

        // the hatch CONTINUES, clamped
        let mut p2 = mk();
        assert!(
            accrue_position_lenient(&pool, &mut p2).is_ok(),
            "the emergency hatch must never revert on the reward ledger"
        );
        // and it accrues on the clamped weight, not the inflated one
        assert_eq!(
            p2.rewards_owed,
            earned(100, pool.reward_per_weight_stored, 0, 0),
            "the hatch must accrue on min(weight, total_weighted)"
        );
    }

    /// ...AND THE HATCH MUST ACTUALLY BE WIRED TO IT.
    ///
    /// `the_hatch_clamps_where_every_other_path_refuses` proves the helper is lenient;
    /// it does NOT prove `emergency_withdraw` calls the lenient one. Mutation-checked
    /// and found wanting: swapping the call back to the strict version left every test
    /// green. A handler's Context cannot be built without a validator, so this pins the
    /// wiring at the source level, which is the same instrument the audit recommends
    /// for the `close =` coupling.
    #[test]
    fn the_hatch_is_wired_to_the_lenient_accrual() {
        let src = include_str!("lib.rs");
        let start = src
            .find("pub fn emergency_withdraw")
            .expect("emergency_withdraw not found — this test must be re-anchored");
        let body = &src[start
            ..start
                + src[start..]
                    .find(
                        "
    }",
                    )
                    .expect("could not find the end of emergency_withdraw")];
        assert!(
            body.contains("accrue_position_lenient("),
            "emergency_withdraw must use the LENIENT accrual — a require! on this path              turns an accounting drift into permanently trapped principal"
        );
        assert!(
            !body.contains("accrue_position(&"),
            "emergency_withdraw must NOT use the strict accrual"
        );
    }

    /// POSITION REVIVAL: the coupling that prevents it is undefended, so pin it.
    ///
    /// Audit L-9. Anchor 0.32.1's `close` writes no closed-account discriminator, so a
    /// closed `Position` sits in exactly the state `init` creates into. The ONLY thing
    /// stopping a close-and-recreate at the same nonce is that `UserStats.next_nonce`
    /// monotonically increments — and that holds solely because `UserStats` has no
    /// `close`, since `init_if_needed` would take the create branch on a System-owned
    /// account and reset it to zero. A `close_user_stats` rent-reclaim instruction is a
    /// one-line diff away from a double-withdraw, and is exactly what a UX pass asks
    /// for. This test is the tripwire.
    #[test]
    fn only_positions_are_ever_closed() {
        let src = include_str!("lib.rs");
        // Attribute lines only — the doc comment in the header mentions it too.
        let sites: Vec<&str> = src
            .lines()
            .filter(|l| l.trim_start().starts_with("close = "))
            .collect();
        assert_eq!(
            sites.len(),
            2,
            "expected exactly two `close =` constraints (Exit and EmergencyWithdraw), found {}: {:?}",
            sites.len(),
            sites
        );
        for l in &sites {
            assert!(
                l.trim() == "close = owner,",
                "a `close =` must return rent to the position OWNER, found: {l}"
            );
        }
        // The needle is SPLIT deliberately. Written as one literal it appears in this
        // very file, `include_str!` reads it back, and the assertion fires on clean
        // source — which it did on the first run. `concat!` resolves at compile time,
        // so the contiguous string never exists in the file being searched.
        let needle = concat!("pub fn ", "close_user_stats");
        assert!(
            !src.contains(needle),
            "adding close_user_stats resets next_nonce and makes Position revival              reachable — see the L-9 note in the header before doing this"
        );
    }

    /// The hatch must never be able to name a reward vault: its Accounts struct has no
    /// such field, so the compiler is the enforcement. This test documents the intent
    /// where a reviewer will look for it.
    #[test]
    fn the_emergency_hatch_declares_no_reward_vault() {
        // A structural property, checked by inspection of `EmergencyWithdraw` above.
        // If a `reward_vault` field is ever added there, delete this test and explain
        // in the commit why I-12 no longer holds.
    }

    /* ─────────────── why the MATURED door is a subset of the tested one ───────────────
     *
     * `withdraw_matured` cannot be driven on `solana-test-validator`: the minimum lock
     * is 7 days and the validator has no clock warp. That is a real coverage hole, and
     * these three pins are what bound it — they are NOT a substitute for execution, they
     * are the argument that the unexecuted delta is two lines wide.
     *
     * `withdraw_matured` is `exit_with_penalty(ctx, now, 0)`. `early_exit` is the SAME
     * function with a non-zero penalty, and CI drives it end-to-end every run. So the
     * matured door's untested delta is exactly:
     *   1. the maturity `require!` PASSING (its failing arm is tested), and
     *   2. `penalty == 0`, which `transfer_from_vault` short-circuits to a no-op — so
     *      the matured path issues FEWER CPIs than the path already proven.
     * Each of those is pinned below. See `tests/matured.rs` for the execution itself.
     */

    /// The matured door must charge NOTHING. A non-zero literal here is a silent 25%
    /// tax on every honest staker who waited out their lock.
    #[test]
    fn the_matured_door_charges_no_penalty() {
        let src = include_str!("lib.rs");
        let start = src
            .find("pub fn withdraw_matured")
            .expect("withdraw_matured not found — this test must be re-anchored");
        let body = &src[start
            ..start
                + src[start..]
                    .find(
                        "
    }",
                    )
                    .expect("could not find the end of withdraw_matured")];
        assert!(
            body.contains("exit_with_penalty(ctx, now, 0)"),
            "the matured door must pass a ZERO penalty — found:\n{body}"
        );
        assert!(
            !body.contains("penalty_for("),
            "withdraw_matured must never compute a penalty"
        );
    }

    /// THE TWO DOORS MUST PARTITION TIME, not merely differ.
    ///
    /// `withdraw_matured` demands `now >= lock_end`; `early_exit` demands `now <
    /// lock_end`. Together they are total: every position can always leave through
    /// exactly one of them. If either comparison is ever loosened to match the other's
    /// direction, a position becomes refused by BOTH doors — principal trapped until
    /// the hatch, which is the failure mode this whole program exists to end.
    #[test]
    fn the_two_doors_partition_time() {
        let src = include_str!("lib.rs");
        let door = |name: &str| -> String {
            let start = src.find(name).expect("door not found — re-anchor this test");
            src[start
                ..start
                    + src[start..]
                        .find(
                            "
    }",
                        )
                        .expect("could not find the end of the door")]
                .to_string()
        };
        let matured = door("pub fn withdraw_matured");
        let early = door("pub fn early_exit");
        assert!(
            matured.contains("now >= ctx.accounts.position.lock_end"),
            "withdraw_matured must admit exactly the matured half-line"
        );
        assert!(
            early.contains("now < ctx.accounts.position.lock_end"),
            "early_exit must admit exactly the complement — the two arms must not          overlap and must leave no position with no door"
        );
    }

    /// A ZERO TRANSFER IS SKIPPED, NOT ATTEMPTED — and that is load-bearing.
    ///
    /// It is what makes the matured path a strict SUBSET of the early-exit path CI
    /// already executes: with `penalty == 0` the stake->reward leg issues no CPI at
    /// all. Delete this guard and the matured door starts making an unproven
    /// zero-amount `transfer_checked` CPI that nothing in the suite has ever run.
    #[test]
    fn a_zero_transfer_is_skipped_not_attempted() {
        let src = include_str!("token.rs");
        let start = src
            .find("pub fn transfer_from_vault")
            .expect("transfer_from_vault not found — this test must be re-anchored");
        let body = &src[start
            ..start
                + src[start..]
                    .find(
                        "
}",
                    )
                    .expect("could not find the end of transfer_from_vault")];
        let guard = body
            .find("if amount == 0")
            .expect("the zero-amount short-circuit is GONE — the matured path is no          longer a subset of the tested early-exit path; re-read the note above");
        let cpi = body
            .find("transfer_checked(")
            .expect("transfer_checked call not found — re-anchor this test");
        assert!(
            guard < cpi,
            "the zero-amount guard must come BEFORE the CPI, or it guards nothing"
        );
    }
}
