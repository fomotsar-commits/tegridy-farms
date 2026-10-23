# tegridy-clmm: the venue's range-pool program

Raydium's concentrated-liquidity program, `raydium-io/raydium-clmm` at commit
`ed1eb41519d5355755f7df52b43fa9610938b60b` (Apache-2.0, see `LICENSE`), copied as it is.
Only its identity changed: every address upstream hard-codes for itself is the venue's
(admin, fee owners and the spare-SOL collector are the venue's two-signature vault), and its
name, links and memos say memetics.finance. Its program id is `7ghzbbmq59QEbdweSzM1ggpeBH1Q2CyxZg4Tr2x8Aso`, made by the owner on
2026-10-21, and a `devnet` or `localnet` build is refused unless `test-chain-keys` is named.

`vendor/uint` is Raydium's copy of the `uint` crate (MIT or Apache-2.0, see its two licence
files) at commit `43a0303b9c2a23a00508816bd6d5a2e9381f143c`, unchanged, so the build fetches
nothing from Raydium.

Three CI checks in `.github/workflows/solana-ci.yml` hold that, with no clone of any Raydium
repository:

- `solana/guards/provenance.mjs`: same files as upstream (hashes in `solana/guards/upstream/`),
  only the reviewed patch differs, and the patch and `Cargo.lock` hash to their pins.
- `solana/guards/key-guard.mjs`: every key in this copy and in `../tegridy-amm/programs/cp-swap`
  is named in `solana/guards/allowed-keys.json`, and none is a key upstream hard-codes.
- the build: compiles with no features, prints the sha256 a deploy must match, and refuses a
  `devnet` or `localnet` build without `test-chain-keys`.

Upstream's unit tests run as they are, but one: `compute_swap_step_test` (in `swap_math.rs`)
expects, for an exact output with the fee on the output coin, the fee plus what the user
received to equal the amount asked, which holds only at a zero fee. CI skips it, and
`programs/amm/tests/swap_math_fee_rule.rs`, our own file beside upstream's, checks the rule
for all four swap kinds.

Its own workspace, because upstream builds with Anchor 1.0.2 and Solana 3.1.10 and the three
programs in `../tegridy-amm` stay on Anchor 0.32.1. Plan, costs and owner decisions:
`docs/RANGE_POOLS_PLAN.md`.
