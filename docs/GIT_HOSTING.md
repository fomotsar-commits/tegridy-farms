# Git hosting: where the code lives, and how to keep it alive

**The rule: no single git host is load-bearing.** The code lives in four places. Any one of them
can disappear and we keep building and deploying.

Read this page before any remote operation: a push, a merge, a mirror change, a deploy. The owner
onboarding checklist is section 2.

The two host addresses are **proposed**. The group `memetics` does not exist yet. If a name
changes, change these two lines; every command below uses them. Run the commands in Git Bash
from the root of a clean clone or worktree.

```
PRIMARY=https://gitlab.com/memetics/tegridy-farms.git
STANDBY=https://bitbucket.org/memetics/tegridy-farms.git
```

---

## 1. What happened, and the setup now

On 2026-09-24 GitHub suspended the account `fomotsar-commits`. Every git, `gh` and API call to it
returns 403. Production kept serving, but nothing could merge or deploy through GitHub. The CI,
the crons, the PR history and Vercel's deploy trigger all lived there. The commits did not: every
one of them was still in a local clone or a bundle. On 2026-09-29 they were combined into one
vault with 605 branches and 700 tags. That build missed 11 of the OneDrive clone's 12 stash
entries (only the newest is a ref); the fresh vault in 2A step 7 takes them all.

So the setup is now:

```
   your clones and worktrees
        |  git push origin   (one push goes to BOTH hosts)
        v
 +--------------------+    push mirror, ~5 min    +----------------------+
 | GitLab   PRIMARY   | ------------------------> | Bitbucket   STANDBY  |
 | memetics/          |                           | memetics/            |
 | tegridy-farms      |                           | tegridy-farms        |
 +--------------------+                           +----------------------+
        | merge to mvp-launch                            .
        v                                                . only in a drill (5A)
 +--------------------+ <................................
 | Vercel: production |
 +--------------------+

 Cold copies (no host needed):
   C:\Users\jimbo\git-vault\tegridy-farms.git   the vault: every ref, built 2026-09-29
   C:\Users\jimbo\OneDrive\git-vault\           daily bundles + SHA256SUMS, newest 14 kept

 Later: GitHub becomes a read-only copy, fed by GitLab's push mirror. Never primary again.
```

| Place | Job | If it dies |
|---|---|---|
| GitLab (gitlab.com) | Primary: MRs, protected trunk, Vercel's trigger | Bitbucket takes over in about 10 minutes (5A) |
| Bitbucket (bitbucket.org) | Hot standby, Vercel-compatible | GitLab keeps going; re-seed Bitbucket from a mirror clone of GitLab (5D) |
| The vault | Every ref from every clone and bundle, off OneDrive | Build a fresh one with `consolidate-refs.sh` (2A step 7). It reads the old one too |
| OneDrive bundles | Daily copy of every repo, including each clone's last view of the hosts | The hosts and clones still have everything |
| Vercel | Serves memetics.finance | Instant Rollback, or a CLI deploy from any copy (5B) |

Codeberg is excluded: its terms ban cryptocurrency projects. SourceHut too. We never make a second
GitHub account, ever: GitHub's abuse filters flag that as ban evasion.

The scripts, all in `scripts/git-hosting/`:

| Script | What it does |
|---|---|
| `consolidate-refs.sh` | Builds a NEW vault from the clones, the old vault and the bundles, including every stash entry. Never overwrites a ref; proves 0 lost. |
| `push-all.sh <repo> <url> [--gitlab] [--dry-run] [--trunk <b>]` | Pushes every branch and tag, then proves the host holds exactly that set. Never forces. `main` goes up as `archive/main`. Refuses a working clone whose branches are only remote-tracking refs. |
| `set-remotes.sh <clone> <primary> [<standby>] [--fix-email <addr>]` | origin fetches from the primary and pushes to both hosts. A GitHub origin becomes a read-only `github` record. |
| `backup-bundles.sh [<dest>]` | One verified bundle per repo per day (branches, tags and remote-tracking refs), newest 14 kept, SHA256SUMS refreshed. |
| `register-backup-task.ps1` | Registers the daily 03:30 backup task, which pings a healthchecks.io check. |
| `test/run-all.sh` | Tests all of the above on throwaway repos. CI runs it. |

---

## 2. Owner onboarding: do these in order

Only you can do this section. It takes about two hours. Agents cannot create accounts, sign in, or
push to a new host without your go.

### 2.0 Before you start (today, 15 minutes)

1. Check how you log in to **Supabase**, **Railway** and **Vercel**. If any of them is "Continue
   with GitHub" only, add an email login plus 2FA or a passkey now. The Supabase project is named
   "fomotsar-commits's Project", which hints at a GitHub login. It holds the only copy of signed
   orders.
2. Confirm the offline copy of `BACKUP_PASSPHRASE` exists. It is the only copy. Without it, every
   Supabase backup made by the old GitHub workflow is unreadable.
3. Git for Windows is installed (it includes Git Credential Manager, which does every sign-in
   below in your browser).

### 2A. GitLab: account, group, empty project (30 minutes)

1. Go to `gitlab.com/users/sign_up`. Sign up with **email and password**. Never "Sign in with
   GitHub" (or Google). Verify the email. If the welcome screens push you to create a project, use
   a throwaway name like `scratch`, never `tegridy-farms`.
2. Turn on 2FA: avatar > **Edit profile** > **Account** > **Enable two-factor authentication**.
   Scan the QR code with an authenticator app, enter the code and your password. **Save the
   recovery codes offline** (paper, or next to the keys), not in OneDrive and never in chat.
