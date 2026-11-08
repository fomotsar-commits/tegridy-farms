# Jupiter listing: what to send

Jupiter takes new DEXes through its
[AMM integrators form](https://support.jup.ag/requests/new/amm-integrators), against the
requirements on its [DEX integration](https://developers.jup.ag/docs/routing/dex-integration)
page. The owner sends the form. Nothing in this folder sends anything.

## Before sending

1. Vault proposal #23 has run (it can from 2026-11-02 19:50:49 UTC) and its check passed, so
   the pool program on mainnet is `1e55bcdc…` again.
2. The fixtures are taken again from that program, as `README.md` says under "To take new
   snapshots": delete `tests/fixtures/memetics.so`, run the refresh, pin the new hash in
   `tests/parity.rs`, and write `tests/fixtures/quote_vectors.json` again, with the site's
   `frontend/src/lib/solana/cpswap/jupiterSdkParity.test.ts`. Every test passes.
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
1% on tier 1, where every public pool sits. The pool's liquidity providers keep 84% of it. The
venue's 16% stays in the pool until the venue's vault collects it. Jupiter's own fees are
Jupiter's, and nothing of ours goes to Jupiter.

## What Jupiter checks after listing

Every 30 minutes Jupiter tests each pool, and drops one that fails both tests
([Market listing](https://developers.jup.ag/docs/swap/routing/amm/market-listing.md)):

- a $500 buy sold straight back must lose under 30%;
- failing that, the price of a $1,000 buy must be within 20% of a $500 buy's.

On a constant-product pool the $500 round trip loses about its two fees, about 2%, so our
pools pass the first test.
