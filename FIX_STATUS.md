# Fix Status — Rolling tracker

Running log of what's landed on `main` in response to [AUDIT_FINDINGS.md](AUDIT_FINDINGS.md),
the 35-detective audit, the Spartan audit, and the 300-agent internal review.
See [REVENUE_ANALYSIS.md](REVENUE_ANALYSIS.md) for the fee-lever calibration.

Last refreshed 2026-04-25 after Wave 1–4 bulletproofing pass (101-agent
canonical audit + remediation phase; see [`.audit_101/MASTER_REPORT.md`](.audit_101/MASTER_REPORT.md)).
For a richer Keep-a-Changelog view see [CHANGELOG.md](CHANGELOG.md).

## ✅ Sessions 3–6 (2026-04-18)

### Contracts — shipped on `main`, **still need mainnet redeploy**

- **[GaugeController.sol](contracts/src/GaugeController.sol)** — commit-reveal
  voting implemented at the contract layer. `commitVote`, `revealVote`,
  `computeCommitment`, `isRevealWindowOpen`, `commitmentOf`, `committerOf`.
  Closes **audit H-2** (bribe arbitrage). 14/14 new tests pass in
  [GaugeCommitReveal.t.sol](contracts/test/GaugeCommitReveal.t.sol).
  All 1921 existing forge tests continue to pass.
- **[Toweli.sol](contracts/src/Toweli.sol)** — canonical TOWELI source in-repo
  for the first time. OpenZeppelin ERC-20 + ERC-2612 permit, 1B fixed
  supply, no admin surface. Closes the "no token source" audit-trail gap.
  Reference deploy script at
  [DeployToweli.s.sol](contracts/script/DeployToweli.s.sol); mainnet uses
  CREATE2 vanity per [docs/TOKEN_DEPLOY.md](docs/TOKEN_DEPLOY.md).
- **[DeployTegridyFeeHook.s.sol](contracts/script/DeployTegridyFeeHook.s.sol)**
  — **closes audit B7**. Self-contained CREATE2 salt-miner that finds a
  deployment address satisfying the Uniswap V4 hook flag bitmask (0x0044).
  Runs inline inside `forge script` — no external tooling required.

### Frontend — commit-reveal + refund loop shipped

- **[GaugeVoting.tsx](frontend/src/components/GaugeVoting.tsx)** — two-step
  commit-reveal UI with localStorage salt persistence, mode toggle
  (commit-reveal default, legacy emergency path), pending-reveal banner,
  missing-salt warning when on-chain commitment exists but local data is
  absent. Closes H-2 end-to-end.
- **[CollectionDetail.tsx](frontend/src/components/launchpad/CollectionDetail.tsx)**
  — red refund banner when sale is `CANCELLED` with a Claim Refund button
  bound to `paidByUser > 0`. Closes **H10** user-facing loop.
- **[OwnerAdminPanel.tsx](frontend/src/components/launchpad/OwnerAdminPanel.tsx)**
  — new on-chain `mintPhase` read + "Cancelled" chip in the panel header.
  Phase / MerkleRoot / Reveal / Withdraw / CancelSale buttons disable with
  clear labels once the sale is in the CANCELLED terminal state.
- **TegridyDrop ABI fix** ([contracts.ts](frontend/src/lib/contracts.ts)) —
  pre-existing bug: `currentPhase()` doesn't exist on the contract (it's
  `mintPhase()`). Every ABI call was reverting. Fixed + added
  `cancelSale`/`refund`/`paidPerWallet`. (V1 TEGRIDY_DROP_ABI block was later
  deleted 2026-04-19 and all readers migrated to TEGRIDY_DROP_V2_ABI, which
  carries the same surface as a strict superset.)
- **[useToweliPrice](frontend/src/hooks/useToweliPrice.ts)** — `TegridyTWAP`
  wired as third oracle leg. 30-minute TWAP cross-checks pair-reserve spot
  price; divergence > 2% flips to TWAP for manipulation-resistant pricing.
  `twapOverrideActive` signal exposed.
