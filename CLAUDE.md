# CLAUDE.md

The repo behind memetics.finance, the venue. Repo, Vercel project and old docs say
Tegridy/Tegriddy Farms: same project, earlier name. Workspaces: `frontend/` (Vite + React,
the site and `api/`), `contracts/` (Foundry), `solana/` (Anchor), `indexer/`,
`indexer-solana/`, `bot/`, `scripts/` (root ops tools).

## Trunk

`mvp-launch` is the default branch and the trunk. It lives on the primary host named in
`docs/GIT_HOSTING.md`; no single host is load-bearing. `main` is a diverged fork (on the hosts,
`archive/main`), never branch from it. Any push or merge that moves `mvp-launch` on any
remote deploys `frontend/` to production within minutes.

## Build and test (Node 20, `.nvmrc`; what `.github/workflows/ci.yml` runs)

```
cd frontend
npm ci --ignore-scripts
npm run lint
npx tsc -b --noEmit      # -b is load-bearing: plain tsc checks zero files
npm test                 # vitest run
npm run build
npx playwright install --with-deps chromium webkit
npx playwright test      # e2e, against vite preview of the build
cd ../contracts && forge build && forge test
```

Root tools: `node --test scripts/lib/redact-url.test.mjs`, and each
`node scripts/<tool>.mjs --self-test` that ci.yml names. On Windows use PowerShell for any
git argument containing `:.github` (Git Bash mangles it). Gotchas: `docs/DEVELOPING.md`.

## The one to-do

`docs/TODO_OPERATOR.md`. Every other plan in `docs/` and `docs/archive/` is history and opens with a pointer there.

## Laws, one line each

1. No em dash in venue-voice copy. `frontend/e2e/em-dash-zero.spec.ts` pins each route's count exactly; it only comes down.
2. The first frame is the hero (`frontend/e2e/first-frame.spec.ts`, `src/lib/firstFrame.test.ts`).
3. The venue reads heat and never computes it: the island's oracle is the ruler, and the tier word beside a wallet is the served tier.
4. Never `wallet_count`, `person_id` or a link to memetics.wtf/island.
5. The venue logs what the venue did. Why the island's values are what they are is the island's to publish, never ours to narrate.
6. A line is certified from a screenshot; a timing from a production build, never a dev server.
7. Every fix is seen red first: its test fails on the pre-fix code before it passes.
8. A search that could not run is not a negative result. Say it did not complete.
9. A comment states the present constraint in six lines or fewer. The story goes in the commit body. Recut a file when you touch it, never as a sweep.
10. A note rides the PR of the work that taught it, or one `docs/notes-<date>` PR per session. Merged branches are deleted.
11. Docs do not run the money paths: a PR touching only `**/*.md` and `docs/**` skips the build; the Doc guards job still runs.
12. The root is a front door (`src/test/frontDoor.test.ts` pins the list). Live docs live in `docs/`, audits in `docs/audits/`, old plans and reports in `docs/archive/`.
13. `CHANGELOG.md` is one plain line per user-facing change, newest thirty days; the long form lives in git.
14. Clone outside OneDrive or any synced folder: a placeholder file reads as a symlink and scanners skip it.
15. Read `docs/GIT_HOSTING.md` before any remote operation. Moving `mvp-launch` anywhere, or a Vercel or Railway deploy or promote, needs the owner's go each time.

## NOTES.md: headings first

A log of traps, newest first, too long to read whole. Run `grep -n '^## ' NOTES.md`
(one line per entry: a date, then the belief that was wrong). Open an entry only when its
heading matches the task; read it from that line to the next `## `.