3. Create the group: **Create new (+)** > **New group** > **Create group**. Name `memetics`,
   visibility **Public**. A public group avoids the Free plan's 5-member cap. The project inside
   stays private until you decide otherwise, and never before 2H.
4. Before any project exists, in the group: **Settings > CI/CD**.
   - **Auto DevOps**: untick "Default to Auto DevOps pipeline", Save.
   - **Runners**: turn off "Enable instance runners for this group".
   - Why: GitLab's own runners burn a 400-minute monthly quota and ask for identity checks. Auto
     DevOps can start a pipeline on the first push because the repo has a `package.json`. Our CI
     will run on our own runner later.
5. Create the project: in the group, **New project** > **Create blank project**. Name
   `tegridy-farms`, visibility **Private**. Under Project Configuration **untick every box**:
   "Initialize repository with a README", and any SAST or secret-detection box. Each of those
   commits a file, which creates a `main` branch. The new project page must say the repository is
   empty.
6. In the project, before the first push: **Settings > CI/CD** > Auto DevOps off, and under
   Runners turn instance runners off.
7. First push, from a fresh vault. The 2026-09-29 vault holds only 1 of clone A's 12 stash
   entries, and sessions have committed since. The fresh build reads the old vault as a source
   and never changes it:
   ```
   VAULT=/c/Users/jimbo/git-vault/tegridy-farms-$(date +%F).git bash scripts/git-hosting/consolidate-refs.sh
   ```
   It must print `staged commits NOT reachable from refs/heads+refs/tags: 0` and
   `commits that could not be staged: 0`, and end with `OK vault=...`. Then push:
   ```
   V=/c/Users/jimbo/git-vault/tegridy-farms-<date>.git      # the fresh vault
   bash scripts/git-hosting/push-all.sh "$V" "$PRIMARY" --gitlab --dry-run
   bash scripts/git-hosting/push-all.sh "$V" "$PRIMARY" --gitlab
   ```
   - The first command opens a browser window. That is Git Credential Manager's gitlab.com
     sign-in. Approve it. No token is typed anywhere.
   - `--gitlab` adds `-o ci.skip`, so the push starts no pipeline. `mvp-launch` goes first, which
     should make it the default branch (step 8 checks). `main` arrives as `archive/main`.
   - Success is one line: `OK: the host holds exactly the local set (N refs).` Anything else:
     stop. The script lists every `MISSING`, `DIFFERS` or `EXTRA` ref.
   - Size is fine: about 150 to 220 MB against GitLab's 5 GiB push limit and 10 GiB repo limit.
8. After the push, in the project:
   - **Settings > Repository > Branch defaults**: default branch = `mvp-launch`.
   - **Settings > Repository > Branch rules** > `mvp-launch` > **View details** (or **Add branch
     rule**): Allowed to merge = **Maintainers**. Allowed to push and merge = **No one**. Allowed
     to force push = **off**.
   - **Settings > Merge requests**: Merge method = **Merge commit with semi-linear history**. Tick
     **Enable "Delete source branch" option by default**. Save.
   - **Do not** tick **Pipelines must succeed** (Settings > Merge requests > Merge checks) yet.
     GitLab says a merge request with no pipeline at all cannot merge. Until our runner is online
     and `.gitlab-ci.yml` exists, no MR has a pipeline, so nothing could merge, not even an urgent
     fix. Turn it on the day a runner passes its first pipeline, and keep one job that runs on
     every MR (a docs-only MR would otherwise be stuck).

### 2B. Bitbucket: the hot standby (20 minutes)

1. Go to `bitbucket.org` and sign up with **your email**, not a Google, Apple, Microsoft or GitHub
   button. Turn on two-step verification in your Atlassian account (`id.atlassian.com` >
   **Security** > **Two-step verification**).
2. When Bitbucket asks for a workspace, name it `memetics`.
3. **Create > Repository**. Make a project if it asks (any name). Repository name
   `tegridy-farms`, **private**, "Include a README?" = **No**, .gitignore = **No**. Under advanced
   settings set the default branch name to `mvp-launch`. The Free plan allows 1 GB per workspace;
   our repo fits with room to spare.
4. Seed it with the same script, **without** `--gitlab` (Bitbucket does not take GitLab's push
   option). Git Credential Manager opens a Bitbucket sign-in in the browser.
   ```
   bash scripts/git-hosting/push-all.sh "$V" "$STANDBY" --dry-run
   bash scripts/git-hosting/push-all.sh "$V" "$STANDBY"
   ```
5. Protect `mvp-launch` on Bitbucket **before** the mirror exists: repository **Settings >
   Workflow > Branch restrictions > Add a branch restriction**, branch `mvp-launch`. Leave
   **Allow rewriting branch history** and **Allow deleting this branch** unticked (the defaults),
   with no exemptions, so they bind everyone, the mirror included. Keep write access for your own
   account: the mirror pushes with your token.
   - Why: the mirror force-updates Bitbucket to match GitLab. After a failover (5A), a GitLab that
     comes back would rewind Bitbucket's newer `mvp-launch` and so roll production back. With
     this restriction the mirror can only move `mvp-launch` forward; anything else fails loudly.
6. Make the token GitLab's mirror will use. Bitbucket app passwords stopped working on
   2026-06-09; use an API token. Avatar > **Account settings** > **Security** > **Create and manage
   API tokens** > **Create API token with scopes**. Name `gitlab-push-mirror`, expiry one year
   (write the date in section 7C), app **Bitbucket**, scopes `read:repository:bitbucket` and
   `write:repository:bitbucket`. It is shown once. Paste it only into GitLab's form in the next
   step. Never into chat, a file or a commit.
