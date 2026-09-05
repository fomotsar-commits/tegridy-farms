# The 44 `[code]` items — audited against the tree, 2026-08-22

Six agents audited every unticked `[code]` line in
[`YEAR_PLAN_2026_2027.md`](YEAR_PLAN_2026_2027.md), plus a completeness critic. Each verdict is
checked against source files, tests and git history — **the plan doc was treated as a claim, not
as evidence**. Where a search was inconclusive the answer is UNKNOWN, never "not there".

| | |
|---|---|
| **Audited** | 44 items |
| **Status** | 27 PARTIAL · 10 NOT_STARTED · 7 DONE |
| **Buildable today** | 13 NO_NEEDS_OPERATOR · 25 YES · 6 NO_NEEDS_EXTERNAL |

"Buildable today" means an agent could land it with **no keys, no deploy, no third-party
account, no live database**. Authoring a migration file counts; running it does not.

## ▶ The queue — buildable now, cheapest first

| Plan line | Est. | Status | Item |
|---|---|---|---|
| 134 | 2 h | PARTIAL | Guided first-run onboarding flow |
| 75 | 2.5 h | PARTIAL | Honesty-debt sweep: addresses.json, README pool figures, PWA wrong-brand manifest, "Last reviewed" dates |
| ~~119~~ | — | ✅ **DONE 2026-08-26** | Ghost-code guard extended to components — `frontend/src/components/componentsAreMounted.test.ts` |
| 99 | 3 h | PARTIAL | Fix indexer gaps: factory governance ABI events, env docs, synthetic keys (INDEXER-H1/H2) |
| 103 | 3 h | PARTIAL | Keyless public scanner API (v1) + docs |
| 133 | 4 h | PARTIAL | Fiat on-ramp widget (Coinbase Onramp / MoonPay aggregate) |
| 161 | 4 h | NOT_STARTED | Liquid locker (stTOWELI) design spike only — build waits for pool depth |
| 43 | 6 h | NOT_STARTED | 015 §2 read-side per table (votes needs an aggregate view first) |
| 122 | 6 h | PARTIAL | LaunchGate/HeatCard/launch-flow e2e |
| 165 | 6 h | PARTIAL | Premium rebundle: API keys, higher caps, bulk scans; correct the unit-confused pricing analysis |
| 135 | 7 h | PARTIAL | EIP-5792 batched transactions (approve+swap one confirmation — highest-leverage zero-surface UX win) |
| 123 | 8 h | NOT_STARTED | Server tests for `_lib/launch-radar.js`, `notifyBirth.ts`, `VotePowerOracle` |
| 102 | 9 h | PARTIAL | Server-side token scanner + public token pages + shareable scan cards / OG unfurls |
| 97 | 10 h | PARTIAL | Frontend GraphQL client: real Leaderboard/History, per-pool volume/TVL, treasury activity feed, timelock queue |
| 150 | 10 h | PARTIAL | If Solana restart: land ~15 scheduled audit fixes (or delete segmented mode — it carries both HIGHs) |
| 139 | 11 h | NOT_STARTED | "Towelie" insights rules engine (free, no-API half) |
| 145 | 14 h | NOT_STARTED | Explorer/afterlife enriched from the indexer: real graduation rates + fee histories on fact sheets |
| 180 | 20 h | PARTIAL | Protocol v2 batch: streaming RevenueDistributor · factory timelock · dead penalty-code removal · IVotes delega |

Total: **18 items, ~128.5 agent-hours.**

---

# Every item, in plan order

## Line 65 — Close PR #278 (would revert the gate to the retired 180-day rule)

**DONE** · buildable: YES · ~? h

**Evidence.** `gh pr view 278 --json state,closedAt` -> {"state":"CLOSED","closedAt":"2026-08-22T20:17:19Z"}. Corroborated by docs/TODO_OPERATOR.md:554-558. The plan line is already `- [x]` and its supersession reasoning checks out: trunk's gate is 657c5170 (#286) and `assertMayLaunch` is wired into both rails.

**Risk.** The line is Q1-scoped and will be archived. The durable fact inside it — that the 180-day floor is now a config knob (`VITE_HEAT_LAUNCH_FLOOR`), not a code change — lives only in this bullet and in TODO_OPERATOR item 2. If both get archived the next person who wants a held-time floor will re-open #278's approach from scratch.

**How to do it.**

Nothing to build. Leave the `[x]` exactly as it is — do NOT re-verify by reopening the PR. One optional 5-minute edit: move the sentence "if the floor is wanted it is a config change (`VITE_HEAT_LAUNCH_FLOOR`), not a re-merge" out of this plan bullet and into the heat/launch-gate docs beside `frontend/src/lib/heat/launchGate.ts`, so it survives the Q1 archive. Verify with `gh pr view 278 --json state` (expect CLOSED) and `grep -rn VITE_HEAT_LAUNCH_FLOOR frontend/src`.

## Line 74 — Commit Supabase base schema (5 of 10 live tables unbuildable from repo) + restore script; verify backups capture data

**DONE** · buildable: YES · ~2 h

**Evidence.** Commit 6b78e15b (2026-08-19, 'supabase: make the database rebuildable, and close the RLS review gap'), an ancestor of HEAD. It adds frontend/supabase/migrations/000_base_schema.sql (498 lines — CREATE TABLE for all five missing tables messages/user_profiles/user_favorites/user_watchlist/votes, plus a schema_migrations ledger at §0, with every column tagged [DDL]/[CODE]/[INFERRED] so guessed types are visible), frontend/supabase/RESTORE.md (266 lines, ordered restore with the 015-before-014 and never-008-after-014 traps), frontend/scripts/supabase-restore.mjs (472 lines, dry-run default, partial-restore-is-failure) and frontend/scripts/supabase-restore.test.mjs (315 lines, incl. a workflow/RESTORE_ORDER parity test at :52-59 and a duplicate-migration-number test). frontend/api/__tests__/rlsCoverage.test.ts:121 shows RLS_NOT_ESTABLISHED_BY_MIGRATION emptied with the reasoning.

'VERIFY BACKUPS CAPTURE DATA' — answered, read-only, no database access. `gh run list --workflow=supabase-backup.yml` shows six consecutive successes (latest 31996436719, 2026-08-17). Its log: `native_orders: 4 rows`, and 0 rows for trade_offers, messages, dm_messages, user_profiles, user_favorites, user_watchlist, votes, push_subscriptions, revoked_jwts. So backups DO capture data (4 real rows dumped), and the nine zeros are the true state — SIWE login has never worked. Stronger: .github/workflows/supabase-backup.yml:139-141 makes a 404 a hard failure and :224-227 exits 1 if ANY table fails, so a green run is positive evidence that all ten tables exist in production — including the five that no migration creates.

**What is left.** Nothing for the line as written. Open, and NOT on the plan: five tables are in no backup at all. frontend/scripts/supabase-restore.mjs:97-105 enumerates them as DRIFT — analytics_events (013), alert_rules (016), api_keys (017), airdrop_manifests and airdrop_manifest_entries (018) — and RESTORE.md repeats it. .github/workflows/supabase-backup.yml:103 still lists only the original ten. 018's own header notes a lost manifest makes a funded airdrop unclaimable by everyone, because the chain stores one 32-byte root and nothing else.

**Risk.** THE TRAP on the remaining slice: adding those five to `TABLES=` will BREAK the weekly backup if their migrations have not been applied to production. dump_table returns 2 on a 404 (workflow :139-141), the job exits 1 on any failure (:224-227), and nobody can currently tell which of 013/016/017/018 are live — MIGRATIONS.md's opening line is that 'has it been applied?' is unanswerable in this repo. Turning a green weekly backup red is a worse outcome than the drift. Second risk on the DONE half: 000_base_schema.sql was derived from code, not read from the live database (its own header, :26-42, says so) — so anyone tempted to tick this as 'the schema is now known-correct' is overreading it. It is rebuildable, not verified.

**How to do it.**

TICK LINE 74. It is done, including its last clause. Rewrite it as: `- [x] `[code]` Commit Supabase base schema + restore script — ✅ shipped 2026-08-19 `6b78e15b` (000_base_schema.sql, RESTORE.md, scripts/supabase-restore.mjs + test). Backups verified capturing: run 31996436719 (2026-08-17) dumped native_orders: 4 rows, nine tables at 0 — and because the workflow hard-fails on a 404, that green run also proves all ten tables exist in prod. Caveat: 000 was derived from code, not read from the live DB (see its header) — rebuildable, not verified.`

THEN OPEN A NEW LINE for the drift, because it is a different problem and burying it inside a ticked line loses it: `- [ ] `[code]` Five tables are in NO backup — analytics_events (013), alert_rules (016), api_keys (017), airdrop_manifests + airdrop_manifest_entries (018). A lost manifest makes a funded airdrop unclaimable.`

To land that new line: edit .github/workflows/supabase-backup.yml. Do NOT append the five to `TABLES=` at :103 — add them to `OPTIONAL_TABLES=` at :111 (currently empty), which the workflow treats as 'warn if absent, do not fail' (:188-191). That captures them wherever the migration IS applied and degrades to a warning where it is not, instead of turning the weekly backup red on an unknown. Then mirror the change in frontend/scripts/supabase-restore.mjs: move the five out of NOT_IN_BUNDLE (:97-105) into RESTORE_ORDER, give each an entry in CREATED_BY (:108-119) naming its migration file, and place airdrop_manifest_entries AFTER airdrop_manifests (foreign key direction — read 018 to confirm the edge before ordering). The parity test at scripts/supabase-restore.test.mjs:52-59 compares RESTORE_ORDER against the workflow's TABLES= line and will fail if you update one and not the other; if you use OPTIONAL_TABLES, that test needs to learn about the second list — extend it deliberately rather than deleting the assertion. Update the 'Not in any bundle' row in frontend/supabase/RESTORE.md to match, or the runbook now lies.

VERIFY: `cd frontend && npx tsc -b --noEmit && npm run lint && npx vitest run`. The restore-script tests are collected (scripts/ is in vitest.config.ts's include; the file header at supabase-restore.mjs:52-55 says so explicitly). Also sanity-check the YAML parses: the TABLES=/OPTIONAL_TABLES= lines are consumed by a bash `for` loop, so quoting matters.

## Line 85 — `arbLinkageMonitor` on a real 5-min cron + auto-pause hook consuming HALT

**DONE** · buildable: YES · ~0.2 h

**Evidence.** Both halves shipped in `762e421f` (2026-08-19), later given a PR gate by `f33aaa73`. Cron: .github/workflows/arb-linkage-monitor.yml:43-44 `schedule: - cron: "*/15 * * * *"`. It is genuinely firing — `gh run list --workflow=arb-linkage-monitor.yml --limit 6` shows six consecutive `success` scheduled runs on 2026-08-22 at 22:16, 22:44, 22:58, 23:19, 23:41, 23:56 UTC. HALT consumer: scripts/monitoring/arbPauseConsumer.mjs (`--probe` writes `arb_status`/`arb_report`/`arb_fingerprint` to GITHUB_OUTPUT); the workflow opens or updates a fingerprinted incident issue on HALT|ERROR (:82-126) and separately fails the job on HALT|ERROR (:184-198), with the rule's own unit tests re-run on the live runner at :180-182.

**Risk.** The line as written promises two things the implementation deliberately does NOT do, and a bare `[x]` would leave the plan claiming both. (a) Cadence is 15 minutes, not 5 — the file's header at :16-25 explains why (GitHub's scheduler drops `*/5` under load and disables schedules after 60 days of repo inactivity) and states plainly that 15 min "is not comfortably inside" the window the modelled 30-minute grind attack needs. (b) The pause is PREPARED, never sent: arbPauseConsumer.mjs:14-26 records the trade — a key that can pause on a schedule is a key sitting in a public CI runner — so time-to-pause is bounded by a human reading a notification. Also `TEGRIDY_LENDING` (workflow :75) is an unset repo var until TegridyLending deploys, so the consumer reports that target as absent rather than guessing.

**How to do it.**

REWRITE the plan line; do not just tick it. Replace it with: "[x] `[code]` arbLinkageMonitor on a 15-minute GitHub cron + a HALT consumer that opens an incident and renders the exact privileged pause call — shipped 2026-08-19 `762e421f`. NOT 5 minutes and NOT automatic: shared CI cannot be held to 5 min, and no signing key lives in the workflow. Verified firing: six consecutive successful scheduled runs 2026-08-22." Then add a NEW `[op]` line underneath for the residual: "If a TWAP-dependent feature ever carries real value, move this to a scheduler that can be held to its interval" — that is a hosting decision, not code, and the workflow header at :23-25 already says so.

No code change is warranted. Specifically do NOT (a) change the cron to `*/5` — it would look tighter and be less reliable, and the header explains that; (b) add a signing key to the workflow to make the pause automatic — that is strictly worse than the current trade and the reasoning is written down at arbPauseConsumer.mjs:14-26.

VERIFY the claim before ticking: `gh run list --workflow=arb-linkage-monitor.yml --limit 6 --json conclusion,createdAt,event` (expect scheduled successes ~15-20 min apart) and `node --test contracts/monitoring/lib/arbLinkage.test.mjs scripts/monitoring/lib/pausePlan.test.mjs`.

## Line 117 — Launcher one-click launch-buy (Doppler Quoter min-out + UniversalRouter build — the GO-LIVE TODO)

**DONE** · buildable: YES · ~0.3 h

**Evidence.** Shipped 2026-08-19 in commit 436c5aad ("launcher + zap: finish one-click launch-buy…", whose message says verbatim "The ratchet exemption is gone"). Both named halves exist: min-out from a real Doppler V4 Quoter at frontend/src/lib/launcher/launchBuy.ts:392 `planLaunchBuy(quoter, request)` calling `quoter.quoteExactInputV4` at :428 then `minOutFromQuote` at :443; the UniversalRouter build at launchBuy.ts:190 `encodeV4ExactInSingleSwap` (V4_SWAP 0x10 + SWAP_EXACT_IN_SINGLE/SETTLE_ALL/TAKE_ALL, transcribed from vendored contracts/lib/v4-periphery @7ebd04b1 per the header at :14-22) and the 5792 batch composer `buildLaunchBuyCalls` at :272 (Permit2 approve + PERMIT2.approve + swap for ERC20; bare swap for native). Mounted: useOneClickLaunchBuy.ts:60 calls it; LaunchBuyPanel.tsx:141-151 wires the real SDK (`new Quoter(publicClient, CHAIN_ID)`, `getAddresses(CHAIN_ID).universalRouter`); LaunchPage.tsx:783 renders the panel. The ghost-code guard now POSITIVELY ASSERTS the mount at hooks/hooksAreMounted.test.ts:113-118. Verified green: `npx vitest run src/lib/launcher/launchBuy.test.ts src/components/launcher/LaunchBuyPanel.test.tsx src/hooks/hooksAreMounted.test.ts src/lib/portfolio` → 5 files, 182 tests passed; `npx tsc -b --noEmit` exit 0.

**Risk.** Do not tick this without reading launchBuy.ts:40-43, which states in the file itself: "NOT YET FORK-PROVEN END TO END… a create+buy fork run against a live auction pool is the outstanding proof for this encoding". scripts/ contains only exotic-toweli-fork-rehearsal.mjs, which proves `create()`, not the buy leg. So the CODE line is done; the PROOF is not, and it is an `[op]`/fork-run task on a money path where the user has already paid for the launch by the time the panel renders. Second residual: LaunchBuyPanel.tsx:329-333 prints the batch id and stops — it never polls `wallet_getCallsStatus`, so a user has no in-app confirmation the buy landed, even though `parseCallsStatus` (src/lib/zap/batchStatus.ts:36) and a working polling loop (src/hooks/useZapRun.ts:304) exist one directory over.

**How to do it.**

This line is DONE as written — tick it, and REWRITE it rather than deleting it, because a bare tick would erase the one thing still open. Edit docs/YEAR_PLAN_2026_2027.md line 117 to: "- [x] `[code]` Launcher one-click launch-buy (Doppler Quoter min-out + UniversalRouter build) — ✅ shipped 2026-08-19 `436c5aad` (`src/lib/launcher/launchBuy.ts` encodes the V4_SWAP UniversalRouter call from vendored v4-periphery @7ebd04b1; `LaunchBuyPanel` on `LaunchPage` is the surface; the ghost-code guard now asserts the mount instead of exempting it). RESIDUAL, not code: the create+buy encoding is not fork-proven end to end (`launchBuy.ts:40-43`) — `[op]` run a create+buy against a live auction pool on a mainnet fork before promoting it." Then, in the SAME edit, fix line 120, whose parenthetical is now false in every clause (see surprises). Do NOT touch any source file for this item. Verify the doc edit broke nothing: `cd frontend && npx vitest run src/lib/docsClaimHonesty.test.ts src/lib/docsAddressTruth.test.ts` — neither test reads YEAR_PLAN today (grep confirms), so this is a cheap regression check, not a real gate.

## Line 120 — Mount the EIP-5792 pair and the gateAudit read surface

**DONE** · buildable: YES · ~0.2 h

**Evidence.** EIP-5792 pair: `useOneClickStake` is mounted at frontend/src/pages/FarmPage.tsx:106; `useOneClickLaunchBuy` at frontend/src/components/launcher/LaunchBuyPanel.tsx:87, and that panel is rendered at frontend/src/pages/LaunchPage.tsx:783. gateAudit read surface: frontend/src/components/heat/GateAuditPanel.tsx is imported at frontend/src/components/LaunchGate.tsx:23 and rendered at :193 and :211; LaunchGate is mounted on three pages — CurveLaunchPage.tsx:13, LaunchPage.tsx:82, SolanaLaunchPage.tsx:16. Both are pinned by tests: frontend/src/hooks/hooksAreMounted.test.ts:113-118 asserts the two-hop useOneClickLaunchBuy -> LaunchBuyPanel -> LaunchPage chain, and frontend/src/components/heat/GateAuditPanel.mounted.test.tsx renders <LaunchGate/> and asserts the panel appears in COLD and STALE and is absent in WARM and no-wallet. Commits: `7ba46691` (routing) and `436c5aad` (one-click launch-buy).

**Risk.** The plan line's parenthetical is now FALSE and actively misleading: it says "`useOneClickLaunchBuy` is a named exemption (it needs the Doppler-encoded V4 UniversalRouter call, which no module produces, and a launch-buy surface, which cannot exist while `isLauncherEnabled()` is false)". Both boundaries are gone — the comment at hooksAreMounted.test.ts:108-112 records it: `launchBuy.ts` encodes the call and `isLauncherEnabled()` is true. The ONLY exemption left in UNMOUNTED_BY_DESIGN (hooksAreMounted.test.ts:32-39) is the `^useIndexed` family, blocked on there being no hosted GraphQL endpoint. Anyone reading line 120 today would go looking for an exemption that no longer exists.

**How to do it.**

Tick the line and delete the stale parenthetical. New text: "[x] `[code]` Mount the EIP-5792 pair and the gateAudit read surface — ✅ `7ba46691` / `436c5aad`. `useOneClickStake` -> FarmPage, `useOneClickLaunchBuy` -> LaunchBuyPanel -> LaunchPage, GateAuditPanel -> LaunchGate -> three launch pages. Pinned by `hooksAreMounted.test.ts` and `GateAuditPanel.mounted.test.tsx`. The old exemption for `useOneClickLaunchBuy` is gone: both boundaries it named (no V4 UniversalRouter encoder, no launch-buy surface) have been removed."

While editing, correct the related claim elsewhere: line 97's indexer bullet says the `useIndexed*` hooks "are carried as a named exemption in hooksAreMounted.test.ts" — that one is still TRUE (hooksAreMounted.test.ts:32-39) and should stay as written.

VERIFY before ticking: `cd frontend && npx vitest run src/hooks/hooksAreMounted.test.ts src/components/heat/GateAuditPanel.mounted.test.tsx`. Both should pass; if the useOneClickLaunchBuy test fails, the mounting regressed and the tick is wrong.

## Line 121 — Fix CommunityPage FeatureNotDeployed copy contradiction

**DONE** · buildable: YES · ~0.5 h

**Evidence.** All four CommunityPage call sites now distinguish deployed-but-unwired from undeployed: frontend/src/pages/CommunityPage.tsx:269 "Community governance is deployed — not yet enabled here" / "The CommunityGrants contract is live on Ethereum mainnet", :275 (MemeBountyBoard), :281 (VoteIncentives), :290 (GaugeController) — each subtitle names the live mainnet contract and says the app opens "once its address is wired into the frontend". The class is pinned, not just the instance: frontend/src/pages/deployClaimHonesty.test.ts:70-85 walks every non-test source file and fails on any sentence containing both a non-existence phrase and one of the four governance contracts; :92-105 asserts the four wired addresses are non-zero while TegridyLending stays zero (the counterweight against over-correcting); :108-120 asserts ContractsPage carries a literal 'unwired' status plus all four real on-chain addresses.

**Risk.** One residual that is a maintainer trap rather than a user-facing lie, and worth closing while the context is fresh: the shared component is still NAMED `FeatureNotDeployed`, its docstring at frontend/src/components/ui/FeatureNotDeployed.tsx:14-23 still defines it as "a feature whose on-chain contract isn't part of the current deployment — i.e. its address is the zero address in constants.ts", and it renders a hardcoded "SOON" badge at :41. For the four Community call sites all three of those are wrong in the same direction the original defect ran: the contracts ARE deployed and only the frontend constant is 0x0. deployClaimHonesty.test.ts strips `//` and block comments before matching (:48-55), so the docstring is invisible to the guard by design.

**How to do it.**

Tick the line: "[x] `[code]` Fix CommunityPage FeatureNotDeployed copy contradiction — ✅ the four call sites now read 'is deployed — not yet enabled here' and name the live mainnet contract; the CLASS is pinned by `src/pages/deployClaimHonesty.test.ts` (a surface may say a feature is unavailable *here*; it may not say a contract does not *exist*)."

OPTIONAL 30-MINUTE FOLLOW-UP, worth doing while you are in the file: rename the component to something state-neutral — `FeatureUnavailableHere` — and rewrite its docstring at FeatureNotDeployed.tsx:14-23 to describe the THREE states the guard's own header enumerates (deployed+wired, deployed-not-wired, not-deployed) instead of collapsing them into "address is the zero address". Consider making the "SOON" badge at :41 a prop, since "soon" is a promise the four Community surfaces cannot keep on their own schedule. This is a pure rename plus a comment; the guard will not notice either way, which is precisely why it needs a human.

TRAP: do not weaken any FeatureNotDeployed wall while renaming. deployClaimHonesty.test.ts:101-105 exists to catch over-correction — TegridyLending really is undeployed and ITS wall must survive.

VERIFY: `cd frontend && npx vitest run src/pages/deployClaimHonesty.test.ts && npx tsc -b --noEmit && npm run lint`.

## Line 176 — Base L2: go/no-go memo + deploy scripts (ROADMAP Q4 commitment)

**DONE** · buildable: YES · ~0.5 h

**Evidence.** Both halves shipped in 710e4a0e (2026-08-19 21:54), on mvp-launch. Memo: docs/BASE_L2_GO_NO_GO.md, 357 lines, with an explicit recommendation at :13 — 'Recommendation: NO-GO for now. Ship the scripts (done — contracts/script/base/), keep the…' — and sections §1 provenance of every number, §2 costs, §3 earnings, §4 risks, §7 what must be true first, §9 if the answer becomes yes, §10 if the answer stays no. Scripts: contracts/script/base/BaseChainConfig.sol (83), DeployBaseMVP.s.sol (291), VerifyBaseMVP.s.sol (216), guarded to Base's chain id so they cannot run against mainnet by accident; test at contracts/test/base/DeployBaseMVP.t.sol (315). ROADMAP.md:84 sets the metric as 'Ship-ready deploy scripts merged and a published decision memo' — both satisfied.

**Risk.** None on the code. The risk is the doc drift: three separate artifacts (YEAR_PLAN line 176, ROADMAP.md:85, BATTLE_PLAN #37) describe this as unstarted, and a session that trusts any one of them will rebuild 900 lines that already exist and are tested.

**How to do it.**

Tick plan line 176 with the shipped marker the doc's own convention requires (docs/YEAR_PLAN_2026_2027.md:9-15): '- [x] `[code]` Go/no-go memo + deploy scripts (ROADMAP Q4 commitment) — ✅ shipped 2026-08-19 `710e4a0e`. The memo decides NO-GO (docs/BASE_L2_GO_NO_GO.md:13); scripts are chain-id-guarded to Base so they cannot be run against mainnet. Mainnet stays the only configured chain.' The line committed to scripts and a decision, not to launching, and that is exactly what landed — record the NO-GO in the tick so a future session does not read the checkbox as 'we went to Base'.

Also REQUIRED, same pass, because it is a live false claim in a public-facing doc: ROADMAP.md:85 currently reads '**Status: not started.** No memo, no Base deploy scripts. Carried forward as year-plan Q4 and as docs/BATTLE_PLAN.md #37.' Both sentences are false as of 710e4a0e. Rewrite to point at the memo and the scripts and to state the NO-GO. ROADMAP.md was last touched by 012c6f58 at 2026-08-19 01:15, twenty hours before the work landed — that timing is the whole explanation and worth a line in the commit message.

While in the memo, note it produced two findings that are NOT on any plan line and belong somewhere durable: §6.1 'The mainnet guardian rotation cannot complete as written' (:255) and §6.2 '`code.length > 0` is no longer a Safe check' (:290). Both are mainnet-custody findings surfaced by a Base slice. §6.1 in particular touches the Q1 custody critical path.

Verify: `cd contracts && forge test --match-path test/base/DeployBaseMVP.t.sol`.

## Line 39 — Enumerate the live 21 permissive qual=true policies against 015's 12 (documented gap)

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~1.5 h

**Evidence.** frontend/supabase/migrations/015_drop_permissive_policy_overrides.sql:5-14 records the live read (role postgres, 2026-08-12: RLS on all 10 public tables, 40 policies). docs/OPERATOR_PACKET_2026_08_12.md:157 states '21 of 40 policies are PERMISSIVE with qual = true'. The 21-vs-12 reconciliation is recorded three times as prose: docs/EVERYTHING_LEFT_2026_08_15.md:71-74, docs/TODO_OPERATOR.md:126-129, docs/WHAT_I_NEED_FROM_YOU.md:47-50 — '8 targets of 015 §1, 4 deferred read-side, 9 intentional (public chat/orderbook/service-role); expected count after the change-set: 13'. The enumeration SQL itself is committed as docs/OPERATOR_NEXT.md:39-57 (step A1) and again as the verification block at 015:104-120. 015's 12 = 8 uncommented DROPs (015:64-78) + 4 commented (015:95-98).

**What is left.** Two halves. (a) [op] — the live read is dated 2026-08-12, ten days stale, and docs/OPERATOR_NEXT.md:41-42 explicitly instructs 'Confirm it still matches before changing anything.' Re-running pg_policies against production is not authorable as a repo file; it needs the Supabase dashboard. (b) [code], landable — the raw 21 rows were never committed. I grepped docs/, frontend/supabase/, frontend/api/, frontend/scripts/ for '21 permissive', 'qual=true', '40 policies', '9 intentional' and every hit is a prose summary. The '9 intentional' figure is arithmetic (21 − 8 − 4), not an enumerated list; it is reconstructable only from 015:41-50's paragraph, which names messages ×2, native_orders ×1, trade_offers ×1, revoked_jwts ×1 and then an unnamed 'the Service role can …' group. Nobody can re-derive the 9 by name today.

**Risk.** The stale-read risk is real but small: the tables are empty (proved independently — see the backup-run evidence on line 74), so nothing can have changed them by use. The bigger risk is that the plan line reads as unstarted work, so a session re-does an analysis that is finished and burns the operator's session budget on it. Second risk: if an agent decides to 'close' this by inventing the 9 policy names from 015's prose, the repo acquires a fourth confident claim with no read behind it.

**How to do it.**

Do NOT try to run SQL — the item as written requires reading a live database and is mislabeled [code]. Two actions.

1. REWRITE the plan line. Replace line 39 with two lines: an `[op]` line reading 'Re-run OPERATOR_NEXT.md A1 (pg_policies enumeration) at the top of the SQL session — the reconciliation is DONE (8+4+9=21 vs 015's 12, expect 13 after; docs/EVERYTHING_LEFT_2026_08_15.md:71-74), this is a freshness re-check on a 2026-08-12 read, not new analysis', and optionally the `[code]` line in step 2.

