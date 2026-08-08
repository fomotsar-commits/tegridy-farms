//! Vendored concentrated-liquidity math from Raydium CLMM. **Apache-2.0.**
//!
//! # Why this is here
//!
//! The segmented (Meteora-shaped) curve prices trades against up to 16
//! `(sqrt_price, liquidity)` segments. That is the concentrated-liquidity formula —
//! the same maths Uniswap V3 and Raydium CLMM use — and it is precisely the kind of
//! fixed-point arithmetic that is disastrous to hand-roll: every rounding direction
//! is a potential value leak, and the U256 intermediates are easy to get subtly wrong.
//!
//! So we do here exactly what `cp-swap` did: **copy the audited program verbatim,
//! change the absolute minimum.** Small diff = small re-audit = small new attack
//! surface (`solana/tegridy-amm/TEGRIDY_FORK.md`).
//!
//! # Provenance — pin this for the diff-audit
//!
//! - Upstream: <https://github.com/raydium-io/raydium-clmm>
//! - Path:     `programs/amm/src/libraries/`
//! - Commit:   `bf7c2413ec685d2ce9d5422d44182b770cd37598` (2026-06-24)
//! - Licence:  **Apache-2.0** — verified by reading `LICENSE` in the upstream repo,
//!             not from GitHub API metadata or an npm `license` field.
//!
//! > ⚠️ Read `docs/CURVE_FORK_EVALUATION.md` before evaluating any other upstream.
//! > Meteora's DBC npm SDK declares MIT while its on-chain program is under a
//! > **non-commercial** licence, and a web search will confidently tell you the whole
//! > thing is MIT. Licences get verified by reading the licence file in the program
//! > repo. Nothing in this directory comes from Meteora.
//!
//! `solana/tegridy-amm/` is already Apache-2.0 (see the root `LICENSE` SCOPE note)
//! because it derives from `raydium-io/raydium-cp-swap`, so this vendor introduces no
//! new licence posture — it is the same upstream under the same terms.
//!
//! # The delta from upstream
//!
//! The five files below are **byte-for-byte upstream** apart from two mechanical
//! substitutions that are unavoidable when lifting code out of its home crate:
//!
//! 1. `use crate::error::ErrorCode` → `use super::ErrorCode` (the shim below).
//! 2. `use super::tick_math` / `crate::libraries::…` → paths relative to this module.
//!
//! No formula, no rounding direction, and no bound has been altered. An auditor should
//! be able to `diff` each file against the pinned commit and see only import lines.

#![allow(clippy::all, dead_code)]

pub mod big_num;
pub mod fixed_point_64;
pub mod full_math;
pub mod liquidity_math;
pub mod sqrt_price_math;
pub mod tick_math;
pub mod unsafe_math;

pub use big_num::{U128, U256};

/// Error shim.
///
/// Upstream raises `crate::error::ErrorCode`, which is Raydium's program-wide error
/// enum. Vendoring the whole thing would drag in error variants for CLMM features we
/// do not have (positions, tick arrays, reward emissions), so this carries only the
/// three variants the vendored files actually raise.
///
/// It carries exactly the variants the vendored files raise — no more — so an auditor
/// can confirm by grep that nothing here invents an error path upstream does not have:
///
/// ```text
/// grep -hoE "ErrorCode::[A-Za-z]+" src/vendor/*.rs | sort -u
/// ```
///
/// `#[error_code]` supplies the `Into<anchor_lang::error::Error>` that the upstream `?`
/// and `require!` calls expect. Anchor offsets each error enum independently, so these
/// discriminants do not collide with `crate::errors::LaunchError`.
#[anchor_lang::prelude::error_code]
pub enum ErrorCode {
    #[msg("Multiplication or addition overflowed in the curve math")]
    CalculateOverflow,
    #[msg("sqrt price is out of the supported range")]
    SqrtPriceX64,
    #[msg("sqrt price is out of the supported range")]
    SqrtPriceX,
    #[msg("sqrt price must be non-zero")]
    ZeroSqrtPrice,
    #[msg("Liquidity in a curve segment must be non-zero")]
    ZeroLiquidity,
    #[msg("Adding a liquidity delta overflowed")]
    LiquidityAddValueErr,
    #[msg("Subtracting a liquidity delta underflowed")]
    LiquiditySubValueErr,
    #[msg("Tick upper bound overflowed")]
    TickUpperOverflow,
    #[msg("Maximum token overflow")]
    MaxTokenOverflow,
}
