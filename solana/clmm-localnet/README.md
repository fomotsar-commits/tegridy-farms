# clmm-localnet: the range-pool program on a local chain

Runs `solana/tegridy-clmm` (the venue's copy of Raydium's concentrated-liquidity program) on a
local validator, with copies of the mainnet accounts it needs, and checks every instruction a
visitor or the venue would use. Results: [RESULTS.md](RESULTS.md). Plan: [docs/RANGE_POOLS_PLAN.md](../../docs/RANGE_POOLS_PLAN.md).

It never deploys, never makes a program key and never signs on mainnet: mainnet is only read.

## What it needs

- The frontend's dependencies (`cd frontend && npm ci --ignore-scripts`). The harness adds no npm
  project of its own: it uses the frontend's `@solana/web3.js` and `@solana/spl-token`.
- WSL with Solana's tools (`solana-test-validator`, `cargo build-sbf`), and the program built there:
  copy `solana/tegridy-clmm` to WSL's own disk and run
  `cargo build-sbf -- --locked` in `programs/amm` (the release build, at the deployed id lib.rs
  declares; RESULTS.md ran before the id change, with `--features placeholder-id`). The build
  writes a fresh `target/deploy/raydium_clmm-keypair.json`: delete it, nothing uses it.
- Mainnet reads from Windows (WSL here has no network): `MAINNET_RPC`, default the public endpoint.

## Steps

| Script | Does |
|---|---|
| `setup.mjs` | Reads the mainnet accounts (programs, BAYLA, WSOL, the multisig, Squads' IDL, today's BAYLA price, rent), makes local keys, writes the local copies. |
| `validator.mjs` | Starts the validator detached in WSL on port 18899; `--stop` kills only the PID it started. |
| `features.mjs` | Lists the runtime features mainnet has not switched on, so the next start switches them off. Run once. |
| `suite.mjs` | The checks, phase by phase (`suite-phases.mjs`, `suite-more.mjs`). |
| `run.mjs` | setup, a fresh validator, the suite: one run from nothing. |
| `run-mutants.mjs` | Each broken input in `mutants.mjs` must turn its check red; then a clean run must pass all. |
| `report.mjs` | Writes RESULTS.md. |

`CLMM_WORK` moves the work folder (default `.work/`, ignored by git: it holds fresh keys and
mainnet copies). `CLMM_TIME_LOCK` sets the local stand-in for the vault's 172,800 s lock (default 10).

## How the vault signs here

Every address comes from the repo: `frontend/scripts/addresses.json`, `solana/guards/allowed-keys.json`
and the frontend's Squads constant. The local multisig is mainnet's own account with its two member
keys swapped for local test keys and its lock shortened. A Squads vault's address comes from the
multisig's address, not from its members, so its vault 0 is the real vault, and every admin action
runs through the real Squads program, signed as the address the program trusts.