7. In GitLab: project > **Settings > Repository > Mirroring repositories**.
   - Git repository URL: `https://bitbucket.org/memetics/tegridy-farms.git`
   - Mirror direction: **Push**. Authentication: username and password.
   - Username: your Bitbucket username exactly as your Bitbucket profile shows it (it is
     case-sensitive), or `x-bitbucket-api-token-auth`. Password: the API token.
   - **Keep divergent refs: off.** GitLab is the truth, so a feature branch rebased on GitLab is
     rebased on Bitbucket too. Step 5 keeps this from ever rewinding `mvp-launch`. GitLab lets
     you change this setting later only through its API, so set it now. **Only mirror protected
     branches: off.** We want every branch.
   - **Mirror repository**, then **Update now**. Check "Last successful update".
   - Branches deleted on GitLab after a merge are deleted on Bitbucket at the next mirror push.
8. Why both the mirror and the second push URL of 2C: the mirror also carries merges made in the
   GitLab UI. The second push URL keeps Bitbucket current when GitLab is down or has banned us,
   which is exactly when the mirror stops.

### 2C. Point every clone at the new hosts (5 minutes)

```
bash scripts/git-hosting/set-remotes.sh /c/Users/jimbo/dev/tegridy-farms "$PRIMARY" "$STANDBY"
bash scripts/git-hosting/set-remotes.sh "/c/Users/jimbo/OneDrive/Desktop/tegriddy farms" "$PRIMARY" "$STANDBY" \
  --fix-email <the email on your GitLab account>
git -C /c/Users/jimbo/dev/tegridy-farms fetch origin
```

- origin now fetches from GitLab and pushes to GitLab and Bitbucket. The old GitHub remote is
  renamed `github`. Its `refs/remotes/github/*` stay as the frozen record of GitHub on 2026-09-24.
  Pushing to it fails on purpose, and `git fetch --all` skips it.
- Branches that tracked GitHub are re-pointed to origin. `git remote rename` moves every branch's
  upstream along with it, so without this a bare `git push` would still go to GitHub.
- The OneDrive clone commits as `fomotsar-commits@users.noreply.github.com`. GitLab and Vercel
  cannot link that address to you. In a GitLab group, Vercel only builds commits whose author is a
  member of the Vercel team. `--fix-email` sets the address for new commits. Old history stays as
  it is; that is harmless.
- Worktrees share their clone's settings, so one run per clone covers all of its worktrees.
- Each clone also has a local `mvp-launch` that is stale. Never push it; `push-all.sh` refuses
  a trunk that is behind any `mvp-launch` it can see.

### 2D. Vercel: from GitHub to GitLab (30 minutes)

**The safe order.** Get these wrong and production silently reverts.
- Today production is exactly trunk `434fb635` (checked 2026-09-29: `held-through.json` shows
  `434fb6352dcb`). No hand deploy is live.
- Push every ref **before** connecting Vercel (2A step 7). After connecting, each branch push
  starts a paid preview build of about 7 billable minutes.
- Vercel picks `main` as the production branch when it connects. That is why `main` lives on the
  hosts only as `archive/main`, and why you set Branch Tracking right after connecting.
- The **first MR on GitLab is the ship branch**. On 2026-09-29 that is `ship/2026-09-26`: 79
  commits ahead of trunk, 0 behind. Check whether a newer ship branch replaced it. Its merge is
  the first GitLab-driven production deploy.
- **Never let a hand deploy get ahead of GitLab's `mvp-launch`.** The next merge would quietly
  roll it back. If an outage forces a hand deploy, get that exact commit onto `mvp-launch` on
  GitLab before anything else merges.

**Phase A, before touching anything**
1. vercel.com > avatar > **Account Settings > Authentication**: add a **passkey**. In a private
   window, check that email login (one-time code) works. Do not run `vercel logout`.
2. Write down what production is: `npx vercel inspect memetics.finance` shows
   `dpl_J2TrMUQxPRuTkbeBKRCczW2nSYD3`. `curl -s https://memetics.finance/held-through.json`
   shows `"commit": "434fb6352dcb"`.

**Phase B, take GitHub out of the deploy path** (safe today)

3. Project **tegridy-farms > Settings > Build and Deployment > Ignored Build Step > Custom**:
   ```
   if [ "$VERCEL_GIT_PROVIDER" = "github" ]; then exit 0; fi; exit 1
   ```
   Exit 0 cancels a build and exit 1 runs it. Any build that GitHub triggers is cancelled.
   GitLab and Bitbucket builds run. It is a project setting, so no pushed commit can undo it.
4. **Settings > Environments > Production > Branch Tracking**: turn **off** "Auto-assign Custom
   Production Domains". Until you turn it back on, a production build waits as **Staged** until
   you promote it.
5. **Settings > Git > Connected Git Repository > Disconnect** (CLI: `npx vercel git disconnect`).
   Env vars, domains, deployments and settings stay. The production branch setting is erased;
   step 9 puts it back.
6. Do steps 3 to 5 again for the project **memetic-fun-lab-proxy** (memetic.fun). Its trunk is
   `main`.

**Phase C, connect GitLab** (after 2A to 2C)

7. **Account Settings > Authentication**: add **GitLab** (this gives Vercel GitLab `api` access;
   you must be Maintainer). Add **Bitbucket** now too, so the failover drill needs no new grant.
