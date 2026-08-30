# Consolidation sweep — 2026-08-28 (late)

**What this was:** a wrap-up pass over every parallel session running against this repo. Same ritual
as [`CONSOLIDATION_2026_08_21.md`](CONSOLIDATION_2026_08_21.md), and it found the same class of loss:
**finished, verified work sitting uncommitted in worktrees, invisible to trunk.**

All of this is **local and unpushed.** Trunk moved from `7ece138a` to a tip 49 commits ahead of
`origin/mvp-launch`.

---

## 0. Trunk was behind its own remote

`mvp-launch` was simultaneously **ahead 3 / behind 3**. The three remote commits (`cdedbc22`,
`0f1ae62b`, `23c56e9c` — curve honesty copy, first-creator orchestration tests, the 08-28 operator
TODO layer) were merged in first, so everything below sits on the true trunk, not a stale one.

## 1. Rescued from worktrees — would have been lost

Two sessions finished today and ended without committing. Both were **test-integrity fixes**, and both
are the direct cause of a CI gate that is currently papered over with a version pin.

| File | From | Size | What it does |
|---|---|---|---|
| `contracts/test/TegridyLending_Reentrancy.t.sol` | `gifted-darwin-8539a5` | +218 / −52 | Re-shapes the attacker's arming state from a zero-init counter to a **non-zero sentinel** |
| `contracts/test/TegridyNFTPool_Reentrancy.t.sol` | `suspicious-lederberg-ec6e16` | +178 / −75 | Same fix, plus a real vacuity finding |

**Why this matters more than "test cleanup":** `receive()` runs inside `WETHFallbackLib`'s gas
stipend, so every slot it touches is charged against that budget. An `attackCount++` from zero costs
20,000 gas (SSTORE_SET) by itself — measured, the old shape burned **29,867 of the 32,300 available,
leaving 7.5% headroom.** That is thin enough that ordinary codegen drift between toolchain releases
flips the test's *outcome on unchanged contract code* — which is exactly how this suite went red
under forge 1.8.0 and why `ci/pin-foundry-toolchain` pinned to 1.7.1. Arming to a non-zero value
first makes the write a dirty-slot store (~100 gas) and buys back an order of magnitude of headroom.
**This is the real fix behind that pin.**

The NFT-pool half also found the old test was **vacuous**: it forwarded `msg.value` to
`swapNFTsForETH` / `removeLiquidity`, which are *not payable*, so the re-entrant call died at the
compiler's callvalue check (994 gas, at the dispatcher) **before `nonReentrant` was ever consulted.**
It proved nothing about the guard it claimed to test. Now gated by `forwardValueOnReenter`.

## 2. Merged into `mvp-launch` — ten branches

| Branch | Commits | What landed |
|---|---|---|
| `test/native-buy-router-coverage` | 2 | First-ever coverage for `TegridyNativeBuyRouter` (money-path Seaport wrapper) — 518 lines |
| `audit/staking-reward-overmint` | 1 | PoC + doc for the **LIVE** base-reward over-mint (audit remediation #2) |
| `audit/restaking-bonus-insolvency` | 3 | CONFIRMED HIGH **fixed** — cumulative-liability cap on `_accrueBonus` |
| `audit/nftfi-vault-seizure-race` | 2 | CONFIRMED **fixed** — freeze deposits/withdrawals while a default is unrecognized |
| `fix/v4-boosted-lp-principal-trap` | 4 | Zero-oracle `emergencyWithdraw`; tolerance scoped to the self-exit path only |
| `feat/components-mounted-guard` | 1 | Ghost-code guard extended to components (code item 119) |
| `fix/v2-additive-power-legs` | 3 | v2 chain: forfeit deletion + review corrections + additive power legs |
| `fix/v2-delete-forfeit` | 1 | The contradictory `_syncMirror` `@dev` that still described the deleted forfeit as live |
| `claude/row8-oracle-reanchor` | 5 | Row 8 TWAP re-anchored on canonical `UniswapV2OracleLibrary` + the V2-provenance CI gate |
| `claude/frontend-avantgarde-audit` | 10 | The 08-28 frontend audit — 53 findings, 46 fixed: a11y, CSP exfil trim, 14 invisible door routes, and the `/bayla` **infinite-reload** bug when storage is blocked |

**Note:** `claude/row8-oracle-reanchor` carries PR **#335**'s commits (`4eb8bda7`, `87146209`) as
ancestors, so #335's content is now on trunk regardless of the PR's state.

`audit/staking-reward-overmint` is a **characterization** test (`_KNOWN_DEFECT`): it asserts the
buggy behaviour, so it is **green today and turns red when the bug is fixed.** It does not redden CI.

## 3. Deliberately NOT merged

**Refuted — do not merge, ever:**
`fix/v2-owner-timelocked-forfeit-v4` (attempt 4, see `V2_FORFEIT_ATTEMPT4_REFUTED_2026_08_26.md`),
plus the older `attempt2/lockend-anchor`, `fix/v2-owner-timelocked-forfeit`, `v2forfeit`.

**Already landed via squashed PRs** — they conflict *because* they are duplicates:
`ci/pin-foundry-toolchain` (#337), `claude/wonderful-brattain-252233` (#339),
`claude/jolly-ritchie-0d4dda` + `deploy/multichain-frontend-live` (#334).

**Left to its open PR:** `claude/frosty-mahavira-815e7b` — R080 zod schemas, **PR #342 OPEN.**

**Conflicts, needs a human rebase decision** (see §4):
`prep/island-wave-five`, `claude/bungalow-buildout`, `claude/curve-discovery-grid`.

**~40 agent worktrees carrying dirty trees are from April 2026** — four months and 100+ commits
stale. Not rescued; superseded. They are noise in every future `git status` sweep and should be
pruned.

## 4. What this sweep leaves open

1. **`prep/island-wave-five`** (1 commit, 25 files) — the homepage "arrival inversion". Conflicts on
   `frontend/index.html` and `frontend/vercel.json` against the avantgarde audit's CSP rewrite.
   Both edits are wanted; the CSP header is the contested line. Needs a rebase, not a merge.
2. **`claude/bungalow-buildout`** (2 commits, 43 files) — Base scanner, curve trust strip, dead-end
   funnels. Conflicts with the Bayla parity work on `bungalows.ts` / `ArtStudioPage.tsx`. Same
   author-intent, divergent implementations of the bungalow surface.
3. **`claude/curve-discovery-grid`** — superseded by trunk's own curve discovery (`c8bd1a31` + the
   origin curve commits). Verify nothing unique is stranded, then delete.
4. **Prune the April-2026 worktrees.** Use `cmd /c rmdir` for anything junctioned — **never**
   `rm -rf`, which has already deleted 961 vendored-lib files out of the main checkout once.
5. **The LIVE staking over-mint is now pinned but not fixed.** Interim mitigation is unchanged and
   is operator work: **keep the reward pool funded ahead of emission (top-up or cut `rewardRate`)
   before the reserve depletes (~2026-10-11)**, which keeps the cap from binding. The real fix is
   the Synthetix funded-period rebase — a migration on a live contract.
