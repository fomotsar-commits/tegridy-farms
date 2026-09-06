use anchor_lang::prelude::*;

/// ERROR CODES ARE A CLIENT CONTRACT. Anchor numbers these from 6000 in declaration
/// order, so inserting a variant renumbers everything after it. New variants go LAST;
/// `layout_tests::error_codes_are_stable` in `lib.rs` pins the ones in circulation.
#[error_code]
pub enum LadderError {
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Amount resolves to zero")]
    ZeroAmount,
    #[msg("Lock is shorter than the seven-day floor")]
    LockTooShort,
    #[msg("Lock is longer than the four-year ceiling")]
    LockTooLong,
    #[msg("Stake is below the pool minimum — measured on what arrived, not what was sent")]
    BelowMinStake,
    #[msg("This wallet already holds the maximum number of open positions on this pool")]
    TooManyPositions,
    #[msg("Deposit would exceed the pool's cap")]
    DepositCapExceeded,
    #[msg("Position is still locked — use early_exit or emergency_withdraw (25% penalty)")]
    StillLocked,
    #[msg("Position has matured — use withdraw_matured; it must not eat a penalty by accident")]
    UseWithdrawMatured,
    #[msg("Only the configured authority may do this")]
    Unauthorized,
    #[msg("Program not initialized by the designated deployer")]
    NotDeployAuthority,
    #[msg("Mint carries a freeze authority — it could freeze the vault and trap every staker's principal")]
    MintHasFreezeAuthority,
    #[msg("Mint carries an extension this pool does not accept (transfer fee, hook, permanent delegate, ...)")]
    UnsupportedMintExtension,
    #[msg("Token program does not match the mint's owner")]
    WrongTokenProgram,
    #[msg("Reward rate exceeds what the vault can fund after reserving what is already owed")]
    RewardTooHigh,
    #[msg("The deposit cap can only be raised, never lowered")]
    CapCanOnlyRaise,
    #[msg("The timelock on this change has not elapsed")]
    TimelockNotElapsed,
    #[msg("There is no pending change to execute")]
    NoPendingChange,
    #[msg("Configured value is outside its permitted range")]
    InvalidParameter,
    #[msg("Pool is already degraded — the flag is one-way")]
    AlreadyDegraded,
    #[msg("Emission exceeds funding plus collected penalties — refusing to pay rewards out of principal")]
    EmissionExceedsFunding,
    #[msg("Stake vault holds less than tracked principal — refusing to proceed")]
    PrincipalInvariant,
    #[msg("Position weight exceeds pool total — ledger is desynchronised")]
    WeightInvariant,
    #[msg("Nothing to sweep")]
    NothingToSweep,
}
