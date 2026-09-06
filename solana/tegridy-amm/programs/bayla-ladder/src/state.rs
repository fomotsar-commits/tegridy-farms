use anchor_lang::prelude::*;

/// PDA seed prefixes. Changing any of these is an account-layout break.
pub const POOL_SEED: &[u8] = b"pool";
pub const POSITION_SEED: &[u8] = b"position";
pub const USER_SEED: &[u8] = b"user";
/// TWO vaults, ALWAYS — even though stake mint == reward mint. Separate vaults are
/// what make "a reward can never be paid out of principal" a property of the account
/// layout rather than of the arithmetic: no reward instruction is ever handed the
/// stake vault (invariant I-12).
pub const STAKE_VAULT_SEED: &[u8] = b"svault";
pub const REWARD_VAULT_SEED: &[u8] = b"rvault";

/// One pool per (mint, nonce). PDA at [`POOL_SEED`, mint, nonce].
///
/// Every cumulative quantity is u128 — see `math.rs` for the Streamflow lesson.
/// `total_principal` is a TRACKED SCALAR and authoritative: it is never derived from
/// the vault balance, because any stranger can transfer into the vault, so only
/// `vault >= total_principal` is a safe statement (invariant I-1).
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub bump: u8,
    pub nonce: u8,
    pub mint: Pubkey,
    /// Pinned at init to whatever program actually owns the mint. Every transfer is
    /// checked against it.
    pub token_program: Pubkey,
    pub decimals: u8,

    /// Admin. Two-step transfer (`propose_authority` / `accept_authority`).
    pub authority: Pubkey,
    pub pending_authority: Pubkey,

    pub stake_vault: Pubkey,
    pub reward_vault: Pubkey,

    /// Smallest stake this pool admits, in raw base units, measured on what ARRIVED.
    /// `>= math::HARD_MIN_STAKE_RAW`; it derives the I-11 divisor floor.
    pub min_stake: u64,

    /// Invariant I-13. Raise-only, on a 48 h timelock. The one lever that genuinely
    /// buys back safety for a program with no deployment record: ship it low and
    /// ratchet as the program ages.
    pub deposit_cap: u64,
    pub pending_cap: u64,
    pub pending_cap_ts: i64,

    /// REAL principal, exactly as Synthetix means `_totalSupply`. Authoritative.
    pub total_principal: u64,
    /// Sum of every open position's weight. The accumulator's divisor.
    pub total_weighted: u128,

    /// Synthetix state, unchanged in meaning.
    pub reward_rate: u128,
    pub period_finish: i64,
    pub last_update_time: i64,
    pub reward_per_weight_stored: u128,

    /// AUDIT C2 (LighthouseLadder.sol): total the accumulator has ever emitted, and
    /// the part already transferred out. Their difference is the outstanding
    /// liability, reserved before any new period may be funded (I-3).
    pub rewards_emitted: u128,
    pub rewards_paid: u128,

    /// TELEMETRY, not an enforced bound (audit L-3 — both are write-only on-chain,
    /// and the docstrings that claimed otherwise were wrong). The enforced solvency
    /// check is in `notify_reward`: outstanding liability must be physically present
    /// in the reward vault.
    ///
    /// `reward_funded_cumulative` counts only tokens moved IN by `notify_reward`, so
    /// a stranger's direct transfer is usable budget but is not counted here.
    /// `penalty_collected_cumulative` counts retained early-exit penalties and swept
    /// emergency-hatch penalties. Since H-1, both categories are genuinely
    /// schedulable via `notify_reward`'s `from_budget`, so the split between them is
    /// now meaningful rather than decorative: it is how an operator answers "how much
    /// of what this pool paid came from leavers rather than from me".
    pub reward_funded_cumulative: u128,
    pub penalty_collected_cumulative: u128,

    /// A penalty charged by `emergency_withdraw`, which declares NO reward vault
    /// (I-12), is left in the stake vault and tracked here until the permissionless
    /// `sweep_orphaned_penalty` moves it to the reward vault. It is never principal:
    /// `total_principal` already excludes it.
    pub orphaned_penalty: u64,

    /// ONE-WAY. When set, `emergency_withdraw` charges no penalty while locked. This
    /// is the answer to "what if the operator is the failure": a flag that can only
    /// ever move in the direction that frees stakers gives a stolen key nothing it
    /// wants. Its cost is honest — it stops future penalty inflow.
    pub degraded: bool,

    /// Truncation remainders (audit M-2 / L-4). Carved OUT of `_reserved` rather than
    /// appended, so `8 + Pool::INIT_SPACE` stays at its pinned 508 and no already-
    /// deployed pool would need migrating. `rpw_residue` carries
    /// `num % total_weighted` from the accumulator step; `emitted_residue` carries
    /// `num % PRECISION` from the pool-side bank. Both are dropped, never banked,
    /// across an I-11-burned or empty-pool interval.
    pub rpw_residue: u128,
    pub emitted_residue: u128,

    pub _reserved: [u8; 96],
}

