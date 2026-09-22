# Open-PR Triage — 2026-06-01

10 PRs open against `main` after #73 (security batch) and #75 (frontend polish) merged.
**None mergeable as-is** — all have a failing check; 4 also conflict with `main`.

## Key finding: the `Vercel` failure is environmental, not code
9 of 10 PRs show `Vercel FAIL` with *"Deployment has failed — run npx vercel inspect …"*.
It fails identically on a 1-line `@types/node` bump (#71), so it's a Vercel project/env
issue (env var, build cache, or preview-deploy config), **not a code defect**. The GitHub-side
checks (Build, Lint, forge) tell the real story. Only **#34** and **#25** have genuine code failures.

## Per-PR

| PR | Title | Owner | Merge | Real CI fail? | Recommendation |
|----|-------|-------|-------|---------------|----------------|
| **#71** | bump @types/node (indexer) | dependabot | MERGEABLE | No (Vercel-only) | **Safe-ish** — dev-dep bump, indexer only. Merge once Vercel env fixed, or admin-merge bypassing the Vercel gate. |
| **#74** | bump viem 2.48→2.51 (indexer) | dependabot | MERGEABLE | No (Vercel-only) | **Likely safe** — minor viem in indexer. Confirm indexer typechecks, then merge. |
| **#72** | bump react group (frontend) | dependabot | MERGEABLE | No (Vercel-only) | **Caution** — react major-ish + 14.8k lockfile churn. Needs a real frontend build+test run before trusting. Don't merge blind. |
| **#34** | bump tooling group (frontend) | dependabot | MERGEABLE | **YES — `Build`** | **Fix-first** — real Build failure (a tooling bump broke compilation). Diagnose before any merge; likely needs a code/config follow-up commit. |
| **#61** | re-promote 16 eslint rules to error | concurrent session | MERGEABLE | No (Vercel-only) | Theirs. Lint-only, 1 file. Low risk but their call. |
| **#68** | Certora Phase 1.4 (6 CVL rules) | concurrent session | MERGEABLE | No (Vercel-only) | Theirs. Additive (+326/-0). Their call. |
| **#62** | README/CHANGELOG Wave-2 ledger | concurrent session | **CONFLICTING** | No (Vercel-only) | Theirs. Docs-only, conflicts in FIX_STATUS/CHANGELOG vs merged #73. Trivial rebase — but theirs to do. |
| **#63** | M19-NFTLENDING acceptOwnership port | concurrent session | **CONFLICTING** | No (Vercel-only) | ⚠️ Conflicts on `TegridyNFTLending.sol` + `contracts-ci.yml` — **the exact files PR #73's NFTLending split rewrote**. Their security fix overlaps merged work; needs careful re-port onto the new sister-Admin structure. THEIRS — re-porting blind risks clobbering. |
| **#59** | M19-cluster acceptOwnership (14 files) | concurrent session | **CONFLICTING** | No (Vercel-only) | ⚠️ Touches RevenueDistributor/ReferralSplitter/POLAccumulator/etc — files the audit batches already changed on main. Large security port that overlaps merged work. THEIRS. |
| **#25** | 30-day UX push (72 files) | concurrent session | **CONFLICTING** | **YES — Lint + Static analysis + forge build** | Oldest (May 15), 72 files incl. contracts. Real multi-gate failures AND conflicts. Likely stale/superseded by everything merged since. Recommend **close or full rebuild**, not merge. THEIRS. |

## Recommended action order
1. **Fix the Vercel env failure** (project-level) — unblocks the 6 otherwise-clean PRs at once. This is an operator/dashboard task, not a code change.
2. **#71, #74** — smallest safe dependency bumps; merge after Vercel is green (or admin-merge).
3. **#34** — diagnose the real `Build` failure (a tooling bump broke the frontend build); needs a fix commit.
4. **#72** — run a real frontend build+test against the new react versions before trusting the bump.
5. **#61, #68, #62** — the concurrent session's low-risk lint/test/docs; their call (just need rebase for #62).
6. **#63, #59** — the concurrent session's M19 security ports; **must be re-ported onto post-#73 main** (NFTLending is now split into a sister Admin; several target files changed). High-context, theirs to own.
7. **#25** — stale 72-file push with real failures + conflicts; recommend close + cherry-pick anything still wanted.

## Ownership note
6 of 10 are the concurrent session's (`fomotsar-commits` / `claude/*` branches): #59, #61, #62, #63, #68, #25.
4 are Dependabot: #34, #71, #72, #74. None are this session's work (mine: #73 + #75, both merged).
