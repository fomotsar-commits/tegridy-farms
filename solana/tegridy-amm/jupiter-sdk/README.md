# Memetics pools: Jupiter SDK

The code Jupiter asks a DEX for before it routes trades to it
([DEX integration](https://developers.jup.ag/docs/routing/dex-integration)): an implementation of
the `Amm` trait from [`jupiter-amm-interface`](https://github.com/jup-ag/jupiter-amm-interface)
for the venue's constant-product pools, program `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`
(our fork of raydium-cp-swap, `../`).

It only decodes state and quotes, as Jupiter requires:

- `update` reads the pool, its fee tier, its two token accounts and its two mints.
- `quote` gives ExactIn quotes in both directions with no network call.
- `get_swap_and_account_metas` lists the 13 accounts of the program's own `swap_base_input`.

## How money moves

The trader pays the fee tier's trade fee out of what they put in (1% on tier 1, which both BAYLA
pools use). The venue's cut is a share of that fee, not an extra charge (16% of it on tier 1). It
stays in the pool, booked to the venue, until the venue's Squads vault
`GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd` collects it. The rest of the fee stays in the pool
for the people who supplied it. A swap pays nobody outside the pool.

`update` refuses a fee tier whose fee collectors are not that vault, so Jupiter never gets a
quote for a pool whose venue cut would go anywhere else.

## Run the tests

```sh
cargo test
```

| Test | What it holds |
|---|---|
| `tests/parity.rs` | Jupiter's test kit: each quote equals what the deployed program pays when it runs the swap in LiteSVM. Both BAYLA pools, both directions, 12 swaps. |
| `tests/fee_paths.rs` | The same check on copies of the BAYLA/SOL snapshot with a creator fee (each way it can be charged), a fund fee, and fees booked to both. The live pools charge neither, so `parity.rs` never runs those paths. |
| `tests/quote_vectors.rs` | 31 fixed swaps and 12 on the live snapshots (`tests/fixtures/quote_vectors.json`). The site's own quote must give the same numbers: `frontend/src/lib/solana/cpswap/jupiterSdkParity.test.ts`. Two of the fixed swaps are what the deployed program paid in `fee_paths.rs`. |
| `tests/ours.rs` | Every key in the SDK's source is the venue's or a token program's; the live fee tiers pay only the venue's vault; a swap touches only the pool, the trader and ours. |
| `tests/refusals.rs` | No quote for a transfer-fee token, ExactOut, a pair the pool does not hold, or token accounts that are not the pool's. |
| `tests/layout.rs` | Every byte offset read here is recomputed from the program's source. It reads `../programs/cp-swap`, so it runs inside this repository. |

The fixtures are committed, so the tests run offline:

- `tests/fixtures/memetics.so` is the program as deployed, read from mainnet: 691,640 bytes,
  sha256 `88b98aa91559824c682f6e6c31906abf222d189ce7a45f16af117368b33db882`.
- `tests/fixtures/accounts/<pool>/` holds both BAYLA pools as mainnet held them at slot
  457516133 (2026-10-16 05:12 UTC).

To take new snapshots: `REFRESH=1 RPC=<mainnet url> cargo test --test parity`. The kit only
reads accounts. After a program upgrade, delete `memetics.so` first so the new one is read, and
pin its hash in `tests/parity.rs`. New snapshots change the live numbers in
`quote_vectors.json`, which then need writing again.

## What it does not do

- ExactOut: not quoted (`supports_exact_out` is false).
- A pool where either token charges a Token-2022 transfer fee: refused. The program takes that
  fee on both legs of a swap and this SDK would rather give no quote than a wrong one. The site
  does not open or add to such pools either.

## Dependencies

`jupiter-amm-interface` and `jupiter-amm-test-kit` come from Jupiter's repository at commit
`95bd18485e58`. The test kit is not on crates.io, and the interface's crates.io release
(0.6.1) predates what the kit needs. Everything else is from crates.io. `Cargo.lock` keeps
`solana-clock`, `solana-last-restart-slot` and `solana-slot-history` at 3.1.x, as Jupiter's
does: LiteSVM 0.14 cannot read their 3.2 releases. Do not `cargo update` them.

The swap arithmetic in `src/math.rs` is transcribed from raydium-cp-swap (Apache-2.0); the file
names its sources. This crate is Apache-2.0 (`../LICENSE`).

## What Jupiter still needs

- **A security audit of the program.** It has none (`../README.md`, `../AUDIT_RFQ.md`, which
  asks for this program's review first, on its own). Jupiter asks for the report with the
  submission. This is the owner's step.
- Jupiter forks the SDK's repository. To hand them this folder on its own, move
  `tests/layout.rs`'s check into a copy of the program's two state files, or keep it in the
  monorepo.
- The submission itself, through Jupiter's AMM integrators form: this folder, the audit, usage
  numbers and who is behind the venue. Jupiter also lists markets only above its liquidity bar.
- The label Jupiter shows for these pools is `Memetics` (`src/lib.rs`), which is the owner's call.

`SUBMISSION.md` has the form's answers and what to do before sending it.
