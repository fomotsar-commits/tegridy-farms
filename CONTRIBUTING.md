# Contributing to Tegriddy Farms

Thanks for your interest in making Tegriddy Farms better. This project welcomes contributions from the community across code, content, and community-building activities.

## Ways to Contribute

There are plenty of ways to help, no matter your skill set:

- **Code** — Fix bugs, implement features, improve performance, or refactor existing modules in the frontend, contracts, or indexer.
- **Documentation** — Improve READMEs, guides, inline comments, or write tutorials for new users.
- **Bug reports** — File detailed issues when you find something broken. Include reproduction steps, environment details, and screenshots/logs when relevant.
- **Feature requests** — Open an issue describing the problem and your proposed solution. Discussion first, code second.
- **Translations** — Help localize the frontend into additional languages.
- **Art & design** — Illustrations, icons, marketing assets, and UX improvements are all welcome.

## Dev Setup

The repo has three main workspaces. Install prerequisites (Node 20+, Foundry, Git) and then:

**Frontend**

```bash
cd frontend
npm install
npm run dev
```

**Contracts**

```bash
cd contracts
forge install
forge test
```

**Indexer**

```bash
cd indexer
npm install
```

Copy `.env.example` to `.env` in each workspace and fill in the required values before running anything that touches RPC endpoints or external services.

## ⚠️ The trunk is `mvp-launch`, not `main`

**`mvp-launch` is the repository's default branch and its real trunk.** Every merge lands
there and it is what deploys to production.

`main` has diverged substantially — a merge between the two reports a **63-file conflict** —
and it carries its own duplicate fixes and a red test baseline that `mvp-launch` does not.
Branching from it means rebasing onto a tree that has moved differently for months.

This guide told contributors to branch from `main` and open PRs against `main` until
2026-09-04. If you have a branch in that state, rebase it onto `mvp-launch` before opening a
PR. Run `git log HEAD..mvp-launch` **before your first edit** so you know what you are behind.

**Merging to `mvp-launch` ships.** Vercel auto-deploys it to memetic.fun and
memetics.finance within a couple of minutes, and a red merge ships exactly as fast as a green
one — so gate on checks that actually ran, not on a green tick. Note that a PR with a merge
conflict runs almost no CI at all: if you see only two or three checks instead of ~30, the
branch is conflicting, not passing.

## Coding Standards

- **TypeScript** — Strict mode is required. Do not introduce `any` unless there is no reasonable alternative, and prefer `unknown` with narrowing when the type is truly dynamic.
- **Solidity** — Target `0.8.26`. Follow the existing style in `contracts/src` (NatSpec on public/external functions, custom errors over `require` strings, checks-effects-interactions).
- **Formatting** — Match the indentation and spacing of the file you are editing. Before opening a PR:
  - Frontend: `npm run precommit` (this is `npm run lint && tsc -b --noEmit`). **There is no
    Prettier config in this repo** — this guide told you to run `npx prettier --check .`
    until 2026-09-04, which would have reformatted the tree to Prettier defaults that nothing
    here follows. ESLint is the formatter of record.
  - Contracts: `forge fmt --check`
- **Tests** — New logic needs tests. Frontend uses Vitest/Playwright; contracts use Foundry. CI will run them; please run locally first.
- **A test only counts once it has failed on the pre-fix code.** This repo has been burned
  repeatedly by tests that pinned the bug instead of the fix — an encoder and its test sharing
  one wrong belief, with CI green the whole time. Show the red before you show the green.
- **Responsive UI** — Frontend changes must look and behave correctly on desktop, iPhone 14+, and iPad viewports.

## PR Process

1. **Fork** the repository on GitHub.
2. **Branch** from **`mvp-launch`**, not `main`, using a descriptive name (`feat/lp-farm-boost`, `fix/lending-oracle-guard`, `docs/contributing-guide`). See the trunk note below — this is not a style preference.
3. **Commit** your changes with clear messages (see convention below). Keep commits focused — one logical change per commit where practical.
4. **Push** your branch and **open a PR** against **`mvp-launch`**. Fill in the PR template: what changed, why, how it was tested, and any follow-ups.
5. **CI must pass** — build, lint, and tests. Draft PRs are fine while you iterate.
6. **Review** — At least one maintainer review is required before merge. Address feedback by pushing follow-up commits (avoid force-pushing once review has started, unless asked).
7. **Squash merge** is the default; the maintainer will handle the merge once approvals and CI are green.

## Commit Message Convention

This repo follows **Conventional Commits**, as reflected in the existing history (`feat(...)`, `fix(...)`, `docs(...)`, `chore(...)`, etc.).

Format:

```
<type>(<scope>): <short summary>

<optional body explaining the why>

<optional footer, e.g. BREAKING CHANGE: ...>
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`, `build`, `ci`. Scope is usually the workspace or subsystem (`contracts`, `frontend`, `indexer`, `deploy`).

Example:

```
feat(frontend): add LP farm APR chart to pool page
```

## Good First Issues

Looking for a place to start? Check the issue tracker for the **`good first issue`** label. These are scoped, well-documented tasks suitable for first-time contributors. The **`help wanted`** label flags larger tasks where maintainer bandwidth is limited and community help is especially welcome.

If nothing open looks right, comment on any issue and a maintainer will help scope something for you.

## Contact

- **Issues & PRs** — Primary channel for anything code-related; open them on GitHub.
- **Security** — For vulnerabilities, please do **not** open a public issue. See `SECURITY.md` for the private disclosure process.
- **General questions** — Start a GitHub Discussion or reach maintainers through the community links in the project README.

By contributing, you agree that your contributions will be licensed under the same license as the project. Thanks for helping grow Tegriddy Farms.
