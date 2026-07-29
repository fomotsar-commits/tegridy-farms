//! # Tegridy Launch — bonding curve (Phase 0, math core)
//!
//! The launch rail that feeds the Tegridy CP-AMM: a pump.fun-shaped constant
//! product over virtual reserves. A token bonds here, and on reaching its
//! graduation threshold its liquidity migrates into a **Tegridy CP-AMM pool** —
//! the venue the protocol owns — rather than a third party's.
//!
//! ## Status — read before extending
//!
//! **Only [`curve`] exists today, and it is the deliberate first piece.** It is
//! the entire pricing surface, it holds every rounding decision, and it is where
//! a bonding curve gets drained. It is written with zero Solana/Anchor
//! dependencies specifically so it can be proven on the host:
//!
//! ```sh
//! rustc --edition 2021 --test src/curve.rs -o /tmp/curve_test && /tmp/curve_test
//! ```
//!
//! 14 tests, covering the anti-extraction properties that matter: a buy/sell
//! round trip can never profit, slicing an order can never beat one shot, fees
//! round up so dust trades cannot dodge them, and the token reserve can never be
//! fully drained.
//!
//! ## Still to build (the Anchor layer)
//!
//! `state.rs`, `errors.rs`, and the instructions: `initialize_global`,
//! `create_launch`, `buy`, `sell`, `graduate`. `graduate` CPIs into
//! `raydium_cp_swap::initialize` to open the pool — the AMM crate is the fork in
//! the sibling `programs/cp-swap`, pinned to the same Anchor 0.32.1.
//!
//! **`graduate` is the highest-risk instruction in this program.** It moves the
//! entire raised balance in a single call and, unlike the AMM, has no audited
//! upstream to diff against. It deserves the deepest review here.
//!
//! ## Design constraints that are not negotiable
//!
//! 1. **This must stay a SEPARATE program from `cp-swap`.** `solana-ci.yml`'s
//!    `diff-guard` asserts that `programs/cp-swap/src` differs from audited
//!    upstream `raydium-cp-swap` in exactly two authority files. Folding launch
//!    logic into cp-swap breaks that invariant and turns a cheap four-constant
//!    diff-audit into a full from-scratch AMM audit.
//! 2. **No TOWELI on Solana.** Standing protocol doctrine, untouched by the
//!    own-venue decision. Nothing here mints, bridges, or references TOWELI.
//!
//! ## Local build limitation (environment, not code)
//!
//! SBF builds cannot run on the current Windows dev box: `cargo build-sbf` fails
//! installing platform-tools with `os error 1314` (symlink privilege), and cargo
//! build scripts are blocked by Application Control (`os error 4551`). Both
//! affect the *existing* cp-swap program identically, so they are environmental,
//! not introduced here. **CI (`solana-ci.yml`, Ubuntu) is therefore the compile
//! gate for this program** — the dependency-free `curve.rs` is the part that can
//! still be proven locally, which is exactly why it was written that way.

pub mod curve;
