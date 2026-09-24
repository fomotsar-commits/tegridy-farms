# Agent 085 — GitHub Workflows & Issue Templates Audit

**Scope:** `.github/workflows/*` (5 files) + `.github/ISSUE_TEMPLATE/*` (4 files) + adjacent (`CODEOWNERS`, `dependabot.yml`)
**Mode:** AUDIT-ONLY. No code modified.
**Date:** 2026-04-25

---

## Files inspected

| Path | Purpose |
|---|---|
| `.github/workflows/ci.yml` | Frontend lint/typecheck/test, build, e2e |
| `.github/workflows/codeql.yml` | CodeQL JS/TS analysis |
| `.github/workflows/contracts-ci.yml` | Foundry build + test |
| `.github/workflows/release.yml` | Tag-driven GitHub Release publish |
| `.github/workflows/slither.yml` | Slither static analysis + SARIF upload |
| `.github/ISSUE_TEMPLATE/bug_report.yml` | Bug template |
| `.github/ISSUE_TEMPLATE/feature_request.yml` | Feature template |
| `.github/ISSUE_TEMPLATE/security.md` | Security stub redirecting to private disclosure |
| `.github/ISSUE_TEMPLATE/config.yml` | Issue chooser config |
| `.github/CODEOWNERS` | Reviewer routing |
| `.github/dependabot.yml` | Dependency updates |

---

## Hunt-list verdicts

### CRITICAL (none)
- **`pull_request_target` running untrusted code:** NOT PRESENT. All workflows use `pull_request` (safe — no secrets on fork PRs unless explicitly granted) or `push` on `main`. No `pull_request_target` triggers anywhere. ✅
- **Checkout of PR ref before secrets eval:** N/A — no `pull_request_target` exists; `actions/checkout@v4` is invoked with default ref under `pull_request` only, which already runs in untrusted-context isolation. ✅
- **Fork PR runs that access secrets:** `ci.yml` build job exposes `VITE_WALLETCONNECT_PROJECT_ID` via `env:` — see HIGH-1 below.

### HIGH

