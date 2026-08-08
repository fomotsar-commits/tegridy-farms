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

construct_uint! {
    pub struct U512(8);
}


// ── DELTA FROM UPSTREAM ────────────────────────────────────────────────────────
// Removed: the local `construct_bignum!` macro (upstream lines 17-341) and the
// `U1024` type it builds (342-344). Nothing in the segmented-curve math references
// U1024 — only U128, U256 and U512 (the last used by full_math's Downcast512) — and
// the macro fails to compile outside its home crate because it expands to
// `$crate::core_::…`, a re-export that only exists in Raydium's crate root.
//
// This is a DELETION, not a modification: every line above is byte-for-byte upstream
// at commit bf7c2413ec685d2ce9d5422d44182b770cd37598. No numeric type, width or
// operation has been altered.