8. Project **tegridy-farms > Settings > Git > Connect Git Repository > GitLab >
   memetics/tegridy-farms**.
9. **Right away: Settings > Environments > Production > Branch Tracking = `mvp-launch`, Save.**
   Check it without printing any secret:
   ```
   MSYS_NO_PATHCONV=1 npx vercel api /v9/projects/prj_J1FvjRMmzfpMy8bfAnxC15k4dILI --raw | node -e "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{const l=JSON.parse(b.slice(b.indexOf('{'))).link||{};console.log(l.type,l.org+'/'+l.repo,'prod:',l.productionBranch)})"
   ```
   It must print `gitlab memetics/tegridy-farms prod: mvp-launch`.
10. **Deployments** tab: if the connect made a production deployment, it is Staged, not live.
    Leave it.
11. Open the ship-branch MR and merge it (a production deploy: section 4). Vercel builds a staged
    production deployment. Before promoting it, check that
    `npx vercel curl <deployment-url>/held-through.json` shows the merge commit. Then
    `npx vercel promote <deployment-url>`.
12. Check the live site: `curl -s https://memetics.finance/held-through.json` shows the merge
    commit.
13. Turn **Auto-assign Custom Production Domains** back **on**. From now on, a merge to
    `mvp-launch` is a production deploy.
14. memetic.fun: make a private GitLab project `memetics/memetic-fun-lab-proxy` with the same
    settings, then `bash scripts/git-hosting/push-all.sh <its clone> <its GitLab URL> --gitlab
    --trunk main`. Connect it in Vercel and set its Branch Tracking to `main`. Check and promote
    the same way.

### 2E. Railway: the indexer (owner checks first)

The Ponder indexer and its nginx proxy run on Railway (`nginx-production-7483.up.railway.app`,
answering on 2026-09-29). Railway built them from the public GitHub URL, which is now a 404. So no
rebuild from source works today, and connecting Vercel to GitLab does not fix it.

1. Check how you log in to Railway. If it is GitHub-only, add an email login.
2. For each service (indexer, any indexer-solana, nginx, Postgres), note its source and its Root
   Directory. Check whether "Redeploy" rebuilds from GitHub.
3. The nginx config is not in the repo. Copy it into `indexer/proxy/`.
4. Deploy path with no git host: `railway up` from a **clean worktree** of the trunk commit.
   Never from the OneDrive checkout: the Railway CLI is linked to it, and it is hundreds of
   commits behind trunk.
   ```
   git -C /c/Users/jimbo/dev/tegridy-farms worktree add /c/Users/jimbo/dev/wt/railway-<sha> <trunk-sha>
   cd /c/Users/jimbo/dev/wt/railway-<sha>
   npx @railway/cli link     # project proactive-beauty, environment production, the service
   npx @railway/cli up       # a production deploy: section 4
   ```
   `railway up` uploads the folder you run it from. Run it where the service's Root Directory
   expects. This path is not rehearsed yet; do it once with the owner watching.

### 2F. Daily bundles (10 minutes)

First the alarm, so a failed backup reaches you. In healthchecks.io (the same account as
`docs/OPS_SCHEDULER.md` when that lands; email and password, two-factor on), create a check named
`git-vault-backup` with period **1 day** and grace **1 day**. The task runs only while you are
logged on, so a day away from this PC also shows as DOWN. Put its ping URL on one line of the ops
env file, `%USERPROFILE%\tegridy-ops-env\ops.env` (outside any git work tree and outside
OneDrive; create it if it does not exist):

```
HC_PING_URL_GIT_VAULT_BACKUP=https://hc-ping.com/<uuid>
```

Each run reads that line and pings the check, or `<url>/fail` when any source failed. The URL is
never copied into the task or the log. Then, in PowerShell, from the repo root:

```
powershell -ExecutionPolicy Bypass -File scripts\git-hosting\register-backup-task.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File scripts\git-hosting\register-backup-task.ps1
Start-ScheduledTask -TaskName git-vault-backup
Get-ScheduledTaskInfo -TaskName git-vault-backup      # LastTaskResult 0 means success
Get-Content $env:LOCALAPPDATA\git-hosting\backup.log -Tail 20
```

- The installer says `ALARM NOT SET` until that line exists. The log's last line after each run
  says whether it pinged.
