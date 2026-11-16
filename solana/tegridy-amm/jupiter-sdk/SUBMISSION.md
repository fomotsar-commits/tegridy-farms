# Jupiter listing: what to send

Jupiter takes new DEXes through its
[AMM integrators form](https://support.jup.ag/requests/new/amm-integrators), against the
requirements on its [DEX integration](https://developers.jup.ag/docs/routing/dex-integration)
page. The owner sends the form. Nothing in this folder sends anything.

## Before sending

1. The pool program on mainnet on 2026-11-15 is the build with the swap guard,
   `01fe923bd9ba3435212d015c2b0d7549592a601ab5707c6222bd0252166e9938` (the vault's proposal
   #32; `../MAINNET_RUNBOOK.md`, section 4b). **While the guard is on for a fee setting, its
   pools refuse every swap that another program calls (6015), Jupiter's included, and this SDK
   gives no quote for that fee setting.** Both live fee settings have it on (proposal #33,
   2026-11-14), so today the SDK quotes no live pool and there is nothing to list. Before
   sending, the owner chooses one: the guard off for the fee setting to be listed (a vault
   proposal, 48 hours), or a program change that lets Jupiter's program through
   (`../TEGRIDY_FORK.md`, "The swap guard").
2. The fixtures are taken again from the program then on mainnet (`README.md`, under the
   fixtures): `node scripts/take-fixtures.mjs`, pin the printed hash in `tests/parity.rs`, and
   write `tests/fixtures/quote_vectors.json` again, with the site's
   `frontend/src/lib/solana/cpswap/jupiterSdkParity.test.ts`. Every test passes. Today's
   fixtures are from 2026-11-15, before proposal #35 changes the program.
3. The Scope A audit report is published (`../AUDIT_RFQ.md` asks for it first, on its own).
4. The figures below are read again on the day.

## The form

- **Name Jupiter shows:** Memetics (`src/lib.rs`). The owner's call.
- **Program:** `EKS4C6xvV9A5DMWaWtVnFvi7ru78EhqRAoddEMpQ2BtT`, constant-product pools, a fork
  of Raydium's `raydium-cp-swap`. ExactIn quotes only.
- **SDK:** https://github.com/fomotsar-commits/tegridy-farms/tree/mvp-launch/solana/tegridy-amm/jupiter-sdk.
  The repository is public and Jupiter may fork it. The SDK sits beside the program because
  `tests/layout.rs` reads the program's own source; a standalone copy can be made if Jupiter
  prefers one.
- **Parity tests:** `cargo test` in that folder. `tests/parity.rs` runs Jupiter's
  `jupiter-amm-test-kit` against the deployed program; the fixtures are committed.
- **Audit:** the Scope A report. [link]
- **Traction**, read 2026-11-01 06:34 UTC from the site's own counters
  (`/api/aggregator?resource=venue-tvl` and `?resource=venue-volume`):
  - 17 pools on Solana, holding $17,987;
  - $18,116 of swaps over 712 swaps since the venue opened, all chains together.
- **Team and backers:** [owner]
- **Contact:** [owner]

## How money moves once Jupiter routes to us

A trade Jupiter sends through one of our pools pays that pool's trade fee out of what goes in:
1% on tier 1, where every public pool sits. The pool's liquidity providers keep 84% of it. Two
shares stay booked in the pool until they are collected: the venue's 10.4%, by the venue's
vault, and the island's 5.6%, by the island's Workshop. Jupiter's own fees are Jupiter's, and
nothing of ours goes to Jupiter.

## What Jupiter checks after listing

Every 30 minutes Jupiter tests each pool, and drops one that fails both tests
([Market listing](https://developers.jup.ag/docs/swap/routing/amm/market-listing.md)):

- a $500 buy sold straight back must lose under 30%;
- failing that, the price of a $1,000 buy must be within 20% of a $500 buy's.

On a constant-product pool the $500 round trip loses about its two fees, about 2%, so our
pools pass the first test.
