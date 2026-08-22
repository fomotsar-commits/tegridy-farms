# What still needs finishing or cleaning up

Inventory of 352 items across 12 tree regions + a completeness critic, 2026-08-13.
18 were flagged as deliberate and are listed last, not as debt.


## HALF-BUILT — 65 items (17 need the operator)

- **TegridyFeeExecutorRouter is fully built and tested with zero integration on any side** `[L]` **[OPERATOR]**
  - `contracts/src/TegridyFeeExecutorRouter.sol`
  - This is a LlamaSwap-routed fee skimmer — a revenue leg — sitting complete and shelved with no record of whether it was rejected or just forgotten. Either wire it (deploy + constant + ABI + a swap surface that routes through it) or delete the contract, its suite, and its script. Leaving it is 589 lines of audited-looking surface no one owns.
  - *evidence:* contracts/src/TegridyFeeExecutorRouter.sol is 589 lines, 12,791 B, with a dedicated 25-assertion suite (contracts/test/TegridyFeeExecutorRouter.t.sol) and a working deploy script (contracts/script/DeployFeeExecutorRouter.s.sol). It has never been deployed (absent from every broadcast receipt, from addresses.json, and from CONTRACTS.md). Its own script prints at :69 "Set FEE_EXECUTOR_ROUTER_ADDRESS

- **An 838-finding frontend remediation backlog is committed to the repo and indexed by nothing — 121 of its items need an owner decision** `[L]` **[OPERATOR]**
  - `frontend/REMEDIATION_PLAN.md`
  - This is a second, larger, better-structured work order than WORKORDER_V2.md, and no inventory pass has ever looked at it — twelve agents enumerated the code it describes and none opened it. The 121 `product-decision` and 14 `operator-action` items are by construction things only the owner can close, and they have been sitting for two months with no register anywhere in the canonical pending list. First action is triage, not execution: reconcile the 625 `fix-now` items against what the 08-12/13 wave already landed, then either fold the survivors into WORKORDER_V2.md or add a status banner and index it from AUDITS.md.
  - *evidence:* 34 tracked files, 1.5 MB, all landed in one commit dated 2026-06-13 (`docs(frontend): 2026-06 full frontend audit + remediation plan`): REMEDIATION_PLAN.md, AUDIT_REPORT_{MAIN,CROSS,NAKA}.md, AUDIT_FINDINGS_CONSOLIDATED.json, plan/g01..g14.md, plan_input/g01..g14.json + _manifest.json. Its own legend (lines 14-22) counts 838 findings: 625 `fix-now`, 121 `product-decision`, 57 duplicate, 16 `redepl

- **indexer/ is 1,832 LOC with no CI job, no consumer, and no deploy config — its fate is the open question, not its code** `[L]` **[OPERATOR]**
  - `indexer/`
  - The pause is a documented, correct holding pattern — but nothing has moved it in six weeks, and every item below is maintenance on code no gate protects. The honest choice is binary: wire the CI job (item below makes that cheap) and give the frontend a read path, or delete the directory and drop the dependabot block. Continuing to carry it costs a little every audit and buys nothing.
  - *evidence:* `git grep -ln indexer -- .github/` matches only dependabot.yml. `git grep -i -E "42069|ponder|INDEXER_URL" -- . ':!indexer/'` finds no runtime reference — only prose in audit archives; the frontend never queries GraphQL. There is no Dockerfile, fly/railway/render config or Procfile in indexer/. .github/dependabot.yml:62-75 paused updates to limit 0 and states the reason plainly, closing four PRs o

- **Own-curve trade path: buyIx/sellIx/createLaunchIx are built, tested, and callable from nothing** `[L]`
  - `frontend/src/lib/launcher/solana/curve/ix.ts:247`
  - Our own venue is deployed and 100% of its trade fees are ours, and no surface can create a launch on it, buy, or sell. rpc.ts:16-28 justifies the write seam being absent FROM THAT FILE (read vs signing threat models) and cites graduation being blocked — but graduation blocks migrate only; nothing blocks create/buy/sell. 26 KB of byte-tested encoders are one write client away from being reachable. If the decision is to keep the curve dark, say so in ix.ts's header the way covenant.ts does, and stop mounting LaunchGate on a page that cannot launch.
  - *evidence:* `grep -rn '\bbuyIx\b|\bsellIx\b|\bcreateLaunchIx\b|associatedTokenAddress|MIGRATE_COMPUTE_UNITS|CurveMode' frontend/src frontend/scripts frontend/api` returns only frontend/src/lib/launcher/solana/curve/ix.ts (:247, :272, :310, :186, :66, :74) and ix.test.ts. The operator CLI does not use them either — frontend/scripts/tegridy-launch-operator.mjs's command table (:1231-1247) is status/derive/check

- **heat/certification.ts is an orphan module — no importer, no test, and no Garden lane to render it** `[L]` **[OPERATOR]**
  - `frontend/src/lib/heat/certification.ts:39`
  - This is deliberately staged against a spec ("THE VENUE NEVER SELF-DECLARES CERTIFICATION") and the fail-closed design is correct — but as shipped it is 85 lines that cannot execute and cannot regress, because no test covers it either. The header says the Garden lane "shows its promise and stays dark", yet no lane component exists to show anything, so setting VITE_ISLAND_CERTIFICATION_URL would change nothing visible. Worth deciding explicitly: build the lane (L, and gated on the island publishing an endpoint), or park the file with a one-line note that it awaits a surface (S).
  - *evidence:* Ripgrep for `certification|isCertified` across frontend/src returns: certification.ts itself; heatGateConfig.ts:65-71 (its own doc comment + `certificationEndpoint()`); launcher/covenant.ts:63,67 and launcher/birthRecord.ts:5 (prose comments only). No `import` of './certification' anywhere. There is no heat/certification.test.ts (heat/ has gateAudit, heatClient, heatOracle, launchGate tests). So t

- **data/rarity.json is an empty placeholder and its generator script does not exist — the pre-computed rarity path has never run** `[L]`
  - `frontend/src/nakamigos/data/rarity.json`
  - Rarity is the spine of this marketplace — the Sniper tab, Traits tab, rank badges, Modal fair-value, ShareCard tiers and constants.rankTier all key off it — and for the 20,000-token flagship collection it resolves from ~40 tokens. Writing the generator once turns six surfaces from suppressed-or-approximate into exact, with no other code change.
  - *evidence:* `cat frontend/src/nakamigos/data/rarity.json` → `{"generatedAt": null, "totalTokens": 0, "traitCount": 0, "rarity": {}}` (81 bytes). api.js:841 `const _precomputed = precomputedRarity?.totalTokens > 0 ? precomputedRarity.rarity : null;` → permanently null. api.js:838 comment says "generated by scripts/compute-rarity.mjs" but `grep -rn 'compute-rarity'` over the whole repo returns exactly ONE hit —

- **Four fully-built Community section components (~2,500 lines) can never render — the addresses that gate them are still 0x0** `[L]` **[OPERATOR]**
  - `frontend/src/pages/CommunityPage.tsx:266-292`
  - This is the single largest block of shipped-but-unreachable UI in the area. The 2026-08-12 comment block (lines 24-46) is explicit that the remaining work is QA against the live deployments, not a build — so the code is finished and the gate is a decision, not a dependency.
  - *evidence:* frontend/src/lib/constants.ts:54,58,60,65 hold 0x0 for GAUGE_CONTROLLER/COMMUNITY_GRANTS/MEME_BOUNTY_BOARD/VOTE_INCENTIVES, so all four `isDeployed(...)` ternaries at CommunityPage.tsx:266,272,278,287 always take the FeatureNotDeployed arm. `wc -l`: GrantsSection 330+, BountiesSection 400+, VoteIncentivesSection 1000+, GaugeVoting 550+. Side effect: `components/ui/SafeText.tsx`'s ONLY two consumer

- **The whole TypeScript curve core is constant-product-only — it cannot represent, decode, price or plot a Segmented launch** `[L]`
  - `frontend/src/lib/launcher/solana/curve/math.ts:495-604, geometry.ts:124, program.ts:379-403`
  - The program has shipped two curve modes since #277 and the client knows about one. If a mode-1 launch is ever created, every quote, every chart point and every progress number renders the wrong pricing model with no error — the precise failure OWN_CURVE_FRONTEND_CONTRACT.md was written to prevent ('a UI that quotes differently than the program executes takes money from users on every trade'). Today it is latent only because item 5 means nothing can create one.
  - *evidence:* `grep -n '^export function' math.ts` returns feeUp, quoteBuy, quoteSell, lamportsUntilTarget, maxReachableRealSol, isqrt, graduationPriceRatioBps, continuityTarget, effectiveReserves, raiseCeiling, quoteBuyOnCurve, quoteSellOnCurve, applySlippage — no segmented anything. `quoteBuyOnCurve` (math.ts:495) unconditionally calls `effectiveReserves` + `quoteBuy`, the virtual-reserve constant product, wi

- **record-evm.js points at a selector-drift guard test that does not exist** `[M]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/record-evm.js:39`
  - Seven hand-typed selectors (lines 47-55) feed the birth certificate the island stores permanently, and a wrong one returns 0x -> decodes to null -> publishes as a plausible `unread`. The instruction "never add a selector without adding it to that test" is unfollowable, and the warning reads as if a guard is in place.
  - *evidence:* _lib/record-evm.js:39-45 says: "[warning] `record-evm.selectors.test.js` re-derives every one of these with viem's `toFunctionSelector` from collector.ts's TOKEN_READER_ABI and ourLaunches.ts's AIRLOCK_GET_ASSET_DATA, then regexes these literals out of this file and compares... Never add a selector here without adding it to that test." `grep -rn 'record-evm.selectors' <repo>` returns only that com

- **/api/v1 is a shipped "Developer API" with six of seven routes uncalled, no documentation anywhere, and a CORS header advertising an API key it never reads** `[M]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/v1/index.js:1`
  - It spends one of the 12 function slots and burns the Alchemy and OpenSea keys for anyone who finds it, to serve six routes nobody has been told about. Needs a product decision, not a patch: either publish it (docs plus the X-API-Key auth the CORS header already promises) or cut it back to the one route the scanner uses and reclaim the surface.
  - *evidence:* v1/index.js:1-11 bills itself as "DEVELOPER API v1 — NFT Data & Intelligence... Fills the Reservoir/SimpleHash gap" and lists routes collections, listings, floor, holders, activity, token. `grep -rn 'route=(collections|listings|floor|holders|activity|token|erc20scan)' frontend/src` returns exactly one hit: src/lib/scanner/ethereumAdapter.ts:220, calling `?route=erc20scan`. The other six have no ca

- **birthRecordFailure and recordUnreadFrom are exported, .d.ts-declared and tested, but no production code calls them — the record-render surface was never built** `[M]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/record-core.js:393`
  - A validator written specifically to stop a malformed record being rendered, fully tested, with no render to guard. The route serves the document correctly; the in-app half of "four consumers" is unbuilt. The certification lane specifically is deliberately dark (.env.example:113-118, VITE_ISLAND_CERTIFICATION_URL unset by design) and should be left alone; the missing piece is a plain record view.
  - *evidence:* `grep -rn 'birthRecordFailure|recordUnreadFrom' frontend/` finds them defined at _lib/record-core.js:393 and :57, declared at _lib/record-core.d.ts:142 and :137, and exercised only by src/lib/launcher/birthRecord.test.ts (lines 241-338, including a suite titled "birthRecordFailure — refuse to render a malformed twin"). Nothing else calls either. The reason is that the render surface does not exist

- **RESOLVED 2026-08-19 — TegridyRestaking is under EIP-170; the 36-selector diff was NOT the lever, and following it to completion would have landed 167 B OVER** `[M]`
  - `contracts/src/TegridyRestaking.sol`
  - Closed by the admin-sister split in `c749c933`: the host is **22,114 B**, **2,462 B under** the 24,576 B limit, with `TegridyRestakingAdmin` at 9,298 B and `RestakingMonitorView` at 2,275 B. The 36-selector list is no longer worth recovering and the orphaned worktree artifact can be left to prune — its own proven landing point was **24,743 B, which is 167 B OVER the limit**, so completing it would have left the contract undeployable and still needing a second lever. The lever that worked is the one the entry below dismissed: `docs/RESTAKING_EIP170_SPLIT_DESIGN.md`, now marked EXECUTED.
  - *evidence:* `forge build --sizes` in this worktree, 2026-08-19 — TegridyRestaking 22,114 B runtime / 2,462 B margin; TegridyRestakingAdmin 9,298 / 15,278; RestakingMonitorView 2,275 / 22,301. `contracts/src/TegridyRestakingAdmin.sol` (377 lines) holds all five propose/execute/cancel triplets, the four timelock keys and the 7-day residual-clear mapping; `contracts/src/lib/RestakingAdminLib.sol` is deleted; the host no longer inherits `TimelockAdmin` (`TegridyRestaking.sol:111`). `contracts/test/Audit_RestakingEIP170Size.t.sol` pins all three contracts under the limit, plus a conservative 24,000 B floor on the host. **Follow-up 1 CLOSED 2026-08-21:** `.github/workflows/contracts-ci.yml` now sets `OVER_EIP170_DEFERRED=""` and its size comments were re-measured against built artifacts, so a regression past 24,576 B fails the job instead of warning. **One follow-up remains:** §5.8 of the design doc (mandatory external re-audit) still gates any deploy.

- **RewardTriangle invariant harness documents a property (INV-CLAIMER-EXCLUSIVE) it does not implement** `[M]`
  - `contracts/test/invariants/MVPLaunch_RewardTriangleInvariants.t.sol:34`
  - This is exactly the overclaim the echidna file's header was corrected for. INV-CLAIMER-EXCLUSIVE is the C-1 finding's other half (only the tracked holder may drain a per-tokenId credit) and it is the one property here nothing else covers.
  - *evidence:* contracts/test/invariants/MVPLaunch_RewardTriangleInvariants.t.sol:27 opens "Properties asserted across 256 runs * 500 calls each:" and lists three: INV-PERTOKEN-LE-HOLDER (:29), INV-CLAIMER-EXCLUSIVE (:34), INV-PRINCIPAL-RECOVERABLE-CROSS (:43). The file declares exactly three `invariant_` functions — :111 invariant_perTokenIdNeverExceedsHolder, :141 invariant_principalRecoverableCrossContract, :

- **The oracle-unlock safety monitor has no runner — both its README and GOLIVE_CORELOOP prescribe a 5-minute cron that does not exist, and the auto-pause half it defers to was never built** `[M]` **[OPERATOR]**
  - `contracts/monitoring/arbLinkageMonitor.mjs`
  - This is the observable form of the load-bearing assumption behind the TWAP oracle, it is dependency-free and takes seconds to run, and it has been run by a human once, a month ago, at which point it already returned WARN. Given the native pool's subsequent state, running it today is the cheapest safety check in the repo. Two actions, separable: (a) pure code — wrap it in a scheduled workflow next to revenue-watch.yml, S; (b) operator — decide whether the auto-pause hook is built or the HALT just pages, M.
  - *evidence:* docs/GOLIVE_CORELOOP.md:117 — 'run it before B4 and on a 5-min cron'. contracts/monitoring/README.md gives the crontab line verbatim. There is no cron: the repo has exactly two scheduled workflows (revenue-watch.yml, registry-onchain.yml) and `grep -rln 'arbLinkageMonitor|PauseGuardian' scripts/ .github/ frontend/scripts/ contracts/monitoring` matches the monitor file and nothing else. The README'

- **The incident-response contact tree is eight cells of TBD, and the drill log directory it prescribes has never been created** `[M]` **[OPERATOR]**
  - `docs/INCIDENT_RESPONSE.md`
  - This is the document you open at T+0 with funds moving, and the first thing it asks you to do — reach the IC, reach the guardian — resolves to TBD. It is also the one gap on this list that is pure operator input and takes minutes: on a single-operator protocol the honest answer for most of those rows is your own name and channel, which is still infinitely better than TBD. The drill schedule is a bigger commitment; if quarterly tabletops are not going to happen, amend §7 to what will actually be done rather than leaving a prescription the log proves was never followed.
  - *evidence:* §9 Contact tree (line 253) — Incident Commander: 'TBD / TBD / Signal: TBD'; Comms Lead: same; PauseGuardian (hot key): 'TBD address'; Tenderly account owner: 'TBD'; Cloudflare / hosting: 'TBD'. Eight of ten data cells are TBD. §7 Drill schedule (line 195) opens 'A runbook that's never been exercised will fail when it's needed', prescribes a quarterly tabletop, a bi-annual live drill and a 'post-de

- **The Heat gate writes a 200-row audit ring that no code reads** `[M]`
  - `frontend/src/lib/heat/gateAudit.ts:82`
  - gate_decision_id is the id the island quotes back and the id a support thread will ask for (gateAudit.ts:31, notifyBirth.ts:95). findGateDecision(id) is the only way to resolve one, and it is unreachable — so the spec line 'any outcome replays against the instrument' is currently false on our side. A GateAuditPanel modelled on BirthQueuePanel next to it on AdminPage is the whole fix.
  - *evidence:* frontend/src/lib/heat/gateAudit.ts exports readGateAudit (:82), findGateDecision (:102) and clearGateAudit (:140). `grep -rn` across frontend/src for each returns only gateAudit.ts itself and gateAudit.test.ts — zero consumers. Only the write side is wired: recordGateDecision is called from launchGate.ts:109,129. The module header promises the opposite — "a wallet that declined analytics still des

- **migrateAsset/canMigrate — the EVM graduation trigger — repeat the exact bug their own header says they fixed** `[M]`
  - `frontend/src/lib/launcher/integratorFees.ts:192`
  - The module was written to close 'a live on-chain function with zero callers in the repo'; it closed that for fees and left it open for graduation. Graduation is what creates the StreamableFeesLocker position the whole post-graduation disclosure path depends on. canMigrate() is a pure simulation probe — a 'Graduate' affordance on IntegratorFeesPanel or LaunchTokenPage is a small addition on top of code that already exists and is tested.
  - *evidence:* frontend/src/lib/launcher/integratorFees.ts:192 (migrateAsset) and :213 (canMigrate). `grep -rn 'migrateAsset|canMigrate' frontend/src frontend/scripts frontend/api` returns only integratorFees.ts and integratorFees.test.ts:141-152. Their doc comment (:183-187) says "`Airlock.migrate` is permissionless … and until this module nothing in the repo called it, so our launches could sit un-migrated ind

- **One-click launch-buy: lib + hook complete, zero UI mounts it** `[M]`
  - `frontend/src/lib/launcher/launchBuy.ts:22`
  - This is a named TODO for real missing work — the SDK swap-encoding path that produces `swapCall` was never built, so the batch composer has nothing to compose and the slippage helper has nothing to slippage-protect. Everything downstream (hook, capability detection, sequential fallback) is finished and dark. Decide: build the Quoter/UR encoding leg, or delete launchBuy.ts + the hook and stop carrying a documented go-live item for a feature nobody can reach.
  - *evidence:* frontend/src/lib/launcher/launchBuy.ts is imported only by frontend/src/hooks/useOneClickLaunchBuy.ts:4, and `grep -rn 'useOneClickLaunchBuy' frontend/src --include=*.tsx` returns nothing — no component or page uses the hook. Within the lib, minOutFromQuote (launchBuy.ts:36) has zero callers of any kind outside launchBuy.test.ts. launchBuy.ts:22-25 carries the open work explicitly: "GO-LIVE TODO: 

- **token → position-tokenId resolution is still open, and the two V1 reads that DO work are unwired** `[M]`
  - `frontend/src/lib/launcher/lockerStream.ts:257`
  - Post-graduation re-attestation is architecturally complete except for one lookup key, and the half that does not need that key (per-beneficiary accrued claims, which proves the published split points at funded accounts) is written, tested, and called by nobody. Wiring readBeneficiaryClaim into LaunchTokenPage's disclosure block is independent of the tokenId problem. The tokenId problem itself is genuinely blocked and the header's reasoning is sound — do not guess the Lock event signature. Worth noting for later: once any launch graduates, enumerating PositionManager Transfer→locker yields the tokenId without needing that signature at all.
  - *evidence:* frontend/src/lib/launcher/lockerStream.ts:257 readMigrationStream is a permanent stub — it ignores its `_client` parameter and returns `{graduated:false, unsupported:true}` unconditionally, documented at :247-255 ("⛔ NOT IMPLEMENTED against V1, deliberately … requires a token -> position-tokenId mapping that is only recoverable from the locker's own Lock event"). But readLockPosition (:187) and re

- **Curve graduation-readiness: migrationEligibility + readRentFloors are written and read by nothing** `[M]` **[OPERATOR]**
  - `frontend/src/lib/launcher/solana/curve/read.ts:491`
  - The execution half is legitimately blocked (cp-swap AmmConfig does not exist; solana/tegridy-amm/MAINNET_RUNBOOK.md:211 reports the #281 admin::ID fix absent from the live binary, so it needs a program upgrade). The READ half is not blocked by anything and is exactly what a surface should render to explain the block honestly. Wire migrationEligibility + readRentFloors into CurveLaunchPage now; leave migrateToAmmIx dark until the AmmConfig exists.
  - *evidence:* frontend/src/lib/launcher/solana/curve/read.ts:491 migrationEligibility and :227 readRentFloors — `grep -rn` over frontend/src, frontend/scripts, frontend/api returns only read.ts and read.test.ts for both. migrateToAmmIx (curve/ix.ts:366) and MIGRATE_COMPUTE_UNITS (:66) likewise have no caller. The only graduation signal any surface shows is the boolean at pages/CurveLaunchPage.tsx:617 (`isAmmCon

- **lib/schemas/ — three zod validation modules with zero runtime wiring, and a plan doc that says they don't exist** `[M]`
  - `frontend/src/lib/schemas/aggregator.ts`
  - 308 lines of validation plus a 239-line test suite ship in the bundle and are exercised only by themselves — they give a false impression that the aggregator/GeckoTerminal/OpenSea boundaries are schema-validated when they are still hand-checked. And an audit plan on this branch records the opposite of the truth, so the next reader closes the item without acting.
  - *evidence:* `git ls-files src/lib/schemas` returns 4 tracked files (aggregator.ts, geckoTerminal.ts, opensea.ts, schemas.test.ts). Ripgrep for `from '.*schemas/'|lib/schemas` across all of frontend/ returns ZERO importers outside the module's own test — the only other hits are two audit-plan JSON/MD files. Every one of the 13 exported schemas (swapApiResponseSchema, odosResponseSchema, cowSwapResponseSchema, 

- **The Heat gate audit trail is written but has no read surface — the module's stated purpose is unfulfilled** `[M]`
  - `frontend/src/lib/heat/gateAudit.ts`
  - A DENIED wallet's decision row is persisted to localStorage under `tegridy.heat.gate.audit.v1` (200-row ring) and is unreachable from the UI. The one user the audit trail was written for — the one turned away — cannot see it. A small "why was I denied?" disclosure on the gate wall would close it.
  - *evidence:* gateAudit.ts:7-11 states the rationale: "a wallet that declined analytics still deserves to be able to ask 'what did the door read when it turned me away?' — that is the whole point of a door that explains itself." The write path is fully wired: launchGate.ts:119 calls `recordGateDecision`, and the resulting `row.id` rides through launchService.ts:593 / solana/submitLaunch.ts:251 → notifyBirth.ts:

- **The EIP-5792 one-click chain is complete through the hook layer and stops before any UI** `[M]` **[OPERATOR]**
  - `frontend/src/lib/stakeBatch.ts:12`
  - Four tested files and a documented user-visible win (one confirmation instead of two on approve+stake) sit one component change away from shipping. Finishing needs live-wallet QA on a 7702-capable wallet, hence operator-gated. If it is not being finished, correct stakeBatch.ts:12 so it stops describing a fallback that cannot happen.
  - *evidence:* lib/eip5792.ts (primitives, 103 lines, tested) → lib/stakeBatch.ts:15 `buildApproveStakeCalls` (tested) → hooks/useOneClickStake.ts:19 and hooks/useOneClickLaunchBuy.ts (both wire getWalletCapabilities/isAtomicBatchSupported/sendCalls/callsId). Ripgrep for `useOneClickStake|useOneClickLaunchBuy` outside hooks/useOneClick* returns only three prose comments (launchBuy.ts:18,65 and stakeBatch.ts:12) 

- **artConfig VIDEOS — a five-clip registry and 1.4 MB of shipped assets that nothing renders** `[M]`
  - `frontend/src/lib/artConfig.ts:227`
  - Added 2026-04-19 per the comment and never surfaced. Per the standing 'never remove art' rule the assets should stay — the open work is the surface (a clips row in the Gallery is the natural home), not a delete. Any surface needs the .mp4-only subset or a fallback: the registry itself flags that the three .mov files are iOS-captured and may not play everywhere.
  - *evidence:* artConfig.ts:227-233 exports `VIDEOS` with five entries; zero references anywhere (repo-wide ripgrep). The files exist and ship: public/videos/{vid01.mov 106 KB, vid02.mov 1.04 MB, vid03.mov 18 KB, vid04.mp4 164 KB, vid05.mp4 45 KB} = 1.4 MB, all dated Apr 20. Ripgrep for `<video` across src returns nothing but the comment at artConfig.ts:223 describing how to render them.

- **"NFT of the Week" voting: client functions, a proxy allowlist entry and four migrations' worth of RLS, with no UI anywhere** `[M]`
  - `frontend/src/nakamigos/lib/userdata.js`
  - A whole feature exists in the schema, the proxy allowlist and the client, and nowhere in the product. Every future RLS/migration pass has to keep reasoning about a `votes` table that nothing reads. Decide: build the tab, or delete the client functions and drop `votes` from ALLOWED_TABLES.
  - *evidence:* lib/userdata.js:309-407 exports getCurrentWeek, castVote, getWeekVotes, getUserVote (~100 lines with a full ISO-8601 week calculation and a localStorage fallback). `grep -rn 'castVote|getWeekVotes|getUserVote'` over frontend/src returns only their own definitions. The backend is real: frontend/api/supabase-proxy.js:54 ALLOWED_TABLES includes "votes"; supabase/migrations/001_siwe_auth_rls.sql:76-85

