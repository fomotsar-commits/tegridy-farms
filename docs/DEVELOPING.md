# Developing Tegridy Farms

How to set up a local development environment, run the three sub-projects (contracts, frontend, indexer), and submit changes.

## Quick start

### Prerequisites

- **Node.js 20.x** (check `.nvmrc` — install via [nvm](https://github.com/nvm-sh/nvm) / [fnm](https://github.com/Schniz/fnm))
- **pnpm 9+** (or `npm` — commands below use pnpm but translate trivially)
- **Foundry** — install via [getfoundry.sh](https://getfoundry.sh/)
- **Git** with working `https://` remotes

### Clone and bootstrap

```bash
git clone https://github.com/<org>/tegriddy-farms.git
cd tegriddy-farms
```

### Running the frontend

```bash
cd frontend
cp .env.example .env
# Fill in: VITE_WALLETCONNECT_PROJECT_ID, VITE_RPC_URL, VITE_ALCHEMY_ID, etc.
pnpm install
pnpm dev
```

The Vite dev server prints a URL (typically `http://localhost:5173`). Hot-reload works for all React/Tailwind changes.

Useful scripts:

```bash
pnpm exec tsc --noEmit     # type-check only
pnpm build                 # production build
pnpm preview               # preview the production build locally
```

### Running the contracts

```bash
cd contracts
cp .env.example .env
# Fill in: RPC_URL (mainnet/sepolia), PRIVATE_KEY (only for deploys), ETHERSCAN_API_KEY
forge install              # installs submodule dependencies
forge build                # compile contracts into contracts/out/
forge test                 # run all 55+ test files
forge coverage             # optional: coverage report
```

For a specific test file or function:

```bash
forge test --match-path test/TegridyStaking.t.sol -vvv
forge test --match-test test_EarlyWithdraw_PenaltyFlow -vvv
```

### Running the indexer

```bash
cd indexer
pnpm install
pnpm dev                   # starts Ponder in dev mode
```

Ponder uses the RPC and chain id from `.env`. You'll see events streaming as they hit the local database; GraphQL is exposed at `http://localhost:42069` by default.

### Running everything in parallel

From the repo root:

```bash
# Terminal 1
cd frontend && pnpm dev

# Terminal 2
cd indexer && pnpm dev

# Terminal 3 (optional, for contract iteration)
cd contracts && forge test --watch
```

## Repo layout

See [`README.md#repo-layout`](../README.md#repo-layout) for the directory tree.

Key conventions:

- All Solidity in `contracts/src/*.sol`; base contracts in `contracts/src/base/`; libraries in `contracts/src/lib/`.
- All contract addresses in the frontend live in [`frontend/src/lib/constants.ts`](../frontend/src/lib/constants.ts) — nowhere else. If you need a new address, add it there.
- All contract ABIs in the frontend live in [`frontend/src/lib/contracts.ts`](../frontend/src/lib/contracts.ts) or [`frontend/src/lib/abi-supplement.ts`](../frontend/src/lib/abi-supplement.ts) (auto-generated from `forge build` artifacts via [`frontend/scripts/extract-missing-abis.mjs`](../frontend/scripts/extract-missing-abis.mjs)).
- In-app product copy with Randy/Tegridy voice is centralised in [`frontend/src/lib/copy.ts`](../frontend/src/lib/copy.ts) so brand changes are one-file diffs.

## Developing a new feature

1. Branch off `main`: `git checkout -b feat/short-description`
2. Write a failing test first (Foundry for contracts, Vitest/Playwright for frontend — tests are WIP).
3. Implement. Keep each PR focused on one change.
4. Run:
   - `cd contracts && forge test`
   - `cd frontend && pnpm exec tsc --noEmit && pnpm build`
   - `cd indexer && pnpm build` (if you touched the indexer)
5. Open a PR using the template in [`.github/pull_request_template.md`](../.github/pull_request_template.md).
6. One code review + CI green is the minimum before merge. Contract changes require a second reviewer (see [CODEOWNERS](../.github/CODEOWNERS)).

## Working with a forked mainnet

For realistic integration testing (e.g. verifying interaction with Chainlink oracles, Uniswap V2 routing):

```bash
# Start a local anvil fork
anvil --fork-url $MAINNET_RPC_URL

# In another shell, test against the fork
cd contracts
forge test --fork-url http://localhost:8545
```

## Adding a new contract

1. Drop the `.sol` file in `contracts/src/`.
2. Write a deploy script in `contracts/script/DeployX.s.sol`.
3. Run `forge build` to confirm it compiles.
4. Deploy to Sepolia first via `forge script ... --rpc-url $SEPOLIA_RPC --broadcast --verify`.
5. After mainnet deploy, add the address to [`constants.ts`](../frontend/src/lib/constants.ts) and [`README.md` Deployed contracts](../README.md#deployed-contracts-ethereum-mainnet).
6. If the dApp needs the full generated ABI (rather than a hand-rolled subset in `contracts.ts`), add the contract to the `MISSING` list in [`frontend/scripts/extract-missing-abis.mjs`](../frontend/scripts/extract-missing-abis.mjs) and re-run it — entries require a live named import in frontend code.

## Common gotchas

- **`forge build` fails with "stack too deep":** [`contracts/foundry.toml`](../contracts/foundry.toml) has `via_ir = true` — make sure your Foundry version is recent enough (`foundryup`).
- **Frontend can't connect to wallet:** confirm `VITE_WALLETCONNECT_PROJECT_ID` is set in `.env`.
- **`wagmi` ABI hooks don't see a function:** regenerate [`abi-supplement.ts`](../frontend/src/lib/abi-supplement.ts) via the script above.
- **Windows + Git line endings:** [`.gitattributes`](../.gitattributes) normalises to LF — if you see diff noise, re-run `git add --renormalize .`.
- **`forge test` fails on `MAINNET_ONLY` require:** Most V3 deploy scripts have `require(block.chainid == 1)` — use `--fork-url` to satisfy.

### Windows toolchain — two of these can destroy work

- **⛔ A worktree's `node_modules` may be a JUNCTION. Remove it with `cmd /c rmdir <path>`, NEVER
  `rm -rf`.** `npm ci` in a fresh worktree dies with EPERM on this box, so the usual fix is
  `cmd /c mklink /J <worktree>/frontend/node_modules <main>/frontend/node_modules`. A recursive
  delete **follows the junction** and takes the real tree with it. `rmdir` removes only the link.
- **⛔ Don't round-trip a non-ASCII file through PowerShell 5.1.** `Get-Content -Raw` piped into
  `Set-Content` mangles the encoding, and this repo is full of em-dashes, arrows and emoji — in
  `addresses.json`, every runbook, every one of these docs. Edit those files directly, or use
  Node with explicit `'utf-8'` on both read and write.
- **Git Bash silently mangles `rev:.github/...` arguments.** `git show 'branch:.github/workflows/ci.yml'`
  fails or returns nothing, because the path gets rewritten before git sees it. This produces a
  **false negative that looks exactly like a real answer** — during the #280 work it twice
  "proved" a workflow step did not exist when it did. Use PowerShell for any git argument
  containing `:.github`.

### Verifying things in this repo

- **A search that could not run is not a negative result.** A timed-out scan, a mangled path, a
  filter that matched nothing — none of those mean "absent". Both times this rule was broken here
  it produced a confident wrong claim: once reporting an on-disk keyfile as missing after the scan
  timed out, once reporting a CI step as absent after the path was mangled. If a check cannot
  complete, say it did not complete.
- **The address registry has TWO pipelines. Grep both.** `ci.yml`'s *Address registry* step runs
  the OFFLINE checks on every push; **`registry-onchain.yml`** is the one that passes `--onchain`,
  on a daily cron and path-filtered to the registry and constants. Reading only `ci.yml` and
  concluding "the chain read never runs" is wrong, and was — see
  [`scripts/verify-addresses.mjs`](../frontend/scripts/verify-addresses.mjs).
- **Moving authority to an N-of-M is one step; keeping the ability to USE it is another, and only
  the second is testable.** cp-swap and tegridy-launch both had upgrade authority correctly
  transferred to a Squads 2-of-2 — a 2-of-2 that had never executed a single transaction, whose
  second member held 0 SOL and appeared in no proposal's `approved[]`. Every upgrade and every
  `program close` depended on a threshold nobody had ever demonstrated. Read `approved[]` on the
  Proposal PDAs, and treat an N-of-M as unproven until a transaction has actually executed at the
  new threshold.
- **Green is not the same as checked.** This repo has shipped two gates that could not fail: a
  `tsc --noEmit` that type-checked zero files, and a chain read behind a flag nothing passed whose
  only disagreement path was a `warn()`. Both were green for weeks. When a check reports a count,
  make zero a failure — `verify-addresses.mjs` fails if a scan finds nothing to look at, because
  "found nothing wrong" and "looked at nothing" must not share an exit code.

## Publishing a release

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full deploy runbook.

## Need help?

- Open a [Discussion](../../../discussions) for architecture questions.
- Open an [Issue](../../../issues) for bugs.
- Follow the [SECURITY.md](../SECURITY.md) disclosure process for security-sensitive reports.

---

*Last updated: 2026-08-22.*