**HIGH-1 — Secret available to fork-PR builds (`ci.yml:67-68`)**
```yaml
env:
  VITE_WALLETCONNECT_PROJECT_ID: ${{ secrets.VITE_WALLETCONNECT_PROJECT_ID }}
```
The `build` job runs on every `pull_request` (including from forks if the repo allows it). GitHub will *not* pass org/repo secrets to fork PRs by default, so practical exposure is low — BUT a malicious PR could modify `npm run build` (it's a script in `package.json`) or any transitive build dep to exfiltrate the value the moment a maintainer re-runs the workflow on a same-repo branch. Safer pattern: gate this step with `if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository` AND publish a public-allowlist value at runtime, or only inject the secret in the deploy job (not CI build for PRs). Treat the WalletConnect project ID as semi-sensitive (rate-limited per project).

**HIGH-2 — Floating major-version pins on third-party actions (supply-chain)**
All workflows pin actions to floating tags rather than commit SHAs:
- `actions/checkout@v4`, `actions/setup-node@v4`, `actions/cache@v4`, `actions/upload-artifact@v4`, `actions/download-artifact@v4` (first-party — lower risk but still mutable)
- `foundry-rs/foundry-toolchain@v1` (third-party — `ci.yml` not used; `contracts-ci.yml:38-40`, `release.yml:56-59`, `slither.yml:38-40`)
- `crytic/slither-action@v0.4.0` (`slither.yml:44`) — minor pin only
- `softprops/action-gh-release@v2` (`release.yml:74`) — third-party with `contents: write` and `GITHUB_TOKEN`; a tag hijack here can publish poisoned releases.
- `github/codeql-action/{init,autobuild,analyze,upload-sarif}@v3` (first-party)

Recommendation for the *third-party* ones (foundry-toolchain, slither-action, action-gh-release): pin to a full 40-char commit SHA, e.g. `softprops/action-gh-release@<sha> # v2.x`. Dependabot’s `github-actions` ecosystem entry will keep SHAs current. First-party `actions/*` and `github/codeql-action/*` are lower priority but still recommended for defense-in-depth on a contracts repo handling user funds.

### MEDIUM

**MED-1 — `workflow_dispatch` input not validated (`release.yml:7-12`)**
```yaml
workflow_dispatch:
  inputs:
    tag:
      description: "Tag to release (must already exist on origin)"
      required: true
```
The `tag` input flows into shell expansions:
```bash
echo "value=${{ github.event.inputs.tag }}" >> "$GITHUB_OUTPUT"     # release.yml:35
TAG="${{ steps.tag.outputs.value }}"                                # release.yml:42
git describe --tags --abbrev=0 "${TAG}^"                            # release.yml:43
git log --no-merges --pretty='- %s (%h)' "${PREV}..${TAG}"          # release.yml:49
tar -czf dist/contracts-${{ steps.tag.outputs.value }}.tar.gz ...   # release.yml:69
```
A malicious tag string like `v1.0.0;rm -rf /` injected by anyone with `workflow_dispatch` permission would execute (only repo write+ users can dispatch by default, so impact is contained — still: this is a classic “Claude Bot 2024” / “tj-actions/changed-files”-style injection vector). Mitigation: add a regex `pattern:` validator, or read into env first then quote: `TAG="$INPUT_TAG"` with `env: INPUT_TAG: ${{ inputs.tag }}`. Same hygiene improvement applies to `steps.tag.outputs.value` interpolation in the `tar` line — switch to env passthrough.

**MED-2 — `softprops/action-gh-release@v2` granted `contents: write` repo-wide (`release.yml:13-14`)**
```yaml
permissions:
  contents: write
```
Set at workflow scope, so every job inherits it. Only the `release` job needs write; tighten by moving `permissions: contents: write` *into* the job and leaving the workflow-scope `permissions: { contents: read }`. Combined with HIGH-2 SHA-pinning, this shrinks blast radius if the action is ever compromised.

**MED-3 — Cache key on `contracts-ci.yml` is content-pinned (good) but no `restore-keys` fallback and no scope guard**
```yaml
key: foundry-${{ hashFiles('contracts/foundry.toml', 'contracts/remappings.txt', 'contracts/lib/**') }}
```
Not user-controllable (no `${{ github.event.* }}` interpolation) — **NO cache-poisoning vector here**. ✅ However, GitHub now isolates caches per branch by default, so a fork PR cannot poison `main`'s cache. Note for follow-up: when `contracts/lib/**` changes (submodule bump), cache misses are full rebuilds — consider `restore-keys: foundry-` for warm starts.

### LOW

**LOW-1 — `forge test` does not produce a coverage gate, only a best-effort summary (`contracts-ci.yml:61-63`)**
`continue-on-error: true` + `|| true` means coverage failures are silent. Not a security issue; a quality/observability gap. Out of scope for this audit but flagging for follow-up agents.

**LOW-2 — `slither.yml` uses `fail-on: none` (`slither.yml:48`)**
Slither findings are uploaded to the Security tab but never fail the build. Acceptable for a noisy tool, but means a contributor can land code that introduces new findings without explicit acknowledgement. Recommend `fail-on: medium` or a baseline-diff approach for the `contracts/src/**` paths after the current bulletproofing wave is complete.

**LOW-3 — `release.yml` checkout uses `submodules: recursive` + `fetch-depth: 0` while `contents: write` is in scope**
If a malicious PR ever managed to land a poisoned submodule pointer (e.g., to a tag that resolves to attacker code), the release workflow's build step (`forge build`) could execute it. Mitigated by branch protection + CODEOWNERS on `contracts/` (already present). Still: a release workflow that *also* publishes is the highest-value target in the repo.

**LOW-4 — `concurrency: cancel-in-progress: false` on releases (`release.yml:18`)**
Intentional and correct — you don't want to cancel a half-published release. Noting that this is the right call and not a bug.

### INFO / Positive findings

- **No `echo $SECRET` patterns anywhere.** Grep against `secrets\.` interpolated into `echo`/`run` lines confirms none. ✅
- **CODEOWNERS exists and covers sensitive paths** (`contracts/`, `.github/`, `script/`). `@tegridy-team` placeholder team needs to actually exist on GitHub for this to enforce — flag for follow-up.
- **`dependabot.yml` is present** and covers `npm` (frontend, indexer, root) + `github-actions` ecosystem. ✅ This addresses one item from the hunt-list outright.
- **`pull_request_template.md` exists** (not in scope for this audit but spotted during traversal).
- **Issue templates correctly redirect security disclosures** (`security.md` + `config.yml: blank_issues_enabled: false`). ✅
- **Least-privilege `permissions: contents: read`** is applied at workflow scope on `ci.yml`, `codeql.yml`, `contracts-ci.yml`, `slither.yml`. ✅ Only `release.yml` widens to `contents: write` (see MED-2).
- **`concurrency:` group set on every workflow.** ✅ Mitigates resource exhaustion / runaway-PR cost.

### Cannot verify from repo files (flag for follow-up agents)

- **Branch protection on `main`:** rules live in repo settings, not in source. Can't audit from filesystem. Recommend follow-up to confirm: required CI checks include `CI / Lint, Type Check & Test`, `CI / Build`, `Contracts CI / forge build + test`, `CodeQL`, `Slither`; require CODEOWNERS review; require linear history; restrict force-push.
- **Repo setting "Send write tokens to workflows from fork PRs":** must be confirmed disabled (default).
- **`@tegridy-team` and sub-teams (`/frontend-team`, `/contracts-team`) existence:** CODEOWNERS references them but membership lives on GitHub.
- **Whether secrets `VITE_WALLETCONNECT_PROJECT_ID` is environment-scoped or repo-scoped.** If env-scoped to a `production` environment with required reviewers, HIGH-1 risk drops to LOW.

---

## Summary table

| Severity | Count |
|---|---|
| CRITICAL | 0 |
| HIGH | 2 |
| MEDIUM | 3 |
| LOW | 4 |
| INFO/positive | 7 |
| Follow-up (cannot verify) | 4 |

---

## Top 5 fixes (priority order)

1. **HIGH-1** — Gate `VITE_WALLETCONNECT_PROJECT_ID` injection in `ci.yml` build step to non-fork-PR contexts (or move to deploy-only workflow).
2. **HIGH-2** — Pin third-party actions (`foundry-toolchain`, `slither-action`, `action-gh-release`) to commit SHAs; let Dependabot manage updates.
3. **MED-1** — Validate / env-passthrough the `tag` input in `release.yml` to close the shell-injection vector via `workflow_dispatch`.
4. **MED-2** — Move `contents: write` from workflow-scope to job-scope in `release.yml`.
5. **LOW-2** — Decide on a Slither severity gate (`fail-on: medium`) once the bulletproofing wave is finalized; otherwise findings will pile up unblocked.

---

*End of agent 085 report. No files modified. Memory directives respected (no `.env` access, no preview tools, no art changes).*
