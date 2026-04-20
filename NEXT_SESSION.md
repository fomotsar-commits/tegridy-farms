# Next Session — Handoff Notes

Where we are, what's left, and where to start when a new session opens.

---

## Status at handoff (2026-04-18, after session 13)

**Current branch:** `main` at [`9b6e7da`](https://github.com/fomotsar-commits/tegridy-farms/commit/9b6e7da). Clean working tree (plus the usual scratch at `.audit_findings.md`, `.claude/`, `.spartan_unpacked/`, `indexer/nul`, `frontend/test-results/`, `indexer/tsconfig.tsbuildinfo` — all gitignored-appropriate).

**13 commits pushed** across sessions 1–13. Cumulative: ~24,000 lines touched across ~130 files.

**Live test health:**
- `forge test`: **1,921 / 1,921 passing** across 66 suites
- `pnpm --filter frontend exec vitest run`: **403 / 403 passing** across 27 files
- `pnpm --filter frontend exec tsc --noEmit`: **0 errors**
- Playwright E2E: 20+ specs across smoke, trust-pages, gauge-voting, wallet-connect, trade-page

**Known-stale:** indexer `pnpm exec tsc --noEmit` reports Ponder `Virtual.Registry` type-recursion errors — **pre-existing ceiling issue**, not a regression. Verified via `git stash` in session 5.

---

## Immediate priorities when the new session opens

### 🔴 1. Wave 0 execution (user hands — 45-90 min + 48h timelock wait)
Open [`docs/WAVE_0_RUNBOOK.md`](docs/WAVE_0_RUNBOOK.md) and work through top-to-bottom. Every step is a scripted command or dashboard click. Six steps:

1. Rotate `.env` secrets (Alchemy / Etherscan / WalletConnect / Upstash / Supabase / deployer EOA)
2. Apply Supabase migration 002 in the SQL editor
3. Redeploy the 3 patched contracts via `scripts/redeploy-patched-3.sh` + `scripts/diff-addresses.ts` → patch `constants.ts` + README + `MIGRATION_HISTORY.md`
4. Deploy `TegridyFeeHook` via the CREATE2 salt-miner at `contracts/script/DeployTegridyFeeHook.s.sol`
5. *(Already done in session 13:)* Render OG PNG — skip
6. Smoke-test prod

Needs: your private key, RPC URL, ~0.05 ETH for gas across all the redeploys, Supabase dashboard access.

### 🟠 2. Community channel registration (user hands — hours across days)
Open [`docs/COMMUNITY_LAUNCH.md`](docs/COMMUNITY_LAUNCH.md). Phased order:
1. GitHub Discussions — **30 seconds**, enable it today in repo settings
2. Twitter / X — register `@tegridyfarms`, post the 5-tweet launch sequence
3. Discord — only after 2 moderators are committed for round-the-clock coverage
4. Telegram — last (announcement-mirror only)

After channels exist, update README's "Community" section + `FUNDING.yml` + `Footer.tsx` with the real URLs.

---

## Deferred deliberately

### 🟣 Multisig migration — "last thing to cover" per your earlier decision
Skeleton in [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md). When ready, ask me to write:
- `docs/MULTISIG_MIGRATION.md` — full runbook
- `contracts/script/TransferOwnershipToMultisig.s.sol` — one script that fires `transferOwnership(safe)` on every owner-controlled contract (TegridyStaking, TegridyLPFarming, SwapFeeRouter, POLAccumulator, GaugeController, VoteIncentives, RevenueDistributor, ReferralSplitter, PremiumAccess, CommunityGrants, MemeBountyBoard, TegridyLending, TegridyNFTLending, TegridyNFTPoolFactory, TegridyLaunchpadV2). V1 `TegridyLaunchpad` source was deleted 2026-04-19 — V1 clones on mainnet remain ownable but are not in scope for this sweep.
- Pre-flight: deploy a Safe with your signer set, decide threshold (3-of-5 recommended)

---

## Upstream / tooling blocked — can't progress without external change

| Item | Blocker | Workaround if you want to unblock |
|---|---|---|
| Indexer expansion (GaugeController events, bounty submissions/votes, grants lapse/cancel/refund, restaking tombstone fix) | Ponder `Virtual.Registry` TypeScript recursion ceiling cascades errors across unrelated contracts when too many events/tables are added. Pre-existing on `main` — not a regression. | Use `ponder.on as any` suppression on new handlers (ugly but works at runtime), OR wait for Ponder to raise the inference budget upstream |
| Leaderboard + History → Ponder GraphQL | Blocks on indexer expansion above | Same |
| Full E2E commit-reveal flow | Mock wallet fixture can't forward RPC writes; Anvil-backed upgrade documented in [`frontend/e2e/fixtures/wallet.ts`](frontend/e2e/fixtures/wallet.ts) § `ANVIL_BACKEND` | Run `anvil --fork-url $MAINNET_RPC`, tweak the fixture per the 4-step upgrade in-file |
| Nonce-based CSP (replace `'unsafe-inline'`) | Requires Vite plugin tooling to inject per-script nonces | Either ship a Vite plugin dev-dep, or accept current CSP (other headers hardened in session 5: HSTS 2y + preload, COOP, CORP, extended Permissions-Policy) |

---

## Ship-ready enhancements (can ship next session, no blockers)

### Code / test
- **More hook unit tests:** `useSwapQuote`, `useSwapAllowance`, `useAddLiquidity`, `useReferralRewards` (the "ghost hooks" from audit M1 that are feature-complete but unimported anywhere) — each adds 10-15 tests via the wagmi-mocks scaffold at `frontend/src/test-utils/wagmi-mocks.ts`
- **Ghost hook rewire:** `useAddLiquidity` has an inline consumer shell in `TradePage`; `useReferralRewards` is unused. Rewire both now that `useBribes` rewire is proven (session 11)
- **`lib/` coverage:** `formatting.ts` already has tests, but `analytics.ts`, `errorReporting.ts`, `storage.ts`, `explorer.ts`, `artConfig.ts` are untested. Pure-logic files, no wagmi needed
- **E2E wallet-integrated:** commit-reveal UI walkthrough (after Anvil upgrade above), refund-flow smoke, admin-panel Danger Zone cancel flow

### Ops / repo hygiene
- **Cut `v3.0.0-rc1` tag** to smoke-test the `.github/workflows/release.yml` workflow — just `git tag v3.0.0-rc1 && git push origin v3.0.0-rc1`
- **Enable branch protection** on `main` via GitHub Settings → Branches: require 2 reviews, require CI green, dismiss stale approvals. Can't do via API from here; user clicks
- **Write `DISCLAIMER.md`** at root — mentioned in earlier audit passes as missing; should include "not financial advice", ToS pointer, regulatory-neutral framing
- **Write `docs/INCIDENT_RESPONSE.md`** — formalise the "if something goes wrong" section from Wave 0 runbook into its own doc
- **Dependabot PR triage:** first weekly batch should land Monday; review + merge

### Observability
- **Dune dashboard** — public TVL / staker count / fee-flow chart. Most legitimacy-building thing you can do fast. Add URL to README
- **Tenderly alerts** — set up anomaly detection on the treasury address and major contract interactions
- **Immunefi listing** — README already points at `immunefi.com/bounty/tegridyfarms` but that page 404s until someone submits the project. Actual listing takes ~2 weeks

### Investor polish
- **Team page** — once you're ready to name signers for multisig, a `docs/TEAM.md` with bios + Twitter handles is the single biggest investor-confidence move you can make (current README literally says "solo project until community exists")
- **Metrics README badge** — cut TVL / fee-distribution / staker count into a dynamic SVG badge via Dune's API

---

## What to say to open the new session

Copy-paste this into the new session's first message:

```
Read NEXT_SESSION.md at the repo root. It's the handoff from the
previous session. Pick up from there — start with the Wave 0 runbook
if I haven't executed it yet, otherwise continue with the ship-ready
enhancements in the order listed.
```

---

## Quick-reference: commit history

| # | SHA | Title | Sessions |
|---|---|---|---|
| 1 | `d2a7bf5` | docs+repo: investor-grade polish | 2 |
| 2 | `86dee44` | contracts: add Toweli.sol source | 2 |
| 3 | `0468faf` | feat: onboarding, meme-voice, ABI regen, mobile polish | 2 |
| 4 | `b871400` | security+product: close audit H-2, refund UI, SEO polish | 4 |
| 5 | `f7ca3dd` | feat: TWAP oracle, OG banner, indexer fix | 5 |
| 6 | `7377745` | feat: B7 closure + nakamigos cleanup + admin state + E2E | 6 |
| 7 | `1ce6eb1` | test: 62 new unit tests + repair stale nav assertions | 7 |
| 8 | `1d2ce96` | test+tooling: wagmi scaffold, useNFTDrop, gauge E2E, OG raster script | 8 |
| 9 | `7369f4a` | test: useLPFarming + useFarmActions (35 new) | 9 |
| 10 | `c91913d` | test: useBribes + useUserPosition + useNFTBoost (36 new) | 10 |
| 11 | `8e5437d` | test+refactor: 5 hook suites (89 new) + VoteIncentives rewire | 11 |
| 12 | `7fc4493` | docs: canonical audit + AUDITS.md rewrite + .gitignore fix | 12 |
| 13 | `9b6e7da` | feat+docs: TOKENOMICS, Wave 0 + Community playbooks, OG PNG | 13 |

---

## Key files to know

### Entry points for a fresh reader
- [`README.md`](README.md) — elevator pitch + user flow + dev flow + full audit archive + deployed contracts
- [`AUDITS.md`](AUDITS.md) — 14-artifact audit inventory with the blocker-status matrix
- [`FIX_STATUS.md`](FIX_STATUS.md) — rolling remediation tracker across all sessions
- [`CHANGELOG.md`](CHANGELOG.md) — Keep-a-Changelog format, `[Unreleased]` section covers sessions 3–13

### Deeper docs
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — 25-contract system map + mermaid diagrams
- [`docs/WAVE_0_RUNBOOK.md`](docs/WAVE_0_RUNBOOK.md) — **next session's primary reading**
- [`docs/COMMUNITY_LAUNCH.md`](docs/COMMUNITY_LAUNCH.md) — Discord/Twitter/Telegram/GitHub setup
- [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md) — multisig migration plan
- [`docs/DEVELOPING.md`](docs/DEVELOPING.md) — local dev setup
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — deploy runbook + rollback
- [`docs/MIGRATION_HISTORY.md`](docs/MIGRATION_HISTORY.md) — canonical vs deprecated addresses
- [`docs/DEPRECATED_CONTRACTS.md`](docs/DEPRECATED_CONTRACTS.md) — orphan contracts (TegridyFarm v1, WithdrawalFee, FeeDistributor v1)
- [`docs/TOKEN_DEPLOY.md`](docs/TOKEN_DEPLOY.md) — how TOWELI was deployed
- [`docs/API.md`](docs/API.md) — serverless endpoint reference

### Test scaffolding
- [`frontend/src/test-utils/wagmi-mocks.ts`](frontend/src/test-utils/wagmi-mocks.ts) — reusable wagmi mock. Any new hook test: `import { wagmiMock } from '../test-utils/wagmi-mocks'` and you're done
- [`frontend/e2e/fixtures/wallet.ts`](frontend/e2e/fixtures/wallet.ts) — Playwright wallet fixture. See `ANVIL_BACKEND` block for the real-RPC upgrade path

### Operational scripts
- ~~[`scripts/redeploy-patched-3.sh`](scripts/redeploy-patched-3.sh)~~ — deleted 2026-04-19 with V1 `TegridyDrop` source. Use per-contract `forge script` runs for `TegridyLPFarming` + `TegridyNFTLending`; V2 drop template auto-deploys with the V2 factory.
- [`scripts/diff-addresses.ts`](scripts/diff-addresses.ts) — print the constants.ts patch after redeploy
- [`scripts/extract-missing-abis.mjs`](scripts/extract-missing-abis.mjs) — pull ABIs from forge artifacts into `frontend/src/lib/abi-supplement.ts`
- [`scripts/render-og-png.mjs`](scripts/render-og-png.mjs) — SVG → PNG (requires `@resvg/resvg-js`, already devDep'd)

---

*Written 2026-04-18 at the close of session 13. If you're reading this in a fresh session, this file is the map.*
