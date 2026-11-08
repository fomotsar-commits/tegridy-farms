# CLAUDE.md

The repo behind memetics.finance, the venue. Repo, Vercel project and old docs say
Tegridy/Tegriddy Farms: the earlier name. Workspaces: `frontend/` (Vite + React, the site
and `api/`), `contracts/` (Foundry), `solana/` (Anchor), `indexer/`, `indexer-solana/`,
`bot/`, `scripts/` (root ops tools).

## Trunk

`mvp-launch` is the default branch and the trunk. GitHub is primary; GitLab is a standby
every push reaches (law 15).
`main` is the diverged fork `archive/main-2026-07-23` (GitLab `archive/main`): never branch
from it. A merge to `mvp-launch` on the primary deploys `frontend/` to production within
minutes; moving it on any remote counts as a production deploy.

## Build and test (Node 24, `.nvmrc`; what `.github/workflows/ci.yml` runs)

```
cd frontend
npm ci --ignore-scripts
npm run lint
npx tsc -b --noEmit  # -b is load-bearing: plain tsc checks zero files
npm test  # vitest run
npm run build
npx playwright install --with-deps chromium webkit
npx playwright test  # e2e, on vite preview of the build
cd ../contracts && forge build && forge test
```

Root tools: `node --test scripts/lib/redact-url.test.mjs` and each
`node scripts/<tool>.mjs --self-test` ci.yml names. Gotchas (Windows, Git Bash):
`docs/DEVELOPING.md`. No CI host: `bash scripts/ci/local-gates.sh <root|frontend|contracts|solana|all>`
runs the same gates.

## The one to-do

`docs/TODO_OPERATOR.md`. Every other plan is history and opens with a pointer there.

## Laws, one line each

1. No em dash in venue-voice copy. `frontend/e2e/em-dash-zero.spec.ts` pins each route's count exactly; it only comes down.
2. The first frame is the hero (`frontend/e2e/first-frame.spec.ts`, `src/lib/firstFrame.test.ts`).
3. The venue reads heat and never computes it: the island's oracle rules, and the tier word beside a wallet is the served one.
4. Never `wallet_count`, `person_id` or a link to memetics.wtf/island.
5. The venue logs what it did. Why the island's values are what they are is the island's to publish, never ours.
6. A line is certified from a screenshot; a timing from a production build, never a dev server.
7. Every fix is seen red first: its test fails on the pre-fix code before it passes.
8. A search that could not run is not a negative result. Say it did not complete.
9. A comment states the present constraint in six lines or fewer. The story goes in the commit body. Recut a file when you touch it, never as a sweep.
10. A note rides the PR of the work that taught it, or one `docs/notes-<date>` PR per session. Merged branches are deleted.
11. Docs skip the build: a PR touching only `**/*.md` and `docs/**` runs the Doc guards job alone.
12. The root is a front door (`src/test/frontDoor.test.ts` pins the list). Docs in `docs/`, audits in `docs/audits/`, old plans in `docs/archive/`.
13. `CHANGELOG.md` is one plain line per user-facing change, newest thirty days; the long form is in git.
14. Clone outside OneDrive or any synced folder: placeholders read as symlinks and scanners skip them.
15. Read `docs/GIT_HOSTING.md` before any remote operation. Moving `mvp-launch` anywhere, or any Vercel or Railway deploy or promote, needs the owner's go.
16. A launch on any rail is a venue launch unless it is born in $BAYLA.
17. Every launch page shows the maker's create-buy and its lock before anyone else can buy.
18 to 23. The face's laws: `docs/FACE_LAWS.md`.
24. Before any signing-page press, read back its "Ready to execute ... proposal #N" line against the step; the signature goes in the block.
25. Which setting builds what: `docs/WORKSHOP_SETTINGS.md`. Fable at max for a stranger's screen and its words, money's shape, shipping order and the read at 390 before merge; Opus at max for a specified build, its red test and fix; lower for lint, types, counts, docs. A PR's body names its setting first.

## NOTES.md: headings first

A log of traps, newest first, too long to read whole. Run `grep -n '^## ' NOTES.md`
(one line per entry: a date, then the wrong belief). Open an entry only when its
heading matches the task; read it from that line to the next `## `.
