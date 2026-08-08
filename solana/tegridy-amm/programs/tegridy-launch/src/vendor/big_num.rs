///! 128 and 256 bit numbers
///! U128 is more efficient that u128
///! https://github.com/solana-labs/solana/issues/19549
use uint::construct_uint;
construct_uint! {
    pub struct U128(2);
}

construct_uint! {
    pub struct U256(4);
}



// ── DELTA FROM UPSTREAM ────────────────────────────────────────────────────────
// Two deletions, no modifications. Every line above is byte-for-byte upstream at
// commit bf7c2413ec685d2ce9d5422d44182b770cd37598.
//
// 1. The local `construct_bignum!` macro (upstream lines 17-341) and the `U1024` it
//    builds (342-344). Nothing references U1024, and the macro cannot compile outside
//    its home crate — it expands to `$crate::core_::…`, a re-export that only exists
//    in Raydium's crate root.
//
// 2. `construct_uint! { pub struct U512(8); }`.
//
//    U512 existed solely for the overflow fallback in `full_math`'s `MulDiv for U256`,
//    which now fails closed instead (see the note there). Declaring it was not free:
//    `construct_uint!` also generates a `pow` family, and `U512::overflowing_pow`
//    holds five U512 locals plus multiply temporaries at once — a 4,280-byte stack
//    frame against SBF's hard 4,096-byte limit. Nothing called it; it still failed
//    every on-chain build, and no profile setting fixes it because the frame is
//    inherent to the function rather than to codegen options.
//
//    Confirmed dead before removal: `grep -rE "\.pow\(|overflowing_pow|checked_pow|
//    saturating_pow"` over the whole program matches nothing outside this comment.