- **Indexer `TegridyStaking` address** corrected from paused v1
  `0x65D8…a421` to canonical v2 `0x6266…4819`
  ([ponder.config.ts](indexer/ponder.config.ts)).
- **Silent catches replaced** across the nakamigos sub-app (Listings,
  MyCollection, MakeOfferModal, OnChainProfile, useSmartAlerts) with
  scoped `console.warn` logging. Closes audit M8.
- **[usePageTitle](frontend/src/hooks/usePageTitle.ts)** extended: canonical
  `<link>`, `og:url`, `twitter:*`, per-page `og:image` override.
- **E2E Playwright specs** extended in
  [e2e/trust-pages.spec.ts](frontend/e2e/trust-pages.spec.ts): security,
  contracts, treasury, tokenomics, changelog, risks, history pages +
  sitemap/manifest/robots/og.svg asset served checks + SEO metadata checks.

### Docs & repo hygiene

- **[LICENSE](LICENSE)** (MIT) — was 404 despite README link.
- **[NOTICE.md](NOTICE.md)** — third-party attributions (OZ, Synthetix,
  Curve, Uniswap V2) + South Park fair-use / parody statement.
- **[HALL_OF_FAME.md](HALL_OF_FAME.md)** — fixes the SECURITY.md broken ref.
- **[docs/MIGRATION_HISTORY.md](docs/MIGRATION_HISTORY.md)** — canonical vs
  deprecated addresses across every contract with multiple live versions.
- **[docs/DEPRECATED_CONTRACTS.md](docs/DEPRECATED_CONTRACTS.md)** — ghost
  addresses (TegridyFarm, FeeDistributor, WithdrawalFee) documented.
- **[docs/TOKEN_DEPLOY.md](docs/TOKEN_DEPLOY.md)** — how TOWELI was
  deployed, CREATE2 vanity notes, testnet redeploy reference.
