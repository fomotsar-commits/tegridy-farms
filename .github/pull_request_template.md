<!--
Thanks for your contribution! Please fill out the sections below.
PRs that do not follow this template may be closed or asked to be revised.
-->

## What

<!-- A short summary of the change. What does this PR do? -->

## Why

<!-- Motivation and context. Link related issues: "Closes #123" -->

## How

<!-- High-level description of the implementation approach. Call out anything non-obvious. -->

## Screenshots / Recordings

<!-- For frontend / UX changes, include before/after screenshots or a short recording.
     For contract changes, paste gas-report diffs if relevant. Delete this section if not applicable. -->

| Before | After |
| ------ | ----- |
|        |       |

## Tests

- [ ] Unit tests added / updated
- [ ] Integration or E2E tests added / updated (if applicable)
- [ ] Foundry tests pass locally (`forge test`) — contract changes only
- [ ] Frontend typecheck + lint pass locally (`npm run typecheck`, `npm run lint`)
- [ ] Manual testing performed on desktop, iPhone 14+, and iPad (responsive — all affected pages)
- [ ] New edge cases, reverts, and failure modes are covered

## Audit Impact

- [ ] **This PR touches audited / security-sensitive code** (contracts, access control, oracles, upgrade paths, user funds, signature verification, fee math, etc.)

If the box above is checked, please describe:
- Which audited invariants are affected
- Whether a re-audit, formal verification, or additional review is required
- Any new trust assumptions introduced

## Checklist

- [ ] Branch is rebased on latest `main`
- [ ] Commits follow conventional-commit style (`feat(...)`, `fix(...)`, `docs(...)`, etc.)
- [ ] No secrets, private keys, or `.env` values committed
- [ ] Documentation updated (README, inline comments, changelog) where relevant
- [ ] Breaking changes are called out clearly in the description

## Deployment notes

<!-- Migration steps, env vars to update, deploy script order, subgraph re-deploy, etc. Delete if N/A. -->