- **The Alerts tab's token picker is decorative — every alert compares against the collection floor** `[M]`
  - `frontend/src/nakamigos/components/PriceAlerts.jsx`
  - The UI teaches per-token alerting and the engine delivers per-collection. The honest disclosure is present only in the state the user is about to leave. Either drop the token picker to a plain label field, or wire per-token pricing from the listings set the tab could already receive.
  - *evidence:* PriceAlerts.jsx:32 `export function usePriceAlerts(_tokens = [], addToast, ...)` with the comment at :28-31 conceding "`_tokens` is unused but kept to preserve the positional signature". checkAlerts (PriceAlerts.jsx:119-131) sets `const price = floorPrice` for every alert regardless of alert.tokenId, so two alerts on different tokens at the same threshold fire identically. Yet the add-row (PriceAl

- **The AUDIT F-7 refreshBoost fix was built, announced in the changelog, and never wired to any component** `[M]`
  - `frontend/src/hooks/useAutoRefreshBoost.ts:21`
  - The gap the hook documents (lines 9-14: a wallet that stakes and THEN buys a JBAC keeps its no-boost effective balance until its next state-mutating call) is still open in the UI. The changelog entry makes it a false shipped-feature claim, not just missing work. Wiring is one banner in components/farm/LPFarmingSection.tsx.
  - *evidence:* `grep -rn 'refreshBoost|needsRefresh' pages components hooks` returns ZERO hits under pages/ or components/. hooks/useAutoRefreshBoost.ts is a complete hook, hooks/useLPFarming.ts:271-316 exposes `refreshBoost, // AUDIT F-7`, and pages/ChangelogPage.tsx:319 already ships the claim to users: "Frontend: refreshBoost auto-detection hook for users who acquire JBAC NFTs after staking". Nothing calls ei

- **Two EIP-5792 one-click hooks with pure tested cores have zero consumers** `[M]` **[OPERATOR]**
  - `frontend/src/hooks/useOneClickStake.ts:19`
  - An approve+stake batch is the single biggest friction cut available on FarmPage and it is 90% built. useOneClickStake.ts:15-17 says the remaining work is live-wallet QA with a smart-account/7702 wallet, so the missing piece is a button plus one QA session — not design.
  - *evidence:* `grep -rn useOneClickStake|useOneClickLaunchBuy --include=*.tsx` matches only the hook files and doc comments in lib/stakeBatch.ts:12 and lib/launcher/launchBuy.ts:18/65. Both pure cores (lib/stakeBatch.ts, lib/launcher/launchBuy.ts) have passing unit tests (lib/stakeBatch.test.ts, lib/eip5792.test.ts); neither hook is imported by FarmPage/StakingCard or LaunchPage.

- **Ethereum half of the registry chain-read asserts nothing — 39 entries, 0 expect blocks** `[M]`
  - `frontend/scripts/verify-addresses.mjs:434-452`
  - The daily job does 39 eth_getCode round-trips, prints 39 lines, and can only fail on the Solana side. A retired/self-destructed contract, or a registry entry pointing at an EOA where a contract should be, passes green. One `"expect":{"type":"contract"}` per entry arms it; the code path is already written and tested.
  - *evidence:* Walking frontend/scripts/addresses.json: solana entries=18 withExpect=18; ethereum entries=39 withExpect=0. verify-addresses.mjs:446-451 only fails on `expect.type === 'contract'` or `'eoa'`, and nothing sets either. The comment at 446-448 says so outright: "Ethereum entries carry no `expect` block today".

- **Echidna and Halmos property suites exist and are executed by no pipeline** `[M]`
  - `.github/contracts-test-slices.json:81-89`
  - Two written property suites that have never been executed by CI. The exclusion from the forge matrix is correct and well-reasoned; the gap is that no other home was ever built. A dispatch-only advisory workflow (crytic/echidna-action, or `pip install halmos` + one job) costs nothing on PRs and turns two dead files into a gate. Reasonable to defer deliberately — but then say so in the manifest, since the current reason implies a workflow that just needs a binary.
  - *evidence:* contracts/test/echidna/MVPLaunch_AMMEchidna.t.sol and contracts/test/halmos/MVPLaunch_HalmosSpecs.t.sol exist, plus contracts/echidna.config.yml. .github/contracts-test-slices.json:81-89 excludes both with the reason "Requires the `echidna` binary, which is not installed in this workflow" / same for halmos. Grep for echidna|halmos|medusa|certora across .github/ returns ONLY those two exclusion ent

- **decodeBondingCurve is still the pre-segmented layout — every real curve account decodes as 'bad-length'** `[M]`
  - `frontend/src/lib/launcher/solana/curve/program.ts:342,379-403,494-520`
  - This is the unfinished half of the #279 fix. program.ts:325-336 documents that exact bug for GlobalConfig ('sat at 186 after the segmented fields were added … made decodeGlobalConfig return bad-length for EVERY real account … Nothing caught it, because the unit tests build their fixtures from this same constant') and then leaves the sibling constant wrong on line 342. read.ts:214 turns it into `{kind:'undecodable', reason:'bad-length'}` for any curve that exists, and read.ts:233 quotes curve rent at 162 bytes.
  - *evidence:* `BONDING_CURVE_SIZE = 162` with the comment `8 + InitSpace(154)`. The program allocates `space = 8 + BondingCurve::INIT_SPACE` (lib.rs:1665). Summing state.rs:179-246 field by field: mint 32 + creator 32 + 8×u64 64 + mode 1 + sqrt_price_x64 16 + sqrt_price_start_x64 16 + segment_count 1 + [Segment;16] 512 + complete 1 + pool 32 + bump 1 = 708, so the account is 716 bytes. 162 is the size through `

- **Segmented mode is fully built on-chain and has never been published, exercised, or given a shape** `[M]` **[OPERATOR]**
  - `solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:598-623,687-707`
  - ~850 lines of Rust plus 1,495 lines of vendored CLMM math, a program instruction, a byte-tested TS builder (#284) and a CLI command exist to serve a mode that cannot currently be launched. Un-gating needs a chosen shape and a funded `global.authority` (see item 20), not more code.
  - *evidence:* `create_launch` mode 1 requires `g.segment_count > 0` (lib.rs:690) or it reverts InvalidParameter. `global.segment_count` is 0 — MAINNET_RUNBOOK §5b step 3 says 'global.segment_count is 0 until it runs'. `git ls-files | grep -i 'curve.json|segments.json'` returns nothing, so the repo contains no candidate shape. Both on-chain suites declare `const CURVE_MODE_CONSTANT_PRODUCT = 0` and comment 'Thes

- **`split_fee` has no TypeScript port and no differential vectors, contrary to its own spec** `[M]`
  - `solana/tegridy-amm/programs/tegridy-launch/CREATOR_FEE_SPEC.md:239-241,259`
  - `split_fee` decides how live mainnet trade fees divide between creator and protocol. The existing 3,815 vectors are still valid (only fee_up's visibility changed), so this is a gap rather than a rot — but the one function that moves money to a third party is the one with no cross-language proof.
  - *evidence:* §7 requires 'math.ts (add splitFee using **floor `/`, not `divCeil`**)' and 'curveVectors.fixture.ts + gen_curve_vectors.rs (regenerate with a SPLIT_FEE_VECTORS block)'; §8 requires 'SPLIT_FEE_VECTORS replayed against math.ts — kills a divCeil-for-floor transcription in TypeScript, which no Rust test can catch'. Repo-wide grep for `SPLIT_FEE_VECTORS` and `splitFee` matches only those three lines o

- **Nothing in CI regenerates or diffs the Rust-generated curve fixture, so the port's only proof can silently go stale** `[M]`
  - `solana/tegridy-amm/tools/gen_curve_vectors.rs:12-21`
  - The fixture is the single mechanism proving math.ts matches curve.rs, and its freshness depends entirely on someone remembering. It has already fallen one commit behind (item 9). A CI job that regenerates and diffs would make the drift impossible.
  - *evidence:* The generator is documented as a manual four-command sequence (cp, sed, diff, rustc). It is not a cargo target and `tools/` is not a workspace member. `grep -rn gen_curve_vectors` across workflows returns nothing. curveVectors.fixture.ts:48-49 records 'Generated 2026-08-01 against curve.rs at commit 3cc2b0ba, whose own #[cfg(test)] mod tests was run in the same session: 23 passed' — curve.rs now h

- **canonical-origin.test.js's list omits heat.js, births.js and record.js, and unlike its sibling it has no discovery guard** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/__tests__/canonical-origin.test.js:22`
  - Two guards over the same invariant, one self-healing and one not. A new origin-gated surface is caught by the parity test and silently skipped by the unowned-origin test. Both files pass today, so this is latent, not broken — the fix is to port the parity test's discovery walk (lines 91-99) into this file.
  - *evidence:* api/__tests__/canonical-origin.test.js:22-37 hardcodes ORIGIN_GATED with 14 entries; _lib/heat.js and _lib/births.js are absent even though both carry a five-entry prod allowlist (heat.js:59, births.js:58). The sibling api/__tests__/origin-allowlist-parity.test.js DOES list them (MIRRORS, lines 37-53) and additionally has a self-healing discovery guard at lines 91-99 that walks api/ and fails on a

- **/api/analytics occupies a function slot but the shipped bundle contains no endpoint to call it** `[S]` **[OPERATOR]**
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/analytics.js:20`
  - One of only 12 function slots, and one of only two spare, is held by an endpoint with no live caller and no destination table. Three legs (client env, service key, migration 013) must all land before it stores a row; two are known-missing and the third is unverified. Worth confirming before spending the last slot on something else.
  - *evidence:* analytics.js:20 says spending the slot took the count "from 10 to 11 of 12". The client half is src/lib/analytics.ts:14, `const ENDPOINT = import.meta.env.VITE_ANALYTICS_ENDPOINT`, and if unset the module logs to console and discards (analytics.js:6-9 describes exactly this history). Checked against the local build artifact frontend/dist (built 2026-08-12 23:33): `grep -rlo 'tegridy_session_id' di

- **verify-addresses.mjs cannot see constructor-created contracts, so rule 5's "closed world" has a hole** `[S]`
  - `frontend/scripts/verify-addresses.mjs`
  - The registry $comment says rule 5 exists because "a guard that can only ever discover addresses the frontend already imports cannot notice a missing entry". Reading only top-level CREATEs reproduces the same blind spot one level down: any factory that mints its template in the constructor is invisible. One extra loop over tx.additionalContracts closes it — and would immediately fail on the two templates, which is the point.
  - *evidence:* frontend/scripts/verify-addresses.mjs:277 — `if (tx.transactionType !== 'CREATE' && tx.transactionType !== 'CREATE2') continue;` — walks only top-level transactions. Foundry records contracts created by a deployed contract's own constructor under `tx.additionalContracts`, which the loop never reads. Both live templates were created that way: DeployLaunchpadV2 run-latest.json has additionalContract

- **DeploySwapFeeRouterUniswap.s.sol is a planned revenue leg that no doc or runbook references** `[S]` **[OPERATOR]**
  - `contracts/script/DeploySwapFeeRouterUniswap.s.sol`
  - The native pool is at ~$14 and the internal SwapFeeRouter has collected 3e12 wei ever; the Uniswap pair is where the volume actually is. This script is the difference between a fee rail on a dead pool and one on a live pool, and it is not on any checklist — it will simply never get run.
  - *evidence:* contracts/script/DeploySwapFeeRouterUniswap.s.sol deploys a second SwapFeeRouter + Admin wired to the real Uniswap V2 Router02, with all mainnet constants hardcoded and a MAINNET_ONLY chain guard. Its NatSpec explains the gap it closes: "the contract was designed for this … but DeployMVP wired it to the internal TegridyRouter." It has never been run (no broadcast dir) and `git grep DeploySwapFeeRo

- **The frontend's hand-written `restakers` ABI is missing the struct's sixth field** `[S]`
  - `frontend/src/lib/contracts.ts`
  - Ships the day restaking goes live, as a silent mis-decode rather than a revert. Worth fixing in the same change as the already-noted pendingTotal re-point so the restaking UI has one correctness pass rather than two.
  - *evidence:* contracts/src/TegridyRestaking.sol:141-153 declares `struct RestakeInfo { tokenId, positionAmount, boostedAmount, bonusDebt, depositTime, unsettledSnapshot }` behind `mapping(address => RestakeInfo) public restakers`, i.e. a 6-tuple return. contracts/src/RestakingMonitorView.sol:5 declares all six correctly. frontend/src/lib/contracts.ts declares `restakers` with only five outputs, stopping at dep

- **`invariant_totalActivePrincipal_consistency` is a hand-rolled helper wearing the `invariant_` prefix — CI predicted this and it is still unfixed** `[S]`
  - `contracts/test/Deep_Restaking_2026_05_01.t.sol:190`
  - CI wrote down the diagnosis and the fix and nobody applied it. Either it is silently flaky in the fuzz-invariant job, or it passes for the wrong reason (unbounded fuzzing that never reaches an interesting state).
  - *evidence:* contracts/test/Deep_Restaking_2026_05_01.t.sol:190 declares `function invariant_totalActivePrincipal_consistency() public` and it is called directly as a helper from test_totalActivePrincipal_invariant_acrossLifecycle at :203, :207, :210, :216 and :222. `grep -rn 'targetContract|targetSelector' contracts/test/` returns 18 hits, none in this file — so when the fuzz-invariant job selects it by name 

- **The typecheck gate was repaired in July and still checks zero test files — tsconfig.test.json is referenced by no project, so 168 TypeScript files are typechecked by nothing** `[S]`
  - `frontend/tsconfig.json`
  - Exactly the reference_silent_ci_gates failure mode, in the file that documents that failure mode. Adding `{"path": "./tsconfig.test.json"}` to the references array is a one-line change; expect it to surface real errors on first run, so budget for the fallout rather than the edit. e2e/ needs its own project or an include added — playwright specs are TypeScript and nothing has ever compiled them.
  - *evidence:* frontend/tsconfig.json is `{"files": [], "references": [{"path": "./tsconfig.app.json"}, {"path": "./tsconfig.node.json"}]}` — two references. tsconfig.test.json exists (with a 9-line R080 rationale for `strictFunctionTypes: false`) and is in that list nowhere; `grep -rn 'tsconfig.test'` across frontend/*.ts, frontend/*.js, frontend/package.json and .github/workflows/*.yml returns zero hits other 

- **notifications.js updatePreferences() is a zero-caller no-op waiting on a column no migration adds** `[S]`
  - `frontend/src/nakamigos/lib/notifications.js:137`
  - An exported async function with no callers and an empty body. Delete it, or add the column and the toggles — but the "no-op kept so callers don't break" rationale is no longer true, because there are no callers.
  - *evidence:* `git grep -n updatePreferences -- frontend/src frontend/api` returns exactly one line — the definition at frontend/src/nakamigos/lib/notifications.js:137. Its comment at :134-136 says "migration 002's push_subscriptions schema has no preferences column ... wire a preferences column + this body when granular toggles ship." No migration 002-015 adds such a column.

- **SwapFeeRouter's three SweepETH events are declared in the ABI with no handler — the observability surface the comment promises does not exist** `[S]`
  - `indexer/ponder.config.ts:186`
  - Ponder only fetches logs for events that have handlers, so the 48h-timelocked sweep lifecycle on the fee router is unindexed and the ABI entries are dead weight. Three handlers writing into the existing pol_event-style pattern, or delete the three ABI entries and the comment — but the current state claims coverage that isn't there.
  - *evidence:* A script diffing every `type:"event"` name in each inline ABI against every `ponder.on("Contract:Event")` in src/index.ts (42 handlers) reports exactly one gap: SwapFeeRouter → SweepETHCancelled, SweepETHExecuted, SweepETHProposed. The ABI block is ponder.config.ts:186-204; its comment at :184-186 states the intent — "Mirror the sister POLAccumulator SweepETH* observability surface so off-chain mo

- **TegridyFactory's pair-disable governance lifecycle is emitted on-chain but missing from the indexer's ABI, despite a comment claiming it** `[S]`
  - `indexer/ponder.config.ts:258`
  - The immediate emergency disable is indexed (factoryEmergencyDisable) but the timelocked propose→execute path — the one a governance UI would need to render a pending queue — is not. Unlike item 12 this is a genuine coverage gap rather than dead ABI weight: two events, one small table or a reuse of factoryGuardianEvent's discriminator.
  - *evidence:* indexer/ponder.config.ts:258-259 says "Pair-disable governance also emits PairDisableProposed/Executed." The TegridyFactoryGovernanceAbi that follows (:260-301) declares GuardianSet, GuardianChangeProposed/Executed/Cancelled and PairEmergencyDisabled — not PairDisableProposed or PairDisableExecuted. Both are real: contracts/src/TegridyFactory.sol:113-114 declares them and :623/:638 emits them.

- **indexer/.env.local.example documents one of the seven env vars the indexer reads** `[S]`
  - `indexer/.env.local.example:1`
  - The undocumented ones are the ones that matter on a real deploy: the RPC fallback chain that ponder.config.ts:447-457 added precisely so a single provider outage can't stall sync, and ALLOWED_ORIGINS, which is the only way to extend the CORS allowlist that src/api/index.ts:45-50 hardcodes. Six lines.
  - *evidence:* `grep -ohE 'process\.env\.[A-Z_0-9]+' indexer/*.ts indexer/src/*.ts indexer/src/api/*.ts | sort -u` yields ALLOWED_ORIGINS, NODE_ENV, PONDER_RPC_URL_1, _2, _3, _4, SWAP_FEE_ROUTER_ADMIN_ADDRESS, TEGRIDY_STAKING_ADMIN_ADDRESS. The whole of indexer/.env.local.example is one line: PONDER_RPC_URL_1=https://eth.llamarpc.com.

- **QUICKSTART.md has 15 image links to a docs/screenshots/ directory that does not exist, reusing the same 5 filenames for all 3 paths** `[S]`
  - `QUICKSTART.md (lines 26,32,38,44,50,64,70,76,82,88,102,108,114,120,126; §Next steps)`
  - It is the onboarding doc, linked from README ("New to DeFi? See QUICKSTART.md"). Fifteen broken images and a dead in-app link is the first impression for the least technical reader. Either ship the screenshots (M, needs a running app) or strip the placeholders (S).
  - *evidence:* `ls docs/screenshots` → "No such file or directory". `grep -n '!\[' QUICKSTART.md` returns 15 lines, all of the form `![Step N](docs/screenshots/stepN.png)` — and the identical five filenames step1..step5 repeat verbatim in Path 1 (Earn yield), Path 2 (Borrow against your NFT) and Path 3 (Launch an NFT drop), so even if the assets landed, two of the three walkthroughs would show the wrong screensh

- **The EAS schema was never registered, and registerFactSheetSchema has no caller anywhere** `[S]` **[OPERATOR]**
  - `frontend/src/lib/launcher/attestation.ts:601`
  - attestation.ts is 25 KB with 54 test cases across attestation.test.ts + attestation.failClosed.test.ts, and the entire subsystem is inert behind one un-invoked one-time transaction. Nothing in the repo can send it: no UI path, no entry in frontend/scripts/. The cheapest honest fix is a small operator script mirroring solana-dbc-operator.mjs's print-don't-send posture, rather than an admin button.
  - *evidence:* frontend/src/lib/launcher/attestation.ts:601 `registerFactSheetSchema(walletClient)` — `grep -rn 'registerFactSheetSchema' frontend/src frontend/scripts frontend/api` returns only attestation.ts and attestation.test.ts. pages/LaunchPage.tsx:264-268 records the consequence: "the Fact Sheet schema must be registered on the SchemaRegistry before any attestation can succeed. It was NOT registered on m

- **The Analytics tab is unreachable from the desktop nav — it exists in MobileNav only** `[S]`
  - `frontend/src/nakamigos/components/Header.jsx`
  - Analytics.jsx (519 lines) plus the three panels it lazy-loads — CollectionHealth (708), HolderAnalytics (172), RarityPriceScatter (830) — are ~2,200 lines of built, maintained UI that a desktop visitor cannot navigate to. Fix is one line in MORE_NAV plus the inverse assertion in navRouting.test.jsx.
  - *evidence:* `grep -in 'analytic' frontend/src/nakamigos/components/Header.jsx` → zero hits. Header.jsx:128-136 PRIMARY_NAV = listings, gallery, deals, traits, activity, collection, portfolio; Header.jsx:138-153 MORE_NAV = pro, trades, sniper, trade, watchlist, favorites, bids, my-listings, alerts, chat, history, whales, integrity, about. That is 21 of the 22 entries in constants.js:90-95 VALID_TABS; the missi

- **orderValidator Layer 3 is dead — the file's documented "Main entry" has no callers** `[S]`
  - `frontend/src/nakamigos/lib/orderValidator.js`
  - The file advertises a three-layer system in which the definitive layer is never invoked, so a reader reasoning about buy-path safety over-estimates the checking that actually runs. Either delete Layer 3 or wire it behind the buy click.
  - *evidence:* lib/orderValidator.js:8 says `Main entry: validateOrderFillability(provider, order, fulfillerAddress)`. `grep -rn 'validateOrderFillability'` over frontend/src returns three hits: the header comment, the definition at :340, and a comment at ShoppingCart.jsx:158 explaining that it was replaced. The only import anywhere is `validateOrderQuick` (Modal.jsx:15/175, ShoppingCart.jsx:9/164), which is Lay

- **listingPrice is threaded through AnimatedCard to Card, which never reads it — live listing prices never render on My NFTs cards** `[S]`
  - `frontend/src/nakamigos/components/Card.jsx`
  - A seller looking at My NFTs sees "#1234" instead of the price their NFT is currently listed at, even though MyCollection already fetched and mapped that listing (listingMap, MyCollection.jsx:56-60). Half of the wiring is done.
  - *evidence:* MyCollection.jsx:447 passes `listingPrice={listingMap.get(String(nft.id))?.price}`. AnimatedCard.jsx:43 spreads `<Card {...cardProps} idx={index} skipReveal />`. Card.jsx:8 destructures exactly `{ nft, idx, onPick, view, isFavorite, onToggleFavorite, skipReveal }` — no listingPrice — and its price cell (Card.jsx:86-99) reads only `nft.price`, which is null for wallet tokens from fetchWalletNfts (a

- **Turning off Floor alerts silently disables Underpriced alerts** `[S]`
  - `frontend/src/nakamigos/hooks/useSmartAlerts.js`
  - A user who only wants underpriced-listing alerts turns Floor off, turns Underpriced on, and receives nothing forever with no error. The dependency is invisible in the settings UI.
  - *evidence:* hooks/useSmartAlerts.js:181 opens `if (cfg.floor.enabled && stats.floor != null) {` and the only assignment to prevFloorRef is inside it at :200 (`prevFloorRef.current = stats.floor;`). The Underpriced check at :313-317 reads that same ref — `const floor = prevFloorRef.current; if (floor && floor > 0) {` — so with cfg.floor.enabled === false the ref stays null forever and the underpriced branch ca

- **Onboarding's fallbackCenter flag is read nowhere, and the step it guards spotlights nothing on mobile** `[S]`
  - `frontend/src/nakamigos/components/Onboarding.jsx`
  - Every first-time mobile visitor ends the welcome tour on a step highlighting an empty corner and describing a control they cannot see or use. The intended fix was written (the flag) and never connected.
  - *evidence:* Onboarding.jsx:35 sets `fallbackCenter: true` on the final "Keyboard Shortcuts" step. `grep -rn 'fallbackCenter' src/` returns that single line — no consumer. It cannot work as intended anyway: resolveTarget (Onboarding.jsx:119-125) uses document.querySelector, which returns display:none elements, so the `if (!el)` centre fallback at :163-171 never fires. The step targets `[data-tour='shortcuts']`

- **LaunchGate exposes two integration points no caller uses, so its wallet-signature step leads nowhere** `[S]`
  - `frontend/src/components/LaunchGate.tsx:51-61`
  - Asking for a wallet signature that changes nothing trains users to sign. The advisory behaviour itself IS deliberate (LaunchPage.tsx:551-554 says so), so the fix is to delete the dead `onOpen`/`children` surface and either remove the prove button or say plainly what it does.
  - *evidence:* All three call sites — LaunchPage.tsx:496, SolanaLaunchPage.tsx:422, CurveLaunchPage.tsx:698 — render `<LaunchGate rail="…" />` with no `onOpen` and no children. LaunchGate.tsx:215 `{open && children}` therefore never renders anything, and `onOpen` (:53-57, documented as the way gate_decision_id reaches the birth notify) is redundant: lib/launcher/launchService.ts:548,593 re-reads the gate itself 

- **registry-onchain.yml's daily cron is red every day: deploy-authority still claims expect.funded=true** `[S]` **[OPERATOR]**
  - `frontend/scripts/addresses.json (deploy-authority entry) + frontend/scripts/verify-addresses.mjs:407-409 + .github/workflows/registry-onchain.yml:28`
  - NEW detail on a tracked item. This is now a permanently-red scheduled check — the exact shape this repo already learned to ignore with Slither, and revenue-watch.yml:107-110 explicitly cites that lesson. Either fund the key, or set `"onchain": false` (the structural exemption the script already supports) with the blocker recorded, so the red check means something again.
  - *evidence:* frontend/scripts/addresses.json deploy-authority carries `expect: {"type":"wallet","funded":true}` (verified by walking the JSON) while its own `status` reads "🔴 EMPTY. getAccountInfo returns value:null on mainnet-beta (checked twice, slot 438,844,123/4 — 2026-08-12)". verify-addresses.mjs:395-409 deliberately DELETED the status-prose escape hatch ("an honesty edit must never be able to switch off

- **.github/coverage-floor.json was never committed, so the weekly coverage cron cannot pass** `[S]`
  - `.github/workflows/contracts-coverage.yml:133-137`
  - The fail-first design is deliberate and correct, but the follow-through is the open loop: every Sunday 05:13 UTC run burns up to 60 minutes of forge coverage and then fails on the missing file. One `workflow_dispatch` with update_floor:true prints the exact JSON to commit. Until then this is a second permanently-red schedule sitting next to the first.
  - *evidence:* `ls .github/` returns CODEOWNERS, FUNDING.yml, ISSUE_TEMPLATE/, contracts-test-slices.json, dependabot.yml, pull_request_template.md, workflows/ — no coverage-floor.json. contracts-coverage.yml:133-137 exits 1 when it is absent ("there is deliberately no 'no floor file, pass anyway' path").

- **ci.yml has no all-pass aggregator, so the new e2e-anvil job may not be a required check** `[S]` **[OPERATOR]**
  - `.github/workflows/ci.yml (jobs: lint-typecheck-test / build / e2e / e2e-anvil)`
  - Cannot be confirmed from the repo — branch-protection config is not in-tree. But if e2e-anvil was not hand-added to the required-check list, the money-path suite the whole job exists to un-skip can go red without blocking a merge, which reproduces the failure mode its own header block warns about at ci.yml:264-287. A ten-line aggregator makes it structural instead of a UI setting somebody has to remember.
  - *evidence:* contracts-ci.yml:583-625 establishes the pattern with `all-tests-pass` and states its purpose: "Branch-protection rules can point at THIS check name … adding a new slice doesn't require updating branch protection." ci.yml has four independent jobs (lint-typecheck-test, build, e2e, e2e-anvil) and no aggregator; e2e-anvil was added 2026-08-12.

- **make-operator-keypair.mjs is referenced by nothing in the repo — no alias, no runbook, no doc** `[S]`
  - `frontend/scripts/make-operator-keypair.mjs`
  - It is the tool that produces the OPERATOR_KEYPAIR file every Solana operator command needs (solana-dbc-operator.mjs:51, tegridy-launch-operator.mjs). Its EEXIST-refuses-to-clobber guarantee (lines 22-39) is genuinely careful work, and it is undiscoverable — so the next operator who needs a payer will reach for `solana-keygen`, which the header notes cannot be installed on this box. One runbook line or one npm alias fixes it.
  - *evidence:* Repo-wide grep for `make-operator-keypair` returns exactly one hit: its own usage line, frontend/scripts/make-operator-keypair.mjs:11. Root package.json aliases 8 scripts and not this one. solana/tegridy-amm/MAINNET_RUNBOOK.md references solana-dbc-operator.mjs, tegridy-launch-operator.mjs and verify-program-constants.mjs, never this.

- **exotic-toweli-fork-rehearsal.mjs is a named pre-prod gate with no alias and no pipeline, now that an anvil CI job exists** `[S]`
  - `scripts/exotic-toweli-fork-rehearsal.mjs + docs/LAUNCHER_GOLIVE_CHECKLIST.md:127`
  - A go-live gate that only exists on a laptop is a gate whose last verdict nobody can date. The infrastructure to host it landed yesterday. Worth NOT putting on every PR (an archive-RPC mainnet fork per PR is real wall-clock) — workflow_dispatch, or a schedule, is the right shape.
  - *evidence:* docs/LAUNCHER_GOLIVE_CHECKLIST.md:127 makes `node scripts/exotic-toweli-fork-rehearsal.mjs` step 1 before flipping EXOTIC_LAUNCHES_ENABLED. No npm alias in root package.json; grep across .github/ finds no reference. ci.yml:288-341 now runs an `e2e-anvil` job with foundry-toolchain installed and ANVIL_FORK_URL already wired.

- **Three backup secrets and one repo variable cannot be verified from the tree; two workflows depend on them** `[S]` **[OPERATOR]**
  - `.github/workflows/supabase-backup.yml:68-84 + .github/workflows/revenue-watch.yml:88-89,178-182`
  - If the three secrets are still unset, the Monday 04:23 UTC backup is red weekly — a third permanently-red schedule alongside the coverage floor and registry-onchain, and this repo has documented twice that a chronically-red check gets ignored. If SOLANA_FEE_ACCOUNT is still unset, one live fee rail is watched by nothing while the other four are. Both are five-minute settings changes; neither can be confirmed or dismissed without opening Settings > Secrets and variables > Actions.
  - *evidence:* supabase-backup.yml:68-84 fails loudly when SUPABASE_URL / SUPABASE_SERVICE_KEY / BACKUP_PASSPHRASE are unset, and its own comment records that every scheduled run from 2026-06-15 to 2026-07-27 was green with zero bytes backed up because they were. revenue-watch.yml:178-182 emits `::warning::Solana swap-fee wallet: set the SOLANA_FEE_ACCOUNT repo variable to watch this rail` on every hourly run wh

- **18 audit review documents (7,939 lines) are untracked while their 153 siblings in the same directory are committed** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.audit_2026_freshlook/fix_review/agent_review_Staking.md`
  - .gitignore line 35 states the policy these violate: "Audit artifacts are EXPLICITLY tracked — every security review belongs on GitHub." 7,939 lines of contract-review reasoning existing on exactly one disk, inside a OneDrive folder that has already pruned files mid-session once.
  - *evidence:* `git ls-files .audit_2026_freshlook | wc -l` = 153; tracked subdirs are findings/, post_fix_scan/, post_fix_scan2/, post_fix_scan4/ through post_fix_scan8/, storage_layout/. Untracked: .audit_2026_freshlook/fix_review/ (15 files — agent_review_Restaking.md 681 lines, agent_review_Pair_TWAP.md 617, agent_review_Lending.md 607, …) and .audit_2026_freshlook/post_fix_scan3/ (captured_owner_matrix.md 4

- **15 untracked mainnet broadcast JSONs are the deploy provenance for the 07-16 gated batch and the 06-07 MVP deploy** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/broadcast/DeployMVP.s.sol/1/run-1780809817554.json`
  - The repo's own convention says these belong in git and its own docs say committing them is the fix for a drift that already bit MIGRATION_HISTORY.md. Right now the deploy record for every live 07-16 contract exists only on this laptop.
  - *evidence:* All 15 are chain 1 with real receipts (parsed with Python): DeployMVP 2026-06-07 05:23, 40 txs / 16 receipts / 13 CREATEs (TegridyStaking 0xcadc93e9…, TegridyFactory 0xa24c7287…, SwapFeeRouter 0x6d5791a6…, RevenueDistributor 0xf993316e…, POLAccumulator 0x2a5f65f4…, +8); then the 2026-07-16 batch — GaugeController 0x6c79522d… 04:39, VoteIncentives+Admin 04:42, PremiumAccess 0x9dc2675b… 04:44, NFTPo

- **frontend/create-fee-atas.mjs is a real operator tool, untracked and in the wrong directory** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/create-fee-atas.mjs`
  - Real, reviewed operator tooling for the live Solana fee wallet, existing on one disk. Commit it — either in place with a comment explaining the frontend/ location, or move to scripts/ and resolve deps explicitly.
  - *evidence:* 3,532 B, dated 2026-07-10, untracked and not ignored. Header: "One-time operator tool: create the wSOL + USDC fee ATAs for the Tegridy Solana fee wallet, using the SAME libraries + derivation the app uses" with a documented run line `FEE_KEYPAIR=/path/to/fee-wallet-keypair.json node create-fee-atas.mjs` and a safety note. Its eleven peers all live in scripts/ and are tracked (scripts/pull-caller-c

- **No `cargo test` runs anywhere in CI — segmented.rs's 23 tests and the vendored CLMM's 12 never execute** `[S]`
  - `.github/workflows/solana-ci.yml:284-287`
  - That Cargo.toml claim is false today: nothing runs cargo test, so the dev-deps buy nothing. segmented.rs's tests include the golden-value rounding pins written specifically after mutation testing (`full_crossing_payouts_are_exact_to_the_lamport`, `full_buy_to_the_top_is_exact_to_the_token`) — they ran once on someone's machine and have guarded nothing since. Adding the step is small; it may go red, which is the point.
  - *evidence:* `grep -rn 'cargo test' .github/workflows/` returns zero hits. The only Rust test invocation in the repo is `rustc --edition 2021 --test src/curve.rs` (solana-ci.yml:286), which compiles curve.rs alone — segmented.rs needs `vendor/` and `anchor_lang`, so it cannot be reached that way. Per-file `#[test]` counts: segmented.rs 23, vendor/tick_math.rs 8, vendor/unsafe_math.rs 3, vendor/liquidity_math.r

- **`LAUNCH_ERROR_CODES` and `LAUNCH_ERROR_COPY` are missing 6020 CreatorMismatch** `[S]`
  - `frontend/src/lib/launcher/solana/curve/program.ts:270-291`
  - `launchErrorName(6020)` returns null, which program.ts:299-301 defines as 'not one of ours (an SPL/system error, a compute exhaustion, an unknown)'. A creator-account mismatch on a trade would be reported to the user as somebody else's failure.
  - *evidence:* errors.rs declares 21 variants; Anchor numbers them from 6000 in declaration order, so `CreatorMismatch` (errors.rs:49) is 6020. The table stops at `6019: 'AwaitingMigration'`. format.ts:173-194 (`LAUNCH_ERROR_COPY: Record<LaunchErrorName, string>`) is short the same entry, and because `LaunchErrorName` is derived from the codes table, TypeScript cannot catch the gap. `grep -c 'LaunchError::Creato

- **The operator harness's `status` never mentions the segmented step, though its header promises it does** `[S]`
  - `frontend/scripts/tegridy-launch-operator.mjs:562-598`
  - `status` is the one command the header tells you to trust over its own prose ('Trust `status`, not this paragraph'), and it is silent about the one feature that is built and unpublished.
  - *evidence:* The file header (lines 48-59) lists a five-step ordering including 'set-curve-segments is orthogonal to all of that: it publishes the Meteora-shaped curve so create_launch --mode 1 has a shape to snapshot' and then states '`status` prints exactly which of these steps is outstanding.' `cmdStatus` prints steps 1-4 only; `grep -n segmentCount` over the whole file matches only lines 1095-1096, inside 


## INCOMPLETE-UX — 13 items (2 need the operator)

- **The buy/sell/create/migrate write path is a branch that can never execute — no CurveWriteClient implementation exists** `[L]`
  - `frontend/src/pages/CurveLaunchPage.tsx:457,893`
  - /curve-launch renders live mainnet chain data and cannot complete its own primary action. The comment justifying the omission (CurveLaunchPage.tsx:60-68) rests on 'the program is not deployed', which stopped being true on 2026-08-08 — so the reason the write path was deliberately withheld has expired.
  - *evidence:* `writeClient={null}` is hardcoded at line 893, the only call site; line 457 branches on `writeClient === null`, so the non-null arm is unreachable. `CurveWriteClient` (rpc.ts:291) is an interface with no implementor — grep across the repo returns only the type import, the interface, and two prop declarations. `grep -l 'createLaunchIx|buyIx|sellIx|migrateToAmmIx'` matches exactly four files: ix.ts,

- **Playwright runs Desktop Chrome and a Pixel 5 — there is no iPhone project and no iPad project, against the standing 'flawless on desktop, iPhone 14+, iPad' rule** `[M]`
  - `frontend/playwright.config.ts`
  - The operator's standing rule names two device classes that no automated check has ever rendered, on an app whose notch handling is entirely inline env() with no fallback other than 0px. Adding `devices['iPhone 14 Pro']` and `devices['iPad (gen 7)']` projects is a two-line config change; the honest cost is triaging what they find and deciding whether iOS Safari (WebKit) is worth installing in CI or whether the Chromium projection is enough.
  - *evidence:* playwright.config.ts:19-22 — `projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }, { name: 'mobile-chrome', use: devices['Pixel 5'] }]`. `grep -rn 'iPhone|iPad|devices\[' frontend/playwright.config.ts frontend/e2e/ .github/workflows/ci.yml` returns only those two lines — the strings iPhone and iPad appear nowhere in the e2e layer. Pixel 5 is 393×851 Android Chrome; iPhone 14 Pro is 393

- **ShareCard and TheaterMode publish approximate ranks as exact, while the grid surfaces hide them** `[M]`
  - `frontend/src/nakamigos/components/ShareCard.jsx`
  - A user tweets an image asserting "RANK #7" that was computed from whatever 40 tokens their browser had loaded. Three surfaces already established the honest convention; these three didn't get it.
  - *evidence:* Card.jsx:45 `{nft.rank && !nft.rankApproximate && (`, Hero.jsx:46 and :78, VirtualGalleryGrid.jsx:353 all suppress the badge when the rank is approximate. ShareCard.jsx:58-70 does not: `if (nft.rank) { const rankText = \`RANK #${nft.rank}\` ... ctx.fillText(rankText, ...) }` bakes it into the downloadable PNG, and ShareCard.jsx:187-188 `const rankPart = nft.rank ? \` (Rank #${nft.rank})\` : ""` pu

- **015's Section 2 leaves four read-side exposure decisions commented out and unassigned** `[S]` **[OPERATOR]**
  - `frontend/supabase/migrations/015_drop_permissive_policy_overrides.sql:88`
  - Section 1 is a no-op today only because the tables are empty; the moment 014 lands and users arrive, Section 2 becomes live product behaviour that nobody chose. This needs four yes/no answers from the operator, not code — and it wants answering in the same session that applies 014, not after.
  - *evidence:* 015_drop_permissive_policy_overrides.sql:88-100 lists four `DROP POLICY` lines commented out — "Anyone can read favorites/profiles/watchlist/votes" — under "SECTION 2 — PRODUCT DECISION", noting the watchlist one "leaks trading intent; the most sensitive of the four" and that the owner-scoped SELECT twin already exists for each. Nothing elsewhere in the repo records a decision on them.

- **Two of nine badges can never be earned, and the Leaderboard renders the full nine-badge grid** `[S]`
  - `frontend/src/lib/pointsEngine.ts:249`
  - The page shows two goals a user can chase forever and never reach, directly beside copy saying daily visits earn nothing. Either drop the two entries from BADGES or make LeaderboardPage filter to earnable ones — the honest fix is dropping them, since the streak source of truth was deliberately deleted.
  - *evidence:* pointsEngine.ts:249-252 defines `streak_7` (`check: d => d.streak.longest >= 7`) and `streak_30` (`>= 30`). `PointsData.streak` is initialised to `{ current: 0, lastVisit: '', longest: 0 }` at pointsEngine.ts:113 and NOTHING increments it — the only writer would have been `recordDailyVisit`, a no-op stub (line 195) with zero call sites. LeaderboardPage.tsx:260 does `{BADGES.map(b => …)}` with `con

- **The My NFTs empty state's only CTA sends you to OpenSea, and the in-app EmptyState config written for it is unused** `[S]`
  - `frontend/src/nakamigos/components/MyCollection.jsx`
  - This is the exact moment a wallet-connected visitor is most likely to buy, and the app hands them to a competitor — forfeiting the 1% PLATFORM_FEE_RECIPIENT cut that App.jsx:165-171 goes out of its way to protect on every other entry path. The in-app replacement is already written.
  - *evidence:* MyCollection.jsx:418-436 hand-rolls its own empty block ("No {collection} Found" / "This wallet doesn't hold any {collection} NFTs") whose single button is `<a href={`https://opensea.io/collection/${...}`} target="_blank">Browse on OpenSea</a>`. Meanwhile components/EmptyState.jsx:20-27 already defines a `collection` state — same copy, but `action: "Browse Gallery", tab: "gallery"` — and `grep -rn

- **Price alerts are localStorage-only, wallet-keyed, and only evaluate while the tab is open — none of it disclosed** `[S]`
  - `frontend/src/nakamigos/components/PriceAlerts.jsx`
  - "Get notified when the floor drops" is understood as a service. It is a browser tab that has to stay open, and the alerts vanish on a second device or a site-data clear. The honesty pattern and its test already exist one tab over.
  - *evidence:* PriceAlerts.jsx:11-25 loads/saves to `${slug}_${wallet}_price_alerts` in localStorage with no server path at all. The wallet in the key implies account scoping, but nothing syncs — contrast lib/userdata.js:234-305, which gives the watchlist real syncWatchlist/addWatchlistRemote/removeWatchlistRemote, all actually called by Watchlist.jsx:34/63/78/92/106. Evaluation is an in-page 30s poll that skips

- **Watchlist silently drops entries whose token isn't in the loaded page window — Favorites has the guard, Watchlist doesn't** `[S]`
  - `frontend/src/nakamigos/components/Watchlist.jsx`
  - The data survives (it round-trips to Supabase via syncWatchlist), but the user sees an empty page and reasonably concludes their watchlist was lost. The exact disclosure needed is already written four files away.
  - *evidence:* Watchlist.jsx:114 `const watchedNfts = useMemo(() => tokens.filter((t) => watchedIds.has(t.id)), [tokens, watchedIds]);` renders only intersecting tokens, and the EmptyState at :167 is gated on `watchlist.length === 0` — so a watchlist of 3 tokens none of which are loaded renders a header, an empty grid, and no explanation. Favorites.jsx:74-78 handles the identical structure honestly: `{favoriteNf

- **The /trade tab can only offer for tokens in the loaded window — ~40 of 20,000** `[S]`
  - `frontend/src/nakamigos/components/NftCompare.jsx`
  - Searching for the specific Nakamigo you actually want to trade for returns nothing 99.8% of the time, and the tab gives no signal that the index is partial. Adding loadAll/hasMore is a one-line prop change plus the same trigger TraitExplorer uses at :380.
  - *evidence:* NftCompare.jsx:227-233 builds the "their NFT" results from the `tokens` prop: `return tokens.filter((t) => t.name.toLowerCase().includes(lower) || String(t.id).includes(theirSearch)).slice(0, 8);`. App.jsx:761 passes `tokens={nfts.allTokens}` and, unlike Listings/TraitExplorer/Deals, passes neither loadAll nor hasMore, so nothing on this tab can widen the window. The "your NFT" side is fine — it f

- **WalletModal shows an end user a .env instruction, and references terms of use with no link** `[S]`
  - `frontend/src/nakamigos/components/WalletModal.jsx`
  - The .env line is a developer note shipped to users at the highest-stakes moment in the funnel, and it reads as a broken site. The unlinked ToS reference asks for agreement to something the user cannot open. Both are one-line fixes.
  - *evidence:* components/WalletModal.jsx:261-278 renders, in the production connect dialog: "WalletConnect & Rainbow require a project ID. Set VITE_WALLETCONNECT_PROJECT_ID in .env" — gated on `!HAS_WC_PROJECT_ID` (WalletContext.jsx:167). WalletModal.jsx:288 renders "By connecting, you agree to the terms of use." as plain text with no href, in an app that has a ToS (memory notes it was amended 2026-08-04). Sepa

- **InfoPage and SolanaSwapPage are the only tab hosts that never got the WAI-ARIA tablist treatment** `[S]`
  - `frontend/src/pages/InfoPage.tsx:72-90`
  - InfoPage hosts Treasury/Contracts/Risks/Terms/Privacy — five tabs, the widest bar in the app — and it is the one a keyboard user cannot arrow through. The hook and the exact markup already exist one file over.
  - *evidence:* `grep -rln useTabListKeys` → ActivityPage, CommunityPage, DashboardPage, LearnPage, LendingPage, TradePage, AMMSection, LendingSection, NFTLendingSection. Missing: pages/InfoPage.tsx:72-90 (five plain buttons with `aria-pressed`, no `role="tablist"`, no arrow-key nav) and pages/SolanaSwapPage.tsx:854-869 (same pattern for the swap/limit switch). LearnPage.tsx:59-92 is the direct sibling that does 

- **The FAQ answers "How do I get TOWELI?" by sending users to Uniswap, never mentioning the in-app swap** `[S]`
  - `frontend/src/pages/FAQPage.tsx:22`
  - This is the CTA-links-out-where-it-should-act-in-app shape, on the single highest-intent question in the FAQ. It also routes the buy away from SwapFeeRouter, so the protocol earns nothing on a purchase the FAQ itself directed.
  - *evidence:* pages/FAQPage.tsx:22 — "Buy TOWELI on Uniswap V2. Simply swap ETH for TOWELI at app.uniswap.org." No link to /swap, which is a primary-nav destination (navConfig.ts:99) rendering a full aggregator + native-pool router (pages/TradePage.tsx). TradePage.tsx:153,558 shows it already quotes and labels the native TOWELI/WETH pool.

- **cp-swap's on-chain security_txt still carries an unactioned OPERATOR TODO for a disclosure contact, on a live mainnet binary** `[S]` **[OPERATOR]**
  - `solana/tegridy-amm/programs/cp-swap/src/lib.rs:19-22`
  - security_txt is the standard a researcher reads off the deployed bytecode. Because it is compiled in, fixing it requires a program upgrade — which is already required anyway to land the #281 admin::ID correction, so this should ride along rather than becoming a second upgrade. The stale 'before MAINNET' block above it is free to fix now.
  - *evidence:* Inside `security_txt!`: '⚠️ OPERATOR: add a dedicated security disclosure email here before mainnet.' The `contacts:` field is `link:https://memetic.fun/trust` with no email. The program deployed to mainnet on 2026-08-08 (addresses.json:68). Lines 33-40 of the same file are a second '⚠️ OPERATOR before MAINNET: set the non-devnet values' block for work that is now done (both constants are set at l


## MISSING-ENTIRELY — 8 items (3 need the operator)

- **TegridyNativeBuyRouter has zero tests, and its own header makes a fork suite a hard pre-deploy gate** `[L]` **[OPERATOR]**
  - `contracts/src/TegridyNativeBuyRouter.sol:8`
  - Gate (2) is the only one of the three that is pure engineering, and it does not exist. The delta-inferred platform fee (`address(this).balance - priorBalance` around the Seaport fill) is exactly the kind of thing only a fork test with a refunding order can settle.
  - *evidence:* `grep -rl TegridyNativeBuyRouter contracts/test/` returns 0 files — it is the only contract in contracts/src/*.sol with no test reference at all (all 33 others have >=1). The 270-line source's header at :8-32 says it "MUST clear: (1) a clean CI compile, (2) a mainnet-fork test suite that actually buys a native listing + an OpenSea listing through it and asserts the referral credit + NFT delivery, 

- **RESOLVED 2026-08-21 — ~~The Phase-7 restaking deploy script named in DeployMVP.s.sol was never written, and RestakingMonitorView has no deploy path at all~~** `[M]`
  - `contracts/script/DeployMVP.s.sol`
  - Closed by `c749c933`, the same commit that landed the admin split. `contracts/script/DeployRestaking.s.sol` now exists and constructs all three — `new TegridyRestaking(`, `new TegridyRestakingAdmin(` and `new RestakingMonitorView(` all resolve to that one file.
  - ⚠️ **This entry was actively misleading and is the reason it is being resolved rather than deleted.** Its five-step list said "host + **RestakingAdminLib** link" — `contracts/src/lib/RestakingAdminLib.sol` was DELETED in that same commit, and this was the last reference anywhere in the repo that did not describe it as deleted. Anyone planning a restaking go-live from this entry would have gone looking for a library that no longer exists.
  - Still true, and still open: `VerifyMVP.s.sol:48` excludes restaking from its checks, so there is no VerifyRestaking invariant set. And §5.8 of `RESTAKING_EIP170_SPLIT_DESIGN.md` — the mandatory external re-audit — gates any deploy regardless of the script existing.
  - *evidence (re-run 2026-08-21, and it now says the opposite):* `grep -rl "new TegridyRestaking(" contracts/script/` returns `contracts/script/DeployRestaking.s.sol`; so do `new TegridyRestakingAdmin(` and `new RestakingMonitorView(`. The original evidence line — that all three returned nothing — was true when written on 2026-08-13 and was falsified on 2026-08-19. RestakingMonitorView.sol is the only src contract that is neither deployed,

- **src/lib/VotePowerOracle.sol has no direct test despite a live/historical semantic split** `[M]`
  - `contracts/src/lib/VotePowerOracle.sol`
  - The `powerAt` vs `powerOfLiveUnsafe` distinction is the anti-flash-loan property for both governance surfaces, and it is only ever tested transitively through two callers that each clamp it differently.
  - *evidence:* `grep -rl VotePowerOracle contracts/test/` returns 0 files. It is consumed at CommunityGrants.sol:473 (`VotePowerOracle.powerAt`) and :478 (`powerOfLiveUnsafe`), and GaugeController.sol:415/:421 with the same pair. GaugeController.sol:411 notes the two readings are reconciled by a min-clamp at the call site, and CommunityGrants.sol:476 records that a `powerOf` alias was removed as deprecated. The 

- **There is no key-succession or continuity document anywhere, and the one key that can unblock graduation exists as a single un-backed-up file on one machine** `[M]` **[OPERATOR]**
  - `docs/OPERATOR_PACKET_2026_08_12.md`
  - Every other risk in this inventory is recoverable; this one is not. Losing that file permanently bricks graduation on a venue that is already live and holding 8.467 SOL of rent, with no seed phrase to regenerate from and no second copy. The packet flagged it yesterday as a precondition to funding and it is still open. Two separable actions: the backup itself is minutes and is the operator's alone (I will not touch key material); the missing continuity doc — which keys exist, where each backup lives, what happens if you are unavailable — is a page of writing and is the thing that turns a one-off backup into a standing property.
  - *evidence:* `git ls-files | grep -iE 'succession|inherit|deadman|estate|continuity|disaster|recovery'` returns exactly one non-vendored hit — .github/workflows/supabase-backup.yml, which backs up the database and nothing else. A content grep for 'key loss|key backup|seed phrase|bus factor|single point of failure|operator unavailable' across docs/*.md and root *.md returns three lines total: a scam warning in 

- **No base schema: 5 of the 10 live tables have no CREATE TABLE anywhere in the migration set** `[M]` **[OPERATOR]**
  - `frontend/supabase/migrations/`
  - The directory cannot rebuild the database. There is no staging clone, no local dev DB, and no way to test a migration before it hits prod — which is exactly how 004 ended up half-applied. A 000_base_schema.sql reconstructed from the live catalog (pg_dump --schema-only, or hand-written from proxy-schemas.js) turns the folder into something a tool can run.
  - *evidence:* `grep -rn "CREATE TABLE" frontend/supabase/migrations/` returns 9 statements covering siwe_nonces, native_orders, trade_offers, push_subscriptions, revoked_jwts, dm_messages, analytics_events. It never creates `messages`, `user_profiles`, `user_favorites`, `user_watchlist` or `votes` — the five tables 001 spends its whole length writing policies against. `grep -rn "ENABLE ROW LEVEL SECURITY"` like

- **The ?resource= ordering invariant is called load-bearing in two places and guarded by nothing** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/aggregator.js:279`
  - Six first-party resources including the birth signer ride on a source-ordering rule enforced only by a comment, and its failure mode is a 404 with a misleading message rather than an exception. A six-line table-driven test (each resource dispatches, each mocked module is invoked) would pin it permanently.
  - *evidence:* aggregator.js:279-280: "MUST stay above the `const provider` line below — a ?resource= call carries no provider, so a branch placed after it never runs and falls into the 404." SERVERLESS_BUDGET.md:45-47 repeats it. `grep -rn 'resource' frontend/api/__tests__` returns exactly one hit — a passing comment in launcher-outcomes.read-honesty.test.js:175 — so no test imports aggregator.js and asserts th

- **heat.js and launch-radar.js are the only two ?resource= branches with no server-side test** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/heat.js:48`
  - The 4500-vs-6000 relationship between heat.js:48 and heatClient.ts is exactly the kind of two-file invariant that silently inverts on the next tuning pass, at which point the specific "Heat oracle unavailable" message stops reaching users and every outage reads as a generic client abort.
  - *evidence:* api/__tests__ (33 files) and api/_lib/__tests__ (5 files) contain record.test.js, births.test.js, launcher-outcomes.read-honesty.test.js and _lib/__tests__/launch-cohort.test.js — but no heat.test.js and no launch-radar.test.js. src/lib/heat/heatOracle.test.ts covers the client-side parser, not the proxy. Untested in heat.js specifically: the 403 gate (line 93), the upstream-400 passthrough (line 

- **notifyBirth.ts has no test file — the one module that decides whether a birth is announced at all** `[S]`
  - `frontend/src/lib/launcher/notifyBirth.ts`
  - Every branch here is a refusal that silently withholds a birth — if readBirthBlock regresses, notifies stop being queued and nothing surfaces, because by design nothing throws. The queue below it (birthNotify.ts) has 18 tests; the decision layer above it has zero. Worth checking while writing them: SolanaLaunchPage.tsx:362 passes `creator: evmAddress ?? ''`, and notifyBirth guards birthBlock and gateDecisionId but not creator, so an empty creator can reach the island.
  - *evidence:* `ls frontend/src/lib/launcher/*.test.ts` shows birthNotify.test.ts and birthRecord.test.ts but no notifyBirth.test.ts, and `grep -rn 'notifyBirth|recordOrigin' frontend/src` returns only notifyBirth.ts itself plus pages/LaunchPage.tsx:72,378 and pages/SolanaLaunchPage.tsx:17,357 — no test references it. It is the only wired module in the directory without a co-located test (26 of 27 have one). Its


## STALE — 122 items (10 need the operator)

- **Thirteen live contracts are running bytecode that contracts/src no longer describes, with no redeploy path for any of them** `[L]` **[OPERATOR]**
  - `contracts/src`
  - "Merged to trunk ≠ live" applies to contracts as much as to the frontend, and nothing in the repo enumerates the gap — CONTRACTS.md lists what is deployed, the CHANGELOG lists what was fixed, and no file joins them. Every audit-remediation commit since June is currently inert on mainnet. Sizing the redeploy (which contracts, in what order, what ownership re-accept each needs) is the missing artifact; the single-batch DeployMVP shape means the answer is probably per-contract scripts, not a re-run.
  - *evidence:* Last commit touching each src file vs its CONTRACTS.md deploy date. Deployed 2026-06-06 (DeployMVP): TegridyStaking (src 2026-08-12, #300), lib/StakingRewardLib (2026-08-08, 51dd19ce — and this one is a DELEGATECALL library whose address 0xb86A763a… is baked into the live host, so a lib redeploy alone changes nothing), RevenueDistributor (2026-08-07, "un-brick permissionless kick(), timelock sweep

- **docs/API.md documents ten endpoints that do not exist and omits every endpoint that does** `[M]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/docs/API.md:18`
  - It is the only file in the repo called "API Reference", and it describes a different product. Anyone integrating from it writes code against routes that 404. Cheaper to delete it and point at api/SERVERLESS_BUDGET.md plus the handler headers (which are genuinely good) than to rewrite it.
  - *evidence:* Last content change 2026-06-07 by a repo-wide sed (`git log -1 -- docs/API.md` -> 9aff5579 "chore: purge tegridyfarms.xyz website refs"); the file's own footer says "Last updated: 2026-04-17". It documents POST /api/auth/nonce, POST /api/auth/verify, GET /api/auth/session, POST /api/auth/logout (lines 18-21), GET /api/quote, GET /api/price/toweli, POST /api/offers, GET /api/offers, POST /api/offer

- **Fourteen markdown docs at contracts/ root were in no doc inventory, including an auditor handoff with two open USER ACTION ITEMs and a stale test count** `[M]` **[OPERATOR]**
  - `contracts/AUDITOR_HANDOFF.md`
  - AUDITOR_HANDOFF.md is the document you hand a paid audit firm. It is fifteen months of drift away from the current suite and it advertises two static-analysis passes that were never run. The two NOT RUN items are cheap on any Linux box and are the kind of thing a firm will ask about in scoping. The seven V4_* docs are a separate question the operator should answer once — the contracts-src agent already recorded src/v4 as deliberately gated, so these are probably 'archive with a banner', not 'act on'.
  - *evidence:* The docs agent's receipt scopes itself to `ls docs/*.md` (45), `find docs/audits` (9) and `ls *.md` (34). `git ls-files contracts | grep -v lib/ | grep -vE '\.sol$|broadcast/'` turns up 14 more: AUDITOR_HANDOFF.md, AUDIT_BATCH3_DEPLOY_READINESS_2026_06_02.md, AUDIT_HALMOS_RESULTS.md, AUDIT_LAUNCHPADV2_2026_06_02.md, AUDIT_SLITHER_TRIAGE.md, RESTORED_FEATURES_DEPLOY_RUNBOOK.md, TRUST_ASSUMPTIONS_MV

- **docs/DEPLOYMENT.md — the deploy runbook README, SECURITY.md and NEXT_SESSION.md all point at — names six paths that do not exist** `[M]`
  - `docs/DEPLOYMENT.md (§Full-fresh steps 3,4,9,10; §Patched-three; §Sepolia)`
  - Four separate docs route a deployer here and the "common path" section's very first command is a deleted shell script. The real current deploy docs are docs/DEPLOY_RUNBOOK.md (2026-08-02, the two Vercel paths) and contracts/script/deploy-gated.sh — neither is linked from here.
  - *evidence:* `ls` on every path it names: MISSING `contracts/script/DeployFinal.s.sol` (step 3), `DeployV3Features.s.sol` (step 4), `DeployTokenURIReader.s.sol` (step 9), `WireV2.s.sol` (step 10), `DeploySepolia.s.sol` (§Sepolia), `scripts/redeploy-patched-3.sh` (§"Patched-three deployment (common path)"). NEXT_SESSION.md:181 itself states redeploy-patched-3.sh was "deleted 2026-04-19" — the repo already knows

- **docs/API.md documents ten endpoints that do not exist and omits every route that does** `[M]`
  - `docs/API.md (§Authentication, §Endpoints, line 9 base URL)`
  - It is titled "API Reference" and its §Contributing tells contributors to add new endpoints here, so it is presented as authoritative while being roughly inverted. Either rewrite against the 11 real handlers or delete it and let frontend/api/SERVERLESS_BUDGET.md own the surface.
  - *evidence:* `find frontend/api -maxdepth 2 -name '*.js'` returns exactly 11 handlers: aggregator, alchemy, analytics, auth/me, auth/siwe, etherscan, opensea, orderbook, solrpc, supabase-proxy, v1/index. frontend/vercel.json's `rewrites` array has no entry for any documented path. Documented but absent: `POST /api/auth/nonce`, `POST /api/auth/verify`, `GET /api/auth/session`, `POST /api/auth/logout` (real rout

- **AUDITS.md — "One page, one truth" — indexes nothing after 2026-05-06 and links a 404 bounty page that SECURITY.md says does not exist** `[M]`
  - `AUDITS.md (line 3 claim; line 13 count; line 178 Immunefi; §Timeline)`
  - README's Security section says "Historical artifacts are indexed in AUDITS.md", and AUDITS.md tells a diligence reader exactly what to read. Three months of audit work is invisible, and the one live external link goes to a page that does not exist — the worst possible signal on a security index.
  - *evidence:* Line 3: "One page, one truth. Every security review, where it came from, what's still open. Nothing is hidden." Its timeline stops at "May 04 ▸ Pass-8". `grep -i` for AUDIT_FINDINGS_2026_05_16 / AUDIT_FINDINGS_2026_05_26_SWARM / AUDIT_FRONTEND_2026_05_27 / AUDITS_2026_100AGENT / audit_2026_freshlook in AUDITS.md returns **zero hits** — yet all four root files exist and `git ls-files .audit_2026_fr

- **docs/GOVERNANCE.md states three things the contracts contradict, and its multisig pointer goes to a roadmap that never mentions multisig** `[M]`
  - `docs/GOVERNANCE.md (§Guardian roles; §Timelock windows; §What the admin CANNOT do; §Summary)`
  - This is the doc that answers "what can the admin do to me" for a depositor. It understates protection in one place (guardian) and overstates it in two others — a 100% fee cap that is really 10%, and a penalty redistribution the code does not perform.
  - *evidence:* (1) §Guardian roles: "There is currently **no separate `guardian` role** for fast emergency response. Guardian introduction is planned alongside the multisig migration." — contracts/src/base/PauseGuardian.sol exists; docs/SAFE_REHOME_RUNBOOK.md §3 defines a dedicated 2-of-3 GUARDIAN Safe and §4.3 re-homes pauseGuardian on five live contracts; docs/INCIDENT_RESPONSE.md §0.1 says "PauseGuardian exis

- **ROADMAP.md is a fossil that README promotes as "Full roadmap", and its Q3-2026 items contradict what shipped** `[M]`
  - `ROADMAP.md (§Q2 items 1-3; §Q3 items 5,7; §Q4 item 9)`
  - Three docs point at it as the forward plan while the real plan lives in WORKORDER_V2.md and the operator's six-month note. Either rewrite it against what is actually queued or replace it with a pointer to WORKORDER_V2.md.
  - *evidence:* Last commit 2026-04-20; today is mid-Q3 2026. Q2 items 1-3 all shipped (LPFarming redeploy `0x1171…e149`, NFTLending grace period, DropV2 cancelSale/refund). Q3 item 5 proposes a "**70/20/10 fee split**" — the live SwapFeeRouter reads `stakerShareBps 10000 / polShareBps 0` per docs/MIGRATION_HISTORY.md, and README/FAQ/REVENUE_ANALYSIS all describe the real constraint as the unremovable 20% referra

- **docs/LAUNCHER_STRATEGY.md's hard gates were bypassed without record, and it cites a session temp file as its red-team archive** `[M]`
  - `docs/LAUNCHER_STRATEGY.md (line 8 gates; tail §red-team archive)`
  - A strategy doc whose stated go-live gates were all skipped, with no note saying so, teaches the next reader that the gates are decorative. And 11 red-team findings are cited to a path that does not exist — they are effectively lost.
  - *evidence:* Line 8: "**Nothing deploys before the core-loop go-live + Safe re-homing gates — and the TOWELI-liveness gate (§6).**" README: the EVM launcher went live 2026-07-21/22; ownership is still on the deployer EOA (no Safe re-homing), the native pool was drained to ~$14 by 2026-08-02 (no TOWELI liveness), and docs/GOLIVE_CORELOOP.md carries a SUPERSEDED banner saying "'farming is live' is false". None o

- **The Header SIWE sign-in button is still commented out on a precondition that has since been met three times over, and there is no way to sign out** `[M]`
  - `frontend/src/nakamigos/components/Header.jsx`
  - Sign-in is now discoverable only by triggering a failure inside DMs or chat, and once signed in the session can only be ended by disconnecting the wallet. The comment actively tells the next reader not to fix it.
  - *evidence:* Header.jsx:652-655: "SIWE Sign In button hidden — infrastructure (useSiweAuth + /api/auth/*) is intact and will be re-surfaced when a feature actually gates on siwe.isAuthenticated (chat / profile / on-chain voting). Until then the button promises capabilities that don't exist." That is now false: DirectMessages.jsx:380-398 renders a hard `needs-auth` gate with its own Sign in button; CommunityCha

- **PR #205 (foundry 1.9) now satisfies the exact lift condition written into the dependabot ignore, but both are frozen** `[M]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.github/dependabot.yml (line 104)`
  - The repo holds a toolchain back on evidence its own PR has since disproved, and the comment will mislead the next reader. Either rebase and merge #205 and delete the ignore, or update the comment to say why it is still held.
  - *evidence:* .github/dependabot.yml lines 104-124 ignores foundry-rs/foundry-toolchain and says "LIFT this ignore only together with a run where all nine slices are green." #205's current statusCheckRollup shows all nine green plus the aggregator: forge test — audit-early / audit-deep / tegridy / deep-fresh-final / r-series / misc / v4 / pass5-pocs / invariants = SUCCESS, all-tests-pass = SUCCESS, forge build 

- **Eight files still tell readers the Solana programs are not deployed; both went live 2026-08-08** `[M]`
  - `solana/tegridy-amm/README.md:31`
  - SECURITY.md is the file GitHub surfaces as the repo security policy AND the target of the on-chain `security_txt` `policy:` field (cp-swap/src/lib.rs:16) — a researcher who reads it is told the live, fund-touching programs are undeployed. This is the same class of error that file was written to correct. Several sibling files (program.ts:3-9, curve/index.ts:3-12, launcher/solana/README.md:236-238) already carry a corrected banner with the note 'This said the opposite for four days', so the pattern for the fix is established; these eight were missed.
  - *evidence:* README.md:31 'Status: **Phase 0 — devnet. NOT audited. NOT on mainnet. Holds no funds.**' · SECURITY.md 'Neither program is deployed to Solana mainnet. Neither holds user funds today.' · AUDIT_OUTREACH.md 'Neither program is deployed to any cluster and neither holds any funds today.' · AUDIT_RFQ.md:107 '**Not deployed.** Program ID is a documented placeholder' · TEGRIDY_FORK.md:11 'NOT ON MAINNET.

- **AUDIT_RFQ.md understates Scope B by roughly 3x and omits a second vendored upstream — it is a document meant to be sent for a quote** `[M]`
  - `solana/tegridy-amm/AUDIT_RFQ.md:65-73,107,138`
  - AUDIT_OUTREACH.md instructs the operator to attach this file when soliciting quotes from OtterSec/Neodyme/Sec3/Zellic. As written it hides an entire second curve mode and a second vendored Apache-2.0 upstream (Raydium CLMM) from the scope, which is exactly the kind of omission that produces a quote that has to be renegotiated.
  - *evidence:* '**1,170 production nSLOC** (2,528 raw lines … lib.rs 815, curve.rs 222, state.rs 78, errors.rs 55)'. Actual `wc -l`: lib.rs 1904, curve.rs 835, state.rs 307, errors.rs 88, plus segmented.rs 847 and src/vendor/ 1,495 — neither of the last two appears in the count or anywhere in the RFQ. The instruction list at line 72 omits `set_curve_segments`. Line 68 calls it 'A pump.fun-shaped bonding curve' (

- **OWN_CURVE_FRONTEND_CONTRACT.md documents create_launch as taking no arguments and never mentions set_curve_segments or curve modes** `[M]`
  - `docs/OWN_CURVE_FRONTEND_CONTRACT.md:277-282`
  - The document's own opening line calls it 'The single source every client surface … is built against'. A client built strictly from §2.3 would encode create_launch with an empty argument buffer and fail to deserialize. The document does carry a 'if a citation and the code disagree, the code wins' escape hatch, but 'Args: none' and the missing instruction are factual gaps, not citation drift.
  - *evidence:* §2.3 states '**Args: none.** Supply, virtual reserves, fee, target and reserve are all read from `global`'. The program signature is `pub fn create_launch(ctx: Context<CreateLaunch>, mode: u8)` (lib.rs:625) and ix.ts:310-313 correctly encodes the mode byte. `grep -i 'segment|curve mode'` over the whole 943-line document returns zero hits, so `set_curve_segments` — a full instruction with its own A

- **SERVERLESS_BUDGET.md is stale by two functions and names a handler file that no longer exists** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/SERVERLESS_BUDGET.md:12`
  - This is the single document a contributor consults before adding an /api route. It currently authorises three additions that would break the deploy on the second one. That it drifted by two functions is itself evidence the "count stays <= 12" rule has no automated check.
  - *evidence:* Line 12 says "Current state (origin/main, 2026-06-01): 9 functions — 3 of headroom" and lines 16-25 enumerate them. The real count on mvp-launch is 11: `ls frontend/api` shows aggregator.js, alchemy.js, analytics.js, etherscan.js, opensea.js, orderbook.js, solrpc.js, supabase-proxy.js, auth/me.js, auth/siwe.js, v1/index.js. The doc omits analytics.js and solrpc.js entirely, and line 25 lists `api/

- **Four in-repo statements of the rate limiter's failure mode, none of which match the code** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/aggregator-proxy.js:217`
  - An operator reading .env.example:152 believes an unset UPSTASH_REDIS_REST_URL takes the API down and will treat Upstash as a blocking prerequisite; an operator reading alchemy.js believes it leaves the API unthrottled and will treat it as a security hole. Neither is true, and the two beliefs lead to opposite decisions.
  - *evidence:* _lib/ratelimit.js:19-33 is authoritative and explicit (PROD OUTAGE FIX 2026-06-09): "Upstash missing OR erroring -> DEGRADED MODE: per-instance in-memory fixed-window enforcing the SAME { limit, windowSec }", and checkRateLimit's JSDoc at line 234 says "neither 503s". Contradicting it: (a) _lib/aggregator-proxy.js:217 — "Rate limit (Upstash). Fails closed in production via _lib/ratelimit.js." (b) 

- **v1/index.js's route list omits erc20scan — the only route actually in use** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/v1/index.js:5`
  - The header is the file's index and it omits the route with the widest input surface and the separate credential requirement — the one a reader most needs to know exists.
  - *evidence:* The header block at lines 5-11 enumerates six routes (collections, listings, floor, holders, activity, token). `erc20scan`, implemented at line 154 and the only route with an in-app caller (src/lib/scanner/ethereumAdapter.ts:220), is not listed. It is also the only route accepting an address outside ALLOWED_CONTRACTS (line 143 exempts it) and the only one needing ETHPLORER_API_KEY (line 156).

- **supabase-proxy.js's docstring understates the surface by two tables and two methods** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/supabase-proxy.js:8`
  - This is the only write path to the database and its docstring describes about 60% of it. The RPC branch injects the verified wallet server-side (line 361, closing the F714 spoof) — a security-relevant behaviour the documented contract gives no hint of.
  - *evidence:* Lines 8-13 document the contract as `{ table, method, body, match }` with table in "messages | user_profiles | user_favorites | user_watchlist | votes" and method in "INSERT | UPDATE | DELETE | UPSERT". The code allows seven tables (line 54 adds dm_messages and push_subscriptions), six methods (line 145 adds SELECT and RPC), and two further body fields the docstring never mentions: `fn` (line 142,

- **aggregator.js's header contradicts its own body about the rewrite shape and the function count** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/aggregator.js:17`
  - A reader hitting line 18 first will look for a nested rewrite that no longer exists and may recreate the routing bug the file's own line 309 records as fixed. Two contradictory accounts of the same mechanism, 290 lines apart in one file.
  - *evidence:* Lines 3-19 date to 2026-05-27 and say "Net: 15 -> 9 functions" (line 12; it is 11 now), "the 7 aggregator proxies" / "the 7 per-aggregator catchalls (cow, kyber, lifi, odos, openocean, paraswap, swapapi)" (lines 4, 10-11; jupiter makes 8, added at line 157), and "URL paths preserved via vercel.json rewrites (/api/odos/:path* -> /api/aggregator/odos/:path* etc.)" (lines 17-19). The actual rewrite i

- **push.js falls back to a VAPID subject on a domain that cannot receive mail** `[S]` **[OPERATOR]**
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/push.js:22`
  - The VAPID subject is the contact address push services use to reach you about deliverability problems. It only bites once push is enabled, which needs the operator to generate the key pair — so fold the subject fix into that change rather than doing it alone.
  - *evidence:* _lib/push.js:22 defaults VAPID_SUBJECT to "mailto:ops@tegridyfarms.vercel.app" — a vercel.app deployment alias, not a mail domain. .env.example:194-195 already records this: "VAPID_SUBJECT unset -> 'mailto:ops@tegridyfarms.vercel.app', which is a stale domain. Set it to a monitored address." Because .env.example:196-198 leaves VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY blank, ensureConfigured() (line 21

- **TegridyStaking bytecode headroom eroded 239 B → 22 B; the CI allowlist comment still says 24,337 B** `[S]`
  - `contracts/src/TegridyStaking.sol`
  - TegridyStaking is live at 0xcaDc93E96De58EA554c71ca609974625615E046D and is on the redeploy list (see the src-vs-chain drift item). At 22 B, the next one-line fix makes the redeploy artifact undeployable, and the gate that is supposed to catch that will still be green. The comment a future engineer reads will tell them they have 239 B.
  - *evidence:* Local artifact contracts/out/TegridyStaking.sol/TegridyStaking.json deployedBytecode = 24,554 B (measured with the exact method .github/workflows/contracts-ci.yml:135-138 uses). EIP-170 is 24,576 → 22 B of headroom. The allowlist comment at .github/workflows/contracts-ci.yml:116-119 says "TegridyStaking — 24,337 B (measured 2026-07-24): 239 B under EIP-170", and contracts/foundry.toml:20-22 says "

- **RESOLVED 2026-08-19 — CORRECTION: docs/RESTAKING_EIP170_SPLIT_DESIGN.md prescribed the approach that WORKED. This entry was wrong — do not act on it** `[S]`
  - `docs/RESTAKING_EIP170_SPLIT_DESIGN.md`
  - The prediction recorded here — that anyone following the doc "lands roughly nowhere — a day-plus of the wrong work" — did not hold, and its instruction to supersede the doc with the 36-selector list pointed at a landing point 167 B over the limit. The sister move **alone** reclaimed **4,670 B** (26,784 → 22,114 B), roughly **twice** the 2,208 B the host was over. The doc was executed essentially verbatim in `c749c933` and now opens with an EXECUTED status header carrying the measured sizes. It remains the plan of record: read it, do not route around it.
  - *evidence:* the disproven premise was that the sister move is "logic extraction — the lever the 2026-08-08 byte-attribution pass showed is exhausted"; the measured result contradicts it (host 22,114 B, 2,462 B under EIP-170; `TegridyRestakingAdmin` 9,298 B; `RestakingMonitorView` 2,275 B — `forge build --sizes`, 2026-08-19). Two as-built deviations from the design are recorded in the doc's own deviation note: only the `*Proposed`/`*Cancelled` events moved to the sister (the five `*Executed` events stay on the host, emitted at the site that performs the write, so an execution log cannot appear without the state change), and the deprecated revert stubs `setBonusRewardPerSecond(uint256)` / `sweepStuckRewards(address)` were deleted outright rather than carried over. Only §5.8, the mandatory external re-audit, is still open.

- **Six live mainnet contracts are absent from the canonical address registry, and two live ones are filed as retired** `[S]`
  - `frontend/scripts/addresses.json`
  - This is exactly the failure the registry's own $comment says it was built to prevent, and exactly the truncation hazard that once produced a fabricated 33-byte Solana pubkey. The two mis-filed rows are worse than absence — they actively tell an operator that a live governance contract is dead. All eight addresses are recoverable today from the receipts; that will not stay true (see the untracked-receipts item).
  - *evidence:* Diffed all 61 addresses in CONTRACTS.md (verified 2026-08-06 by cast read-back) against frontend/scripts/addresses.json (ethereum + retiredDeploys + denylist). Absent entirely: GaugeController 0x6c79522D47Cf6d1051Cb474E81d9b6f3996c1054, VoteIncentives 0x6e1dCB7EBD16E09edb574F414aDc664B2A5E21AF, VoteIncentivesAdmin 0xf87Ec231BA7FA3975619309bc16C698B2ea3B300, TegridyNFTLendingAdmin 0x693787831e9C36A

- **Five places assert a contracts/src file does not exist when it does** `[S]`
  - `frontend/src/lib/constants.ts`
  - These comments are the first thing anyone reads when asking "where did the governance contracts go", and they say the code was deleted. It was not — it is live, and un-gating is a constant edit, not a rebuild. One of them (extract-missing-abis) also blocks ABI regeneration on a false premise.
  - *evidence:* frontend/src/lib/constants.ts:53, :57, :59, :65 and :73 each carry "ZEROED 2026-05-31 (relaunch; no src contract, not in DeployMVP)" for GaugeController, CommunityGrants, MemeBountyBoard, VoteIncentives and TegridyLending. All five sources exist in contracts/src today (1,272 / 1,345 / 951 / 2,014 / 2,697 lines), all five have working deploy scripts, and four of the five are LIVE on mainnet per CON

- **Three broken contracts/src source links on the public /contracts page** `[S]`
  - `frontend/src/pages/ContractsPage.tsx`
  - The whole point of the page is provable source-to-address linkage; three of them 404. The TOWELI one is the nastiest because it renders fine for anyone developing on macOS or Windows and only breaks for the public.
  - *evidence:* frontend/src/pages/ContractsPage.tsx turns each entry's `source` string into a GitHub blob URL (:178, `${GITHUB_BASE}/${entry.source}`). Testing all 23 non-external paths with `test -f`: `contracts/src/TegridyFeeHook.sol` (:111) does not exist — the file is contracts/src/v4/TegridyV4Hook.sol; `contracts/src/TokenURIReader.sol` (TegridyTokenURIReader row) does not exist — it is contracts/src/Tegrid

- **The CI size-gate says the VoteIncentives admin split is "the eventual fix" — it shipped 2026-05-31** `[S]`
  - `.github/workflows/contracts-ci.yml`
  - Points the next person at work that is already done, and hides the real state: VoteIncentives is 99 B under EIP-170 with the admin lever already spent, so the next growth needs a different lever entirely.
  - *evidence:* .github/workflows/contracts-ci.yml:120-121: "VoteIncentives — 24,274 B … Admin-function split into VoteIncentivesAdmin is the eventual fix." That comment was written 2026-07-23 (commit 751018fc). contracts/src/VoteIncentivesAdmin.sol was added 2026-05-31 (commit 3b457872) and already holds every propose/execute/cancel triplet, all pending state and all six timelock keys; the host retains only the 

- **TegridyNativeBuyRouter's header says it has not been compiled — CI has been compiling it for months** `[S]`
  - `contracts/src/TegridyNativeBuyRouter.sol`
  - The draft gate is correct and should stay; only the compile claim is wrong, and it is the one thing in the header a reader could actually verify. Fixing it costs one line and stops the whole header reading as unmaintained.
  - *evidence:* contracts/src/TegridyNativeBuyRouter.sol:10-12: "has NOT been compiled (the local forge build hangs in this environment — CI is the compile source of truth), fork-tested, or externally audited." The contracts-ci build job runs `forge build --skip test --skip script` (contracts-ci.yml:92), which compiles ALL of contracts/src — the file has a current artifact at 4,609 B and is inside the bytecode si

- **VerifyMVP.s.sol's env-var docstring lists a variable the script never reads** `[S]`
  - `contracts/script/VerifyMVP.s.sol`
  - An operator building the env block from the docstring will set a variable that does nothing, and may go hunting for a restaking address that does not exist. One-word fix, but VerifyMVP is the pre-launch gate whose whole premise is that partial-green is unacceptable.
  - *evidence:* contracts/script/VerifyMVP.s.sol:31 lists RESTAKING among the required env vars. Line 48 is `// RESTAKING deferred to Phase 7 (C1) — not part of the MVP deploy/verify set.` and no vm.envAddress("RESTAKING") call exists. Line 11 already removed the import for the same reason. The docstring is the only place that was missed.

- **23 `// Location: TegridyStaking.sol:NNN` annotations in FinalAudit_Staking.t.sol all point at the wrong lines** `[S]`
  - `contracts/test/FinalAudit_Staking.t.sol:103`
  - Anyone triaging one of these findings jumps to a line that has nothing to do with it. Either drop the line numbers and keep the function names, or regenerate them.
  - *evidence:* `grep -c "// Location: TegridyStaking.sol:" contracts/test/FinalAudit_Staking.t.sol` = 23. Spot-checked against the current 2792-line source: :755 (claimed `_settleRewardsOnTransfer` Claimed event) is a blank line; :232 (claimed the votingPower `>=` compare) is a docstring inside `interface ITegridyStakingJbacVault`; :77 / :78 (claimed MAX_BOOST_BPS / MAX_LOCK_DURATION constants) are a comment lin

- **Five more stale hard-coded source line references in test docstrings** `[S]`
  - `contracts/test/FRESH2026_F3_StakingJbacRestakerLookup.t.sol:31`
  - Same class as the FinalAudit_Staking item but in the newest test files, so the drift is ongoing rather than historical. Referencing a function name survives refactors; a line number does not.
  - *evidence:* FRESH2026_F3_StakingJbacRestakerLookup.t.sol:31 cites `FIX (TegridyStaking.sol:1086-1112)` — :1086-1090 is now the `_jbacTokenId == 0` strand guard; :33 cites `revalidateBoost lines 1303-1309` — that range is now a docstring about the 182-day boost clamp. FRESH2026_F4_StakingIncreaseAutoMaxLockOrder.t.sol:33 cites `FIX (TegridyStaking.sol:961-986)` — :961 is `modifier updateReward()`; :37 cites `l

- **PASS5 PoC header still describes the HIGH it was written for as open, with line numbers that moved** `[S]`
  - `contracts/test/pass5_pocs/PASS5_REV_H1_DistributeBypass.t.sol:8`
  - The only file-level header in the suite that still advertises a live HIGH. A reader grepping for open findings hits it first.
  - *evidence:* contracts/test/pass5_pocs/PASS5_REV_H1_DistributeBypass.t.sol:8-19 reads, in the present tense: "The sibling entrypoint `distribute()` is *also* permissionless and lacks the guard", "Sites: L296-298 distribute() -NO MIN_DISTRIBUTE_STAKE check / L309-320 distributePermissionless() -has the check", "Severity: HIGH". The guard is in place: contracts/src/RevenueDistributor.sol:438 declares `distribute

- **Halmos spec docstring claims `forge test` runs it; the slice manifest says the opposite and the manifest is right** `[S]`
  - `contracts/test/halmos/MVPLaunch_HalmosSpecs.t.sol:40`
  - The docstring is the reason someone would believe these six properties are still being checked. They are not checked by anything, and the results doc they'd fall back on predates several rewrites of the contract it proves things about.
  - *evidence:* contracts/test/halmos/MVPLaunch_HalmosSpecs.t.sol:40-41: "If halmos isn't installed locally, these files still compile and run under `forge test` as regular tests (without symbolic enumeration)." Every function in the file is `check_*` (:89, :105, :118, :127, :144, :163); forge's collector only picks up `test*`/`invariant_*`. .github/contracts-test-slices.json:88 states this correctly as the exclu

- **C1_RewardClusterRegression.t.sol calls itself scaffolding for a refactor that already shipped** `[S]`
  - `contracts/test/C1_RewardClusterRegression.t.sol:20`
  - The tests are still valuable — they are now the regression net for a landed refactor rather than a pre-flight scaffold — but the header tells a reader the extraction is still ahead, which changes how they'd treat a failure.
  - *evidence:* contracts/test/C1_RewardClusterRegression.t.sol:20: "These tests are the SAFETY SCAFFOLD for an upcoming refactor that moves the reward cluster into a delegatecall library." That library exists and is live: contracts/src/lib/StakingRewardLib.sol, described in contracts/foundry.toml:31 as "live reward-accounting cluster (May-24 C1)", and the cluster functions the header lists (_getReward, _settleUn

- **security.txt still declares the retired alias origin as canonical, three weeks after robots.txt and sitemap.xml were moved to memetic.fun** `[S]` **[OPERATOR]**
  - `frontend/public/.well-known/security.txt`
  - RFC 9116 says a `Canonical:` URI that does not match the URI the file was retrieved from should cause the file to be treated as suspect — so served from memetic.fun, this file is spec-invalid, which is the opposite of what a disclosure policy is for. Two-line fix. The TODO(owner) half is the operator's call and interacts with the docs agent's SECURITY.md finding — worth resolving both in one pass so the contact address is stated identically in both places.
  - *evidence:* The file carries `# https://tegridyfarms.vercel.app` (line 2), `Canonical: https://tegridyfarms.vercel.app/.well-known/security.txt`, and 'The dapp at https://tegridyfarms.vercel.app and its serverless API' in its in-scope list. Its two siblings were both corrected on 2026-08-07 with explicit rationale — robots.txt: 'was https://tegridyfarms.vercel.app/sitemap.xml — the alias origin, not the canon

- **sitemap.xml omits /curve-launch — the route its own header names as one of the Solana routes it was written to add** `[S]`
  - `frontend/public/sitemap.xml`
  - The own curve is the strategic rail and it is the one page search engines are not told exists. One `<url>` entry. Worth re-reading the 'not deployed placeholder' clause at the same time — if CurveLaunchPage still renders that state for another reason, the sitemap entry should wait, and the header should say so explicitly instead of leaving the reader to infer it.
  - *evidence:* The header's coverage rationale reads 'Not one Solana route was listed — no /solana, no /solana-launch, no /curve-launch.' The body then lists /solana and /solana-launch and stops. `grep -c curve-launch frontend/public/sitemap.xml` = 1, and that single hit is the comment. The route is real: App.tsx:59 lazy-imports CurveLaunchPage and App.tsx:226 mounts `<Route path="curve-launch">`. The header doe

- **The Certora harness is on no compile path, though its README says forge build typechecks it** `[S]`
  - `contracts/certora/harness/TegridyStakingHarness.sol`
  - The README's maintenance contract — 'when TegridyStaking storage layout shifts, the rules MUST be re-reviewed' — leans on a compile check that does not happen, so the harness can silently rot against the contract it wraps until the day someone pays for a Certora run. Either add certora/harness to the build (a `--contracts` path in one CI step) or correct the sentence. The second is honest and free.
  - *evidence:* contracts/certora/README.md, final section 'Maintenance contract': 'The CI `forge build` on this PR's branch typechecks the harness contract; the `.spec` file is text-only.' foundry.toml sets `src = "src"` and does not extend the compile paths, so forge compiles src/ + test/ + script/ only — certora/ is none of the three. Confirmed empirically: `ls contracts/out | grep -i TegridyStakingHarness` re

- **foundry.toml carries a 40-line bytecode-size ledger that is stale in the same way the CI allowlist comment is** `[S]`
  - `contracts/foundry.toml`
  - It is the same fact wrong in three places, and this is the copy a contributor reads first because it sits above the knob (`optimizer_runs = 200`) whose rationale it is explaining. Fix all three in one edit or the next size regression will be argued against whichever stale number the reader happened to open.
  - *evidence:* The contracts-src pass reported the stale 24,337 B figure against contracts/src/TegridyStaking.sol and the CI allowlist comment. There is a third and much longer copy nobody named: foundry.toml lines 6-50, which assert 'TegridyStaking: 24,337 B (~239 B headroom — FROZEN for launch)' — against the measured 22 B of headroom in that same finding — plus 'TegridyFactory: 12,133 B', 'SwapFeeRouter: 21,3

- **DEVELOPING.md tells developers to run `supabase start` / `supabase db push`, which cannot work here** `[S]`
  - `DEVELOPING.md:76`
  - This is the first thing a new contributor runs and the last place the real procedure is written down. The actual procedure — paste files into the Supabase SQL editor by hand, in an order the filenames do not give you — is documented only inside 014's and 015's headers.
  - *evidence:* DEVELOPING.md:76-79 documents the setup step. There is no frontend/supabase/config.toml — `git ls-files | grep -i config.toml` returns only contracts/lib/forge-std/test/fixtures/config.toml — and the Supabase CLI refuses to start without one. No package.json anywhere declares `supabase` as a dependency (`git grep '"supabase"' -- '**/package.json'` is empty). And per the item above, db push would a

- **The schema docstring in supabase.js is pre-SIWE and contradicts its own header** `[S]`
  - `frontend/src/nakamigos/lib/supabase.js:77`
  - This docstring is currently the closest thing the repo has to a definition of the `messages` table (see the base-schema item), so it will be read as authoritative — and the last thing it says is that the security model shipped in 001 hasn't shipped. Either promote the accurate parts into 000_base_schema.sql and delete the docstring, or cut it back to the 7 columns and drop the policy/function prose.
  - *evidence:* frontend/src/nakamigos/lib/supabase.js:11 opens "--- Required Supabase table schema (run this in the SQL editor): ---" and prints a toggle_like body with no JWT check — the version 001 replaced and 006 replaced again — then closes at :77-78 with "NOTE: Author identity is NOT cryptographically verified. For production, consider requiring an EIP-4361 (SIWE) signature". Lines 1-7 of the same comment 

- **trade_offers status enum comment lists a value the code never writes and omits two it does** `[S]`
  - `frontend/supabase/migrations/002_native_orders_trades_push.sql:73`
  - There is no CHECK constraint, so nothing breaks — but this comment is what anyone adding a status filter or a state machine will read, and it is wrong in both directions.
  - *evidence:* 002_native_orders_trades_push.sql:73 annotates the column `-- active|accepted|rejected|expired|cancelled`. `grep -ohE 'status: "[a-z]+"' frontend/api/orderbook.js | sort -u` yields accepted, active, cancelled, countered, declined, expired, filled. `countered` (orderbook.js:1937) and `declined` (:2033, with the declined_at column 007 added) are not in the comment; `rejected` appears nowhere in the 

- **supabase-backup.yml omits analytics_events and asserts a coverage guarantee that is false** `[S]`
  - `.github/workflows/supabase-backup.yml:103`
  - The day 013 is applied, the only table whose contents cannot be reconstructed from chain or from the user's wallet is the one not being backed up. The false comment also means the 404-tolerance policy rests on a premise that doesn't hold.
  - *evidence:* .github/workflows/supabase-backup.yml:103 sets TABLES to ten names; analytics_events (013) is not among them, and the surrounding comment derives the list only from orderbook.js and the proxy ALLOWED_TABLES — analytics writes through neither, so the "keep in sync" rule as written will never catch it. :105-109 then justifies an empty OPTIONAL_TABLES with "every table in the list above has a committ

- **src/index.ts asserts "Ponder requires a handler for every registered event", which the SweepETH gap contradicts** `[S]`
  - `indexer/src/index.ts:636`
  - Nobody knows which, because nothing runs the indexer — no CI job, no deploy. If the claim is true the service is unbootable and has been since the SweepETH ABI entries went in. Resolving item 12 settles this either way; until then the comment is a load-bearing assumption nobody has tested.
  - *evidence:* indexer/src/index.ts:636-637 reads "Ponder requires a handler for every registered event; POLAccumulator is in the MVP set." The item above shows three registered SwapFeeRouter events with no handler. Either the claim is false (the likely case — Ponder filters logs by handler registration) or it is true and `ponder dev` refuses to start.

- **Two OPERATOR TODOs in ponder.config.ts describe work already done** `[S]`
  - `indexer/ponder.config.ts:610`
  - These are the only two TODO markers in the whole area (`grep -rnE 'TODO|FIXME|HACK|XXX'` over indexer/*.ts, indexer/src and the migrations returns exactly these two lines). Both are false, and both tell a reader the subscription is inert when it is not.
  - *evidence:* ponder.config.ts:610-612 reads "OPERATOR TODO: replace 0x000... with the deployed TegridyStakingAdmin address after running the deploy script + setStakingAdmin wiring. Until then, this subscription is a no-op (matches no logs)." The default two lines down (:617) is 0x4B134C08aAF86B6e2A8E097D1039C4e7638806f3, annotated "relaunch StakingAdmin". Same shape at :625-626 vs the SwapFeeRouterAdmin defaul

- **The start-block comment describes a 24500000 floor and 'two legacy contracts' that no longer exist** `[S]`
  - `indexer/ponder.config.ts:495`
  - Two generations of comment stacked on top of each other, the older one describing state that the newer one already replaced. DEPLOY_RUNBOOK §6 was separately flagged years back for hard-coding this same 24500000 into a re-sync procedure.
  - *evidence:* ponder.config.ts:491-496 says per-contract blocks "replace the prior shared 24500000 floor" and that "Two legacy contracts (TegridyFactory) keep the conservative 24500000 floor until ops verify their broadcast files" — naming one contract, not two. `grep -n 24500000 indexer/*.ts` matches only lines 493 and 495; every start-block constant at :500-504 is 25263328, set by the RELAUNCH note directly b

- **ponder.config.ts claims the frontend renders pause banners from the pauseState table; the frontend has never read it** `[S]`
  - `indexer/ponder.config.ts:567`
  - These two comments are the stated justification for keeping subscriptions alive, and both describe a consumer that does not exist. They are why the directory reads as load-bearing when the dependabot block already established it is not — worth correcting before anyone weighs item 10.
  - *evidence:* ponder.config.ts:565-568 justifies the POLAccumulator_Pause subscription with "The frontend uses the pauseState table to render protocol-paused banners." `git grep -n 'pause_state\|pauseState' -- frontend/src frontend/api` returns nothing. The frontend calls `paused()` on-chain instead — frontend/src/components/farm/StakingCard.tsx and four other files. The neighbouring claim at :552-554, that wit

- **stakingAction.type comment omits the `transfer` value the handler writes** `[S]`
  - `indexer/ponder.schema.ts:31`
  - One word. Any consumer switching on this column from the comment will miss a whole action class — and this column is untyped text, so nothing else catches it.
  - *evidence:* ponder.schema.ts:31 annotates the column `// stake | withdraw | earlyWithdraw | claim | extend | increase`. src/index.ts:238 inserts `type: "transfer"` from the ERC-721 Transfer handler added by the 2026-05-26 H-24 fix. `grep -ohE 'type: "(stake|withdraw|earlyWithdraw|claim|extend|increase|transfer)"' src/index.ts | sort -u` confirms all seven are written.

- **DEVELOPING.md's indexer instructions use the wrong package manager and describe env vars the indexer does not read** `[S]`
  - `DEVELOPING.md:83`
  - Conflates the indexer with the Vercel /api functions, which have genuinely different config. Anyone following it installs against the wrong lockfile and then looks for RPC config in the wrong place. Small, but it is the only setup doc for this directory.
  - *evidence:* DEVELOPING.md:57 and :83-86 say `cd ../indexer && pnpm install` and `pnpm dev`; indexer/ ships package-lock.json (npm) and no pnpm-lock.yaml. The Env Var Reference at :103 describes the indexer's environment as "Indexer / API — inherited from the frontend Supabase keys plus a service-role key for the /api functions (Vercel env)" — the indexer reads no Supabase variable at all (see the env enumerat

- **docs/WAVE_0_TODO.md tells the operator to acceptOwnership on three DEPRECATED contracts, one of which MIGRATION_HISTORY calls a permanent brick** `[S]`
  - `docs/WAVE_0_TODO.md (§3, lines 59-64)`
  - The most dangerous doc in my area. It is a tick-box checklist explicitly designed to be pasted into a GitHub issue and executed, and six other live docs point at it (NEXT_SESSION.md:39, FIX_STATUS.md:878, DEPLOY_CHEAT_SHEET.md:208, DEPLOY_RUNBOOK.md:49, docs/WAVE_0_RUNBOOK.md:11, docs/SECURITY_DEFERRED.md:12 and :16). Retiring it with a SUPERSEDED banner pointing at MIGRATION_HISTORY + SAFE_REHOME_RUNBOOK fixes the whole cluster.
  - *evidence:* Lines 59-64: "Multisig `0x0c41e76D2668143b9Dbe6292D34b7e5dE7b28bfe` must call `acceptOwnership()` on ... TegridyLPFarming `0xa7EF7…`, TegridyNFTLending `0x0540…`, GaugeController `0xb93264aB…`" — all three unchecked `[ ]`. docs/MIGRATION_HISTORY.md:102 (verified on-chain 2026-08-06) says of that exact GaugeController: "Deprecated — **DANGEROUS** … `pairToGauge(address)` **REVERTS** … `VoteIncentiv

- **docs/SAFE_REHOME_RUNBOOK.md still warns of a 0xA360 "time bomb" that its own companion doc closed on 2026-07-19** `[S]`
  - `docs/SAFE_REHOME_RUNBOOK.md (§4.1 line 70; §4.2 header; line 178)`
  - README's roadmap gate #1 names this file as THE runbook for the single biggest outstanding risk. An operator opening it sees a fabricated emergency at the top and may rush the Safe rebuild — the opposite of what §2 and §3 correctly tell them to do slowly. Add a header note: windows cancelled 2026-07-19; the real residual is NFTPoolFactory `0xbB8E…6F5B` (still owner=0xA360, ctor-direct, never had a window) plus the nine un-re-homed contracts.
  - *evidence:* §4.1 line 70: "Their 14-day windows do NOT expire until ~2026-07-30 — as of today (2026-07-18) they are STILL OPEN (~12 days left) and 0xA360 could call `acceptOwnership()` on any of them right now." §4.2 header repeats "Gated batch (Wave-2, windows OPEN until ~2026-07-30 — act before expiry)". Line 178: "**The still-open 0xA360 window (time bomb).** … If you do nothing, 0xA360 could seize them." 

- **README calls docs/GOLIVE_HANDOFF.md "Current" but it covers 8 of ~20 owned contracts — the entire 2026-07-16 batch is missing** `[S]`
  - `docs/GOLIVE_HANDOFF.md (title line; line 3 table)`
  - An operator following the doc README calls "Current" re-homes 8 contracts, verifies them green, announces decentralization, and leaves eleven contracts on the deployer key. Either fold it into SAFE_REHOME_RUNBOOK or relabel it "Wave-1 subset only, dated 2026-07-11".
  - *evidence:* Title: "verified on-chain 2026-07-11". Line 3: "All 8 owned contracts" then a table of exactly 8 (Staking, StakingAdmin, TWAP, RevenueDistributor, SwapFeeRouter, SwapFeeRouterAdmin, POLAccumulator, ReferralSplitter). docs/SAFE_REHOME_RUNBOOK.md §4.2 lists those 8 plus TegridyFactory, TegridyLPFarming, and nine Wave-2 contracts (GaugeController, NFTLending+Admin, VoteIncentives+Admin, CommunityGran

- **docs/LAUNCHER_GOLIVE_CHECKLIST.md says the launcher gate is SHUT; the flag has read `true` since 2026-07-21** `[S]`
  - `docs/LAUNCHER_GOLIVE_CHECKLIST.md (line 5; §0; §1; §2; final "Flip:")`
  - §1 lists three "Hard gates — ALL must pass before un-gating", including Safe re-homing. None passed, and the launcher went live anyway. The doc records a bypassed gate as an unmet one, so nobody can tell from the docs whether the bypass was a decision or an accident. Mark EXECUTED with the date and which gates were waived.
  - *evidence:* Line 5: "Compiled 2026-07-17. **Nothing here is live; the code is committed and gated.**" §0: "**Gate is SHUT:** `config.ts` `LAUNCHER_ENABLED = false`, integrator = zero address. `/launch` renders the 'SOON' placeholder." Actual `grep -n` on frontend/src/lib/launcher/config.ts: line 22 `export const LAUNCHER_ENABLED = true;`, line 32 `LAUNCHER_INTEGRATOR_ADDRESS = '0xD355A072d6bBbA275DBD83A3149f6

- **docs/GATED_DEPLOY_RUNBOOK.md has no DONE banner — the batch it describes deployed 2026-07-16** `[S]`
  - `docs/GATED_DEPLOY_RUNBOOK.md (line 8 status; §0 prerequisite 2)`
  - Reads as pending work. Worse, its stated precondition was violated in the real deploy and the doc records neither fact, so the next gated batch can repeat it. Add an EXECUTED banner plus a line on what was waived.
  - *evidence:* Line 8: "Status (2026-07-15): all 9 gated deploy scripts pre-deploy-audited + hardened … **8 GO + LaunchpadV2 GO, 0 blockers.**" README's Live-deployment-status: "✅ **Gated-feature batch deployed on-chain 2026-07-16** (11 contracts, all Etherscan-verified)", with every address listed. §0 prerequisite 2 says "the **`MULTISIG`** below MUST be the rebuilt 3-of-N governance Safe … Don't deploy with th

- **README contradicts itself on LockerClaimer: deployed and wired in one section, "wired to nothing" in the roadmap** `[S]`
  - `README.md (line 599 vs lines 315-320)`
  - Two mutually exclusive statements about the same contract in one file, 284 lines apart, on the question of whether launcher revenue can reach stakers. A reader gets the opposite answer depending on where they stop.
  - *evidence:* README.md:315-320: "That gap is now closed. [`LockerClaimer`] is **deployed and Etherscan-verified** at `0xD2Ac3dC13c6fd09855F0e4a077826983Aa66E6C7` … Its permissionless `claim(tokenId)` pulls from the locker and pushes the ETH leg to `RevenueDistributor`." README.md:599 (Medium-term roadmap): "**`LockerClaimer` adoption** — the small contract that would let the launcher's 15% fee line reach TOWEL

- **README's E2E warning quotes a grep whose output changed — the anvil money-path CI job now exists** `[S]`
  - `README.md (lines 445-455)`
  - This is a self-verifying claim — it publishes the command so a reader can check it — and the command no longer reproduces. Understating your own coverage is a smaller sin than overstating it, but it is still wrong, and it is the kind of claim CI could pin.
  - *evidence:* README.md:445-455: "⚠️ **The browser E2E suite does not cover the money paths.** A full run reports **44 skips** … No pipeline supplies an Anvil fork today: `grep -rn ANVIL .github/` returns **two lines, both comments**. A green E2E run proves the interface renders, not that a transaction works." Running that exact grep today returns **five** lines, three of them live YAML: `.github/workflows/ci.y

- **README repo-layout counts are wrong: 106 test files (actual 116), 7 frontend scripts (actual 10)** `[S]`
  - `README.md (lines 420, 472, 479)`
  - Small, but these are the numbers a reader spot-checks first to decide whether the rest of a very long README is trustworthy. Cheap to make CI-checkable alongside the existing frontend/src/lib/docsAddressTruth.test.ts pattern.
  - *evidence:* README.md:472 "└── test/  **106 test files**"; `find contracts/test -name '*.sol' | wc -l` = **116** (top-level `ls contracts/test/*.sol | wc -l` = 94). README.md:479 "├── scripts/  **7 build/operator CLIs**"; `ls frontend/scripts/` shows 10 executables (capture-airlock-selectors, capture-locker-selectors, csp-hash, extract-missing-abis, make-operator-keypair, migrate-art-imgs, run-e2e-with-anvil,

- **CONTRIBUTING.md tells contributors to branch from and PR against `main`; README says that is the wrong branch** `[S]`
  - `CONTRIBUTING.md (lines 58, 60)`
  - README hands a new contributor to CONTRIBUTING.md, which immediately gives the instruction README just warned against. A PR opened against `main` either 63-file-conflicts or pushes a months-old tree toward the branch Vercel treats as Production.
  - *evidence:* CONTRIBUTING.md:58 "**Branch** from `main` using a descriptive name"; :60 "**Push** your branch and **open a PR** against `main`." README.md:458-461 (§Contributing, the section that links here): "See [CONTRIBUTING.md]. Branch off **`mvp-launch`** — it is the real trunk and the repo's default branch; `main` has diverged substantially (a merge is a 63-file conflict)." docs/DEVELOPING.md §"Developing

- **FAQ.md describes three product surfaces that do not exist, and routes readers to two fossil trackers** `[S]`
  - `FAQ.md (§How do I become a creator; §How do I refer; §What's the grant program; §Who controls the multisig)`
  - The 2026-08-12 pass correctly hardened the fee and multisig answers in this file but did not touch the four product answers around them, so it now mixes carefully-verified paragraphs with invented UX. A user follows "generate a referral link from your profile page" and finds no profile page.
  - *evidence:* §"How do I become a creator?": "Creators apply via the in-app creator portal with a sample collection, social links, and a short pitch" — `grep -rni "creator portal|apply as a creator" frontend/src/` returns nothing; no such route in App.tsx. §"How do I refer?": "Generate a referral link from your **profile page** … Referral rebates are **claimable weekly from the dashboard**" — there is no `/prof

- **docs/COMMUNITY_LAUNCH.md's ready-to-post public copy points at the wrong domain and at the stale `main` branch** `[S]`
  - `docs/COMMUNITY_LAUNCH.md (lines 86, 101, 115, 315; Tweet 2)`
  - This is copy "a stranger will post under their own name" — the doc's own words. A launch tweet pointing at the non-brand vercel.app alias and a `blob/main` audit link is a public, hard-to-retract error, and the 08-12 pass shows the file is treated as ship-ready.
  - *evidence:* Line 86 (Twitter bio draft), line 101 ("**Website:** `https://tegridyfarms.vercel.app`"), line 115 (Tweet 1: "🌾 tegridyfarms.vercel.app") and line 315. README's badge row and body use **memetic.fun** as the app ("Live at memetic.fun"), and frontend/vercel.json redirects `www.memetic.fun` → `memetic.fun`. Tweet 2 links `github.com/fomotsar-commits/tegridy-farms/blob/**main**/AUDITS.md` — README:459

- **V2_ROADMAP.md presents completed work as an open backlog, and ROADMAP.md feeds off it** `[S]`
  - `V2_ROADMAP.md (items 4, 5, 6, 8, 13, 14)`
  - Five of fifteen backlog items are done and one names a dead key. WORKORDER_V2 already flags #5/#6 as needing re-verification — the right instinct applied to the wrong file. Strike the shipped items or fold the live ones into WORKORDER_V2 and delete this.
  - *evidence:* Last commit 2026-04-05. Item 4 "Add `increaseAmount()` to TegridyStaking — Users currently can't add tokens to existing positions" — contracts/src/TegridyStaking.sol:1348 defines `function increaseAmount(uint256 tokenId, uint256 _additionalAmount) external`. Item 8 "Deploy tokenURI reader contract" — TegridyTokenURIReader live at `0x5cfEe751eAf274F68b05267012b85a867dfCd326` (constants.ts:78). Item

- **docs/USER_VALUE_ROADMAP.md's TL;DR lists four live surfaces as dark and one nonexistent contract as usable** `[S]`
  - `docs/USER_VALUE_ROADMAP.md (§TL;DR, lines 14-18)`
  - Wrong in both directions in one sentence: four shipped revenue surfaces reported as switched off, and restaking offered against a contract that has never been deployed. Its "highest-leverage single move — re-lights ~9 features" framing is the doc's whole thesis, and five of the nine are already lit.
  - *evidence:* Line 14: "the `isDeployed()` gate zeroes nine surfaces for the relaunch: **LP Farming, Gauge voting, Community Grants, Meme Bounty, Vote Incentives, Premium, ERC-20 Lending, NFT Lending, NFT-AMM/Launchpad**. What a user can do *today*: buy TOWELI (swap), stake/lock, **restake**, claim ETH revenue, set a referrer." README's Live-deployment-status: LP Farming live since 2026-06-08; NFT lending, NFT 

- **docs/ARCHITECTURE.md's "Notes & open questions" tail names a deleted contract and claims gauge voting is live in the UI** `[S]`
  - `docs/ARCHITECTURE.md (§Notes & open questions; footer)`
  - README's Deeper-docs table sends developers, integrators and auditors here. The stale footer date is the specific trap: a reader who checks the date correctly discounts the whole file, including the freshly-verified fee-flow section that is the best thing in it.
  - *evidence:* `git show 63f83136 -- docs/ARCHITECTURE.md` shows the 2026-08-12 pass rewrote only the §Fee flow prose and diagram; the tail is untouched. It says: "**`TegridyFeeHook` (Uniswap V4 hook)** has source in-repo but no deploy script" — `ls contracts/src/TegridyFeeHook.sol` → not found; the V4 hook is contracts/src/v4/TegridyV4Hook.sol and README says it is **pre-deployed** to mined address `0xB6cf…0044

- **REVENUE_ANALYSIS.md's lever table still says "100 % → RevenueDistributor → stakers" three lines from where the same claim was corrected** `[S]`
  - `REVENUE_ANALYSIS.md (line 14 lever #1 and the "same" cell on lever #2; header lines 3-6)`
  - The 08-12 honesty sweep explicitly targeted this class of claim in this file and missed the table right above the text it fixed. Anyone scanning the lever table — the most quotable artifact in the doc — gets the pre-correction number.
  - *evidence:* `git show 63f83136 -- REVENUE_ANALYSIS.md` shows the 2026-08-12 pass rewrote the §"Revenue out" bullet and the §4 calibration row to "~80 % end-to-end" with the ReferralSplitter explanation. It did not touch the §1 table. Line 14 (lever #1) and the identical "same" cell on lever #2 still read: "Who receives | **100 % → `RevenueDistributor` → stakers** (pro-rata TOWELI lock-weighted)". Separately, 

- **WORKORDER_V2.md's serverless-budget ground rule is off by one and omits a function; its own follow-up task is still undone** `[S]`
  - `WORKORDER_V2.md (ground rule 5, line 18; ground rule 7(d); line 31)`
  - This is the live work order, corrected on 2026-08-12, and the budget number is the one that fails a deploy when wrong. "Two slots" invites someone to add two routes; the second breaks the build.
  - *evidence:* Ground rule 5: "the branch is at **10/12** Vercel Hobby functions (aggregator, alchemy, auth/me, auth/siwe, etherscan, opensea, orderbook, solrpc, supabase-proxy, v1/index) — not 9/12. **Two slots of headroom.**" `find frontend/api -maxdepth 2 -name '*.js' -not -path '*_lib*' -not -path '*__tests__*'` returns **11**: the ten listed plus `frontend/api/analytics.js`. So it is 11/12 with **one** slot

- **docs/MULTISIG_MIGRATION.md prescribes one Safe; docs/SAFE_REHOME_RUNBOOK.md prescribes three disjoint ones and calls the current Safe unfit — neither links the other** `[S]`
  - `docs/MULTISIG_MIGRATION.md (line 3; §0 "When to do this")`
  - Two 300+ line custody runbooks for the same irreversible operation giving structurally different designs, with the older cited by name inside the newer for its key rules. "Done incorrectly, it can brick admin authority permanently" — its own words. Add a SUPERSEDED-for-topology banner that keeps the key-management sections it is cited for.
  - *evidence:* MULTISIG_MIGRATION.md line 3: "How to hand ownership of every Tegridy Farms contract from a single deployer EOA to **a Safe multisig, in one coordinated pass**." §0: "**Before** the protocol holds meaningful user TVL … The sweet spot is **the relaunch window itself** … See [RELAUNCH_RUNBOOK.md § Stage E]" — the relaunch shipped 2026-06-06 and the migration did not happen. docs/SAFE_REHOME_RUNBOOK.

- **docs/SECURITY_DEFERRED.md's top two "requires external action" items both target things that no longer exist** `[S]`
  - `docs/SECURITY_DEFERRED.md (§TegridyFeeHook stranded ownership; §Multisig acceptOwnership on 3 contracts; §Stray files at repo root)`
  - A deferred-security register is only useful if its entries are still real. Two of its four external-action items point at deleted code and dead addresses, which makes a reader distrust the two that remain accurate (the TWAP custom-oracle and NFT-AMM Sudoswap-fork entries).
  - *evidence:* Item 1 "TegridyFeeHook stranded ownership — Status: live but broken … Fix: redeploy with `_owner` … Already queued in docs/WAVE_0_TODO.md" — `ls contracts/src/TegridyFeeHook.sol` → not found; the V4 module is contracts/src/v4/ (6 files). Item 2 "Multisig `acceptOwnership` on 3 contracts … await acceptance from `0x0c41e76D…`" — the dead Wave-0 set. §"Stray files at repo root": "25 Markdown files … 

- **docs/DEPRECATED_CONTRACTS.md names a deprecated address as the canonical successor and omits every Wave-0 and legacy-staking address** `[S]`
  - `docs/DEPRECATED_CONTRACTS.md (§Deprecated — replaced by a canonical version)`
  - Its stated purpose is "so that off-chain tooling doesn't mistake them for canonical state" — and it points the reader at an unpaused legacy vault as the current one, which is exactly the failure it exists to prevent. MIGRATION_HISTORY.md now does this job correctly; cheapest fix is to reduce this file to a pointer.
  - *evidence:* "`TegridyStaking@0x65d8b8…a421` — v1, paused after Spartan C-01 finding; **superseded by `0x626644…4819`**". docs/MIGRATION_HISTORY.md (verified 2026-08-06) marks `0x626644523d34B84818df602c991B4a06789C4819` as "Legacy — **WITHDRAW-ONLY** … **Was previously listed here as CANONICAL, which it is not.** Still holds user positions and is **unpaused**, so it will accept a deposit — never route stake/a

- **docs/SOLANA_FEE_CAPTURE_PLAN.md says the swap surface is gated off and the fee wallet is a Squads multisig — both wrong** `[S]` **[OPERATOR]**
  - `docs/SOLANA_FEE_CAPTURE_PLAN.md (line 3 status; §Operator activation runbook step 1)`
  - The one custody fact an operator would rely on this doc for — "the Solana fee account is a multisig" — is false in production, and the doc reads as if the runbook has not been executed. Record the actual activation date and the single-key deviation, or the next person plans a Squads-based sweep against a key that is not one.
  - *evidence:* Line 3: "**Status:** Surface A **SHIPPED** to `mvp-launch` (2026-06-18), **gated OFF until activated**" and "Ships DARK behind `isSolanaConfigured()`". README §Solana surface: "**Swap fee-capture (live in the app)** — memetic.fun routes Solana swaps through the Jupiter aggregator with a small platform fee that accrues to a Tegridy Solana fee account." §"Operator activation runbook" step 1: "Create

- **docs/SWAP_REVENUE_ARCHITECTURE.md's problem statement and open decisions were both resolved months ago** `[S]`
  - `docs/SWAP_REVENUE_ARCHITECTURE.md (line 3 status; §The problem this resolves; §Open decisions)`
  - Linked from README's Deeper-docs table as "Swap/liquidity revenue design". A reader takes away that the fee rail cannot collect — the opposite of the current, more interesting truth (it collects and cannot distribute).
  - *evidence:* Line 3: "Status: **framework draft, 2026-06-07.** Canonical reference for how the protocol earns on swaps." Core premise: "`SwapFeeRouter.router` points at the **internal TegridyRouter**, not real Uniswap, so it can only execute on our own (thin/empty) pools — **it reverts, and can't skim a fee** on deep-liquidity swaps." docs/MIGRATION_HISTORY.md (2026-08-06/08-12): SwapFeeRouter is CANONICAL and

- **AUDIT_FINDINGS.md presents April "🔴 BLOCKERS (ship-stopping)" against deploy scripts that no longer exist — and AUDITS.md sends diligence readers straight to it** `[S]`
  - `AUDIT_FINDINGS.md (§🔴 BLOCKERS, B1; line 162)`
  - A prospective depositor or auditor is explicitly told to read this file, and it opens with ship-stopping blockers against a codebase that was fully redeployed six weeks later. Add a closure banner — AUDIT_FINDINGS_2026_05_16.md and AUDITS_2026_100AGENT_RESOLUTION.md both do this correctly and are the model.
  - *evidence:* §"🔴 BLOCKERS (ship-stopping)" B1: "Four deploy scripts still point to the **old** staking address `0x65D8b879…Ea421`, not the new `0x626644…4819`: `contracts/script/DeployGaugeController.s.sol:8`, `DeployV3Features.s.sol:18`, `DeployTokenURIReader.s.sol:8`, `WireV2.s.sol:35`". `ls` → three of those four scripts do not exist, and *both* addresses in the finding are now deprecated (canonical staking

- **FIX_STATUS.md's outstanding-items tail lists a nonexistent script, a resolved TOKENOMICS placeholder, and a superseded migration number** `[S]`
  - `FIX_STATUS.md (line 1; tail §outstanding items, around lines 870-895)`
  - AUDITS.md and FAQ.md both cite it as a current tracker. Its remaining-work list is the part a reader acts on, and four items are either impossible (deleted script) or already done.
  - *evidence:* Line 1: "Running log of what's landed on `main`" (trunk is mvp-launch). Tail items still listed as outstanding: "**Run `DeployTegridyFeeHook.s.sol`** (CREATE2 miner)" — `ls contracts/script/DeployTegridyFeeHook.s.sol` → not found; "**Apply Supabase migration 002**" — the live ledger runs to 015 with 005 applied 2026-08-12; "**Finalise [TOKENOMICS.md] allocation** — still 'TBD placeholder' on mainn

- **SECURITY.md tells reporters to "Use email" after the project retired all its email addresses, and routes them to two superseded runbooks** `[S]` **[OPERATOR]**
  - `SECURITY.md (lines 7, 10, 19, 51; §See also)`
  - A researcher with a live finding reads "Use email", finds no address, and either gives up or files publicly — the one outcome the file exists to prevent. The security.txt at frontend/public/.well-known/security.txt (per docs/SECURITY_TOOLING.md) is where a real channel should be reconciled.
  - *evidence:* Line 7: "**Preferred channel:** the community channels linked on our site" (commit cd859ccf retired `security@`/`conduct@tegridyfarms.xyz` "-> community channels"). Line 19, same page: "Please do NOT open public GitHub issues for security vulnerabilities. **Use email.**" Line 10 also says "please **email** the team via our community channels" — there is no email address anywhere in the file. §"See

- **docs/OPEX.md's Vercel row says 9 serverless functions; there are 11, and the doc it cites still says 9 too** `[S]` **[OPERATOR]**
  - `docs/OPEX.md (lines 76-77; line 111 nakamigos.gallery)`
  - The function count determines whether the next deploy succeeds, and three docs now disagree with reality in the same direction. The nakamigos.gallery credentialed-CORS exposure is the more serious item and is genuinely unresolved — worth re-checking the registration status before anything else in this file.
  - *evidence:* Line 76: "Used by | The entire frontend and all **9 serverless functions**"; line 77: "Hobby: **12-function cap (main = 9, see `frontend/api/SERVERLESS_BUDGET.md`)**". Actual count is 11. SERVERLESS_BUDGET.md still reports 9 as of "origin/main, 2026-06-01". Line 111 (nakamigos.gallery): "**currently DOWN (ECONNREFUSED as of 2026-06-11)**" with detection listed as a gap — two months on, the state i

- **docs/SOCIAL_PREVIEW_SPEC.md specifies an asset path that does not exist and duplicates a live OG pipeline** `[S]`
  - `docs/SOCIAL_PREVIEW_SPEC.md (line 4; §Implementation Notes)`
  - An unbuilt spec pointing at two nonexistent asset paths, sitting alongside a working OG pipeline it does not mention. Either wire it to frontend/public/og.svg as the source of record or delete it.
  - *evidence:* Line 4: "Exported asset lives at `docs/og-preview.png`." `ls docs/og-preview.png` → not found; `ls docs/` contains only banner.png and banner.svg. The real OG assets are frontend/public/og.png + frontend/public/og.svg, generated by scripts/render-og-png.mjs, and docs/COMMUNITY_LAUNCH.md's Twitter section correctly says "Header image: use `frontend/public/og.png`". §Implementation Notes asks for a 

- **docs/DEVELOPING.md prescribes pnpm, a broken typecheck command, and a 55-test-file suite that is now 116** `[S]`
  - `docs/DEVELOPING.md (§Prerequisites; §Running the frontend; §Running the contracts; §Developing a new feature)`
  - Every setup command in the canonical developer-onboarding doc uses a package manager the repo does not use, and the typecheck command it teaches is the one the README explicitly documents as silently passing.
  - *evidence:* "**pnpm 9+** (or `npm` — commands below use pnpm)" and every command block uses `pnpm install` / `pnpm dev` / `pnpm exec tsc --noEmit`; `ls pnpm-lock.yaml` → not found, while package-lock.json and frontend/package-lock.json exist. "`forge test` — run all **55+ test files**" — `find contracts/test -name '*.sol' | wc -l` = 116. "`pnpm exec tsc --noEmit`" is the form README:432-443 documents as check

- **DESIGN_H2_COMMIT_REVEAL_VOTING.md is still labelled "design proposal, not implementation" — commit-reveal shipped 2026-04-18** `[S]`
  - `DESIGN_H2_COMMIT_REVEAL_VOTING.md (line 3 status)`
  - A shipped feature's spec still reads as a proposal, so anyone auditing whether H-2 was actually closed gets a "not implemented" banner from the primary design document. One-line status change.
  - *evidence:* Line 3: "**Status:** design proposal, not implementation." Root DEPLOY_RUNBOOK.md:225: "~~**H-2 commit-reveal voting** — design spec in `DESIGN_H2_COMMIT_REVEAL_VOTING.md`, not implemented.~~ **CLOSED 2026-04-18** — commit-reveal voting is now LIVE on `GaugeController` … Tests in `GaugeCommitReveal.t.sol` (14 tests) cover the closure." AUDITS.md's remediation table: "H-2 bribe arbitrage (commit-re

- **API_INDEXER_AUDIT.md audits an 8-function API surface that has since been restructured entirely** `[S]`
  - `API_INDEXER_AUDIT.md (line 3 scope/date)`
  - Presented at repo root as a current domain audit. Low urgency on its own — the fix is a dated "superseded, surface restructured" banner so nobody re-derives findings against routes that no longer exist.
  - *evidence:* Line 3: "**Scope:** `frontend/api/**` (**8 Vercel serverless functions**) + `indexer/` … **Date:** Apr 17, 2026." The surface today is 11 handlers with a fundamentally different shape: an 8-provider aggregator catchall reached via vercel.json rewrites, a `?resource=` dispatch pattern, plus analytics.js, solrpc.js and v1/index.js — none of which existed in April. Its SIWE findings predate migration

- **frontend/src/lib/launcher/README.md documents a 10-file, 54-test directory that is now 27 modules and 456 tests** `[S]`
  - `frontend/src/lib/launcher/README.md:30`
  - This is the first thing anyone opening the directory reads, and it contradicts itself twice and the code four times. A newcomer would conclude the launcher is pre-go-live and the SDK is not installed.
  - *evidence:* The file (unmodified since 2026-07-17) lists 10 files at :13-26 and claims "**54/54 launcher tests green.**" at :30. Actual: 27 non-test modules, 27 test files, 456 `it(` cases — attestation, afterlife, airlock, birthNotify, birthRecord, cohortLogSource, covenant, discovery, integratorFees, launchBuy, launchService, lockerStream, notifyBirth, ourLaunches, radarClient, tokenDossier and all of solan

- **solana/README.md still says the Solana page has "no signer and no submit path — that is the design, not an omission"** `[S]`
  - `frontend/src/lib/launcher/solana/README.md:203`
  - Same failure mode the repo already apologises for twice (curve/index.ts:7-9 and tegridy-launch-operator.mjs:16-19, both about a banner that stayed wrong for four days): a stale 'this cannot spend money' claim tells a reviewer to stop reading exactly where a signing path now lives.
  - *evidence:* frontend/src/lib/launcher/solana/README.md:203 heading reads "## Gating + wizard integration (preview page LIVE; no in-app submit)"; :205-212 says "/solana-launch renders a config PREVIEW with no signer and no submit path" and "It has **no signer and no submit path** — that is the design, not an omission." It does submit: pages/SolanaLaunchPage.tsx:45 imports submitLaunch, :282 destructures sendTr

- **curve/read.ts still calls the live PROGRAM_ID a placeholder, and program.ts calls the live cp-swap fork undeployed** `[S]`
  - `frontend/src/lib/launcher/solana/curve/read.ts:119`
  - Both mis-state WHY graduation is blocked. A reader of program.ts:41 concludes the AMM program is not deployed; the real blocker is that the deployed bytecode carries the wrong admin::ID (#281), so AmmConfig is uncreatable without a program upgrade — a different task, owner and cost. read.ts:119 sits directly above readDeployment, the function whose whole point is that a comment cannot know what is deployed and an account read can.
  - *evidence:* frontend/src/lib/launcher/solana/curve/read.ts:119 — "`PROGRAM_ID` is a placeholder (lib.rs:97-101) and returns `null` on mainnet-beta" — contradicted by curve/program.ts:31-35, which pins PROGRAM_ID to the mainnet deploy of 2026-08-08 (slot 438,055,726), and by curve/index.ts:3-5. Separately, curve/program.ts:40-41 — "/** The cp-swap fork a launch graduates into. Mainnet id — NOT yet deployed. */

- **launcher/config.ts header describes the pre-go-live world its own next comment contradicts** `[S]`
  - `frontend/src/lib/launcher/config.ts:3`
  - Four lines, self-contradicting within twenty, in the file every gating question starts at.
  - *evidence:* frontend/src/lib/launcher/config.ts:3-6 — "The launcher un-gates ONLY after all three launch gates pass: core-loop go-live -> Safe re-homing -> TOWELI liveness. Until then LAUNCHER_ENABLED stays false and the page renders the standard 'SOON' placeholder". :22 is `export const LAUNCHER_ENABLED = true;` and its own doc comment (:15-21) records the 2026-07-22 go-live and the operator's explicit waive

- **heatOracle.ts points at docs/HEAT_LAUNCH_GATE.md, which does not exist** `[S]`
  - `frontend/src/lib/heat/heatOracle.ts:72`
  - The pointer is load-bearing: it is the cited record for why the 180-day tenure floor was retired in favour of degrees — the most consequential and most re-litigated decision in the heat subsystem. Repoint it at docs/HEAT_WAVE_TWO.md or write the doc.
  - *evidence:* frontend/src/lib/heat/heatOracle.ts:72 — "See docs/HEAT_LAUNCH_GATE.md for the full record of that reversal." `ls docs/ | grep -i heat` returns only HEAT_WAVE_TWO.md, and `grep -rn 'HEAT_LAUNCH_GATE' frontend/src docs api` finds this one reference and no file.

- **tegridy-launch-operator.mjs says its logic lives in a file that does not exist** `[S]`
  - `frontend/scripts/tegridy-launch-operator.mjs:8`
  - Reported because it is a broken pointer INTO this area from its only live operator entry point — an operator following it finds nothing and has no map of curve/. One-line fix.
  - *evidence:* frontend/scripts/tegridy-launch-operator.mjs:8 — "the pure logic it drives lives in `src/lib/launcher/solana/tegridyLaunch.ts`" (and :63 refers to it again). `find frontend/src -name 'tegridyLaunch*'` returns nothing; `ls frontend/src/lib/launcher/solana/` is dbc.ts, dbcClient.ts, liveConfig.ts, squads.ts, submitLaunch.ts, curve/. The logic is in curve/ — the same file's :12-13 correctly says "`PR

- **discovery.ts describes a future adapter that shipped, and its stated purpose (feeding enrichment) is unrealized** `[S]`
  - `frontend/src/lib/launcher/discovery.ts:11`
  - Low stakes, but it makes the data flow unreadable: the module named 'discovery' is documented as the seam into enrichment and is in practice a display mapper for a separately-labelled market-wide surface whose honesty boundary radarClient.ts:9-13 is careful to police. Retitle the header to what it does, or actually route discovered baselines into enrichment.
  - *evidence:* frontend/src/lib/launcher/discovery.ts:11-14 — "a caller (a **future** thin adapter behind the aggregator catchall, mirroring launcher-outcomes.js) does the fetch". That adapter exists: frontend/api/_lib/launch-radar.js, fronted by radarClient.ts:56 (LAUNCH_RADAR_ENDPOINT). More substantively, discovery.ts:1-9 states its purpose as producing "the CONSUMED launch list (LaunchBaseline[]) the outcome

- **TEGRIDY_LP_CREATED_AT is still the interim placeholder its own comment flags for the operator** `[S]` **[OPERATOR]**
  - `frontend/src/lib/constants.ts:39`
  - Two months of pool age now sit on an assumed date, so any fee-APR or average-daily-volume figure derived from it is off by however far the real first mint was from midnight 2026-06-08. Resolvable with one archive read of the first Mint event on the pair 0x55875887B43C2E23aE424AF0FC8606Fdb058a481.
  - *evidence:* constants.ts:36-39: "Pair first-mint timestamp (unix seconds) — used for fee-APR / avg-daily-volume pool-age math. Interim = the 2026-06-08 LP relaunch date; OPERATOR: replace with the pair's actual first-mint block timestamp once known." The value is still `Math.floor(new Date('2026-06-08T00:00:00Z').getTime() / 1000)`. Consumed by usePoolTVL.ts.

- **towelieKnowledge tells users CSV export is "coming soon" — it shipped** `[S]`
  - `frontend/src/lib/towelieKnowledge.ts:269`
  - The in-app assistant is the surface a user asks "can I export my history?" on, and it answers no about a feature that is one click away on the page it just pointed them at.
  - *evidence:* towelieKnowledge.ts:269: "Dashboard → History tab (or just /history) for your full tx log. Filter by type, export coming soon." HistoryPage.tsx:286-288 renders `<button onClick={exportCSV} … title="Export transactions as CSV">Export CSV</button>`.

- **towelieKnowledge says the Launchpad tab "un-gates when it redeploys" — it redeployed 2026-07-16** `[S]`
  - `frontend/src/lib/towelieKnowledge.ts:191`
  - Same class as the CSV one: the assistant understates a shipped feature on exactly the question a prospective creator asks. The file has a good track record of dated honesty passes (2026-06-11, 07-19, 07-24, 08-07) — this entry just missed the 07-16 batch.
  - *evidence:* towelieKnowledge.ts:191: "Launchpad lets project owners create gated NFT collections with a wizard. Built and internally reviewed (no third-party audit yet); the NFT Finance → Launchpad tab un-gates when it redeploys." constants.ts:90-93 sets TEGRIDY_LAUNCHPAD_V2_ADDRESS = 0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7, "RELAUNCH 2026-07-16 gated batch". navConfig.ts:64-71 therefore has NFT_FINANCE_AD

- **tokenList.ts still lists MATIC, superseded by POL in 2024, and two logo assets are orphaned** `[S]`
  - `frontend/src/lib/tokenList.ts:105`
  - A user selecting "MATIC / Polygon" from the default swap list gets routed against a deprecated token's thinning pools. Either swap the entry to POL or drop it. The two orphan PNGs are leftovers from earlier list entries — trivial, but they are shipped bytes.
  - *evidence:* tokenList.ts:105-111 lists `{ address: '0x7D1AfA7B718fb893dB30A3aBc0Cfc608AaCfeBB0', symbol: 'MATIC', name: 'Polygon' }` in DEFAULT_TOKENS. That is the legacy MATIC ERC-20; Polygon migrated to POL (0x455e53CBB86018Ac2B8092FdCd39d8444aFFC3F6) in September 2024 and liquidity moved with it. Separately, public/tokens/ contains dot.png and mana.png with no matching entry in DEFAULT_TOKENS — I diffed th

- **solana.ts carries two "that's a later batch" parentheticals for work that landed, and duplicates the wSOL/USDC mints** `[S]`
  - `frontend/src/lib/solana.ts:17`
  - Three names for one mint (SOL_MINT / SOL.mint / WSOL_MINT) across two of my files plus the launcher, and comments describing shipped work as pending. solanaTokenList's SOL/USDC entries should reference the constants in solana.ts, which it already imports from at line 9.
  - *evidence:* solana.ts:17-18: "(A Solana RPC WILL need one when the wallet + swap UI lands; that's a later batch.)" — the RPC proxy constant is defined nine lines below at :30 and SolanaSwapPage ships. solana.ts:55: "Canonical mainnet mints (the curated allowlist lands with the swap UI)" — solanaTokenList.ts landed and its own header (lines 4-6) explains it is deliberately no longer an allowlist. Duplication: 

- **useNfts's pagination comment names the Analytics tab as the full-load trigger — Analytics is never passed loadAll** `[S]`
  - `frontend/src/nakamigos/hooks/useNfts.js`
  - This comment is the documented answer to "how does a 20,000-token collection ever fully load?", and it points at a tab that neither triggers the load nor is reachable on desktop. It sends the next reader in the wrong direction on the rarity problem.
  - *evidence:* hooks/useNfts.js:98-100: "Auto-load remaining tokens only for small collections (< 1000 supply). For larger collections, users trigger via Analytics tab or trait filter expansion". App.jsx:755 renders `<Analytics tokens={nfts.allTokens} stats={stats} activities={activities} listings={listings} onPick={setSelected} />` — no loadAll, no hasMore. The tabs that actually receive loadAll are Listings (A

- **lib/notifications.js's header advertises notification types that do not exist** `[S]`
  - `frontend/src/nakamigos/lib/notifications.js`
  - The file header is the first thing anyone reads when extending notifications, and two thirds of its type list is aspiration presented as spec.
  - *evidence:* lib/notifications.js:5-11 lists six notification types: floor price alerts, outbid alerts, whale activity, sale confirmations, "Prediction market results", "Points milestone achievements". There is no prediction market and no points system anywhere in frontend/src/nakamigos — grep finds neither term outside this comment. What the module actually supports is one on/off push subscription per wallet 

- **lib/supabase.js cites the wrong migration for the toggle_reaction anon revoke** `[S]`
  - `frontend/src/nakamigos/lib/supabase.js`
  - Migration 005 was applied to prod on 2026-08-12 while 010/011 sit in the unapplied set, so this comment tells an operator the reaction path is hardened in prod when it may not be. Wrong-number citations in migration comments are exactly what the migration ledger exists to prevent.
  - *evidence:* lib/supabase.js:303-306: "the anon RPC trusted its `wallet` arg (spoofable as any wallet) and migration 005 revokes anon EXECUTE so the proxy is the only call path." The revoke is in 010_reaction_auth_hardening.sql:34-35 and re-applied in 011_reaction_jwt_binding.sql:80-82. supabase/migrations/005_add_seaport_order_hash.sql contains no REVOKE and no mention of toggle_reaction. (The sibling comment

- **supabase.js and userdata.js embed full DDL/RLS in doc comments that duplicate — and now contradict — the migration files** `[S]`
  - `frontend/src/nakamigos/lib/userdata.js`
  - Two of the three schema-carrying modules describe a pre-hardening world, and the RLS state is the single most load-bearing unknown before login day. Replacing both blocks with the notifications.js pointer costs minutes and removes a contradiction from the exact files someone will read while reasoning about 014/015.
  - *evidence:* lib/supabase.js:11-81 is a 70-line commented CREATE TABLE / triggers / policies / RPC block for `messages`; lib/userdata.js:12-80 is the equivalent for user_profiles, user_favorites and user_watchlist. Both still present the permissive forms — userdata.js:24 `CREATE POLICY "Anyone can read profiles" ... USING (true)`, :40 "Anyone can read favorites", :60 "Anyone can read watchlist" — which are pre

- **The keyboard-shortcut single-source-of-truth is stale in both directions** `[S]`
  - `frontend/src/nakamigos/lib/shortcuts.js`
  - The one shortcut that changes global app behaviour (Lite↔Pro) is the one nobody is told about, in a file whose whole purpose is preventing that. And App.jsx:152 asserts a correspondence that hasn't held since deals/portfolio joined the nav — which is also the thread that leads to the unreachable Analytics tab.
  - *evidence:* lib/shortcuts.js:1-9 claims to be the one listing "so they can't drift from each other — or from the real handler in App.jsx" and enumerates the handled keys as "TAB_KEYS = '1'..'6'; j/k, Enter, Escape, g, f, c, s, /, m, ?". It omits Ctrl/Cmd+Shift+P, which App.jsx:522-527 handles (`toggleTradingMode()`), and neither KeyboardHelp.jsx nor About.jsx:344-347 shows it — `grep -n 'Shift|Ctrl|Cmd'` acro

- **RisksPage tells users four governance contracts "are not deployed at all" — the same repo verified on 2026-08-12 that they are deployed and unpaused** `[S]`
  - `frontend/src/pages/RisksPage.tsx:37`
  - The Risks page is where the protocol's honesty posture lives; a demonstrably false factual claim there is worse than the risk it was written to disclose. The correct wording already exists two files away.
  - *evidence:* pages/RisksPage.tsx:37 body text: "The contracts that remain unredeployed — gauge voting, vote incentives, grants, meme bounties, and ETH lending — are not running old bytecode either: they are not deployed at all." CommunityPage.tsx:25-52 records the opposite from live `eth_getCode`/`paused()` reads on 2026-08-12, with full checksummed addresses (0xeBC3aaf4…, 0x6D2C6EC2…, 0x6e1dCB7E…, 0x6c795 22D

- **ContractsPage renders the four deployed governance contracts as "awaiting deployment" — contradicting CommunityPage on the same site** `[S]`
  - `frontend/src/pages/ContractsPage.tsx:129-132`
  - A visitor who clicks /community then /contracts gets two opposite answers about whether the same four contracts exist. ContractEntry already supports a `status` + `note` pill (:57-63, used for 'redeploy'/'multisig'), so a 'deployed, not wired' status is an in-pattern fix.
  - *evidence:* pages/ContractsPage.tsx:129-132 lists Gauge Controller / Vote Incentives / Community Grants / Meme Bounty Board with their constants.ts values, which are 0x0; `undeployed` at :183 therefore renders the `title="Address not yet assigned — contract awaiting deployment"` treatment at :256 and the legend at :356 ("Not part of the relaunch deployment"). CommunityPage.tsx:62-79 links the very same contra

- **Five copy surfaces still say the ETH fee-share "opens when the native pool goes live" — the pool is deployed and the rail has earned** `[S]`
  - `frontend/src/pages/FAQPage.tsx:21`
  - "Not live yet" and "live but too shallow to win quotes" are different products with different risk profiles, and the app says both. The shallow-pool wording already exists in-repo; this is a copy alignment, not new writing. (Cross-check the exact fee-earned figure against the operator's measured on-chain read before restating any number.)
  - *evidence:* pages/FAQPage.tsx:21 ("switches on when the native pool goes live"), :30 ("activate once the native pool is live"), :41 ("That ETH stream starts flowing when the native pool launches"), pages/HomePage.tsx:81 ("opens with the native pool"), pages/TokenomicsPage.tsx:183 ("once the native pool is live"). But constants.ts:33-35 hold real factory/router/LP addresses, and two surfaces already use the ac

- **Both issue-template contact links 404 (wrong org and wrong repo spelling), and blank issues are disabled** `[S]`
  - `.github/ISSUE_TEMPLATE/config.yml:1-8`
  - With blank issues off, these two links plus the bug/feature forms are the entire intake surface. A security reporter following the config's own advice lands on a 404 — and ISSUE_TEMPLATE/security.md tells them not to file publicly, so the dead link is the whole path.
  - *evidence:* ISSUE_TEMPLATE/config.yml points at https://github.com/tegridy-team/tegriddy-farms/security/policy and .../discussions. Remote is fomotsar-commits/tegridy-farms — wrong org, and `tegriddy-farms` (double-d) is not the repo name either. `blank_issues_enabled: false` on line 1.

- **PR template asks contributors to run `npm run typecheck`, which does not exist, and to rebase on `main`** `[S]`
  - `.github/pull_request_template.md (Tests + Checklist sections)`
  - The equivalent real command is `npm run precommit` (lint + `tsc -b --noEmit`) — and `-b` is load-bearing per ci.yml:44-54, so a contributor who improvises `tsc --noEmit` type-checks zero files and reports it as passing. That is the exact bug ci.yml just fixed.
  - *evidence:* pull_request_template.md line under Tests: "Frontend typecheck + lint pass locally (`npm run typecheck`, `npm run lint`)". frontend/package.json scripts are dev/build/lint/preview/test/test:watch/test:e2e/test:e2e:ui/e2e/precommit/analyze — no `typecheck`. Checklist also says "Branch is rebased on latest `main`" while every workflow targets [main, mvp-launch] and mvp-launch is trunk.

- **contracts/slither.config.json's _severity_floor describes a CI gate that was never built that way** `[S]`
  - `contracts/slither.config.json:38 (_severity_floor key)`
  - This is the auditor-handoff config. It tells a reader the gate is a jq grep in a workflow that does not contain one, and names a step as "TBD" that shipped two years of commits ago in a different file. An auditor calibrating on it mis-models what CI actually blocks.
  - *evidence:* contracts/slither.config.json line with `_severity_floor`: "CI severity gate is enforced by jq-grepping the JSON output for impact==High|Medium (see .github/workflows/contracts-ci.yml — Slither step TBD)." contracts-ci.yml contains no slither step (grep for slither across it returns nothing); the gate lives in slither.yml:86 as the action's `fail-on: medium`.

- **scripts/diff-addresses.ts points the operator at a script that is not in the repo, and is superseded by verify-addresses** `[S]`
  - `scripts/diff-addresses.ts:5,45-58,83,94`
  - Still cited as the canonical post-redeploy step by docs/DEPLOYMENT.md:44, docs/WAVE_0_RUNBOOK.md:204, FIX_STATUS.md:896 and NEXT_SESSION.md:185. An operator following the runbook hits an error telling them to run a file that does not exist, for two of forty addresses, when the bidirectional guard already covers all of them.
  - *evidence:* Its header (line 5) and both failure messages (lines 83, 94) tell the operator to run `scripts/redeploy-patched-3.sh`. `git ls-files "*.sh"` returns only contracts/deploy-mvp.sh plus vendored lib/ scripts — no redeploy-patched-3.sh anywhere. Header line 6 says it reads "the three broadcast JSONs"; TARGETS (lines 45-58) holds two. It covers 2 addresses; frontend/scripts/addresses.json tracks 39 Eth

- **og.png / banner.png are four months behind the SVG that was edited yesterday, and nothing regenerates or checks them** `[S]`
  - `scripts/render-og-png.mjs + frontend/public/og.png + docs/banner.png`
  - og.png is the social preview prod actually serves to crawlers that reject SVG. It is a nearly-four-month-old rasterization of a source edited yesterday. contracts-ci.yml:229-240 already has exactly the right pattern for this — regenerate, `git diff --quiet`, fail on drift — for abi-supplement.ts; the same nine lines would arm this. Regenerating is one command (@resvg/resvg-js is already a root devDependency).
  - *evidence:* `git log -1 -- docs/banner.svg` → 63f83136, 2026-08-12 (yesterday's #300 buildout). `git log -1 -- frontend/public/og.png` and `-- docs/banner.png` → 9b6e7daa, 2026-04-18. `git log -1 -- frontend/public/og.svg` → 36a84b1f, 2026-04-28. `npm run render-og-png` exists (package.json:7) and grep across .github/ finds no workflow that calls it.

- **render-og-png.mjs docstring recommends the unpinned npx install audit R058 removed, and pnpm in an npm repo** `[S]`
  - `scripts/render-og-png.mjs:11-17,51`
  - The script's own error path hands an operator an unpinned, unchecksummed supply-chain fetch as the recommended route, for a dependency the repo already declares. R058's fix either never landed on this branch or was reverted — worth knowing which, since R058 claims other files too.
  - *evidence:* Lines 13 and 51 both print `npx --yes -p @resvg/resvg-js@2 node scripts/render-og-png.mjs`, labelled "Recommended (zero install)". Line 16 says `pnpm add -Dw @resvg/resvg-js`. .audit_101/remediation/R058.md:26-36 records this exact hint as remediated ("replaced with pnpm install + node"). The repo is npm (package-lock.json at root and in frontend), @resvg/resvg-js is already in root devDependencie

- **contracts-ci.yml's cache comment describes a v4.2.0 pin; the pin is v6.1.0** `[S]`
  - `.github/workflows/contracts-ci.yml:69-74`
  - The comment argues for staying on a v4 line the repo left two majors ago, so the next reader either trusts a wrong constraint or spends time re-deriving it. Trivial to fix, and the same block is the only documentation of why the pin moves at all.
  - *evidence:* contracts-ci.yml:69-74 — "CI fix 2026-05-17: bumped from v4.0.2 SHA … to v4.2.0 SHA. Keeps SHA pinning for supply-chain safety while staying on the supported v4 line." — immediately above `uses: actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0`. The same SHA appears uncommented at contracts-ci.yml:359, :539 and solana-ci.yml:205, :273.

- **gitleaks.yml comment justifies the GITHUB_TOKEN binding by v2 behaviour; the action is pinned to v3.0.0** `[S]`
  - `.github/workflows/gitleaks.yml:32-39`
  - The env binding may still be needed, may not — the recorded reason no longer describes the pinned version, so nobody can tell without re-testing. Same class as the cache comment: the justification and the pin have drifted apart, and the justification is what survives review.
  - *evidence:* gitleaks.yml:34-37 — "gitleaks-action@v2 hard-requires GITHUB_TOKEN on pull_request events (it fetches the PR's commit list via the API before scanning)" — above `uses: gitleaks/gitleaks-action@e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e # v3.0.0`.

- **registry-onchain.yml's header instructs work that has already been done** `[S]`
  - `.github/workflows/registry-onchain.yml:18-24`
  - Half the instruction is complete, the job is still red for the other half (see the expect.funded item), and the header no longer explains why. A reader hitting the red check reads a note about a stale registry entry that is no longer stale and concludes the check is out of date.
  - *evidence:* registry-onchain.yml:18-24: "As of 2026-08-12 the registry's `deploy-authority` … is recorded as 'live, funded … 3.53 SOL left' and does not exist on mainnet … Either fund it, or correct the registry." The registry HAS been corrected — addresses.json now reads "🔴 EMPTY. getAccountInfo returns value:null … The previous text here said '3.53 SOL left. Keep it funded' and was stale."

- **tegridy-launch-operator.mjs prints a placeholder location that is off by 13 lines and contradicts itself** `[S]`
  - `frontend/scripts/tegridy-launch-operator.mjs:562`
  - Operator-facing output on the one command (`status`) an operator runs to decide whether the live program is the real deploy or the throwaway. Two different line numbers for the same constant in the same file is exactly the kind of small wrongness that makes someone distrust the rest of the report.
  - *evidence:* Line 562 prints "(PLACEHOLDER from lib.rs:101)"; line 499 of the same file says "the throwaway from lib.rs:114". `grep -n 'declare_id!' solana/tegridy-amm/programs/tegridy-launch/src/lib.rs` → 114. The comment block at 268-274 documents fixing the semantics of this exact label but left the line number.

- **PRs #280 and #282 are stacked on base branches whose own PRs already MERGED — merging either lands nothing on trunk** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/scripts/verify-addresses.mjs`
  - Two PRs that look actionable in the queue but would merge into abandoned branches. Each needs an explicit decision: retarget to mvp-launch (which surfaces a large conflicting diff) or close.
  - *evidence:* #280 base = claude/address-registry; `gh pr list --state all --head claude/address-registry` → "#274 MERGED feat(ops): one registry for every protocol address" (merged 2026-08-08T21:43:47Z into mvp-launch). #282 base = claude/solana-creator-split; → "#277 MERGED feat(solana): two curve modes on audited math" (merged 2026-08-08T19:06:39Z into mvp-launch). GitHub did not auto-retarget because both b

- **PR #280's substance already landed in trunk — only SOLANA_WELL_KNOWN is unique to it** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/scripts/verify-addresses.mjs (line 326)`
  - Saves re-doing a merge that would mostly regress. Harvest the SOLANA_WELL_KNOWN denylist map as a small standalone commit, then close #280 rather than retargeting 776 lines of overlap.
  - *evidence:* Trunk's frontend/scripts/verify-addresses.mjs (31,741 B) already contains everything #280 claims to add: `async function onchain()` at line 326, the fail-closed rationale at lines 351-354 ("`--onchain` could not fail on any input, ever"), `eth_getCode` at 437, Solana `getAccountInfo` at 422, and both base58 regression tests at 549/551 including "the 2026-08-08 fabricated address still decodes to 3

- **PR #265 is green, clean, one commit, and has sat unmerged for 8 days** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/src/lib/launcher/solana`
  - The only open PR with no blocker of any kind. Genuinely wanted work sitting in the queue purely from neglect, drifting further behind trunk every day.
  - *evidence:* `gh pr view 265`: base=mvp-launch, MERGEABLE/CLEAN, every check SUCCESS, one commit 09c3b48c "feat(solana): catch a bad metadata URI while it is still free to fix". Branch claude/launcher-polish is 1 ahead / 32 behind, last commit 2026-08-04.

- **Three tracked run-latest.json files point at April 2026 deploys with different addresses than the live contracts** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/broadcast/DeployGaugeController.s.sol/1/run-latest.json`
  - Seven tracked docs tell readers to source addresses from run-latest.json (DEPLOY_CHEAT_SHEET.md:70, docs/DEPLOYMENT.md:64, docs/LAUNCHPAD_V2_ARCHITECTURE.md:210, docs/SAFE_REHOME_RUNBOOK.md:99, CONTRACTS.md:5, docs/MIGRATION_HISTORY.md:5). For these three scripts that instruction hands out a superseded address — and SAFE_REHOME_RUNBOOK uses them to decide ownership transfers.
  - *evidence:* Parsed each tracked run-latest.json: DeployGaugeController → 2026-04-18, CREATE 0xb93264ab0af377f7c0485e64406be9a9b1df0fdb; DeployNFTLending → 2026-04-18, 0x05409880adfea888f2c93568b8d88c7b4aadb139; DeployVoteIncentives → 2026-04-19, 0xa5a974dac4b9f8168cd3fac727997e66522f5b43. The live July addresses are 0x6c79522d…, 0x89beb6cc…, 0x6e1dcb7e…. frontend/scripts/addresses.json already carries the war

- **.gitignore states a falsehood about dotfiles, and three scratch directories are one `git add -A` from being committed** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.gitignore (lines 39-41)`
  - The comment teaches the next contributor a wrong rule, and the two directories it names as safely-excluded are in fact staged-ready. Fix is two real ignore lines plus a corrected comment — but it must NOT ignore .audit_2026_freshlook/, whose contents genuinely belong in git.
  - *evidence:* .gitignore lines 39-41 read: "If a genuine scratch / working buffer needs to stay out, prefix with a leading dot (e.g. `.audit_findings.md`, `.spartan_unpacked/`) which is already covered by general dotfile conventions." Git has no such convention. Proof: `git check-ignore -v .spartan_unpacked/word/document.xml` → no match; same for .audit_diffs/full.diff and .audit_2026_freshlook/fix_review/agent

- **origin/main is dead as code but is still a production deploy path** `[S]` **[OPERATOR]**
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.git/refs/remotes/origin/main`
  - main carries zero unlanded work but per the operator's own live-exposure note it still deploys to Vercel Production — any push ships a 2026-07-23 build. Order matters: repoint Vercel's production branch to mvp-launch in the dashboard FIRST, then delete or lock main. Deleting first would break that deploy path rather than fix it.
  - *evidence:* `git rev-list --left-right --count origin/main...origin/mvp-launch` = 10 / 719; last commit 2026-07-23 e74417aa. All ten main-only commits (#73 #75 #76 #77 #78 #96 #97 #99 #100 #102) are content-present in trunk — four spot-checks: scripts/check-interface-selectors.mjs exists in trunk at 21,863 B (#102); scripts/extract-missing-abis.mjs is ABSENT from trunk, so #97's consolidation landed; contract

- **Two untracked planning documents describe work that has since completed** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/contracts/DEPLOY_REVENUE_FEATURES_RUNBOOK.md`
  - The runbook is worse than useless — it names an exclusion list the actual deploy ignored, so anyone reconstructing what shipped gets the wrong answer. Neither file is tracked, so neither is findable by grep on a clean clone. Delete both, or fold the runbook's verified pre-flight table into docs/MIGRATION_HISTORY.md as history.
  - *evidence:* OPEN_PR_TRIAGE_2026_06_01.md (4,291 B, 2026-06-02) triages "10 PRs open against `main`" — #71, #74, #72, #34, #61, #68, #62, #63, #59, #25 — all long closed, against a branch now 719 commits behind. contracts/DEPLOY_REVENUE_FEATURES_RUNBOOK.md (5,101 B, 2026-06-08) is a pre-flight runbook whose scope reads "deploy these: TegridyLaunchpadV2, TegridyNFTPoolFactory, TegridyNFTLending, TegridyLending,

- **WORKORDER_V2.md Phase 3 still lists as open two items that are now done** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/WORKORDER_V2.md (Phase 3, from line 80)`
  - This file is the canonical hygiene work order and already carries [v1-STALE]/[v1-WRONG] markers for exactly this drift, so the convention exists — two more entries need it. Otherwise the next person re-verifies finished work.
  - *evidence:* Item 3 says ".skip-broken/: all 6 files → DELETE" — `git ls-files .skip-broken | wc -l` = 0, already gone. Item 5's sub-clause "[NEW] Fix FUNDING.yml — it still invites donations to the compromised-era wallet" — .github/FUNDING.yml was disabled 2026-07-28 with an eleven-line rationale and the address commented out. Item 1 (root bloat: CODEBASE dumps + tegridy_100_findings_unpacked/ + 12 root image

- **CurveWriteClient is documented as living in `curveClient.ts`, a file that does not exist** `[S]`
  - `frontend/src/pages/CurveLaunchPage.tsx:66-67`
  - Naming drift that sends whoever implements item 5 to a nonexistent file.
  - *evidence:* 'The write seam is `CurveWriteClient` in curveClient.ts'. Repo-wide grep for `curveClient` returns only this comment. The interface actually lives in `frontend/src/lib/launcher/solana/curve/rpc.ts:291`, and line 653 of the same page correctly says 'See curve/rpc.ts's CurveWriteClient' — the two comments in one file disagree.

- **TEGRIDY_FORK.md records a TRUNCATED admin address and states the mainnet authorities are unset when they are committed** `[S]`
  - `solana/tegridy-amm/TEGRIDY_FORK.md:26,31`
  - The repo's own doctrine is that a truncated address is never recorded, because one was previously reconstructed into a 33-byte fake. This table has four of them, and its prose contradicts the source it claims to describe on the single most fund-sensitive constant in the fork.
  - *evidence:* Line 26: `| admin::ID — lib.rs | GThUX1…hFMJ | GgE6AfEH…Wq5a (devnet) |` — every address in that table is elided with `…`. Line 31: 'The mainnet values are set to the Squads multisig / treasury by the operator before mainnet.' Committed reality (cp-swap/src/lib.rs:75,88): `admin::ID` non-devnet = `Dcjink4RGNUBpRVV4AX8mzxNLpUF2ik5h8Em6usv7kZ7`, `create_pool_fee_reveiver::ID` = `2sa31zceMSTAAbSu5wfS

- **solana/tegridy-amm/README.md still tells you to clone Raydium's repo and pins three wrong toolchain versions** `[S]`
  - `solana/tegridy-amm/README.md:36-66`
  - Following the README produces a toolchain that cannot build this workspace, in a checkout of somebody else's repository. It is inherited upstream text that the audit/SECURITY sections were already rewritten to correct — this section was missed.
  - *evidence:* Quickstart: `git clone https://github.com/raydium-io/raydium-cp-swap && cd raydium-cp-swap && yarn && anchor test` — verbatim upstream, clones the wrong project. Setup says `rustup default 1.81.0`, Solana `v2.1.0`, `avm install 0.31.0`. Anchor.toml:1-3 pins `anchor_version = "0.32.1"` / `solana_version = "2.3.0"`, and both CI workflows set `SOLANA_VERSION: v2.3.0` and install Anchor 0.32.1.

- **Anchor.toml calls the live mainnet program id a placeholder** `[S]`
  - `solana/tegridy-amm/Anchor.toml:21-23`
  - The comment inverts the truth about the one file `anchor build` reads to decide what address to build against. Given that the repo's whole convention is 'trunk carries the placeholder, Anchor.toml/the build patches in the real id', a comment saying the opposite is how someone regenerates a keypair over a live program.
  - *evidence:* '# Our own bonding curve. Placeholder id — replaced with a dedicated keypair / # before any real deploy, same as the cp-swap fork's.' immediately above `tegridy_launch = "CpFnacrACftonjeQ4hJBkja3PkrwvFSRFzBEk9oKhzED"` — which addresses.json:73 and MAINNET_RUNBOOK:237 both record as the live mainnet program (slot 438,055,726). The genuine placeholder, `8YVjjc…`, lives in lib.rs:114 and is deliberat

- **`global.authority` is still a single operator key while two source files assert it is the Squads multisig** `[S]` **[OPERATOR]**
  - `solana/tegridy-amm/programs/tegridy-launch/src/state.rs:110`
  - Two source comments state as present fact a custody arrangement that has not happened, on the key that controls trade fees and `set_curve_segments`. Compounding: because deploy-authority holds zero lamports, it cannot currently sign anything — so the authority handover, `update_global`, and publishing a segment shape are all blocked on funding it. Note `global.fee_recipient` IS the vault, so fees are safe; it is the admin seat that is not.
  - *evidence:* state.rs:110 '/// Admin. Mainnet: the Squads multisig, threshold >= 2.' and program.ts:346 '/** Admin. Mainnet: the Squads multisig, threshold >= 2 (state.rs:80). */'. addresses.json:88-90 (tegridy-launch-global) records: 'Its `authority` FIELD is the mutable admin and is currently deploy-authority; hand it to squads-vault with `update-global --new-authority`.' The same file records deploy-authori

- **Stale file:line citations in the operator harness, and one internal contradiction** `[S]`
  - `frontend/scripts/tegridy-launch-operator.mjs:38-45,141-142,562`
  - The harness is the artefact an operator reads immediately before a multisig ceremony, and its citations are how they verify a claim against source. scripts/verify-program-constants.mjs cites the same constants at 114/140/142 and is correct — worth using it as the reference when re-pinning.
  - *evidence:* 'lib.rs:184-187 and lib.rs:259-263 say cp_swap_program/amm_config MAY both be zero at init' — lib.rs:184-188 is the tail of `check_launch_economics` plus a doc comment, and 259-264 is `quote_buy_for`'s match arm; the real text is at 359-367. 'deployer::ID under `--features devnet` (lib.rs:126-127) … the System Program sentinel instead (lib.rs:128-129)' — the arms are at lib.rs:139-140 and 141-142.

- **`segmented.rs` cites a compute test in tests/ that does not exist** `[S]`
  - `solana/tegridy-amm/programs/tegridy-launch/src/segmented.rs:53-55`
  - The safety argument for the 16-segment ceiling points at evidence that was never produced, and the worst case it describes (a buy crossing all 16 segments) is unreachable today anyway because no segmented launch can be created.
  - *evidence:* MAX_SEGMENTS doc: 'Raising it raises the worst-case CU of buy/sell, which is already the tightest budget in the program — do not raise it without re-measuring (see the compute test in tests/).' `grep -rn 'computeUnitsConsumed|setComputeUnitLimit' tests/` returns two hits, both in tegridy-launch-migration.test.ts (466, 546), both measuring `migrate_to_amm`. There is no buy/sell CU measurement anywh

- **MAINNET_RUNBOOK opens by prescribing a devnet dry-run via a script that only handles cp-swap and was skipped** `[S]`
  - `solana/tegridy-amm/MAINNET_RUNBOOK.md:5`
  - A first-line instruction pointing at a script that cannot cover half the deployment, for a step that was not taken. Either delete the line and the script, or extend the script and re-state it as optional.
  - *evidence:* 'should hold all authorities. Devnet dry-run first (`deploy-devnet.sh`).' The mainnet deploy is recorded as done at §5b (2026-08-08) with no devnet leg mentioned. deploy-devnet.sh handles `raydium_cp_swap.so` only — it has no tegridy-launch path — and its header sizes the airdrop for 'A ~692KB program', while solana-ci now measures tegridy_launch at 444,920 bytes and derives deploy cost from the a


## DEAD — 60 items (0 need the operator)

- **Nine "attack" tests emit log lines instead of asserting, and two of them record unremediated findings only inside an `if`** `[M]`
  - `contracts/test/RedTeam_AMM.t.sol:396`
  - These cost compile + run time in the `misc` and `deep-fresh-final` slices and can never go red, so a regression in first-depositor inflation, cyclic-path acceptance or the disabled-pair bypass would ship silently. The two MEDIUM/LOW findings are recorded nowhere a human reads.
  - *evidence:* Bodies with zero assert*/expectRevert/expectEmit: RedTeam_AMM.t.sol:396 test_ATTACK3_firstDepositorInflation (88 lines, everything inside `if (depositOk)`), :706 ATTACK7b, :756 ATTACK8, :820 ATTACK9, :945 ATTACK10b, :1001 ATTACK11; FinalAudit_AMM.t.sol:351 test_AUDIT4_validateNoDuplicatesGasWithMaxPath (50 lines, `try … {} catch {}` then a gas log), :457 test_AUDIT6_mintFeeManipulation; RedTeam_St

- **afterlife.ts is a 14.7 KB orphan — nothing but its own test imports it** `[M]`
  - `frontend/src/lib/launcher/afterlife.ts`
  - afterlifeEligibility() is the function that answers, honestly and per-feature, 'what afterlife wiring does this graduated launch qualify for, and what is still undeployed'. It is written, tested (afterlife.test.ts, 20 cases / 50 assertions) and rendered by nothing — so the app cannot answer that question anywhere, and a reader grepping 'afterlife' finds a live-looking module. Either wire afterlifeEligibility into LaunchTokenPage/LaunchAfterlife or delete the module and the two constants; leaving it is the state that produced the 'chart shipped built, tested and rendered by nothing' note in solana/README.md:237.
  - *evidence:* `grep -rn "launcher/afterlife'|from './afterlife'" frontend/src` returns exactly one hit: frontend/src/lib/launcher/afterlife.test.ts:12. All 14 exports (computeV4PoolId, defaultAfterlifeAddressBook, buildBoostedStakerDeployParams, afterlifeEligibility, AfterlifeAddressBook, …) have zero production consumers. The similarly-named afterlifeLedger.ts IS wired (components/launcher/LaunchAfterlife.tsx:

- **pointsEngine's entire streak subsystem is dead code kept alive by no-op stubs** `[M]`
  - `frontend/src/lib/pointsEngine.ts:60`
  - About 60 lines of a security-sensitive module read as live points machinery. The next person to touch points has to re-derive that recordAction does nothing before they can reason about anything, and usePoints still advertises a `streakMultiplier` value that is structurally always 1. usePoints.ts:151's disclaimer also still says "Client-side: streak counter (computed locally from your visit cadence)" — there is no streak counter.
  - *evidence:* pointsEngine.ts:189-197 — `recordAction` and `recordDailyVisit` are `@deprecated` stubs whose whole body is `return getPointsData(address);`. Nothing ever pushes to `PointsData.actions` any more except pointsEngine.ts:230 inside `incrementReferralCount`, which itself has ZERO callers repo-wide (ripgrep over src incl. .jsx). Consequences chained: (a) reconcilePoints:161-163 filters `actions` for ty

- **motion.ts — six of eleven exports have no adopter, and the revealVariants comment names a consumer that inlines its own** `[M]`
  - `frontend/src/lib/motion.ts:35`
  - The file's whole premise (lines 1-2: "a single source of truth … so the app's 60+ framer-motion usages stop each hand-rolling their own timing") is half-delivered, and one comment actively misdescribes the code. Given the standing 'reuse the shared motion system' rule the right move is adoption — point Reveal.tsx at revealVariants, put liftHover/pressTap on the card/button primitives — rather than deletion. Fix the stale comment either way.
  - *evidence:* Zero references repo-wide: `EASE_IN_OUT` (:12), `SPRING_SOFT` (:17), `revealVariants` (:35), `liftHover` (:53), `pressTap` (:54). `SPRING_SNAPPY` (:18) is referenced only by the dead `liftHover`. motion.ts:33-34 says revealVariants is "used by <Reveal>" — Reveal.tsx:3 imports only `{ EASE_OUT, DUR }` and inlines `initial={{opacity:0,y}} whileInView={{opacity:1,y:0}}` at :23-26. motion.ts:51-52 say

- **The shared motion system's reveal/interaction half is dead: <Reveal> has zero call sites against 40 hand-rolled whileInView** `[M]`
  - `frontend/src/components/motion/Reveal.tsx:8`
  - The standing instruction is to reuse the shared motion system; half of it was written and never adopted, so "reuse it" currently points at code with no precedent. Either adopt <Reveal> across the 40 sites or delete the unused half so the surviving tokens (pageVariants, staggerContainer, staggerItem, EASE_OUT, DUR) are the whole truth.
  - *evidence:* `grep -rn '<Reveal'` → 0 hits; components/motion/Reveal.tsx is reachable only through the barrel components/motion/index.ts:2. Zero external references for lib/motion.ts's `revealVariants`, `liftHover`, `pressTap`, `SPRING_SOFT`, `SPRING_SNAPPY`, `EASE_IN_OUT`. Meanwhile `grep -rn whileInView pages components` = 40 inline usages, `whileHover` = 1, `whileTap` = 1. Reveal.tsx doesn't even use reveal

- **Four inherited Raydium test suites (881 lines) run nowhere, and Anchor.toml carries an unactioned TODO explaining why they would fail** `[M]`
  - `solana/tegridy-amm/tests/deposit.test.ts`
  - 881 lines of AMM coverage that would exercise the fork's deposit/withdraw/swap paths are inert, and the note naming the fix has sat unactioned. Either adapt them and wire a CI job, or delete them and the stale clone list — carrying them looks like coverage that does not exist.
  - *evidence:* CI invokes exactly two suites by name: `ts-mocha … tests/tegridy-launch-constraints.test.ts` (solana-ci.yml:583) and `… tests/tegridy-launch-migration.test.ts` (solana-ci.yml:730). deposit.test.ts (337), initialize.test.ts (183), swap.test.ts (200) and withdraw.test.ts (161) are never named. Anchor.toml's `[scripts] test` glob would pick them up, but nothing runs `anchor test`. Anchor.toml:14-17 c

- **The Rust `client/` crate is untouched Raydium upstream pointing at Raydium's own devnet program** `[M]`
  - `solana/tegridy-amm/client_config.ini`
  - Seven Rust files and ~20 dependencies (anchor-client, solana-client, solana-transaction-status, …) in the lockfile for a crate nobody builds, nobody diffs, and that actively breaks workspace-root builds. Deleting it removes a real footgun.
  - *evidence:* `raydium_cp_program = CPMDWBwJDtYax9qW7AyRuVC19Cc4L4Vcy4n2BHAbHkCW` — Raydium's devnet CPMM, not our fork (3ZvZ…/BvBkt…); `admin_path = adMCyoCgfkg7bQiJ9aBJ59H3BXLY3r5LNLfPpQfMzBe.json`, a keyfile that does not exist in this repo. The crate is a workspace member (Cargo.toml:4 `members = ["programs/*", "client"]`) but CI never builds it — solana-ci runs only `cargo build-sbf` from inside program di

- **_lib/url-allowlist.js has zero production importers; opensea.js carries a drifted inline copy of the same logic** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/url-allowlist.js:1`
  - 106 lines plus a 108-line test suite proving a sanitizer nothing calls, while the sanitizer that IS called is a narrower, differently-behaving twin. The passing test suite is currently zero evidence about production behaviour. Either wire opensea.js to the lib (reconciling the http:// disagreement deliberately) or delete both files.
  - *evidence:* `grep -rn 'isAllowedUri|sanitizeUrlFields|url-allowlist' frontend/` returns exactly three producers of those symbols: the module itself, its own test api/__tests__/url-allowlist.test.js:4, and the unrelated TS original src/lib/imageSafety.ts. No file under api/ imports it. Its own header (lines 3-6) states why it exists: "JS port of frontend/src/lib/imageSafety.ts:isAllowedUri so the OpenSea proxy

- **`withRateLimit` is the first usage pattern the rate limiter advertises and has zero callers** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/ratelimit.js:340`
  - A wrapper with no callers and no test that the module's own docs steer new handlers toward. Either delete it and fix the USAGE block, or keep it and cover it — but it should not be the documented default while being the untried path.
  - *evidence:* _lib/ratelimit.js:340 exports `withRateLimit(opts, handler)`. `grep -rn '\bwithRateLimit\b' api src` returns only the definition and the module's own USAGE block at lines 36-40, which presents it as the primary form: "import { withRateLimit } from './_lib/ratelimit.js'; export default withRateLimit({...}, async (req,res) => {...})". All 11 handlers use the "or, inline" fallback documented at lines

- **`decodeBool` in abi-decode.js has no consumers anywhere, not even a test** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/abi-decode.js:96`
  - Small, but it is an ABI decoder with no caller and no test in a module whose whole point (per record-evm.js:18-20) is that a wrong decode is indistinguishable from a real zero. An untested decoder there is the wrong thing to leave for the next person to reach for.
  - *evidence:* `grep -rn 'decodeBool' frontend/` returns exactly one line: the definition at _lib/abi-decode.js:96. Its only sibling consumer, _lib/record-evm.js:23, imports `decodeAbiString, decodeUint, decodeUint8, decodeAddress, wordAt` — every export of abi-decode.js except decodeBool.

- **The live V4 fee hook is an orphan that src/v4/TegridyV4Hook.sol can no longer reproduce** `[S]`
  - `contracts/src/v4/TegridyV4Hook.sol`
  - Two people can read "redeploy pending" and "status: live" and reach opposite conclusions about whether the address is usable. It is not: no admin surface, and no source in this repo compiles to it. Either retire the address into retiredDeploys with the orphan reason, or fold it into the DeployV4 runbook as a fresh mine — but stop listing it as a live component.
  - *evidence:* TEGRIDY_FEE_HOOK_ADDRESS 0xB6cfeaCf243E218B0ef32B26E1dA1e13a2670044 was deployed 2026-04-18 via the Arachnid CREATE2 proxy; no broadcast receipt for it exists anywhere in contracts/broadcast (grep for TegridyV4Hook/TegridyFeeHook returns nothing). CONTRACTS.md:66 records owner() == 0x4e59b448… (the proxy), so every admin function is unreachable, and says "Patched constructor accepts _owner; redepl

- **contracts/.skip-broken/ — six tracked dead files, still parked after the workorder said delete** `[S]`
  - `contracts/.skip-broken`
  - Already triaged as safe to delete, and deleting it also removes the last reason contracts/script/mocks/MockTokens.sol exists. A dot-prefixed directory of parked test files is exactly the shape that hides a coverage hole from the guard built to find them.
  - *evidence:* contracts/.skip-broken/ holds 6 git-tracked files untouched since 2026-04-26: three test files (Audit195_POL.t.sol 49 KB, R013_TegridyPair.t.sol 15 KB, TegridyNFTPool.t.sol 42 KB) and three deploy scripts (DeployAuditFixes.s.sol, DeployFinal.s.sol, DeploySepolia.s.sol). WORKORDER_V2.md:93 already adjudicated this: "all 6 files → DELETE (verified: active suites supersede the test files … the deploy

- **contracts/src/Toweli.sol is not the live token, yet it is the sole target of the formal-verification profile** `[S]`
  - `contracts/foundry.toml`
  - The only formal-methods gate in the repo proves properties of a contract that is not deployed and never will be. Repoint it at something that is live (the foundry.toml comment already suggests SwapFeeRouter fee-math / TWAP), or say plainly in the profile comment that it verifies a reference implementation only. Do NOT delete Toweli.sol — it is the documented intended behaviour and CONTRACTS.md leans on it.
  - *evidence:* CONTRACTS.md:39-49 (selector scan + live cast call, 2026-08-12): the deployed TOWELI at 0x420698CF… names itself `Towelie`, is a token-generator template, has burn/burnFrom and Ownable2Step with owner() renounced to 0x0, and REVERTS on permit / DOMAIN_SEPARATOR / nonces. contracts/src/Toweli.sol is the OZ-based source that "documents intended behaviour … it is not what is at 0x420698…". Meanwhile 

- **Two "for test compatibility" external views with no test — or any other — caller** `[S]`
  - `contracts/src/CommunityGrants.sol`
  - Small (~50 B each per the measured getter-harvest rate) but the justification comment is simply false, which is the part that costs time — the next person to read it will assume a test depends on it. Both contracts are live, so only worth folding into the redeploy, not a standalone change.
  - *evidence:* contracts/src/CommunityGrants.sol:274 `feeReceiverChangeReadyAt()` and contracts/src/MemeBountyBoard.sol:257 `minBountyRewardChangeTime()`, each under a "─── Legacy View Helpers (for test compatibility) ───" banner. `git grep` for both across contracts/test, frontend/src and scripts returns ZERO hits. The sibling helpers in the same banners are genuinely used (ReferralSplitter.sol:241 pendingCalle

- **CheckCanonicalWETH.s.sol is a post-deploy invariant nobody runs** `[S]`
  - `contracts/script/CheckCanonicalWETH.s.sol`
  - A written, working guard that has never gated anything. Either add the one line to deploy-gated.sh's AFTER BROADCAST block and docs/GATED_DEPLOY_RUNBOOK.md, or delete it — an unrun invariant is worse than none because it reads as coverage.
  - *evidence:* contracts/script/CheckCanonicalWETH.s.sol asserts every deployed contract's stored `weth`/`WETH` immutable matches the canonical WETH9 for the chain, and its NatSpec says "Run after every mainnet / fork / L2 deploy as the final smoke check before the multisig accepts ownership." `git grep CheckCanonicalWETH` across docs/, README.md, CONTRACTS.md, DEPLOY_CHEAT_SHEET.md, DEPLOY_RUNBOOK.md, .github/ 

- **Three R018 streaming tests are empty `public pure { return; }` bodies that pass over nothing** `[S]`
  - `contracts/test/R018_Staking.t.sol:266`
  - Three tests count as green in the r-series slice while executing nothing, and the surrounding comments give contradictory accounts of whether the code exists. Either delete them and record the gap in one place, or keep one honestly-named skip.
  - *evidence:* contracts/test/R018_Staking.t.sol:266, :273, :279 are all `function test_R018_streaming_*() public pure { return; }`. The docstring at :264 says "Body retained as documentation of the intended invariant" while the body at :267 says "Body removed to keep the test suite compiling" — the bodies are gone, so the comment contradicts itself. The deferral is real: `grep -rn 'rewardsDuration|periodFinish|

- **`test_updateBonus_capsRewardToAvailableBalance` never calls updateBonus and asserts nothing** `[S]`
  - `contracts/test/Audit195_Restaking.t.sol:899`
  - A named cap test that cannot fail is worse than no test — it reads as coverage in the audit-early slice.
  - *evidence:* contracts/test/Audit195_Restaking.t.sol:899-918. It deploys a high-rate TegridyRestaking, transfers 10 WETH, then opens `vm.startPrank(alice)`, does one approve, and immediately `vm.stopPrank()` under the comment "Alice already has a staking position, so skip this test if so". It closes with "// The updateBonus modifier caps: if (reward > available) reward = available; // This is tested implicitly

- **Seven helper contracts declared in test files and never used anywhere** `[S]`
  - `contracts/test/RedTeam_AMM.t.sol:77`
  - Dead bytecode compiled on every slice job, and each one implies a test that was planned and never written (a rebasing-token attack, a self-destructing token, an ETH-rejecting NFT-lending borrower).
  - *evidence:* For each name, `grep -rn <name> contracts/ --include="*.sol"` returns exactly one line — the declaration: Audit195_Revenue.t.sol:153 `contract ETHAcceptor`; Audit195_SwapFeeRouter.t.sol:127 `contract NoETHReceiver`; FinalAudit_AMM.t.sol:98 `contract SelfDestructToken is ERC20`; FinalAudit_Staking.t.sol:34 `contract FA_NFTReceiver is IERC721Receiver`; RedTeam_AMM.t.sol:77 `contract RebasingToken is

- **contracts/README.md is the verbatim `forge init` template — it still tells you to deploy `script/Counter.s.sol`** `[S]`
  - `contracts/README.md`
  - It is the first file a reader opens in the contracts directory and it teaches `--private-key` on the command line — the exact practice deploy-mvp.sh:24-26 warns against ('raw hex — DISCOURAGED, visible via /proc'). Replace with a ten-line pointer to deploy-mvp.sh, foundry.toml and the test-slice manifest.
  - *evidence:* 66 lines, `git log -1` = 2026-03-22 (the initial commit), never touched since. Full text is the stock Foundry scaffold — 'Foundry consists of: Forge / Cast / Anvil / Chisel', a link to book.getfoundry.sh, and a Deploy section reading `forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>`. There is no Counter.s.sol in this repo, and the real depl

- **contracts/.github/workflows/test.yml is a second CI workflow that GitHub can never run, and would fail if it could** `[S]`
  - `contracts/.github/workflows/test.yml`
  - It reads as a live contracts CI to anyone auditing the pipeline, and it contradicts every convention the real workflows established (SHA pinning, branch filters, sliced test execution). Delete it. Nothing references it: `grep -rn '.github/workflows' repo-wide` returns only root-workflow paths.
  - *evidence:* GitHub Actions only reads `.github/workflows` at the REPOSITORY root; a nested `.github/` is inert. Same 2026-03-22 initial-commit date as contracts/README.md, and it is the same Foundry template: `on: push` with no branch filter, floating `actions/checkout@v5` and `foundry-rs/foundry-toolchain@v1` (the root workflows are all SHA-pinned — see ci.yml:29 `actions/checkout@3d3c42e5… # v7.0.1`), and t

- **Four dead CSS classes in index.css with rules in six places each, and a TODO whose work shipped** `[S]`
  - `frontend/src/index.css`
  - Small, but .glass-card-strong/.glass-card-subtle are carried through the light-theme, reduced-motion and print blocks, so every future change to those blocks pays for two variants nobody renders. Either adopt them (they were presumably meant as depth tiers of glass-card) or drop them and their five satellite rules together — a partial delete would leave dangling selectors in the media queries.
  - *evidence:* Counted class-attribute occurrences across all frontend/src *.tsx/*.jsx: btn-primary 103, btn-secondary 48, glass-card 100 — and btn-gold 0, glass-card-strong 0, glass-card-subtle 0, pb-safe 0. Each dead class still carries rules in multiple blocks: .btn-gold at index.css:169 (iOS 44px touch targets), :316, :327 (hover), :841 (print); .glass-card-strong/.glass-card-subtle at :231, :242, :261 (redu

- **public/manifest.json is a byte-identical orphan of manifest.webmanifest, and index.html's own comment argues against shipping it** `[S]`
  - `frontend/public/manifest.json`
  - R077 made a deliberate choice and left the thing it rejected in the shipped bundle, where PWA tooling can still discover it by convention — which is the exact confusion the comment names. Delete manifest.json; the webmanifest is authoritative and already linked.
  - *evidence:* md5sum on both files: 3a9e8f401cc3b309ede319cff291c0c3 for each. index.html:6-9 — 'R077: point at the W3C-spec manifest filename. `manifest.webmanifest` is the canonical extension for Web App Manifests; `manifest.json` can confuse some PWA tooling.' followed by `<link rel="manifest" href="/manifest.webmanifest">`. A repo-wide grep for `manifest.json` across frontend/src, frontend/index.html, front

- **restaking_audit_fixes_2026_05_26.patch is a tracked loose patch file at the repo root** `[S]`
  - `restaking_audit_fixes_2026_05_26.patch`
  - A dangling diff against a file that has since been split and re-split is worse than nothing — applying it would corrupt. Delete it; the audit record it belongs to is already in the tree as prose.
  - *evidence:* 2,604 bytes, tracked, `git log -1` = 2026-05-26, never modified since. The docs pass enumerated root `*.md` (34) and `*.txt` (3) and so did not see a `.patch`; the repo-hygiene pass enumerated untracked files and tracked-blob duplicates and so did not see it either. Its subject matter — the 2026-05-26 restaking audit fixes — is recorded in AUDIT_FINDINGS_2026_05_26_SWARM.md and, per the memory ind

- **A nine-line comment block explains the deletion of code that was itself already deleted, pointing at a line number that no longer exists** `[S]`
  - `indexer/ponder.config.ts:428`
  - Every referent in the block is gone. It sends a reader to a line number for a declaration that does not exist and to handlers that were deleted in the same sweep. This is the clearest single delete-on-sight in the file.
  - *evidence:* ponder.config.ts:428-436 describes removing a duplicate `TegridyLendingAbiV2`, says its four new events "are now merged into the pre-existing declaration above" at "line ~390", and directs the reader to src/index.ts "where the four new handlers (LoanOfferCancelled, EscrowRewardsPaid, CollateralStuck, StuckCollateralClaimed) attach to the canonical TegridyLending subscription." `grep -n TegridyLend

- **DEPLOY_CHEAT_SHEET.md is a paste-ready operator script for a superseded April broadcast, and it opens by asserting there are no funds at risk** `[S]`
  - `DEPLOY_CHEAT_SHEET.md (lines 3, 5; §1 Gap A; lines 154, 203-207)`
  - 390 lines of copy-pasteable `forge script --broadcast` and `cast send` aimed at a deployment topology that no longer exists, with a false "no funds at risk" preamble. Delete or move under an archive/ directory.
  - *evidence:* Line 1: "Deploy Cheat Sheet — Audit Remediation Broadcast". Line 3: "the exact commands to run in order … **Assumes no users / no funds on the existing deployment.**" README's "Legacy exit surface (2026-07-22)" bullet: "two retired pre-relaunch staking contracts still held user funds". Line 5 names as "Source of truth for addresses and args" five scripts, four of which are gone (`DeployFinal.s.sol

- **NEXT_SESSION.md is an April handoff whose copy-paste prompt tells the next session to start with the Wave-0 runbook** `[S]`
  - `NEXT_SESSION.md (line 9; §1a lines 34-37; §"What to say to open the new session")`
  - It is named to look like the current entry point and is designed to be pasted verbatim into a fresh session. It routes a reader into the Wave-0 fossil with a Safe address and three contract addresses that are all superseded. Highest-leverage single deletion in this area.
  - *evidence:* Line 9: "Status at handoff (2026-04-25) … **Current branch:** `main`" (trunk is mvp-launch). §1a lines 34-37 give the dead Safe plus three deprecated addresses (see the WAVE_0_TODO item). §"What to say to open the new session" hands the reader a literal prompt: "start with the Wave 0 runbook if I haven't executed it yet". Six "ship-ready" items are already done or moot: docs/INCIDENT_RESPONSE.md e

- **docs/WAVE_0_RUNBOOK.md — 379-line runbook for a superseded wave, with a hardcoded local path, a wrong test count, and a false bug-bounty claim** `[S]`
  - `docs/WAVE_0_RUNBOOK.md (line 3; §Pre-flight; §If something goes wrong item 4)`
  - SECURITY.md and SECRET_ROTATION.md both cite it as the current key-rotation / ownership-transfer procedure, so a credential incident routes an operator into an April deploy wave against contracts that are now deprecated.
  - *evidence:* Line 3: "takes the protocol from 'post-session-11 working tree' to 'everything patched is live on mainnet'" — that wave's addresses are all Deprecated per docs/MIGRATION_HISTORY.md, superseded by the 2026-06-06 DeployMVP relaunch. §Pre-flight embeds `cd "C:/Users/jimbo/OneDrive/Desktop/tegriddy farms"` and `forge test  # expect: 1921 passed` (FIX_STATUS.md quotes 2,574; RELAUNCH_RUNBOOK.md quotes 

- **docs/LAUNCHPAD_V2_NOTES.md is entirely superseded — it describes the V2 factory address as a zero placeholder** `[S]`
  - `docs/LAUNCHPAD_V2_NOTES.md (lines 13, 18; §Verification checklist step 1)`
  - 43 lines whose every actionable instruction is already done, plus a tsc command the repo has documented as silently checking nothing. Delete it; trim the ARCHITECTURE §Address migration to past tense.
  - *evidence:* Line 13: "`TEGRIDY_LAUNCHPAD_V2_ADDRESS` Currently `0x0000000000000000000000000000000000000000` (placeholder)." `grep -n` frontend/src/lib/constants.ts:93 → `export const TEGRIDY_LAUNCHPAD_V2_ADDRESS = '0xa6149B4d05138A4073902A0Ca0345c2d0E470dF7' as const;` (deployed 2026-07-16, live in-app since 07-21). Line 18: "`TEGRIDY_FEE_HOOK_ADDRESS` … Arachnid CREATE2 proxy owned — admin functions stranded

- **Two dead PR-triage docs: docs/DEPENDABOT_TRIAGE_2026-04-20.md, and OPEN_PR_TRIAGE_2026_06_01.md which is untracked yet cited by the live work order** `[S]`
  - `OPEN_PR_TRIAGE_2026_06_01.md and docs/DEPENDABOT_TRIAGE_2026-04-20.md`
  - A live work order dispatches a task to a file that is not in the repository. Delete both, or at minimum drop the WORKORDER_V2 reference so the instruction is executable.
  - *evidence:* OPEN_PR_TRIAGE_2026_06_01.md line 3: "10 PRs open against `main` after #73 and #75 merged" — PR numbers run to #300 today, and `git status` lists this file as `??` (untracked), so it exists only on this machine. WORKORDER_V2.md:31 nonetheless instructs: "triage May–June stragglers per `OPEN_PR_TRIAGE_2026_06_01.md`". docs/DEPENDABOT_TRIAGE_2026-04-20.md triages PRs #1-#19 opened 2026-04-18/20 agai

- **CODEBASE_FULL.txt and CODEBASE_OVERVIEW.txt are tracked 2026-03-26 source dumps that a remediation record already claims were deleted** `[S]`
  - `CODEBASE_FULL.txt and CODEBASE_OVERVIEW.txt (repo root)`
  - 14.8k lines of stale Solidity and TypeScript in the repo root that any grep, any agent, and any LLM ingesting the repo will treat as source. The remediation record asserting they were removed means a future audit will believe the cleanup landed.
  - *evidence:* `git ls-files --error-unmatch` confirms both are TRACKED; last touched 2026-04-09 (bae51346). CODEBASE_FULL.txt is 14,454 lines, header "TEGRIDY FARMS - FULL CODEBASE / **Generated: 2026-03-26**" — a verbatim source snapshot predating the 2026-06-06 relaunch, the 2026-07-16 gated batch, the launcher, the trust tooling and the entire Solana tree. CODEBASE_OVERVIEW.txt (344 lines) is a directory-str

- **defi-ui-design-research.md and novel-defi-yield-mechanisms.md are orphaned pre-project research dumps at the repo root** `[S]`
  - `defi-ui-design-research.md and novel-defi-yield-mechanisms.md (repo root)`
  - Zero consumers, and they inflate the root-markdown count docs/SECURITY_DEFERRED.md already flags as hygiene debt. Move to docs/research/ or delete.
  - *evidence:* Both last touched 2026-03-22 in the repo's initial commit fe6d2323, 514 and 455 lines. `grep -rn` for either filename across all `*.md` returns **zero** inbound references — no README link, no docs link, not in NEXT_SESSION's "Key files to know". Content is generic market research ("1. RAYDIUM (raydium.io) — Solana / Color Palette / Primary Accent: `#abc4ff`"; "ORDERFLOW AUCTIONS: Monetizing Your 

- **Dead exports with no consumer anywhere, including one @deprecated with no 'existing callers'** `[S]`
  - `frontend/src/lib/heat/heatOracle.ts:314`
  - heldDays is the one worth deleting rather than tolerating: it converts heldSinceUnix into a day count, which is precisely the tenure arithmetic heatOracle.ts:56-72 and launchGate.ts:15-20 say twice must not exist in venue code ("If you find yourself adding a day-counter here, the spec says you have drifted"). Leaving a ready-made day-counter in the module that forbids day-counters is an invitation. The rest is ordinary selector surface — small — but eip1167Target's @deprecated note is actively false and should either name a caller or go.
  - *evidence:* Each verified with `grep -rn '\b<name>\b' frontend/src frontend/scripts frontend/api` returning only the definition (and, where noted, a test). collector.ts:53-58 `eip1167Target` — marked "@deprecated use cloneImplTarget — kept for existing callers"; there are none, only collector.test.ts:123-125. airlock.ts:31 `WETH_MAINNET` — definition only, and the module's own notes say WETH reverts InvalidTo

- **imageSafety.ts — the metadata fan-out helpers were never adopted, and the header names a consumer that doesn't import it** `[S]`
  - `frontend/src/lib/imageSafety.ts:94`
  - `createLimit` + `metadataLimit` exist specifically for the NFT grid fan-out described in the header, and the grid never used them — so nothing caps concurrent Alchemy/OpenSea metadata fetches. `fetchWithIpfsFallback` is the only code path that would race gateways, so no <img> in the app ever falls through past ipfs.io. Fix the header first; then either adopt the two helpers in NftImage or delete them and fold the second gateway list into the lib's.
  - *evidence:* Zero consumers repo-wide for `fetchWithIpfsFallback` (line 94), `createLimit` (line 122), `metadataLimit` (line 153), `ALLOWED_SCHEMES` (line 34), and `safeUrl` (line 167 — a pure one-line alias of `resolveSafeUrl`). The header at lines 4-7 claims "Used by: … nakamigos/components/NftImage.jsx (grid metadata fetch fan-out)" — NftImage.jsx imports only React and CollectionContext (head of file verif

- **composableCow.ts — a dead ABI encoder duplicating the tuple already inlined in the live one** `[S]`
  - `frontend/src/lib/composableCow.ts:80`
  - A consensus-critical tuple written twice, one copy never exercised, in a file whose header says the struct is "copied field-for-field" from CoW DAO. If the two ever drift, only one is tested. Minor UX note alongside it: the TWAP panel shows the parts bounds but not the interval bounds, because those two constants were never surfaced.
  - *evidence:* `CONDITIONAL_ORDER_PARAMS_ABI` (line 80) and `encodeConditionalOrderParams` (line 91) have zero references anywhere including composableCow.test.ts. The tuple they encode {handler, salt, staticInput} is re-declared inline inside `COMPOSABLE_COW_CREATE_ABI` at lines 105-110, which is what `buildCreateTwapCalldata` (line 123) actually uses. Also unused externally: TWAP_MIN_INTERVAL_SECONDS (33) / TW

- **isAggregatorEnabled() is a feature flag whose off-branch cannot execute, and SUPPORTED_CHAIN_ID duplicates CHAIN_ID** `[S]`
  - `frontend/src/lib/aggregator.ts:419`
  - A callable that can only ever answer true reads to a future maintainer as a real gate. And two constants naming the one supported chain means a chain change has two places to miss. (For contrast, the seven /api/<provider> proxy paths this file fetches ARE all present in frontend/vercel.json:94-100 — that half is correctly wired, so no finding there.)
  - *evidence:* aggregator.ts:418-421 — `// Aggregator is always available — no API key needed` / `export function isAggregatorEnabled(): boolean { return true; }`. Zero non-test consumers (referenced only by aggregator.test.ts). Separately aggregator.ts:12 `export const SUPPORTED_CHAIN_ID = 1` has zero external consumers (used internally at :352) while constants.ts:135 already exports `CHAIN_ID = 1` for the same

- **contracts.ts — four wagmi config objects with zero consumers anywhere in the repo** `[S]`
  - `frontend/src/lib/contracts.ts:335`
  - `voteIncentivesConfig` bakes in VOTE_INCENTIVES_ADDRESS, which is 0x0 (constants.ts:65) — a ready-made {address, abi} pair pointing at the zero address is exactly the shape someone reaches for and then wonders why every read reverts. All four are pure surface with no adopter; per the minimal-surface rule they should go.
  - *evidence:* Repo-wide ripgrep (excluding node_modules) for `voteIncentivesConfig|lpFarmingConfig|stakingConfig|toweliConfig` returns exactly four hits — the four definitions themselves: contracts.ts:335, :371, :580, :585. No importer, no test.

- **constants.ts — four exports with zero consumers (the cross-check you asked for)** `[S]`
  - `frontend/src/lib/constants.ts:213`
  - GECKOTERMINAL_EMBED is a fully-formed chart-iframe URL that no page mounts, and UNISWAP_ADD_LIQUIDITY_URL is an add-liquidity deep link the app never offers — both look like planned surfaces that never landed. The staking-admin address is the more interesting one: the deployed TegridyStakingAdmin sister has pause/setter functions and AdminPage wires only the fee-router half, so half the two-role admin surface has no UI.
  - *evidence:* Repo-wide ripgrep excluding node_modules: `UNISWAP_ADD_LIQUIDITY_URL` (constants.ts:213) and `GECKOTERMINAL_EMBED` (constants.ts:215) each return exactly one hit — their own definition, while their siblings UNISWAP_BUY_URL and GECKOTERMINAL_URL are consumed. `LockOption` (constants.ts:150), the interface behind LOCK_OPTIONS, has zero references. `TEGRIDY_STAKING_ADMIN_ADDRESS` (constants.ts:27) ha

- **copy.ts — three copy decks written for surfaces that never adopted them, one keying a pool that doesn't exist** `[S]`
  - `frontend/src/lib/copy.ts:151`
  - Two parallel error-copy vocabularies, one of them unreachable, in a repo whose voice consistency is a deliberate product choice. Either adopt ERROR_COPY inside surfaceTxError's fallback or drop it; drop the phantom USDC pool row regardless.
  - *evidence:* Test-only consumers (copy.test.ts) and nothing else: `ERROR_COPY` (:151, four in-voice error strings), `POOL_FLAVOR` (:163) + `poolFlavorLabel` (:170), `lockLabelForSeconds` (:60). POOL_FLAVOR's key set includes `'TOWELI-USDC-LP': "Randy's Cash Crop"` — there is no TOWELI/USDC pool; constants.ts knows only TEGRIDY_LP_ADDRESS and TOWELI_WETH_LP_ADDRESS. Meanwhile the app's real error surfacing runs

- **solanaTokenList.resolveMint is dead and redundant with the path SolanaSwapPage actually uses** `[S]`
  - `frontend/src/lib/solanaTokenList.ts:163`
  - An exported network-calling helper that duplicates a call the one consumer already makes. Small, but it is the kind of thing a future paste-a-mint refactor reaches for and then has to re-verify.
  - *evidence:* solanaTokenList.ts:163 `resolveMint` — zero consumers repo-wide. Its body is `searchTokens(mint).find(t => t.mint === mint)`. SolanaSwapPage.tsx:213 handles a pasted mint by calling `searchTokens(q)` directly and uses `looksLikeMint` (:217) only to pick the error string "Mint not found / not listed on Jupiter."

- **irysClient.arweaveHttpUrl is dead and its comment claims a preview path that doesn't exist** `[S]`
  - `frontend/src/lib/irysClient.ts:50`
  - The comment describes a two-path design where only one path was built, so a reader assumes previews resolve through arweave.net when they don't. Either wire it into the wizard's upload preview or drop both the helper and the second half of the sentence.
  - *evidence:* irysClient.ts:50 `arweaveHttpUrl` — zero consumers repo-wide. Its sibling `arweaveUri` (:46) is live at Step4_FundUpload.tsx:92,116,119 and Step5_Deploy.tsx:73,75. The shared comment at :41-45 says "We prefer ar:// for the on-chain baseURI … and the https variant for client-side previews" — no client-side preview uses the https variant; the launchpad wizard writes ar:// only.

- **artOverrides has two orphan keys for surfaces that were never wired into the art system** `[S]`
  - `frontend/src/lib/artOverrides.ts:285`
  - Both pin `bobowelie`, which artConfig.ts:241-244 deliberately excludes from ART_POOL_ALL because it is the TOWELI brand logo — so these read as an abandoned attempt to route the token logo and the Towelie avatar through the art system. Harmless but misleading in a generated file. Note the file is auto-written by /art-studio, so a hand-edit is only safe when no studio session is open.
  - *evidence:* Wrote a validator (scratchpad/artcheck.mjs) comparing the 339 override keys against artConfig's ART ids and against every pageArt()/ArtImg pageId used in src plus ArtStudioPage's surface catalog. All 339 artIds resolve. Two keys have no surface at all: artOverrides.ts:285 `"token-logo-toweli:0": { artId: "bobowelie" }` and :296 `"towelie-avatar:0": { artId: "bobowelie" }` — ripgrep for those pageI

- **hooks/useTradingMutations.js — an entire react-query mutation layer with zero consumers** `[S]`
  - `frontend/src/nakamigos/hooks/useTradingMutations.js`
  - It is a plausible-looking optimistic-update layer that a future contributor will assume is the sanctioned way to mutate, and wiring it would change cache behaviour under every money path. Either adopt it deliberately or delete it; leaving it is the worst of both.
  - *evidence:* 124 lines exporting useBuyNft, useCancelOrder, useCreateItemOffer, useCreateCollectionOffer, useCreateTraitOffer, useAcceptOffer. My orphan-file sweep (matching every import-specifier form across all of frontend/src) reports it as one of only two files in the tree with no importer at all. `grep -rn 'useTradingMutations' frontend/src/` returns two hits: the file itself, and a comment at lib/queryCo

- **main.jsx is an orphan standalone entry point that is in no build and would crash if it were** `[S]`
  - `frontend/src/nakamigos/main.jsx`
  - Two prior audit passes (plan/g10_naka_shell.md:6, AUDIT_FINDINGS_CONSOLIDATED.json:5028) reasoned about routing behaviour on the premise that this standalone entry is a live mount mode. It isn't, and keeping it keeps producing that wrong premise.
  - *evidence:* The second of the two files my orphan sweep found with no importer. `grep -rn 'nakamigos/main'` across frontend/ hits only audit JSON and plan markdown, never a build input; frontend/index.html is the sole HTML entry and vite.config.ts declares no extra rollup input. It also could not work: it renders `<BrowserRouter><App /></BrowserRouter>` with no WagmiProvider and no QueryClientProvider, while 

- **Dead exports across lib/ and hooks/ — HolderBadge, three skeleton variants, two event normalizers, four query factories** `[S]`
  - `frontend/src/nakamigos/hooks/useHolderStatus.jsx`
  - Several of these carry comments asserting consumers that don't exist, so each one costs the next reader a grep to disprove. The queryConfig four in particular imply a react-query migration that only got two hooks in.
  - *evidence:* Scripted unused-export sweep (definition site vs any bare-identifier reference in the tree), each hand-verified. Zero references anywhere: hooks/useHolderStatus.jsx:113 HolderBadge (a full badge component) and, with it, :33 holderTierLabel and :40 holderTierColor which nothing else calls; components/SkeletonFallback.jsx:29 ListSkeleton, :42 AnalyticsSkeleton, :61 GenericSkeleton (only GallerySkele

- **Premium is deployed, so PremiumPage/AdminPage/ActivityPage all carry a dead "not deployed" branch and three false comments** `[S]`
  - `frontend/src/pages/PremiumPage.tsx:76-95`
  - Three files describe a gate that closed weeks ago. The next reader will reason about Gold Card from a comment that inverts reality.
  - *evidence:* constants.ts:63 PREMIUM_ACCESS_ADDRESS = 0x9DC2675B2017687dD9768C63D15f0aD5194Fa3f5 (non-zero), so `isDeployed()` is true. Unreachable: PremiumPage.tsx:80-95 (the whole FeatureNotDeployed early-return) and AdminPage.tsx:478 `<PendingDeployCard name="Premium Access" />` plus its component at AdminPage.tsx:86-99. Comments now false: PremiumPage.tsx:77 "PremiumAccess isn't part of the relaunch deploy

- **NFT-Finance dead gates: the "every contract is the zero address" comment and three unreachable placeholders** `[S]`
  - `frontend/src/pages/LendingPage.tsx:120-130`
  - Four surfaces still describe a pre-deploy world that ended on 2026-07-21. The LendingPage one is the worst: the placeholder copy and the "Live" pill are driven by the same expression and say opposite things.
  - *evidence:* constants.ts:76,80,93 are real addresses (pool factory 0xbB8E49Ba…, NFT lending 0x89BeB6cc…, launchpad V2 0xa6149B4d…); only TEGRIDY_LENDING_ADDRESS (:73) is 0x0. So LendingPage.tsx:120-124's comment "Every NFT-Finance contract is currently the zero address (constants.ts, ZEROED 2026-05-31)" is false, and these three branches can never execute: LendingPage.tsx:358-360 (FeatureNotDeployed "NFT lend

- **GalleryPage's empty state is unreachable — GALLERY_ORDER is a static non-empty literal** `[S]`
  - `frontend/src/pages/GalleryPage.tsx:95-99`
  - Small, but it's the exact shape asked for: a branch that can never execute, complete with a "Check back soon" message no one will read.
  - *evidence:* pages/GalleryPage.tsx:95 `sortedPieces.length === 0` where sortedPieces derives (":74-77") from the module-level literal GALLERY_ORDER (artConfig.ts:338, 80 entries, no runtime mutation). lib/artConfig.galleryCount.test.ts pins the array's shape, so it cannot become empty without a source edit.

- **~190 lines of exported-but-unreferenced "Coming Soon" components in NFT-Finance, including fabricated lender rows** `[S]`
  - `frontend/src/components/nftfinance/LendingSection.tsx:351-447`
  - ChangelogPage.tsx:233 records a deliberate pass to stop demo data impersonating real activity; this block survived it because nothing renders it. Dead fake-data components are exactly what gets accidentally re-mounted during a refactor. The `@internal Reserved` tag reads as a lint silencer, not a plan — nothing references a future ticket.
  - *evidence:* Zero external references (checked all 484 .ts/.tsx files for each identifier): components/nftfinance/AMMSection.tsx:2650-2713 `ComingSoon`, components/nftfinance/LendingSection.tsx:352-447 `ComingSoonState`, :222-245 `SkeletonLayout`, :270-277 `LendingPulseDot`. All four carry `/** @internal Reserved for future use */`. ComingSoonState:359-364 holds `mockOffers` with invented principals, APRs and 

- **PhaseBadge and its bug-fix config are orphaned — the launchpad renders PhaseIndicator instead** `[S]`
  - `frontend/src/components/launchpad/launchpadShared.tsx:52-77`
  - A recorded correctness fix sits in code nobody renders, which means the reasoning is invisible to whoever next touches PhaseIndicator. Either mount PhaseBadge on the collection cards or delete it and move the F261 note to PhaseIndicator.
  - *evidence:* `grep -rn 'PhaseBadge'` matches only its definition at components/launchpad/launchpadShared.tsx:60 and PHASE_BADGE_CONFIG at :52. The only phase UI actually mounted is `PhaseIndicator` (CollectionDetailV2.tsx:8,243). The F261 comment at launchpadShared.tsx:47-51 — documenting the fix where a ternary "collapsed every non-1/2 phase into a single misleading 'Paused'" — lives on the dead component.

- **POINTS_NAV is a dead nav export whose only consumer is a test that pins it** `[S]`
  - `frontend/src/lib/navConfig.ts:103-105`
  - Same tautology class as the two navConfig tests already repaired on 2026-08-12, but this one survives because the export is unused rather than self-referential. Either drive the three hardcoded links from POINTS_NAV (then the test bites) or delete both.
  - *evidence:* lib/navConfig.ts:105 exports POINTS_NAV. `grep -rn '\bPOINTS_NAV\b'` outside navConfig.ts returns only lib/navConfig.test.ts:4,92-97. Every rendered Tradermigos link is hardcoded: TopNav.tsx:255, BottomNav.tsx:41, Footer.tsx:26. The test at :92-97 asserts `POINTS_NAV.to === '/nakamigos'` — a constant nothing renders, so it cannot detect a nav regression.

- **launchpadConstants exports three tokens nobody reads, two of which duplicate the shared motion system** `[S]`
  - `frontend/src/components/launchpad/launchpadConstants.ts:3`
  - Three dead tokens in a file whose whole purpose is "shared design tokens", two of them forks of the app-wide motion system.
  - *evidence:* Zero external references for `GLASS` (launchpadConstants.ts:3), `fadeUp` (:30), `fadeUpVariants` (:31). `stagger` (:32), `INPUT`, `LABEL`, `BTN_EMERALD`, `PHASE_LABELS`, `FEATURE_BULLETS` are all consumed. fadeUp/fadeUpVariants restate lib/motion.ts's `staggerItem`/`revealVariants` with a different duration and no shared easing.

- **release.yml has never fired and cannot — no v*.*.* tag exists and nothing carries a version** `[S]`
  - `.github/workflows/release.yml`
  - 113 lines of hardened, SHA-pinned, injection-audited workflow (R056 MED validator, contents:write scoping, tar --exclude hardening) guarding a release process that does not exist. Either adopt semver tagging or delete it — a maintained-looking gate on a path nobody walks costs review attention every time dependabot bumps an action inside it.
  - *evidence:* `git tag` returns exactly three: audit-pass-6, audit-remediation, backup/crazy-nobel-pre-rebase. release.yml:3-6 triggers only on `v*.*.*`; the workflow_dispatch path requires a tag "that must already exist on origin" and validates it against `^v[0-9]+\.[0-9]+\.[0-9]+…$` (line 45). frontend/package.json version is "0.0.0"; root package.json has no version field.

- **CODEOWNERS names an org that does not own this repo, so zero reviewers are ever requested** `[S]`
  - `.github/CODEOWNERS:14,20-25,31-38,42-45,50-51`
  - The file's own security section marks `/.github/`, `/.github/workflows/` and `/scripts/` as requiring core-team review. That rule enforces nothing today. Either map the patterns to real collaborators or delete the file — a CODEOWNERS that resolves to nobody reads as review coverage that is not there.
  - *evidence:* `git remote -v` → https://github.com/fomotsar-commits/tegridy-farms.git. CODEOWNERS assigns `@tegridy-team` (default `*`), `@tegridy-team/frontend-team`, `@tegridy-team/contracts-team`. A team handle from a different org is not a valid owner on this repo; GitHub silently requests nobody.

- **Root slither.config.json is an orphaned duplicate with keys slither cannot parse; its notes file still calls it live** `[S]`
  - `slither.config.json (repo root) + slither.config.notes.md:124-133`
  - Two configs with different detector sets, one of which is now unreachable from CI but is still what a developer running `slither .` from the repo root picks up — so local and CI results diverge silently. Delete the root pair (and the .gitignore:18 note about it), or make it a symlink-equivalent comment pointing at the contracts one.
  - *evidence:* slither.yml:73 now passes `slither-config: contracts/slither.config.json` explicitly, and its comment (50-61) says the root file was "last touched 2026-05-03" and "was read by nothing" it should have been. Root config declares `detectors_to_exclude` as a JSON ARRAY, while contracts/slither.config.json's `_schema_note` records that slither calls `.split(',')` on that key (string required), and carr

- **revenue-watch.yml's ETH_RPC/SOL_RPC overrides are unreachable, and the credit probe reads a different variable name** `[S]`
  - `.github/workflows/revenue-watch.yml:85-101 + scripts/pull-caller-credit.mjs:66`
  - Five names for two concepts across this area: ETH_RPC (verify-addresses.mjs:328, registry-onchain.yml:84), ETH_RPC_URL (verify-ownership.mjs:431, pull-caller-credit.mjs:66, oneshot-guard.mjs:267, capture-airlock-selectors.mjs:52), RPC_URL (capture-locker-selectors.mjs:12), SOLANA_RPC (verify-addresses.mjs:327), SOLANA_RPC_URL (verify-program-constants.mjs:345). An operator who sets a paid endpoint to stop the hourly public-RPC throttling gets it applied to nothing in revenue-watch, and the workflow's own `state=partial` red-check path (278-307) fires on the throttling it could have avoided.
  - *evidence:* revenue-watch.yml:100-101 does `ETH_RPC="${ETH_RPC:-https://ethereum-rpc.publicnode.com}"` / `SOL_RPC="${SOL_RPC:-…}"`, but that step's `env:` block (85-89) binds only SOLANA_FEE_ACCOUNT — GitHub does not export `vars.*` into `run:`, so neither override can ever be non-empty. Separately, the "Read the stranded caller credit" step (72-80) has no `env:` at all and scripts/pull-caller-credit.mjs:66 r

- **PR #278 (heat launch gate) is fully superseded — close it** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/src/lib/heat/heatGateConfig.ts`
  - An open, conflicting PR that re-adds an older version of code already in trunk. Leaving it open invites someone to resolve the conflict and regress the gate.
  - *evidence:* #278 is +299/-0 creating six files. All six already exist in origin/mvp-launch (`git cat-file -e origin/mvp-launch:<path>` succeeds for each) and trunk's copies are larger and newer: launchGate.ts trunk=6259 B vs branch=4271 B; heatGateConfig.ts trunk=3269 B vs branch=2041 B. `git log --diff-filter=A origin/mvp-launch -- frontend/src/lib/heat/heatGateConfig.ts` names the landing commit: 657c5170 "

- **CODEBASE_FULL.txt and CODEBASE_OVERVIEW.txt are stale generated dumps that .gitignore names but cannot exclude** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/CODEBASE_FULL.txt`
  - A 604 KB snapshot of March code at repo root reads as current to anyone who opens it, and it is the largest non-vendored text blob in the tree.
  - *evidence:* CODEBASE_FULL.txt header line 3 reads "Generated: 2026-03-26"; 604,591 B. CODEBASE_OVERVIEW.txt 17,570 B. `git log -1 -- CODEBASE_FULL.txt CODEBASE_OVERVIEW.txt` → 2026-04-09 bae51346, i.e. untouched for four months while the repo took 700+ commits. Both listed at .gitignore lines 32-33 but tracked, so the rules are no-ops. WORKORDER_V2.md line 91: "delete, don't regenerate — README + docs/ARCHITE

- **tegridy_100_findings_unpacked/ is 22 tracked files of raw unpacked .docx XML** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/tegridy_100_findings_unpacked/word/document.xml`
  - Half a megabyte of XML nobody can read, versioned as source, while the equivalent for the Spartan audit was deliberately left out of git — inconsistent treatment of the same artifact class.
  - *evidence:* `git ls-files tegridy_100_findings_unpacked | wc -l` = 22 — [Content_Types].xml, _rels/.rels, docProps/app.xml, word/document.xml, … The last is 575,428 B, the 6th-largest non-vendored blob in the repo. This is the machine-readable interior of a Word document, not a readable finding set. WORKORDER_V2.md line 91 lists it for `git rm` alongside the root images. The parallel case .spartan_unpacked/ w

- **264 orphaned refs under refs/remotes/pr/* from a remote that no longer exists** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.git/packed-refs`
  - They are why the repo reads as 427 remote branches when origin actually has 164, and they pin objects against GC. Deleting refs/remotes/pr/ is safe — no configured remote will ever refresh them and every PR head is recoverable from GitHub.
  - *evidence:* `git for-each-ref refs/remotes | wc -l` = 428, split by remote-name into 164 under origin and 264 under `pr`. `git remote -v` lists only origin, and `git config --get-regexp '^remote\.'` returns just remote.origin.url and remote.origin.fetch (`+refs/heads/*:refs/remotes/origin/*`) — there is no remote.pr.* config at all. The refs are PR head snapshots (refs/remotes/pr/1 dated 2026-06-08, pr/10 202

- **docker-compose.yml is upstream Raydium's, named `raydium-cpmm-dev`, and drives commands the repo says cannot run** `[S]`
  - `solana/tegridy-amm/docker-compose.yml:31`
  - It is plausibly a genuine escape hatch for the Windows SBF problem — a container would sidestep the symlink-privilege failure entirely. But nobody has validated that, and as it stands it is upstream-named dead config. Decide: verify it as the documented local-build workaround, or delete it.
  - *evidence:* `container_name: raydium-cpmm-dev`. Its usage cheatsheet is entirely `anchor build` / `anchor test`, which is the path programs/tegridy-launch/README.md and lib.rs:68-74 document as unavailable on the dev box, and which CI does not use either (CI drives `cargo build-sbf` plus explicit `ts-mocha` invocations). Nothing in the repo references the compose file except its own contents.


## CLEANUP — 66 items (2 need the operator)

- **No shared mocks module: 13 copies of MockJBAC, 11 of MockWETH, and three spellings of the TOWELI mock** `[L]`
  - `contracts/test/R028_SwapFeeRouter_M_Findings.t.sol:16`
  - Every slice recompiles a dozen near-identical mocks, and MockTOWELI / MockToweli / MockTowel being three different contracts is a real trap when copy-pasting a test. Partly deliberate — some mocks differ behaviourally on purpose (ETH rejecters, fee-on-transfer, huge-supply) — so the safe scope is the naming drift and the byte-identical ERC20/ERC721/WETH stubs, not a blanket consolidation. A shared contracts/test/mocks/*.sol needs no slice entry (the coverage guard only flags non-.t.sol files that declare test functions).
  - *evidence:* `grep -n "^contract " contracts/test/*.t.sol contracts/test/*/*.t.sol | … | sort | uniq -c | sort -rn` gives MockJBAC x13, MockWETH x11, MockTOWELI x8, ETHRejecter x7, MockToweli x4, MockNFT x4, MockERC20 x4, MockTowel x3, MockToken x3, MockSequencerFeed x3, MockFactory x3, FeeOnTransferToken x3. There is no contracts/test/mocks/ directory — the recursive walk shows only echidna/, halmos/, invaria

- **The RPC-failover block is triplicated across three _lib modules; the file that flagged it named an exit criterion nobody met, and the drift guard covers only two of the three copies** `[M]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/ethcall.js:14`
  - Three hand-maintained copies of which public Ethereum RPCs are alive, in the modules backing order verification, the token scanner's contract-flag pass, and the birth record. The repo already decided this should be one module and wrote down when to finish; the job is half done and the safety net has a hole in it.
  - *evidence:* `PUBLIC_RPC_URLS` + `rpcUrlChain()` + `alchemyUrl()` (plus `pad32`/`padAddr`) appear verbatim three times: _lib/ethcall.js:43-75 (exported), _lib/seaport-verify.js:165-196 (private), _lib/eth-code.js:27-48 (private). ethcall.js's own header, lines 14-18, states the unfinished work and its exit test: "seaport-verify.js still carries its own copy of this block — the de-duplication half of the change

- **Three separate invariant harnesses assert the identical `balance >= totalStaked`, two assert the identical cap bound** `[M]`
  - `contracts/test/invariants/MVPLaunch_StakingInvariants.t.sol:85`
  - Five invariant functions across three files carrying two distinct properties. The MVPLaunch_StakingInvariants harness has no property that StakingInvariants + RewardTriangle do not already cover with better handlers.
  - *evidence:* invariants/MVPLaunch_StakingInvariants.t.sol:85 invariant_principalRecoverable → `assertGe(toweli.balanceOf(address(staking)), staking.totalStaked())`; invariants/MVPLaunch_RewardTriangleInvariants.t.sol:141 invariant_principalRecoverableCrossContract → the same two operands, same direction; invariants/StakingInvariants.t.sol:468 invariant_totalStakedBounded → `assertLe(staking.totalStaked(), toke

- **FuzzInvariant.t.sol's pair invariants are a weaker duplicate of invariants/PairInvariants.t.sol, and the file runs nothing in its own slice** `[M]`
  - `contracts/test/FuzzInvariant.t.sol:293`
  - Two pair-invariant runners maintained in parallel, and the file sits in a unit slice where it never executes, which makes slice balance misleading. Move `reservesMatchBalances` into PairInvariants.t.sol and relocate or retire the rest.
  - *evidence:* contracts/test/FuzzInvariant.t.sol:293 TegridyPairInvariantTest asserts k >= kLast (:327), totalSupply >= 1000 (:337), reserves == balances (:344). contracts/test/invariants/PairInvariants.t.sol asserts a strictly stronger fee-aware K bound (:157 invariant_kGrowsByFeesOnly, which catches a fee bypass that a plain k >= kLast cannot see — the docstring says so), the dead-address MINIMUM_LIQUIDITY lo

- **Duplicated test bodies across files, two of them in the same slice** `[M]`
  - `contracts/test/Audit195_StakingCore.t.sol:557`
  - Duplicate coverage inflates slice counts and doubles the maintenance cost when the behaviour changes — a fix has to land in two places or the suite goes half-red for a reason that looks like flakiness.
  - *evidence:* 56 test-function names collide across files. Material cases: test_executeEmergencyExit_penaltyIfLockActive and test_executeEmergencyExit_noPenaltyIfLockExpired exist in both Audit195_StakingCore.t.sol (:557, :583) and Audit195_StakingGov.t.sol (:859, :886) — both files are in the `audit-early` slice, and a diff of the two bodies shows only local-variable names and `365 days` vs `LOCK_1Y` / `30 day

- **19 test files carry mojibake in their comments** `[M]`
  - `contracts/test/RedTeam_AMM.t.sol:390`
  - Section rules render as 60 characters of garbage, which makes these files materially harder to read — and they are the files most in need of reading (RedTeam, FinalAudit). Cosmetic only, but it must be repaired with the Edit tool: the known cause on record is a PowerShell 5.1 `Get-Content -Raw` + `Set-Content -Encoding utf8` round-trip, so fixing it with the same tool re-corrupts it.
  - *evidence:* `grep -rl "â€\|Ã¢\|â”\|â•\|ï¿½" contracts/test/` returns 19 files: Audit195_Pair, Audit195_Router, Audit195_SwapFeeRouter, AuditFixes_Pair, AuditFixes_SwapFeeRouter, AuditR014_Oracle, AuditR014_SwapFeeRouter, Audit_SFR_H01, Deep_Routers_2026_05_01, FinalAudit_AMM, FuzzInvariant, R028_SwapFeeRouter_M_Findings, R062_SequencerCheck, RedTeam_AMM, SwapFeeRouter, TegridyPair, TegridyRouter, TegridyTWAP,

- **Four drifted copies of withRetry, and trades.js's copy ignores the no-retry flag its own caller sets** `[M]`
  - `frontend/src/nakamigos/lib/trades.js`
  - P2P trade creation and accept both go through postOrderbook, so a user gets three extra seconds of spinner on a rejection that can never change, and the server re-runs its per-item on-chain checks each time. One shared helper removes the drift class permanently.
  - *evidence:* Independent implementations at api.js:23, api-offers.js:31, lib/orderbook.js:42 and lib/trades.js:37; openseaGet/openseaPost are also duplicated (api.js:80-95 vs api-offers.js:62-72). They have drifted: api.js re-throws AbortError explicitly and uses a plain setTimeout delay; api-offers.js has an abort-aware delay but drops `signal.reason` and its openseaGet (:62) does not forward `signal` to the 

- **Nav is configured four times with label drift, and the guard test only checks one direction** `[M]`
  - `frontend/src/nakamigos/components/Header.jsx`
  - Five sources of truth for one nav; the existing regression test was written for this exact bug class (its own comment cites the P2P Trades tab shipping dead) and covers only half of it. One shared TAB_META map plus the inverse assertion closes it.
  - *evidence:* Header.jsx:128 PRIMARY_NAV and :138 MORE_NAV (arrays of [key, label] pairs) versus MobileNav.jsx:4 PRIMARY_TABS and :12 MORE_TABS (arrays of {key,label,icon}), plus constants.js:90 VALID_TABS as a fifth list. The same tab carries different labels by viewport: "⇄ P2P Trades" (Header.jsx:140) vs "⇄ Trade Offers" (MobileNav.jsx:14); "🎯 Sniper" (Header.jsx:141) vs "Sniper" (MobileNav.jsx:15); "Favorit

- **EmptyState defines 25 states; 16 are never used because every tab hand-rolls its own** `[M]`
  - `frontend/src/nakamigos/components/EmptyState.jsx`
  - ~90 lines of config that look canonical but aren't, so the copy-and-CTA improvements that landed in EmptyState never reach the pages. It is also why the MyCollection empty state kept its external link-out.
  - *evidence:* components/EmptyState.jsx:1-163 configures gallery, search, filters, collection, favorites, watchlist, cart, portfolio, listings, offers, collectionOffers, traitOffers, myListings, bids, bidsReceived, trades, activity, history, analytics, holders, chat, alerts, rarity, wallet, whales. `grep -rn 'EmptyState' src/nakamigos --include=*.jsx` (excluding the file and tests) yields nine distinct types in

- **~100 dead class selectors in App.css, including whole families for components that went fully inline-styled** `[M]`
  - `frontend/src/nakamigos/App.css`
  - App.css is imported eagerly in main.tsx (App.jsx:5) so it is on the critical path for every /nakamigos view. More importantly the dead families mislead: someone adding to WhaleIntelligence or NftCompare will reach for `.whale-card` or `.compare-slot` and get nothing.
  - *evidence:* Scripted diff of the 439 class selectors in App.css (4,603 lines) against every JS/TS file under frontend/src, then hand-filtered the dynamically-composed families (`toast-${t.type}` at Toast.jsx:105, `depth-chip--${thickness}` at DepthChart.jsx:266, whale-trend-*) as false positives. What remains is genuinely dead, in contiguous blocks: `.compare-*` — 13 selectors from App.css:2174 — while NftCom

- **Five hand-rolled ArtCard/ArtPanel clones, four of which bypass <ArtImg> entirely** `[M]`
  - `frontend/src/components/ui/ArtCard.tsx:14-19`
  - ui/ArtCard.tsx's own docstring says art goes through ArtImg so "/art-studio overrides, focal objectPosition, scale, CLS-reserving width/height and the broken-image fallback all come for free" — and cites "SecurityPage's card" as the reference it was factored from. SecurityPage was never migrated onto it. Concretely: those four surfaces are invisible to the art-studio override system, reserve no layout, and have no broken-image fallback; SecurityPage additionally loses its card blur on Safari/iOS for want of the -webkit prefix.
  - *evidence:* `grep -rn 'function ArtCard|const ArtCard'` → components/ui/ArtCard.tsx:21 (the shared one, uses <ArtImg>), components/launchpad/launchpadShared.tsx:20, components/nftfinance/AMMSection.tsx:125, pages/SecurityPage.tsx:54 — plus the near-identical components/nftfinance/LendingSection.tsx:176 `ArtPanel`. The latter four all render a raw `<img src={art.src}>` (launchpadShared.tsx:39, AMMSection.tsx:1

- **Frontend dependabot queue is saturated at exactly 10/10 — no new bump, including a security bump, can be opened** `[M]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.github/dependabot.yml (line 12)`
  - Dependabot silently stops raising frontend PRs at the cap — a CVE fix for jose, supabase-js or the wagmi/viem stack would never appear. Merging the nine green ones clears it; they need a CI re-run first since their checks ran against a base 10 commits old.
  - *evidence:* .github/dependabot.yml line 12 sets `open-pull-requests-limit: 10` for directory "/frontend". `gh pr list --json headRefName --jq '[.[]|select(.headRefName|startswith("dependabot/npm_and_yarn/frontend"))]|length'` returns exactly 10 (#301, #296, #295, #294, #293, #292, #291, #290, #289, #287). Nine are MERGEABLE/CLEAN with zero failing checks; only #301 fails, on the known anvil E2E flake. All hav

- **PR #296 (framer-motion 12→13) is a major that needs a decision, not a batch merge** `[M]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/package.json`
  - This is the one dependabot PR in the queue that must NOT be swept up with the other eight. The app's shared motion system rides on it. Triage separately against the v13 changelog.
  - *evidence:* #296 bumps framer-motion ^12.43.0 → ^13.0.0 plus motion-dom/motion-utils to ^13.0.0, and shows MERGEABLE/CLEAN with no failing checks. Per .github/dependabot.yml lines 35-38 majors are deliberately delivered as single-package PRs "where the blast radius is legible and the decision is deliberate" — so green CI here is the config working as designed, not a verdict on the upgrade.

- **The repo directory is 56 GB, and 26.3 GB of it is 84 duplicated submodule clones inside .git** `[M]` **[OPERATOR]**
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.git/worktrees`
  - This is the mechanism behind the known "OneDrive pruned node_modules mid-session" hazard — 56 GB inside a synced folder, 99.7% of it redundant. It also makes every recursive tool at repo root unusable (my first `du` on .claude/worktrees exceeded 400 s). Removing the worktrees reclaims both halves at once: the 30 GB of working trees and the 26.3 GB of admin clones.
  - *evidence:* Measured with `du -sm`: .claude/worktrees = 30,034 MB and .git = 27,366 MB. Breaking down .git: .git/worktrees 26,941 MB, .git/modules 328 MB, .git/objects 95 MB, everything else <3 MB. Drilling in, each worktree admin dir is ~335 MB and `du -sm .git/worktrees/wf_a9721a5c-5f1-3/*` shows all of it in `modules/` — `ls .git/worktrees/wf_a9721a5c-5f1-3/modules/contracts/lib` returns solady/ solmate/ v

- **86 of 116 worktrees hold uncommitted tracked changes, HEADs dated 2026-04-29 to 2026-07-23** `[M]` **[OPERATOR]**
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.claude/worktrees/wf_a9721a5c-5f1-3`
  - Bulk-removing the worktrees would discard all of this silently. Correct order: inspect wf_a9721a5c-5f1-3 (the Certora specs and the BootstrapTWAP/DeepenLP script pair look like they were never landed), decide keep-or-drop, then remove the rest. I only sampled 4 of the 86, so give the others a scripted `git -C <wt> diff --stat` pass before deleting.
  - *evidence:* Swept every worktree with `git -C <wt> status --porcelain --untracked-files=no`; 86 report non-zero. `git worktree prune --dry-run -v` prints nothing, so all 116 directories still exist. About thirty share an identical signature — ` M .audit_101/076_AuthSiwe.md`, ` M .audit_101/079_OpenseaOrderbook.md`, ` M .audit_101/095_DocsDrift.md`, ` M AUDITS.md`, ` M README.md` — one abandoned batch replayed

- **316 local and 164 origin branches with no documented lifecycle; 76 local and ~80 remote are free to delete now** `[M]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/CONTRIBUTING.md`
  - Nothing is broken, but the branch list is unusable for finding real in-flight work and there is no written rule, so it regrows. Two safe passes — delete the 76 merged-unpinned local branches, and the ~80 merged origin branches with no open PR — plus three lines in CONTRIBUTING.md.
  - *evidence:* `git branch --list | wc -l` = 316: 119 merged into origin/mvp-launch, 77 machine-generated `worktree-*` names, 23 with a gone upstream (`git branch -vv | grep -c ': gone]'`). 85 are pinned by a worktree checkout (`git worktree list --porcelain | grep -c '^branch '`), leaving 76 merged-and-unpinned. On the remote: 164 origin branches, 99 merged into mvp-launch (`git branch -r --merged`), only 19 wi

- **births.js is the only ?resource= branch not using the shared origin gate, so it ignores ALLOWED_ORIGIN and is not prod-like-aware** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/births.js:218`
  - births is the signing path — the one branch where an origin decision actually matters — and it is the one that does not share the reviewed implementation. The divergence is silent: adding a domain via ALLOWED_ORIGIN makes five surfaces work and the sixth 403.
  - *evidence:* launch-cohort.js:149, launch-radar.js:81, launcher-outcomes.js:539 and heat.js:93 all call `isOriginAllowed(...)` imported from _lib/aggregator-proxy.js. births.js:218 instead does `if (!ALLOWED_ORIGINS.includes(origin))` against its own literal array at lines 58-67. Two behavioural differences follow from aggregator-proxy.js:63 and :95: (1) the shared builder adds `process.env.ALLOWED_ORIGIN` to 

- **Three resource branches enforce with the shared allowlist but emit the CORS header from a separate local array, so widening via ALLOWED_ORIGIN only half-works** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/heat.js:59`
  - ALLOWED_ORIGIN is documented in .env.example:156-158 as the no-redeploy widening lever. On these three routes it produces a request that is authorised and then discarded by the browser — the most confusing possible failure, because server logs show 200.
  - *evidence:* heat.js:59-78, launch-radar.js:38-57 and launcher-outcomes.js:175-194 each declare a local `ALLOWED_ORIGINS` literal used ONLY by their `setCors`, then enforce the 403 with `isOriginAllowed()` from aggregator-proxy.js, whose `buildAllowedOrigins` (aggregator-proxy.js:63) additionally adds `process.env.ALLOWED_ORIGIN`. An origin added via ALLOWED_ORIGIN therefore passes the server-side 403 and rece

- **Every aggregator test drives a request shape production never sends; the shape production always sends is untested** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/__tests__/aggregator-proxy.test.js:178`
  - The entire swap hot path — 8 providers, origin gate, path allowlist, body cap — is green against an input shape the platform never produces. A regression in the `p`-string split would take out every quote in production with a fully green suite. One `makeReq({ query: { provider, p: okPath.join('/') } })` case per provider closes it.
  - *evidence:* vercel.json:94-101 rewrites all eight providers to `/api/aggregator?provider=<id>&p=:path*`, so `req.query.p` always arrives as a slash-joined STRING and aggregator.js:319-321 (`req.query.p.split("/")`) is the only branch production executes. api/__tests__/aggregator-proxy.test.js builds every request with `query: { ...okQuery, path: okPath }` where okPath is an ARRAY (lines 178, 204, 218, 230, 24

- **runProxy documents a cacheControl knob no provider sets, and uses a globalLimit knob it does not document** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/aggregator-proxy.js:189`
  - Two extension points with zero users, one documented and dead, one live and undocumented — so the JSDoc is wrong in both directions. Minor, but this is the config contract eight providers are written against.
  - *evidence:* aggregator-proxy.js:189-190 documents `@param {string} [cfg.cacheControl]` and line 306 reads it; none of the eight CONFIGS in aggregator.js:25-240 sets it, so every aggregator response is unconditionally `private, no-store`. Conversely `cfg.globalLimit` is read at line 231 and referenced by .env.example:239-240 ("per provider unless the provider sets globalLimit") but is absent from the JSDoc blo

- **etherscan.js keeps an authHeaders() wrapper and an unused `extra` parameter left over from the reverted Bearer-auth approach** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/etherscan.js:26`
  - Trivial to inline, and the name actively misleads: someone adding a header will reasonably call authHeaders({...}) on a function whose whole point is that auth does not go in headers here. The v1 fallback is separately worth knowing — with no key this endpoint targets a deprecated API.
  - *evidence:* etherscan.js:26-29 defines `authHeaders(extra = {})` returning `{ Accept: 'application/json', ...extra }`. Its only call site is line 210, `authHeaders()`, with no argument. The function is residue of the R048 Bearer-header design that lines 13-19 record as reverted ("v2 does NOT accept Authorization: Bearer... The key goes in the QUERYSTRING"), and its own line 27 comment now says "Auth travels i

- **holder-gate.js evaluates IS_PROD at module load, against the per-request rule the repo established for exactly this** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/_lib/holder-gate.js:29`
  - Low impact — IS_PROD only selects the dev-skip branch at line 75 — but the codebase made an explicit, documented decision about this pattern and one file predates it. Cheap to align while the reason is still written down next to it.
  - *evidence:* _lib/holder-gate.js:29-31 computes `const IS_PROD = ...` once at import. auth/me.js:30-41 wraps the identical expression in `isRevocationRequired()` and explains why: "AUDIT FIX FRESH-2026: F-FRESH-1 + F-FRESH-2 — read NODE_ENV / VERCEL_ENV per-request (not at module load) so a config change takes effect without a cold-start." supabase-proxy.js:199-204 and solrpc.js:53-59 follow the per-request fo

- **Two test files named ratelimit.test.js in different directories, both covering _lib/ratelimit.js** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/__tests__/ratelimit.test.js:1`
  - Purely locational. "Fix the ratelimit test" is ambiguous, and a failure report naming ratelimit.test.js does not say which. Merging into api/_lib/__tests__/ (next to the module) or renaming one to ratelimit.global.test.js resolves it.
  - *evidence:* api/__tests__/ratelimit.test.js (70 lines) imports `checkGlobalLimit` from ../_lib/ratelimit.js and tests the global circuit-breaker. api/_lib/__tests__/ratelimit.test.js (203 lines) imports extractIp, buildRateLimitKey, memoryRateLimit, checkRateLimit from ../ratelimit.js and tests the identity/limiting layer. Different content, same module under test, same basename, two directories. Both are col

- **The broadcast receipts for the entire current live deployment set are untracked** `[S]`
  - `contracts/broadcast`
  - Two consequences. (1) In CI the rule-5 walk only ever sees pre-relaunch scripts, so no receipt for any currently-live contract can be checked against the registry — the guard runs on a stale world and reports success. (2) The receipts are the only full-precision record of the NFTPool template address, which exists nowhere else in the repo un-truncated; a lost machine loses it.
  - *evidence:* `git ls-files contracts/broadcast/*/1/run-latest.json` returns 16 files, all pre-relaunch. `git ls-files` returns ZERO files for DeployMVP.s.sol/, DeployCommunityGrants.s.sol/, DeployMemeBountyBoard.s.sol/, DeployLaunchpadV2.s.sol/, DeployNFTPoolFactory.s.sol/, DeployPremiumAccess.s.sol/ — i.e. the 2026-06-06 relaunch and most of the 2026-07-16 gated batch. Two more live-deploy receipts are indivi

- **Every `invariant_` under test/invariants/ runs twice per CI run** `[S]`
  - `.github/contracts-test-slices.json:78`
  - The override's stated reason ("the shared default would strip every test it exists to run") was true before the fuzz-invariant job existed; the job now covers those tests by name from anywhere in the tree. Removing the override halves the invariant CPU without losing a single property.
  - *evidence:* The `invariants` slice overrides the shared name filter to `^testFuzz_` (.github/contracts-test-slices.json:78), so `forge test --match-path test/invariants/*.t.sol --no-match-test ^testFuzz_` runs all 38 `invariant_` functions in that directory. The separate `fuzz-invariant` job (.github/workflows/contracts-ci.yml:506-581) selects `^(testFuzz_|invariant_)` by NAME with no `--match-path`, so it ru

- **Forty-two of the 87 @theme design tokens have no consumer, including the entire Cartman ramp — while the launchpad hardcodes 'Cartman red' as a different hex** `[S]`
  - `frontend/src/index.css`
  - Low urgency and zero payload cost — Tailwind v4 tree-shakes unused @theme tokens out of the emitted CSS, so this ships no bytes. It is design-system drift, and the operator's preserve-art rule cuts BOTH ways here: the header comment at index.css:44-53 assigns each character a semantic role ('Cartman (red) → premium, bribes, high-risk'), so the honest read is that the ramps were authored ahead of the surfaces and the surfaces then hardcoded hexes instead. Reconciling launchpadConstants.ts to the tokens is the additive fix; deleting the ramps is the subtractive one and is the wrong call under the standing rule.
  - *evidence:* index.css is the main app's whole token layer (842 lines) and was in no agent's scope. Scanned with scratchpad/css4.mjs, which tests each `@theme` token BOTH as its generated Tailwind v4 utility (`bg-|text-|border-|from-|to-|via-|ring-|shadow-|fill-|stroke-|…-<name>`) and as a `var()` reference across all of frontend/src + index.html. 42 of 87 match neither. All eight Cartman steps are dead (--col

- **frontend/.claude/launch.json duplicates the root one byte-for-byte, and its cwd resolves to frontend/frontend** `[S]`
  - `frontend/.claude/launch.json`
  - Two copies means the fix for the hardcoded node path has to land twice or it half-lands. Delete the frontend one — the root config already declares `cwd: frontend` correctly.
  - *evidence:* Both files are identical: the same `runtimeExecutable: "C:\\Program Files\\nodejs\\node.exe"`, same runtimeArgs, same port 5173, same `"cwd": "frontend"`. The repo-hygiene pass flagged the hardcoded machine-specific node path against .claude/launch.json at the root only; the frontend copy has the same defect plus one of its own — a `cwd` of `frontend` relative to a config already inside frontend/ 

- **Six e2e assertions are wrapped in runtime conditionals, and one of them can pass having asserted nothing** `[S]`
  - `frontend/e2e/a11y-smoke.spec.ts`
  - Small, and mostly self-documented, but it is precisely the shape the operator's mutation rule targets — a test that cannot fail proves nothing, and this one is in the a11y suite where a silent pass is indistinguishable from coverage. Converting the bare `if (count > 0)` to `test.skip(count === 0, '…')` costs one line and makes the gap visible in the report. Not worth touching the other five, which already skip loudly.
  - *evidence:* Counted `test.skip|if ((await|if (count|if (await` per spec: a11y-smoke 5 sites across 6 tests, lending 2/4, liquidity 2/4, swap 2/4, claim-rewards 1/4, stake 1/4; the other six specs have none. Most use `test.skip(true, '<reason>')`, which at least reports as skipped. The exception is a11y-smoke.spec.ts's 'TradePage swap amount input has a contextual aria-label': it does `const count = await amou

- **The migration set cannot be applied in filename order — 001 aborts, and 015 must run before 014** `[S]`
  - `frontend/supabase/migrations/014_siwe_nonces.sql:44`
  - Any lexical runner (supabase db push, a CI job, or a person going 001→015) applies 014 before 015, which by 015's own analysis publishes every user's favourites, watchlist, profile and votes to anyone holding the anon key on login day. The loud comments are the only guard. Renaming 014 to 016 costs minutes and makes the filenames tell the truth; repairing 001 (or superseding it with the base schema above) removes the abort.
  - *evidence:* 001_siwe_auth_rls.sql:25 does `DROP POLICY ... ON messages` and :115 `ALTER TABLE trade_offers ENABLE ROW LEVEL SECURITY`, but trade_offers is not created until 002:64 and messages is never created at all. 014_siwe_nonces.sql:10-14 confirms this first-hand: "001 aborts partway through ... Do NOT 'just re-run 001' to fix this: it will abort again." Separately 014:44 says "DO NOT APPLY THIS FILE BEF

- **Migration 008 blanket-grants EXECUTE on ALL ROUTINES to anon, silently reversing 004's function lockdown — and every later migration has to patch around it** `[S]`
  - `frontend/supabase/migrations/008_grant_new_table_roles.sql:20`
  - Impact today is small — prune_revoked_jwts only deletes already-expired rows — but the structural cost is that every new table and every new SECURITY DEFINER function is anon-reachable by default, and the author has to remember a REVOKE. Two of the last three migrations already had to. Either narrow 008 to the specific routines that need it, or add the REVOKE back in a new migration and note the default-privileges trap where the next author will see it.
  - *evidence:* 004_security_hardening.sql:56-57 revokes EXECUTE on prune_revoked_jwts from PUBLIC and from anon/authenticated, and :65-66 revokes toggle_like from anon, with a header explaining why (SECURITY DEFINER, reachable via PostgREST). 008_grant_new_table_roles.sql:20 then runs `GRANT EXECUTE ON ALL ROUTINES IN SCHEMA public TO anon, authenticated;` and sets ALTER DEFAULT PRIVILEGES to keep doing it for e

- **The indexer does not typecheck — 34 errors — which is what blocks the dependabot exit condition** `[S]`
  - `indexer/tsconfig.json:9`
  - Adding a `tsc --noEmit` job to CI is the cheapest half of dependabot's un-pause condition, and today it would fail on the first run for reasons that have nothing to do with the handler code. Dropping `composite` and adding `skipLibCheck` is a two-line change that turns the gate green and makes it meaningful.
  - *evidence:* `cd indexer && node_modules/.bin/tsc --noEmit -p tsconfig.json` → 34 errors. With --skipLibCheck, 14 remain, all TS4023 of the form "Exported variable 'stakingPosition' has or is using name 'onchain' from external module ... but cannot be named" — one per onchainTable in ponder.schema.ts. Both causes are in indexer/tsconfig.json:9: `"composite": true` forces declaration emit (which is what makes p

- **indexer/package.json declares `engines` twice; the stricter one is silently discarded** `[S]`
  - `indexer/package.json:22`
  - Duplicate JSON keys are legal and silent. Whoever raised the floor to Node 20 got no effect and no warning. Pick one.
  - *evidence:* Parsing with an object_pairs_hook shows top-level keys ['name','version','private','license','engines','type','scripts','dependencies','devDependencies','engines'] — `engines` appears at position 5 (node >=20.0.0) and again at position 10 (node >=18.0.0). JSON last-key-wins, so the resolved value is >=18.0.0.

- **ponder.config.ts is a second source of contract-address truth that the registry gate does not scan** `[S]`
  - `indexer/ponder.config.ts:529`
  - Clean now, unguarded structurally: a redeploy updates constants.ts, passes CI, and leaves ponder.config.ts pointing at the dead contract with nothing to say so. If item 10 resolves toward keeping the indexer, adding indexer/ponder.config.ts to the check-5 scan list is a few lines. If it resolves toward deletion, this evaporates.
  - *evidence:* I extracted all 8 address literals from indexer/ponder.config.ts and checked each against frontend/scripts/addresses.json — all 8 are present, so there is no drift today. But frontend/scripts/verify-addresses.mjs:73 sets its drift-check source to `join(HERE,'..','src','lib','constants.ts')` and its reverse check to contracts/broadcast; indexer/ is scanned by neither, and the registry's own rule 4 

- **indexer/nul is a 221 KB shell artifact kept alive by a dedicated .gitignore line** `[S]`
  - `indexer/nul`
  - Not harmful, but the repo now carries a gitignore rule whose only purpose is to hide a mistake. Delete the file and the line together. (Two more of the same shape sit untracked at the repo root — `nul` and `tl.so` — outside this area but worth the same treatment.)
  - *evidence:* `ls -la indexer/` shows `nul`, 221,374 bytes, dated 2026-04-18 — the file Windows creates when a POSIX shell redirects to `> nul`. `git check-ignore -v indexer/nul` → `.gitignore:15:indexer/nul`, a rule written specifically for it.

- **Two files named DEPLOY_RUNBOOK.md and two named DEVELOPING.md, at root and in docs/, with different content and no cross-reference** `[S]`
  - `DEPLOY_RUNBOOK.md vs docs/DEPLOY_RUNBOOK.md; DEVELOPING.md vs docs/DEVELOPING.md`
  - A relative link to `DEPLOY_RUNBOOK.md` resolves differently depending on the reader's directory, and one of the two targets is four months stale. Pick one canonical filename per concept.
  - *evidence:* Root DEPLOY_RUNBOOK.md line 1: "Deployment Runbook — Audit-Remediation Redeploy … Baseline commit `714d839`, Tip commit `25014a0`" (2026-04-26). docs/DEPLOY_RUNBOOK.md line 1: "Deploy runbook — **Status: written 2026-08-02**" about the two Vercel deploy paths. Root DEVELOPING.md line 3 links to `./DEPLOY_RUNBOOK.md` (resolves to the April one); docs/DEVELOPING.md "Publishing a release" links to `D

- **docs/SECRET_ROTATION.md instruction 1 lists the same domain three times — a visible botched find-and-replace** `[S]`
  - `docs/SECRET_ROTATION.md (lines 58-59; §Bucket C)`
  - An operator restricting a new key to one origin three times locks out the two domains the app actually serves from — a self-inflicted outage during a rotation, which is exactly when you least want one. One-line fix with a real consequence.
  - *evidence:* Lines 58-59: "Generate a new key in the provider dashboard; add origin restriction to `tegridyfarms.vercel.app` + `tegridyfarms.vercel.app` + `tegridyfarms.vercel.app`." The file's last commit is 9aff5579 "chore: purge tegridyfarms.xyz website refs repo-wide -> tegridyfarms.vercel.app" — the sed collapsed three distinct origins into one repeated three times. The real allowlist set today (per front

- **docs/LAUNCHPAD_GUIDE.md and CHANGELOG.md link to `tegriddy-farms` (double-d) — a repo slug that 404s** `[S]`
  - `docs/LAUNCHPAD_GUIDE.md line 169; CHANGELOG.md lines 4032-4033`
  - Three dead public links, one of them the only support channel offered to a creator who has just deployed a collection and hit a problem. The audit already found the class and the sweep missed these files.
  - *evidence:* docs/LAUNCHPAD_GUIDE.md:169: "Open a [Discussion](https://github.com/fomotsar-commits/**tegriddy**-farms/discussions)". CHANGELOG.md:4032-4033: `[v3.0.0-pre]: https://github.com/fomotsar-commits/tegriddy-farms/tree/main` and `[v2.x]: .../commits/main`. `git remote -v` → `https://github.com/fomotsar-commits/**tegridy**-farms.git` (single d). `.audit_101/055_StaticDrift.md:122` already logged this e

- **Two independent implementations of the Uniswap V4 PoolId hash, each with its own V4PoolKey type** `[S]`
  - `frontend/src/lib/launcher/lockerStream.ts:75`
  - Both are pinned by tests today so this is not currently a money bug — but curve/index.ts:35-38 and solana/README.md:252-256 both record that four copies of the curve maths produced a real one. The same directory now carries two copies of a hash whose disagreement would silently mis-identify a pool. Keep one (lockerStream's is pinned against a real on-chain Initialize id) and re-export it; if afterlife.ts is deleted per the first item, this resolves itself.
  - *evidence:* frontend/src/lib/launcher/afterlife.ts:51 exports `interface V4PoolKey` and :72 `computeV4PoolId(key)` = keccak256(encodeAbiParameters([currency0,currency1,fee,tickSpacing,hooks])). frontend/src/lib/launcher/lockerStream.ts:60 exports an identical `interface V4PoolKey` and :75 `poolKeyToId(k)` with the identical five-field encoding. Same directory, same viem call, byte-identical output. lockerStre

- **Duplicated comment block in curve/rpc.ts** `[S]`
  - `frontend/src/lib/launcher/solana/curve/rpc.ts:90`
  - Cosmetic, but it is a copy-paste artifact sitting on the most carefully-reasoned guard in the file — the one whose absence manufactured 'not-deployed' out of a malformed 200. Delete one copy.
  - *evidence:* frontend/src/lib/launcher/solana/curve/rpc.ts:90-92 and :93-95 are the same three comment lines verbatim ("`'result' in b` rather than `b.result !== undefined`: an explicit `\"result\": null` is a real answer and must survive, while a body with no `result` member at all is a non-answer and must not be mistaken for one."), both immediately above the single `if (!('result' in b))` at :96.

- **parseOrNull is byte-identical in all three schema files** `[S]`
  - `frontend/src/lib/schemas/aggregator.ts:86`
  - Three copies of the one helper the whole directory exists to provide. Whichever way the schemas item resolves (wire or delete), this should collapse to one module first.
  - *evidence:* Same 7-line body at schemas/aggregator.ts:86, schemas/geckoTerminal.ts:60, schemas/opensea.ts:144 — `const result = schema.safeParse(data); return result.success ? result.data : null;` with the same `<T extends z.ZodTypeAny>` signature. schemas.test.ts:24 imports one of the three arbitrarily.

- **Two competing "single sources of truth" for the staking lock tiers, and they disagree — the Yield Calculator silently omits the 6-Month lock** `[S]`
  - `frontend/src/lib/copy.ts:50`
  - A user who picks 6 Months in the staking form cannot model it in the Yield Calculator — the option simply isn't there. And copy.ts:60 `lockLabelForSeconds(180*86400)` returns `undefined`, so any surface that adopts it gets no label for a lock the contract accepts. The F113 comment claims the consolidation already happened; it half-happened.
  - *evidence:* constants.ts:147-159 `LOCK_OPTIONS` says "F113: single source of truth for the staking lock tiers. Previously copy-pasted in FarmPage, StakingCard, and BoostScheduleTable" and lists SEVEN tiers: 7, 30, 90, **180**, 365, 730, 1460 days. copy.ts:50-57 `LOCK_DURATIONS` lists SIX: 7, 30, 90, 365, 730, 1460 — no 180. Consumers split: StakingCard.tsx:193/395, BoostScheduleTable.tsx:29/54 and FarmPage.ts

- **Three isUserRejection implementations, and the mevProtection copy still carries the pre-R074 bug** `[S]`
  - `frontend/src/lib/mevProtection.ts:50`
  - Concrete failure: a user clicks "Add MEV Blocker RPC" and cancels the MetaMask prompt; the provider wraps the 4001 in an outer error carrying its own code, extractErrorCode returns the outer code, isUserRejection returns false, and useMevProtection.ts:97 falls through to the "genuine refusal" branch showing manual-setup instructions for a deliberate cancel. That is exactly the class R074 fixed in txErrors.ts. One helper, three bodies, and the two the audit didn't touch still have the defect. Collapse mevProtection's copy onto txErrors.ts:56.
  - *evidence:* txErrors.ts:56 is canonical — an 8-hop `.cause` walk checking `instanceof UserRejectedRequestError`, `code === 4001`, `name === 'UserRejectedRequestError'`, and 'user rejected'/'user denied' message substrings; its comment (lines 49-55) records AUDIT R074: "The legacy check only looked at the outer error and produced false-negative 'real failure' toasts for cancelled wallet prompts." mevProtection

- **navConfig PROMOTE_PENDING=true makes both address-derived gates unreachable; the NFT-finance half is now provably redundant** `[S]`
  - `frontend/src/lib/navConfig.ts:61`
  - A two-month-old staging switch is the only thing holding /community in the menu, and it also silently disables the isDeployed gating it was meant to temporarily bypass for NFT finance. The clean shape: drop the override from NFT_FINANCE_LIVE (verified no-op), keep it on COMMUNITY_LIVE only until the four governance addresses land in constants.ts, and put the reason on that line alone rather than sharing one flag. The file is otherwise unusually well documented — this is tidying, not a defect.
  - *evidence:* navConfig.ts:61 `const PROMOTE_PENDING: boolean = true;` then :71 `NFT_FINANCE_LIVE = PROMOTE_PENDING || NFT_FINANCE_ADDRESSES_LIVE` and :81 `COMMUNITY_LIVE = PROMOTE_PENDING || COMMUNITY_ADDRESSES_LIVE`. Short-circuit means neither address expression can ever affect the result. The file's own 2026-08-12 note at :46-48 says of the NFT-finance half: "three of its four addresses are real in constant

- **detection/index.ts barrel re-exports 15 module internals that nothing outside detection/ imports** `[S]`
  - `frontend/src/lib/detection/index.ts:16`
  - The barrel's header justifies keeping the split files importable "for tree-shaking or testing" — that argues for the split, not for promoting internals to the public surface. Trimming the two `export { … }` blocks at :16-42 to the eleven actually imported keeps the public API honest without touching any implementation.
  - *evidence:* Checked each barrel export for any reference outside src/lib/detection/ (ripgrep over src incl. .jsx). No consumers: `worseBand`, `evaluateGate`, `assessConfidence`, `headlineSentence`, `computeHHI`, `giniCoefficient`, `topNShare`, `sumBalances`, `clusterStats`, `includedSharesDesc`, `largestUnclassifiedShareOfTotal`, `bundledCurrentHeldShare`, `sniperHeldShare`, `computeMetrics`, `EXCLUDED_CATEGO

- **storage.ts exports the eviction whitelist for an audit fix that has no external consumer and no test** `[S]`
  - `frontend/src/lib/storage.ts:18`
  - Low stakes, but the export was the audit's deliverable and nothing pins it — the kebab-vs-snake prefix bug that motivated it ("settings not saving") could regress silently. A three-line test on isEvictable('tegridy-theme') / isEvictable('wagmi.store') is worth more than the export is.
  - *evidence:* storage.ts:18 `EVICTABLE_PREFIXES` and :21 `isEvictable` — zero references outside storage.ts (used internally at :22 and :58). The header at :4-9 explains they were exported as part of AUDIT R045 M4. storage.test.ts does not import either.

- **About 30 type-only exports with zero references — mostly normal TS hygiene, worth one pass not thirty** `[S]`
  - `frontend/src/lib/`
  - Most of these are legitimately exported because they annotate an exported function's parameters or return value — removing the export would be wrong. The genuinely prunable subset is the handful attached to already-dead symbols (ConditionalOrderParams with encodeConditionalOrderParams, LockOption, CertificationState) plus the three internal-only helpers. Recording it once so it does not get re-discovered as thirty separate findings.
  - *evidence:* The usage scan flagged these as having no reference outside their defining file: MetaAggregatorResult, AggregatorSpread, ConsentState, LockOption, ReceiptCopyKey, CowOrderSubmission, CowOrderStatus, CowSwapQuoteRequest, BuildCowSwapOrderParams, BuiltCowSwapOrder, ConditionalOrderParams, TwapPlanInput, TwapPlan, DiscoveryResult, DiscoveryOptions, DeployerReputationConfig, SummarizeDeployerOptions, 

- **Modal's FairValueBadge re-implements the exact formula lib/valuation.js was extracted to own** `[S]`
  - `frontend/src/nakamigos/components/Modal.jsx`
  - The stated invariant ("one formula everywhere") is currently false and nothing enforces it, so the next tweak to either copy silently makes the modal and the trade window disagree on the same token's value.
  - *evidence:* lib/valuation.js:4-6 states "estimateTokenValue mirrors the detail modal's FairValueBadge math exactly (one formula everywhere, so the trade window never disagrees with the modal)". Modal.jsx does not import it — components/Modal.jsx:32-34 computes `const percentile = 1 - (nft.rank - 1) / supply; const multiplier = 1 + Math.log1p(percentile * 9) / Math.log(10) * 1.5; const fairValue = Math.min(flo

- **Two unrelated things are both called "Pro", and one of them tells you to go buy the other** `[S]`
  - `frontend/src/nakamigos/contexts/TradingModeContext.jsx`
  - The default mode for every new user is Lite (TradingModeContext.jsx:32), so this toast is on the common path. "Pro feature" reads as paywalled when it is a free view toggle, and the page it points at exists to say the paid thing doesn't exist yet. Renaming the toggle (Simple/Advanced) costs nothing and removes the collision.
  - *evidence:* TradingModeContext.jsx:50 exposes `isPro` for a free Lite/Pro UI toggle persisted to localStorage. hooks/useProAccess.jsx:32 exposes `isPro` meaning "this wallet holds a Tegridy Pro Pass NFT". App.jsx:428 toasts `${label} is a Pro feature — switch to Pro in the header to view it` when a Lite user hits a hidden tab — a user who follows that to /pro lands on ProMembership.jsx:34, which renders the p

- **Favorites and My NFTs cards carry a 'VIEW ON OPENSEA' button the gallery grid doesn't** `[S]`
  - `frontend/src/nakamigos/components/Card.jsx`
  - The same NFT offers an outbound link on Favourites and My NFTs but not in the Gallery, and on My NFTs the card's only action for something you own is to go look at it elsewhere — where a List button belongs (Modal.jsx:567 already has the in-app onList path). The buy/view naming drift also makes the code read as a competing buy route.
  - *evidence:* Card.jsx:69-72 renders `<div className="card-buy-wrap"><button className="btn-buy-quick" onClick={handleBuy} aria-label={`View ${nft.name} on OpenSea`}>VIEW ON OPENSEA</button></div>`, where handleBuy (Card.jsx:12-15) is `window.open(OPENSEA_ITEM(...))`. Card is reached only through AnimatedCard (AnimatedCard.jsx:3/43), whose only two consumers are Favorites.jsx:62 and MyCollection.jsx:441 — the m

- **The Gallery headline over-counts by 3 — it uses the raw array length that UNIQUE_GALLERY_COUNT exists to correct** `[S]`
  - `frontend/src/pages/GalleryPage.tsx:88`
  - Two pages of the same site state different collection sizes (80 vs 77), and the page the dedupe was written for is the one that ignores it. One-token change.
  - *evidence:* pages/GalleryPage.tsx:88 renders `{GALLERY_ORDER.length} pieces`; pages/HomePage.tsx:819 renders `{UNIQUE_GALLERY_COUNT} original pieces`. Resolving every ART.* id in GALLERY_ORDER (artConfig.ts:338-366) gives 80 entries but 77 unique basenames — duplicated: /splash/new/1, /splash/new/7, /splash/new/28. lib/artConfig.ts:369-374 states UNIQUE_GALLERY_COUNT was created precisely "so the displayed co

- **Loader has dead geometry and two timing constants duplicated as magic numbers in the phases** `[S]`
  - `frontend/src/components/loader/geometry.ts:69`
  - Editing T_VORTEX_END today changes nothing; the phase keeps its own literal. That's the failure mode a timings block exists to prevent.
  - *evidence:* Zero consumers anywhere in components/loader: `buildSnakePath` (geometry.ts:69-91, 30 lines of spiral math), `TrailParticle` (types.ts:34), `T_VORTEX_END` and `T_TEXT_END` (constants.ts:57-58). Meanwhile phases/vortex.ts:7 hardcodes `const vortexDuration = 1500` and phases/shatter.ts:8 hardcodes `1500` with the comment `// T_SHATTER_END - T_ART_END` — i.e. a constant is declared as source-of-truth

- **slither.yml's "DEBUG (temporary)" step: removal condition can never be met, two phantom paths, off-pattern action SHA** `[S]`
  - `.github/workflows/slither.yml:95-107`
  - A temporary step whose exit condition is a state the repo has already accepted it will not reach. The SHA drift also means dependabot's github-actions ecosystem produces two separate bump PRs for the same action.
  - *evidence:* slither.yml:95-107 — "DEBUG (temporary) … Drop this step once CI is reliably green on `fail-on: medium`", against a workflow tracked as chronically red. Its path glob lists slither-report.json and slither-report.sarif, which the action is not configured to emit at the repo root (only `sarif: slither.sarif` is passed at line 87); `if-no-files-found: warn` hides that. It pins actions/upload-artifact

- **solana-deploy-artifact.yml violates the ${{ }}-into-bash rule its own comment states, and swallows the Anchor.toml pin failure** `[S]`
  - `.github/workflows/solana-deploy-artifact.yml:83-141`
  - Two separate problems in one step. The splice is workflow_dispatch-only so the blast radius is small, but the file asserts a hardening rule it does not follow — which is how the rule stops being applied elsewhere. The `|| true` is worse: if the sed pattern stops matching, anchor build rewrites declare_id! back to the committed value and the workflow publishes a deployable .so pinned to an address the operator does not control, which is exactly the failure the validate step (76-101) exists to prevent.
  - *evidence:* Lines 144-147 state the rule: "Inputs come through `env:`, never `${{ }}` inside the script: `${{ }}` is textual substitution performed BEFORE bash parses." But lines 83, 90, 115, 141, 185, 190-193 splice `${{ inputs.program_id }}` / `${{ inputs.deployer }}` / `${{ inputs.cluster }}` directly into `run:` bodies. Line 141 also ends `sed -i "s/^tegridy_launch = …" ../../Anchor.toml || true` — while 

- **Eight scripts have npm aliases and seven do not, and the two selector-capture scripts are near-duplicates** `[S]`
  - `package.json:6-15 + frontend/scripts/capture-locker-selectors.mjs:37-40 vs frontend/scripts/capture-airlock-selectors.mjs`
  - capture-locker-selectors is cited by the fixture it generates (frontend/src/lib/launcher/lockerSelectors.fixture.ts:38) as the regeneration command, so it is live, not dead — it is just harder to find than its twin for no reason. The shared opcode walk is the one piece of genuinely subtle logic in both files (skipping PUSH payloads) and now exists in two copies that can drift independently.
  - *evidence:* Root package.json aliases render-og-png, extract-abis, check-selectors, capture-airlock-selectors, diff-addresses, predeploy, verify-ownership, oneshot-guard. Unaliased: scripts/check-test-slice-coverage.mjs, scripts/verify-program-constants.mjs, scripts/pull-caller-credit.mjs, scripts/exotic-toweli-fork-rehearsal.mjs, frontend/scripts/capture-locker-selectors.mjs, frontend/scripts/csp-hash.mjs, f

- **solana-ci.yml triggers on pushes to every branch — the only workflow without a branches filter** `[S]`
  - `.github/workflows/solana-ci.yml:34-38`
  - Five jobs, two of which `cargo install --git` the Anchor AVM toolchain and run a solana-test-validator, fire on any push to any branch that touches solana/**. Nothing in the file says this is deliberate, and it is the only workflow written this way — most likely drift rather than intent, but confirm before narrowing, since a wider trigger on the diff-guard is arguably the safe direction.
  - *evidence:* solana-ci.yml:34-38 — `on: push: paths: ["solana/**", …]` and `pull_request: paths: […]`, with no `branches:` key. Every other push/PR-triggered workflow scopes to `branches: [main, mvp-launch]` (ci.yml:5-7, contracts-ci.yml:5/21, codeql.yml:4-7, gitleaks.yml:10-13, slither.yml:5/10, registry-onchain.yml:31/38).

- **PRs #268/#269/#271 are structurally unmergeable one at a time — each splits codeql-action across two versions** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.github/dependabot.yml (line 96)`
  - Three of the 19 open PRs can never go green alone, so they sit forever, and every future codeql-action release reproduces the same 4-way split. A `groups:` entry for `github/codeql-action/*` makes them arrive as one PR that passes.
  - *evidence:* Four separate dependabot PRs bump github/codeql-action 4.37.4→4.37.6, one per sub-action. .github/workflows/codeql.yml calls three of them (init line 40, autobuild line 46, analyze line 49) all pinned to the same SHA f205ea1c #v4.37.4. Merging any ONE leaves the other two at 4.37.4. Verbatim from `gh api repos/fomotsar-commits/tegridy-farms/check-runs/93036882041/annotations`: {"level":"failure","

- **Twelve tracked root images are byte-identical duplicates of frontend/public/art/ files that nothing references** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/HCc30jXbAAEPdIg.jpg`
  - This is a dedupe, not an art removal — every canonical copy under frontend/public/art/ stays and those are the only ones the app loads, so the preserve-art rule is satisfied. WORKORDER_V2.md line 91 already specifies the fix with the full file list and the warning to use explicit paths, never glob pathspecs.
  - *evidence:* Blob-SHA match via `git ls-tree -r HEAD`, every one exact: HCc30jXbAAEPdIg.jpg=art/smoking-duo.jpg (1,060,743 B), G8RpIY5a4AMjIYe.jpg=art/beach-sunset.jpg, G86hUvAagAMyFOu.jpg=art/jb-christmas.jpg, G27matobYAE_iFa.jpg=art/rose-ape.jpg, GzLhcj9bEAE89lL.jpg=art/porch-chill.jpg, GvcaxNeWwAA_-7e.jpg=art/ape-hug.jpg, Gn5CMrmbEAAbmG1.jpg=art/wrestler.jpg, GtNK4vzbMAMYJ5L.jpg=art/dance-night.jpg, Gu4WJc1

- **Four disposable junk files at repo root, none of them ignored** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/idx.html`
  - idx.html is the risky one — an 8 KB near-copy of the real index.html that would silently revert the social-unfurl fix if mistaken for a backup. The other three are noise. Delete all four; add `nul`, `*.so`, `*.mp4` to .gitignore.
  - *evidence:* `nul` (46 B) contains a captured shell error, literally "/usr/bin/bash: line 1: cd: too many arguments" — a Windows `> nul` redirect run inside bash, which creates a real file. .gitignore line 15 already ignores `indexer/nul` for this exact accident but not the root one. `tl.so` (514,320 B) is `ELF 64-bit LSB shared object, *unknown arch 0x107*, stripped` — a compiled Solana SBF program binary, da

- **.claude/scheduled_tasks.lock is a runtime lock committed to git** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.claude/scheduled_tasks.lock`
  - A stale lock naming a dead PID ships to every clone and every worktree and churns the diff of anyone whose tooling touches it. `git rm --cached` plus one .gitignore line.
  - *evidence:* 90 B, tracked, content `{"sessionId":"6a589b58-d501-4655-ac29-57022a43c1de","pid":6756,"acquiredAt":1776261162193}` — acquiredAt is ≈2026-04-15. One commit touches it: fefa2506 "Add dark/light mode, 138 frontend tests, mobile responsive fixes", i.e. swept in accidentally. It already produces spurious diffs: `git -C .claude/worktrees/zealous-borg-d961c3 status` shows ` D .claude/scheduled_tasks.loc

- **.claude/launch.json hardcodes a machine-specific absolute node path** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.claude/launch.json (line 6)`
  - Silently fails for any contributor not on Windows or with node installed elsewhere. One-token fix: `"node"`.
  - *evidence:* Line 6 is `"runtimeExecutable": "C:\\Program Files\\nodejs\\node.exe"` — an absolute Windows path committed to a shared repo. The repo pins a node version via a tracked .nvmrc, so the resolved `node` on PATH is already the intended interpreter.

- **.gitattributes omits .avif and .mov from its binary list** `[S]`
  - `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.gitattributes (binary block, ~line 29)`
  - `text=auto` heuristics normally classify these correctly, so this is prophylactic rather than an active bug — but a false positive on a 1 MB .mov would corrupt it on checkout. Two lines in the existing block.
  - *evidence:* Line 1 sets `* text=auto eol=lf` globally, then a binary block lists *.png *.jpg *.jpeg *.gif *.webp *.ico *.woff *.woff2 *.ttf *.otf *.pdf. Missing: *.avif and *.mov, both tracked — frontend/src/lib/artConfig.ts line 46 loads '/splash/new/1.avif', and frontend/public/videos/vid02.mov is 1,035,042 B, the 4th-largest non-vendored blob.

- **Tests pin the wrong BondingCurve size as a literal, re-deriving the same stale belief** `[S]`
  - `frontend/src/lib/launcher/solana/curve/program.test.ts:115-118`
  - Both tests are self-consistent with the encoder they test, so they can never fail — exactly the vacuous-pass mode the GlobalConfig comment warns about. Fixing item 1 without fixing these means the fix is unproven.
  - *evidence:* `it('BondingCurve = 162 (state.rs:123-166)')` asserts `DISC + 2*PUBKEY + 7*U64 + BOOL + PUBKEY + U8 === BONDING_CURVE_SIZE` — seven u64s (the struct has eight) and no mode/segment fields. read.test.ts:595-602 is a describe block titled 'the account sizes the rent reads use / match the layouts' whose comment explains the GlobalConfig lesson verbatim, then does `expect(GLOBAL_CONFIG_SIZE).toBe(723)`

- **Three doc comments in the program attached to the wrong item when the segmented fields were inserted** `[S]`
  - `solana/tegridy-amm/programs/tegridy-launch/src/lib.rs:582-598`
  - These are what an IDL and any generated docs will carry, and one of them relocates a warning about the flag that terminates a curve onto an unrelated field. All three were introduced by the same #277 insertion.
  - *evidence:* lib.rs:582-587 is a `///` block reading 'Open a launch: mint the whole supply onto a fresh curve … `mode` selects the pricing curve' — the docs for `create_launch`. A blank line follows, then 589-597 documents set_curve_segments, then `pub fn set_curve_segments` at 598. Rust concatenates both blocks onto the next item, so set_curve_segments' docs now open by describing create_launch, and `create_l

- **Three different vector counts for one fixture; `index.ts` says 3,125 and the file has 3,815** `[S]`
  - `frontend/src/lib/launcher/solana/curve/index.ts:18-19`
  - Small, but the count is the number quoted to auditors as the strength of the port's proof, and there are three of them in a directory whose stated purpose is being the single source of truth.
  - *evidence:* index.ts:19 'differentially proven against 3,125 Rust-generated vectors'. `grep -c '^  \[\[' curveVectors.fixture.ts` = 3815, matching the fixture's own header ('3,815 cases') and OWN_CURVE_FRONTEND_CONTRACT.md:27 ('3,815 input/output rows'). Separately, tegridy-launch-operator.mjs:8-9 claims the config math is 'diffed against the real curve.rs over 50,009 cases' — a fourth number, for a file (`te

- **`frontend/create-fee-atas.mjs` is an untracked operator tool sitting outside the directory every other operator tool lives in** `[S]`
  - `frontend/create-fee-atas.mjs:1-15`
  - An uncommitted script that derives and creates real fee-receiving accounts, living where nothing else does and reviewable by nobody. Either move it to frontend/scripts/ and commit it (it reads a keypair path from ENV and creates idempotent ATAs — same posture as the committed harnesses), or delete it. Leaving it untracked in the tree is the worst of both.
  - *evidence:* Shows as `??` in `git status`. Header: 'One-time operator tool: create the wSOL + USDC fee ATAs for the Tegridy Solana fee wallet, using the SAME libraries + derivation the app uses.' It hardcodes `FEE_OWNER = 'DVGiHe98CzEf7VuCS6YpVDFnp38ubJmKNLt6aMJwAyER'`. The two sibling Solana operator harnesses are `frontend/scripts/solana-dbc-operator.mjs` and `frontend/scripts/tegridy-launch-operator.mjs`.

- **A live git worktree still sits on the already-merged create-amm-config branch** `[S]`
  - `C:/tw`
  - A full second checkout pinned to a superseded commit of the Solana AmmConfig work, which is exactly the setup that produces edits made against a stale tree. One `git worktree remove` away. (Flagging only this one — the ~90 dirs under .claude/worktrees/ are general repo hygiene, outside this area.)
  - *evidence:* `git worktree list` reports `C:/tw   c16191e7 [claude/create-amm-config-builder]`. That work landed on trunk as 4c230cca 'feat(cp-swap): the create_amm_config builder — the last missing instruction (#285)'.


## DELIBERATE — leave alone (18)

- **migrate-art-imgs.mjs: ternary with two identical branches, plus a one-shot migration with four unconverted matches** — `frontend/scripts/migrate-art-imgs.mjs:45`
  - The dead ternary is a zero-risk delete. The four remaining conversions are NOT: ART_POOL_ALL auto-rotates into every <ArtImg>, so converting them changes which art renders on the nav logo, receipt, connect prompt and consent banner. Treat the migration as intentionally stopped and say so in the header (or delete the script), rather than leaving a "one-shot" that a future session will run to completion by accident.
- **BUNDLE_LISTING_ENABLED and the bundle routes are a deliberate three-part gate — leave alone** — `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/api/orderbook.js:1041`
  - Listed so the next sweep does not re-file it as dead code. Everything here is intentionally inert, the intent is written down at each site, and the inert direction is the safe one. No action.
- **API_INDEXER_AUDIT.md is a dated historical audit, not live documentation — leave alone** — `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/API_INDEXER_AUDIT.md:3`
  - A dated audit record is supposed to describe the code as it stood on its date; rewriting it destroys the record. Distinct from docs/API.md, which presents itself as current reference and is the one worth fixing. No action beyond not mistaking it for live docs.
- **Echidna harness has no runner, no config file, and has never executed** — `contracts/test/echidna/MVPLaunch_AMMEchidna.t.sol:18`
  - Three AMM safety properties are parked in a file nothing can execute. The honest options are (a) add contracts/echidna.config.yml plus a dispatch-only workflow so an auditor can run the 24h campaign, or (b) delete the directory and its exclusion entry. The current state is the worst of both: it reads as coverage and is not.
- **KNOWNDEFECT test pins live defective behaviour and is written to hard-fail the day the defect is fixed** — `contracts/test/StakingBoostResidual_2026_08_12.t.sol:472`
  - This is the only open-by-design tripwire in the suite and it is correctly built (it fails loudly rather than rotting). What is unfinished is the decision behind it: an early exit permanently destroys reward residue that the expired exit preserves, and the choice between (a) and (b) is gated on the TegridyStaking bytecode budget, which is an owner call.
- **`pass5-pocs` is a whole CI matrix job for one file and four tests** — `.github/contracts-test-slices.json:71`
  - Worth deliberately NOT doing unless runner minutes are the constraint: slices run in parallel, so wall-clock is max(slice), and merging trades a small billing saving for a slightly longer critical path. Flagging it so the asymmetry is a choice rather than an oversight.
- **LEAVE ALONE: abi-supplement.ts is a 4,000-line generated file and should stay that way** — `frontend/src/lib/abi-supplement.ts`
  - Only about ten of its ~200 ABI entries are ever called, so it looks like prunable bloat — but hand-pruning breaks the generator contract and the next regeneration reverts it. If bundle size matters, the change belongs in the generator (emit only referenced selectors), not the artifact. Reporting so it is not re-flagged.
- **LEAVE ALONE: seven repo-guard tests live in src/lib/ and each explains why** — `frontend/src/lib/siteIdentity.test.ts`
  - They look like orphans (a test with no source) and will be flagged by any future inventory. Moving them to a src/__guards__/ directory would cost a vitest include change for no benefit — the placement is what makes them run.
- **LEAVE ALONE: explorer.ts carries Goerli and 17 non-mainnet chains the app never connects to** — `frontend/src/lib/explorer.ts:17`
  - Technically stale, but the tables are inert lookup data with a documented mainnet fallback (:59-64), and getChainLabel's whole point (:69-70) is "don't lie about being on mainnet" for chains it doesn't know. Trimming buys nothing and would make the helper worse if a testnet or L2 is ever added. Recording it so it isn't re-raised.
- **Correctly-gated drafts and freshly-verified docs — deliberate, leave alone** — `docs/NATIVE_BUY_ROUTER_DESIGN.md, docs/WHETSTONE_MIGRATOR_PETITION.md, docs/RESTAKING_EIP170_SPLIT_DESIGN.md, docs/CURVE_FORK_EVALUATION.md, docs/GOLIVE_CORELOOP.md, docs/CANCEL_PENDING_OWNERSHIP_2026_07.md, docs/OPERATOR_PACKET_2026_08_12.md, docs/MIGRATION_HISTORY.md, CONTRACTS.md, TOKENOMICS.md, NOTICE.md, docs/DUNE_QUERIES.md`
  - Listing these so the operator does not spend time on them. They are the house style working: status in the first line, gates named, dates on every claim, and a test behind the address tables. The stale docs above were written before that convention existed. The cheapest systemic fix is to extend the docsAddressTruth / docsClaimHonesty test pattern to assert that every script and asset path referenced in docs/ and root markdown actually exists — that one gate would have caught roughly a third of the findings in this report.
- **The certified/Garden third tier: interface written, no consumer, no test, no preview panel** — `frontend/src/lib/heat/certification.ts:39`
  - PARTLY DELIBERATE AND SHOULD STAY THAT WAY: isCertified() answering 'not-published' while VITE_ISLAND_CERTIFICATION_URL is unset, and isCovenantActive() being hardcoded false with no env flag, are correct fail-closed choices and the comments explain them at length — do not 'clean these up'. What is genuinely unfinished is (a) the disclosure panel covenantFeeConstitution() was written for, so the third tier is invisible to users, and (b) certification.ts has no test, so its fail-closed branches (unreadable → not certified, truthy-but-not-true → not certified) are unproven — the one behaviour the spec is emphatic about. Add certification.test.ts; treat the panel as a product decision, not debt.
- **SeasonalEvent: 144 lines and a permanent 60-second timer on every page, for a list hardcoded to []** — `frontend/src/components/SeasonalEvent.tsx:34`
  - Keeping the component is deliberate and correctly reasoned (the RULE at :29-32 is worth preserving). The actionable part is narrow: short-circuit the timer when the list is empty, and drop `seasonal:0` from the art inventory until an event exists. Do NOT delete the component or its regression-guard tests (SeasonalEvent.test.tsx:56-77) — they are the thing stopping an unbacked reward promise from coming back.
- **RevenueDistributor's dust-reconcile residue is deliberate — do not clean it** — `contracts/src/RevenueDistributor.sol`
  - Listing it so nobody re-flags it. The one real observation underneath: this retirement landed 2026-08-07 and the live RevenueDistributor was deployed 2026-06-06, so the ABI-preservation argument is about a FUTURE deploy — it is covered by the src-vs-chain drift item, not by a cleanup.
- **The remaining undeployed src is deliberately gated, not abandoned — recorded so it is not re-triaged** — `contracts/src/v4`
  - Roughly 40% of the file count in this area is intentionally gated, and every gate is documented at the point of use. The only genuinely unowned things are the four items reported above (FeeExecutorRouter, the Uniswap fee leg, the missing Phase-7 restaking script, and RestakingMonitorView's deploy path).
- **DO NOT dedupe the art/drop ↔ art/new and nakamigos ↔ splash blob pairs** — `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/frontend/public/art/new`
  - Worth deliberately NOT doing. Both path families are loaded by the app, the rotation pool resolves by path, and preserve-art is a hard rule. Collapsing ~9 MiB of duplicate art would save disk and break surfaces — a bad trade. The root-image dedupe is the only safe one, precisely because those twelve have zero references.
- **Loose-object churn in the object store; run gc only after the other cleanups** — `C:/Users/jimbo/OneDrive/Desktop/tegriddy farms/.git`
  - Genuinely borderline — 26 MiB loose is not a problem by itself, and the object store is a rounding error next to the 26.3 GB of duplicated submodule clones. Worth one `git gc` AFTER the refs/remotes/pr/* deletion and the worktree removal, when it will actually reclaim something. Not worth doing before.
- **CORRECTION — 'Echidna has no config file and has never executed' is wrong on both counts; only the missing runner is real** — `contracts/echidna.config.yml`
  - Acting on the item as written sends someone to author a config that is already there and tuned, and understates the evidence base — 53M sequences with zero falsifications is a real result worth citing to an auditor, not a gap. Merge it into the ops-ci item and keep only the runner half. ONE genuine sub-finding survives and is new: echidna.config.yml:37-39 says 'Persisted corpus … Commit corpus snapshots to git so CI runs warm-start from prior progress', while contracts/.gitignore:17 excludes `echidna-corpus/` — so the warm-start the config depends on can never happen. The ops agent recorded `git ls-files contracts/echidna-corpus` = 0 as 'gitignored, not debt'; given the config's instruction it is a contradiction, and one of the two files has to change.
- **CORRECTION — contracts/.skip-broken/ has six tracked files; the repo-hygiene pass excluded it as empty** — `contracts/.skip-broken`
  - Not the finding itself — that one is already filed and correct — but the exclusion. A dropped item hides better than a wrong one, and this is the second place in these receipts where a dot-prefixed path was assumed untracked (the same receipt notes .gitignore 'states a falsehood about dotfiles'). Worth re-checking any other 'excluded, 0 tracked files' judgement made against a dot-path in that pass.