- **[docs/GOVERNANCE.md](docs/GOVERNANCE.md)** — admin-key model, timelock
  windows per contract, honest threat model ("single EOA; multisig
  migration is a priority"), what admin CAN and CANNOT do.
- **[docs/DEVELOPING.md](docs/DEVELOPING.md)**,
  **[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**,
  **[docs/API.md](docs/API.md)** — developer, deploy, and API references.
- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — expanded from 2.7KB
  outline to full reference with mermaid diagrams for every surface.
- **[docs/banner.svg](docs/banner.svg)** + `frontend/public/og.svg` —
  purpose-built 1280×640 social preview. Rendered as README hero + wired
  into `index.html` as `og:image` + `twitter:image`.
- **[README.md](README.md)** — rewritten with elevator pitch + badges
  (Contracts CI / CodeQL / Slither / License / Solidity / Chain) + TOC
  + repo layout + honest security section.
- **[CHANGELOG.md](CHANGELOG.md)** — comprehensive `[Unreleased]` section
  covering sessions 3–6 per Keep a Changelog.
- **GitHub workflows:** new
  [contracts-ci.yml](.github/workflows/contracts-ci.yml),
  [codeql.yml](.github/workflows/codeql.yml),
  [slither.yml](.github/workflows/slither.yml),
  [release.yml](.github/workflows/release.yml).
- **[.github/dependabot.yml](.github/dependabot.yml)** + FUNDING.yml
  + [.gitattributes](.gitattributes) + [.nvmrc](.nvmrc).
- **Vercel security headers** hardened: HSTS 2y + preload, COOP, CORP,
  X-Permitted-Cross-Domain-Policies, extended Permissions-Policy
  ([vercel.json](frontend/vercel.json)).
- **[frontend/public/sitemap.xml](frontend/public/sitemap.xml)** —
  `lastmod` + `changefreq` on every URL; added `/contracts` + `/treasury`.
- **[frontend/public/manifest.json](frontend/public/manifest.json)** —
  replaced broken `skeleton.jpg` icon refs with actual `icon-192.png` +
  `icon-512.png`; added `any maskable` purpose.
- **package.json `license: "MIT"`** + `engines.node ≥20` on both
  `frontend/` and `indexer/`.

## ⚠️ Status of original 2026-04-17 session work

All original-session fixes below are still in place on `main` (re-verified
at the session-6 HEAD). Addresses still need the mainnet redeploy to take
effect on-chain.

## ✅ Originally done (2026-04-17)

### Contracts (need rebuild + redeploy to take effect)
- `contracts/src/TegridyLPFarming.sol` — added `exit()` convenience function so the
  frontend's existing `useLPFarming.exit()` call no longer reverts. Stake now auto-refreshes
  the caller's boost against the latest TegridyStaking NFT (JBAC holders no longer need a
  separate `refreshBoost` step).
- `contracts/src/TegridyNFTLending.sol` — added `GRACE_PERIOD = 1 hours` and gated
  `repayLoan` (`deadline + GRACE_PERIOD`) and `claimDefault` (`deadline + GRACE_PERIOD`) so
  NFT borrowers get the same safety buffer as ERC-20 borrowers.
- ~~`contracts/src/TegridyDrop.sol`~~ — H-10 refund-flow (`MintPhase.CANCELLED`,
  `paidPerWallet` tracking, `cancelSale()` irreversible owner-only, pull-pattern
  `refund()`, events `SaleCancelledEvent` + `Refunded`, `withdraw()` blocked when
  CANCELLED, `setMintPhase()` cannot enter/exit CANCELLED). **V1 source deleted
  2026-04-19**; the same surface lives on `contracts/src/TegridyDropV2.sol`,
  which is the canonical drop template going forward.
- `contracts/script/DeployGaugeController.s.sol`,
  `contracts/script/DeployTokenURIReader.s.sol`,
  ~~`contracts/script/DeployV3Features.s.sol`~~ (deleted 2026-04-19),
  `contracts/script/WireV2.s.sol` — replaced stale staking address
  `0x65D8...` with the new `0x6266...` (Gap A sed).

### Deleted dead code
- `contracts/src/LPFarming.sol` (was the duplicate non-boosted farm — `TegridyLPFarming` is
  the only one deployed).
- `contracts/script/DeployLPFarming.s.sol`, `contracts/test/LPFarming.t.sol` — orphaned
  after the above.
- `frontend/src/assets/hero.png`, `react.svg`, `vite.svg` — Vite starter leftovers.
- `frontend/src/components/PageTransition.tsx` — imported nowhere.
- Empty dirs: `frontend/src/components/characters/`, `frontend/src/components/dashboard/`,
  `frontend/src/assets/textures/`.

### Frontend fixes (hot-reloadable)
- `frontend/src/lib/constants.ts` — `TEGRIDY_STAKING_ADDRESS` swapped to new `0x6266...`.
  Dated comment explaining the C-01 migration. `TOWELI_TOTAL_SUPPLY` comment explains why
  the hardcode is safe.
- `frontend/src/pages/SecurityPage.tsx` — removed the inflated "5 Critical / 13 High / 26
  Medium / 38 Low — all resolved" block. Replaced with a neutral "read the audit files"
  card with three links.
- `frontend/src/pages/ChangelogPage.tsx` — softened "Fixed all v4 audit findings" →
  "Applied fixes for several v4 audit findings" with pointer to the audit file.
- `frontend/src/hooks/useLPFarming.ts` — added `chainId` guard + proactive allowance check
  in `stake()`; imports `CHAIN_ID`. (parseEther is correct for Uniswap V2 LP tokens; added
  comment explaining.)
- `frontend/src/hooks/useSwapQuote.ts` — wired `useChainId()` into the master `pairsEnabled`
  flag so quotes don't fire on non-mainnet (prevents silent garbage reads).
- `frontend/src/components/nftfinance/LendingSection.tsx`,
  `frontend/src/components/nftfinance/AMMSection.tsx` — converted `<a href="/security">` to
  `<Link to="/security">` so clicks stay in SPA routing.
- `frontend/src/pages/HistoryPage.tsx` — fetch cap raised from 50 → 500, added 25/row
  pagination with Prev/Next + page indicator, resets to page 0 when the wallet changes.

### Supabase migrations
- `frontend/supabase/migrations/002_native_orders_trades_push.sql` — creates the three
  tables referenced by API endpoints / RLS policies but never backed by a CREATE TABLE:
  `native_orders`, `trade_offers`, `push_subscriptions`. Also backfills explicit SELECT
  policies on `messages`, `user_profiles`, `user_favorites`, `user_watchlist`, `votes`.

### Env / docs
- `contracts/.env.example` — added `TEGRIDY_STAKING`, `TEGRIDY_LP`, `LP_TOKEN`.
- `frontend/.env.example` — added `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`,
  `ALLOWED_ORIGIN`.
- `REVENUE_ANALYSIS.md` — full fee-lever map, peer benchmarks, calibration recommendations,
  revenue-quick-win decision tree.

### What I did NOT touch per your instructions
- `.env` files — you said "private key is scrubbed, API keys whatever". Left as-is.
  They were never committed to git (verified via `git log --all --full-history`). Rotate
  at your pace.

## 🟡 Deferred — remaining work

Scope cut from the current work to keep changes reviewable. Each can be picked up later.

1. ✅ ~~Commit-reveal gauge voting UI~~ — **done in session 4-5**; `GaugeController.sol`
   now has `commitVote`/`revealVote`, ABI is in `contracts.ts`, `GaugeVoting.tsx`
   ships the two-step flow with localStorage salt persistence.
2. ✅ ~~Launchpad admin UI (cancelSale, refund, reveal)~~ — **done in sessions 4-6**;
   OwnerAdminPanel has Danger Zone + cancelSale confirm, CollectionDetail has
   buyer-side refund banner, all gated on on-chain `mintPhase` reads.
3. **Rewire ghost hooks** — `useBribes`, `useReferralRewards`, `useAddLiquidity` are
   feature-complete but unimported. `VoteIncentivesSection.tsx` reimplements bribe
   logic inline. Not blocking but is technical debt.
4. **Indexer expansion — BLOCKED by Ponder type ceiling**. Register `GaugeController`
   events, add `MemeBountyBoard` submission/vote/dispute/refund handlers, add
   `CommunityGrants` lapse/cancel/refund/execution-failed handlers, fix
   `restaking_position` tombstone (`depositTime=0` on Unrestaked breaks active-
   positions queries). Attempted in session 5 — Ponder's `Virtual.Registry`
   TypeScript inference ceiling trips when total contract count or per-ABI event
   count crosses a threshold. Session 5 established the ceiling was pre-existing
   (broken already in committed state), not a regression.
5. **Wire Leaderboard + History to Ponder** — blocks on #4.
6. ✅ ~~Wire `TegridyTWAP.consult()` into `useToweliPrice`~~ — **done in session 5**;
   30-min TWAP cross-checks spot; > 2% divergence triggers fallback.
7. ✅ ~~`TegridyFeeHook` deploy~~ — **salt-mining script shipped in session 6**
   ([DeployTegridyFeeHook.s.sol](contracts/script/DeployTegridyFeeHook.s.sol)).
   Self-contained CREATE2 miner for the `0x0044` hook-flag prefix. Needs
   operational run + V4 pool wiring to close B7 fully.
8. ✅ ~~Regenerate `frontend/src/generated.ts`~~ — **done in session 3** via
   [scripts/extract-missing-abis.mjs](scripts/extract-missing-abis.mjs). 8 missing
   ABIs now in [abi-supplement.ts](frontend/src/lib/abi-supplement.ts).
9. **Test backfill** — 29 hooks with no unit tests. Session 5-6 added the
   Playwright E2E scaffolding and extended smoke.spec.ts + wrote
   `trust-pages.spec.ts`; significant frontend unit-test coverage is still owed.
10. ✅ ~~Silent `.catch(() => {})` in nakamigos components~~ — **done in session 6**.
    MakeOfferModal, MyCollection, Listings, OnChainProfile, useSmartAlerts all get
    scoped `console.warn` logging. useSound AudioContext.close() left silent with
    an explanatory comment (browser-owned lifecycle; errors not actionable).
11. ✅ ~~isPending guards on AMMSection/NFTLendingSection~~ — **done in session 3**.

## 🔴 Needs YOU (not something an agent can do)

- **Rotate committed API keys + private key** out of `.env` working files. Never pushed
  to git per earlier `git log --all --full-history` check, but rotate anyway.
- **Wave-0 multisig `acceptOwnership` STILL OPEN** on 3 contracts (LP Farming,
  Gauge Controller, NFT Lending) — Safe `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe`
  must call `acceptOwnership()` on each. See [`docs/WAVE_0_TODO.md`](docs/WAVE_0_TODO.md) §3.
- **Per-contract constructor-arg deltas** from Wave 1–4 bulletproofing — read
  the change logs in `.audit_101/remediation/` before broadcasting:
  - **R003** — `TegridyLending` constructor now **5 args** (was 4); new `_twap`
    arg passes the `TegridyTWAP` address for ETH-denominated collateral floor.
  - **R015** — `POLAccumulator` constructor now **5 args**; new `_twap` arg +
    `LPMismatch` factory check on the LP token vs. the pair the TWAP watches.
  - **R020** — `VoteIncentives` constructor now **7 args**; new
    `_commitRevealFromGenesis` (boolean) tells the bribe contract whether to
    treat epoch 0 as commit-reveal-active or legacy.
  - **R029** — `TegridyNFTLending` no longer auto-whitelists collections at
    construction. Post-deploy you must call `proposeWhitelistCollection(addr)`
    → wait 24h → `executeWhitelistCollection(addr)` for each of JBAC,
    Nakamigos, GNSS (recipe in [`DEPLOY_CHEAT_SHEET.md`](DEPLOY_CHEAT_SHEET.md) §3 Step 5).
- **After rebuilding contracts:** run the per-contract `forge script` invocations
  documented in [`DEPLOY_CHEAT_SHEET.md`](DEPLOY_CHEAT_SHEET.md) (the previous
  one-shot helper `scripts/redeploy-patched-3.sh` was deleted 2026-04-19 with the
  V1 `TegridyDrop` source — use per-contract scripts now). Then run
  [`scripts/diff-addresses.ts`](scripts/diff-addresses.ts) → apply the constants.ts
  patch + README address-table updates in one commit. Current on-chain versions
  still do **not** have every patch — see [`NEXT_SESSION.md`](NEXT_SESSION.md)
  for the live Wave 0 status.
- **Apply Supabase migration 002** in the SQL editor.
- **Run `DeployTegridyFeeHook.s.sol`** (CREATE2 miner) once POOL_MANAGER +
  REVENUE_DIST env vars are set. Mining typically 10k–200k iterations.
- **Transfer ownership to a Safe multisig** — biggest trust-model improvement still
  outstanding. See [docs/GOVERNANCE.md](docs/GOVERNANCE.md).
- **Finalise [TOKENOMICS.md](TOKENOMICS.md) allocation** — still "TBD placeholder"
  on mainnet.
- **Publish a community surface** — Discord / Twitter / governance forum. Until
  then GitHub Issues / Discussions are the canonical channel per README.
- **Decide on the revenue calibration moves in
  [REVENUE_ANALYSIS.md](REVENUE_ANALYSIS.md) §4** — each one is a 24–48h timelock
  proposal that needs a multisig signer set (blocks on multisig migration).
