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
pools use). Two shares of that fee are booked in the pool, not charged on top: 10.4% of it for
the venue, which the venue's Squads vault `GRMtSxgseKdesExU1BQ22abEspTXV55UPcLaHCd18osd`
collects, and 5.6% for the island, which the island's Workshop collects itself (the split of
2026-10-18). The other 84% stays in the pool for the people who supplied it. On a 100 SOL trade
that is a 1 SOL fee: 0.104 SOL for the venue, 0.056 SOL for the island, 0.84 SOL for the pool's
liquidity providers. A swap pays nobody outside the pool.

`update` refuses a fee tier whose venue share is not collected by that vault, or whose island
share is collected by anyone but the vault or the island's Workshop
`G2EHPseTXetHbBvvRDs27XQyXfQikXXyxP9uMbsKrbu`, so Jupiter never gets a quote for a pool whose
shares would go anywhere else.

## Run the tests

```sh
cargo test
```

| Test | What it holds |
|---|---|
| `tests/parity.rs` | Jupiter's test kit: each quote equals what the deployed program pays when it runs the swap in LiteSVM. Both BAYLA pools, both directions, 12 swaps, with the venue's and the island's shares booked as on mainnet. |
| `tests/fee_paths.rs` | The same check on copies of the BAYLA/SOL snapshot with a creator fee (each way it can be charged) and fees booked to the island and the creator. The live pools charge no creator fee, so `parity.rs` never runs those paths. |
| `tests/quote_vectors.rs` | 31 fixed swaps and 12 on the live snapshots (`tests/fixtures/quote_vectors.json`). The site's own quote must give the same numbers: `frontend/src/lib/solana/cpswap/jupiterSdkParity.test.ts`. Two of the fixed swaps are what the deployed program paid in `fee_paths.rs`. |
| `tests/ours.rs` | Every key in the SDK's source is the venue's, the island's Workshop or a token program's; the live tiers pay the venue's share only to the vault and the island's only to the vault or the Workshop; a tier with its swap guard on gets no quote, so as mainnet holds them no live pool does; a swap touches only the pool, the trader and ours. |
| `tests/refusals.rs` | No quote for a transfer-fee token, ExactOut, a pair the pool does not hold, token accounts that are not the pool's or are frozen, or after an `update` that was refused. |
| `tests/layout.rs` | Every byte offset read here is recomputed from the program's source. It reads `../programs/cp-swap`, so it runs inside this repository. |

The fixtures are committed, so the tests run offline:

- `tests/fixtures/memetics.so` is the program as deployed, read from mainnet at slot 469908387:
  the build of the vault's proposal #32 (the swap guard), last deployed in slot 469177891,
  714,776 bytes, sha256 `01fe923bd9ba3435212d015c2b0d7549592a601ab5707c6222bd0252166e9938`.
  Proposal #35 replaces it once executed (it can be from 2026-11-16 05:13 UTC).
- `tests/fixtures/accounts/<pool>/` holds both BAYLA pools as mainnet held them at finalized
  slot 469908367 (2026-11-15 23:08:57 UTC): fee tier 1 at a 1% trade fee, the venue's share
  104,000 and the island's 56,000 millionths of it, the island's share owned by the Workshop,
  the swap guard on.
- Every live tier has the guard on and the SDK quotes no guarded tier, so the quote tests read
  these accounts with the guard alone cleared (`tests/common/mod.rs`, `snapshot`). The guard
  moves no amount. `tests/ours.rs` checks that the accounts as taken get no quote.

To take both again: `node scripts/take-fixtures.mjs` in this folder. It only reads: three
requests to the public mainnet endpoint, 2.5 s apart. It cuts the program to the ELF's own
length, so the hash is the registry's, and prints the slot and the hash to pin in
`tests/parity.rs`. New snapshots change the live numbers in `quote_vectors.json` and its two
`fee_paths token-0 copy` cases, which then need writing again.

## What it does not do

- ExactOut: not quoted (`supports_exact_out` is false).
- A pool where either token charges a Token-2022 transfer fee: refused. The program takes that
  fee on both legs of a swap and this SDK would rather give no quote than a wrong one. The site
  does not open or add to such pools either.
- A pool on a fee tier whose swap guard is on: refused. Jupiter calls every swap it routes from
  its own program, and such a tier refuses a swap another program calls (6015 `SwapNotDirect`,
  `refuses_swap` in the program's `states/config.rs`), so every route would fail. Both live
  tiers have had the guard on since 2026-11-14 (Squads proposal #33), so today this SDK quotes
  no live pool. A listing waits on the owner's choice: the guard off on the tier to list (a
  vault proposal, 48 hours), or a program change that lets Jupiter's program through.
- A pool whose token account is frozen: refused. The token program moves no tokens into or out
  of a frozen account, so the swap would fail.
- After an `update` is refused, no quote until one passes.

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
- Hand Jupiter, or any aggregator, an explicit list of pools, each with LP shares in existence
  and its opening time passed. Never hand it addresses derived from a pair of coins.

`SUBMISSION.md` has the form's answers and what to do before sending it.