2. LANDABLE [code] SLICE — make '9 intentional' an enumerated list instead of a subtraction. Create `frontend/supabase/POLICY_INVENTORY.md` with one row per policy: table, cmd, policyname, and which of three buckets it is in (015 §1 target / 015 §2 deferred / intentional). The 12 in 015 you can name exactly from frontend/supabase/migrations/015_drop_permissive_policy_overrides.sql:64-78 and :95-98. For the 9 intentional, name only what 015:41-50 actually names — messages 'Anyone can read' and 'Anyone can read messages', native_orders 'Anyone can read orders', trade_offers 'Anyone can read trades', revoked_jwts 'Service role only' — and mark the remaining ~4 'Service role can …' rows as UNKNOWN-BY-NAME with the note that they were counted, not listed. THE TRAP: do not fill those four in from imagination to make the table look complete. A row that says UNKNOWN prompts the operator to paste the real name; a row that guesses ends the check. Cross-reference frontend/supabase/migrations/002_native_orders_trades_push.sql and 007_p2p_trades_and_chat.sql for candidate service-role policy names, and mark anything you take from there as INFERRED-FROM-MIGRATION, not OBSERVED — 004 is only partially applied (docs/OPERATOR_PACKET_2026_08_12.md:140-147), so a migration is not proof of live state.

VERIFY: `cd frontend && npx tsc -b --noEmit && npm run lint && npx vitest run`. A markdown-only change should be green; if it is not, you touched something else.

## Line 40 — castVote → proxyWrite repoint (merged + deployed) before anything else

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~0.25 h

**Evidence.** MERGED — commit c66e6064 (2026-08-18, 'nakamigos: route the last anon-key write through the proxy'), confirmed an ancestor of HEAD on mvp-launch via `git merge-base --is-ancestor`. frontend/src/nakamigos/lib/userdata.js:471-501 — castVote now calls `proxyWrite({ table: "votes", method: "UPSERT", body: { wallet, token_id: String(tokenId), week } })` and returns a discriminated {ok,status} instead of `!error`. Tripwire: frontend/src/nakamigos/userdataWriteHonesty.test.js:39-50 regex-fails the suite if any mutating verb (.insert/.upsert/.update/.delete/.rpc) reappears in userdata.js. I independently grepped frontend/src/nakamigos for direct supabase mutations: zero remain (all `.delete(` hits are JS Set/Map calls). NOT DEPLOYED — docs/OPERATOR_NEXT.md:124-130 (step A5) and docs/TODO_OPERATOR.md:150-160 (§0.2) both still list the Vercel redeploy as outstanding as of 2026-08-21/22, and frontend/dist/ is untracked (`git ls-files frontend/dist/*` returns 0 files), so the local bundle is not evidence of prod.

**What is left.** Only the deploy. The [code] half is complete and guarded by a test. `git ls-files` shows no open branch or PR touching this (`gh pr list` returns 15 open PRs, all dependabot). The redeploy is a Vercel action and must happen BEFORE 015 §1 runs, or the deployed bundle is still the anon-key writer against dropped policies.

**Risk.** Ordering risk, not code risk: if 015 §1 is applied while prod still serves the pre-c66e6064 bundle, writes are refused with 42501 and the OLD code returns a bare boolean, so they vanish silently — which is the exact failure c66e6064 exists to prevent. The plan line's own word 'deployed' is load-bearing and easy to tick off on the strength of 'merged'. Note also c66e6064's finding, recorded in its commit message and in docs/UNFINISHED_INVENTORY_2026_08_13.md:132: castVote has zero callers (the vote UI was never wired), so the 'kills voting silently' framing was about the library, not a live user path.

**How to do it.**

The code work is DONE. Do not re-implement it. Edit the plan line.

Rewrite line 40 as: `- [x] `[code]` castVote → proxyWrite repoint — ✅ shipped 2026-08-18 `c66e6064`; userdata.js:471 goes through the SIWE proxy and userdataWriteHonesty.test.js trips if a direct anon-key mutation reappears. ⚠️ The DEPLOY half is `[op]` and still open — see OPERATOR_NEXT.md A5; prod must serve this bundle BEFORE 015 §1 runs.` Then add (or fold into the existing line 41 `[op]` step) an explicit 'redeploy Vercel' as the first action of the change-set rather than the fifth.

If you want to add value beyond the doc edit, the one genuinely landable thing is a guard that the ordering cannot be got wrong by memory: there is no test asserting 'redeploy precedes 015'. That is a runbook property, not a code property, so prefer strengthening docs/OPERATOR_NEXT.md A0 (which already says 'You must redeploy before step A2') by moving that sentence out of A0's body and into A2's heading, where the operator is standing when it matters.

VERIFY the code claim yourself before ticking: `cd frontend && npx vitest run src/nakamigos/userdataWriteHonesty.test.js src/nakamigos/lib/userdata.test.js` — both should pass. Then `git log --oneline -1 c66e6064` and `git merge-base --is-ancestor c66e6064 HEAD` to confirm it is on trunk.

## Line 71 — Branch protection for path-filtered checks — the OLD prescription is obsolete; arm the rule on the now-correct contexts

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~1.5 h

**Evidence.** The `[code]` half landed today: `cdd58b06` deleted the four `-not-applicable.yml` companions and added `.github/scripts/diff-scope.mjs` + a `scope` job in each of the four workflows (slither.yml:39, contracts-ci.yml:49, registry-onchain.yml:65, solana-ci.yml:71), pinned by frontend/src/test/requiredCheckSynthesis.test.ts and frontend/src/test/diffScope.test.ts. The `[op]` half is NOT done and nothing at all is armed: `gh api repos/fomotsar-commits/tegridy-farms/branches/mvp-launch/protection` -> 404 "Branch not protected"; `gh api .../rulesets` -> exactly one ruleset (id 16492952, name "121") with `"enforcement":"disabled"`. Context strings verified correct and unique: `Static analysis` (slither.yml:90), `all-tests-pass` (contracts-ci.yml:750), `registry vs chain` (registry-onchain.yml:118), `all-checks-pass` (solana-ci.yml:835), plus ci.yml's `Lint, Type Check & Test` (:20), `Build` (:212), `E2E Tests` (:257), `E2E Tests (Anvil fork — money paths)` (:356).

**What is left.** (a) [op] Arm the branch-protection rule / enable the disabled ruleset on mvp-launch — today ZERO checks are required, so any of the four red gates can be merged past. (b) [code, landable now] ci.yml has NO aggregator job, unlike contracts-ci (`all-tests-pass`) and solana-ci (`all-checks-pass`), so its four jobs must each be named individually and a fifth job added later is invisible to branch protection. Flagged at docs/UNFINISHED_INVENTORY_2026_08_13.md:286-287 and never fixed.

**Risk.** Two traps. (1) Do NOT re-add a companion workflow — `paths` and `paths-ignore` are not complements and re-adding one reintroduces the exact defect measured on #205 (real Slither FAILED, 2-second shim passed, only the pass surfaced). requiredCheckSynthesis.test.ts will go red if you try. (2) Arming protection while E2E is red (it is: run 32598383834) blocks every merge including the fixes. Arm the green contexts first, or land the E2E fixes first.

**How to do it.**

REWRITE the plan line, then do the landable half.

PLAN EDIT: line 71 currently narrates the deleted-companion history at paragraph length. Compress it to one `[op]` bullet — "Arm branch protection on mvp-launch; the checks are now singular and reportable (`cdd58b06`)" — and move the #205 post-mortem into the header of frontend/src/test/requiredCheckSynthesis.test.ts, where it already lives verbatim. Add a second `[code]` bullet for the ci.yml aggregator below.

LANDABLE CODE SLICE (do this): add an `all-ci-pass` job to .github/workflows/ci.yml. Copy the shape from .github/workflows/contracts-ci.yml:749-770 exactly — `needs: [lint-typecheck-test, build, e2e, e2e-anvil]`, `if: always()`, and a step that fails when any `needs.*.result != 'success'`. ci.yml has no `scope` job, so you do NOT need the two-complementary-steps dance that contracts-ci/solana-ci use; a single result-reading step is correct. Then extend frontend/src/test/requiredCheckSynthesis.test.ts's "solana-ci exposes one aggregate check to require" describe block (currently :250-282) to assert the same shape for ci.yml, so a future fifth job cannot escape the aggregate.

VERIFY: `cd frontend && npx vitest run src/test/requiredCheckSynthesis.test.ts src/test/diffScope.test.ts && npx tsc -b --noEmit && npm run lint`.

OPERATOR HANDOFF (write this list into docs/TODO_OPERATOR.md, do not perform it): required contexts to tick are `Lint, Type Check & Test`, `Build`, `all-ci-pass` (once the above lands), `Static analysis`, `all-tests-pass`, `registry vs chain`, `all-checks-pass`. Confirm afterwards with `gh api repos/fomotsar-commits/tegridy-farms/branches/mvp-launch/protection --jq '.required_status_checks.contexts'` — it returns 404 today, which is the proof nothing is armed.

## Line 75 — Honesty-debt sweep: addresses.json, README pool figures, PWA wrong-brand manifest, "Last reviewed" dates

**PARTIAL** · buildable: YES · ~2.5 h

**Evidence.** addresses.json is NOW CORRECT and the plan's "UNVERIFIED" label is answered: frontend/scripts/addresses.json:75 and :83 both read "CLOSED ON MAINNET 2026-08-13 ... This program id is SPENT", and :88-100 register both ProgramData accounts with `"expect": {"type": "absent"}`. Nothing in the file says "live, DEPLOYED" about a closed program. BUT the root README.md was never swept — `git log --oneline -5 -- README.md` shows its last touch is 63f83136 (#300), predating today's 8-file Solana correction (514942c5), and it still asserts the opposite of the truth in four places: README.md:287 "Code on trunk, deployed to no cluster ... returns `null` on both mainnet-beta and devnet (checked 2026-07-31)", :378 "deployed to NO cluster: verified 2026-07-31", :379 "also deployed to no cluster", :597 "two programs, deployed to no cluster at all". Both were deployed 2026-08-08 and closed 2026-08-13. "Last reviewed: July 2026" is in THREE files, not five: frontend/src/pages/SecurityPage.tsx:368, FAQPage.tsx:259, ContractsPage.tsx:501 (plus AUDITS.md:199, "Last reviewed: 2026-05-06"). PWA: frontend/public/manifest.json and manifest.webmanifest both carry the corrected multi-chain `description`, but `"name": "Tegridy Farms"` survives in both, and frontend/index.html:42 still reads `<title>Tegridy Farms | TOWELI Yield Farm</title>`.

**What is left.** (1) README.md lines 287, 378, 379, 597 — the largest surviving instance of the exact defect this item names, and it is on the repo's front page. (2) The three "Last reviewed: July 2026" page stamps + AUDITS.md:199. (3) index.html:42's single-chain title, which the manifest fix did not cover. (4) README pool figures are stale-but-honestly-dated (line 101: 7.38 WETH "read on-chain 2026-08-02"; line 538: native pair "drained, ~$14 as of 2026-08-02") — a re-read is an operator/RPC task, but re-stamping or removing the date is not.

**Risk.** The failure mode that produced this item is correcting one file at a time and calling the class closed — commit 514942c5 fixed eight files under frontend/src/lib/launcher/solana/ and the plan then recorded "the Solana half is DONE", while README.md sat three directory levels up saying the opposite. Do not repeat it: grep the WHOLE tree, not the directory you were pointed at. Second trap: the "Last reviewed" stamps must not simply be bumped to today — the pages have not actually been reviewed, and stamping an unreviewed page is a fresh lie, not a fix.

**How to do it.**

Four separate, independently landable edits.

(1) README.md — the important one. Fix lines 287, 378, 379, 597. Replace every "deployed to no cluster / getAccountInfo returns null / checked 2026-07-31" claim with the timeline that frontend/scripts/addresses.json:75,83 already states: deployed to mainnet-beta 2026-08-08, both programs closed 2026-08-13, both ids permanently SPENT and non-redeployable, graduation never ran because cp-swap's AmmConfig was never created. Copy the wording from frontend/src/lib/launcher/solana/curve/index.ts:13 and README at frontend/src/lib/launcher/solana/README.md rather than inventing new prose — those were reviewed today. Do NOT delete the sections; the rail's existence is still true, only its deployment state changed.

(2) The three page stamps. Either delete the "Last reviewed" line from SecurityPage.tsx:368 / FAQPage.tsx:259 / ContractsPage.tsx:501, or actually read each page's claims against the tree first and then stamp today's date. Deleting is honest; bumping without reading is not. Same choice for AUDITS.md:199. While you are in ContractsPage, note deployClaimHonesty.test.ts:108-120 already pins its address list, so a careless edit there goes red — that is the guard working.

(3) frontend/index.html:42 — `<title>Tegridy Farms | TOWELI Yield Farm</title>` still sells a single-chain farm. The manifests' `description` was already corrected; the title was missed. The product NAME is an open operator decision (docs/OPERATOR_NEXT.md), so do not rename to memetic.fun unilaterally — but the "| TOWELI Yield Farm" suffix is a factual claim about scope and can go now.

(4) README pool figures at :101 and :538 are dated 2026-08-02 and internally consistent, so they are stale rather than dishonest. Leave the numbers, but confirm the date stamps are still attached to every figure. Do not re-read the chain — that needs an RPC and is not this item.

CLOSE THE CLASS, don't just fix the files: add a guard in the style of frontend/src/pages/deployClaimHonesty.test.ts that fails when any tracked doc asserts a Solana program is undeployed while frontend/scripts/addresses.json records it CLOSED. That is what stops the fifth sweep.

VERIFY: `grep -rn "deployed to no cluster\|checked 2026-07-31" --include=*.md .` returns nothing outside docs/ history files; `grep -rn "Last reviewed" frontend/src` returns nothing (or today's date); `cd frontend && npx vitest run && npx tsc -b --noEmit && npm run lint`.

## Line 96 — Deploy the Ponder indexer + hosting config + CI job

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~2 h

**Evidence.** Hosting docs real: indexer/DEPLOY.md (9.8KB runbook, 088ed89e, extended by 814e2f2e) + indexer/.env.local.example:1-59. CI job absent: .github/workflows/ci.yml has zero steps with working-directory: indexer; the only workflow naming it is .github/workflows/npm-advisories.yml:61 (project: [".","frontend","indexer"]) which is an audit matrix, not a build gate. No hosting manifest tracked: `git ls-files | grep -iE 'railway|fly.toml|Dockerfile|Procfile|render.yaml'` returns only solana/tegridy-amm/docker-compose.yml. I ran the typecheck myself: `npx tsc -p indexer/tsconfig.json --noEmit --composite false --incremental false` emits ~30 errors, ALL inside indexer/node_modules; adding --skipLibCheck yields ZERO errors.

**What is left.** (1) The deploy itself — operator, costs money, creates an account. (2) The CI job — nothing exists; fully landable today. (3) A hosting manifest file (railway.json or Dockerfile) — nothing exists; landable today. Note the plan line calls DEPLOY.md 'hosting config'; it is a runbook plus an annotated env list, not a config a platform reads.

**Risk.** Adding skipLibCheck weakens type checking of dependency surfaces — acceptable and standard, but say so in the diff rather than slipping it in. A CI job that runs `ponder codegen` without checking whether it dials out could add a flaky network dependency to every PR. Also: indexer/node_modules on this machine dates from Apr 17 while package.json pins ponder ^0.8.30 — a fresh `npm ci` in CI installs from package-lock.json and could surface errors my local run did not.

**How to do it.**

TWO landable pieces; the deploy is not one of them.

A) THE CI JOB. First fix the blocker: indexer/tsconfig.json has no "skipLibCheck". Add `"skipLibCheck": true` to its compilerOptions. Without it a plain `tsc` in indexer/ fails on vendored .d.ts only — @electric-sql/pglite (Cannot find namespace 'Emscripten'), drizzle-orm/mysql-core (SQLWrapper/getSQL), and drizzle-orm/node-postgres (no @types/pg). I verified those are the ONLY errors: with --skipLibCheck the indexer's own 1,974 lines typecheck clean. Second trap: indexer/tsconfig.json sets "composite": true, so `tsc --noEmit` is not universally legal — either drop composite or invoke `npx tsc -b --noEmit` (the same shape frontend/ uses). Then add a job to .github/workflows/ci.yml modelled on the existing 'Solana indexer unit tests' step (ci.yml:84-85) — a separate top-level job with `defaults.run.working-directory: indexer`, SHA-pinned actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 and actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 with `cache-dependency-path: indexer/package-lock.json`, `npm ci --ignore-scripts`, then `npx tsc -b --noEmit`. Do NOT add `ponder codegen` blind: it loads ponder.config.ts, and whether 0.8.x codegen touches the network is unverified here — if you want it, add it as a second step and read the run log before treating it as a gate. No RPC key is needed for the typecheck: ponder.config.ts:493-509 falls back to viem's public transport with a warning when PONDER_RPC_URL_1..4 are unset.
VERIFY: `cd indexer && npx tsc -b --noEmit` exits 0 locally, and `gh run view <id>` shows the new job green on the PR.

B) THE HOSTING MANIFEST. DEPLOY.md §1 already picked Railway and §2 names the exact settings (root indexer/, build `npm ci`, start `npm run start`, Node >=20). Encode that as indexer/railway.json (schema: build.builder NIXPACKS, deploy.startCommand, deploy.healthcheckPath) — and set healthcheckPath to `/ready`, NOT `/health`: DEPLOY.md §3 spells out that /health is 200-always and says nothing about sync, so a /health check routes traffic to an indexer that has indexed nothing.

C) THE DEPLOY. Operator only. Do not attempt it, do not create accounts, do not set VITE_INDEXER_URL.

PLAN LINE: after (A) and (B) land, rewrite the annotation so only the deploy is outstanding — the current text says 'the deploy and the CI job are the remaining halves' and the CI job will no longer be one.

## Line 97 — Frontend GraphQL client: real Leaderboard/History, per-pool volume/TVL, treasury activity feed, timelock queue UI

**PARTIAL** · buildable: YES · ~10 h

**Evidence.** Client shipped as claimed: frontend/src/lib/indexer/client.ts (376 lines), queries.ts (177), hooks/useIndexedQuery.ts (194), tests client.test.ts (325) + queries.test.ts (143), commit 088ed89e. BUT the plan's parenthetical 'wired to no page' is STALE — three later commits wired it: 2c67d86e (lib/terminal/feed.ts:72 TERMINAL_FEED_QUERY over indexedPairs+pairEvents, mounted pages/TerminalPage.tsx:48), 7a69e809 (useCopyLeaderboard/useCopySignals/useCopyFollowerFills/useCompetitionStandings, mounted pages/CopyTradingPage.tsx:50-52 and pages/CompetitionsPage.tsx:40), b4200931 (lib/chart/pairSwaps.ts:63 PAIR_SWAPS_QUERY + useChartCandles, mounted components/chart/ChartPage.tsx:41,61). useIndexedSwaps/useIndexedStakingHistory are consumed by hooks/useTaxReport.ts:101-102, mounted at pages/TaxPage.tsx:54. bot/src/indexerClient.js is a fifth consumer. The FOUR SURFACES THE LINE NAMES are still not indexer-backed: pages/LeaderboardPage.tsx:3 uses usePoints/pointsEngine; pages/HistoryPage.tsx:10-12 uses lib/txHistory (Etherscan proxy); pages/TreasuryPage.tsx:20 uses fetchAddressTxList — grep for 'polEvent' across frontend/src returns ZERO hits; grep for 'timelockProposal' across frontend/src returns ZERO hits; hooks/usePoolTVL.ts:25 reads getReserves on-chain, not the indexer.

**What is left.** Four GraphQL documents + readers + page wiring, none of which exist: (a) treasury activity feed over the polEvent table (indexer/ponder.schema.ts, 6 discriminated types), (b) timelock queue UI over timelockProposal (contract/key/type/executeAfter/expiresAt), (c) an indexer-backed Leaderboard (the swap table already backs a copy-trading board — the points Leaderboard is a separate page), (d) indexer-backed History (stakingAction + swap already have hooks; HistoryPage just does not use them). Per-pool VOLUME is derivable and half-present via pairEvent; per-pool TVL is NOT derivable from any current table — there is no reserves/sync row.

**Risk.** The biggest risk is re-asserting the stale 'wired to no page' framing and building a second, parallel client. There is one client and five consumers already; adding a sixth pattern fragments the ready-gate. Second risk: rendering an empty page from a not-ready indexer as a legitimate zero — every query must keep requesting `_meta { status }` (client.ts:152 INDEXER_META_SELECTION) so a backfilling indexer surfaces as 'backfilling', never '0 ETH swept'.

**How to do it.**

This is pure dark authoring — the whole point of the client's design is that it self-gates. isIndexerConfigured() (lib/indexer/client.ts:64) is false with VITE_INDEXER_URL unset, so a new surface renders 'unavailable', exactly like the four already shipped. Tests mock fetch; no live indexer.

COPY THE ESTABLISHED SHAPE, do not invent one. Read frontend/src/lib/terminal/feed.ts end-to-end first: it is the reference implementation (query constant + zod row schema + a pure reducer + a test that asserts the query text matches the schema). Then per surface:
1. Treasury feed. New frontend/src/lib/treasury/polFeed.ts: `POL_FEED_QUERY` over `polEvents(where: $where, orderBy: "timestamp", orderDirection: "desc", limit: $limit)`. Column names come from indexer/ponder.schema.ts polEvent VERBATIM — type, ethUsed, toweliAdded, lpCreated, sender, amount, recipient, token, lpAmount, tokenOut, ethOut, oldTreasury, newTreasury, timestamp, txHash. Add a hook via hooks/useIndexedQuery.ts and render it on pages/TreasuryPage.tsx BESIDE the existing Etherscan feed, not instead of it.
2. Timelock queue. New frontend/src/lib/governance/timelockQueue.ts over `timelockProposals`. THE TRAP that decides whether this surface is honest: the row's `key` is keccak256(TYPE_CONSTANT ‖ subject) — it tells you a proposal is pending but NOT which pair/token/address it is about (indexer/ponder.config.ts:255-275 and indexer/DEPLOY.md §6 both spell this out). Render 'a change of type X is queued, subject not indexed', never a fabricated subject. Landing YEAR_PLAN item 99's semantic-events half first is what makes a subject-resolving queue possible.
3/4. Leaderboard + History. Both already have working hooks — useIndexedSwaps and useIndexedStakingHistory. Wire them into LeaderboardPage/HistoryPage as an ADDITIONAL, clearly-labelled indexed section that reports `unavailable`/`backfilling` from the hook state; do not replace the points engine or the Etherscan history, or the pages go blank the moment the indexer is down.

MANDATORY SIDE-EFFECT: frontend/src/hooks/hooksAreMounted.test.ts:32-38 exempts /^useIndexed/ as 'unmounted by design'. That exemption is ALREADY false (useTaxReport mounts them via TaxPage) and its own staleness check at line 81 cannot see it, because the check only looks for importers outside src/hooks. Delete the exemption in the same PR.

PER-POOL TVL — READ THIS BEFORE PROMISING IT: no table carries reserves. pairEvent has mint/burn amount0/amount1, so a running reserve is reconstructible by summation only if you index from the pair's first block and never miss an event, which is a strictly weaker guarantee than getReserves. Either add a `Sync(uint112,uint112)` subscription + reserves table to the indexer, or leave TVL on usePoolTVL and say so on the plan line.

VERIFY: from frontend/ — `npx tsc -b --noEmit && npm run lint && npx vitest run`. Also assert in a test that each new query string only names columns present in indexer/ponder.schema.ts; queries.test.ts already pins field lists that way and exists because a wrong column name comes back as a GraphQL error the client correctly reports as 'unavailable' — a silent permanent outage.

PLAN LINE: rewrite it now regardless. 'wired to no page' is false and is the second confidently-wrong claim this file has carried.

## Line 98 — Solana leg or cron: DBC pool trades + partner-fee accrual per launch; fee-claim ops dashboard

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~12 h

