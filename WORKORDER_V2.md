# Tegridy Farms — Remediation Work Order v2 (hard-verified 2026-07-28)

Supersedes the external `tegridy-claude-code-workorder.md` + `tegridy-feature-roadmap.md` (both dated 2026-07-23/24). Every load-bearing claim in those docs was re-verified against the repo and mainnet by a 75-agent adversarial review (verify → 2-skeptic refute → design), and this document itself passed a red-team critique pass (2026-07-28). Items marked **[v1-WRONG]** were factually wrong in the originals; **[v1-STALE]** were true once but already done/changed; **[NEW]** were missing entirely.

**Execution protocol: stop, summarize, and WAIT for operator go at the end of each phase — mandatory after Phase 0 and before ANY phase containing deletions or contract-source changes.** Commit per phase with conventional-commit messages.

---

## Ground rules (non-negotiable)

0. **[NEW] Branch + working tree:** all work targets **`mvp-launch`** — the real trunk (`main` is 7/481 behind with a different, red vitest baseline). Never merge `main` in. The primary checkout is SHARED with concurrent sessions: work in a dedicated git worktree (node_modules junction trick documented in memory) or commit fast with explicit paths; re-check the branch before every commit. vitest on mvp-launch is fully green — any failure is yours.
1. **Never read, open, grep, cat, or echo** `.env*`, `*.pem`, `*.key`, `secrets/`, `.aws/`, `.ssh/`, `.npmrc`, `.pypirc`, or anything under `keys/`. Use placeholders; ask the operator for values.
2. **Never broadcast a transaction.** Write and dry-run `forge script` (no `--broadcast`), generate calldata, write runbooks. All on-chain execution is the operator's.
3. **Minimal attack surface is law:** sibling-canonical fixes only (port from battle-tested patterns already in the repo or from OZ/Curve/Synthetix/Aave/Uniswap/Sudoswap/Gondi/Solady); DELETE before ADD; no proxies; immutable contracts are a feature.
4. **[v1-WRONG → corrected] Redeploy batching:** a next-redeploy batch **already exists** — branch `claude/determined-wu-1418c6`, commit `8f72bed` ("sec(1000-agent): fix M-1/L-1/L-2/L-3/L-4 + 3 gas packings"). **Scope: only BEHAVIOR changes to deployed contract sources go there** (Spartan-M2 fix, TWAP ratchet, any future caller-incentive). Hygiene, test relocation, and dead-code deletion (Phases 3/4) land on `mvp-launch` — that's where CI actually gates. Never start a fresh `next-redeploy` branch; it orphans `8f72bed`.
5. **Serverless budget [v1-WRONG]:** the branch is at **10/12** Vercel Hobby functions (aggregator, alchemy, auth/me, auth/siwe, etherscan, opensea, orderbook, solrpc, supabase-proxy, v1/index) — not 9/12. Two slots of headroom. Every new server route folds into `frontend/api/v1/index.js` (`?route=` dispatch) or the aggregator catchall; never add a top-level `api/*.js` without counting. First task touching api/: refresh the stale `frontend/api/SERVERLESS_BUDGET.md`.
6. **Test gates:** `forge test` green, frontend `vitest run` green, `tsc --noEmit` 0 errors per phase. `forge build` works locally (~84s warm; cold worktree 10min+; use `forge inspect` for one contract). **[NEW] CI placement rule — ~~SUPERSEDED 2026-07-28 by PR #130~~:** ~~new Foundry gating tests go DIRECTLY in `contracts/test/` with a slice-matching prefix (`Audit_*.t.sol` is safest); never in `test/v4/` or `test/invariants/` (no CI slice runs those)~~. **Corrected rule:** the matrix is now generated from `.github/contracts-test-slices.json` and a coverage guard FAILS CI on any `contracts/test/**/*.t.sol` not claimed by a slice or an explicit `excluded[]` entry — so a test in an unsliced location can no longer be silently ignored, it is a hard error telling you to slice it. `test/v4/` and `test/pass5_pocs/` now have slices. Note the original rule was itself understated: it was not only subdirectories — **10 TOP-LEVEL files** (the five `Audit20260712_*`, `C01_*`, both `C1_*`, `MVPLaunch_StakeCapsAndGuardian`, `TransferOwnershipToMultisig`) also matched no slice, so "`test/` root with an `Audit_*` prefix" was necessary but NOT sufficient — `Audit20260712_*` starts with `Audit` and still never ran. **Still true:** test names must avoid the substrings `Invariant`/`Fuzz` (the shared `--no-match-test` is a NAME filter, independent of slicing), and `test/invariants/`, `test/echidna/`, `test/halmos/` still run in NO pipeline. After landing a suite, verify the CI slice log actually RAN it.
7. **[NEW] House UI laws:** (a) every UI change verified responsive at desktop / iPhone 14+ (390–430px) / iPad; (b) never remove or swap existing art or page sections — new pages/cards get art additively (ArtCard with a distinct idx); (c) a new regression test counts only if shown FAILING against pre-fix code — pin the invariant, not a literal; (d) prod deploy = from REPO ROOT, alias `tegridyfarms.vercel.app`; beware the SPA-fallback trap (missing `/assets/*.js` returns 200 + index.html) — verify deploys against real chunk URLs; re-check date-gated content whenever its window opens.
8. **[NEW] Port before you build:** Tradermigos (`frontend/src/nakamigos/`) already has watchlist, alerts, notification center, share cards, profiles on the same Supabase+SIWE stack — adapt those patterns into TYPED main-app modules. Never deep-import `.jsx` from nakamigos into main-app pages.
9. **[NEW] ABI single source of truth:** `frontend/src/lib/contracts.ts` + generated `abi-supplement.ts` are CI-gated for drift (PR #101 gate). Never hand-edit the generated file; never reintroduce wagmi codegen (deleted 2026-07-23). Any new ABI generator (e.g. for the indexer) must be a SIBLING script reading the same forge artifacts.
10. **[NEW] Supabase migrations:** number each new migration with the next contiguous free number AT CREATION TIME (012 exists but is deliberately unapplied — bundle go-live is operator-gated). The operator applies migrations INDIVIDUALLY, never a bulk `db push`, until 012's gated go-live has happened. Copy migration 008's explicit role grants into every new table (Supabase 42501 trap) and the 001/004 SIWE-wallet RLS pattern.
11. **Honesty-gating is law:** numbers render only from live reads; missing data self-gates to an explicit "no data" state; nothing fabricates. Read `frontend/src/lib/scanner/scanner.ts` header + `ProofOfClaims.tsx` before building any surface.

---

## Phase 0 — Baseline verification (~30 min)

1. Full test + typecheck suite; record baseline (mvp-launch vitest is green — record exact counts).
2. `forge build --sizes`: flag anything within 1KB of 24,576 B **and** anything over the CI gate's 24,000 B warn tier (VoteIncentives measured 24,197 B — already over the warn tier). Storage-packing ADDS bytecode; measure both axes.
3. Confirm frontend gating state in `frontend/src/lib/constants.ts` (zeroed vs live addresses).
4. **[NEW]** Branch/PR inventory before any contract work: `git log --all --grep=redeploy` + `gh pr list` — confirm `8f72bed` as the redeploy base; adopt PR #94 as the Ponder-upgrade vehicle if Phase 2B proceeds; track/land PR #102 (interface-selector CI guard); triage May–June stragglers per `OPEN_PR_TRIAGE_2026_06_01.md`.
5. **[NEW]** V2_ROADMAP verification pass: check each item against source before treating it as pending (at least #2 boost-decay and #8 tokenURI are already done; verify #5 dead-penalty-code and #6 Factory-timelock still pending — if so they belong in the `8f72bed` batch).
6. Output a one-page baseline report. Fix nothing yet. **WAIT for operator go.**

---

## Phase 1 — Fee split activation (timelocked parameter changes; operator executes)

**Verified premise:** SwapFeeRouter `0x6d5791A660e79175F74C6D639584C98422d5956E` routes 100% of swap fees to stakers (`stakerShareBps=10000`, live read). `applyFeeSplit` exists (floor 5000 staker, cap 2500 POL); the timelocked path is SwapFeeRouterAdmin `0xa517A1cEfd961c0DDE8155a0Fa870aEE5bb0D060` `proposeFeeSplit`/`executeFeeSplit` (48h), owner = clean deployer. The Q3 "70/20/10 splitter contract" is superseded **for the swap stream** — do not build it (drop/lending fee streams stay 100%-to-treasury; accepted deviation, operator's call).

**Two live-read discoveries that change the sequence [v1-WRONG]:**
- `polAccumulator()` on the live router = **address(0)** — a naive `proposeFeeSplit(8000,1000)` would silently route the POL slice to treasury (8000/0/2000). POLAccumulator receipt itself cannot revert (unconditional receive + pull-pattern) — TWAP dormancy only idles the funds.
- `treasury()` = **`0x7D26…Bd7d`** — the 2-of-2 Safe whose only signers are the flagged pair pending rebuild.

Deliverables (`docs/FEE_SPLIT_ACTIVATION.md` + calldata bundle, no broadcast):
1. **Full read battery first** (cast, publicnode; paste outputs into the memo; re-run before each execute): (A) router — stakerShareBps / polShareBps / treasury / polAccumulator / admin; (B) admin — owner + all pending-change state; (C) treasury Safe `0x7D26…Bd7d` — getOwners/getThreshold (the custody ground truth); (D) PremiumAccess — monthlyFeeToweli / toweli / owner (anchors deliverable 3); (E) pair getReserves (the TOWELI→ETH conversion for the memo's math); (F) the four fee-cut lever levels + each admin/owner signer, incl. the 0xA360 Safe threshold that determines the Safe-gated leg.
2. **Three-leg bundle on SwapFeeRouterAdmin** (all 48h): Leg 1 `proposePolAccumulator(<POLAccumulator address from constants.ts>)`; Leg 2 `proposeTreasuryChange(<operator-supplied clean address>)`; Leg 3 `proposeFeeSplit(8000, 1000)`. **Binding rule: Leg 3 executes ONLY after Leg 1 AND (Leg 2 OR the completed Safe rebuild re-homing 0x7D26). If neither Leg-2 condition holds, do not execute Leg 3** — it would park 10% of every distribution in the flagged Safe. Safe alternative if the operator wants POL routing before any treasury fix: `proposeFeeSplit(9000, 1000)` (sum = 10000 → treasury remainder 0), retuned to 8000/1000 after rotation. Note: `execute*()` functions take NO arguments (no expected-value binding) — read pending state immediately before executing; proposals have a bounded validity window (~7 days — verify the constant in SwapFeeRouterAdmin source and put the execute window, day 2–9, in the runbook; past it, `cancel*` and re-propose). Rollback: `cancel*` pre-execution; fresh `proposeFeeSplit(10000,0)` post-execution. Un-wiring trap: once `polShareBps>0`, un-setting the accumulator reverts — zero the POL share first.
3. **Premium: doc-truth fix, NOT repricing [v1-WRONG].** The "0.01 ETH/mo, reprice to 0.003" deliverable is unit-confused: the live PremiumAccess (`monthlyFeeToweli()`, cast-verified) charges **10,000 TOWELI/mo ≈ 0.00026 ETH ≈ ~$1/mo** — already ~11× BELOW the v1 target; there is no ETH payment path in the contract. The 0.01-ETH figure traces to the never-deployed `.skip-broken/DeployFinal.s.sol`, itself unit-confused. Action: correct `REVENUE_ANALYSIS.md` (lines ~18/65/76/91-92/100-101: live price, mechanism = proposeFeeSplit not proposeFeeChange, break-even ≈ $12k/mo not $40k, delete "requires a contract patch"). Include the future repricing path as reference only (`PremiumAccess.proposeFeeChange(uint256 toweliWei)` → 24h → `executeFeeChange`, args in TOWELI-wei — beware repeating the unit confusion) with no recommended value.
4. **Optional fee-cut appendix, split by signer [NEW]:** deployer-executable today — lending 5%→2-3% (TegridyNFTLendingAdmin, 48h), launchpad 5%→3% (direct, 48h, expected-value-bound execute), bribe 3%→2% (VoteIncentivesAdmin, 24h). **Safe-gated** — NFT-pool fee 0.5%→0.25% requires the 0xA360 Safe the operator deliberately isn't operating: deliver as a post-rebuild Safe-tx bundle or defer explicitly. State snapshot semantics plainly: cuts affect only offers/pools/drops created AFTER execution.
5. Frame honestly: revenue today is near-zero — this is correctness plumbing so future fees route right, not an income event.

---

## Phase E — Emissions runway **[NEW — rank-#1 omission in v1]**

100% of live Farm yield is finite TOWELI emissions. Verified: the **LP-farming reward period already ended 2026-06-15** (periodFinish on-chain); the staking pool holds ~5.2M distributable → runway to **~2026-10-04** (~10 weeks; re-derive from chain at execution — don't trust this figure either).
1. Publish the emission end date read live from chain (frontend already has usePoolData runway fields).
2. Operator decision doc: taper/refill policy via the `proposeRewardRate` path BEFORE ~Oct-4; refills only from realized revenue (Phase 1 is the funding-side companion).
3. LP farming: label honestly as ended (or operator re-notifies) — the UI must not imply live LP emissions.
4. Add a synthetic-monitor alert on a remaining-runway threshold.

---

## Phase L — Launcher go-live residue **[NEW — was orphaned between v1 phases]**

The `launchBuy.ts` GO-LIVE TODO is Doppler-SDK swap-encoding work with zero indexer dependency (v1 misfiled it under the indexer phase): add `@whetstone-research/doppler-sdk` v1.0.29 to the shared lockfile (already fork-proven for `create()` per `frontend/src/lib/launcher/README.md` L61-95), implement the Quoter min-out + UniversalRouter command build for `swapCall` (README L30-35), and fork-verify create+buy end-to-end against a live auction pool (blastapi as the anvil archive RPC — the only free one that works). This also unblocks Phase 4.4's `useOneClickLaunchBuy` wire-vs-delete decision.

---

## Phase 2 — Data layer (replaces "Indexer unblock") **[v1-WRONG on cause and critical path]**

Verified: the four un-gated surfaces (NFTLending, NFTPoolFactory, LaunchpadV2/DropV2, PremiumAccess) have zero indexing — because of a deliberate 2026-05-24 MVP scope cut (AUDIT M5), not the Ponder type-recursion ceiling (a separate, real, possibly-fixed-upstream risk; check via PR #94). Bigger: the indexer has **never been deployed**, has **no hosting config** and **no frontend consumer** — hosting + consumer wiring dominate the critical path, not handlers. The LaunchPage.tsx:157 baselines feed from **GeckoTerminal new_pools** (adapter `discovery.ts` already written + fixture-tested), not launchpad indexing.

**Track 2A — free data spine (ships now, $0):**
1. Supabase migration `<next free number>_protocol_events.sql` (ground rule 10): `protocol_events` (PK (tx_hash, log_index) for idempotent upserts) + `child_contracts` registry; 008-style role grants.
2. `scripts/sweep-protocol-logs.mjs`: Etherscan v2 `getLogs` (key in `?apikey=`, never Bearer) per live address, start blocks from the 07-16 broadcast files; 15-block confirmation lag; `--resweep` repair flag.
3. Event-only ABI generation as a SIBLING of `frontend/scripts/extract-missing-abis.mjs` (ground rule 9). Event-name corrections vs v1: "liquidated" = `DefaultClaimed`, "loan created" = `LoanAccepted`, DropV2 cancel = `SaleCancelledEvent` (+ `Refunded`).
4. Serving routes folded into `v1/index.js`: `protocol-events` (History/Activity), `leaderboard` aggregates (SQL views, not per-request scans).
5. LaunchPage baselines via the GeckoTerminal new_pools adapter behind the existing aggregator catchall (zero new functions).
6. `.github/workflows/event-sweep.yml`, cron `*/15`. **Fail-safe required:** first step checks secrets and exits 0 green with "sweep disabled — secrets not configured" (or ship `workflow_dispatch`-only and make the cron trigger part of gate G1) — scheduled workflows run on the default branch (mvp-launch) and would otherwise go chronically red before the operator adds keys. GH Actions timing is best-effort; UI copy says "minutes-to-hours", never "real-time".
7. Extend `docs/DUNE_QUERIES.md` with the four new surfaces (topic0 + queries in the existing style).

**Track 2B — Ponder (code now, deploy later):** write the four subscriptions + schema + handlers against the verified events (factory() on `PoolCreated.pool` and both `CollectionCreated` variants; start blocks from the 07-16 broadcasts); run `tsc --noEmit` and apply the `ponder.on as any` workaround ONLY if the recursion error actually appears. **Deployment gates on operator decisions:** G1 ($0) sweep secrets + cron enable; G2 ($0) free Dune account + embed; G3 ($5-25/mo, deferred) hosted Ponder (host + Postgres + authed RPC + rate-limited proxy per the in-file mandate). Decide up front: ONE canonical store per surface; atomic cutover if G3 lands.

**Phase 7B gate rewrite:** 7B.2 protocol analytics ships NOW (direct-read stat tiles + Dune embeds after G2; time-series self-gates); 7B.1 creator dashboards + 7B.4 pool analytics gate on **G1 OR G3**; 7B.3 grant transparency gates on the grants feature un-gating.

---

## Phase 3 — Repo hygiene + doc truth (corrected)

1. Root bloat — **explicit paths only, never glob pathspecs** (git pathspecs recurse): `git rm` the tracked set: `CODEBASE_FULL.txt`, `CODEBASE_OVERVIEW.txt` (delete, don't regenerate — README + docs/ARCHITECTURE.md are the maintained sources), `tegridy_100_findings_unpacked/`, and the 12 tracked root images (`FXLAxKHWAAApvxz.png`, `FojAU1PaAAA2EfG.jpg`, `G27matobYAE_iFa.jpg`, `G86hUvAagAMyFOu.jpg`, `G8RpIY5a4AMjIYe.jpg`, `Gn5CMrmbEAAbmG1.jpg`, `GtNK4vzbMAMYJ5L.jpg`, `Gu4WJc1W0AECDIm.jpg`, `GvcaxNeWwAA_-7e.jpg`, `GzLhcj9bEAE89lL.jpg`, `HCc30jXbAAEPdIg.jpg`, `azzuzu.jpg`). Plain-`rm` (no commit needed — gitignored) the 7 untracked root avif: `1.avif 3.avif 7.avif 28.avif 53.avif 58.avif 61.avif`. **⚠ Identical basenames under `frontend/public/splash/new/` are LIVE app art — do not touch them** (preserve-art hard rule).
2. **[v1-STALE] Stale scripts: already done — no action.** WireV2/Verify/DeployTegridyRouter deleted (10e1dcc, 87b47da). **Do NOT delete `DeployVoteIncentives.s.sol`** — env-read (e9b06b7), hardened (a01527c), referenced by `deploy-gated.sh:98`, executed the live 07-16 deploy. Optionally annotate scan8's verdict.md as resolved.
3. `.skip-broken/`: **all 6 files → DELETE** (verified: active suites supersede the test files; R013's central scenario — feeTo=0 lifecycle — is unreachable on the real factory; the deploy scripts are dead, incl. the unit-confused DeployFinal.s.sol). One-line CHANGELOG note. No coverage lost.
4. **[v1-WRONG] `ethers@6` stays in `dependencies`.** Live client-runtime code on the Tradermigos buy/offer/orderbook/SIWE/ENS paths via dynamic `import('ethers')` (7 UI components) — already correctly code-split. Optional replacement item: assert no STATIC ethers import leaks into an eager chunk.
5. NEXT_SESSION.md (2026-04-25, ~60% superseded): rewrite with the verified fold-forward list (indexer expansion, Anvil E2E fixture, nonce-CSP note, DISCLAIMER.md, Dune, Tenderly, Immunefi listing → AUDITS.md, branch protection, docs/TEAM.md); mark §1a/1b/1c superseded. **[NEW] Fix `FUNDING.yml` — it still invites donations to the compromised-era wallet.**
6. **[v1-STALE] `docs/INCIDENT_RESPONSE.md` already exists** (~7 weeks old; covers pause-guardian tree / who-calls-what / comms template) — verify its contact tree, don't rewrite. Only `DISCLAIMER.md` is missing: write it as a SHORT pointer/consolidation doc (mirror TermsPage §6 + link /terms, /risks, SECURITY.md, README's disclaimer) — no new legal prose to drift.
7. **[v1-WRONG] Immunefi:** README is clean. The one dead link is **`AUDITS.md:178`** — replace with SECURITY.md:11's honest interim wording (or drop the bullet until listed). Optional: note in `solana/tegridy-amm/SECURITY.md` that the vendored Raydium bounty text doesn't cover this repo.

---

## Phase 4 — Tests + v4-family disposition (replaces blanket "write tests") **[v1-WRONG]**

Verified: 3 of the 4 "untested" contracts already have house-style suites — in `contracts/test/v4/`, which **no CI slice ever runs**. All hook-family contracts + NativeBuyRouter are undeployed (NativeBuyRouter is an explicit DRAFT with the Spartan-M2 refund-misbooking documented at source).
1. **TegridyBoostedLPStaker (KEEP — only family member on a live product path, the afterlife flagship):** RELOCATE its existing test section out of `test/v4/TegridyV4Hook.t.sol` into `contracts/test/Audit_V4BoostedLPStaker.t.sol` (CI-reachable per ground rule 6), de-hook the scaffold (sorted currencies, tickSpacing 60), extend coverage there. Verify the CI slice log lists it. **Before deleting DeployV4.s.sol (next item), extract a minimal `DeployBoostedLPStaker.s.sol`** — it's the staker's only deploy script and the afterlife path may need it.
2. **Hook trio (TegridyV4Hook + TegridyV4HookAdmin + TegridyV4SwapRouter): DELETE — operator confirm first** (killed by the 2026-07-22 fork-Clanker decision). Removal list: the 3 sources; `test/v4/TegridyV4Hook.t.sol` (after the staker salvage); `test/v4/Audit20260712_POLIsolation.t.sol` (hook-only); DeployV4/VerifyV4 scripts; stale LAUNCHER_STRATEGY.md:66/100/168 "move under TegridyV4Hook" copy; README.md:74 contract-table row (drop the two dead names, keep BoostedLPStaker); SAFE_REHOME_RUNBOOK.md:118/130/142 checklist entries (mark N/A); docs/SECURITY_TOOLING.md:205; LAUNCHER_LIQUIDITY_AND_UX_RESEARCH.md mention; the `contracts/V4_*.md` hook-family docs (delete or stamp superseded — EXCEPT `V4_BOOSTED_LP_HOOK_DESIGN.md`, which mixes live staker design with dead hook content: TRIM, don't delete). **Final authoritative step: repo-wide grep for `TegridyV4Hook|TegridyV4SwapRouter|TegridyV4HookAdmin` must return zero live references** — the list above is the map, the grep is the territory.
3. **TegridyNativeBuyRouter: KEEP-AS-DRAFT.** No unit suite now — its own header mandates a mainnet-FORK suite (incl. a Seaport refund order) AFTER fixing M2. Fold the M2 fix into the `8f72bed` batch; fork tests need an RPC-secret CI job or an operator-run-only note.
4. **Ghost hooks [v1-WRONG on the named suspect]:** `useAddLiquidity` is wired end-to-end (LiquidityTab → TradePage). Real zero-importer ghosts: `useAutoRefreshBoost` (embodies audit F-7 — wire into the farm page or operator-decides delete), `useOneClickStake`, `useOneClickLaunchBuy` (also blocked on Phase L). Wire-vs-delete = operator decision per hook; vitest via wagmi-mocks for whatever gets wired.
5. E2E: implement the ANVIL_BACKEND 4-step plan verbatim from `frontend/e2e/fixtures/wallet.ts:191-208`, substituting a live fork RPC (publicnode) for the dead llamarpc example.
6. Small fix: `frontend/src/lib/launcher/afterlife.ts:16-17` stale header comment (contradicts the wired posm at :94-98).

---

## Phase 5 — Monitoring-first keeper (replaces paid-automation framing) **[v1-WRONG]**

Verified baseline: every fee accumulator is zero and `epochCount=0` since deploy — a keeper would have had nothing to do in 7 weeks. `recoverCallerCredit` is a refund-rescue, NOT a caller-incentive precedent (none exists in the lineage). DCA is NOT keeper-able (client-side keys; nothing server-visible to execute) — the honest hands-off route is CoW TWAP/conditional orders, tracked under D.16 below. TWAP upkeep is blocked on two operator actions (DeepenLP + timelocked floor-lower to 1 WETH), then a 4× bootstrap.
1. NOW ($0): extend `synthetic-monitor.yml` (or a sibling on the same */30 cron, with the same missing-secrets fail-safe as Phase 2A.6) with **state-conditional** curl-JSON-RPC probes: fee-staleness alert only if `accumulatedETHFees ≥ threshold` (2 consecutive breaches); epoch-gap alert only if distributable balance ≥ MIN_DISTRIBUTE (1 ETH) AND time-gap; TWAP-floor-clearance alert (reserves clear floor but observations stale). Never a naive "no epoch push in N days" — it fires forever against a zero-revenue rail.
2. One-page operator runbook with exact cast commands for the permissionless calls (`distributeFeesToStakers`; `convertTokenFeesToETH` — noting owner-only first-conversion bootstrap per token, owner-only multi-hop, 1/hr throttle).
3. Chainlink/Gelato: premature (recurring cost against zero revenue). A caller-incentive is a NEW contract surface — only ever as a forked battle-tested pattern in the `8f72bed` batch, and only when revenue makes automation worth paying for. The keeper doc must cite TegridyTWAP.sol M1 (a single incentivized keeper = the ratchet's sole-updater actor).

---

## Phase 6 — TegridyRestaking EIP-170 split (unchanged, gated on operator go)

Verified: design doc matches; measured 26,760 B → gap 2,184 B; the sister-move estimate (~2.5 KB) leaves ~300 B nominal margin and prior extractions landed 2-3× below estimate — the design's §5.6 escape hatch matters. Job ends at green tests + sizes + re-audit-ready diff. Deploy gated on external re-audit. (Phase 7 does not depend on this.)

---

## Phase 7 — Wave 1, distribution-first (replaces v1's 7A ordering) **[v1 ordering REFUTED]**

The binding constraint is DISTRIBUTION, not retention/monetization of near-zero traffic. Build order (W1-0 feeds W1-3/4/5; W1-1/2/3/4 independent after W1-0; W1-5 is the spine consumed by W1-6 + Wave-1.5):

- **W1-0 (S-M) Server-side detection port:** `frontend/api/_lib/detection.js` — plain-JS port of only the needed core (the detection math is pure TS but the adapters' fetch layer is browser-bound; api/ is plain JS — no src/*.ts imports). Vitest PARITY test vs the TS core on shared fixtures.
- **W1-1 (M) Token detail pages** `/token/:chain/:address`: scanner verdict + fact-sheet/afterlife (launched-here only, first-class empty states) + deployer-reputation link + (after W1-5) Watch button. **[v1-WRONG]** PriceChart is single-token today (TOWELI pool constants at module level) — port-and-parameterize: pool-address prop + GeckoTerminal token→top-pool lookup (already in CSP), self-gate "no pool found". **Deployer-link data path [restored]:** add `getcontractcreation` to `ALLOWED_ACTIONS` in `frontend/api/etherscan.js:66` (one line; `module=contract` already admitted) — or scope the link to launched-here tokens where the deployer is already known. **Linkify every existing token mention** (scanner results, launch explorer, swap token-select) to `/token/...` — that's what makes the page discoverable.
- **W1-2 (M) Shareable scan cards + OG unfurls:** card on the RAW-CANVAS 1200×630 `ShareCard.jsx` pattern (**not** html2canvas — v1 conflated them). Unfurl mechanism — **decide up front, one mechanism per path prefix:** preferred = extend `frontend/middleware.js`'s matcher (currently `"/nakamigos/:path*"` only) to `['/nakamigos/:path*','/token/:path*']` and serve the token OG stub from the same edge middleware (house pattern, one bot list, zero vercel.json changes, /nakamigos untouched). If vercel.json is chosen instead, the bot-UA rewrite MUST be inserted BEFORE the SPA catch-all rewrite or it never matches; `og` route in the catchall must set `text/html` explicitly and stay scoped to `/token/*`.
- **W1-3 (M) Public scanner API + embeddable surface + launch deep links** (the settled #1 lever's v1): `?route=verdict` JSON in the catchall, keyless v1 (keys = Premium wave), existing Upstash limits + caching; embed snippet; prefill deep links into the launch wizard (clamp all params against policy; the gate recomputes as normal). **Write `docs/API_PUBLIC.md`** (verdict + erc20scan routes, embed snippet, deep-link params; full SDK deferred).
- **W1-4 (S-M) Telegram bot stage 1 (stateless):** `?route=telegram` webhook in the catchall; reject on `X-Telegram-Bot-Api-Secret-Token` mismatch; `/scan <addr>` via W1-0; every reply deep-links to W1-1 pages.
- **W1-5 (M-L) Watch & alerts spine:** migration `<next free number>_watches_and_alerts.sql` — **channel-aware from day one** (`channel: wallet|telegram`, subject = lower(wallet) or chat_id) + `alert_events`; RLS per 001/004 + 008 grants (ground rule 10). Sweep via `.github/workflows/watch-sweep.yml` (GH Actions — Vercel Hobby cron is daily-only; same missing-secrets fail-safe), diffing hard facts only per chain: top-holder threshold crossings (both chains), Solana mint/freeze flips, new-deploy-by-watched-deployer; drop "ETH LP unlock windows" until a real data source exists. Free cap 5 watches server-side; premium 50 via a server eth_call helper (reuse `seaport-verify.js`'s ethCall; cache 60-300s; **fail CLOSED to the free cap**). Push via the existing event-agnostic `sendPushToWallet`.
- **W1-6 (S) Telegram stage 2:** `/watch` `/unwatch` rows keyed by chat_id; sweep delivery via sendMessage with deep links.
- **Wave-1.5 (each S-M):** NotificationCenter port (from `frontend/src/nakamigos/components/NotificationCenter.jsx`, reads alert_events); PWA InstallPrompt port (from the nakamigos component); **LLM Towelie flag-gated default-OFF** — route disabled unless `ANTHROPIC_API_KEY` AND `TOWELIE_LLM_ENABLED=1`; keyword bank stays tier-1; **safe-design (mandatory):** its OWN rate-limiter identifier (3-5 req/min/IP + per-wallet daily cap — never the shared v1 budget), a global daily request ceiling as a hard spend bound, small max_tokens, response caching, and the grounding/guardrail system prompt: protocol Q&A only, Towelie's voice, NEVER trading/financial advice, NEVER state a number the context doesn't contain (answer "don't know, check /contracts"), grounded on a build-time `towelieContext.md` digest of README+TOKENOMICS+FAQ; graceful-degrade e2e (keyword-bank fallback, never an error). **`lib/towelieInsights.ts` is CREATE-NEW** (does not exist): pure rules evaluated on dashboard/farm mount → `useTowelie().say()` queue with dedup keys (unclaimed yield > threshold, lock expiring ≤7d, boost decayed, alert fired), fully vitest-covered — free, no API, ship any time.
- **Premium rebundle** follows W1-3/W1-5 (API-keys migration next-free-number, higher caps, bulk scans; rewrite `ACTIVE_BENEFITS` truthfully; keep 3× points).

**Wave 2** per the Phase-2 gate rewrite above.

### Roadmap items corrected/retired **[strategy verdicts]**
- **A.1 "graduation to own venue" — RETIRED as framed:** fees do NOT stop at graduation (EVM: 15% of graduated-pool LP fees stream to stakers via StreamableFeesLocker; SOL: perpetual DAMM-v2 partner claim to the Squads vault). Own-venue stays Wave-3+/gated = fork Clanker v4, never the bespoke hook.
- **A.2 vesting/LP-lock vaults — SPLIT:** launcher tokens = already shipped (Doppler vesting + lock + fact-sheet gate checks); external-token lock vaults = audit-gated custody product, later, verbatim-fork only.
- **A.4 anti-snipe — DONE** (both chains, incl. the simulator snipe test); residual = fee decay on graduated pools, already specced in LAUNCHER_STRATEGY.
- **A.6 generative-art lane — RETAG:** no Art-Blocks hook exists in-repo (DropV2 is URI-only; VORTEX is a loading animation). Either 🔴 contract work, or an honest 🟢 v0 (off-chain deterministic renderer, seed on-chain, labeled as such).
- **7A.4 tier-priced launch fees — CONFIRMED buildable now:** the EVM fee constitution is client-passed per launch (flex the 1500-bps stakers line by gate tier; sum=10000; Doppler line stays); Solana = per-config-key (tier-keyed configs; config creation is signed by config keypair + payer, not the Squads vault). UI caveat: direct-to-Doppler launches bypass integrator pricing (inherent to integrator fees).
- **B.12 EAS reputation — facts-only:** attest observed on-chain facts (revocable, timestamped); NEVER a composite score or "verified" language (endorsement-liability posture the strategy killed).
- **D.16 DCA/TWAP — ship (a) only:** surface the existing `useCowTwap`/TwapOrderPanel with Safe upsell after money-path QA; (b) ERC-1271 alternatives = watch item; (c) keeper-DCA is mis-grounded.
- **D.18 bridge tab — CONFIRMED, mostly-UI, deferred-visible:** LiFi already proxied; extensions = `/v1/status` in the same provider allowlist + destination-chain awareness. Constraints: never bridge TOWELI; no TOWELI on Solana.
- **E.21 position market — interim OTC board only, with a buyer-eligibility pre-check** (`userTokenId[buyer]==0` + 24h elapsed — the single-position-per-EOA guard guts the AMM buy side; AMM listing needs a contract change in the redeploy batch).
- **H.33 seasons-that-pay — retag 🟣+⚙️:** needs server-side derivation (indexer) + on-chain-slice-only formula (exclude streaks/visits) + realized-revenue funding; not ⚙️-ready today.
- **#40 un-gate Meteora DBC — DONE [v1-STALE]** (Solana launcher live 2026-07-22).
- **Un-assessed carry-forward:** #19, #24–27, #29, #31, #39, #41, #43–44, #46 received no verification verdict — they carry forward visible-but-unverified; verify each premise before building.

---

## Operator-only (remind, don't attempt)

- Safe rebuild → re-home sequence (SAFE_REHOME_RUNBOOK.md; incl. NFTPoolFactory's 0xA360-owned special case). Verified on-chain 2026-07-28: all stale pendingOwner windows are CLOSED — nothing time-sensitive; planned work at the operator's pace.
- DeepenLP + BootstrapTWAP + floor-lower (fold the TWAP redeploy with the ratchet fix — already written on `8f72bed` — into this step).
- Phase-2 gates G1/G2/G3 (sweep secrets + cron, Dune account, Ponder hosting $).
- Bundle-listing go-live: apply migration 012 → server env → client flag → live QA a real 2-NFT bundle → sign-off (design law: bundles NEVER in per-token gallery/floor).
- Hook-trio deletion confirm (Phase 4.2); ghost-hook wire-vs-delete decisions (Phase 4.4); emissions taper/refill policy (Phase E).
- Any `--broadcast`, key handling, Vercel Pro, Immunefi listing, Tenderly, audit-firm engagement, Base L2 go/no-go, Solana AMM mainnet.

## Deferred backlog (kept visible)

V2_ROADMAP **#5 (dead penalty-code removal, ~6,300 gas/tx) + #6 (Factory timelock)** — verify still-pending in Phase 0.5, then fold into the `8f72bed` batch. Launchpad graduation extras beyond the captured annuity; external lock vaults; position secondary market (contract leg); auto-compound; LP zapper; Premium discount hook + tiers; IVotes delegation; seasons payouts; Tegridy Wars groundwork; Base L2; nonce-CSP; Nakamigos route-split; plus the un-assessed roadmap carry-forward list above.

---

**Sequencing: 0 → 1 → E → 3 → 4 → 7 (Wave 1, incl. L any time) → 2 (2A anytime after 0; 2B code anytime, deploy on gates) → 5 → 7 (Wave 2), with 6 only on explicit operator go. Stop, summarize, and WAIT for operator go after each phase — mandatory after Phase 0 and before any deletion or contract-source phase.**
