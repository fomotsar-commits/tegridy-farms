# Audit 091 — Dead Code & Unused Exports

**Scope:** `frontend/src/`, `frontend/api/`, `contracts/src/`, `indexer/`
**Mode:** AUDIT-ONLY
**Date:** 2026-04-25

---

## Summary Counts

| Category | Count |
|---|---|
| Dead page modules (unimported by App.tsx) | 12 |
| Dead V1 launchpad files (per memory: V1 must be deleted) | 3 |
| Committed `.bak` files | 1 (confirmed) + 1 vercel project bak |
| Solidity DEPRECATED functions still present | 14 (intentional — see notes) |
| Generated.ts ABIs for deleted V1 contracts | 0 (clean) |
| Indexer dead handlers | 0 (all imports used) |

---

## frontend/src/pages/ — Dead pages (merged into tabs, but files left behind)

`App.tsx` lazy-imports only: HomePage, FarmPage, TradePage, DashboardPage, GalleryPage, ActivityPage, CommunityPage, LearnPage, AdminPage, ArtStudioPage, LendingPage, InfoPage. Comments at lines 20, 23-27, 32, 35 explicitly state the merges.

The following page files exist but are NOT imported anywhere in `frontend/src/`:

1. `frontend/src/pages/HistoryPage.tsx` — merged into ActivityPage (App.tsx:20)
2. `frontend/src/pages/LeaderboardPage.tsx` — merged into ActivityPage
3. `frontend/src/pages/PremiumPage.tsx` — merged into ActivityPage
4. `frontend/src/pages/ChangelogPage.tsx` — merged into ActivityPage
5. `frontend/src/pages/TokenomicsPage.tsx` — merged into LearnPage (App.tsx:23)
6. `frontend/src/pages/LorePage.tsx` — merged into LearnPage
7. `frontend/src/pages/SecurityPage.tsx` — merged into LearnPage
8. `frontend/src/pages/FAQPage.tsx` — merged into LearnPage
9. `frontend/src/pages/RisksPage.tsx` — merged into InfoPage (App.tsx:32)
10. `frontend/src/pages/PrivacyPage.tsx` — merged into InfoPage
11. `frontend/src/pages/TermsPage.tsx` — merged into InfoPage
12. `frontend/src/pages/ContractsPage.tsx` — merged into InfoPage
13. `frontend/src/pages/TreasuryPage.tsx` — merged into InfoPage

Each is a multi-hundred-line page file that ships in dev builds (and could be code-split into Rollup chunks if any stale dynamic import remains). Recommend deletion or empty-stub redirect.

**Note:** these dead pages still re-import live modules (Sparkline, PulseDot, FlashValue, ReferralWidget, Confetti, etc.), which keeps grep noisy but does not justify retention.

---

## frontend/src/components/launchpad/ — V1 launchpad (per memory: V1 must be deleted)

Memory `project_scope_decision.md`: "delete V1 duplicates only (Launchpad/Drop)". The V2 pair (`CollectionDetailV2.tsx`, `OwnerAdminPanelV2.tsx`) is the only one consumed (via `LendingPage` → wizard). The V1 trio is still present but never imported outside its own self-references:

1. `frontend/src/components/launchpad/CollectionDetail.tsx` — only referenced inside itself + a comment in CollectionDetailV2.tsx:12
2. `frontend/src/components/launchpad/OwnerAdminPanel.tsx` — only imported by CollectionDetail.tsx:9 (internal pair)
3. `frontend/src/hooks/useNFTDrop.ts` — only consumed by `CollectionDetail.tsx:6` and the test file `useNFTDrop.test.ts`. Production code uses `useNFTDropV2.ts`.

This is exactly the scenario flagged in memory. **Highest-impact deletion.**

---

## frontend/api/ — clean

All API endpoints (`alchemy.js`, `etherscan.js`, `opensea.js`, `orderbook.js`, `supabase-proxy.js`, `v1/index.js`) are Vercel serverless route handlers (default-export style — never module-imported by frontend code). All have tests in `frontend/api/__tests__/` and `frontend/api/_lib/__tests__/`. No dead modules.

`frontend/.vercel/project.json.bak` — committed bak file. Safe to remove (not load-bearing).

---

## contracts/src/ — DEPRECATED functions retained intentionally

Audit found 14 functions explicitly marked `DEPRECATED` (PremiumAccess.sol, POLAccumulator.sol, RevenueDistributor.sol, ReferralSplitter.sol, TegridyFactory.sol, TegridyRestaking.sol, VoteIncentives.sol). All retained for ABI/storage-slot compat — they revert with explanatory messages. **NOT dead code in the harmful sense** — keep per battle-tested-defaults mandate.

No mock contracts in `contracts/src/`. All 19 `Mock*` contracts live exclusively in `contracts/test/*.t.sol` and are imported by surrounding tests in the same file. No orphan mocks.

No state vars confirmed never read or written outside this audit's reach (would require Slither/full call-graph analysis — 91-agent scope is grep-deep, not solver-deep). DEPRECATED functions write to deprecated fields by design.

---

## contracts/test/ — committed `.bak`

Confirmed previously flagged: `contracts/test/Audit195_Restaking.t.sol.bak` (50,726 bytes, dated 2026-03-29). Foundry will **not** compile it (`.bak` extension), but it is in git history. **Recommend removal.** Multiple worktree copies under `.claude/worktrees/agent-*/` are cwd artifacts, not project bloat.

---

## frontend/src/generated.ts — clean

6,661 lines, 19 ABI exports. All ABIs correspond to live contracts (`tegridyDropV2Abi`, `tegridyLaunchpadV2Abi` — V2 only). **No V1 ABI bloat.** This file is healthy.

---

## indexer/src/index.ts — clean

All 16 schema imports (`stakingPosition` … `bounty`) are referenced by `ponder.on(...)` event handlers. No dead imports. No dead handlers.

---

## Top-5 Highest-Impact Dead Modules (priority for deletion)

1. **`frontend/src/components/launchpad/CollectionDetail.tsx` + `OwnerAdminPanel.tsx` + `hooks/useNFTDrop.ts`** — V1 launchpad/drop pair, explicitly flagged for deletion in `project_scope_decision.md`. ~600 lines of dead React.
2. **`frontend/src/pages/HistoryPage.tsx`** — large merged page (~370+ lines, includes its own `exportCSV` ~line 307, fetch logic, table rendering). Functionality lives in ActivityPage tabs.
3. **`frontend/src/pages/PremiumPage.tsx`** — 449 lines per audit 050. Functionality lives in ActivityPage tabs.
4. **`frontend/src/pages/TokenomicsPage.tsx`** — heavy page with Sparkline + chart deps. Functionality lives in LearnPage tabs.
5. **`contracts/test/Audit195_Restaking.t.sol.bak`** — 50KB committed backup. Already flagged by another agent. Confirmed stale.

---

## Notes on Scope

- Did not run static call-graph analysis on Solidity (would catch unused private/internal vars). Grep-only audit per agent scope.
- "Unused imports left in files (zero-cost but noise)" — TypeScript with `noUnusedLocals: true` would catch these at compile time; recommend confirming `tsconfig.json` has it. Did not enumerate per-file because the compiler does it cleanly.
- Feature-flagged dead branches: searched for `if (false)`, `// @ts-ignore feature flag`, etc. — none found.
- All findings are AUDIT-ONLY. No edits made to any source.