/// One position. PDA at [`POSITION_SEED`, pool, owner, nonce_le]. Every stake is its
/// OWN position — there is no top-up, so there is no boost blending and no way to buy
/// a high multiplier for a short commitment.
///
/// A closed position is DELETED (`close = owner`), never zeroed and left behind.
/// All three criticals in the EVM design review began with a record that outlived
/// its close (invariant I-7).
#[account]
#[derive(InitSpace)]
pub struct Position {
    pub bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub nonce: u32,
    /// Principal, in raw base units — what ARRIVED.
    pub amount: u64,
    /// `amount x boost / BPS`, frozen at stake time.
    pub weight: u128,
    pub lock_end: i64,
    /// Synthetix `userRewardPerTokenPaid`.
    pub reward_per_weight_paid: u128,
    /// Synthetix `rewards[]` — accrued and not yet paid. Deferred, never forfeited,
    /// when the vault is short (I-2).
    pub rewards_owed: u128,

    /// AUDIT L-8, and it is FREE NOW AND IMPOSSIBLE LATER. `Pool` reserved padding and
    /// these two did not. An upgrade that grows this struct fails Borsh (3003) on every
    /// pre-existing account across all four exit paths, and `stake` fails one step
    /// earlier on `ConstraintSpace` (2019). Recoverable by redeploying the prior
    /// binary — but only because nothing is live yet.
    ///
    /// Padding only helps ADDITIVE growth. Reordering or widening an existing field
    /// still breaks every account, reserve or no reserve.
    pub _reserved: [u8; 64],
}

/// Per-(pool, wallet) bookkeeping. PDA at [`USER_SEED`, pool, owner].
///
/// The nonce is PROGRAM-ASSIGNED and monotone, so a client can never collide with
/// itself, and no `Vec<Pubkey>` of position ids lives on-chain — the client
/// enumerates with `getProgramAccounts` + memcmp on `owner`, exactly as
/// `bungalowStaking.ts` already does against Streamflow.
#[account]
#[derive(InitSpace)]
pub struct UserStats {
    pub bump: u8,
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub next_nonce: u32,
    pub open_positions: u8,
    /// Rewards a position was owed when it closed through a path that could not (or
    /// did not fully) pay them — the emergency hatch, which has no reward vault, or an
    /// exit against a short vault. AUDIT C3 in the Solidity keeps these in a per-
    /// account `rewards[]` that survives the position; this is that ledger. Paid by
    /// `claim_carried` under the same I-2 rule: what the vault holds now, the rest
    /// deferred. Deferred, never forfeited.
    pub rewards_carried: u128,

    /// See `Position::_reserved` — same reasoning, smaller struct (audit L-8).
    pub _reserved: [u8; 32],
}

#[event]
pub struct Staked {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub nonce: u32,
    pub amount: u64,
    pub lock_secs: i64,
    pub weight: u128,
}

#[event]
pub struct Withdrawn {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub nonce: u32,
    /// What the staker RECEIVED.
    pub amount: u64,
    /// What the pool kept. Zero on a matured withdrawal.
    pub penalty: u64,
    /// true = the reward-vault-free hatch; false = a normal exit.
    pub emergency: bool,
}

#[event]
pub struct RewardPaid {
    pub pool: Pubkey,
    pub owner: Pubkey,
    pub nonce: u32,
    pub amount: u64,
    /// What is STILL owed after this payment — non-zero means the vault was short and
    /// the balance is deferred, not lost.
    pub deferred: u128,
}

#[event]
pub struct RewardAdded {
    pub pool: Pubkey,
    /// Fresh tokens transferred in by this call.
    pub amount: u64,
    /// Tokens already in the vault that this call scheduled (AUDIT H-1). An indexer
    /// must add the two to get what the window will actually pay.
    pub from_budget: u64,
    pub reward_rate: u128,
    pub period_finish: i64,
}

#[event]
pub struct Degraded {
    pub pool: Pubkey,
}
