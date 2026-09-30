# Deploy runbook

**Status: written 2026-08-02.** Before this file the procedure existed only in one
person's head and in an assistant's memory. That is the actual reason it is here — a
deploy process nobody else can execute is an outage waiting for a holiday.

---

## There are TWO deploy paths, and only one of them has a guard

| Path | Trigger | Guarded? |
| --- | --- | --- |
| **Vercel CLI** | a human runs `npx vercel --prod` | ✅ `npm run predeploy` |
| **Vercel Git integration** | a **push** to the branch configured as *Production Branch* | ❌ **nothing local runs** |

The second path is the dangerous one and no script can close it, because no local
step is involved. It is a dashboard setting.

> ### ✅ The Production Branch is `mvp-launch`. It used to be `main`; that was repointed.
>
> **Current, as of 2026-09-10.** The nearest thing this repo has to a written record of
> the setting is [`TODO_OPERATOR.md` §3](TODO_OPERATOR.md), landed 2026-09-06 in
> [#435](https://github.com/fomotsar-commits/tegridy-farms/pull/435):
>
> > Now that `mvp-launch` is the Production Branch, **a push to trunk auto-deploys with
> > no local step**, so `scripts/predeploy-check.mjs` never runs on that path
>
> Note what that costs and what it buys. It buys: production now ships trunk, so a merge
> to `mvp-launch` deploys the tree everyone is actually working on. It costs: the
> predeploy guard sits in front of the CLI path only, and the CLI path is no longer the
> common one — **trunk pushes are ungated**. If they should be gated, the guard has to
> move into CI; nothing local can close a dashboard-triggered deploy.
>
> ⚠️ **The dashboard is the authority, not this file.** No committed file sets the
> Production Branch — `frontend/vercel.json` has no `productionBranch` key and there is
> no Vercel deploy workflow under `.github/workflows/`. Anyone with a reason to be sure
> (a rollback, an incident, a custody change) reads the setting in the Vercel dashboard.
> Treat every claim here, this one included, as a report of what was true when written.
>
> #### What the 2026-08-02 note said, and why it is kept
>
> It read: *"the Production Branch is `main`, and `main` is stale"*. That was true and
> load-bearing at the time — the three most recent `environment=Production` deployments
> were `e74417aa`, `64e454c0`, `6b89b60a`, all dated 2026-07-24, all on `origin/main`
> and none on `origin/mvp-launch`; trunk had only ever received `environment=Preview`.
> A single `git push origin main` would have shipped a months-old tree with no human
> step. The repoint is what closed that.
>
> **`main` is still a live branch and is still stale**, so the second half of the old
> warning survives the repoint: measured 2026-09-10, `git rev-list --left-right --count
> origin/main...origin/mvp-launch` reports `10  1345`, and `main`'s tip
> (`e74417aa`) is dated 2026-07-23. It no longer deploys, so the failure mode is quieter
> now but not gone: a PR based on `main` still runs the full gate set (the workflows
> trigger on `branches: [main, mvp-launch]`), so it goes **green against a 2026-07-23
> tree** and then merges somewhere nothing deploys from and nothing else merges into.
> **Do not push to `main`, and do not base a PR on it — base on `mvp-launch`.**

---

## Before every CLI deploy

```bash
npm run predeploy
```

Exit 0 means the tree on disk is byte-identical to `origin/<branch>`. Exit 1 means do
not deploy, and it names which rule tripped. Run `node scripts/predeploy-check.mjs
--self-test` to prove the guard itself still works (CI does this on every push).

It blocks on: commits behind, commits ahead, a diverged sha, uncommitted changes to
tracked files, and a missing `.vercel/`. It warns on untracked files (they upload too)
and on deploying a branch other than `mvp-launch`.

**It does not check the Git-integration path.** A green run means *this tree* is safe
to push to Vercel — not that production is safe.

---

## The deploy itself

Deploy from the **repo root**, not `frontend/`. The Vercel project's Root Directory
setting already appends `frontend`, so running the CLI from inside `frontend/` targets
`frontend/frontend`.

```bash
npx vercel --prod --yes
```

This auto-aliases the production domains in one shot — no separate `vercel alias` step.

### Deploying from a worktree

Preferred, because it cannot pick up stray edits from the shared checkout. The
`.vercel/` directory is gitignored, so a fresh worktree has no project link and the
CLI would offer to create a *new* project. Copy it in, then remove it:

```bash
git worktree add /tmp/deploy origin/mvp-launch
cd /tmp/deploy
cp -r "<repo-root>/.vercel" .
npx vercel --prod --yes
rm -rf .vercel
```

---

## After every deploy: verify the render, not the build

CI green and "deployment ready" both say nothing about what a browser receives. Open
the production URL and confirm the specific thing you shipped actually changed. Two
real cases where the build was fine and the render was not:

- A deploy that reverted 262 frontend files was "successful" by every automated signal.
- Static pages kept rendering while three API handlers hard-403'd, so a smoke test of
  the homepage passed while login, Solana reads and swap POSTs were dead.

Also worth knowing: **stat panels render `0.000` / `$0.00000000` while loading.**
Screenshot a loading frame and you will report a fabricated-zero bug that does not
exist. Wait for values to populate before judging.

---

## Adding a new production origin

Every origin-gated handler under `frontend/api/` carries its own hardcoded allowlist.
Adding a domain to DNS is not enough — a browser on the new origin gets a CORS refusal
from each handler that does not list it.

`frontend/api/__tests__/canonical-origin.test.js` enforces this both ways: every
origin-gated surface must allow the canonical origin, and none may name a domain the
project does not control. It walks `api/` and fails on a handler missing from its own
list, so adding a handler without adding it to the guard is caught.

Do not add an origin the project does not own. On 2026-08-02 a lapsed domain was found
still in the allowlist of thirteen surfaces — and, on four of them, as the fallback
handed to *unmatched* origins.

---

## Moving the source links to another git host

Every "read the source" link the site shows goes to our own domain first:
`https://memetics.finance/source/<path>` for a file or folder, and `/source` for the repo.
`/source-issues` is the issue list, linked only from the security policies. Four redirects in
`frontend/vercel.json` send them on to the git host. One of them, `/source/info/refs`, is for git
itself: it lets `git clone https://memetics.finance/source` work, and `held-through.json`
publishes that address as the repo. So when the code moves hosts, the site and
`held-through.json` keep working after **one edit: four lines of `frontend/vercel.json`**. No
page changes. A program's on-chain security.txt gets the same protection once it uses these
links (cp-swap's does not yet: TODO_OPERATOR O-0929-10).

**Today the links go to GitHub, the primary.** These are the four lines in
`frontend/vercel.json`, one rule per line:

```json
    { "source": "/source", "destination": "https://github.com/fomotsar-commits/tegridy-farms", "permanent": false },
    { "source": "/source-issues", "destination": "https://github.com/fomotsar-commits/tegridy-farms/issues", "permanent": false },
    { "source": "/source/info/refs", "destination": "https://github.com/fomotsar-commits/tegridy-farms.git/info/refs", "permanent": false },
    { "source": "/source/:path*", "destination": "https://github.com/fomotsar-commits/tegridy-farms/blob/mvp-launch/:path*", "permanent": false }
```

**If GitHub is gone, point them at the GitLab standby.** This is one step of the GitHub-gone
failover. Replace the four lines above with these four, exactly, then merge:

```json
    { "source": "/source", "destination": "https://gitlab.com/memetics-finance/tegridy-farms", "permanent": false },
    { "source": "/source-issues", "destination": "https://gitlab.com/memetics-finance/tegridy-farms/-/issues", "permanent": false },
    { "source": "/source/info/refs", "destination": "https://gitlab.com/memetics-finance/tegridy-farms.git/info/refs", "permanent": false },
    { "source": "/source/:path*", "destination": "https://gitlab.com/memetics-finance/tegridy-farms/-/blob/mvp-launch/:path*", "permanent": false }
```

To go back to GitHub, put the first four lines back. If the GitLab group is ever renamed from
`memetics-finance`, change it in all four lines above and in `OUR_REPOS` in
`frontend/src/test/sourceLinks.test.ts`.

**Before any move, the target must be ours and public.** Merging to `mvp-launch` deploys the
redirects. A redirect to a name nobody owns sends every trust link on the site to whoever
registers that name first. A private project sends them to a sign-in page. Just before the
merge, check the target:

- GitLab: `curl -s https://gitlab.com/api/v4/projects/memetics-finance%2Ftegridy-farms` must return
  JSON with `"visibility":"public"`. `404 Project Not Found` means stop: the project is missing
  or private, and the API does not say which.
- GitHub: `curl -s https://api.github.com/repos/fomotsar-commits/tegridy-farms` must return
  `"visibility": "public"`.

Then run `npx vitest run src/test/sourceLinks.test.ts` in `frontend/`, since CI may be down
during a failover. The test lists our repo's homes (`OUR_REPOS`) and fails if the rules point
anywhere else, so a mistyped name fails before it deploys. On 2026-09-30 both checks
passed: the GitLab project is public, and a file (200), a folder (302 to `/-/tree/`), the issue
list (302 to `/-/work_items`) and `info/refs` (200) all answered without a sign-in.

For any other host, keep the repo's address identical in all four lines and use the host's
shapes below (the test knows them and fails otherwise). Keep `/source/info/refs` above
`/source/:path*`, keep the branch `mvp-launch`, and keep `"permanent": false`: browsers do not
cache a 307 by default, so the next move reaches every browser at once.

| Host | `/source` | `/source-issues` | `/source/info/refs` | `/source/:path*` |
| --- | --- | --- | --- | --- |
| GitHub (primary) | `<repo>` | `<repo>/issues` | `<repo>.git/info/refs` | `<repo>/blob/mvp-launch/:path*` |
| GitLab (standby) | `<repo>` | `<repo>/-/issues` | `<repo>.git/info/refs` | `<repo>/-/blob/mvp-launch/:path*` |
| Bitbucket (optional third copy) | `<repo>` | `<repo>` (Bitbucket removed its issue tracker on 2026-08-20) | `<repo>.git/info/refs` | `<repo>/src/mvp-launch/:path*` |

Both `blob` views open folders too: GitHub sends a folder to `/tree/` with a `301`, GitLab to
`/-/tree/` with a `302`. A raw view does neither, so never use one. A path the repo does not
have is a `404` on GitHub, but on GitLab it is a `302` to the repo root, so there a wrong link
looks fine when clicked. For that reason the test checks paths against `git ls-files`, not
against the host: it renders the pages that link source and checks the path of every link they
show, and does the same for every literal path in the code. It also refuses any use of
`SOURCE_URL` it cannot check, such as `SOURCE_URL + '/x'`. After the deploy, check one file and
the root: `curl -sI https://memetics.finance/source/docs/AUDITS.md` and
`curl -sI https://memetics.finance/source` should each answer `307` with a `location` on the
new host, and that location should open the file, not a 404 or the repo root. Then check git:
`git ls-remote https://memetics.finance/source mvp-launch` should print one commit.

---

## Production can be AHEAD of trunk

Because the CLI ships the working tree, code can reach production having never reached
a remote. A `www.memetic.fun` → apex redirect was live in production while existing in
no commit on any branch; deploying clean trunk would have silently removed it.

So when production behaves differently from what the code says, there are **two**
questions, not one: is trunk wrong, or is the deploy not trunk? Diff the live render
against `origin/mvp-launch` before writing a fix — otherwise you re-fix shipped work.

---

## Function count ceiling

The Vercel Hobby plan caps serverless functions at **12**. `frontend/api/` currently
resolves to 10 real functions (the rest of the `.js` files are `__tests__`). When
adding an endpoint, add a `?resource=` branch to an existing catchall rather than a new
file, or the deploy fails on the cap.
