# Dependabot Triage — 2026-04-20

**Context:** 18 Dependabot PRs open against `main`, all opened 2026-04-18–20. Zero merged, zero closed. This doc triages them by risk and gives you a recommended merge order. Read top-to-bottom.

## Summary

| # | PR | Package / group | Bump | Risk | Action |
|---|---|---|---|---|---|
| 1 | [#17](https://github.com/fomotsar-commits/tegridy-farms/pull/17) | recharts | `3.8.0 → 3.8.1` | 🟢 Low | Merge |
| 2 | [#18](https://github.com/fomotsar-commits/tegridy-farms/pull/18) | @tanstack/react-virtual | `3.13.23 → 3.13.24` | 🟢 Low | Merge |
| 3 | [#16](https://github.com/fomotsar-commits/tegridy-farms/pull/16) | typescript-eslint | `8.57.1 → 8.58.2` | 🟢 Low | Merge |
| 4 | [#14](https://github.com/fomotsar-commits/tegridy-farms/pull/14) | react-router-dom | `7.13.1 → 7.14.1` | 🟢 Low | Merge |
| 5 | [#13](https://github.com/fomotsar-commits/tegridy-farms/pull/13) | globals | `17.4.0 → 17.5.0` | 🟢 Low | Merge |
| 6 | [#12](https://github.com/fomotsar-commits/tegridy-farms/pull/12) | @supabase/supabase-js | `2.102.1 → 2.103.3` | 🟢 Low | Merge |
| 7 | [#2](https://github.com/fomotsar-commits/tegridy-farms/pull/2) | crytic/slither-action | `0.4.0 → 0.4.2` | 🟢 Low | Merge |
| 8 | [#9](https://github.com/fomotsar-commits/tegridy-farms/pull/9) | **react group** (react, react-dom) | `19.2.4 → 19.2.5` | 🟢 Low | Merge |
| 9 | [#15](https://github.com/fomotsar-commits/tegridy-farms/pull/15) | @tanstack/react-query | `5.91.3 → 5.99.0` | 🟡 Medium | Review changelog, then merge |
| 10 | [#5](https://github.com/fomotsar-commits/tegridy-farms/pull/5) | actions/download-artifact | `4 → 8` | 🟡 Medium | Check workflow compat, merge |
| 11 | [#3](https://github.com/fomotsar-commits/tegridy-farms/pull/3) | actions/checkout | `4 → 6` | 🟡 Medium | Check workflow compat, merge |
| 12 | [#4](https://github.com/fomotsar-commits/tegridy-farms/pull/4) | actions/setup-node | `4 → 6` | 🟡 Medium | Check workflow compat, merge |
| 13 | [#1](https://github.com/fomotsar-commits/tegridy-farms/pull/1) | actions/upload-artifact | `4 → 7` | 🟡 Medium | Check workflow compat, merge |
| 14 | [#10](https://github.com/fomotsar-commits/tegridy-farms/pull/10) | @types/node (indexer) | `22.19.17 → 25.6.0` | 🟡 Medium | Hold until Node 24+ is your floor |
| 15 | [#8](https://github.com/fomotsar-commits/tegridy-farms/pull/8) | ponder (indexer) | `0.8.33 → 0.16.6` | 🔴 High | **Hold** — large pre-1.0 API jump |
| 16 | [#7](https://github.com/fomotsar-commits/tegridy-farms/pull/7) | **web3-stack**: wagmi `2 → 3`, viem `2.47 → 2.48` | Mixed | 🔴 High | **Close or rebase** — wagmi v3 is a major API change |
| 17 | [#6](https://github.com/fomotsar-commits/tegridy-farms/pull/6) | typescript (indexer) | `5.9.3 → 6.0.3` | 🔴 High | **Hold** — TS 6.0 is brand new, break risk |
| 18 | [#19](https://github.com/fomotsar-commits/tegridy-farms/pull/19) | **tooling group** (includes TS 5→6, eslint 9→10, @types/node 24→25) | Mixed | 🔴 High | **Close or split** — multiple majors bundled |

Legend: 🟢 safe patch/minor · 🟡 needs a quick look · 🔴 defer or renegotiate

---

## Recommended merge order (safe path)

Merge the eight 🟢 PRs first, one at a time, in this order. Each should pass CI (your existing `CI` workflow runs lint, typecheck, unit, build, E2E). If any fails, stop and investigate before continuing.

```
1.  #2   — crytic/slither-action 0.4.0 → 0.4.2        (CI-only, safest)
2.  #13  — globals 17.4.0 → 17.5.0                    (eslint devDep)
3.  #16  — typescript-eslint 8.57.1 → 8.58.2          (lint devDep)
4.  #17  — recharts 3.8.0 → 3.8.1                     (chart library patch)
5.  #18  — @tanstack/react-virtual 3.13.23 → 3.13.24  (virtualization patch)
6.  #14  — react-router-dom 7.13.1 → 7.14.1           (router patch)
7.  #12  — @supabase/supabase-js 2.102.1 → 2.103.3    (supabase SDK patch)
8.  #9   — react group (react/react-dom 19.2.4 → 19.2.5, patch)
```

After those eight land, the 🟡 batch:

```
9.  #15  — @tanstack/react-query 5.91.3 → 5.99.0      (read the CHANGELOG before merging)
10. #3   — actions/checkout 4 → 6                     (major but low-risk GH action)
11. #4   — actions/setup-node 4 → 6
12. #1   — actions/upload-artifact 4 → 7
13. #5   — actions/download-artifact 4 → 8            (must be ≥4 to match #1, check pairing)
```

For #1 + #5 (artifact actions), double-check: `upload-artifact@7` and `download-artifact@8` must be paired correctly. Version-4 format is compatible with v5+ downloads; check the artifact v4→v5 migration notes.

---

## Hold / close

### 🔴 #7 web3-stack group (wagmi 2 → 3)

**Do not merge as-is.** wagmi v3 is a major version with breaking API changes. Merging would silently change behaviour on every money-moving surface in the app: `useSwap`, `useFarmActions`, `useLPFarming`, `useNFTBoost`, `useAccount`, everything.

**Two ways forward:**

1. **Close the PR** and let Dependabot re-open it when you're ready to do the migration (set `major-version-update: true` in `.github/dependabot.yml` to opt in explicitly).
2. **Pin wagmi to `2.x` in `package.json`** (e.g. `"wagmi": "^2.19.5"` is already a caret range that allows minor/patch but not major — confirm Dependabot respects it with `versioning-strategy: increase` vs `increase-if-necessary`).

The viem bump inside the group (`2.47.6 → 2.48.1`) is a minor and fine on its own; if you want it, cherry-pick viem into a new branch without wagmi.

### 🔴 #19 tooling group

Bundles **three** major bumps (TypeScript 5→6, ESLint 9→10, @types/node 24→25) plus two minor/patch. Merge as-is = huge surface-area change in one PR. Either:

- **Close** and let the individual PRs (#6, #10) come through separately, or
- **Split** the group: update `.github/dependabot.yml` to exclude majors from the `tooling` group.

### 🔴 #6 typescript 5.9.3 → 6.0.3

TypeScript 6.0 was released recently. Bumping a major of your compiler when you have 1,933 forge tests, 70 Vitest cases, 20+ Playwright specs, and 58k LOC of app code is a week-long project, not a Dependabot drive-by. Hold until you've read the TS 6 release notes and budgeted time for the strict-mode / type-narrowing changes that typically break on a major.

### 🔴 #8 ponder 0.8.33 → 0.16.6

Pre-1.0 framework with an 8-minor jump. Ponder's breaking-change cadence in pre-1.0 is high. Read the cumulative changelog; you likely need to rewrite `indexer/ponder.config.ts` event handlers. Don't merge under time pressure.

### 🟡 #10 @types/node (indexer) 22 → 25

Node 25 types are ahead of your actual runtime floor (`engines.node: >=20.0.0`). Bumping `@types/node` ahead of the runtime floor occasionally surfaces APIs your code shouldn't use. Not dangerous, just off-policy. Wait until you bump the `engines.node` floor to 24 or later.

---

## Housekeeping — prevent future backlog

`.github/dependabot.yml` in this repo groups some updates. To reduce the "Dependabot overwhelm" pattern you hit here, consider these updates after this sweep:

1. Split majors out of the `tooling` group so each lands standalone.
2. Add `versioning-strategy: increase-if-necessary` to avoid noise from upward-compatible bumps that your caret ranges already satisfy.
3. Set `schedule.interval: weekly` with a fixed day (e.g. Monday) so PRs arrive in one batch instead of dripping all week.
4. Add labels (`dependencies`, `javascript`, `github-actions`) so the PR list is filterable.
5. If you want auto-merge for 🟢-class bumps, add a `dependabot-auto-merge.yml` workflow that merges `type: patch` on green CI — but **only** for devDeps, never for production.

Example minimal dependabot config:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /frontend
    schedule: { interval: weekly, day: monday }
    open-pull-requests-limit: 5
    labels: [dependencies, javascript]
    groups:
      tooling:
        dependency-type: development
        update-types: [minor, patch]   # <- explicitly exclude major
      react:
        patterns: [react, react-dom]
  - package-ecosystem: github-actions
    directory: /
    schedule: { interval: weekly, day: monday }
    labels: [dependencies, github-actions]
```

---

## What I verified locally

- Fetched all 18 dependabot branches from `origin` (now present locally).
- Read each branch's commit message to confirm the bump scope and identify the three **major** bumps hidden in group PRs (wagmi 3, TypeScript 6, ESLint 10, @types/node 25).
- Confirmed current working-tree `tsc --noEmit` passes on main at HEAD.
- Did **not** check out each branch and run the full test matrix — that's 18 × (npm ci + vitest + playwright + forge build) which needs real CI time. The recommendation is to let your existing CI run each PR individually as you merge them.

## What you should do

1. Merge the eight 🟢 PRs in the order above via the GitHub PR UI, one at a time, waiting for CI green on each.
2. Review #15 (react-query 5.91 → 5.99) quickly — minor version bumps in TanStack Query sometimes change cache invalidation semantics. Skim the CHANGELOG, merge if clean.
3. Do the four 🟡 GitHub Actions PRs (#1, #3, #4, #5) as a mini-batch after reading GitHub's release notes for major-version changes.
4. **Close** PRs #6, #7, #8, #19 with a comment pointing to this doc. Re-open when you're ready to do each upgrade as an intentional project.
5. Update `.github/dependabot.yml` using the pattern above so this doesn't happen again.

*Generated 2026-04-20 as part of the bulletproofing-follow-up B5 batch.*
