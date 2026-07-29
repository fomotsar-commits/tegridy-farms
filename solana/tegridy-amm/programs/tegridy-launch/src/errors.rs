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
        }
    }
}