- It copies the script to `%LOCALAPPDATA%\git-hosting\`, so deleting a worktree cannot break it.
  Re-run the installer after the script changes. Re-running is safe.
- It runs daily at 03:30 while you are logged on. A missed run starts at the next chance.
- By default it bundles: the 2026-09-29 vault, the dev clone, the OneDrive clone,
  memetic-fun-lab-proxy, nakamigos-app and sartoshisiding.com. To change the list, create
  `%LOCALAPPDATA%\git-hosting\backup-sources.txt` with one `name=path` per line.
- A vault never changes, so bundle a fresh one once by hand (Git Bash):
  `BACKUP_SOURCES="tegridy-farms-ALL-<date>=<its path>" bash scripts/git-hosting/backup-bundles.sh`
- Each clone's bundle holds its remote-tracking refs too. After 2C, a clone's newest trunk is
  `origin/mvp-launch` (GitLab's, as last fetched), not its own stale `mvp-launch`.
- A repo that has not changed since its newest bundle is skipped. A tegridy-farms bundle is about
  150 MB, so 14 days of two busy clones can reach about 4 GB of OneDrive.
- To check every bundle: `cd /c/Users/jimbo/OneDrive/git-vault && sha256sum -c SHA256SUMS`.
- The bundles hold unreleased work (ship branches, audit material). Never share that folder.

### 2G. The other repos the account owned

`memetic-fun-lab-proxy` (2D step 14), `nakamigos-app` (trunk `master`) and `sartoshisiding.com`.
Give each one a private project in the `memetics` group and push it with
`push-all.sh <clone> <url> --gitlab --trunk <its trunk>`. They are already in the daily bundles.

### 2H. Before the project is made public (not part of onboarding)

The project holds every ref of the vault, and much of that was never public on GitHub: 453
`archive/*` tags (stash, tmp and PR heads, bundle-only commits), 69 `rescue/*` branches, and audit
material. Making the project public publishes all of it. Before any visibility change:

1. Push the whole vault to a second private project, for example
   `memetics/tegridy-farms-archive`, with `push-all.sh`, and wait for its `OK` line. That project
   stays private for good.
2. Scan every ref, not only the branches: a fresh `git clone --mirror "$PRIMARY"`, then
   `gitleaks git <that mirror> --log-opts="--all"`. Resolve every finding first. The 2026-09-29
   scan of the vault found 2, both in test fixtures.
3. Decide which `archive/*`, `rescue/*` and audit refs leave the public project. Removing them is
   a one-time owner decision made by hand, and the only exception to "never delete on a host"
   (section 4). Do it only after step 1 verified.
4. Then change the visibility.

---

## 3. Daily use

- **Remotes after 2C:** `origin` fetches from GitLab and pushes to GitLab and Bitbucket.
  `github` is the frozen record; pushing to it fails.
- A push to origin goes to both hosts. If one host rejects it, git says so and the other has
  still moved. Fix the cause and push again. Never force.
- Never push `mvp-launch` directly. GitLab rejects it, but Bitbucket may accept it. Then the two
  trunks differ, the branch restriction (2B step 5) stops the mirror from rewinding Bitbucket,
  and the mirror shows an error until the owner sorts it out.
- Install glab: `winget install --id GLab.GLab`. The owner signs in once with `glab auth login`
  and picks the browser option.

| Was (GitHub) | Now (GitLab) |
|---|---|
| `gh pr create --base mvp-launch --fill` | `glab mr create --fill --target-branch mvp-launch --yes` (`--fill` also pushes the branch) |
| `gh pr view N` | `glab mr view N` |
| `gh pr view N --json mergeStateStatus`, gate on `CLEAN` | `glab mr view N -F json --jq .detailed_merge_status`, gate on `mergeable` |
| `gh pr checks N` | `glab ci status --branch <branch>` |
| `gh pr diff N --name-only` | `git diff --name-only origin/mvp-launch...origin/<branch>` (the MR page stops at 3,000 files) |
| `gh pr list` | `glab mr list` |
| `gh pr merge N` | `glab mr merge N --sha <head-sha> --auto-merge=false --yes` (a production deploy: section 4) |
| `gh run list`, `gh run view` | `glab ci list`, `glab ci view` |
| `gh run download` | `glab job artifact <branch> <job-name>` |
| `gh api ...`, `gh issue list`, `gh auth status` | `glab api ...`, `glab issue list`, `glab auth status` |

- **`glab mr merge` does not always merge now.** When a pipeline is running it turns on
  auto-merge by default, and the MR merges later when the pipeline passes. Pass
  `--auto-merge=false` to merge now or fail. Always pass `--sha` so only the reviewed commit
  merges.
- **Semi-linear history:** an MR merges only when it is up to date with `mvp-launch`. If GitLab
  says it needs a rebase, run `glab mr rebase N` (or press Rebase).
- **Numbers:** GitLab MRs are `!N` and start again at `!1`. On GitLab, `#N` means an issue. Every
  `#NNN` in old docs, the changelog, NOTES.md and memory means a GitHub PR, forever.
- **Go slow on the API.** Poll at most once a minute. Never loop `glab api` over hundreds of
  items. A burst of `gh` calls came just before the GitHub suspension, and GitLab bans without
  appeal.
- `scripts/predeploy-check.mjs` compares against `origin/mvp-launch`. After 2C that is GitLab.

---

## 4. What counts as a production deploy

A production deploy is defined by its **effect**, not by the tool. Each one needs the owner's
explicit go, every time:

- anything that moves `mvp-launch` on **any** remote: `glab mr merge`, the Merge button in the
  GitLab UI, `git push <any remote> mvp-launch`, or a `push-all.sh` run that moves a host's
  `mvp-launch`;
- `vercel deploy --prod`, `vercel promote`, and Instant Rollback;
- connecting a Vercel project to a different git host (5A);
- `railway up`, and a Railway redeploy.

Never, on any path:
- `vercel build` followed by `vercel deploy --prebuilt`. Five build-time variables are
  "Sensitive" on Vercel (`VITE_BAYLA_LADDER_POOL`, `VITE_BAYLA_LADDER_PROGRAM`,
  `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, `VITE_VAPID_PUBLIC_KEY`). The prebuilt path bakes
  them into the public bundle as the text `[SENSITIVE]` or as empty strings. Always let Vercel
  build.
- pushing `main` to a host as `main`, or `--force`, `--mirror`, `--prune` or `--delete` against a
  host.

---

## 5. Drills

### 5A. GitLab is gone: Bitbucket becomes primary (about 10 minutes)

1. **First, cut the mirror:** in Bitbucket, avatar > **Account settings** > **Security** >
   **Create and manage API tokens**, revoke `gitlab-push-mirror`. This works even while GitLab is
   unreachable. Otherwise a GitLab that
   comes back resumes its mirror and deletes every branch made on Bitbucket after the failover.
2. Check that Bitbucket holds the real trunk. Compare `git ls-remote "$STANDBY"
   refs/heads/mvp-launch` with the commit production serves (`held-through.json`) and with your
   clone's last view of GitLab (`git -C <clone> rev-parse origin/mvp-launch`). If Bitbucket is
   behind, push that trunk to it. Without force, this can only move it forward:
   `git -C <clone> push "$STANDBY" refs/remotes/origin/mvp-launch:refs/heads/mvp-launch`.
3. Vercel, project tegridy-farms: turn auto-assign **off** (Branch Tracking panel). **Settings >
   Git > Disconnect**, then **Connect > Bitbucket > memetics/tegridy-farms**. Set Branch Tracking
   to `mvp-launch` and check it with the command in 2D step 9. It must print `bitbucket`. The next
   production build is staged. Check it, promote it, then turn auto-assign back **on**.
4. Every clone: `bash scripts/git-hosting/set-remotes.sh <clone> "$STANDBY"`, then
   `git fetch origin`.
5. On Bitbucket, tighten the `mvp-launch` restriction from 2B step 5: now only you may write,
   and changes go through pull requests.
6. When a new primary exists, seed it from a mirror clone of Bitbucket (5D), run `set-remotes.sh`
   with the new primary and standby, and reconnect Vercel the same way.
7. If GitLab comes back, it is behind. Catch it up from Bitbucket (5D) before anything else. It is
   never a mirror source again until 5D shows no `MISSING` or `DIFFERS` line.

### 5B. Every host is gone: restore from a bundle, deploy with the Vercel CLI

1. Check the bundles: `cd /c/Users/jimbo/OneDrive/git-vault && sha256sum -c SHA256SUMS`.
2. Restore every tegridy-farms bundle into one repo, and list every trunk they hold, newest
   first. A clone's newest trunk is its `origin/mvp-launch`, not its own `mvp-launch`, which is
   stale:
   ```
   R=/c/Users/jimbo/restore/tegridy-farms.git
   git init -q --bare "$R"
   for f in /c/Users/jimbo/OneDrive/git-vault/tegridy-farms-*.bundle; do
     git -C "$R" fetch -q "$f" "+refs/*:refs/b/$(basename "$f" .bundle)/*"
   done
   git -C "$R" for-each-ref --sort=-committerdate --format='%(committerdate:iso) %(objectname) %(refname)' \
     'refs/b/*/heads/mvp-launch' 'refs/b/*/remotes/*/mvp-launch'
   ```
3. Take the top commit as `SHA`, and prove it contains what production serves. Otherwise the
   deploy would roll production back.
   ```
   SHA=<the top commit above>
   curl -s https://memetics.finance/held-through.json          # note its "commit"
   git -C "$R" merge-base --is-ancestor <that commit> "$SHA" && echo "SAFE: $SHA contains production"
   ```
   No `SAFE` line: stop. Production keeps serving as it is. Find a newer copy first (any clone's
   `origin/mvp-launch`), and ask the owner.
4. Deploy from a clean checkout, at the repo root. `.vercelignore` uploads only `frontend/`, and
   running inside `frontend/` fails. The two ids below are not secrets.
   ```
   git -C "$R" branch restore-trunk "$SHA"
   git clone --branch restore-trunk "$R" /c/Users/jimbo/restore/deploy
   cd /c/Users/jimbo/restore/deploy
   export VERCEL_ORG_ID=team_EVDD1zUWWUUoAzBGWe58k0uR VERCEL_PROJECT_ID=prj_J1FvjRMmzfpMy8bfAnxC15k4dILI
   SHA=$(git rev-parse HEAD)
   npx vercel deploy --prod --skip-domain --yes -b VITE_VERCEL_GIT_COMMIT_SHA=$SHA -b GITHUB_SHA=$SHA
   npx vercel curl <printed-url>/held-through.json      # "commit" must be the first 12 of $SHA
   npx vercel promote <printed-url>                     # a production deploy: section 4
   ```
   Vercel builds it, so the Sensitive variables are filled in on Vercel's side.
   `scripts/predeploy-check.mjs` needs a live origin and cannot pass here; step 3 stands in for it.
5. Stand up a new primary. Seed it from the newest vault bundle (`git clone --mirror` it, then
   5D). Then push `restore-trunk` to its `mvp-launch` (a fast-forward, so no force; a protected
   trunk needs the 5D exception) before anything else merges.

### 5C. Practice, so the drills are not new on the bad day

- Weekly: check that the hosts agree.
  ```
  diff <(git ls-remote --heads --tags "$PRIMARY" | sort) <(git ls-remote --heads --tags "$STANDBY" | sort) && echo "hosts match"
  ```
- Monthly: run 5B steps 1 to 3 into a temp folder, and check that the top trunk is GitLab's
  current `mvp-launch` or close behind it. Run the 5B deploy as a **preview** (drop `--prod`).
- Monthly: check the backup is alive. The newest `tegridy-farms-*` bundle in
  `OneDrive\git-vault` should be days old at most, `Get-ScheduledTaskInfo -TaskName
  git-vault-backup` should show `LastTaskResult` 0, and healthchecks.io should show the check UP.

### 5D. Seed or catch up a host

Seed a host only from a copy that holds every branch: a fresh vault (2A step 7), or a mirror clone
of the host that survived. Never from a working clone: most of its branches are only
remote-tracking refs, so `push-all.sh` refuses it.

```
SRC=/c/Users/jimbo/git-vault/host-copy-$(date +%F).git
git clone --mirror "$STANDBY" "$SRC"                       # or "$PRIMARY", whichever survived
bash scripts/git-hosting/push-all.sh "$SRC" <host URL> --dry-run      # add --gitlab for a GitLab host
bash scripts/git-hosting/push-all.sh "$SRC" <host URL>
```

- A new, empty host ends with the usual `OK` line.
- A host that came back already holds its old refs. `push-all.sh` only moves them forward, then
  lists as `EXTRA` the refs that only that host has (mostly branches deleted after a merge) and
  stops. Nothing was deleted. Review the list; that stop is expected here. A branch that moved
  differently on each host is rejected and listed as `DIFFERS`: decide by hand which one wins.
- A returning GitLab rejects the `mvp-launch` push, because it is protected. Set **Allowed to
  push and merge** to Maintainers for this one run, then back to **No one**.

---

## 6. When GitHub returns

Do these in this order.

1. **Now, in the appeal:** ask for a full export of the account's data if reinstatement is
   refused. GitHub deletes content 90 days after a cancellation.
2. **Before reinstatement:** remove the blanket `Bash(gh pr *)` and `Bash(gh run *)` allow rules
   from `.claude/settings.local.json` in the OneDrive checkout.
3. **Disable Actions first, before anything is pushed there:** repository **Settings > Actions >
   General > Actions permissions > Disable actions**. Otherwise 8 cron workflows wake up without
   their secrets.
4. **Read Security > Advisories and Issues.** A vulnerability report filed before the suspension
   is still unread.
5. **Write down (names only):** Settings > Secrets and variables (Actions, Dependabot,
   Codespaces), Environments, Deploy keys, Webhooks, and installed GitHub Apps. Variable values can
   be read back; secret values cannot.
6. **Export the account's data once:** **Settings > Account > Export account data**. It is one
   request, and the download link arrives by email. Do not crawl the API with `gh`.
7. **Remove the Vercel GitHub app:** `github.com/settings/installations` > Vercel > Configure >
   Uninstall. Vercel's side was disconnected in 2D.
8. **Save what only GitHub has, before any mirror touches it.** The step 9 mirror deletes every
   GitHub branch that GitLab lacks and overwrites every one that differs. GitHub may hold pushes
   no clone ever fetched (Dependabot, cloud sessions). One clone, one bundle, then the
   GitHub-only refs go to GitLab under `github-late/`:
   ```
   GHM=/c/Users/jimbo/git-vault/github-final-$(date +%F).git
   git clone --mirror https://github.com/fomotsar-commits/tegridy-farms.git "$GHM"
   git -C "$GHM" bundle create /c/Users/jimbo/OneDrive/git-vault/github-final-$(date +%F).bundle --all
   git -C "$GHM" fetch -q "$PRIMARY" '+refs/heads/*:refs/primary/heads/*' '+refs/tags/*:refs/primary/tags/*'
   git -C "$GHM" for-each-ref --format='%(refname)' refs/heads refs/tags | while read -r ref; do
     if [ -n "$(git -C "$GHM" rev-list -1 "$ref" --not --glob='refs/primary/*')" ]; then
       kind=${ref#refs/}; kind=${kind%%/*}; echo "$ref:refs/$kind/github-late/${ref#refs/$kind/}"
     fi
   done > github-late.txt
   cat github-late.txt
   if [ -s github-late.txt ]; then git -C "$GHM" push -o ci.skip "$PRIMARY" $(cat github-late.txt); fi
   ```
   The list holds only refs with a commit GitLab lacks; GitHub's old `mvp-launch` and `main` are
   not on it. Also turn off Dependabot on GitHub (**Settings > Code security**): a branch it opens
   there exists only on GitHub, and the next mirror sync deletes it.
9. **Make GitHub a push-mirror target.** Create a fine-grained token for this repository only
   (**Settings > Developer settings > Personal access tokens > Fine-grained tokens**) with
   **Contents: read and write** and **Workflows: read and write**, and an expiry date (7C). In
   GitLab: **Settings > Repository > Mirroring repositories**, URL
   `https://github.com/fomotsar-commits/tegridy-farms.git`, **Push**, username
   `fomotsar-commits`, password = the token, **Keep divergent refs off**.
10. **Never make GitHub primary again.** Do not reconnect Vercel to it; the Ignored Build Step
   stays. Clones keep `github` as a read-only record. The local `gh` token and Git Credential
   Manager's github.com token will work again: use them for reads, slowly.

---

## 7. Credentials

Names only. No value is ever written in this repo, a doc, a commit or a chat.

### 7A. What was set on GitHub, and where each value survives

Only three GitHub secrets ever existed. Secret values cannot be read back even after
reinstatement.

| Name | Kind | Used by | Set on GitHub? | Where the value survives |
|---|---|---|---|---|
| `BACKUP_PASSPHRASE` | secret | `supabase-backup.yml` | yes | **Only your offline copy.** Lose it and every old backup is unreadable. |
| `SUPABASE_SERVICE_KEY` | secret | `supabase-backup.yml` | yes | Vercel production env (viewable) and the Supabase dashboard |
| `SUPABASE_URL` | secret | `supabase-backup.yml` | yes | Vercel `SUPABASE_URL`; derivable from the project ref |
| `VITE_WALLETCONNECT_PROJECT_ID` | secret | `ci.yml` | **no** (CI built the path without it) | Vercel, Reown. Nothing to re-create. |
| `ANVIL_FORK_URL` | secret | `ci.yml` | **no** (CI used a public RPC) | Nothing to re-create |
| `ETH_RPC_URL` | secret | `arb-linkage-monitor.yml` | **no** | `contracts/.env` locally |
| `GITHUB_TOKEN` | automatic | gitleaks, release | automatic | GitLab's `CI_JOB_TOKEN` replaces it but **cannot open issues**; monitors need a service-account token (7B) |
| `TEGRIDY_LENDING` | variable | `arb-linkage-monitor.yml` | unknown | Lending is not deployed |
| `SOLANA_FEE_ACCOUNT` | variable | `revenue-watch.yml` | unknown | Probably unset everywhere |
| `SOLANA_RPC`, `ETH_RPC`, `BASE_RPC` | variables | `registry-onchain.yml` | unknown | Public fallbacks are built in |
| `RH_RPC` | variable | not on trunk yet (PR #614) | unknown | Needed when that work lands |
| `VENUE_SITE_URL`, `VENUE_INDEXER_URL` | variables | not on trunk yet (PR #466) | unknown | The indexer URL is the Railway host in 2E |

No environments, Dependabot secrets, Codespaces secrets or deploy keys were in use. Confirm on
reinstatement (section 6 step 5).

### 7B. New credentials this move creates

| Credential | Made in | Kept in | Used for |
|---|---|---|---|
| GitLab password, 2FA and recovery codes | 2A | your password manager; codes offline | everything on GitLab |
| Atlassian password and two-step verification | 2B | your password manager | Bitbucket |
| Bitbucket API token `gitlab-push-mirror` | 2B step 6 | only GitLab's mirror settings | GitLab to Bitbucket mirror |
| Git Credential Manager sign-ins (gitlab.com, bitbucket.org) | first push | Windows Credential Manager | your pushes and fetches; they refresh on their own |
| Vercel login connections to GitLab and Bitbucket | 2D step 7 | Vercel | deploy triggers; revocable in GitLab and Atlassian settings |
| Later: GitLab service-account token | CI workstream | GitLab CI variables (masked, protected) | monitors that open issues, Renovate |
| Later: runner authentication tokens (`glrt-...`) | CI workstream | the runner host | our own CI runner |
| Later: `VERCEL_TOKEN` (one project only), `RAILWAY_TOKEN` | deploy workstream | GitLab CI variables (masked, protected) | deploys from CI |
| Later: GitHub fine-grained token | section 6 step 9 | only GitLab's mirror settings | GitLab to GitHub mirror |

### 7C. Expiry calendar

A token that expires breaks a mirror silently. GitLab personal and service-account tokens last
at most 365 days (GitLab emails 60, 30 and 7 days before). When you create one, add its expiry
date here in a PR. Dates only.

| Credential | Created | Expires | Renew by |
|---|---|---|---|
| Bitbucket API token `gitlab-push-mirror` | | | |
| GitLab service-account token | | | |
| GitHub fine-grained mirror token | | | |
| Vercel token (if CI deploys) | | | |

---

## 8. Dates to beat

| Date | What happens | Status |
|---|---|---|
| ~2026-10-01 | `git gc` in the OneDrive clone may prune 280 commits whose only copy is a bundle | Covered: they are in the vault since 2026-09-29. Keep the vault. Its 12 stash entries are not at risk from gc (git never expires `refs/stash` entries unless a `gc.refs/stash.*` setting says so), but 11 of them exist only in that clone until a fresh vault is built (2A step 7). |
| 2026-10-20 | The BAYLA mainnet build artifact expires on GitHub | A local copy exists and its hash matches |
| ~2026-10-28 | The oldest Supabase backup artifact expires on GitHub | Cannot be downloaded while suspended |
| 2026-11-16 | The npm-advisory baseline expires; 24 advisories start blocking CI | CI workstream |
| 2026-11-23 to 12-08 | The BAYLA reload window | Operator task |
| 2026-12-20 | The newest possible Supabase backup artifact expires | |
| 2026-12-23T15:32Z | BAYLA emission stops unless reloaded | Operator task |
| ~2027-03-24 | The GitHub appeal window closes (six months) | Section 6 step 1 |
| creation + 365 days | Every GitLab token expires | Section 7C |

---

## 9. Not covered here

These are separate pieces of work. Each one has its own branch, and its own doc once it lands:
- CI on GitLab, with our own runner: branch `ci/gitlab-pipeline` (`docs/CI_ON_GITLAB.md`). It runs
  the `.github/workflows/` files unchanged, so the git-hosting tests in `ci.yml` run there too.
  Never the shell executor on the PC that holds keys. Port from the newest ship branch, not
  trunk: its `solana-ci.yml` differs.
- The monitors, crons and the Supabase backup: branch `ops/off-github-crons`
  (`docs/OPS_SCHEDULER.md`). They run from Windows Task Scheduler with healthchecks.io alarms, not
  as GitLab schedules.
- The security contacts that point at dead GitHub URLs (`solana/tegridy-amm/SECURITY.md` and the
  on-chain security.txt of the live cp-swap program): branch `fix/source-links-first-party`.
- Builds that still fetch from public github.com (submodules, foundryup, anchor, gitleaks).
- Do not retire the OneDrive clone while `C:\Users\jimbo\tegridy-ops` hangs off it. That worktree
  holds operator keys, and `worktree remove --force` deletes ignored files.