**Evidence.** The Solana leg LANDED and the plan line never noticed: commit 814e2f2e (2026-08-19) 'indexer: add the Solana leg, so the fee rail can finally be measured' — 23 files, 3,429 insertions under indexer-solana/ (src/ingest.js, src/classify.js, src/store.js, src/rpc.js, src/pagination.js, src/health.js, 9 test files). Tables: indexer-solana/sql/001_solana_tables.sql:65 solana_dbc_trade, :94 solana_fee_claim, :134 solana_gap, :170 solana_tick. Its tests run in CI: .github/workflows/ci.yml:84-85 'Solana indexer unit tests' (npx vitest run --root ../indexer-solana), accounted for at frontend/src/test/vitestCollection.test.ts:62. The plan text is untouched since creation: `git log -1 -S"Solana leg or cron" -- docs/YEAR_PLAN_2026_2027.md` -> a179c9f6 2026-08-17, even though 012c6f58 'docs: reconcile the plans with the tree' ran on 2026-08-19. NOT done: (a) accrual — indexer-solana/DEPLOY.md §6 records `accrual-not-indexed` as a STANDING gap (accrued-but-unclaimed fees live in pool account state whose layout the repo does not vendor, and the program's licence forbids forking it, per docs/CURVE_FORK_EVALUATION.md); the column is deliberately named claimed_fee_total_observed. (b) dashboard — grep for solana_fee_claim/solana_dbc_trade across the whole repo returns 5 files, ALL inside indexer-solana/. Nothing in frontend/ or frontend/api/ reads them.

**What is left.** Three distinct things. (1) 'partner-fee accrual' as written is NOT achievable — only CLAIMS are indexable; the plan line's wording promises a number the licence and the un-vendored account layout put out of reach. (2) The fee-claim ops dashboard: no read path at all. Ponder's GraphQL cannot serve these tables — they are raw SQL, not declared in indexer/ponder.schema.ts — and indexer-solana/.env.local.example:67-71 states the status listener 'serves no indexed data; rows are read from Postgres by whatever fronts them'. Nothing fronts them. (3) SOLANA_WATCH (pool/baseMint/quoteMint/feeReceiver per launch) is operator config; with feeReceiver unset the leg writes a `fee-receiver-unset` gap row and indexes no claims for that pool.

**Risk.** The named risk is an agent reading 'partner-fee accrual per launch' literally and decoding the Meteora pool account to produce an accrual number — that is both a licence problem and a fabricated figure. Second risk: shipping a fee dashboard that reads solana_fee_claim without solana_gap, which turns every outage into a quiet understatement of fees. Third: adding a 12th Vercel function and failing deploys for an unrelated reason.

**How to do it.**

SPLIT THIS LINE IN THREE BEFORE TOUCHING CODE — it currently reads as one unstarted item and two of its three parts have already been decided.

PART 1 (plan edit, do first): tick the trades half and cite 814e2f2e. Rewrite the accrual half to say what indexer-solana/DEPLOY.md §6 already established: accrual is a standing known-unknown, not a task. Leaving 'partner-fee accrual' on a to-do list invites an agent to fabricate it by decoding a layout this repo cannot legally vendor.

PART 2 (landable dark slice of the dashboard): author the READER and the page, gated exactly like the EVM client. Create frontend/src/lib/solanaFees/ with (a) a config gate mirroring lib/indexer/client.ts:33-64 (`isSolanaFeedConfigured()` reading one VITE_ var, false today), (b) row zod schemas transcribed from indexer-solana/sql/001_solana_tables.sql — column names verbatim, and keep claimed_fee_total_observed's name intact on the way through, (c) a pure reducer turning claim rows into a per-pool ledger, (d) fixture-driven tests with mocked fetch. Then a page shell that renders 'not configured'. THE HONESTY REQUIREMENT, non-negotiable and the reason the leg was built this way: the dashboard MUST read solana_gap alongside the data and render open gap rows inline. A pool with an `undecodable` or `backlog-truncated` gap has a hole in its history, and a fee total shown without that banner is a confident wrong number. Also surface the standing `accrual-not-indexed` row as permanent UI copy: this screen shows fees COLLECTED, never fees EARNED.

PART 3 (operator/blocked): the HTTP read path. It needs a live Postgres, so it cannot be proven here — but the DESIGN decision must be made before writing the reader, because it fixes the URL shape. THE TRAP: frontend/api is at 11 of the Vercel Hobby 12-function cap (`git ls-files frontend/api | grep '\.js$'` minus _lib/ and __tests__/ = 11; frontend/api/SERVERLESS_BUDGET.md documents that exceeding it fails the DEPLOY, not the build). So you get at most ONE new function, or you fold the route into the existing frontend/api/aggregator.js catchall the way `?resource=launch-cohort` does (aggregator.js:266-269, lazy-importing ./_lib/launch-cohort.js). Fold it in. Alternatively add a read route to the Railway service beside the indexer — but indexer/DEPLOY.md §3 makes the reverse proxy mandatory and that is operator work.

VERIFY: from frontend/ — `npx tsc -b --noEmit && npm run lint && npx vitest run`; the Solana leg's own suite with `npx vitest run --root ../indexer-solana --environment node`.

## Line 99 — Fix indexer gaps: factory governance ABI events, env docs, synthetic keys (INDEXER-H1/H2)

**PARTIAL** · buildable: YES · ~3 h

**Evidence.** Two of three sub-items are DONE. INDEXER-H1 fixed: indexer/src/index.ts:265-296 — the comment names the finding and the handlers now `.update()` the existing position and read `user` from `pos.user` instead of inserting user=0x0 (the only remaining zero-address literals are the mint/burn guards at :218-219 and the fail-closed junk-pair cache at :576-577). INDEXER-H2 fixed: every row id is `event.log.id` (30 sites via `grep -n 'id: ' indexer/src/index.ts`; the timelock composite at :76 still embeds event.log.id), and 35 of 36 inserts carry .onConflictDoNothing(). Env docs DONE: indexer/.env.local.example:1-59 documents all 7 vars this repo's code reads — cross-checked against `grep -o 'process\.env\.[A-Z_]*'` over ponder.config.ts + src/, which yields exactly PONDER_RPC_URL_1..4, ALLOWED_ORIGINS, TEGRIDY_STAKING_ADMIN_ADDRESS, SWAP_FEE_ROUTER_ADMIN_ADDRESS, NODE_ENV — plus Ponder's 5 framework vars, split OURS/PONDER'S; indexer/DEPLOY.md §2 repeats them as a deploy checklist. Factory governance PARTIAL: the F1 fix landed in 088ed89e — indexer/ponder.config.ts:277-338 TegridyFactoryGovernanceAbi now carries GuardianSet/GuardianChangeProposed/Executed/Cancelled + PairEmergencyDisabled + the keyed ProposalCreated/Executed/Cancelled triplet; subscribed at ponder.config.ts:632-637; handled at indexer/src/index.ts:759-847.

**What is left.** Only the semantic-payload half of factory governance. contracts/src/TegridyFactory.sol:110-139 emits 12 subject-carrying events that are NOT in the ABI and NOT indexed: FeeToUpdated, TokenBlocked, PairDisableProposed/Executed/Cancelled, FeeToSetterProposed/Accepted/ProposalCancelled, FeeToChangeProposed/Cancelled, TokenBlockProposed/Cancelled. Because `key = keccak256(TYPE_CONSTANT ‖ subject)`, a caller holding a candidate subject can compute the key forward, but pending subjects cannot be ENUMERATED — so 'list every pending pair disable' is unanswerable, which is precisely what a timelock queue UI (line 97) needs.

**Risk.** The real hazard is signature drift: a hand-typed ABI entry whose types do not match the contract makes Ponder request logs for a topic0 that never fires, and the resulting empty table is indistinguishable from 'no governance activity' — the exact failure the sweep_event comment in ponder.schema.ts was written about. Copy from TegridyFactory.sol, and check `indexed` on every parameter. Second: the deploy is still absent, so none of this can be proven against real logs — do not claim it was.

**How to do it.**

Three edits, all in indexer/, all verifiable offline.
1. indexer/ponder.config.ts: extend TegridyFactoryGovernanceAbi (the array ending `] as const` at ~:338) with the 12 events. Transcribe the signatures from contracts/src/TegridyFactory.sol:110-139 — do NOT retype from the comment block at ponder.config.ts:266-272, which lists 8 and misses TokenBlocked/FeeToUpdated/FeeToSetterProposalCancelled. Keep the `as const` and note the existing comment at :331-334: the triplet is repeated inline rather than spread because spreading widens the array and kills Ponder's type inference — the same applies to anything you add.
2. indexer/ponder.schema.ts: add ONE discriminated table (the pol_event / pair_event pattern already in the file), e.g. `factoryGovernanceAction` with id (event.log.id), type text, subject hex nullable, flag boolean nullable, executeAfter bigint nullable, timestamp, txHash, indexed on type and subject. One table, not twelve — the file's own convention.
3. indexer/src/index.ts: register 12 handlers next to the existing TegridyFactory_Governance block at :759-847, each `.insert(...).onConflictDoNothing()` with `id: event.log.id`. Nullable columns must stay null where the event does not carry the field — the sweep_event comment in ponder.schema.ts explains why (null means 'the event does not report this', never zero).
Then delete the 'WHAT IS STILL NOT INDEXED' paragraph at ponder.config.ts:266-275 and the matching bullet in indexer/DEPLOY.md §6, or they become the next stale claim.
VERIFY: `cd indexer && npx tsc -p tsconfig.json --noEmit --skipLibCheck` exits 0 (see line 96 — skipLibCheck is required until tsconfig.json gains it). Landing the line-96 CI job first makes this self-checking.

PLAN LINE: after this, rewrite line 99 to name only what is left — or tick it. As written it lists two items that were fixed before the line was written, which makes the line read as more outstanding work than exists.

## Line 102 — Server-side token scanner + public token pages + shareable scan cards / OG unfurls

**PARTIAL** · buildable: YES · ~9 h

**Evidence.** Server-side read DONE: frontend/api/v1/index.js:343 `case "erc20scan"` → frontend/api/_lib/scannerApi.js:55 readErc20Distribution (Ethplorer, server-side); Solana leg goes through frontend/api/solrpc.js per frontend/src/lib/scanner/solanaAdapter.ts:4. OG unfurls DONE: frontend/middleware.js:28 matcher `["/nakamigos/:path*", "/scan", "/deployer"]`, trustCard() at frontend/middleware.js:140, shipped in d1bc3339. Public token pages NOT done: frontend/src/App.tsx:284-355 has no `/token/:chain/:address` route — only `/scan` (App.tsx:345) and `/launch/:token` (App.tsx:306, launched-here tokens only). Scan cards NOT done: frontend/src/pages/ScannerPage.tsx:179 is a `Copy share link` button only; the only raw-canvas card components are src/nakamigos/components/ShareCard.jsx and src/components/referrals/ReferralShareCard.tsx, neither wired to a scan.

**What is left.** (1) The `/token/:chain/:address` page WORKORDER W1-1 specifies does not exist, so nothing links a token mention to a durable public page. (2) No per-token scan card image — frontend/middleware.js:151 hands every /scan unfurl the static `${origin}/og.png`, so a shared scan looks identical to every other shared scan. (3) The SCORING is still client-side only: `ls packages/` returns "No such file or directory", so BATTLE_PLAN #39's packages/trust-core extraction never happened and the server returns a distribution, never a score (apiTiers.js:52 note: 'Returns the measured distribution, not a risk score.'). (4) The ETH holder read needs a paid ETHPLORER_API_KEY (scannerApi.js:60 falls back to 'freekey', which 403s) — that is operator, not code.

**How to do it.**

Land the token-page slice; leave the card image and the trust-core extraction alone.

STEP 1 — the page. Create frontend/src/pages/TokenPage.tsx and register it in frontend/src/App.tsx next to line 345 as `<Route path="token/:chain/:address" .../>` (lazy, same Suspense/PageSkeleton wrapper as its neighbours). Do NOT write a new scan: import `useTokenScan` from src/hooks/useTokenScan.ts and `ScanReport` from src/components/scanner/ScanReport.tsx exactly as ScannerPage.tsx:5-7 does, and read the address from useParams instead of useSearchParams. Reuse `detectChain` from src/lib/scanner to validate the :chain segment against the address form and render the existing `invalid` state on mismatch — a URL saying `ethereum` with a base58 mint must not silently scan Solana.

STEP 2 — discoverability, which is what actually makes it worth building. Linkify existing token mentions to the new route: src/components/scanner/ScanReport.tsx, src/components/launcher/LaunchExplorer.tsx rows, and src/components/swap/TokenSelectModal.tsx.

STEP 3 — the unfurl. Extend frontend/middleware.js: add "/token/:path*" to the `config.matcher` at line 28, and add a branch in `middleware()` (near line 190, alongside the `/scan` || `/deployer` test) that parses chain+address out of `url.pathname` and calls the existing `tokenIdentity()` + `ogHtml()` helpers. Do not add a verdict to the card — the header comment at middleware.js:16-21 explains why (the real read is computed client-side from partly key-gated data, so a card asserting 'safe'/'concentrated' can contradict the page it links to). Keep `${origin}/og.png` as the image for now.

THE TRAP, twice over. (a) FUNCTION BUDGET: frontend/api/ currently holds ELEVEN top-level handlers (aggregator.js, alchemy.js, analytics.js, auth/me.js, auth/siwe.js, etherscan.js, opensea.js, orderbook.js, solrpc.js, supabase-proxy.js, v1/index.js) against a hard Hobby cap of 12. One slot left. This slice must add ZERO functions — middleware.js is Vercel Edge Middleware and does not consume a slot (that is the stated premise at middleware.js:22-23), and the page reuses `/api/v1?route=erc20scan`. Note that frontend/api/SERVERLESS_BUDGET.md:12 still says '9 functions — 3 of headroom' and lists a catchall path (`api/aggregator/[provider]/[...path].js`) that no longer exists; count the directory yourself, do not trust that section. (b) SPA REWRITE ORDER: frontend/vercel.json's rewrite list ends with `/((?!api/).*) → /index.html`. A new `/token/*` rewrite, if you add one, MUST sit above it or it never matches. You should not need one — the SPA fallback already serves the route.

VERIFY: from frontend/ run `npx tsc -b --noEmit`, `npm run lint`, `npx vitest run`. Add frontend/src/pages/TokenPage.render.test.tsx modelled on the existing ScannerPage.render.test.tsx, and assert the chain/address mismatch case renders the invalid state rather than scanning. Check frontend/e2e/trust-pages.spec.ts — it already asserts OG behaviour and may need the new path added.

## Line 103 — Keyless public scanner API (v1) + docs

**PARTIAL** · buildable: YES · ~3 h

**Evidence.** The keyless route EXISTS and is anonymous: frontend/api/v1/index.js:343 `case "erc20scan"`, admitted for ANY address (index.js:323 exempts it from ALLOWED_CONTRACTS), rate-limited anonymously at 20 rpm/IP + a 600 rpm global breaker (index.js:238-254). It is documented in that file's own header at index.js:12. But it is ABSENT from the published catalog: frontend/api/_lib/apiTiers.js:41 API_ROUTES lists only scan/collections/floor/holders/activity/token/listings, so `GET /api/v1?route=status` never reports it and src/components/developer/EndpointReference.tsx (which renders from API_ROUTES) never shows it. docs/API.md (128 lines) does not mention erc20scan, scan, or /api/v1 at all. docs/API_PUBLIC.md, which WORKORDER_V2.md:135 (W1-3) specifies, does not exist.

**What is left.** The route is real but unpublished. Three gaps: (a) no API_ROUTES entry, so the developer page and the status endpoint both omit the one keyless scanner route; (b) no written reference doc — docs/API.md is not merely silent on it, it is actively stale (it documents /api/quote, /api/price/toweli, /api/offers, /api/push/subscribe and POST /api/auth/nonce|verify|session|logout, none of which exist as handlers in frontend/api/); (c) no embed snippet, no SDK. UNKNOWN whether the omission was deliberate: I found no comment or test asserting that erc20scan must stay out of API_ROUTES — I grepped `erc20scan` across frontend/api and frontend/src/components/developer and the only hits are v1/index.js:12,248,323,332,343.

**Risk.** Adding erc20scan to API_ROUTES publishes a route whose upstream needs a paid ETHPLORER_API_KEY (scannerApi.js:57-60). With the key unset the route answers 403 'Holder data source is not enabled on this deployment'. Publishing it must therefore say that, or the venue advertises a free API that answers 403 for everyone — the exact 'documented URL the deployment cannot keep' failure apiTiers.js:104-108 was written to avoid. Check `/api/v1?route=status` → `platform` (apiPlatformStatus() in _lib/apiAuth.js) and gate the row's rendered state on it, or give the row an honest `note`.

**How to do it.**

Two edits and a doc, all zero-key and zero-deploy.

(1) frontend/api/_lib/apiTiers.js — add an entry to API_ROUTES (starts line 41), ABOVE the collections row so the free scanner reads first:
  { id: 'erc20scan', method: 'GET', path: '/api/v1?route=erc20scan&contract=0x…', summary: 'ERC-20 top-holder distribution, keyless.', keyed: false, note: '<state the ETHPLORER_API_KEY dependency and the top-100 partial-read ceiling>' }
HARD CONSTRAINT stated at apiTiers.js:15-17: this file is bundled into the BROWSER. Do not add an import and do not touch process.env in it.

(2) Check frontend/api/__tests__/apiErrorSemantics.test.js before you touch anything — it pins API_ERROR_SEMANTICS against the codes the server can emit in BOTH directions, so an undocumented refusal fails and a documented-but-dead one fails too. erc20scan emits 403 / 422 / 502 (v1/index.js:365) with plain `{error}` bodies and NO `code` field, unlike the keyed `scan` route. Read that test's assertions before adding a row that implies erc20scan shares the keyed refusal contract — it does not.

(3) Write docs/API_PUBLIC.md: the keyless erc20scan route (params, the exact response shape enumerated at src/lib/scanner/ethereumAdapter.ts:10-13, the three refusal statuses, the top-100 partial-read disclosure), a curl example, and the rate limits actually enforced (20 rpm/IP, 600 rpm global, both env-overridable via V1_GLOBAL_RPM). Link it from docs/API.md.

(4) SEPARATELY, and worth doing in the same PR: docs/API.md documents five endpoints that do not exist. Either rewrite it against the 11 real handlers or mark it superseded — right now it is the first thing an integrator reads and every route in it 404s.

VERIFY: from frontend/ run `npx tsc -b --noEmit && npm run lint && npx vitest run`. The developer-page tests (src/pages/DeveloperPage.test.tsx) render from API_ROUTES, so a new row shows up there; check whether that test snapshots a route count.

## Line 104 — Telegram bot

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~? h

**Evidence.** The bot is CODE-COMPLETE and tested. bot/src/ holds 8 modules + 8 test files, 2,127 lines total; the command router at bot/src/commands.js:78-83 implements /link, /status, /unlink, /heat [address], /history, /scan <token>, plus /alerts (commands.js:131) and /start|/help (commands.js:117). Tests RUN IN CI: .github/workflows/ci.yml:97-98 `npx vitest run --root ../bot --environment node`. The venue side is live too: frontend/api/_lib/botLink.js is dispatched from frontend/api/aggregator.js:365 via `?resource=bot-link` (zero new functions), migration frontend/supabase/migrations/020_telegram_links.sql exists, and frontend/src/components/bot/TelegramLinkPanel.tsx is mounted on /alerts via components/notifications/AlertsPanel.tsx:75. The non-custodial property is guarded by frontend/api/__tests__/bot-noncustodial.test.js, which runs in the FRONTEND suite so an edit to the API or the migration cannot skip it. bot/DEPLOY.md:1-11 states the position plainly: 'complete and deployed nowhere'.

**What is left.** Only operator steps: (1) a Telegram account + BotFather token (TELEGRAM_BOT_TOKEN, bot/.env.example:14); (2) a shared secret generated once and set IDENTICALLY on both sides — BOT_LINK_SECRET in the bot env and on Vercel (bot/.env.example:16-22); (3) a long-running host — bot/DEPLOY.md §1 recommends Railway alongside the indexer; (4) applying migration 020 by hand (this repo has no migration ledger). Nothing in this item is a code gap.

**Risk.** bot/DEPLOY.md:45-47 carries an explicit prohibition worth restating: do NOT 'solve' the hosting problem by adding an api/bot.js webhook function. The bot is a long-poll process, the wrong shape for a serverless function, and there is exactly ONE slot left under the 12-function cap. Any agent that reads 'the bot has no host' and reaches for Vercel spends the last slot on the one workload that cannot use it.

**How to do it.**

Do not rebuild any of this. The correct code action is to REWRITE THE PLAN LINE, because '[code] Telegram bot' misdescribes the state: the code shipped, the deploy did not. Rewrite line 104 in the same shape line 76 already uses for the indexer — e.g. `[op] Deploy the Telegram bot — code complete and CI-tested (bot/, 2,127 lines; venue side on ?resource=bot-link + migration 020 + TelegramLinkPanel on /alerts); the BotFather token, BOT_LINK_SECRET on both sides, a Railway host and applying migration 020 are the remaining halves`. Then move it out of the `[code]` list.

If you want a genuinely landable CODE slice here, it is coverage, not features: bot/src/index.js and bot/src/telegram.js are the two modules with NO co-located .test.js (every other module has one). index.js's `main()` already supports `--preflight` (index.js:50), so its boot-check path is testable without a network. Add bot/src/telegram.test.js covering getUpdates offset advancement and the error/backoff path, and bot/src/index.test.js covering preflight exit codes. Verify with `npx vitest run --root ../bot --environment node` from frontend/.

Before proposing any in-chat execution feature, read bot/SESSION_KEYS.md — there is a design for it and it is gated on an audit wave that has not happened.

## Line 105 — Watch/alerts spine on push infra

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~14 h

**Evidence.** The SPINE landed and is substantial: frontend/src/lib/alerts/ is 8 modules + 8 test files, 3,283 lines (rules.ts, sources.ts, readers.ts, evaluate.ts, inbox.ts, channels.ts, rulesClient.ts), shipped 9bb03d8d ('alerts: a rules engine with four verdicts, because "quiet" and "could not look" are different facts'). Server CRUD is frontend/api/_lib/alerts.js dispatched at frontend/api/aggregator.js:300 (`?resource=alerts`, zero new functions, user's own SIWE JWT forwarded to PostgREST under RLS); store is frontend/supabase/migrations/016_alert_rules.sql; surface is frontend/src/pages/AlertsPage.tsx routed at App.tsx:350. The PUSH half did NOT land, and is refused on the record: frontend/src/lib/alerts/channels.ts:59 `export const BACKGROUND_DELIVERY_AVAILABLE = false`, with the reasoning at channels.ts:1-25 — no VAPID keys, and no sender that runs when the tab is shut. Rules are evaluated in the browser, once a minute, only while /alerts is open (AlertsPage.tsx:70-73 says so to the user). WORKORDER_V2.md:137 (W1-5) specified `.github/workflows/watch-sweep.yml`; ls .github/workflows/ shows 15 files and that is not one of them.

**What is left.** Everything that makes an alert arrive. Specifically: (a) no evaluator that runs with the tab shut — frontend/api/_lib/push.js exists and can send, but nothing calls it for an alert; (b) migration 016 is unapplied (its own header at 016_alert_rules.sql:3-9 says so — until an operator runs it every alerts call answers 503 `schema-missing`); (c) no VAPID key pair, so channels.ts reports web-push as `unconfigured` and pushManager.subscribe cannot even be called; (d) the alert_rules schema deliberately has no last_fired_at/status column (016:18-23) because no real evaluator writes to one.

**Risk.** There is a doctrinal trap here that an agent WILL walk into. frontend/api/SERVERLESS_BUDGET.md says of `alerts`: 'Do not "fix" this by adding a cron that pretends to be the F9 worker.' That prohibition is about a Vercel cron, which only runs when called and cannot watch anything. A GitHub Actions scheduled sweep is a different animal — it genuinely runs on its own schedule, and WORKORDER W1-5 specifies exactly that (Vercel Hobby cron is daily-only, which is why). Do not delete the honest disclosure in channels.ts as part of 'wiring push': BACKGROUND_DELIVERY_AVAILABLE must flip to true only when something real sends, and flipping it early makes every 'delivered' claim on that surface false.

**How to do it.**

Blocked on the operator for delivery, but there is a real landable slice: AUTHOR the sweep, do not run it.

LANDABLE TODAY (no keys): create scripts/watch-sweep.mjs and .github/workflows/watch-sweep.yml. The worker reads alert_rules with a service-role key, re-evaluates each rule using the SAME pure functions the browser uses (import from frontend/src/lib/alerts/evaluate.ts and readers.ts — do NOT write a second evaluator; a fork here means the browser and the sweep disagree about what fired, which is the failure src/lib/alerts/evaluate.ts's four-verdict design exists to prevent), and sends via the existing frontend/api/_lib/push.js `sendPushToWallet`. MISSING-SECRETS FAIL-SAFE IS MANDATORY: with SUPABASE_SERVICE_ROLE_KEY or the VAPID pair unset the job must exit 0 having done nothing and say so in its log — never half-run. Model the workflow on .github/workflows/revenue-watch.yml, which already has this shape in this repo.

Do NOT flip channels.ts:59 in that PR. Flipping it is the LAST step, and it belongs with the operator step that actually provisions VAPID.

OPERATOR STEPS, in order: (1) apply frontend/supabase/migrations/016_alert_rules.sql by hand; (2) `npx web-push generate-vapid-keys` and set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT on Vercel plus VITE_VAPID_PUBLIC_KEY in the client build (the exact instruction is already written at channels.ts:93); (3) add SUPABASE_SERVICE_ROLE_KEY + the VAPID pair as GitHub Actions secrets; (4) only then flip BACKGROUND_DELIVERY_AVAILABLE and update the AlertsPage.tsx:70-73 copy that currently promises the opposite.

FUNCTION BUDGET: this adds zero Vercel functions — the sweep runs on GitHub, and the CRUD already lives on the aggregator catchall. frontend/api/ is at 11 of 12; do not add api/alerts.js.

VERIFY: `npx vitest run` from frontend/ (the alerts suite is 8 test files), and `node scripts/watch-sweep.mjs` with no env set — it must exit 0 and print the missing-secret reason.

## Line 107 — Dune dashboard published; [op] DefiLlama listing

**PARTIAL** · buildable: NO_NEEDS_EXTERNAL · ~2 h

**Evidence.** docs/DUNE_QUERIES.md:8-15 records five queries created and public on dune.com under @cifurious9266 with their query ids; Q4 (8157397) and Q5 (8157796) are marked VALIDATED against known on-chain values. But docs/DUNE_QUERIES.md:16 states plainly: 'No dashboard exists yet.' The 'Still to do' list at DUNE_QUERIES.md:223-228 has three open items: apply the numerator cast to Q1/Q2/Q3/Q5 ON dune.com, build the dashboard, embed it. No embed exists in the app either — grepping `dune.com` across frontend/src and frontend/vercel.json returns zero hits, and there is no /analytics route in frontend/src/App.tsx:284-355.

**What is left.** All three dune.com actions, plus the embed. Note the sequencing trap the doc itself found: Q1/Q2/Q3/Q5 still carry the truncating `/ 1000000000000000000` divisor on dune.com. Q1/Q2/Q3 return no rows today so the output looks identical either way — they would silently publish zeros the moment real data arrives. Q5 has real data and is the acceptance test (all its amounts are sub-1-ETH; DUNE_QUERIES.md:53-63 shows the truncating form returning 0 for every row while Q4 still looks correct).

**Risk.** A future editor 'verifying' a divisor fix against Q4 will get a false pass — 6,400,000 TOWELI is an exact multiple of 1e18, so the truncating integer divisor returns the right answer there by luck. DUNE_QUERIES.md:190-193 carries that warning inline in Q4; keep it.

**How to do it.**

This is a dune.com account action; no agent lands it from the repo. Nothing to build in code first either, because a Dune embed URL is keyed to a VISUALIZATION id that does not exist until the dashboard is assembled — writing an /analytics page now would ship an iframe pointed at nothing.

OPERATOR, in this order (the order matters): (1) In each of Q1/Q2/Q3/Q5 on dune.com, replace the divisor with the exact form at DUNE_QUERIES.md:23-25 — `CAST(bytearray_to_uint256(...) AS decimal(38,0)) / CAST(1000000000000000000 AS decimal(38,18))`. Casting the NUMERATOR is the load-bearing half. (2) Run Q5 and confirm it returns 4 swaps / ~0.005702 WETH with fractional per-day values; if any day shows 0 the cast did not take. Do NOT use Q4 as the check. (3) Create the dashboard 'Tegridy Farms — Real Yield', counter widgets for Q1/Q2/Q3/Q4 cumulatives, line charts for the daily series (DUNE_QUERIES.md:230-234). (4) Paste the five embed URLs back into DUNE_QUERIES.md.

THEN the code slice becomes buildable and is small: add an `/analytics` route in frontend/src/App.tsx, and add `https://dune.com` to `frame-src` in the Content-Security-Policy header in frontend/vercel.json — that CSP is one long single-line string and currently allows frame-src only for geckoterminal and walletconnect, so the iframe silently renders blank without it. Pair the embeds beside the live on-chain ProtocolStats strip rather than replacing it.

Rewrite the plan line meanwhile: '[code] Dune dashboard published' is mislabelled — the five queries are the code half and they are done; what remains is an account action. Retag it `[op]`.

## Line 113 — Incident-response contact tree filled + one drill held

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~3 h

**Evidence.** The runbook itself is thorough and recently corrected — docs/INCIDENT_RESPONSE.md is 303 lines with severity tiers, roles, a pause toolkit, comms templates, a post-mortem template, and a §7 drill schedule (INCIDENT_RESPONSE.md:218-226). It even carries a CORRECTED 2026-08-19 block at :60-66 fixing a fast path that would have reverted in a live incident (guardianPause(), not pause()). But §9 Contact tree (INCIDENT_RESPONSE.md:276-288) is entirely unfilled: all six rows read TBD — Incident Commander, Comms Lead, PauseGuardian address, Tenderly owner, hosting, with 'Signal: TBD' as every channel. And no drill has been held: INCIDENT_RESPONSE.md:226 says to track results in `docs/drills/YYYY-MM-DD.md`, and `ls docs/drills/` returns 'No such file or directory'.

**What is left.** Real human names, backups, Signal handles, the Tenderly and hosting account owners — none of which exist in the repo — and an actually-held tabletop with a scribe's timings. The one row that is NOT operator-only is the PauseGuardian address: it is an on-chain Safe (docs/GOLIVE_HANDOFF.md:74,86-90 describe `proposeGuardianChange(<pauseGuardian Safe>)` and the 48h GUARDIAN_CHANGE_DELAY), so that cell is fillable from repo facts.

**Risk.** A contact tree with names but no verified channels is worse than TBD, because it reads as rehearsed. The drill's stated purpose (INCIDENT_RESPONSE.md:223) is precisely to validate that 'signers' keys still work, Telegram channels reach humans, Tenderly alerts route correctly' — so filling the table without the drill leaves the claim untested and looks tested.

**How to do it.**

The item is operator-gated, but there is a real landable slice that makes the operator's half a 30-minute job instead of an open-ended one.

LANDABLE TODAY (no keys, no external accounts):
(1) Create docs/drills/TEMPLATE.md — a fill-in-the-blanks tabletop record: scenario, start time, each §5 'first 15 minutes' step with an SLA column and an actual-elapsed column, and an action-item table. INCIDENT_RESPONSE.md:226 already defines the rule ('anything that took >2× the SLA is an action item'); the template just makes it mechanical.
(2) Create docs/drills/SCENARIOS.md with two scripted SEV-0/SEV-1 tabletops built from the sharp edges already documented at INCIDENT_RESPONSE.md:290-300 — e.g. a drainer tx against TegridyLending (tests guardianPause() selector 0xd4593872 and the unpause asymmetry), and a poisoned TWAP (tests that the responder reaches for emergencyDisablePair 0xe24d0ff7 knowing undoing it is a 48h timelock). Each scenario states the correct answer at the bottom so it can be self-scored.
(3) Fill the ONE row you can prove: resolve the PauseGuardian Safe address from docs/GOLIVE_HANDOFF.md / docs/GOVERNANCE.md and put the real address in §9. Cite the source in the cell. Leave every human row TBD — do not invent a placeholder name; this repo already has a recorded incident (see .github/workflows notes and docs/CONSOLIDATION_2026_08_21.md) of an address being INVENTED to fit a truncated pattern.

OPERATOR: fill the five human rows, then run one scenario from docs/drills/SCENARIOS.md and commit the completed template as docs/drills/<date>.md.

VERIFY: no test covers docs/. Check whether frontend/src/lib/docsClaimHonesty.test.ts or docsAddressTruth.test.ts parses INCIDENT_RESPONSE.md before editing addresses in it — docsAddressTruth.test.ts decodes protocol addresses out of markdown and will fail on a malformed one, which is the behaviour you want.

## Line 119 — ✅ DONE 2026-08-26 — Extend the ghost-code guard to components

**SHIPPED** · `frontend/src/components/componentsAreMounted.test.ts`

**What landed.** A path-resolved reachability graph, not a port of the hooks regex — the audit's
trap was real and the naive form is worthless. Roots are `src/App.tsx`, `src/main.tsx` and every
file under `src/pages/`; edges are STATIC (`from '…'`), DYNAMIC (`import('…')`) and `require('…')`
specifiers resolved to real files on disk (extension and `/index` variants, `@/` and `src/` aliases).
Test files are excluded from the graph entirely, which is what makes a test-only importer count as
unmounted. Transitive reachability falls out of the walk, so the second tier the audit asked for
needed no special case.

**Result on trunk: exactly one unexempted ghost**, matching the audit's hand-verification.
`launcher/FactSheetPricing.tsx` is exempted with its real boundary — there is no per-launch fact
sheet DETAIL surface to mount it on (the disclosure IS produced by `lib/launcher/collector.ts` and
attested at `lib/launcher/attestation.ts:208`, but the only launcher surface that ships is
`LaunchExplorer`, which renders a list and never a single sheet). Mounting it is a feature, not a
wire-up — **that feature is still owed.** `positionMarket/` is exempted on the deploy gate already
documented at `lib/constants.ts`. Both exemptions self-invalidate: a test fails the moment anything
reaches them, and another fails if an exemption stops matching any file.

**Proven non-vacuous**, because this repo has shipped three gates that could not fail: removing the
`TriggerOrderTab` import and render from `TradePage.tsx` turns the guard red naming
`swap/TriggerOrderTab.tsx`; restored, it is green. Two sentinels also assert the component list and
the root list are non-empty, since either being empty would make every check pass over nothing.

**The limit, stated in the file:** it measures IMPORT reachability, so a component imported and
never rendered still reads as mounted. `@typescript-eslint/no-unused-vars` is an ERROR in this
repo's eslint config and covers that half. Neither gate closes it alone.

The original analysis, kept because its trap is the reusable part:

**~~PARTIAL~~** · buildable: YES · ~3 h

**Evidence.** The guard is still hooks-only: frontend/src/hooks/hooksAreMounted.test.ts:50-52 enumerates only `readdirSync(HOOKS).filter(f => /^use[A-Z].*\.tsx?$/...)`. No component-reachability guard exists — `git ls-files frontend/src/test/` returns a11yRouteCoverage, ciFuzzInvariantGate, ciGateIntegrity, contractsCoverageFloor, diffScope, npmAdvisoryGate, playwrightDeviceMatrix, requiredCheckSynthesis, setup, typecheckCommand, vitestCollection — none of them. The line's example is OBSOLETE: TriggerOrderTab.tsx is mounted at frontend/src/pages/TradePage.tsx:18 (import) and :706 (render), landed in `7ba46691` "mount: route the three surfaces that were finished but unreachable". I scanned all 169 non-test components and verified each candidate by hand; exactly TWO real ghosts survive: frontend/src/components/positionMarket/PositionMarketPanel.tsx (195 lines, referenced by NOTHING in frontend/src — not even a test; only a comment at frontend/src/lib/constants.ts:163 mentions the directory) and frontend/src/components/launcher/FactSheetPricing.tsx (89 lines, default export, imported only by its own FactSheetPricing.test.tsx:11).

**What is left.** The guard itself — nothing enforces component reachability. Plus the two ghosts above need a decision (mount, delete, or exempt with a written boundary).

**Risk.** THE TRAP, and I walked into it: a naive port of the hooks regex is worthless for components. hooksAreMounted.test.ts's `importersOf` matches `from '…/<Name>'`, which works only because every hook file is named after its single export. Components are not: frontend/src/pages/LendingPage.tsx:12-13 mounts LendingSection via `lazy(() => import('../components/nftfinance/LendingSection').then(mod => ({default: mod.LendingSection})))`, and frontend/src/App.tsx:104,109,125 mounts OnboardingFlow / ZapPage / ChartPage the same way. My first pass reported all 169 components as orphans; my second reported 16; hand-verification left 2. A guard that ships with false positives gets an ever-growing exemption list and then guards nothing — which is exactly how the companion-workflow shim survived.

**How to do it.**

REWRITE the plan line first — its example is dead. New text: "[ ] `[code]` Extend the ghost-code guard to components — it guards hooks only. Two components are unreachable on trunk today: `positionMarket/PositionMarketPanel.tsx` (zero references anywhere) and `launcher/FactSheetPricing.tsx` (imported only by its own test)."

BUILD IT: add frontend/src/components/componentsAreMounted.test.ts, modelled on frontend/src/hooks/hooksAreMounted.test.ts (reuse its `walk`, its UNMOUNTED_BY_DESIGN shape, and its "found the directory — a zero-length list would pass vacuously" sentinel at :66-68; that sentinel is what stops the guard passing over an empty set).

The reachability check must differ from the hooks one in three ways:
1. Match BOTH static and dynamic specifiers: `from '<path>'` AND `import('<path>')`. Missing the second is the whole bug.
2. Resolve by module PATH, not by exported symbol. Compute each component file's path relative to src, then test whether any other non-test module's specifier resolves to it. Symbol-name matching breaks on named-export destructuring off a lazy import and on barrel re-exports.
3. A test-only importer counts as UNMOUNTED. FactSheetPricing is the proof — fully written, fully tested, on screen nowhere. This is the `useAutoRefreshBoost` shape one level up.
Then add a second tier, as hooksAreMounted.test.ts:113-118 already does for useOneClickLaunchBuy: a component reached only by another unmounted component is still dark. Walk transitively up to a file under src/pages/ or src/App.tsx.

PROVE IT CANNOT PASS VACUOUSLY (this repo has shipped three gates that could not fail): before committing, temporarily delete the `<TriggerOrderTab />` render at TradePage.tsx:706 and confirm the new test goes red; restore it. Also confirm it does NOT flag LendingSection/AMMSection/ZapPage/ChartPage/OnboardingFlow — those are all lazily mounted and are the false-positive set.

DECIDE THE TWO GHOSTS in the same PR — mount, delete, or add to UNMOUNTED_BY_DESIGN with the real boundary. PositionMarketPanel has a plausible boundary already written at frontend/src/lib/constants.ts:163 ("components/positionMarket gates on isDeployed()"); FactSheetPricing has no stated boundary and is the likelier delete-or-mount.

VERIFY: `cd frontend && npx vitest run src/components/componentsAreMounted.test.ts && npx vitest run && npx tsc -b --noEmit && npm run lint`.

## Line 122 — LaunchGate/HeatCard/launch-flow e2e

**PARTIAL** · buildable: YES · ~6 h

**Evidence.** The LaunchGate/HeatCard half LANDED: frontend/e2e/heat-gate.spec.ts (commit `57b188f7`), 5 tests — WARM opens the lane (:110), COLD shows own degrees and offers no lane (:126), STALE renders retry and never a verdict (:152), the audit panel surfaces a prior denial (:183), and logs the live denial into the record it reads back (:213). But it is RED on trunk and is the ONLY red thing in the browser matrix. Run 32598383834 (head `2b8ccde8`), job `E2E Tests`: 8 failed / 516 passed, and all 8 are heat-gate.spec.ts — `[mobile-chrome]` :183 and :213; `[iphone-safari]` :110, :126, :213; `[ipad-safari]` :110, :126, :213. Desktop `[chromium]` passes heat-gate outright. The launch-flow half does not exist: `git ls-files frontend/e2e/` lists a11y-routes, a11y-smoke, claim-rewards, gauge-voting, heat-gate, lending, liquidity, risks-page, smoke, stake, swap, trade-page, trust-pages, wallet-connect — no launch spec.

**What is left.** (a) Green the 8 heat-gate failures, which are viewport/engine-specific, not a launch-flow gap. (b) The launch-flow specs — no browser test drives an actual launch past the door.

**Risk.** docs/TODO_OPERATOR.md:529 titles this work "1b. The chromium heat-door failures" and its guidance sends you to grep for `195.54` and `41.20` and suspect a stale route fixture. That framing is WRONG in a way that will waste a session: desktop chromium passes every heat-gate test. The failures are confined to mobile-chrome, iphone-safari and ipad-safari, and the split is informative — mobile-chrome fails only the two audit-panel tests (:183, :213) while the two WebKit projects fail the two verdict tests (:110, :126) plus :213. That is two different causes: a responsive-layout / scoped-locator problem on the door text under WebKit, and a storage problem on :213 (which reads back `localStorage['tegridy.heat.gate.audit.v1']`) shared by all three. Second trap: the spec header at :11-16 warns that `vite preview` serves a static build with no `/api`, so an unrouted heat request 404s into STALE and silently turns every assertion into an assertion about an outage — check the route stub is actually intercepting on each project before concluding anything about layout.

**How to do it.**

FIRST, correct the diagnosis in docs/TODO_OPERATOR.md:529-541 — retitle it from "chromium heat-door failures" to the real matrix, and record that desktop chromium is green. Re-derive it yourself: `gh run view 32598383834 --log-failed | grep -E '\[[a-z-]+\] › e2e/'`.

THEN fix, in this order, cheapest first:
1. Reproduce locally per project rather than in bulk: `cd frontend && npx playwright test e2e/heat-gate.spec.ts --project=iphone-safari` (then mobile-chrome, ipad-safari). Do not run the whole suite while iterating.
2. The `:213` failure is common to all three and fails at :217 — that test reads back `localStorage` key `tegridy.heat.gate.audit.v1` (spec :14, :225). Check the storage write survives on WebKit and under the mobile context before touching any layout.
3. The WebKit `:110`/`:126` failures are `expect(door.getByText('WARM'|'COLD', {exact:true})).toBeVisible()` at :114/:130 — a scoped locator against a `door` container. On narrow viewports the verdict chip may be rendered but clipped, or the door container may resolve differently. Read frontend/src/components/LaunchGate.tsx and HeatCard.tsx for responsive branches before editing the spec.
4. The mobile-chrome `:183` failure is at :199, `expect(toggle).toHaveAttribute('aria-expanded','false')` — the GateAuditPanel disclosure toggle. Note frontend/src/components/heat/GateAuditPanel.mounted.test.tsx already asserts exactly this in jsdom and passes, so the component logic is fine and the difference is rendering/timing under the mobile context.

⛔ DO NOT green these by loosening assertions, widening timeouts, adding retries, or excluding the mobile/tablet projects from the matrix. The device projects were added deliberately in `abdbf38a` and frontend/src/test/playwrightDeviceMatrix.test.ts guards them. A door that renders its verdict on desktop and not on a phone is a real defect in a launch surface most users will meet on a phone.

THE LAUNCH-FLOW HALF (separate PR): add frontend/e2e/launch-flow.spec.ts driving /launch past a WARM door through the form to the point of submission, using the same network-stubbing discipline the heat-gate spec establishes at :11-16 (stub `/api/aggregator?resource=heat`; never contact the island) and the wallet fixture at e2e/fixtures/wallet.ts. Assert the honesty properties, not the happy path: that the fact sheet's fee constitution matches `DEFAULT_FEE_CONSTITUTION`, and that a COLD wallet is never offered a signature. Add the route to e2e/fixtures/routes.ts if it is not already covered.

VERIFY: `cd frontend && npx playwright test e2e/heat-gate.spec.ts` green on all projects, then the full gates `npx tsc -b --noEmit && npm run lint && npx vitest run`.

## Line 133 — Fiat on-ramp widget (Coinbase Onramp / MoonPay aggregate)

**PARTIAL** · buildable: YES · ~4 h

**Evidence.** Built and mounted, shipped 93823dae. frontend/src/components/onboarding/FiatOnrampPanel.tsx (192 lines) + frontend/src/lib/onramp/{config,widgetUrl,partnerFee}.ts + frontend/src/hooks/useOnrampSession.ts, all with co-located tests; rendered on /start via components/onboarding/OnboardingFlow.tsx:65. Four states, three of them refusals, with an explicit not-configured branch naming the missing env keys (FiatOnrampPanel.tsx:1-10,73-80). Providers are Transak and MoonPay (lib/onramp/config.ts:37,57-69) — NOT Coinbase Onramp as the plan line names. THE GAP: MoonPay requires a server-signed widget URL (config.ts:68 requires VITE_ONRAMP_MOONPAY_SIGN_URL) and that endpoint DOES NOT EXIST. `?resource=ramp-sign` appears only in four TEST files (FiatOnrampPanel.test.tsx:26, useOnrampSession.test.ts:18, lib/onramp/config.test.ts:23,122, widgetUrl.test.ts:29); frontend/api/aggregator.js's resource dispatch (lines 249-365) has eleven branches — launcher-outcomes, launch-radar, launch-cohort, heat, births, alerts, record, airdrop, referrals, commerce, bot-link — and no ramp-sign.

**What is left.** (1) The MoonPay signing resource is unimplemented, so MoonPay can never be configured on this deployment regardless of what the operator sets. (2) Transak is link-only and needs no signature, so the Transak leg is complete in code and gated purely on VITE_ONRAMP_TRANSAK_KEY + VITE_ONRAMP_TRANSAK_ENV. (3) Coinbase Onramp is not implemented at all — decide whether the plan line means it or should be rewritten to Transak/MoonPay. (4) Partner keys require KYB with the ramp — operator, and BATTLE_PLAN.md:185 already flags ramp-partner KYB as a day-one long pole.

**Risk.** The signing endpoint handles a MoonPay SECRET key. Write it as a server-side resource only; a signature the browser can produce is one anybody can produce (the same argument frontend/api/SERVERLESS_BUDGET.md makes for `births`). Also: useOnrampSession.ts fails CLOSED — every failure resolves to `unavailable`, never a URL, and widgetUrl.ts's `isPermittedOnrampUrl` verifies the returned URL is on the provider's own origin. Do not relax either while wiring the signer; a signer that returns an attacker-chosen URL is a payment-page redirect.

**How to do it.**

Land the missing signer. It is self-contained and costs zero function slots.

Create frontend/api/_lib/rampSign.js exporting `handleRampSign(req, res)`. Model it on frontend/api/_lib/births.js, which is the closest existing shape (holds a shared secret, signs, refuses when the secret is unset). It must: read MOONPAY_SECRET_KEY from process.env and answer 503 with an explicit 'not configured' code when unset (never a 200, never an unsigned URL); accept the widget URL query the client built; verify the URL's origin is exactly `https://buy.moonpay.com` server-side too (do not trust the client's own check in widgetUrl.ts); compute MoonPay's HMAC-SHA256 signature over the query string and return `{ url }`; be rate-limited via frontend/api/_lib/ratelimit.js and origin-gated like the other first-party resources.

Then add the dispatch branch in frontend/api/aggregator.js. TWO NON-NEGOTIABLES, both stated at aggregator.js:243-248 and SERVERLESS_BUDGET.md: use a LAZY dynamic import (`const { handleRampSign } = await import("./_lib/rampSign.js")`) so the swap hot path never loads it, and place the branch ABOVE the `const provider` line — a `?resource=` call carries no provider, so a branch below it never runs and falls into the 404. Put it next to the other resource branches around line 300.

DO NOT create frontend/api/ramp-sign.js. frontend/api/ holds ELEVEN top-level handlers today against a hard Hobby cap of 12; that last slot is not this. (SERVERLESS_BUDGET.md:12 still claims 9 — it is stale; count the directory.)

The tests already exist and already name the path `/api/aggregator?resource=ramp-sign` — so make the implementation match the tests, not the other way round. Add frontend/api/__tests__/ramp-sign.test.js pinning: 503 when the secret is unset, refusal of any origin other than buy.moonpay.com, and that no response body ever carries the secret.

VERIFY: from frontend/ run `npx tsc -b --noEmit && npm run lint && npx vitest run`.

SEPARATELY: rewrite the plan line. It says 'Coinbase Onramp / MoonPay aggregate' and what shipped is Transak + MoonPay.

## Line 134 — Guided first-run onboarding flow

**PARTIAL** · buildable: YES · ~2 h

**Evidence.** The flow is BUILT and routed: frontend/src/components/onboarding/OnboardingFlow.tsx (117 lines) + onboardingSteps.ts (179 lines) + two test files, shipped 93823dae, registered at frontend/src/App.tsx:310 as `<Route path="start" …>`. The design is good — onboardingSteps.ts:1-16 derives every destination from the same liveness gates the destination pages read, so a re-gated surface disappears from the tour instead of being promised, and onboardingSteps.test.ts pins that the prose never names a dark surface either. BUT THE ROUTE IS ORPHANED. Grepping `'/start'` / `to="/start"` / 'Start here' across frontend/src returns hits ONLY inside OnboardingFlow.tsx itself (lines 25 and 47). frontend/src/components/ui/OnboardingModal.tsx — the first-visit modal, mounted at components/layout/AppLayout.tsx:183 — links to /farm and /swap (OnboardingModal.tsx:155,159) and NOT to /start, even though OnboardingFlow.tsx:5-7 describes itself as 'the destination that hello can point at'. /start is absent from frontend/src/lib/navConfig.ts and absent from frontend/public/sitemap.xml (32 <loc> entries, no /start).

**What is left.** Discoverability, which for an onboarding flow is most of the feature. A first-run flow no first-run user can reach is reachable only by someone who already knows the URL. Three one-line gaps: no link from OnboardingModal, no navConfig entry, no sitemap entry.

**Risk.** This is exactly the defect class plan line 119 describes — the ghost-code guard covers HOOKS only, so an unreachable PAGE passes CI. frontend/src/lib/__tests__/hooksAreMounted.test.ts will not catch this. Whatever you do here, do not also 'fix' it by making /start a blocking gate: OnboardingFlow.tsx:3-6 explains that the modal is deliberately non-blocking because a four-step gate in front of the value prop leaks the funnel.

**How to do it.**

Three edits, each small, plus one guard so it cannot regress.

(1) frontend/src/components/ui/OnboardingModal.tsx — add a third destination beside the existing /farm and /swap links at lines 155-162: `<Link to="/start" onClick={close}>New here? Start here</Link>`. This is the link OnboardingFlow.tsx:5-7 says it was built to receive. Keep the modal dismissible and non-blocking.

(2) frontend/src/lib/navConfig.ts — add `{ to: '/start', label: 'Start here' }`. Read the file's own rules first: it has a documented rule that a hub gets exactly ONE nav entry, and several entries carry `soon: true` or a justifying comment (see the /alerts entry at navConfig.ts:312 and the /scan entry at :270 for the house style). /start is unconditionally live (onboardingSteps.ts filters its own contents), so it needs no flag. Check navConfig.test.ts — it asserts a canonical 'every reachable top-level route' list (navConfig.ts:325 mentions it), which may be exactly the test that should have caught this.

(3) frontend/public/sitemap.xml — add `<loc>https://memetic.fun/start</loc>`. While you are there, note that /alerts, /referrals, /checkout, /tax, /terminal, /chart, /copy-trading, /competitions, /zap, /yield, /airdrop and /vesting are also missing from the 32 entries; fixing the whole set is a separate, larger call — do not silently expand scope, but say so in the PR.

(4) THE GUARD, which is the durable part: add a test asserting that every non-redirect `<Route path>` in App.tsx is reachable from at least one of navConfig.ts, OnboardingModal.tsx or an in-page Link — the component-level analogue of hooksAreMounted.test.ts. That is plan line 119's item ('extend the ghost-code guard to components') and this orphan is the concrete case that justifies it. If you build the guard, note the legitimate exemptions it will hit (e.g. /admin) and give each a written reason, the way hooksAreMounted.test.ts does.

VERIFY: from frontend/ run `npx tsc -b --noEmit && npm run lint && npx vitest run`. There is also a Playwright a11y sweep across every route (commit 1d67f8e1) — a newly-linked route may need adding there.

## Line 135 — EIP-5792 batched transactions (approve+swap one confirmation — highest-leverage zero-surface UX win)

**PARTIAL** · buildable: YES · ~7 h

**Evidence.** LANDED — the rail and three mounted consumers. Rail: frontend/src/lib/eip5792.ts (`isAtomicBatchSupported` :53, `getWalletCapabilities` :73, `callsId` :83, `sendCalls` :90) plus the read-back parser frontend/src/lib/zap/batchStatus.ts:36 `parseCallsStatus`. Consumers: approve+stake (src/lib/stakeBatch.ts:15 `buildApproveStakeCalls` → src/hooks/useOneClickStake.ts → mounted at src/pages/FarmPage.tsx:106); approve+buy on the launcher (launchBuy.ts:272 → useOneClickLaunchBuy.ts:66 → LaunchBuyPanel → LaunchPage.tsx:783); and the zap, which DOES batch approve+swap — src/lib/zap/calls.ts:142-210 encodes the swap leg as a `WalletCall` against SwapFeeRouter/UniswapV2Router and src/hooks/useZapRun.ts:31 sends the batch. A fourth, independent implementation lives in src/nakamigos/lib/trades.js:120 `tryAtomicBatch` (approve+fill). NOT LANDED — the headline case, approve+swap on the MAIN swap surface. src/pages/TradePage.tsx:143 calls `useSwap()`; src/hooks/useSwap.ts uses wagmi `useWriteContract` at :202 and `executeSwap` at :404 hard-refuses while an approval is outstanding (`if (allowance.needsApproval) { toast.error('Please approve the token first'); return; }`). `grep -n "sendCalls|5792|writeContracts|getCapabilities" src/hooks/useSwap.ts src/hooks/useSwapAllowance.ts` returns nothing. So it is two confirmations on the surface where most volume happens.

**What is left.** A batch composer + hook + affordance for the primary swap path: (1) `frontend/src/lib/swapBatch.ts` — pure `buildApproveSwapCalls()`, the direct analogue of stakeBatch.ts; (2) `frontend/src/hooks/useOneClickSwap.ts` — the capability-detection wrapper, the direct analogue of useOneClickStake.ts; (3) a `canBatch`-gated button in TradePage.tsx; (4) batch-status polling reusing `parseCallsStatus`, because the existing receipt pipeline cannot consume a batch id.

**Risk.** Four ways to get this subtly wrong, in descending damage. (a) THE BIG ONE: useSwap's entire success path hangs off `useWaitForTransactionReceipt` over the hash from `useWriteContract` (useSwap.ts:202, dedupe guard `lastHandledHashRef` :212, receipt effect ~:256-350 which fires the toast, `trackSwap` analytics and the auto-reset). `wallet_sendCalls` returns a BATCH ID, not a tx hash. Feeding the id into that path yields a receipt query that never resolves — the UI hangs on 'pending' forever after a swap that actually succeeded. (b) The approval spender MUST come from `swapSpenderFor(selectedRoute, onChainSource)` (src/lib/swapRouting.ts:20). Approving SwapFeeRouter while executing on UniswapV2Router (or vice-versa) is the exact F186 regression that file was written to prevent — every ERC20-input swap reverts at gas estimation. (c) The floor: on the aggregator route, useSwap.ts:441-449 deliberately RECOMPUTES the minimum from the on-chain fallback venue's own output, because holding that leg to the aggregator-priced minimum made the revert guaranteed-by-construction. A batch built off `quote.minimumReceived` on an aggregator route reintroduces R033 H-01. (d) Native-in swaps need no approve at all — the batch degenerates to one call and the one-click affordance is pure noise; and the CoW route (src/components/swap/CowSwapPanel.tsx) is an off-chain signed order where batching does not apply. Gate the affordance off both.

**How to do it.**

Land it in the shape the repo already established twice, and steal from the zap rather than inventing. STEP 1 — read these three first, in order: src/lib/stakeBatch.ts (34 lines; the composer shape), src/hooks/useOneClickStake.ts (the capability-detection shape), src/lib/zap/calls.ts:142-210 (the swap leg already encoded as a WalletCall against both venues, including the fee-on-transfer and native-in branches). STEP 2 — write `frontend/src/lib/swapBatch.ts`, pure, no React: `export function buildApproveSwapCalls(p: { token: Address; spender: Address; amountIn: bigint; currentAllowance: bigint; swapCall: WalletCall }): WalletCall[]`. Rules: emit no approve when `currentAllowance >= amountIn`; emit `approve(0)` then `approve(amountIn)` (two calls) when `currentAllowance > 0n` — that is the USDT/force-approve case that src/hooks/useSwapAllowance.ts:47-53 handles with a multi-step state machine, and in a batch it collapses to two calls, so do NOT port the state machine; throw (never silently proceed) when `swapCall.to !== spender` on the ERC20 path, mirroring launchBuy.ts:275. STEP 3 — write `frontend/src/hooks/useOneClickSwap.ts` by copying useOneClickStake.ts almost verbatim: same `CHAIN_HEX = '0x1'`, same `chainId !== CHAIN_ID` guard (CHAIN_ID is 1, src/lib/constants.ts:175), `atomicRequired: true`. STEP 4 — refactor useSwap.ts so the calldata is built ONCE and reused: today `executeSwap` (useSwap.ts:400-548) calls `writeContract` inline in nine branches. Extract a pure `buildSwapCall(...): WalletCall` that returns `{to, data, value}` for each branch using `encodeFunctionData`, have `executeSwap` keep calling `writeContract` from it, and hand the SAME object to the batch path. Do not fork the branch logic — a second copy of nine venue branches is how the floor and the executor drift apart. STEP 5 — the receipt problem. Add a batch-status path instead of reusing the hash path: on `wallet_sendCalls` success, poll `wallet_getCallsStatus` exactly the way src/hooks/useZapRun.ts:304 does, feed the answer to `parseCallsStatus(raw, callCount)` from src/lib/zap/batchStatus.ts, and only fire the existing swap toast + `trackSwap` when it returns `{kind:'settled'}` with the swap leg confirmed. `parseCallsStatus` already refuses to align a receipt list it cannot map one-for-all or one-per-call — respect its `unreadable` verdict and say so rather than guessing. STEP 6 — TradePage.tsx: render the one-click button ONLY when `canBatch && allowance.needsApproval && !fromToken.isNative && selectedRoute !== 'cow'`; otherwise the existing two-step flow stays exactly as it is. Never remove the sequential path — unlike the launch-buy, there IS a proven fallback here and it must remain the default. TRAP TO AVOID BEYOND THE RISK FIELD: adding `useOneClickSwap.ts` without mounting it fails src/hooks/hooksAreMounted.test.ts (every hook must be imported by a non-test module or listed in UNMOUNTED_BY_DESIGN at :32) — so the hook and the TradePage wiring must land in the same commit. VERIFY: `cd frontend && npx vitest run src/lib/swapBatch.test.ts src/hooks/useSwap.test.ts src/hooks/hooksAreMounted.test.ts src/lib/swapRouting.test.ts src/hooks/receiptStatus.test.ts && npx tsc -b --noEmit && npm run lint`. Include a swapBatch test asserting the zero-then-target approve pair on a nonzero existing allowance, and one asserting the spender equals `swapSpenderFor(...)` for all four (route, onChainSource) combinations.

## Line 137 — Unified portfolio dashboard (EVM + staking NFTs + Nakamigos + launcher positions)

**PARTIAL** · buildable: NO_NEEDS_EXTERNAL · ~5 h

**Evidence.** TWO OF FOUR LEGS LANDED, and the frame is live. Shipped 2026-08-19 in commit 93823dae ("portfolio + onboarding: a total that says when it is partial…"): src/lib/portfolio/{types,sources,aggregate}.ts, src/hooks/usePortfolioSources.ts, src/hooks/usePortfolio.ts, src/components/portfolio/UnifiedPortfolio.tsx — mounted at src/pages/DashboardPage.tsx:120 (`usePortfolio()`) and :298 (`<UnifiedPortfolio sources total summary/>`). EVM ✅: native ETH plus TOWELI, LP underlying derived from reserves, and claimable revenue + referral — usePortfolioSources.ts:100-116 (batch A, 12 reads folded into one Multicall3 eth_call). STAKING NFTs ✅: usePortfolioSources.ts:136-142 (batch B — `getPosition`/`earned` on STAKING_MONITOR_VIEW keyed by the tokenId read in batch A), with the inter-batch age spread deliberately reported rather than hidden (header comment :24-29). NAKAMIGOS ❌: the `nft` leg at src/lib/portfolio/sources.ts:238-252 is labelled 'JBAC NFTs' and reads ONLY `JBAC_NFT_ADDRESS` (src/lib/constants.ts:171); `grep -n "nakamigos|Nakamigos" src/lib/portfolio/*.ts` returns nothing, and there is no `nakamigos` member in the `PortfolioSourceId` union at src/lib/portfolio/types.ts:16-23. LAUNCHER POSITIONS ❌ but HONESTLY DECLARED: src/lib/portfolio/sources.ts:259-267 emits `{id:'launched-tokens', state:'out-of-scope', usd:null}` with the reason "this build has no per-wallet token index, so tokens launched through the rail… are outside this total", and types.ts:38-40 defines `out-of-scope` as "nothing in this build reads this leg at all. Permanent until something is built." Tests green: `npx vitest run src/lib/portfolio` passes (part of the 182 above).

**What is left.** Two legs. LAUNCHER POSITIONS — blocked, and the blocker is real: valuing a wallet's holdings of rail-launched tokens needs a per-wallet token index that does not exist. The only in-repo enumerator is src/lib/launcher/ourLaunches.ts:196 `readOurLaunches`, and it is an `eth_getLogs` walk from `AIRLOCK_FIRST_BLOCK` (:212) that is integrator-wide, not per-wallet — ourLaunches.ts:120-127 says explicitly `creator: null` because "the Airlock record exposes timelock/governance, neither of which is the creator EOA". Running that walk on every dashboard load against a public RPC is not shippable (the file's own comment at :159 notes RPCs cap getLogs ranges). This is BATTLE_PLAN #42 / the F1 indexer, which needs a hosted GraphQL endpoint (`VITE_INDEXER_URL`, still unset — it is the standing exemption at src/hooks/hooksAreMounted.test.ts:33-38). NAKAMIGOS — genuinely landable today, as a COUNT leg only: src/nakamigos/api.js:669 `fetchWalletNfts(walletAddress, contract, …)` already walks Alchemy's `getNFTsForOwner` through the existing server proxy (frontend/api/alchemy.js), paginated with a disclosed 25-page cap, and the /nakamigos route already ships in-app (App.tsx:284), so the proxy path is the one already in production.

**Risk.** THE ONE THAT MATTERS: do not let a Nakamigos leg contribute a dollar figure. src/lib/portfolio/sources.ts:234-237 states the standing rule for this venue — NFTs are "Counted, never marked… anything held is `unpriced` forever, which is the correct permanent state until a floor feed exists" — and types.ts:33-37 defines `unpriced` as "the QUANTITY is known and the MARK is not". src/nakamigos/api.js:193 `fetchCollectionStats` returns an OpenSea floor and it is RIGHT THERE; using it to mark the leg would put a fabricated number into the one figure on the venue that users act on without re-deriving (types.ts:1-13 is the essay explaining exactly that). SECOND: the aggregator distinguishes `unavailable` (read attempted, failed — transient) from `ok` with a zero. A failed Alchemy page must become `unavailable`, never 0. THIRD: `fetchWalletNfts` returns `complete: false` when the page cap is hit or a page fails — a partial walk is a partial count and must degrade to `unavailable`, not report the partial number as a count. FOURTH, structural: usePortfolioSources.ts's whole read-cost argument (header :10-22, "2-3 JSON-RPC requests per minute, flat") is a Multicall3 claim; an Alchemy REST walk is a different budget on a different host. Poll it on its own slower interval, not on the 60s POLL_MS, and never block batch A's render on it.

**How to do it.**

First, REWRITE the plan line rather than leaving it flat — it is two-thirds done and reads as untouched. docs/YEAR_PLAN_2026_2027.md line 137 → "- [ ] `[code]` Unified portfolio dashboard — EVM + staking NFTs ✅ shipped 2026-08-19 `93823dae` (`src/lib/portfolio/`, live on `DashboardPage`, with a total that withholds itself rather than shrinking when a leg is unread). Remaining: Nakamigos (landable now, count-only) and launcher positions (blocked on the F1 per-wallet token index — BATTLE_PLAN #42; `src/lib/portfolio/sources.ts:259` already declares it `out-of-scope` on the surface)." THEN, to land the Nakamigos slice — do it in the module's own idiom, which is unusually strict, so read src/lib/portfolio/types.ts top to bottom (97 lines, it is the design doc) before writing anything. (1) Add `'nakamigos'` to the `PortfolioSourceId` union at types.ts:16-23, placing it next to `'nft'` since display order is the union order. (2) In src/lib/portfolio/sources.ts, add a leg modelled EXACTLY on the JBAC block at :238-252: `state:'ok', usd:0, detail:'none held'` on a confirmed zero; `state:'unpriced', usd:null, detail:'N held — this venue has no NFT price feed, and a collection floor is not a price'` on a nonzero count; `callFailed(asOf)` on a failed or incomplete read. Extend the `PortfolioSnapshot` `nft` field to `{jbac, nakamigos}` and update src/lib/portfolio/sources.test.ts. (3) In src/hooks/usePortfolioSources.ts, DO NOT add the contract to batch A — Nakamigos ownership comes from Alchemy, not from your Multicall. Add a separate `useQuery` calling `fetchWalletNfts(address, NAKAMIGOS_CONTRACT)` from src/nakamigos/api.js (the contract is `COLLECTIONS.nakamigos.contract`, src/nakamigos/constants.js:98) with its own `refetchInterval` of 5 minutes or slower and its own `dataUpdatedAt` → `readAsOf(...)` (the helper at usePortfolioSources.ts:63), because every contributing leg must be able to state its own age. Pass `{ tokens, totalCount, complete }` into the snapshot and map `complete === false` to the failed branch. (4) The aggregate needs no change: `unpriced` legs already do not contribute to the sum and already force the total to `partial` — check src/lib/portfolio/aggregate.ts and add a test asserting a held-Nakamigos wallet still produces a `partial` total rather than an inflated `complete` one. TRAP: src/nakamigos/api.js is plain JS inside a TS project; import it from a `.ts` file only after checking how other TS callers do it, and if `allowJs` friction appears, wrap it in a tiny typed adapter rather than loosening tsconfig — `npx tsc -b --noEmit` is a required gate and must stay exit 0. VERIFY: `cd frontend && npx vitest run src/lib/portfolio src/hooks/usePortfolioSources.test.tsx src/pages/DashboardPage.pol.test.tsx src/pages/DashboardPage.lpBoost.test.tsx && npx tsc -b --noEmit && npm run lint`.

## Line 138 — Notification inbox on the push schema; real PWA install for the main app

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~8 h

**Evidence.** PWA INSTALL: DONE. frontend/src/lib/pwa/{install.ts,serviceWorker.ts} + components/pwa/{PwaRuntime.tsx,InstallPrompt.tsx}, PwaRuntime mounted at frontend/src/App.tsx:393 (imported line 15); frontend/public/manifest.webmanifest (standalone, 192/512 maskable icons) linked from frontend/index.html:9; frontend/public/sw.js is a real app-shell worker; shipped b4200931. serviceWorker.ts:1-28 handles the genuinely hard part — it refuses to register at scope '/' when nakamigos' /push-sw.js already owns it, so installing the shell cannot silently unregister the push worker of every user who enabled notifications. install.ts:10-14 correctly ships NO iOS button, because iOS Safari fires no beforeinstallprompt. INBOX: EXISTS but is browser-local, not on the push schema. frontend/src/lib/alerts/inbox.ts (248 lines) + hooks/useNotifications.ts + components/notifications/NotificationInbox.tsx, persisted to localStorage via inbox.ts:187 `INBOX_STORAGE_KEY = 'tegridy-alert-inbox-v1'`, capped at 200 entries (inbox.ts:53). The only push-related table in frontend/supabase/migrations/ is push_subscriptions (002_native_orders_trades_push.sql:107-140). There is no notifications/inbox table in any of the 22 migrations.

**What is left.** The 'on the push schema' half. The inbox is per-browser: clear storage or switch device and the record is gone, and nothing a server ever knew about is in it. Making it server-side requires the same missing piece as line 105 — something that runs when the tab is shut and writes rows. A table written only by the browser would be a synced cache, not a delivery record, and the inbox's own design (inbox.ts:1-18, which keeps `event` and `gap` rows apart precisely so an outage cannot read as a quiet market) would be undermined by rows nobody server-side vouched for.

**Risk.** Do not ship migration + table + client sync and call the item done. The value of 'on the push schema' is that a delivery attempt is RECORDED BY THE SENDER; useNotifications.ts:31-34 already stamps each entry with the channels it was recorded against precisely so 'nothing was pushed for this' is a permanent fact rather than an inference. A server table filled by the browser would make that stamp meaningless.

**How to do it.**

TICK THE PWA HALF AND SPLIT THE LINE. The plan line bundles a shipped feature with a blocked one, which is why it still reads unstarted. Rewrite line 138 as two lines: mark the PWA install `[x]` with the evidence (`components/pwa/`, `lib/pwa/`, manifest.webmanifest, sw.js, PwaRuntime at App.tsx:393, shipped b4200931 — noting the scope-yield behaviour and the deliberate absence of an iOS button), and leave the inbox line open with its real blocker named: it waits on the same sender line 105 waits on.

LANDABLE TODAY, if you want the schema half started: author frontend/supabase/migrations/022_notifications.sql — do not apply it. Shape it after 016_alert_rules.sql, which is the correct model in this repo: same RLS-keyed-to-the-SIWE-JWT-wallet-claim pattern as push_subscriptions in 002/004, plus the 008-style grants, and an unapplied-migration header block stating that until an operator runs it the reads answer 503 `schema-missing` and NOT an empty inbox. Carry 016's discipline forward literally: DO NOT add a `delivered_at` or `status` column until a real sender writes to it — 016_alert_rules.sql:18-23 explains why (a column that is always NULL reads as 'never fired', which is a claim). Give the table the same dedup key the pure store already uses (inbox.ts keys events on idempotencyKey and gaps on rule+reason), so a restarted sweep produces one row, not one per pass.

FUNCTION BUDGET: the read/write API extends `?resource=alerts` in frontend/api/_lib/alerts.js, dispatched from aggregator.js:300. Do NOT add api/notifications.js — frontend/api/ has 11 top-level handlers against a cap of 12.

OPERATOR: applying 022, plus the VAPID pair and the sweep secrets from line 105.

VERIFY: `npx vitest run` from frontend/ — frontend/api/__tests__/rlsCoverage.test.ts checks that every table has RLS coverage and will fail on a new table without policies. That test is the reason to write the migration carefully rather than quickly.

## Line 150 — If Solana restart: land ~15 scheduled audit fixes (or delete segmented mode — it carries both HIGHs)

**PARTIAL** · buildable: YES · ~10 h

**Evidence.** Branch `claude/solana-segmented-removal` @ b990f8b2 (2026-08-18) removes segmented.rs + src/vendor/ (~2,350 lines, BondingCurve 716→170 B). `git merge-base --is-ancestor b990f8b2 mvp-launch` → FALSE: it is NOT on trunk. Trunk still carries solana/tegridy-amm/programs/tegridy-launch/src/segmented.rs (847 lines) and src/vendor/. Branch merge-base is fd706689; trunk is 72 commits ahead of it (`git rev-list --count fd706689..mvp-launch` → 72). Findings ledger: `grep -o 'Disposition: [A-Z]*' docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md | sort | uniq -c` → 22 MOOT, 21 SCHEDULED — the plan's '~15' undercounts by six.

**What is left.** The branch is unmerged and 72 commits stale. Of its own six-item DO-NOT-MERGE checklist (b990f8b2 commit message, 'WHAT IS LEFT before this can merge'): (1) client follows the 170-byte layout — ALREADY DONE ON TRUNK, independently of the branch, see surprises; (2) tripwire test that reads the Rust and fails on client drift — NOT DONE (no test under frontend/src/lib/launcher reads any solana/**/*.rs; the only fs-reading tests are covenant.test.ts and spentProgramIds.test.ts:213, which reads program.ts, not the Rust); (3) delete the clmm-vendor-guard job — NOT DONE and correctly so on trunk, where .github/workflows/solana-ci.yml:209-268 still guards a src/vendor/ that still exists; it only becomes a red job on the branch; (4) MAINNET_RUNBOOK.md step 3 still documents set-curve-segments — NOT DONE (solana/tegridy-amm/MAINNET_RUNBOOK.md:296-306); (5) new operator prerequisite (a cp-swap admin must create the permission PDA for the migration authority before any launch can graduate) — NOT DONE, not present anywhere in MAINNET_RUNBOOK.md; (6) unverified SBF stack frame on MigrateToAmm::try_accounts, migration compute budget, and the TypeScript integration tests, which were edited without a type-check or a run — NOT DONE, needs a cargo build-sbf. The 21 SCHEDULED audit fixes themselves: untouched as a set (a handful were incidentally closed on trunk — #256 client account drift by 21835d1d/0fbbf2a4, #316 closed-program staleness by 514942c5/b0484908, #189 CI required-checks by cdd58b06/5565506b — but no one has reconciled the ledger).

**Risk.** Two ways to get this subtly wrong. (1) A naive `git merge` or `git rebase` of the branch will silently regress trunk's client to the branch's older, partly-guessed version — the branch was cut before 0fbbf2a4 fixed the migrateToAmmIx account order and before 514942c5 stopped the client claiming a live rail. The regression would type-check and lint clean. (2) Removing clmm-vendor-guard from the job body but not from all-checks-pass's `needs:` at solana-ci.yml:836 produces a workflow that fails to parse rather than a workflow that fails a check — easy to misdiagnose as unrelated CI breakage. Separately: the account-layout break is only safe because BOTH program ids are closed and spent (docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md:16-30, verified on two RPCs 2026-08-15). Do not repeat this pattern once anything is live.

**How to do it.**

This is landable today because it is all local Rust/TS/doc work, but the merge is NOT a fast-forward and the obvious approach will destroy work.

THE TRAP, read this first: trunk has ALREADY moved the TypeScript client to the post-removal 170-byte layout (frontend/src/lib/launcher/solana/curve/program.ts:361-381 declares POST_REMOVAL_PROGRAM with `branch: 'claude/solana-segmented-removal'`, and program.test.ts:105-112 asserts BONDING_CURVE_SIZE === 170 and GLOBAL_CONFIG_SIZE === 194). Trunk's Rust still has segmented mode. The client and the program on trunk deliberately disagree, and program.ts:363-370 says so in a comment. So checklist item 1 is already satisfied on trunk, by commits 0fbbf2a4 and 514942c5, which the branch predates. Rebasing b990f8b2 onto mvp-launch will conflict hard in frontend/src/lib/launcher/solana/curve/**. RESOLVE EVERY SUCH CONFLICT IN FAVOUR OF TRUNK — trunk's client is the newer and better-verified one (0fbbf2a4's message: offsets read from the program source, not guessed). Take ONLY the Rust and workflow changes from the branch.

Steps: (a) `git checkout -b solana/segmented-removal-rebased mvp-launch`; (b) `git cherry-pick -n b990f8b2`, then `git checkout mvp-launch -- frontend/` to discard the branch's client edits wholesale; (c) confirm the remaining diff touches only solana/tegridy-amm/** — expect deletion of programs/tegridy-launch/src/segmented.rs and src/vendor/ (7 files), edits to curve.rs, errors.rs, lib.rs, state.rs, Cargo.toml, Cargo.lock, and the two tests/ files; (d) checklist 3: delete the `clmm-vendor-guard` job at .github/workflows/solana-ci.yml:209-268 AND remove it from the two aggregation lists at :836 (`needs:`) and :857 (the result string) — missing either leaves all-checks-pass referencing a job that no longer exists, which fails the workflow at parse time; (e) checklist 4: rewrite MAINNET_RUNBOOK.md:296-306, deleting the set-curve-segments step and renumbering; (f) checklist 5: add a new §0 prerequisite to MAINNET_RUNBOOK.md stating that a cp-swap admin must create the permission PDA keyed by the migration authority before any launch can graduate, and mark it UNVERIFIED — program.ts:410-417 already records that the PDA-keyed-by-migration_authority claim is an inference, not a read; do not upgrade it to fact; (g) checklist 2: add frontend/src/lib/launcher/solana/curve/rustDrift.test.ts that `readFileSync`s solana/tegridy-amm/programs/tegridy-launch/src/state.rs, regex-extracts the `pub struct BondingCurve` and `pub struct GlobalConfig` field lists, sums their widths, and asserts they equal BONDING_CURVE_SIZE and GLOBAL_CONFIG_SIZE. Model the file-reading + repo-root resolution on frontend/src/lib/launcher/solana/spentProgramIds.test.ts:25 and :213. This test MUST be written to go RED on today's trunk (716 vs 170) and green only after the Rust deletion lands in the same commit — that is the whole point, and it is what nobody has done.

Verify: from frontend/, `npx tsc -b --noEmit && npm run lint && npx vitest run`. Then `cd solana/tegridy-amm && cargo test -p tegridy-launch --lib` — expect 40 passing (baseline was 67; the 27-test delta is the deleted segmented and vendored-math suites, per the b990f8b2 message). Do NOT attempt checklist item 6 (SBF frame / compute budget) unless a Solana toolchain is installed; if it is not, leave the DO-NOT-MERGE header's item 6 in place and say so.

Do NOT try to 'land the ~15 scheduled audit fixes' as an alternative: there are 21, not 15, several are already closed on trunk without the ledger being updated, and the rest are gated on the unmade `[op]` restart decision at plan line 149 plus the `[ext]` audit at line 153. Deleting segmented mode is the arm of the 'or' that is actually reachable.

## Line 158 — ERC-4626 auto-compounder over LP farming (verbatim Yearn V3/Beefy; post-audit)

**PARTIAL** · buildable: NO_NEEDS_EXTERNAL · ~5 h

**Evidence.** BUILT, and the plan line is stale. contracts/src/vaults/TegridyHarvestVault.sol (543 lines), contracts/script/DeployHarvestVault.s.sol (82), contracts/test/vaults/TegridyHarvestVault.t.sol (697) + TegridyHarvestVaultReentrancy.t.sol (258) — all landed in c749c933 (2026-08-19 13:10), which IS on mvp-launch. The plan doc's own 'Reconciled against the tree 2026-08-19' header refers to commit 012c6f58 at 2026-08-19 01:15, twelve hours BEFORE c749c933 — which is why the box is still empty.

**What is left.** Three real gaps, not just a tick. (1) BASE DEVIATION: the plan says 'verbatim Yearn V3/Beefy'; the vault is built on OpenZeppelin ERC4626 (TegridyHarvestVault.sol:7, :96-100), neither of the two the plan named. Defensible, but undocumented as a deviation. (2) THREE OF FOUR MANDATED GUARDRAILS ABSENT. docs/USER_VALUE_ROADMAP.md:85 lists four as 'mandatory, verbatim, no improvising': OZ virtual-shares defence — PRESENT (`_decimalsOffset()` returns 6 at :248); dead-shares seed mint — ABSENT; Yearn's profit-unlock buffer — ABSENT; Beefy's `harvestOnDeposit` — ABSENT. `minAmountOut` routed through Flashbots Protect — ABSENT (the bound is `minPairedOut`, supplied by the keeper, :352-378; no Flashbots reference in the file). (3) DESIGN INVERSION: docs/USER_VALUE_ROADMAP.md:81 specifies 'permissionless `harvest()` + caller reward … bots self-harvest for the reward, so no team keeper'. The shipped `harvest()` is `onlyKeeper` (:355), and :339-351 argues the case for it (an untrusted caller supplying minPairedOut=0 can sandwich the vault's own swap). The argument is good; the plan and roadmap still say the opposite. (4) NO FRONTEND: no useHarvestVault.ts, no HARVEST_VAULT address in frontend/src/lib/constants.ts, no FarmPage section. The only frontend references are in frontend/src/lib/zap/venues.ts and its tests. Deployed nowhere; audit and deploy outstanding.

**Risk.** The audit is the real blocker and it is external, so nothing here reaches users. The trap is the opposite one: c749c933 landing makes it LOOK done, and the next session ticks the box without noticing the guardrail gaps or that the roadmap still promises a permissionless harvest that does not exist. Also note docs/SLITHER_TRIAGE_2026_08_22.md:126-157 clears all 8 Slither findings on this file — but its own header (:7-14) says the adversarial refutation pass never ran and the verdicts are 'evidence, not a decision'. Do not treat that triage as an audit.

**How to do it.**

Do NOT simply tick line 158 — that would bury four unrecorded deviations from the repo's own verbatim-fork law. Instead:

(a) Rewrite plan line 158 to say what actually landed: '🟡 in the tree 2026-08-19 `c749c933` — OZ ERC4626 base, not Yearn V3/Beefy; keeper-gated harvest, not permissionless; three of four USER_VALUE_ROADMAP §85 guardrails absent. Audit + deploy outstanding.' The plan header at docs/YEAR_PLAN_2026_2027.md:9-15 explicitly sanctions this shape ('a box ticked on a half-done item is a lie the next session inherits').

(b) Correct docs/USER_VALUE_ROADMAP.md:81 and :85 so they stop mandating a design the tree deliberately rejected. Line 81's 'no team keeper' clause is now false, and it is the sentence that sells the feature. Replace it with the actual reasoning, which is already written well at TegridyHarvestVault.sol:339-351 — cite the file:line rather than re-arguing it.

(c) The two genuinely landable code deltas, both pure Solidity + foundry, no keys: Beefy's `harvestOnDeposit` (call `harvest()` from `_deposit` when rewards exceed a threshold, so a large deposit cannot dilute pending yield) and Yearn's profit-unlock buffer (stream harvested profit into `totalAssets()` over a lock period instead of stepping it, which closes the sandwich-the-harvest-block deposit). Note that the profit-unlock buffer changes `totalAssets()` (:241-243, currently live LP balance + `farm.rawBalanceOf`), so every share-price test in TegridyHarvestVault.t.sol must be re-read, not just re-run.

(d) Frontend, behind `isDeployed()`: add HARVEST_VAULT_ADDRESS to frontend/src/lib/constants.ts (zero address for now, exactly as POSITION_MARKET_ADDRESS is at :168), a hooks/useHarvestVault.ts mirroring useLPFarming.ts, and a card on FarmPage.tsx. MANDATORY on that card: the vault earns only the 1.0× base boost because it holds no veTOWELI position (TegridyHarvestVault.sol:76-90 spells this out), so a boosted depositor earns strictly MORE by staking LP directly. The file's own words: any interface showing a boosted APY next to this vault is misreporting. Render the un-boosted rate and say why.

Verify: `cd contracts && forge test --match-path 'test/vaults/*'`; from frontend/, `npx tsc -b --noEmit && npm run lint && npx vitest run`.

## Line 159 — TegridyRestaking EIP-170 split → `[ext]` re-audit → `[op]` deploy

**PARTIAL** · buildable: NO_NEEDS_EXTERNAL · ~1 h

**Evidence.** The `[code]` half is DONE and the plan line is stale. c749c933 (on mvp-launch) split TegridyRestaking.sol (577 lines changed) into host + contracts/src/TegridyRestakingAdmin.sol (377 lines, new) + the pre-existing contracts/src/RestakingMonitorView.sol (86 lines, from 51e8f049), deleted contracts/src/lib/RestakingAdminLib.sol (265 lines), and added contracts/script/DeployRestaking.s.sol (119) and contracts/test/Audit_RestakingEIP170Size.t.sol (117). Measured sizes, re-measured against this tree's own artifacts rather than trusted: TegridyRestaking 22,114 B (2,462 B under), TegridyRestakingAdmin 9,298 B, RestakingMonitorView 2,275 B — docs/CONSOLIDATION_2026_08_21.md:105-112. It was 26,784 B, i.e. 2,208 B OVER and undeployable by construction — Audit_RestakingEIP170Size.t.sol:10-12. Design doc: docs/RESTAKING_EIP170_SPLIT_DESIGN.md. The frontend ABI was subsequently realigned to the 6-field RestakeInfo by 0d4ec7e4 (#304).

**What is left.** Only `[ext]` re-audit and `[op]` deploy. YES — a re-audit is the only blocker on the code side; there is no unwritten code on this line. Confirmed deployed nowhere (c749c933's own message: 'Both are deployed nowhere. Restaking deploy stays gated on an external re-audit, which is not mine to schedule.').

**Risk.** Low on the code. The risk is a stale-plan one: this is the item most likely to be re-done by a future session, because RESTAKING_EIP170_SPLIT_DESIGN.md reads as a plan for unbuilt work and the year-plan box is empty. Both artifacts point at work that already shipped.

**How to do it.**

Rewrite plan line 159 to close the `[code]` half and leave the rest open: '- [ ] `[ext]` Re-audit the TegridyRestaking EIP-170 split → `[op]` deploy — the split shipped 2026-08-19 `c749c933`: 26,784 B → 22,114 B, with a regression guard at contracts/test/Audit_RestakingEIP170Size.t.sol so the analysis cannot be redone in six months.' Do not tick the whole line — the audit and deploy are real and outstanding.

The one piece of genuine remaining code work, and it is not on this line: docs/CONSOLIDATION_2026_08_21.md:114-116 reports TegridyStaking at 24,554 B (22 bytes of headroom) and VoteIncentives at 24,477 B (99 bytes). BOTH ARE LIVE. The next one-line edit to either produces an undeployable artifact, and the doc says the extraction is unbuilt. That is the same defect class this line just fixed, one contract over, and it blocks plan line 180 (see that entry). If an agent has appetite for restaking-adjacent EIP-170 work, that is where it should go.

When preparing the auditor handoff, do not let the split's own design doc mislead them: docs/RESTAKING_EIP170_SPLIT_DESIGN.md:157 warns that the `restakers` public getter tuple shape (RestakeInfo, TegridyRestaking.sol:134-144) is bound by RestakingMonitorView.sol:5 and 40+ test sites — including the write-only `unsettledSnapshot` field at :140. Do not reorder or remove RestakeInfo fields, and say so in the handoff.

Verify: `cd contracts && forge test --match-path test/Audit_RestakingEIP170Size.t.sol` and `forge build --sizes | grep -i restaking`.

## Line 160 — Staking-position secondary market (redeploy batch 8f72bed + E.21)

**PARTIAL** · buildable: NO_NEEDS_OPERATOR · ~4 h

**Evidence.** The contract leg is DONE and the plan line is stale. contracts/src/markets/TegridyPositionMarket.sol (609 lines) + contracts/script/DeployPositionMarket.s.sol (72) + four test files (test/markets/PositionMarket.t.sol 491, PositionMarketFeeAndRewards.t.sol 292, PositionMarketHarness.sol 261, PositionMarketStakingBinding.t.sol 220), all in 710e4a0e (2026-08-19 21:54), on mvp-launch. Crucially it does NOT need the 8f72bed batch or the E.21 relaxation: TegridyPositionMarket.sol:38-59 states it is 'built to be correct against the LIVE contract, unrelaxed, so it needs no redeploy to be safe', and works around the AlreadyHasPosition guard by refusing such buyers up front with `RecipientHoldsPosition` and taking a `recipient` parameter.

**What is left.** Three things. (1) FRONTEND IS ORPHANED: frontend/src/components/positionMarket/PositionMarketPanel.tsx exists but `grep -rn 'PositionMarketPanel' frontend/src` returns ZERO importers outside the file itself. There is no PositionMarketPage.tsx (frontend/src/pages/ has no position/market page), no nav entry (no match in frontend/src/lib/navConfig.ts or App.tsx), and POSITION_MARKET_ADDRESS is the zero address (frontend/src/lib/constants.ts:168). The hooks (usePositionMarket.ts, usePositionMarketFillability.ts and their tests) are real and tested but unreachable from the app. (2) E.21 PHASE 1 NOT DONE: docs/BATTLE_PLAN.md:1101 specifies an interim OTC board — a `stakingPosition` collection type on frontend/api/orderbook.js; `grep -n 'stakingPosition' frontend/api/orderbook.js frontend/api/_lib/*.js` returns nothing. (3) E.21 PHASE 2 NOT DONE and not needed: the single-position guard is still live (contracts/src/TegridyStaking.sol:500 `error AlreadyHasPosition()`, :1006 and :1076 `if (userTokenId[msg.sender] != 0) revert AlreadyStaked()`). Not deployed; 8f72bed is not on mvp-launch.

**Risk.** The contract binds five TegridyStaking selectors (userTokenId, unsettledRewards, rewardToken, claimUnsettled, kick — IStakingPositionMarketView at TegridyPositionMarket.sol:22-28) and the file warns at :13-21 that a future EIP-170 golf pass could lower one to `internal`, after which the call reverts with EMPTY returndata, indistinguishable from a legitimate refusal. This is not hypothetical — it names `userPositionCount`, 2026-05-31. Given TegridyStaking has 22 bytes of headroom (docs/CONSOLIDATION_2026_08_21.md:114), the next golf pass is close. Every selector is pinned in test/markets/PositionMarketStakingBinding.t.sol; do not add one without adding its binding assertion.

**How to do it.**

Blocked on deploy, but there is a real landable slice and it is the most embarrassing gap in this cluster: a 609-line audited-shape contract with 1,264 lines of tests, a working hook layer, and a rendered panel that NOTHING IMPORTS.

Landable today, no keys: create frontend/src/pages/PositionMarketPage.tsx that renders `<PositionMarketPanel />`, add its route to frontend/src/lib/navConfig.ts, and gate the whole surface on `isDeployed(POSITION_MARKET_ADDRESS)` the way every other undeployed surface in this repo is gated. Keep POSITION_MARKET_ADDRESS at the zero address in frontend/src/lib/constants.ts:168 — do NOT invent one. With the gate on, the page renders its not-yet-live state and nothing else; that is the correct shipped behaviour and it is what makes the panel stop being dead code.

The listing card must read lock end, `boostBps`, pending rewards and intrinsic TOWELI live from StakingViewLib / the indexer, never a modeled 'fair value' (docs/BATTLE_PLAN.md:1101). Reuse frontend/src/hooks/usePositionMarketProceeds.test.ts's subject for net-proceeds display rather than recomputing.

Then rewrite plan line 160 — the parenthetical is now wrong in a way that will cost a future session real time. It reads '(redeploy batch 8f72bed + E.21)', implying the market waits on a redeploy. It does not. Replace with: '- [ ] `[op]` Deploy TegridyPositionMarket — contract shipped 2026-08-19 `710e4a0e`, built against the UNRELAXED live staking so it needs no redeploy; the E.21 guard relaxation is a separate, optional v2 item.'

Do NOT register this market as a lending contract to dodge the transfer guards. TegridyPositionMarket.sol:47-53 rejects that explicitly: `isLendingContract[from]` is the carve-out, registration is a timelocked staking-admin action, and it would hand the market cooldown and rate-limit exemptions it has no business holding. An agent optimising the buyer flow will be tempted by this.

Verify: `cd contracts && forge test --match-path 'test/markets/*'`; from frontend/, `npx tsc -b --noEmit && npm run lint && npx vitest run`.

## Line 165 — Premium rebundle: API keys, higher caps, bulk scans; correct the unit-confused pricing analysis

**PARTIAL** · buildable: YES · ~6 h

**Evidence.** API KEYS: DONE. frontend/api/_lib/apiAuth.js (610 lines — issuance, verification, per-key tiers, metering), frontend/supabase/migrations/017_api_keys.sql, frontend/src/components/developer/ApiKeyPanel.tsx, surfaced at /developers (App.tsx:354); shipped 896ab324 + 33850b8c. HIGHER CAPS: catalog + limiter DONE — frontend/api/_lib/apiTiers.js:205 API_TIERS defines free/starter/growth/scale at 10/60/300/1200 rpm and 1k/50k/400k/2.5M monthly calls, enforced from the same module the developer page renders from. But nobody can buy one: apiTiers.js:28 `API_BILLING_ENABLED = false` and apiTiers.js:35 `API_PRICING_STATE = 'proposed'`, so self-serve issuance mints only the $0 tier. BULK SCANS: NOT DONE — grepping `bulk` across frontend/api and frontend/src returns only BulkListingWizard (an NFT surface) and two unrelated comments; there is no batch or multi-address scan route. PRICING ANALYSIS: NOT CORRECTED, and it is wrong in two independent ways (see remaining).

**What is left.** (1) No bulk-scan endpoint. (2) Paid tiers unsellable until a processor is wired — that is deliberate (apiTiers.js:22-27 says flipping the flag without a processor would publish a price the venue cannot collect) and is an operator decision. (3) REVENUE_ANALYSIS.md is wrong twice. UNIT CONFUSION: lever #5 (REVENUE_ANALYSIS.md:18) and calibration move #4 (:100-101) price the Premium subscription in ETH — '0.01 ETH / month (PREMIUM_MONTHLY_FEE)' and 'Cut PREMIUM_MONTHLY_FEE to 0.003 ETH' — but the deployed contract charges TOWELI: contracts/src/PremiumAccess.sol:39 `uint256 public monthlyFeeToweli; // TOWELI per month` and :250 `uint256 cost = monthlyFeeToweli * months;`. There is no PREMIUM_MONTHLY_FEE ETH lever to cut. The live page agrees with the contract, not the doc — frontend/src/pages/PremiumPage.tsx:221,255,290 all render TOWELI. ARITHMETIC ERROR: REVENUE_ANALYSIS.md:76 claims $30/mo needs '$40k/mo' of swap volume to break even. A 50% discount on a 0.50% fee saves 0.25% of volume, so break-even is $30 / 0.0025 = $12,000/mo. The proposed '$9/mo → ~$12k/mo' at :76 and :101 is wrong the same way: $9 / 0.0025 = $3,600/mo. Both figures are 3.33x too high, consistent with dividing by 0.075% instead of 0.25%.

**Risk.** The pricing figures are quoted onward — docs/ARCHITECTURE.md:102 and docs/USER_VALUE_ROADMAP.md:5 both point readers at REVENUE_ANALYSIS.md as the fee-calibration authority — so a wrong break-even is not confined to one file. Separately, when correcting the ETH/TOWELI confusion do NOT convert the doc's ETH figures to TOWELI at a spot price and present the result as the contract's setting: the contract's number is a TOWELI quantity fixed by proposeFeeChange, and its USD value moves with the token. State both, and say which one the contract actually stores.

**How to do it.**

Two independent landable slices; do them in separate commits.

SLICE A — correct REVENUE_ANALYSIS.md (1-2h, pure doc, no keys). Fix lever #5 at line 18 to state the deployed denomination: `monthlyFeeToweli` (contracts/src/PremiumAccess.sol:39), changed via the timelocked proposeFeeChange at PremiumAccess.sol:567-574, with the USD equivalent shown as derived-at-a-price rather than as the setting. Fix the break-even arithmetic at :76 and :101: show the working inline (fee 0.50%, discount 50%, so 0.25% of volume saved; break-even = monthly fee ÷ 0.0025) so the next reader can check it in one line instead of trusting it. Rewrite calibration move #4 (:100-101) to name the lever that exists. While in there, check the two rows flagged at docs/UNFINISHED_INVENTORY_2026_08_13.md:755-758 — lever #1's 'Who receives | 100% → RevenueDistributor → stakers' cell at line 14 (and the 'same' cell on lever #2) still contradicts the ~80% end-to-end figure the same document uses at line 68 after ReferralSplitter's carve. That is the same class of defect and it is already diagnosed; fix it in the same pass. Then verify: from frontend/ run `npx vitest run` — frontend/src/lib/docsClaimHonesty.test.ts and src/pages/revenueClaimHonesty.test.ts parse claims out of docs and may already pin some of these strings.

SLICE B — bulk scans (4h, zero keys, zero new functions). Add a `route=bulkscan` case to the EXISTING frontend/api/v1/index.js switch (around line 343, beside `erc20scan` and `scan`). It must NOT be a new file: frontend/api/ holds ELEVEN top-level handlers against a hard Hobby cap of 12 (aggregator, alchemy, analytics, auth/me, auth/siwe, etherscan, opensea, orderbook, solrpc, supabase-proxy, v1/index) and SERVERLESS_BUDGET.md:12's '9 functions' figure is stale — count the directory. v1/index.js:22-24 already states this rule for the keyed layer; follow it.

The bulk route MUST be keyed (add it to the KEYED_ROUTES set at v1/index.js:79 — a keyless fan-out endpoint is an unmetered cost amplifier against a paid Ethplorer key), must cap the address list hard (10-25, refuse above with a 400 carrying a documented code), must meter one call PER ADDRESS not per request (use admission.settle and check how apiAuth.js counts), and must preserve the per-address three-outcome contract from _lib/scannerApi.js: each element carries its own `scanned` boolean, and an address whose read FAILED must not appear as a clean result. Do not aggregate a partial batch into a single 200 that hides which entries were unreadable. Add the new refusal codes to API_ERROR_SEMANTICS (apiTiers.js:135) and an API_ROUTES row (apiTiers.js:41) — frontend/api/__tests__/apiErrorSemantics.test.js pins that list in both directions and will fail if you skip either.

VERIFY: `npx tsc -b --noEmit && npm run lint && npx vitest run` from frontend/. Extend frontend/api/__tests__/v1-scan-honesty.test.js with the batch case: one good address plus one unreadable one must not produce a response in which the unreadable one looks clean.

## Line 180 — Protocol v2 batch: streaming RevenueDistributor · factory timelock · dead penalty-code removal · IVotes delegation · staking-AMM change

**PARTIAL** · buildable: YES · ~20 h

**Evidence.** Three of five landed; two did not. STREAMING REVENUEDISTRIBUTOR — DONE: contracts/src/v2/StreamingRevenueDistributor.sol (759 lines), contracts/test/v2/StreamingRevenueDistributor.t.sol (639), contracts/script/DeployStreamingDistributor.s.sol (96), all in 710e4a0e; Synthetix-pattern continuous accrual with boost/lock weighting as the delta, preserving the epoch-snapshot anti-flash-staker property. FACTORY TIMELOCK — DONE in source: contracts/src/TegridyFactory.sol:20 `is TimelockAdmin`, :53 `FEE_TO_CHANGE_DELAY = 48 hours`, :297-298 `setFeeTo` reverts 'Use proposeFeeToChange()', :302-313 propose/execute pair, plus a C6 fix at :373-388 clearing a pending FEE_TO_CHANGE when the setter rotates. DEAD PENALTY-CODE REMOVAL — DONE in source: TegridyStaking.sol:1985 'V2: reconcilePenaltyDust() removed — penalty drain system was dead code'; grep for totalPenaltyUnclaimed|totalPenaltyAccumulated|totalRewardsAccumulated|totalPenaltiesRedistributed across contracts/src returns zero hits. IVOTES DELEGATION — NOT DONE: no IVotes or ERC721Votes anywhere in contracts/src/TegridyStaking.sol (every 'delegat' hit is EIP-170 delegatecall-library plumbing or EIP-7702 receiver checks); ROADMAP.md:96 confirms 'IVotes delegation is in the Q4 v2 batch'. STAKING-AMM CHANGE — NOT DONE: the E.21 relaxation is unbuilt, AlreadyHasPosition still fires (TegridyStaking.sol:500, :1006, :1076).

**What is left.** IVotes delegation and the staking-AMM (E.21 phase-2 multi-position-receipt) change. Both edit contracts/src/TegridyStaking.sol, and that is the problem — see risk. Also: V2_ROADMAP.md items 5 (:27) and 6 (:33) still present the two completed items as an open backlog, and WORKORDER_V2.md:32 and :171 still ask a future session to 'verify #5/#6 still pending'. That verification is what this audit just did: both are done in source, neither is deployed.

**Risk.** Two. (1) An agent that writes IVotes first and measures after will produce a contract that compiles, tests green under `forge test`, and is undeployable — the size gate is a separate job and, per docs/CONSOLIDATION_2026_08_21.md:125-131, that gate has itself shipped three defects including one where a missing `jq` made every contract measure 0 B and print 'All contracts within size budget'. A false green by construction, which actually happened on a dev machine during the 2026-08-19 work. Always measure with `forge build --sizes` directly, never trust the CI summary line. (2) Relaxing the single-position guard changes the invariant TegridyPositionMarket was designed around; the market's refusal path (`RecipientHoldsPosition`) becomes a false refusal, which is a UX regression rather than a safety one, but it will look like a bug.

**How to do it.**

THE TRAP, and it is the single most valuable finding in this cluster: both remaining sub-items add code to contracts/src/TegridyStaking.sol, which measures 24,554 bytes with TWENTY-TWO bytes of headroom under EIP-170's 24,576 (docs/CONSOLIDATION_2026_08_21.md:105-116, re-measured against this tree's own artifacts, not trusted from the originating session). VoteIncentives is at 24,477 B with 99 bytes. Both are LIVE and both are floor-exceptions in the CI size gate. Adding OZ's ERC721Votes to TegridyStaking is not a large change that might be tight — it is arithmetically impossible without an extraction first, and the doc says the extraction is unbuilt.

So the order is: (1) extract from TegridyStaking before writing a line of IVotes. Follow the pattern this repo has now used three times rather than inventing a fourth — host implementation + admin sister + monitor view + delegatecall library. The worked examples are contracts/src/TegridyRestakingAdmin.sol (c749c933, took restaking 26,784 → 22,114 B) and contracts/src/StakingMonitorView.sol / contracts/src/lib/StakingViewLib.sol, already in use at TegridyStaking.sol:791 and :854. Pair the extraction with a size-regression test modeled verbatim on contracts/test/Audit_RestakingEIP170Size.t.sol — that file's docblock (:15-19) explains why a test is needed on top of the CI gate: the gate carries a two-tier allowlist whose OVER_EIP170_DEFERRED tier only WARNS, and an allowlist entry cannot soften an assertion.

(2) Then IVotes: OZ ERC721Votes pattern per V2_ROADMAP.md:47-50 — users delegate without transferring the NFT, which unlocks Tally / Snapshot on-chain mode. Note TegridyStaking.sol:1951 already comments that Compound and OZ Governor both compare against the MAX_POSITIONS_PER_HOLDER cap (50, :246), and voting power already sums over `_positionsByOwner` via StakingViewLib.votingPowerOf (:791). Delegation must respect that same set, not the legacy single-pointer `userTokenId` (:226) — TegridyStaking.sol:765-770 records that using `userTokenId` for voting power was a real bug that undercounted multi-NFT holders.

(3) Staking-AMM change: relax the transfer-in guard to allow multi-position receipt per docs/BATTLE_PLAN.md:1101. The EnumerableSet and the votingPowerOf iteration already support it — this is a small delta. Leave the STAKE-path guard (:1006, :1076) unchanged; only the transfer-in path relaxes. Before doing it, read contracts/src/markets/TegridyPositionMarket.sol:38-59: that market was deliberately built to be correct against the UNRELAXED contract, so relaxing must not break it. PositionMarketStakingBinding.t.sol reads the cap and rate limit from the live contract and asserts the market agrees — run it after.

(4) Housekeeping, cheap and separately landable: strike V2_ROADMAP.md items 5 and 6 (or delete the file — docs/UNFINISHED_INVENTORY_2026_08_13.md:740-741 already found five of fifteen items shipped and recommended folding the live ones into WORKORDER_V2 and deleting it), and close out WORKORDER_V2.md:32's 'verify #5/#6 still pending' with the answer.

Verify: `cd contracts && forge build --sizes | grep -E 'TegridyStaking|VoteIncentives'` must show every src contract under 24,576 B; `forge test --match-path 'test/markets/*'` and the full staking suite must stay green.

## Line 43 — 015 §2 read-side per table (votes needs an aggregate view first)

**NOT_STARTED** · buildable: YES · ~6 h

**Evidence.** 015 §2 is still four commented-out DROPs: frontend/supabase/migrations/015_drop_permissive_policy_overrides.sql:95-98. No aggregate view exists anywhere — I grepped all 23 tracked .sql files plus docs for 'CREATE VIEW', 'CREATE OR REPLACE VIEW', 'MATERIALIZED VIEW': zero hits; the only matches for 'aggregate' are prose at 000_base_schema.sql:400, 013_analytics_events.sql:81, OPERATOR_NEXT.md:67, TODO_OPERATOR.md:93. Highest migration number is 021_commerce.sql, so 022 is free.

THE PLAN LINE IS WRONG BY THREE TABLES, and 015's own comment is wrong. 015:91 asserts 'The owner-scoped SELECT twin ("Owner reads watchlist" etc.) already exists for each'. Grepping every policy statement across migrations 000-021: user_favorites has 'Owner reads favorites' (002:155-158, 004:157-160, 000:300-304) and user_watchlist has 'Owner reads watchlist' (002:160-163, 004:162-165, 000:349-353) — but user_profiles has NO owner SELECT policy in any file (only 'Anyone can read profiles', 002:152-153 / 000:257-259) and votes has NO owner SELECT policy in any file (only 'Anyone can read votes', 002:165-166 / 000:402-404).

AND the two twins that do exist are unreachable from the browser. They key on `current_setting('request.jwt.claims',true)::json->>'wallet'`, but the browser's Supabase client carries only the anon key — the SIWE JWT is httpOnly and server-only (frontend/src/nakamigos/lib/supabaseProxy.js:1-11), and the proxy permits SELECT for dm_messages ONLY (frontend/api/supabase-proxy.js:64-68, `const SELECT_TABLES = new Set(["dm_messages"])`). All four live reads go direct with the anon key: userdata.js:200-201 (user_profiles), :283-284 (user_favorites), :355-356 (user_watchlist), :522-523 and :551-552 (votes).

**What is left.** Everything. And more than the line says: applying ANY of 015 §2's four drops makes that table read as EMPTY from the browser — for the owner too — not as an error. userdata.js catches the failure and falls back to localStorage, so the UI shows blank/stale data with no toast. Live callers exist for three of the four: App.jsx:647-652 (syncFavorites), components/Watchlist.jsx:34-38 (syncWatchlist), components/EditProfile.jsx:65 (getProfile). getWeekVotes/getUserVote have no callers at all — the vote UI was never wired — so the aggregate view the line names is work for a dead path, while the three tables that ARE live have no plan at all.

**Risk.** Three ways to get this subtly wrong. (1) Building only the votes view, because that is what the plan line says, and then uncommenting all four §2 lines — that silently blanks profiles, favourites and watchlists in production. (2) Creating the aggregate view with `security_invoker = true`: the view then inherits the caller's RLS, reads votes as anon, and returns zero rows — i.e. it reproduces the exact outage it exists to prevent, and it does so silently because getWeekVotes catches and returns {}. (3) Editing 015 in place to uncomment §2. 015 may already be applied; MIGRATIONS.md's whole thesis is that this database has no ledger, and editing an applied file makes its identity lie. Also note this repo has already made the underlying mistake once: 002:143-146 records that 001 enabled RLS with no SELECT policy, leaving these same five tables unreadable.

**How to do it.**

Treat the plan line as understated and fix the read path for all four tables, not just votes. Everything below is repo-file authoring — no SQL is executed, so it is landable today. Running it is [op].

STEP 1 — correct the record first (5 min, highest value per minute). In frontend/supabase/migrations/015_drop_permissive_policy_overrides.sql, the comment at :91 is false. Replace it with the truth: 'user_favorites and user_watchlist have an owner-scoped SELECT twin; user_profiles and votes have NONE in any migration. And no twin is reachable from the browser — it keys on the SIWE JWT claim, which the anon-key client does not carry (api/supabase-proxy.js:68 permits SELECT for dm_messages only). Uncommenting any line below makes that table read EMPTY, not denied.' Editing a comment in an applied migration is safe; editing its statements is not.

STEP 2 — move the three LIVE reads through the proxy. In frontend/api/supabase-proxy.js:68, add "user_profiles", "user_favorites", "user_watchlist" to SELECT_TABLES (all three are already in ALLOWED_TABLES at :54). The SELECT branch at :340-352 is already filter-required, order-pinned and row-capped at SELECT_MAX_ROWS=200 — but it hardcodes `order=created_at.asc`, so confirm each table has created_at (000_base_schema.sql does define it) or make the order column per-table. Add a `proxySelect({table, match})` export to frontend/src/nakamigos/lib/supabaseProxy.js alongside proxyWrite. Then repoint userdata.js:200 (getProfile), :283 (syncFavorites), :355 (syncWatchlist) to it, keeping the existing localStorage fallback and the SYNC_STATUS discriminated-result shape the file already uses. NOTE: getProfile reads OTHER wallets' profiles too (EditProfile.jsx:65 is self, but profile display is not), so decide explicitly whether user_profiles stays publicly readable — if it does, it should be REMOVED from the 015 §2 list rather than proxied.

STEP 3 — the votes aggregate view, as a NEW file `frontend/supabase/migrations/022_vote_tally_view.sql` (022 is the next free number; 021_commerce.sql is the highest). Body: `CREATE OR REPLACE VIEW public.vote_tallies WITH (security_invoker = false) AS SELECT week, token_id, count(*)::int AS votes FROM public.votes GROUP BY week, token_id;` then `GRANT SELECT ON public.vote_tallies TO anon, authenticated;` and end the file with `NOTIFY pgrst, 'reload schema';` plus the ledger insert pattern from supabase/MIGRATIONS.md ('INSERT INTO public.schema_migrations (filename, note) VALUES ('022_vote_tally_view.sql', …) ON CONFLICT DO NOTHING'). security_invoker=false is the whole mechanism — say so in a comment so nobody 'fixes' it to satisfy a Supabase linter. Then repoint getWeekVotes (userdata.js:522) to `.from("vote_tallies").select("token_id, votes").eq("week", week)` and sum from the `votes` column rather than counting rows. getUserVote (userdata.js:551) reads the caller's OWN row and must go through the proxy (add "votes" to SELECT_TABLES) or get a new 'Owner reads own vote' policy — it cannot use the view, which has no wallet column by design.

STEP 4 — the drops themselves go in `023_drop_permissive_reads.sql`, NOT by uncommenting 015. One DROP POLICY IF EXISTS per table you actually decided on, each with a one-line comment naming the read path that now covers it. Leave any table you did not build a replacement read for out of the file entirely.

STEP 5 — add the tripwire. frontend/src/nakamigos/userdataWriteHonesty.test.js already guards against direct anon-key WRITES in userdata.js; extend it (or add a sibling) to fail if a direct anon-key `.from(<owned table>).select(` reappears once step 2 lands. Without it this regresses the first time someone adds a read.

VERIFY: `cd frontend && npx tsc -b --noEmit && npm run lint && npx vitest run`. api/__tests__/rlsCoverage.test.ts parses every migration and will react to new CREATE POLICY / view statements — read its failure text rather than editing its expectations. scripts/supabase-restore.test.mjs enforces unique migration numbers, so 022/023 must not collide.

## Line 72 — Release identity: first semver tag so release.yml runs

**NOT_STARTED** · buildable: NO_NEEDS_OPERATOR · ~1.5 h

**Evidence.** `git tag -l` -> exactly 3 tags, none semver: `audit-pass-6`, `audit-remediation`, `backup/crazy-nobel-pre-rebase`. `gh release list` -> empty. .github/workflows/release.yml:3-6 triggers only on `push: tags: v*.*.*`, so it has never run. frontend/package.json:4 is `"version": "0.0.0"`. CHANGELOG.md:8 has only `## [Unreleased]`, whose text says "a tagged release will cut from here once Wave 0 redeploys are complete".

**What is left.** Everything. No tag, no release, no version number anywhere. Plus a latent defect in release.yml that will corrupt the very first release's notes (see risk).

**Risk.** VERIFIED LIVE TRAP, fix this before anyone tags anything: release.yml:71 runs `PREV=$(git describe --tags --abbrev=0 "${TAG}^")` with no `--match`. `git describe --tags --abbrev=0 HEAD` today returns `audit-pass-6`, and `git ls-remote --tags origin` confirms that tag is on origin. So the FIRST semver release would take the `if [ -n "$PREV" ]` branch and emit `git log audit-pass-6..v0.1.0` — hundreds of commits of audit-era history — instead of the intended "Initial release." Second risk: the act of pushing a tag makes release.yml publish a public GitHub Release with `draft: false` (release.yml:110). That is a publish, not a build, which is why this is operator-gated.

**How to do it.**

Do the code slice; hand the tag push to the operator.

CODE (landable now, ~1.5h):
1. .github/workflows/release.yml:71 — change `git describe --tags --abbrev=0 "${TAG}^"` to `git describe --tags --abbrev=0 --match 'v*.*.*' "${TAG}^"`. Without this the first release's notes are wrong and nobody will notice until it is public. This is the single highest-value line in the item.
2. CHANGELOG.md — cut a `## [0.1.0] - <date>` section from the `[Unreleased]` content at :8, leaving `[Unreleased]` empty above it. Keep the 2026-07-30 trunk-correction note where it is; it is history, not release notes.
3. frontend/package.json:4 — `"0.0.0"` -> `"0.1.0"`. Nothing reads it today, so this is purely so the tag and the tree agree.
4. Add docs/RELEASING.md: which branch releases cut from (mvp-launch, NOT main — see the CHANGELOG correction at :12-20), the tag format release.yml accepts (`^v[0-9]+\.[0-9]+\.[0-9]+(-(rc|beta|alpha|pre)\.[0-9]+)?$`, release.yml:45), and the fact that `workflow_dispatch` needs the tag to already exist on origin.
5. Optional guard, cheap and in this repo's style: a vitest in frontend/src/test/ asserting release.yml's `--match` flag is present and that CHANGELOG's newest version heading matches package.json's version. This repo has shipped three gates that could not fail; a release path nobody has ever executed is the same shape.

OPERATOR (do NOT do this yourself): `git tag -a v0.1.0 -m "..." && git push origin v0.1.0`. Then `gh run list --workflow=release.yml` should show one run, and `gh release view v0.1.0` should show notes reading "Initial release." — if it instead lists commits since `audit-pass-6`, step 1 was not applied.

VERIFY the code half: `cd frontend && npx tsc -b --noEmit && npm run lint && npx vitest run`, and `git describe --tags --abbrev=0 --match 'v*.*.*' HEAD` should exit non-zero (no semver tag yet) — which is the behaviour that makes the notes say "Initial release."

## Line 123 — Server tests for `_lib/launch-radar.js`, `notifyBirth.ts`, `VotePowerOracle`

**NOT_STARTED** · buildable: YES · ~8 h

**Evidence.** All three are untested; `_lib/heat.js` really is done as the line says (frontend/api/_lib/__tests__/heat.test.js). (1) frontend/api/_lib/launch-radar.js (129 lines) has no test — `git ls-files frontend/api/_lib/__tests__/` returns exactly airdrop, alerts, botLink, heat, launch-cohort, logSafe, proxy-schemas-failclosed, proxy-schemas, ratelimit. (2) frontend/src/lib/launcher/notifyBirth.ts (107 lines) has no test file — `git ls-files | grep -i notifybirth` returns only the source — while being live on two launch paths, frontend/src/pages/LaunchPage.tsx:461 and SolanaLaunchPage.tsx:393. (3) contracts/src/lib/VotePowerOracle.sol (124 lines) has no direct test — `grep -rln VotePowerOracle contracts/ --include=*.sol` returns only source files: CommunityGrants.sol, GaugeController.sol, MemeBountyBoard.sol, TegridyRestaking.sol, VoteIncentives.sol and the library itself. No file under contracts/test/ names it.

**What is left.** All three. UNKNOWN, stated as such: I did not verify whether the four consumer suites (GaugeController.t.sol, VoteIncentives.t.sol, CommunityGrants.t.sol, MemeBountyBoard.t.sol, plus CommunityGrants_RealStakingIntegration.t.sol) happen to exercise the library's restaking-fallback path indirectly. The search I ran was a filename+identifier grep for `VotePowerOracle` across contracts/, which proves no test names it, not that no test reaches it.

**Risk.** Each of the three has a specific, non-obvious property that a generic happy-path test will miss, and writing the generic test is worse than writing none because it makes the gap look closed. notifyBirth: its whole reason for existing is that `birth_block` is CHAIN TRUTH and must never be approximated — notifyBirth.ts:9-15 says a notify whose block cannot be read is QUEUED WITHOUT BEING SENT rather than sent with a fabricated block. A test that only asserts the happy send would let a future refactor start guessing block numbers and mis-date every token's heat forever. launch-radar: its stated honesty boundary (launch-radar.js:10-18) is that it returns MARKET-WIDE pools and must never feed the Tegridy cohort surfaces, which would fabricate a track record. VotePowerOracle: it exists solely because a user who restakes is otherwise silently disenfranchised across five governance consumers (the GOV-ECON-01 fix documented at VotePowerOracle.sol:24-40) — the additive staking+restaking sum IS the test.

**How to do it.**

Three independent PRs; do them in this order (highest consequence first).

(1) contracts/test/VotePowerOracle.t.sol — Foundry. Assert the property the library was written for, not its arithmetic: a user with staking power S and restaking power R reads S+R, and critically a user whose NFT has been deposited into TegridyRestaking (so `staking.votingPowerOf(user)` is 0 and a 0-checkpoint is written at deposit time) still reads non-zero. Cover both entrypoints — the live read and the historical `…AtTimestamp` one — because the timestamp path is what gauge epochs and bribe claims settle on. Mirror the mocking style in contracts/test/CommunityGrants_RealStakingIntegration.t.sol. Read VotePowerOracle.sol:24-40 first; it names the exact three reads that go to zero. Verify: `cd contracts && forge test --match-path test/VotePowerOracle.t.sol -vvv`.

(2) frontend/src/lib/launcher/notifyBirth.test.ts — vitest. The load-bearing cases: (a) EVM path where the receipt read succeeds -> six fields correct, `birth_block` from the receipt; (b) EVM path where the receipt read FAILS or times out -> the birth is ENQUEUED and NOT sent, and no fabricated block appears anywhere in the payload; (c) Solana path where `slot` is supplied by the caller; (d) Solana path with no slot. Inject `publicClient` and `origin` — the interface at notifyBirth.ts:21-34 exposes both specifically for tests. Mock `./birthNotify` (`enqueueBirth`/`flushBirthQueue`) and assert which one was called, since that distinction IS the honesty property. Verify: `cd frontend && npx vitest run src/lib/launcher/notifyBirth.test.ts`.

(3) frontend/api/_lib/__tests__/launch-radar.test.js — node/vitest, copy the harness shape from the sibling frontend/api/_lib/__tests__/launch-cohort.test.js, which tests the closest-shaped adapter. Cover: CORS origin allowlist (launch-radar.js ALLOWED_ORIGINS, including that a non-listed origin is refused), rate limiting via the mocked `checkRateLimit`/`checkGlobalLimit`, the MAX_PAGES=2 bound, the `readBoundedText`/MAX_RESPONSE_BYTES cap on a hostile oversized upstream body, and an upstream 429/5xx surfacing as a clean error rather than an empty success. Then add the honesty assertion the file's own header demands: this adapter is a thin pipe and must not normalise or reshape — the parse lives in src/lib/launcher/discovery.ts.

BEFORE WRITING (3), check the runner wiring: frontend/src/test/vitestCollection.test.ts asserts every test file has a slice, so a new file in an unregistered directory can fail collection or, worse, be collected by nothing. Confirm frontend/api/_lib/__tests__/ is already a covered slice — heat.test.js lives there, so it should be.

VERIFY ALL: `cd frontend && npx tsc -b --noEmit && npm run lint && npx vitest run`, plus `cd contracts && forge test`.

## Line 136 — Gasless/paymaster pilot (EIP-7702 + Pimlico/Alchemy/Coinbase)

**NOT_STARTED** · buildable: NO_NEEDS_EXTERNAL · ~4 h

**Evidence.** Nothing exists. `grep -rni "paymaster|pimlico|7702|4337" frontend/src --include=*.ts --include=*.tsx` returns only prose: src/lib/eip5792.ts:4, :37, :48 (comments explaining that atomicRequired triggers the EIP-7702 upgrade prompt), src/hooks/useOneClickStake.ts:15 ("needs live-wallet QA (a smart-account / 7702…)"), and src/lib/docsAddressTruth.test.ts:95 / docsClaimHonesty.test.ts:305 (about the treasury signer's delegation designator — unrelated). Two false-positive families excluded by hand: contracts/lib/** vendored forge-std, and numeric substrings inside src/lib/launcher/solana/curve/curveVectors.fixture.ts. There is no `frontend/src/lib/gas/` directory, no `smartAccount.ts`, and no gas resource in the API — `ls frontend/api/` shows aggregator.js, alchemy.js, analytics.js, etherscan.js, opensea.js, orderbook.js, solrpc.js, supabase-proxy.js, auth/, v1/, _lib/, and `grep -rn "resource=gas|paymaster" frontend/api/*.js frontend/api/_lib/*.js` returns nothing. The written plan for this exists at docs/BATTLE_PLAN.md:885-889 (item #48) and its prerequisite track at :136-144 (F6), which states plainly "There are no embedded wallets, no account abstraction, no paymaster, no session keys… anywhere in frontend/src". Confirmed still true.

**What is left.** The pilot itself is blocked: a hosted paymaster (Pimlico/Alchemy/Coinbase) needs an account, an API key, and a FUNDED on-chain deposit before a single sponsored transaction can execute — and BATTLE_PLAN.md:889 binds the sponsorship budget to house law ("may not spend capital it has not earned", capped monthly at ≤5% of prior-month realized fee revenue read from RevenueDistributor), which is an operator decision, not a code one. THE GENUINELY LANDABLE SLICE, needing no key and no deploy: (1) the ERC-7677 capability plumbing — `SendCallsParams` at src/lib/eip5792.ts:30-41 has NO `capabilities` field, so the wrapper at :90 physically cannot carry a `paymasterService` payload; add `capabilities?: Record<string, unknown>` and thread it through, and add a `paymasterCapability(caps, chainIdHex)` reader beside `isAtomicBatchSupported` at :53 using the same case-insensitive `lookupChain` helper at :63; (2) `frontend/src/lib/gas/sponsorBudget.ts` — a pure policy module (per-user daily cap, monthly ceiling as a fraction of realized revenue, eligibility) that returns a hard "sponsorship off" verdict when no budget is configured, with the whole cap arithmetic unit-tested against fixtures; (3) `frontend/src/lib/gas/paymaster.ts` — pure builders for the ERC-20-gas and sponsored-gas capability payloads, byte-tested the way launchBuy.ts pins its encodings, with zero network calls.

**Risk.** Two traps. FIRST, the honesty trap this repo enforces everywhere: a `capabilities` field that is threaded through but never populated must not produce a surface that says "gasless" — follow the LaunchBuyPanel precedent (LaunchBuyPanel.tsx:211-217) of telling the user plainly that the path is unavailable rather than offering a degraded version of it. `sponsorBudget.ts` must default CLOSED (no env → sponsorship off), never open. SECOND, do not weaken `atomicRequired`. A paymaster-sponsored batch is still a batch; useOneClickLaunchBuy.ts:61-65 documents why atomicRequired:true is load-bearing (a non-atomic execution can land the approve without the swap, stranding an allowance). Adding a capabilities payload must not become an excuse to relax that flag to widen wallet support.

**How to do it.**

Leave the plan line UNTICKED and REWRITE it to name its blocker, so the next reader does not re-derive it: change docs/YEAR_PLAN_2026_2027.md line 136 to "- [ ] `[code]` Gasless/paymaster pilot (EIP-7702 + Pimlico/Alchemy/Coinbase) — `[ext]` blocked: needs a paymaster account, an API key and a funded deposit; `[op]` blocked: the sponsorship budget is house-law-capped at ≤5% of prior-month realized revenue (BATTLE_PLAN #48, `docs/BATTLE_PLAN.md:885-889`). The offline half — ERC-7677 capability plumbing in `src/lib/eip5792.ts` plus a fail-closed `src/lib/gas/sponsorBudget.ts` — is landable now." IF AN AGENT IS TOLD TO LAND THE OFFLINE SLICE ANYWAY, here is the whole job. Read src/lib/eip5792.ts end to end first — it is 103 lines and every design decision in it is commented. Edit 1: add `capabilities?: Record<string, unknown>` to `SendCallsParams` (:30-41) and pass it inside the params object at :90-102, ONLY when defined — an unconditional `capabilities: undefined` key changes the JSON-RPC payload some wallets validate strictly. Edit 2: add `export function paymasterCapability(capabilities: unknown, chainIdHex: string): unknown` next to `isAtomicBatchSupported` (:53), reusing the existing `lookupChain` helper (:63) so hex-casing behaviour stays identical; return the `paymasterService` sub-object or undefined, and NEVER infer support from its mere presence — ERC-7677 wallets advertise `{supported: boolean}`. Edit 3: create `frontend/src/lib/gas/sponsorBudget.ts` as a PURE module: it must take the budget inputs as arguments (monthly ceiling, spend-to-date, per-user daily cap, the user's spend today) and return a discriminated verdict `{ok:true, remainingWei} | {ok:false, reason}` — no `import.meta.env` reads inside the arithmetic, so the tests need no env. Have the env read live in one thin exported accessor that returns null when unset, and make null mean OFF. Edit 4: create `frontend/src/lib/gas/paymaster.ts` with pure payload builders and pin them with byte-level assertions, following the precedent in src/lib/launcher/launchBuy.ts (its whole header explains why encodings get pinned by independently-derived tests rather than round-tripped through their own encoder). DO NOT create a hook or a UI surface in this slice — src/hooks/hooksAreMounted.test.ts:87-92 fails any hook that no non-test module imports, and there is nothing honest to mount it on until a paymaster exists. Pure lib modules are exempt from that guard, which is exactly why the slice is drawn at the lib boundary. VERIFY: `cd frontend && npx vitest run src/lib/gas src/lib/eip5792 src/hooks/useOneClickStake.test.ts src/hooks/useZapRun.test.ts && npx tsc -b --noEmit && npm run lint` — the two hook tests are there to prove the `SendCallsParams` change did not alter the payload the three existing consumers send.

## Line 139 — "Towelie" insights rules engine (free, no-API half)

**NOT_STARTED** · buildable: YES · ~11 h

**Evidence.** What exists under the Towelie name is a static FAQ bot, not an insights engine. frontend/src/lib/towelieKnowledge.ts:1-3 says so in its own header: 'Towelie's Q&A bank. Plain keyword-overlap matching — no LLM, no API.' It is 432 lines of hand-written KNOWLEDGE_BASE entries keyed on question keywords; frontend/src/components/TowelieAssistant.tsx (475 lines) + hooks/useTowelie.ts (103 lines) render it, mounted via components/layout/AppLayout.tsx:117 (TowelieProvider) and :181 (TowelieAssistant). Nothing reads the user's own state and derives an observation from it: `grep -rln "insight" frontend/src --include=*.ts --include=*.tsx` returns ZERO files. The 'LLM assistant stays flag-gated' clause describes something that does not exist to gate — grepping llm|openai|anthropic|VITE_TOWELIE across frontend/src returns no matches; docs/BATTLE_PLAN.md:1048 describes that assistant as future work on an F5 host that is not built.

**What is left.** The whole rules engine. An insights engine takes the user's live state — portfolio positions, a scan outcome, a Heat tier, alert evaluations — and emits derived, dated, sourced observations ('your LP position is unboosted and a lock would raise it', 'this token's top-holder share moved 8pts since your last scan'). Nothing in the repo does that.

**Risk.** The danger is generating a claim the underlying reads do not support — this repo's whole honesty regime is built against exactly that. Every insight must carry the field it derived from and must NOT fire when the source read failed. Note the shape src/lib/alerts/evaluate.ts already established: four verdicts, where 'quiet' and 'could not look' are different facts. An insights rule that treats an unreadable source as 'nothing to report' is the same defect in a new costume. Second risk: scope creep into the LLM half. The plan says the free no-API half; keep it deterministic.

**How to do it.**

Build it as a pure module, not as a component. This is the highest-leverage genuinely-buildable item in this cluster: every input already exists as client-side TypeScript and no key, host or migration is needed.

CREATE frontend/src/lib/insights/ with rules.ts (rule definitions), derive.ts (the pure evaluator), and co-located tests. COPY THE SHAPE OF frontend/src/lib/alerts/evaluate.ts — read it first; it is the closest sibling and it already solved the hard part. Each rule takes a typed snapshot and returns one of: `fires` (with a human sentence, the exact source field, and a timestamp), `quiet` (read it, nothing to say), or `unreadable` (could not read the source — NEVER rendered as quiet). Rules must be pure functions of their input with no fetching inside them.

INPUTS THAT ALREADY EXIST — wire to these, do not write new readers: frontend/src/hooks/usePortfolioSources.ts (per-source availability, and it already reports PARTIAL rather than summing over a gap), frontend/src/lib/scanner/scanner.ts + lib/detection/ (scan outcome and metrics), frontend/src/lib/heat/heatClient.ts (tier), frontend/src/lib/alerts/evaluate.ts (evaluations). Every one of these already self-gates; your job is to not undo that.

SURFACE: render into the existing TowelieAssistant bubble via the queue in hooks/useTowelie.ts rather than adding a new chrome element. Insights are proactive and Q&A is reactive — keep them visually distinguishable, and make an insight's source field inspectable (the reader must be able to see what it was derived from).

EXPLICITLY OUT OF SCOPE: the LLM path. No API call, no proxy route, no env flag for one. frontend/api/ is at 11 of 12 functions and there is no slot for an LLM proxy; docs/BATTLE_PLAN.md:1048 puts that on an unbuilt F5 host. If you add a flag at all, add it OFF and with nothing behind it.

VERIFY: from frontend/ run `npx tsc -b --noEmit && npm run lint && npx vitest run`. Write the tests first — for each rule, assert all three verdicts, and assert specifically that a failed source read produces `unreadable` and renders nothing rather than silence-that-looks-like-good-news.

## Line 145 — Explorer/afterlife enriched from the indexer: real graduation rates + fee histories on fact sheets

**NOT_STARTED** · buildable: YES · ~14 h

**Evidence.** The indexer cannot answer this today: `grep -i 'airlock|doppler' indexer/ponder.config.ts` returns ZERO hits. The contracts block (ponder.config.ts:561-673) subscribes only to TegridyStaking, RevenueDistributor, SwapFeeRouter, TegridyPair (via factory), POLAccumulator_Pause/_Business, TegridyFactory_Governance, TegridyTWAP, TegridyStakingAdmin, SwapFeeRouterAdmin — the Doppler/Airlock launch lifecycle, the only source of graduation events, is not indexed at all. On the frontend side frontend/src/lib/launcher/factSheet.ts exports LaunchTier, ResidualPower, LiquidityDisclosure, FeeConstitutionLine, LaunchPricingDisclosure, VestingSchedule, LaunchFactSheet, GateCheck — no graduation-rate field, no fee-history field, no indexer import. What DOES exist is a per-token graduation STATUS from a different source: frontend/src/lib/launcher/tokenDossier.ts:209 GraduationKind = 'graduated'|'not-graduated'|'cannot-verify', read from Doppler's StreamableFeesLocker and rendered at frontend/src/pages/LaunchTokenPage.tsx:499-512. The cohort list comes from frontend/src/lib/launcher/cohortLogSource.ts -> /api/aggregator?resource=launch-cohort (frontend/api/_lib/launch-cohort.js:31, Airlock 0xde3599a2ec440b296373a983c85c365da55d9dfa from block 21,000,000), also not the indexer.

**What is left.** Everything the line names. A cohort graduation RATE (graduated / launched, per cohort) does not exist anywhere — only per-token status. Fee HISTORY (a time series per launch) does not exist: no table, no query, no fact-sheet field. And the indexer has no Airlock/Doppler subscription to derive either from.

**Risk.** Highest-consequence item on this list because its output is written on-chain and cannot be retracted. A graduation rate derived from a partially-synced indexer, or a 0 standing in for 'unknown', becomes a permanent published claim. Secondary: the Airlock ABI has been hand-rolled wrong in this repo before (capture-airlock-selectors.mjs exists because of it), so an unverified event signature yields an empty table that reads as 'no launches graduated' — a fabricated failure record for other people's tokens.

**How to do it.**

Three layers; the first two are authorable dark, the third is where honesty is won or lost.

LAYER 1 — indexer (no host needed, this is just authoring). In indexer/ponder.config.ts add an Airlock subscription: address 0xde3599a2ec440b296373a983c85c365da55d9dfa (take it from frontend/api/_lib/launch-cohort.js:31, which is the address already in production use — do not source it from memory), startBlock 21_000_000 (same file, :45). Note this start block is ~4M blocks BEFORE the 25263328 every other subscription uses, so it materially lengthens first-boot backfill — say so in the config comment. Subscribe to Airlock `Create` (the topic0 constant is in launch-cohort.js) plus the migrate/graduate event from the Doppler migrator. Add two tables to indexer/ponder.schema.ts: `launchCreated` (asset, pool, creator, timestamp, txHash) and `launchGraduated` (asset, v4PoolId or pool, timestamp, txHash). Fee history: the integrator-fee surface already has a hand-rolled ABI in the frontend (see frontend/scripts/capture-airlock-selectors.mjs, whose header records that a hand-rolled Airlock fragment was WRONG once) — capture the fee events from that path rather than inventing signatures.

LAYER 2 — frontend reader. New frontend/src/lib/launcher/graduationStats.ts: a query over launchCreateds/launchGraduateds returning {launched, graduated, ratePpm, windowStart, windowEnd}, going through hooks/useIndexedQuery.ts so it inherits the ready-gate. Add `graduationCohort?: {...}` and `feeHistory?: [...]` as OPTIONAL fields on LaunchFactSheet in factSheet.ts.

LAYER 3 — THE TRAP, and it is a legal-shaped one. factSheet.ts's header says a fact sheet is a DISCLOSURE, not an endorsement, and frontend/src/lib/launcher/attestation.ts folds the sheet's canonical JSON into `disclosuresDigest`, which is published ON-CHAIN and is PERMANENT. Two consequences: (a) a graduation rate computed from a backfilling indexer would be committed forever as a wrong number, so the new fields must be OMITTED entirely when the hook reports unavailable/backfilling — never defaulted to 0, and never included in the canonical JSON in that state. The file already has this pattern twice, as `readable?: boolean` on ResidualPower and LiquidityDisclosure, each with a comment about a `false` that meant 'nobody asked'; follow it exactly. (b) A cohort rate is a statement about OTHER people's tokens appearing on THIS token's sheet — keep the wording factual and scoped ('N of M launches in this cohort have graduated'), never comparative or reassuring.

VERIFY: `cd indexer && npx tsc -p tsconfig.json --noEmit --skipLibCheck`; from frontend/ `npx tsc -b --noEmit && npm run lint && npx vitest run`. Add a test asserting the canonical disclosures JSON is byte-identical to today's when the new fields are absent — that is what proves no already-published digest changes meaning.

## Line 155 — Keeper for `migrate_to_amm`; Jupiter DEX-integration submission

**NOT_STARTED** · buildable: NO_NEEDS_EXTERNAL · ~6 h

**Evidence.** frontend/scripts/tegridy-launch-operator.mjs command dispatch at :1191-1205 handles exactly: status, derive, check-config, init-global, update-global, create-amm-config, help. There is no `migrate` command. docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md:489 is a SCHEDULED finding titled 'No operator command and no write-client method exists for migrate_to_amm', with the failure mode and a precise recommendation at :491-493. The instruction builder `migrateToAmmIx` does exist (frontend/src/lib/launcher/solana/curve/ix.ts:325+, tested at ix.test.ts:282-460) — but the finding explicitly says reaching for it directly is wrong. No keeper process exists anywhere: `find . -type d -iname '*keeper*'` returns nothing, and the only 'keeper' strings in frontend/api are in aggregator.js and _lib/commerce.js, unrelated.

**What is left.** Everything. Both halves. The keeper/operator command is unwritten; the Jupiter submission has no artifact and no prerequisite met.

**Risk.** The permission-PDA derivation is still an inference, not a read: program.ts:410-417 lists 'the permission PDA is keyed by `migration_authority`' under UNVERIFIED. A `migrate` command that hardcodes the wrong seed fails as a constraint error naming an account the operator never typed — the exact confusing-revert class this finding exists to prevent. Keep it in the UNVERIFIED list; do not let writing the command promote the inference to a fact.

**How to do it.**

The Jupiter half is dead on arrival and should be recognised as such: docs/SOLANA_OWN_VENUE_SCOPE.md:68-69 makes Jupiter DEX-integration submission step 8 of the mainnet runbook, i.e. it requires a deployed AMM with live pools that pass Jupiter's depth test. Both program ids are closed and spent (see line 150's evidence), so there is nothing to submit. Do not attempt it, do not draft the submission — an application naming a closed program id is worse than none.

The keeper half IS authorable today, against a program that does not yet exist, and that is fine — it is exactly the 'write the migration file, don't run it' case. Add a `migrate` command to frontend/scripts/tegridy-launch-operator.mjs following the recommendation the audit already wrote at docs/SOLANA_PROGRAM_FINDINGS_2026_08_15.md:493, verbatim: (a) refuse BEFORE touching any key when `global.cp_swap_program == 0` or `global.amm_config == 0` (this is the AmmNotConfigured/6015 condition the script already documents at :37, :68, :475, :1092), when `curve.complete` is already true, or when `curveLamports - rentExempt < target + reserve`; (b) prepend `ComputeBudgetProgram.setComputeUnitLimit(MIGRATE_COMPUTE_UNITS)` — migrate_to_amm measured 264,128 CU against Solana's 200,000 default per solana/tegridy-amm/programs/tegridy-launch/MIGRATE_DESIGN.md:220-239, so omitting this fails with 'Program failed to complete', which reads as a program bug; (c) build accounts from the same list the Anchor migration rehearsal uses (solana/tegridy-amm/tests/tegridy-launch-migration.test.ts), NOT from a fresh hand-derivation.

Mirror the existing dry-run discipline: every other command in this script prints without `--send` first. Follow `cmdCreateConfig`'s pattern (the one 21835d1d hardened) — print the resolved plan, require an explicit acknowledgement flag for anything dangerous.

Sequencing trap: `migrateToAmmIx` on trunk targets the POST-removal account list (it gained `creator` and a `permission` PDA — program.ts:374-378). If line 150's Rust deletion has not merged yet, a `migrate` command built on it will not match the program in solana/ on trunk. Land line 150 first, or write the command against the post-removal shape and mark it clearly as post-removal-only in the same way program.ts:361-370 does.

Verify: from frontend/, `npx vitest run` with a new test that asserts each refusal fires before any signer is touched, and that the transaction's first instruction is the compute-budget one. There is no on-chain verification available and none should be faked.

## Line 161 — Liquid locker (stTOWELI) design spike only — build waits for pool depth

**NOT_STARTED** · buildable: YES · ~4 h

**Evidence.** `grep -rln 'stTOWELI|stToweli|liquid locker|LiquidLocker'` over docs/, contracts/src, frontend/src returns exactly two files: docs/USER_VALUE_ROADMAP.md and docs/YEAR_PLAN_2026_2027.md — i.e. the plan line itself and the one paragraph it derives from (docs/USER_VALUE_ROADMAP.md:91). No design doc, no contract, no test, no ADR. Nothing in contracts/src, nothing in frontend/src.

**What is left.** The entire design spike. Note the line already scopes itself: 'design spike ONLY — build waits for pool depth'. So the deliverable is a document, and the document does not exist.

**Risk.** The failure mode is scope creep into a build — a multi-contract subsystem (wrapper + peg pool + vote replication + oracle) that the line explicitly defers. A second, subtler risk: writing the memo as advocacy. USER_VALUE_ROADMAP.md:91 calls this 'the correct, most-proven cure', which is an easy sentence to inherit uncritically; the 2024 cvxCRV evidence in the same paragraph cuts the other way.

**How to do it.**

This is the clearest unambiguous YES in the whole cluster: the deliverable is explicitly a design document, needs no keys, no deploy, no third party, and no capital. Write docs/LIQUID_LOCKER_DESIGN_SPIKE.md.

Source material, and do not go past it: docs/USER_VALUE_ROADMAP.md:91 is the only prior art in the repo and it already contains the hard parts — the Convex/Aura/Stake DAO pattern, the lock-vs-liquidity-vs-governance trilemma framing, the Stake DAO vote-replication variant (holders stay liquid AND keep voting), and the three preconditions: a funded peg pool, fee buyback, and a peg-aware oracle. It also carries the number that should dominate the memo: cvxCRV traded 50-70% under peg during 2024 stress. Build the spike around that, not around the upside.

Structure it as a decision memo, matching docs/BASE_L2_GO_NO_GO.md — which is the repo's best example of this genre and was written to be decided FROM: provenance of every number, what it costs, what it earns, what it risks, what must be true first, a recommendation with its reasoning, and an 'if the answer becomes yes' section. Copy that skeleton.

The specific things the spike must settle, because they are what makes this dangerous rather than merely large: (a) the depeg risk is STRUCTURAL and PERMANENT, not a launch risk — say plainly that stTOWELI must never be accepted as naively-priced collateral in TegridyLending or TegridyNFTLending, and name the oracle requirement; (b) name the pool-depth number that gates the build, derived from the same TWAP-floor arithmetic the plan uses at its Q1 'First revenue' lane (~$3.9k for a 1.0 WETH TWAP floor), not asserted; (c) state the interaction with TegridyPositionMarket (line 160) — a liquid locker and a position secondary market are competing answers to the SAME problem (pre-maturity exit), and the market already shipped while the locker has not started. The spike should say whether the locker is still wanted given that, and if the answer is no, say so — a spike that recommends not building is a successful spike.

Do not write any Solidity. Do not create contracts/src/stToweli.sol. The line says design spike only and the build gate (pool depth) is nowhere near met.

Verify: no CI gate applies to a markdown file; the verification is that the memo can be decided FROM without opening another document, which is the standard docs/BASE_L2_GO_NO_GO.md sets.

## Line 185 — Seasons-that-pay loyalty (revenue-funded, H.33)

**NOT_STARTED** · buildable: NO_NEEDS_OPERATOR · ~6 h

**Evidence.** The scaffolding exists; the 'that-pay' half does not. frontend/src/lib/season.ts (46 lines) computes only a season PHASE from the CURRENT_SEASON window — its docblock says it exists so an expired window renders as expired rather than as a permanent '0d left'. frontend/src/lib/pointsEngine.ts (267 lines) plus tests is the points accrual. There is no frontend/src/lib/seasons/ directory, no SeasonsPage.tsx, no quests.ts, no redemption.ts, no frontend/api/_lib/seasons.js. WORKORDER_V2.md:154 is explicit: 'H.33 seasons-that-pay — retag 🟣+⚙️: needs server-side derivation (indexer) + on-chain-slice-only formula (exclude streaks/visits) + realized-revenue funding; not ⚙️-ready today.' docs/BATTLE_PLAN.md:911 (#51) specifies the full build: a Supabase `quests` table with predicates, an accrual job verifying each claimed completion against indexer data, a `season_points` ledger with RLS, and a lazy `?resource=seasons` leg in frontend/api/aggregator.js.

**What is left.** Everything that makes it 'pay'. Three hard prerequisites, none met: (a) server-side derivation requires the indexer and a Supabase quests/season_points schema with RLS — the repo's own login/RLS migration chain (015 → 014 → 016 → 013) is still unrun per plan lines 133-137; (b) 'revenue-funded' requires realized revenue, and the first staker distribution epoch in protocol history has not happened (plan Q1 'First revenue' lane); (c) the points formula must be reduced to an on-chain slice only, excluding streaks and visits.

**Risk.** The formula is the whole risk surface. A points system that counts streaks or visits is a points system that pays out to whoever scripts a browser, and this one is funded from realized revenue — i.e. from stakers. Building the pretty parts (SeasonsPage, quest cards) before the formula is settled makes the formula harder to change later, because by then it has a UI shaped around it.

**How to do it.**

Blocked, but for a specific reason worth stating rather than hand-waving: this feature pays real money out of revenue that does not yet exist, and its ledger lives in Supabase tables behind a migration chain the operator has not run. Do not build the payout path.

The landable slice, today, no keys and no database: write the on-chain-slice-only points formula as a pure module, frontend/src/lib/seasons/onchainPoints.ts, with vitest coverage. WORKORDER_V2.md:154 names the exact constraint — the formula must exclude streaks and visits, because those are client-observable and therefore forgeable, and derive only from indexed on-chain actions. Extract the on-chain-derived subset of frontend/src/lib/pointsEngine.ts into it, keeping that file's stated security posture (on-chain/indexed data authoritative, localStorage a paint cache only) and deleting the rest of the surface from the new module rather than carrying it forward. The unit under test should be a deterministic function from a list of indexed actions to a point total — no fetch, no storage, no clock beyond an injected `now`.

That module is the piece that has to be right and is the piece nobody can build later under time pressure once real money is attached to it. Everything else on H.33 (quest definitions, the accrual job, the RLS ledger, the redemption path) waits on the operator.

Do NOT create a Supabase migration file for `quests` / `season_points` speculatively. This repo's migration chain has an ordering hazard the plan calls out explicitly at line 136 ('Never run 008 after 014; never run 004 as a unit'), and adding an unnumbered migration to a chain that is mid-surgery is how the renumbering collision at commit 33850b8c happened.

Also rewrite plan line 185 so its blockers are visible on the line itself rather than only in WORKORDER_V2: '- [ ] `[op]`+`[code]` Seasons-that-pay (H.33) — blocked on realized revenue and on the Supabase/RLS chain; the on-chain-slice-only formula is the buildable half.'

Verify: from frontend/, `npx tsc -b --noEmit && npm run lint && npx vitest run`.

## Line 191 — Annual security review + chaos drill · truthful `GOVERNANCE.md` · roadmap restated for year two

**NOT_STARTED** · buildable: NO_NEEDS_OPERATOR · ~7 h

**Evidence.** Four parts, none done. CHAOS DRILL: docs/INCIDENT_RESPONSE.md:195-200 prescribes a quarterly tabletop, a bi-annual live drill and a post-deploy smoke, and mandates that results be tracked in docs/drills/YYYY-MM-DD.md — `ls docs/drills` → 'No such file or directory'. Zero drills have ever been recorded. docs/UNFINISHED_INVENTORY_2026_08_13.md:82 adds that eight of ten contact-tree cells in §9 are 'TBD', including the PauseGuardian hot-key address. GOVERNANCE.md: docs/GOVERNANCE.md footer reads 'Last updated: 2026-04-17' and contains at least three claims that are false against source today — see remaining. ANNUAL SECURITY REVIEW: the newest security artifact is docs/SLITHER_TRIAGE_2026_08_22.md, whose own header at :7-14 says 'The adversarial refutation pass never ran… this document is evidence, not a decision. Do not apply suppressions from it until the refutation has run.' The dated audit docs in contracts/ stop at 2026-06-02. ROADMAP RESTATED: ROADMAP.md:85 still asserts 'Status: not started. No memo, no Base deploy scripts' — false since 710e4a0e.

**What is left.** All four. The GOVERNANCE.md falsehoods, verified against source: (1) '§Guardian roles — There is currently no separate `guardian` role for fast emergency response. Guardian introduction is planned alongside the multisig migration' — contracts/src/base/PauseGuardian.sol exists and is inherited by FOURTEEN contracts (AirdropFactory, POLAccumulator, RevenueDistributor, SwapFeeRouter, TegridyFeeExecutorRouter, TegridyLockVault, TegridyNFTPoolFactory, TegridyRestaking, TegridyRestakingAdmin, TegridyStaking, v2/StreamingRevenueDistributor, v4/TegridyV4Hook, v4/TegridyV4HookAdmin, VestingFactory). (2) The §Timelock windows table lists 12 contracts; TimelockAdmin is inherited by ~30 files under contracts/src, with TegridyFactory (48h FEE_TO_CHANGE, TegridyFactory.sol:53), TegridyRestaking, TegridyLockVault, TegridyFeeExecutorRouter, TegridyDropV2, TegridyTWAP, ReferralSplitter, MemeBountyBoard, CommunityGrants, AirdropFactory and TegridyHarvestVault all absent. (3) §What the admin CANNOT do claims 'Bypass the 25% early-withdrawal penalty REDISTRIBUTION' — the penalty is not redistributed; the entire 25% goes to the treasury address, which the admin sets on a 48h timelock (TegridyStaking.sol:1483-1508, and :1484 is literally 'AUDIT FIX L-23: Corrected comment — penalty goes to treasury, not redistributed to stakers'). The claim reads as a user protection while describing an admin-controlled flow.

**Risk.** GOVERNANCE.md is the document a depositor or an auditor reads to decide whether to trust the protocol, and it is wrong today in the direction that flatters the protocol (claiming no guardian role exists is a smaller-attack-surface claim; calling the penalty 'redistribution' implies stakers receive it). Rewriting it from the existing text rather than from source will preserve the errors — the 2026-08-12 honesty sweep did exactly that to REVENUE_ANALYSIS.md, fixing the prose three lines below a table that still carried the pre-correction number (docs/UNFINISHED_INVENTORY_2026_08_13.md, §REVENUE_ANALYSIS). Regenerate each section from a grep, do not edit around the old prose.

**How to do it.**

Split this line — it bundles two pure-doc items that are landable today with two that are not, and as one checkbox it will stay unticked forever.

LANDABLE TODAY (do this now): (a) Rewrite docs/GOVERNANCE.md against source, not from memory. Fix the three falsehoods listed in `remaining`, verifying each claim by grep before writing it. Method: regenerate the timelock table from `grep -rln TimelockAdmin contracts/src/` and read each contract's delay constants; regenerate the guardian section from `grep -rln PauseGuardian contracts/src/`; re-read TegridyStaking.sol:1483-1508 before writing anything about the penalty. Add a row-per-contract rather than a curated 12, because a curated list is what silently went stale. The single most useful correction for a reader deciding whether to deposit: the 25% early-exit penalty flows to an admin-settable treasury, on a 48h timelock — say that in §What the admin CAN do, where it belongs, instead of implying the opposite in §CANNOT. Keep the 'single EOA, multisig migration on the roadmap' framing — grep confirms that part is still honest. (b) Restate ROADMAP.md for year two: at minimum correct :85 (Base — memo and scripts shipped 710e4a0e, decision is NO-GO per docs/BASE_L2_GO_NO_GO.md:13) and :96 (IVotes — still accurate, but note the EIP-170 blocker from line 180). Then reconcile ROADMAP's Q4 items against the four contracts that landed 2026-08-19 and are not reflected anywhere.

NOT LANDABLE (say so on the line rather than leaving it open): the chaos drill needs live signers, real keys and a testnet pause/unpause ceremony — `[op]`. The annual security review needs an external firm — `[ext]`. Neither is agent work. But one preparatory piece IS landable: create docs/drills/README.md establishing the template and the tracking convention docs/INCIDENT_RESPONSE.md:202 already mandates, so the first drill has somewhere to land. Do not fabricate a drill record.

Suggested rewrite of line 191, replacing it with three: '- [ ] `[code]` Truthful GOVERNANCE.md + roadmap restated for year two — buildable now, pure doc work verified against source'; '- [ ] `[op]` Chaos drill (docs/INCIDENT_RESPONSE.md §7; docs/drills/ does not exist, zero drills ever run, 8 of 10 contact-tree cells are TBD)'; '- [ ] `[ext]` Annual security review'.

Verify: no CI gate covers markdown. The verification is mechanical and must actually be performed: every contract named in the new GOVERNANCE.md timelock table must appear in `grep -rln TimelockAdmin contracts/src/`, and every delay figure must match a constant in the named file. Cite file:line in the doc so the next reader can re-verify in one command.

---

# Completeness critic — what the audit itself missed

## 1. Coverage

**The audit enumerated the wrong 44.** It ran against the plan as of `05aff561^`, not the current tree. `05aff561` (2026-08-22 17:41, "docs: a START HERE section…") edited two of the lines the audit then went on to audit:

- **Line 65** was ticked to `- [x]` by that commit. The audit spent a slot confirming an item the plan had already closed.
- **Line 71** was retagged from `` `[code]` `` to `` ⚠️ `[op]` `` by that same commit ("REWRITTEN 2026-08-22 — the old prescription is now a defect"). It is no longer a `[code]` line at all.

I verified this mechanically. `git show 05aff561^:docs/YEAR_PLAN_2026_2027.md` matched against `^- \[ \] \`\[code\]\`` yields exactly the audit's 44, including 65 and 71. The same regex on the current file yields 42.

The current true set of unticked lines carrying a `[code]` tag is **44**, and it is a different 44: the anchored 42 plus **line 116** and **line 177**. Both were missed, and both were missed for the same mechanical reason — they lead with `` `[op]` `` and carry the `` `[code]` `` tag mid-line, so an anchored regex skips them.

**Line 116** — `[op]` Light theme decision → `[code]` fix (app-wide ~1.5:1 contrast defect). Not vapour: `e2e3decb` (2026-08-18) landed the decision-free half (`frontend/src/index.css`, plus `frontend/src/lib/lightThemeContrast.test.ts`, 266 lines). That test names its own uncovered surface at lines 38-45 — `.heading-luxury` has no plate of its own and "always resolves against whatever the page paints", correct only if art-backed pages gain a light scrim, correct-to-remove only if they keep the dark murals. So the remaining `[code]` work is precisely scoped and genuinely `NO_NEEDS_OPERATOR`. It should have been classified, not omitted.

**Line 177** — `[op]` If go: MVP set on Base; `[code]` bridge tab (LiFi /v1/status + destination awareness); cross-chain portfolio. This is the more costly miss, because **the bridge tab is not actually conditional on the Base decision.** `docs/BATTLE_PLAN.md:231` already carries a full build spec, and its destination is Solana, not Base: extend `getLiFiQuote` in `frontend/src/lib/aggregator.ts` for `fromChain`/`toChain`, widen `liFiResponseSchema` in `frontend/src/lib/schemas/aggregator.ts`, add `frontend/src/components/swap/CrossChainTab.tsx` mounted in `TradePage.tsx`, and extend the `lifi` CONFIG `matchPath` in `frontend/api/aggregator.js` to admit `/v1/status`. The proxy seam already exists (`frontend/api/aggregator.js` and `frontend/api/_lib/aggregator-proxy.js` both already carry li.fi config). This is a fully-specified, buildable-today `[code]` item that no agent looked at, and the `[op]` prefix plus the Base NO-GO will keep hiding it.

## 2. Optimism

I spot-checked the DONE claims resting on the weakest evidence. One is clean, two are wrong in a way that matters.

**Line 120 — clean, DONE confirmed.** My first grep looked like the gateAudit surface was test-only, but that was my filter's fault. `frontend/src/components/LaunchGate.tsx:23` imports `GateAuditPanel` and renders it at `:193` and `:211`, and `frontend/src/components/heat/GateAuditPanel.mounted.test.tsx` exists specifically to assert mounting rather than rendering ("IS IT ACTUALLY ON SCREEN?" … "`readGateAudit` sat in this repo with zero consumers precisely that way"). Four cases pinned: COLD carries the panel collapsed, STALE carries it, WARM does not, no-wallet does not. This one is properly done and properly guarded.

**Line 85 — marked DONE with no caveat; the plan line is falsified on both of its two clauses.** The audit cited `.github/workflows/arb-linkage-monitor.yml:43-44` as proof of the cron and stopped there.

- The line says **"a real 5-min cron"**. The workflow is `cron: "*/15 * * * *"` (`arb-linkage-monitor.yml:44`), and its header argues the point deliberately at `:17-27`: *"The prescribed 5 minutes is not achievable here and pretending otherwise would be worse than picking a slower number on purpose… 15 minutes is what this runner can actually be held to."* It also states the margin is thin — `consult()` reads observations spaced ≥15 minutes and the adversarial review models a 30-minute grind.
- The line says **"auto-pause hook that consumes HALT"**. `scripts/monitoring/arbPauseConsumer.mjs:14-25` is headed "WHY IT DOES NOT SEND THE TRANSACTION" and concludes: *"this is alerting plus preparation. Time-to-pause is bounded by a human reading a notification."* The workflow agrees at `:38-40`: "The pause itself is NOT automated and no key is present in this workflow."

Both are good engineering decisions. But ticking line 85 DONE with no note leaves the plan asserting a 5-minute cadence and an automatic pause on the one condition that gates NFT lending, the TegridyLending deploy and POL accumulation. That is a safety-relevant false belief, and marking it DONE removes the line before anyone reads the disagreement.

**Line 117 — DONE is defensible, but the module names an outstanding proof the audit did not surface.** The code is real and not a stub: `minOutFromQuote` at `frontend/src/lib/launcher/launchBuy.ts:55`, the V4 `execute` encoder at `:183`, `quoteExactInputV4` wired at `:428`, min-out applied at `:443`, and the encoding is transcribed from vendored `contracts/lib/v4-periphery @ 7ebd04b1` rather than invented (`:13-21`). Against the plan's own `[code]` definition at line 11 ("merged and tested — not deployed, not switched on"), DONE holds. But `launchBuy.ts:37-40` says: *"NOT YET FORK-PROVEN END TO END… a create+buy fork run against a live auction pool is the outstanding proof for this encoding."* The plan calls this line "the GO-LIVE TODO"; closing it silently discards the one remaining proof obligation on a path where a launch is paid for before the buy leg is reached.

## 3. Pessimism

**Line 105 (14h, `NO_NEEDS_OPERATOR`) — wrong. The largest landable slice in the whole audit is buried here.** The audit's own remaining text concedes the shape: "no evaluator that runs with the tab shut — `frontend/api/_lib/push.js` exists and can send, but nothing calls it." Writing that caller is code, and three facts make it cheap:

- `frontend/src/lib/alerts/evaluate.ts:30-32` states the decision core is pure — *"Nothing here fetches. Facts arrive as `SourceReading`s from readers.ts so the whole decision surface is a pure function over data."* It is already portable to Node.
- **`frontend/vercel.json` has no `crons` key at all** — I read the whole file; it has `buildCommand`, `outputDirectory`, `functions`, `headers`, and nothing else. There is no `frontend/api/cron/` directory either. Scheduled server-side execution does not exist anywhere on this deployment, and adding it is a repo file edit, not an operator action.
- The server schema is already authored: `frontend/supabase/migrations/016_alert_rules.sql`.

So the operator holds only the VAPID keys and the migration apply. The evaluator route, the `crons` entry, and the `push.js` wiring are all landable today.

**Line 138 (8h, `NO_NEEDS_OPERATOR`) — also wrong, same shape.** `frontend/src/lib/alerts/inbox.ts` is already split at exactly the right seam: `ingest` (`:117`), `markRead` (`:143`), `markAllRead` (`:153`), `dismiss` (`:158`), `unreadCount` (`:163`) are pure transitions over `InboxState`, and localStorage is confined to a persistence block at `:183-230` (`INBOX_STORAGE_KEY`, `serializeInbox`, `parseInbox`). Moving to the push schema means authoring a migration, adding an API route, and swapping that one adapter. This repo has 22 committed migrations of which most are unapplied — authoring a migration is unambiguously `[code]` here. Only the apply needs the operator.

**Line 98 (12h, `NO_NEEDS_OPERATOR`) — UNKNOWN, and I am stating it as UNKNOWN.** I could not confirm or refute a landable slice for the "fee-claim ops dashboard" half. The searches I ran: `grep -rn "claimPartnerFee\|feeClaim\|claimFee\|partner_fee\|partnerFee"` over `frontend/src`, `indexer/src`, `indexer-solana` for `.ts`/`.tsx`, which returned only airdrop/onramp/swap-fee surfaces and no fee-claim ops surface. I did not read `indexer-solana/sql/` or `indexer-solana/src/` to determine whether the Solana leg already exposes claim rows a dashboard could read. That question decides the classification and I did not answer it.

**A correction that runs the other way — line 180 is too optimistic, not too pessimistic.** The audit marked it `buildableNow: YES, 20h`. Two of its five sub-items (IVotes delegation, staking-AMM change) edit `contracts/src/TegridyStaking.sol`, and `c178eb14` (2026-08-21) re-measured that contract at **24,554 B — 22 B of headroom**. `contracts/foundry.toml:19-25` marks it *"FROZEN for launch"* and rules: *"ANY further growth must extract more to a lib or sister; do NOT consume buffer… 22 B is less than one line of code, and this contract is live + on the redeploy list. Extract BEFORE the next edit."* `.github/workflows/contracts-ci.yml:211-219` says the same. Neither sub-item can land as scoped; both require a prerequisite extraction to `StakingViewLib` or the `StakingMonitorView` sister that appears nowhere on the plan.

> **Addendum 2026-09-05 — the quoted figures moved; the conclusion did not.** The paragraph
> above is accurate as of its 2026-08-22 date, but the text it quotes no longer exists at the
> cited lines. `TegridyStaking` was re-measured at **24,521 B — 55 B of headroom** after the
> `[LEND-EOA-WHITELIST]` / `[LEND-RESIDUE-DEADLOCK]` pass, which shipped two security fixes and
> still returned 33 B by folding three duplicated code-length checks into one `_requireContract`
> helper. `contracts/foundry.toml` and the CI allowlist comment were updated to match, so the
> verbatim quotes here ("22 B is less than one line of code") will not be found in either file.
> The line-180 verdict STANDS: 55 B is still far less than either sub-item costs, and the
> prerequisite extraction is still unplanned. The measured size is now ratcheted by
> `contracts/test/Audit_StakingEIP170Size.t.sol`, so this figure can no longer drift silently —
> which is what let the number in this document go stale in the first place.

## 4. Plan lines now wrong as written

**Line 77 (the Q1 acceptance gate) is now unreachable by decision.** It reads *"**Q1 done when:** every contract Safe-owned · login live with RLS verified · …"*. On 2026-08-21, `347f6586` recorded the opposite as a standing instruction in `docs/WHAT_I_NEED_FROM_YOU.md` §0.3: *"**Instruction on the record, 2026-08-21: leave the Safe situation alone.** It is not an open question waiting on an answer, and no session should reopen it, propose topologies, or fold it into a plan as a blocker."* The commit body adds that the ownership-migration chain is "parked, by choice." Q1 can therefore never be marked done against its own written bar, and lines 30, 31, 33, 91, 164 and 187 all prescribe Safe work that a session is now instructed not to raise. Line 164's parenthetical precondition ("launchpad Safe-owned") is parked by choice, not pending.

**Line 85, as detailed above** — prescribes a 5-min cron and an auto-pause the tree deliberately declined, with the reasoning written down in both files.

**Line 191's GOVERNANCE.md item is now wrong in a second, newer way.** The audit correctly flagged `docs/GOVERNANCE.md:92` — *"There is currently no separate `guardian` role for fast emergency response. Guardian introduction is planned alongside the multisig migration"* — as false. Both clauses are now false, and the second only became false on 08-21. The role exists in source: `contracts/src/TegridyFactory.sol:50` declares `address public guardian`, and the constructor at `:197` takes `_guardian` directly. And `dc446f17` (2026-08-21) decoupled it from any multisig migration entirely — `contracts/script/DeployMVP.s.sol` now constructs with `new TegridyFactory(deployer, treasury, pauseGuardian)` and the added comment reads *"Guardian = PAUSE_GUARDIAN from block one. There is NO post-deploy rotation."* So the doc's stated remedy points at a migration the operator has since parked, for a role that is already set at construction.

**Line 159's premise is stale in the direction of pessimism.** `c178eb14` empties the `OVER_EIP170_DEFERRED` tier and records `TegridyRestaking` at **22,114 B, 2,462 B headroom — under EIP-170 and deployable**. The figure it replaced said 26,623 B "STILL over", stale by ~4,500 B. Any reader working from the older records will believe the split is unfinished.

## 5. Not in the plan at all

**No scheduled execution exists anywhere on the hosting config.** `frontend/vercel.json` has no `crons` key and there is no `frontend/api/cron/`. Every "runs while the tab is shut" feature on the plan — the alert evaluator (105), the notification inbox (138), the Solana fee cron (98) — silently depends on infrastructure that does not exist and that nothing on the plan asks anyone to create. It is one file edit, and it is the shared blocker under three separate multi-hour lines.

**The mandatory pre-extraction on TegridyStaking.** `contracts/foundry.toml:23-25` states a hard rule — extract to a lib or sister *before* the next edit — and no plan line carries it. Line 180 schedules two edits to that contract as if the rule did not exist.

**The audit's own selection regex is a durable defect, not a one-off.** Any future line written as `` `[op]` X → `[code]` Y `` will be skipped by the same anchored pattern that lost 116 and 177. Two such lines exist today and both contain real, scoped, buildable work. Worth fixing at the source — either by normalising the plan's tagging so every line leads with its most-actionable tag, or by matching on containment.

**Uncommitted work is sitting in the tree right now**, and this repo has been bitten by it before: `c178eb14`'s own body says it was *"Recovered from an uncommitted worktree (.claude/worktrees/infallible-einstein-3e0063)"* whose originating session had measured five commits earlier. `git status --porcelain` currently shows `frontend/e2e/fixtures/wallet.ts`, `frontend/playwright.config.ts` and `frontend/src/index.css` modified and uncommitted. The first two are exactly the files `05aff561`'s per-spec E2E seeding recipe prescribes editing, so this is probably live in-flight work — but it is unrecorded, and the index.css change touches the same file as the line-116 light-theme fix.
