use anchor_lang::prelude::*;

use crate::curve::CurveError;

#[error_code]
pub enum LaunchError {
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Curve has insufficient liquidity for this trade")]
    InsufficientLiquidity,
    #[msg("Trade amount resolves to zero")]
    ZeroAmount,
    #[msg("Fee exceeds the hard ceiling")]
    FeeTooHigh,

    #[msg("Trading is paused")]
    Paused,
    #[msg("This curve has already graduated; trade on the AMM pool instead")]
    AlreadyComplete,
    #[msg("This curve has not reached its graduation target yet")]
    NotReadyToGraduate,
    #[msg("Output below the caller's minimum — slippage")]
    SlippageExceeded,
    #[msg("Only the configured authority may do this")]
    Unauthorized,
    #[msg("Configured value is outside its permitted range")]
    InvalidParameter,
    #[msg("Curve would drop below rent exemption")]
    InsufficientRentExemptBalance,
    #[msg("Mint carries a freeze authority — it could freeze the vault or holders")]
    MintHasFreezeAuthority,
    #[msg("Program not initialized by the designated deployer")]
    NotDeployAuthority,
    #[msg("Graduation target exceeds the most SOL this curve could ever hold")]
    GraduationTargetUnreachable,
    #[msg("Launch would list at a price far from its final curve price — retune virtual SOL or the target")]
    GraduationPriceGap,
    #[msg("cp-swap program or AmmConfig is not configured yet")]
    AmmNotConfigured,
    #[msg("Supplied cp-swap program or AmmConfig does not match the configured one")]
    AmmMismatch,
    #[msg("Curve holds too few lamports to fund migration")]
    MigrationReserveTooLow,
    #[msg("LP tokens were not fully burned — liquidity would not be permanently locked")]
    LpNotBurned,
    #[msg("Curve is fully funded and awaiting migration — it has NOT graduated yet")]
    AwaitingMigration,
    #[msg("Creator account does not match the creator recorded on this curve")]
    CreatorMismatch,
}

/// Lift a pure-curve error into the program's error space.
///
/// The math module deliberately knows nothing about Anchor (so it can be tested
/// with a bare `rustc --test`), so this is the one seam between the two.
impl From<CurveError> for LaunchError {
    fn from(e: CurveError) -> Self {
        match e {
            CurveError::Overflow => LaunchError::Overflow,
            CurveError::InsufficientLiquidity => LaunchError::InsufficientLiquidity,
            CurveError::ZeroAmount => LaunchError::ZeroAmount,
            CurveError::FeeTooHigh => LaunchError::FeeTooHigh,
            // A share above 100% is a config-shaped mistake, and config
            // validation is where it should have been caught.
            CurveError::ShareTooHigh => LaunchError::InvalidParameter,
        }
    }
}
