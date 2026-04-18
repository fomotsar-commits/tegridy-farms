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
- All contract ABIs in the frontend live in [`frontend/src/lib/contracts.ts`](../frontend/src/lib/contracts.ts) or [`frontend/src/lib/abi-supplement.ts`](../frontend/src/lib/abi-supplement.ts) (auto-generated from `forge build` artifacts via [`scripts/extract-missing-abis.mjs`](../scripts/extract-missing-abis.mjs)).
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
6. Re-run [`scripts/extract-missing-abis.mjs`](../scripts/extract-missing-abis.mjs) to pull the ABI into the frontend.

## Common gotchas

- **`forge build` fails with "stack too deep":** [`contracts/foundry.toml`](../contracts/foundry.toml) has `via_ir = true` — make sure your Foundry version is recent enough (`foundryup`).
- **Frontend can't connect to wallet:** confirm `VITE_WALLETCONNECT_PROJECT_ID` is set in `.env`.
- **`wagmi` ABI hooks don't see a function:** regenerate [`abi-supplement.ts`](../frontend/src/lib/abi-supplement.ts) via the script above.
- **Windows + Git line endings:** [`.gitattributes`](../.gitattributes) normalises to LF — if you see diff noise, re-run `git add --renormalize .`.
- **`forge test` fails on `MAINNET_ONLY` require:** Most V3 deploy scripts have `require(block.chainid == 1)` — use `--fork-url` to satisfy.

## Publishing a release

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for the full deploy runbook.

## Need help?

- Open a [Discussion](../../../discussions) for architecture questions.
- Open an [Issue](../../../issues) for bugs.
- Follow the [SECURITY.md](../SECURITY.md) disclosure process for security-sensitive reports.

---

*Last updated: 2026-04-17.*
