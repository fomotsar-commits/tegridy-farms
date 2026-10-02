# Git hosting: where the code lives, and how to keep it alive

**The rule: GitHub is the primary. GitLab is a live standby that every push reaches. GitHub is
never the only copy again.** If GitHub disappears, GitLab takes over in about 15 minutes
(section 5A). If GitLab disappears, nothing changes day to day (5B).

Read this page before any remote operation: a push, a merge, a mirror change, a deploy. The
owner's setup list is section 2. The failover drill is section 5A.

**The addresses live here.** Every command below uses these names. If a name changes, change
this block, `MIRROR_URL` in `.github/workflows/mirror-to-gitlab.yml`, and the GitLab lines of
`docs/DEPLOY_RUNBOOK.md`, "Moving the source links to another git host", with `OUR_REPOS` in
`frontend/src/test/sourceLinks.test.ts`, in one pull request. The GitLab group
is `memetics-finance` (renamed 2026-09-30; `memetics` was taken). Run the commands in Git Bash,
from the root of a clean clone.

```
PRIMARY=https://github.com/fomotsar-commits/tegridy-farms.git    # public; Vercel deploys from it
STANDBY=https://gitlab.com/memetics-finance/tegridy-farms.git            # public; GitHub's branches and tags
VAULT_URL=https://gitlab.com/memetics-finance/tegridy-farms-vault.git    # private; every ref of the vault
```

The site's source links (the four `/source` rules in `frontend/vercel.json`) have one runbook:
`docs/DEPLOY_RUNBOOK.md`, "Moving the source links to another git host". It holds the four lines
for GitHub and for the standby, exactly, and the checks to run before and after a move. Only the
failover drill (5A step 6) and the fail-back (5A.2) move them.

---

## 1. The setup

```
   your clones and worktrees
        |  git push origin: GitHub first, then GitLab (two push URLs)
        v
 +--------------------+   mirror-to-gitlab.yml, on every push   +----------------------+
 | GitHub   PRIMARY   | --------------------------------------> | GitLab  LIVE STANDBY |
 | PRIMARY above      |   SSH deploy key; never forces or       | STANDBY above        |
 |                    |   deletes; sends everything daily       | (public)             |
 +--------------------+                                         +----------------------+
        | merge to mvp-launch                                              .
        v                                                                  . only in the drill (5A)
 +--------------------+ <...................................................
 | Vercel: production |
 +--------------------+

 Also:
   GitLab vault project (VAULT_URL, private)        every ref of the local vault, pushed by hand
   C:\Users\jimbo\git-vault\tegridy-farms-v2.git     the vault, built 2026-09-29
   C:\Users\jimbo\OneDrive\git-vault\               daily bundles + SHA256SUMS, newest 14 kept
   healthchecks.io, check gitlab-standby           alarms when the daily full copy stops or fails
```

| Place | Job | If it dies |
|---|---|---|
| GitHub | Primary: pull requests, CI, scheduled jobs, Vercel's trigger | GitLab takes over in about 15 minutes (5A) |
| GitLab standby | A public copy of GitHub's branches and tags, current within minutes | Nothing changes day to day; make a new standby (5B) |
| GitLab vault project | A private copy of every ref, including unreviewed audit and PoC branches | Push the local vault again (2B) |
| The local vault | Every ref from every clone and bundle, off OneDrive | Build a fresh one with `consolidate-refs.sh`. It reads the older vaults too |
| OneDrive bundles | A daily copy of every repo, including each clone's last view of both hosts | The hosts and the clones still have everything |
| Vercel | Serves memetics.finance | Instant Rollback, or a CLI deploy from any copy (5C) |

**Why this shape.** The owner chose it on 2026-09-29/30, after GitHub reinstated the account:
- GitHub stays primary because Vercel's GitHub integration, free GitHub Actions and the Claude
  desktop PR panel keep working there.
- GitLab carries little traffic as a standby, so it is unlikely to be flagged.
- GitHub has an appeal path, and it worked. GitLab bans have no appeal.
- Codeberg is excluded: its terms ban cryptocurrency projects. SourceHut too. We never make a
  second GitHub account: GitHub treats that as ban evasion.
- Bitbucket is an optional third copy (Appendix A), not part of the setup.

**What keeps the standby current:**
1. Every clone's `origin` pushes to GitHub, then GitLab (`set-remotes.sh`, 2D). Fetch stays GitHub.
   A pre-push hook lets the GitLab half send only what GitHub took. So a push GitHub refuses, for
   example one its secret scanning blocks, never lands on the public standby.
2. `.github/workflows/mirror-to-gitlab.yml` pushes every branch and tag pushed to GitHub, over SSH,
   with a GitLab deploy key. It carries what no clone pushed: merges made on GitHub, cloud sessions.
   - It never forces and never deletes. A branch deleted on GitHub stays on GitLab.
   - A feature branch force-pushed on GitHub keeps its old version on GitLab: the run warns.
   - `mvp-launch` on GitLab takes only fast-forwards, and only from that key. A trunk push GitLab
     refuses fails the run.
   - Once a day it sends every branch and tag again (GitHub starts no run for a push of more than
     three tags). Then it pings the healthchecks.io check `gitlab-standby` (2E), so a standby that
     stops being current raises an alarm.
3. The vault project is pushed by hand after each new vault build (2B step 2).

The scripts, all in `scripts/git-hosting/`:

| Script | What it does |
|---|---|
| `set-remotes.sh <clone> <primary> [<standby>] [--fix-email <addr>]` | origin fetches from the primary and pushes to the primary, then the standby. A remote named for the standby's host fetches the standby. With a standby, it installs `pre-push-standby.sh` as the clone's pre-push hook. On a failover it swaps: the old origin becomes a frozen record, the standby becomes origin. |
| `pre-push-standby.sh` | The pre-push hook. A remote's second push URL gets a ref only when the first URL already holds it exactly as pushed. |
| `mirror-to-gitlab.sh` | Run by the mirror workflow. Pushes one ref (a push event) or every branch and tag (the daily run). Never forces or deletes. |
| `push-all.sh <repo> <url> [--gitlab] [--dry-run] [--trunk <b>] [--vault]` | Pushes every branch and tag, then proves the host holds exactly that set. Never forces. `main` goes up as `archive/main`. Refuses a repo with `archive/*` tags (a vault) unless `--vault`. |
| `consolidate-refs.sh` | Builds a NEW vault from the clones, the older vaults and the bundles, every stash entry included. Never overwrites a ref; proves 0 lost. |
| `backup-bundles.sh [<dest>]` | One verified bundle per repo per day (branches, tags, remote-tracking refs), newest 14 kept, SHA256SUMS refreshed. |
| `register-backup-task.ps1` | Registers the daily 03:30 backup task, which pings a healthchecks.io check. |
| `test/run-all.sh` | Tests all of the above on throwaway repos. CI runs it. |

---

## 2. Owner setup: do these in order

Only you can do this section. It takes about an hour. Agents cannot sign in, make keys or change
host settings without your go.

### 2.0 Before you start (15 minutes)

1. Check how you log in to **Supabase**, **Railway** and **Vercel**. If any of them is "Continue
   with GitHub" only, add an email login plus 2FA or a passkey now. A GitHub suspension locks you
   out of every service you sign in to with GitHub. The Supabase project holds the only copy of
   signed orders.
2. Confirm the offline copy of `BACKUP_PASSPHRASE` exists. It is the only copy. Without it, every
   Supabase backup made by the GitHub workflow is unreadable.
3. Git for Windows is installed. It includes Git Credential Manager, which does each sign-in below
   in your browser.

### 2.1 Merge this work first (your go: a production deploy)

The steps below run scripts from `scripts/git-hosting/`, so this work must be on `mvp-launch` in
your clone. GitHub also shows the mirror's **Run workflow** button, and runs its daily schedule,
only for a workflow on the default branch. Until 2C is done, each push to `mvp-launch` shows a red
Mirror to GitLab run, on purpose: it says the mirror's key is missing. Other branches only warn.

### 2A. GitLab: the account, the group and two projects (20 minutes)

1. The account exists (username `fomotsar`, Google login). Give it a second way in, because a
   Google lockout would lock GitLab too, and GitLab bans have no appeal:
   - set a GitLab password: sign out, then use **Forgot your password?** with the account's email;
   - turn on 2FA: avatar > **Edit profile** > **Account** > **Enable two-factor authentication**.
     Save the recovery codes offline (paper, or next to the keys), never in OneDrive or chat.
2. The group: finish the rename (group > **Settings > General > Advanced > Change group URL**) and
   check that the group page opens at the new name. Then, in the group, **Settings > CI/CD**:
   - **Auto DevOps**: untick "Default to Auto DevOps pipeline", Save.
   - **Runners**: turn off "Enable instance runners for this group".
   - Why: GitLab's own runners burn a 400-minute monthly quota and ask for identity checks, and
     Auto DevOps can start a pipeline on the first push because the repo has a `package.json`.
3. The standby: in the group, **New project > Create blank project**. Name `tegridy-farms`,
   visibility **Public**. Under Project Configuration **untick every box** ("Initialize repository
   with a README", and any SAST or secret-detection box): each one commits a file, which creates a
   `main` branch. The new project page must say the repository is empty. Then, in the project:
   - **Settings > CI/CD**: Auto DevOps off, instance runners off.
   - **Settings > General > Visibility, project features, permissions**: Issues on. After a
     failover, the site's `/source-issues` link lands there.
4. The vault project: the same, named `tegridy-farms-vault`, visibility **Private**, the same
   boxes unticked and the same CI settings. It stays private for good. It holds audit material,
   PoC and rescue branches, and 464 `archive/*` tags. 423 of those are old GitHub pull request
   heads, public once as `refs/pull/*`. The other 41 (stash entries, and commits found only in
   clones or bundles) were never public.

### 2B. Fill both projects (20 minutes)

1. **The standby gets exactly what GitHub has.** Seed it from a mirror clone of GitHub, never from
   a working clone (most of a clone's branches are only remote-tracking refs) and never from the
   vault:
   ```
   M=/c/Users/jimbo/git-vault/github-mirror-$(date +%F).git
   git clone --mirror "$PRIMARY" "$M"
   bash scripts/git-hosting/push-all.sh "$M" "$STANDBY" --gitlab --dry-run
   bash scripts/git-hosting/push-all.sh "$M" "$STANDBY" --gitlab
   ```
   - The first push opens a browser window: Git Credential Manager's gitlab.com sign-in. Approve
     it. No token is typed anywhere.
   - `--gitlab` adds `-o ci.skip`, so the push runs no pipeline job. GitLab's docs say such a
     push still shows as an empty **Skipped** pipeline. `mvp-launch` goes first, which
     makes it the default branch. GitHub's `main` arrives as `archive/main`: Vercel picks `main` as
     the production branch when it connects, and that must never happen by accident.
   - Success is one line: `OK: the host holds exactly the local set (N refs).` Anything else:
     stop. The script lists every `MISSING`, `DIFFERS` or `EXTRA` ref.
   - The mirror clone also holds GitHub's `refs/pull/*`. `push-all.sh` sends only branches and tags.
2. **The vault project gets everything.**
   ```
   V=/c/Users/jimbo/git-vault/tegridy-farms-v2.git
   bash scripts/git-hosting/push-all.sh "$V" "$VAULT_URL" --gitlab --vault --dry-run
   bash scripts/git-hosting/push-all.sh "$V" "$VAULT_URL" --gitlab --vault
   ```
   - `push-all.sh` refuses any repo that holds `refs/tags/archive/*` (a vault) unless `--vault` is
     given. So a mixed-up URL cannot publish this vault on the public standby. It checks only for
     those tags: it cannot tell a working clone's unpushed branches from GitHub's. That is why the
     standby is seeded only from a mirror clone of GitHub (step 1).
   - The vault is about 150 MB. GitLab allows 5 GiB per push and 10 GiB per repo.
   - Push it again after each new vault build (5D).
3. In the standby project, set it up now for the day it becomes primary:
   - **Settings > Repository > Branch defaults**: default branch = `mvp-launch`.
   - **Settings > Merge requests**: Merge method = **Merge commit with semi-linear history**. Tick
     **Enable "Delete source branch" option by default**. Save.
   - **Do not** tick **Pipelines must succeed** yet. A merge request with no pipeline at all cannot
     merge, and until a runner exists no merge request has one, not even an urgent fix.

### 2C. The mirror: a deploy key, a GitHub secret and a trunk rule (15 minutes)

1. Make a key pair on your PC, in a folder outside any repo and outside OneDrive:
   ```
   mkdir -p ~/mirror-key && ssh-keygen -t ed25519 -N "" -C github-actions-mirror -f ~/mirror-key/gitlab-mirror
   ```
2. GitLab, the standby project: **Settings > Repository > Deploy keys > Add new key**. Title
   `github-actions-mirror`. Key: the contents of `~/mirror-key/gitlab-mirror.pub` (the public
   half). Tick **Grant write permissions to this key**. Leave the expiration date empty, or set one
   and write it in 7C. **Add key**.
3. GitHub, the repository: **Settings > Secrets and variables > Actions > New repository secret**.
   Name `GITLAB_MIRROR_SSH_KEY`. Value: the whole private file `~/mirror-key/gitlab-mirror`, from
   its `-----BEGIN` line to its `-----END` line. Or, without the clipboard:
   ```
   gh secret set GITLAB_MIRROR_SSH_KEY --repo fomotsar-commits/tegridy-farms < ~/mirror-key/gitlab-mirror
   rm -r ~/mirror-key
   ```
   Delete the folder either way. The private half now lives only in that secret. If it is ever
   needed again, make a new pair and repeat steps 2 and 3.
4. GitLab, the standby project: **Settings > Repository > Branch rules** > `mvp-launch` > **View
   details**:
   - **Allowed to merge**: No one. A merge request merged on the standby would give its trunk a
     commit GitHub's trunk lacks. Failover (5A step 3) sets Maintainers.
   - **Allowed to push and merge**: **Edit**. Roles: No one. **Deploy keys**: add
     `github-actions-mirror`. **Save changes**.
   - **Allowed to force push**: off.
   - GitLab's conditions for this: the key is enabled on the project with write access, and its
     owner (you) is a member of the project. A deploy key cannot be picked for "Allowed to merge";
     it does not need to be.
   - Why: only the mirror can move GitLab's trunk, and only forward. So the standby's trunk is
     always a commit GitHub's trunk had.
5. Test it: GitHub > **Actions > Mirror to GitLab > Run workflow**, branch `mvp-launch`. It must
   end green with `OK: the standby already holds every branch and tag GitHub has.` (or, if GitHub
   moved since 2B, `OK: the standby took every ref it was sent...`). From now on each push to
   GitHub reaches GitLab in about a minute. The first merge after this is the real test of step 4:
   its Mirror to GitLab run must be green.

### 2D. Point every clone at both hosts (5 minutes)

```
bash scripts/git-hosting/set-remotes.sh /c/Users/jimbo/dev/tegridy-farms "$PRIMARY" "$STANDBY"
bash scripts/git-hosting/set-remotes.sh "/c/Users/jimbo/OneDrive/Desktop/tegriddy farms" "$PRIMARY" "$STANDBY"
git -C /c/Users/jimbo/dev/tegridy-farms fetch gitlab
```

- origin still fetches from GitHub. It now pushes to GitHub first, then GitLab. A new remote
  `gitlab` fetches the standby.
- It also installs a pre-push hook (`pre-push-standby.sh`, in the clone's hooks folder, which
  `core.hooksPath` can move). Before the GitLab half, the hook asks GitHub for the refs being
  pushed, and sends GitLab nothing unless GitHub holds each one exactly as pushed. If the clone
  already has a pre-push hook of its own, the script stops and changes nothing.
- The first push to GitLab opens Git Credential Manager's browser sign-in, once.
- Worktrees share their clone's settings, so one run per clone covers all of its worktrees.
- Re-running with the same arguments changes nothing.

### 2E. The alarm on the standby (5 minutes)

A mirror that stops is silent: a schedule that does not fire makes no run, so nothing goes red
(section 6). So the daily run reports to healthchecks.io, outside GitHub.

1. In healthchecks.io, create a check named `gitlab-standby`, period **1 day**, grace
   **12 hours**. Use the one account for every check (email and password, two-factor on, never
   GitHub sign-in): `docs/OPS_SCHEDULER.md` section 2 sets it up and lists every check.
2. Put its ping URL in a GitHub Actions secret named `HC_PING_URL_GITLAB_STANDBY` (**Settings >
   Secrets and variables > Actions**).
3. **Arm it now.** GitHub > **Actions > Mirror to GitLab > Run workflow**, branch `mvp-launch`.
   When the run ends, the check must show **UP**. A new check stays grey and sends nothing until
   its first ping, so without this step it never alarms. Not UP: the secret is wrong; the run's
   ping job says why.
4. From then on the daily run (06:41 UTC) and every run by hand ping it: the URL when the mirror
   job passed, `<url>/fail` when it failed or was cancelled.
   - **DOWN with no ping for 36 hours:** no daily run happened. Usually GitHub's schedules stopped
     firing, as they did from 2026-09-24. GitHub also turns off a public repo's schedules after 60
     days with no activity. Or the ping itself failed: that run is red.
   - **DOWN after a `/fail` ping:** the run fired but the standby did not take everything, or
     GitHub cancelled the run while it waited behind another. Read the run's log (section 3). The
     next good run turns it UP.
   - This check watches the standby. While it is DOWN for one reason, a second reason sends no new
     email. GitHub's scheduler has its own check, `github-crons`, pinged every 30 minutes
     (`docs/OPS_SCHEDULER.md` section 2).
   - Until the secret exists, each run shows a warning saying so.

### 2F. Vercel: ready for the drill (5 minutes)

1. vercel.com > avatar > **Account Settings > Authentication**: add a **passkey**, if not done.
   In a private window, check that email login (one-time code) works. Do not run `vercel logout`.
2. Same page: connect **GitLab**, so the failover needs no new grant. Change nothing on the
   project: Vercel stays connected to GitHub.
3. Know what production is today: `curl -s https://memetics.finance/held-through.json` shows its
   `"commit"`, the first 12 characters of the trunk it serves.

### 2G. Daily bundles (10 minutes)

First the alarm, so a failed backup reaches you. In healthchecks.io create a check named
`git-vault-backup`, period **1 day**, grace **1 day**. The task runs only while you are logged on,
so a day away from this PC also shows as DOWN. Put its ping URL on one line of the ops env file,
`%USERPROFILE%\tegridy-ops-env\ops.env` (outside any git work tree and outside OneDrive; create it
if it does not exist):

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
- By default it bundles: the first vault (`tegridy-farms.git`), the dev clone, the OneDrive clone,
  memetic-fun-lab-proxy, nakamigos-app and sartoshisiding.com. To change the list, create
  `%LOCALAPPDATA%\git-hosting\backup-sources.txt` with one `name=path` per line.
- A vault never changes, so each one is bundled once by hand. The v2 vault's bundle exists:
  `tegridy-farms-ALL-v2-2026-09-29.bundle`. For a newer vault (Git Bash):
  `BACKUP_SOURCES="tegridy-farms-ALL-<date>=<its path>" bash scripts/git-hosting/backup-bundles.sh`
- Each clone's bundle holds its remote-tracking refs too. A clone's newest trunk is
  `origin/mvp-launch` (GitHub's, as last fetched), not its own `mvp-launch`, which is stale.
- A repo that has not changed since its newest bundle is skipped. A tegridy-farms bundle is about
  150 MB, so 14 days of two busy clones can reach about 4 GB of OneDrive.
- To check every bundle: `cd /c/Users/jimbo/OneDrive/git-vault && sha256sum -c SHA256SUMS`.
- The bundles hold unreleased work (ship branches, audit material). Never share that folder.

### 2H. The other repos the account owns

`memetic-fun-lab-proxy`, `nakamigos-app` (trunk `master`) and `sartoshisiding.com` are in the
daily bundles. The mirror workflow covers only tegridy-farms. To give one a standby too, make a
private project for it in the group and seed it from a mirror clone of GitHub:
`push-all.sh <mirror clone> <its GitLab URL> --gitlab --trunk <its trunk>`.

---

## 3. Daily use

- **Remotes after 2D:** `origin` fetches from GitHub and pushes to GitHub, then GitLab. `gitlab`
  fetches the standby. Pull requests, reviews and merges happen on GitHub, with `gh`, as before.
- **A push that fails only on GitLab still happened on GitHub.** Git prints an error for the
  GitLab half. The mirror workflow copies the push to GitLab anyway. Never retry with force.
- **A push GitHub refuses never reaches GitLab.** Without the hook it would: git pushes to each
  push URL in turn and goes on after one refuses. With it (2D), the GitLab half prints
  `pre-push: <ref> not sent` and sends nothing. Fix the push; never skip the hook
  (`--no-verify`). `git push --dry-run origin` prints the same line, because GitHub took nothing.
- **If a secret reached GitLab anyway** (a push from a clone without the hook, or straight to the
  `gitlab` remote): tell the owner now. The secret must be rotated. The mirror never deletes, so
  the branch stays public on GitLab until the owner deletes it there (section 4).
- **Never push `mvp-launch` directly.** On GitHub that is a production deploy. GitLab refuses it:
  only the mirror's key may move its trunk.
- **Is the standby current?** `git fetch --all`, then
  `git log --oneline gitlab/mvp-launch..origin/mvp-launch`. Empty means yes. It can lag a push by a minute or two.
- **Go slow on the API.** Poll at most once a minute. Never loop `gh api` or `glab api` over
  hundreds of items. A burst of `gh` calls came just before the GitHub suspension, and GitLab bans
  without appeal.
- **Numbers:** `#N` means a GitHub pull request. After a failover GitLab merge requests are `!N`
  and start again at `!1`. Every `#NNN` in old docs, the changelog, NOTES.md and memory means a
  GitHub pull request, forever.

**When a Mirror to GitLab run is red.** Its `::error::` line says which of these it is. Nothing
was forced or deleted in any case.
- *The secret is not set.* Do 2C steps 1 to 3. Away from the trunk this is only a warning.
- *The standby did not take mvp-launch: diverged.* GitLab's trunk holds a commit GitHub's trunk
  does not. Someone moved it by hand. Compare `git ls-remote "$STANDBY" refs/heads/mvp-launch`
  with `origin/mvp-launch`, then stop and ask the owner.
- *... refused.* GitLab's own rules said no. Check that the trunk rule (2C step 4) still lists
  the deploy key.
- *... failed*, or *could not read the standby.* GitLab did not answer, or the key is gone. If it
  lasts, see 5B.
- *Only the ping job is red* (daily and manual runs): healthchecks.io did not take the ping, or
  `HC_PING_URL_GITLAB_STANDBY` is not a plain https URL. The mirror job's own result stands.

A **warning** on a feature branch means GitLab keeps an older version of a branch that was
force-pushed on GitHub. That is expected. The clone that force-pushed usually sent the new version
to GitLab itself.

---

## 4. What counts as a production deploy

A production deploy is defined by its **effect**, not by the tool. Each one needs the owner's
explicit go, every time:

- anything that moves `mvp-launch` on the primary: `gh pr merge`, the Merge button,
  `git push <any remote> mvp-launch`, or a `push-all.sh` run that moves the host's `mvp-launch`;
- moving `mvp-launch` on the standby by hand. The mirror moving it after a merge is part of that
  merge, not a second deploy;
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
  host;
- pushing the vault to the public standby.

---

## 5. Drills

### 5A. GitHub is gone: GitLab becomes the primary (about 15 minutes)

**Start when** GitHub answers 403 for the account, or the repository or account is gone, and the
owner says go. Steps 1 to 5 take about 15 minutes; after them GitLab is the primary. Steps 6 to 9
follow the same day, and step 6 makes the first production build from GitLab. Steps 4 and 6 are
production deploys.

1. **Cut the mirror (1 minute).** GitLab, the standby project: **Settings > Repository > Deploy
   keys**, remove `github-actions-mirror`. A GitHub that comes back can now change nothing on
   GitLab. Its workflow runs will go red; that is fine. In healthchecks.io, pause the
   `gitlab-standby` check: with no mirror it can only go DOWN.
2. **Check that GitLab holds the real trunk (2 minutes).**
   ```
   git ls-remote "$STANDBY" refs/heads/mvp-launch
   curl -s https://memetics.finance/held-through.json
   git -C /c/Users/jimbo/dev/tegridy-farms rev-parse origin/mvp-launch
   ```
   The first line is GitLab's trunk. `"commit"` in the second is the first 12 characters of what
   production serves. The third is your clone's last view of GitHub. All three name the same
   commit: go on.
   - GitLab is behind (the last merge never reached it): in 2C step 4's rule, set **Allowed to push
     and merge** to Maintainers, then push the trunk from the clone that has it. Without force this
     can only move it forward:
     `git -C <clone> push "$STANDBY" refs/remotes/origin/mvp-launch:refs/heads/mvp-launch`
   - Anything else: stop and ask the owner. Never force.
3. **Give GitLab's trunk the rules of a primary (1 minute).** Branch rules > `mvp-launch`:
   **Allowed to merge** = Maintainers, **Allowed to push and merge** = No one, force push off. This
   also undoes step 2's change.
4. **Move Vercel to GitLab (5 minutes).** Project **tegridy-farms**:
   1. **Settings > Environments > Production > Branch Tracking**: turn **off** "Auto-assign Custom
      Production Domains". Until it is back on, a production build waits as **Staged**.
   2. **Settings > Build and Deployment > Ignored Build Step > Custom**:
      ```
      if [ "$VERCEL_GIT_PROVIDER" = "github" ]; then exit 0; fi; exit 1
      ```
      Exit 0 cancels a build and exit 1 runs it. A GitHub that comes back can trigger nothing. It
      is a project setting, so no pushed commit can undo it.
   3. **Settings > Git > Disconnect**. Env vars, domains, deployments and settings stay; the
      production branch setting is erased. Then **Connect Git Repository > GitLab** > the standby
      project.
   4. **Right away: Branch Tracking = `mvp-launch`, Save.** Check it without printing any secret:
      ```
      MSYS_NO_PATHCONV=1 npx vercel api /v9/projects/prj_J1FvjRMmzfpMy8bfAnxC15k4dILI --raw | node -e "let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{const l=JSON.parse(b.slice(b.indexOf('{'))).link||{};console.log(l.type,l.org+'/'+l.repo,'prod:',l.productionBranch)})"
      ```
      It must print `gitlab`, then the standby's group and project, then `prod: mvp-launch`.
   5. Leave auto-assign off for now. Connecting a repository starts no build, so production keeps
      serving what it served. The first GitLab build comes from step 6's merge. It waits as
      **Staged** until you check it and promote it there.
5. **Point every clone at GitLab (2 minutes).**
   ```
   bash scripts/git-hosting/set-remotes.sh /c/Users/jimbo/dev/tegridy-farms "$STANDBY"
   bash scripts/git-hosting/set-remotes.sh "/c/Users/jimbo/OneDrive/Desktop/tegriddy farms" "$STANDBY" \
     --fix-email <the email on your GitLab account>
   git -C /c/Users/jimbo/dev/tegridy-farms fetch origin
   ```
   - origin now fetches from and pushes to GitLab. The `gitlab` remote became origin, refs and all.
   - GitHub's refs stay as the remote `github`, a frozen record: `git fetch --all` skips it and a
     push to it fails. Branches that tracked GitHub track origin.
   - `--fix-email`: the OneDrive clone commits as `fomotsar-commits@users.noreply.github.com`. In a
     GitLab group, Vercel only builds commits whose author is a member of the Vercel team, and it
     cannot match that address. Old history stays as it is; that is harmless.
   - The mirror workflow is dead from here on. Clones push to GitLab directly.
6. **Point the source links at GitLab: the first production build from GitLab.** In
   `frontend/vercel.json`, replace the four `/source` lines with the GitLab ones in
   `docs/DEPLOY_RUNBOOK.md`, "Moving the source links to another git host", exactly, after the
   checks that section gives. In the same merge request, update the address block at the top of
   this page: `PRIMARY` becomes the GitLab URL, and the GitHub line says it is gone. Open and
   merge it with `glab` (5A.1). Then:
   1. `git -C /c/Users/jimbo/dev/tegridy-farms fetch origin`, then
      `git -C /c/Users/jimbo/dev/tegridy-farms rev-parse origin/mvp-launch`: the merge commit.
   2. Vercel > **Deployments**: its production build is **Staged**.
      `npx vercel curl <deployment-url>/held-through.json` must show that commit's first 12
      characters. Anything else: stop and ask the owner.
   3. `npx vercel promote <deployment-url>`, then turn auto-assign back **on** (step 4.1). From
      now on a merge to GitLab's `mvp-launch` is a production deploy.
   4. `curl -sI https://memetics.finance/source` answers 307 with a GitLab `location`.
7. **CI.** If a runner is registered for the project (`docs/CI_ON_GITLAB.md`), set the CI/CD
   variable `TEGRIDY_CI_ON_GITLAB` to `1` (project **Settings > CI/CD > Variables**, with "Protect
   variable" cleared so merge request pipelines see it). Tick **Pipelines must succeed** once a
   pipeline has passed. With no runner, run `bash scripts/ci/local-gates.sh all` on a clean
   worktree of the merge request's head before each merge.
8. **Scheduled jobs.** GitHub's schedules died with it. Register the stopgap tasks on the ops PC,
   with their healthchecks alarms: `docs/OPS_SCHEDULER.md`, the section "Failover: GitHub is gone"
   (`scripts\ops\register-tasks.ps1 -Failover`). That includes the Supabase backup.
9. **Railway.** It builds the indexer from the GitHub URL, so no rebuild from source works. Deploy
   with `railway up` from a **clean worktree** of the trunk commit, never from the OneDrive
   checkout (the Railway CLI is linked to it, and it is far behind trunk). A production deploy:
   ```
   git -C /c/Users/jimbo/dev/tegridy-farms worktree add /c/Users/jimbo/dev/wt/railway-<sha> <trunk-sha>
   cd /c/Users/jimbo/dev/wt/railway-<sha>
   npx @railway/cli link     # project proactive-beauty, environment production, the service
   npx @railway/cli up
   ```
   `railway up` uploads the folder you run it from. Run it where the service's Root Directory
   expects. This path is not rehearsed yet; do it once with the owner watching.

#### 5A.1 Working on GitLab

Install glab: `winget install --id GLab.GLab`. The owner signs in once with `glab auth login` and
picks the browser option.

| On GitHub | On GitLab |
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
  `--auto-merge=false` to merge now or fail. Always pass `--sha` so only the reviewed commit merges.
- **Semi-linear history:** an MR merges only when it is up to date with `mvp-launch`. If GitLab
  says it needs a rebase, run `glab mr rebase N` (or press Rebase).
- `scripts/predeploy-check.mjs` compares against `origin/mvp-launch`, which is GitLab's after step 5.

#### 5A.2 When GitHub comes back after a failover

GitHub is then behind, and it is not in the deploy path (step 4). Keep GitLab primary until the
owner decides. To make GitHub primary again, in this order:
1. Catch GitHub up from a mirror clone of GitLab (5E).
2. Reconnect Vercel to GitHub the way step 4 did, with the Ignored Build Step now cancelling
   `gitlab`.
3. Run `set-remotes.sh <clone> "$PRIMARY" "$STANDBY"` on each clone. It turns the frozen `github`
   record back into origin, and GitLab back into the standby.
4. Redo 2C: a new deploy key, and the trunk rule back to merge No one, push only that key.
5. Point the source links back at GitHub: the GitHub lines in `docs/DEPLOY_RUNBOOK.md`, "Moving
   the source links to another git host".
6. Switch GitLab CI off: `docs/CI_ON_GITLAB.md`, "Switching it off". Turn off **Pipelines must
   succeed** first, or nothing on GitLab can merge in the next outage.
7. Move the scheduled jobs back to GitHub: `docs/OPS_SCHEDULER.md` section 8.
8. Unpause the `gitlab-standby` check and arm it again (2E step 3).

Each trunk move is a production deploy.

### 5B. GitLab is gone (or bans the account)

Nothing changes day to day. GitHub stays primary and production is untouched.

**What you see:** each Mirror to GitLab run on the trunk goes red, the daily run pings `/fail` (an
alarm), and each push from a clone prints an error for its GitLab half. The GitHub half worked.

1. Quiet the clones: `bash scripts/git-hosting/set-remotes.sh <clone> "$PRIMARY"`. origin then
   pushes only to GitHub. The `gitlab` remote stays, with its last view of the standby.
2. A GitLab ban has no appeal. Pick the new standby's host: a new GitLab project if the project,
   not the account, was lost; otherwise another host (Appendix A).
3. Make the new standby from a mirror clone of GitHub (2B step 1). Never from the vault: it holds
   refs that were never public.
4. Make a new private vault project and push the local vault to it (2B step 2). Build a fresh
   vault first if the newest one is old (5D).
5. Update the address block at the top of this page and every place listed above it (`MIRROR_URL`
   in the workflow, the standby's source-link lines and `OUR_REPOS`), make a new
   deploy key (2C), and run 2D again on each clone. A host other than gitlab.com also needs its own
   published host key and fingerprint in the workflow and in `mirrorToGitlab.test.ts`, and no
   `ci.skip` push option (`MIRROR_PUSH_OPTION`).

### 5C. Every host is gone: restore from a bundle, deploy with the Vercel CLI

1. Check the bundles: `cd /c/Users/jimbo/OneDrive/git-vault && sha256sum -c SHA256SUMS`.
2. Restore every tegridy-farms bundle into one repo, and list every trunk they hold, newest
   first. A clone's newest trunk is one of its remote-tracking refs (`origin/mvp-launch`,
   `gitlab/mvp-launch`), not its own `mvp-launch`, which is stale:
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
5. Stand up a new primary as a **private** project. Seed it from the newest vault bundle
   (`git clone --mirror` it, then 5E with `--vault`). Then push `restore-trunk` to its
   `mvp-launch` (a fast-forward, so no force) before anything else merges. It stays private: the
   vault holds refs that were never public. A public copy gets only the branches and tags GitHub
   had (a clone bundle's `remotes/origin/*`), and only with the owner.

### 5D. Practice, so the drills are not new on the bad day

- **Weekly:** check that the standby holds every GitHub branch and tag.
  ```
  comm -23 <(git ls-remote --heads --tags "$PRIMARY" | sed 's#\trefs/heads/main$#\trefs/heads/archive/main#' | sort) \
           <(git ls-remote --heads --tags "$STANDBY" | sort)
  ```
  No output: it does. A line is a ref GitLab lacks or holds at another commit. A feature branch
  line matches a mirror warning (section 3). A `mvp-launch` line is an emergency. The standby may
  hold more than GitHub: branches deleted on GitHub stay there.
- **Weekly:** the last daily Mirror to GitLab run is green, and healthchecks.io shows
  `gitlab-standby` UP.
- **Monthly:** run 5C steps 1 to 3 into a temp folder. The top trunk must be GitHub's current
  `mvp-launch` or close behind it. Run the 5C deploy as a **preview** (drop `--prod`).
- **Monthly:** the backup is alive. The newest `tegridy-farms-*` bundle in `OneDrive\git-vault` is
  days old at most, `Get-ScheduledTaskInfo -TaskName git-vault-backup` shows `LastTaskResult` 0,
  and healthchecks.io shows `git-vault-backup` UP.
- **Monthly:** build a fresh vault and push it to the vault project (2B step 2):
  `VAULT=/c/Users/jimbo/git-vault/tegridy-farms-$(date +%F).git bash scripts/git-hosting/consolidate-refs.sh`.
  It must end `OK vault=...` with `commits that could not be staged: 0`. It reads the older vaults.
- **Each quarter:** walk 5A on paper with the owner and check that every click path still exists.

### 5E. Seed or catch up a host

Seed a host only from a copy that holds every branch: a mirror clone of the host that survived,
or, for the private vault project only, a vault. Never from a working clone: most of its
branches are only remote-tracking refs, so `push-all.sh` refuses it.

```
SRC=/c/Users/jimbo/git-vault/host-copy-$(date +%F).git
git clone --mirror <the surviving host's URL> "$SRC"
bash scripts/git-hosting/push-all.sh "$SRC" <host URL> --dry-run      # add --gitlab for a GitLab host
bash scripts/git-hosting/push-all.sh "$SRC" <host URL>
```

- A new, empty host ends with the usual `OK` line.
- A host that came back already holds its old refs. `push-all.sh` only moves them forward, then
  lists as `EXTRA` the refs that only that host has (mostly branches deleted after a merge) and
  stops. Nothing was deleted. Review the list; that stop is expected here. A branch that moved
  differently on each host is rejected and listed as `DIFFERS`: decide by hand which one wins.
- A protected `mvp-launch` rejects the push. On GitLab, set **Allowed to push and merge** to
  Maintainers for this one run, then back to what it was.

---

## 6. What happened from 2026-09-24

- **2026-09-24:** GitHub suspended the account `fomotsar-commits`. Every git, `gh` and API call
  returned 403. Production kept serving trunk `434fb635`, but nothing could merge or deploy. The
  CI, the scheduled jobs, the PR history and Vercel's deploy trigger all lived on GitHub. The
  commits did not: every one was still in a local clone or a bundle.
- **The silent part:** GitHub's scheduled workflows stopped from that day, for more than five
  days, and nothing told anyone. A schedule that does not fire makes no failed run and sends no
  email. They had still not resumed when the account came back. That is why every alarm on a
  schedule, 2E and 2G included, lives outside the thing it watches, and is armed by a first ping.
  GitHub's scheduler itself now has one too: the `github-crons` heartbeat
  (`docs/OPS_SCHEDULER.md`).
- **2026-09-29:** the refs of every clone and bundle went into one vault. The first build missed
  11 of the OneDrive clone's 12 stash entries (only the newest is a ref). A fresh vault,
  `C:\Users\jimbo\git-vault\tegridy-farms-v2.git`, was built with the fixed script: 612 branches,
  720 tags, 12 of 12 stash entries, 0 lost. Its bundle is in `C:\Users\jimbo\OneDrive\git-vault\`.
- **2026-09-29:** the 9 Supabase backup artifacts on GitHub (2026-07-30 to 2026-09-21) were
  downloaded to `C:\Users\jimbo\OneDrive\backups\supabase-github\`. They are complete: production
  holds 4 `native_orders` rows and no rows elsewhere, and each backup is about 2 KB. Backups never
  live only on GitHub again.
- **2026-09-29:** a plan to make GitLab the primary, with Bitbucket as standby, was built and
  tested. Its scripts are the ones in `scripts/git-hosting/`.
- **2026-09-29/30:** GitHub reinstated the account. The repository is public again, Actions is
  on, all 15 workflows are active, and the trunk is still `434fb635`.
- **The decision:** GitHub stays primary, GitLab becomes a live standby, and GitHub is never the
  only copy again (section 1 has the reasons). Bitbucket moved to Appendix A.

---

## 7. Credentials

Names only. No value is ever written in this repo, a doc, a commit or a chat.

### 7A. GitHub Actions secrets and variables

Secret values cannot be read back, only replaced.

| Name | Kind | Used by | Set on GitHub? | Where the value survives |
|---|---|---|---|---|
| `GITLAB_MIRROR_SSH_KEY` | secret | `mirror-to-gitlab.yml` | from 2C | Only there. Lost: make a new pair (2C) |
| `HC_PING_URL_GITLAB_STANDBY` | secret | `mirror-to-gitlab.yml` | from 2E | healthchecks.io |
| `HC_PING_URL_GITHUB_CRONS` | secret | `synthetic-monitor.yml` (the heartbeat) | from `docs/OPS_SCHEDULER.md` section 2 | healthchecks.io |
| `BACKUP_PASSPHRASE` | secret | `supabase-backup.yml` | yes | **Only your offline copy.** Lose it and every old backup is unreadable. |
| `SUPABASE_SERVICE_KEY` | secret | `supabase-backup.yml` | yes | Vercel production env (viewable) and the Supabase dashboard |
| `SUPABASE_URL` | secret | `supabase-backup.yml` | yes | Vercel `SUPABASE_URL`; derivable from the project ref |
| `VITE_WALLETCONNECT_PROJECT_ID` | secret | `ci.yml` | **no** (CI built the path without it) | Vercel, Reown. Nothing to re-create. |
| `ANVIL_FORK_URL` | secret | `ci.yml` | **no** (CI used a public RPC) | Nothing to re-create |
| `ETH_RPC_URL` | secret | `arb-linkage-monitor.yml` | **no** | `contracts/.env` locally |
| `GITHUB_TOKEN` | automatic | gitleaks, release | automatic | GitLab's `CI_JOB_TOKEN` stands in after a failover but **cannot open issues** |
| `TEGRIDY_LENDING` | variable | `arb-linkage-monitor.yml` | unknown | Lending is not deployed |
| `SOLANA_FEE_ACCOUNT` | variable | `revenue-watch.yml` | unknown | Probably unset everywhere |
| `SOLANA_RPC`, `ETH_RPC`, `BASE_RPC` | variables | `registry-onchain.yml` | unknown | Public fallbacks are built in |

### 7B. Credentials the standby adds

| Credential | Made in | Kept in | Used for |
|---|---|---|---|
| GitLab login: Google, plus a password, 2FA and recovery codes | 2A | your password manager; codes offline | everything on GitLab |
| Deploy key `github-actions-mirror` | 2C | private half: only the GitHub secret; public half: GitLab | the mirror workflow's pushes |
| Git Credential Manager sign-in (gitlab.com) | the first push | Windows Credential Manager | your pushes and fetches; it refreshes on its own |
| healthchecks.io checks `gitlab-standby`, `git-vault-backup` | 2E, 2G, in the one account `docs/OPS_SCHEDULER.md` section 2 makes | healthchecks.io; the ping URLs as named in 2E and 2G | the alarms |
| Vercel's login connection to GitLab | 2F | Vercel | the failover's deploy trigger; revocable in GitLab |
| Only in a failover: glab sign-in, runner tokens (`glrt-...`) | 5A | Windows Credential Manager; the runner host | merges and CI on GitLab |

### 7C. Expiry calendar

A key or token that expires breaks the mirror or an alarm. The run goes red, but only when
someone looks. When you create one with an expiry, add its date here in a PR. Dates only.

| Credential | Created | Expires | Renew by |
|---|---|---|---|
| Deploy key `github-actions-mirror` (if an expiry was set) | | | |
| Bitbucket API token (Appendix A, if used) | | | |
| GitLab service-account or personal tokens (failover only) | | | |

---

## 8. Dates to beat

| Date | What happens | Status |
|---|---|---|
| ~2026-10-01 | `git gc` in the OneDrive clone may prune 280 commits whose only copy is a bundle | Covered: the v2 vault holds them, and all 12 stash entries |
| 2026-10-20 | The BAYLA mainnet build artifact expires on GitHub | A local copy exists and its hash matches |
| ~2026-10-28 to 2026-12-20 | The 9 Supabase backup artifacts expire on GitHub | Covered: downloaded to OneDrive on 2026-09-29 |
| 2026-11-16 | The npm-advisory baseline expires; 24 advisories start blocking CI | CI workstream |
| 2026-11-23 to 12-08 | The BAYLA reload window | Operator task |
| 2026-12-23T15:32Z | BAYLA emission stops unless reloaded | Operator task |
| as set | The deploy key's expiry, if one was set | Section 7C |

---

## 9. The other runbooks, and what is not covered

Each has its own doc:
- **CI on GitLab, for a failover:** `docs/CI_ON_GITLAB.md`. `.gitlab-ci.yml` runs the
  `.github/workflows/` files unchanged, only when `TEGRIDY_CI_ON_GITLAB` is `1`.
  `scripts/ci/local-gates.sh` is the gate while no runner exists. Nothing is ported: GitLab runs
  whatever workflow files the trunk holds. Where the runner may live is the owner's open decision
  (TODO O-0929-CI1); a VPS is preferred. Until it is written down there: never the shell executor
  on the PC that holds keys. Every runner here uses the shell executor, so no runner on that PC.
- **Scheduled jobs:** `docs/OPS_SCHEDULER.md`. Day to day GitHub runs them, the `github-crons`
  heartbeat says when they stop, and the owner's PC copies GitHub's backups weekly. In a
  failover, Windows Task Scheduler runs them with healthchecks.io alarms, not GitLab schedules.
- **Source links through our own domain:** `docs/DEPLOY_RUNBOOK.md`, "Moving the source links
  to another git host". The `/source` rules point at GitHub day to day, and 5A step 6 moves them.
  The on-chain security.txt of the live cp-swap program is item O-0929-10 of
  `docs/TODO_OPERATOR.md`.

Not covered:
- **Builds that fetch from public github.com** (submodules, foundryup, anchor, gitleaks). They read
  other owners' repositories, so only an outage of github.com itself stops them.
- Do not retire the OneDrive clone while `C:\Users\jimbo\tegridy-ops` hangs off it. That worktree
  holds operator keys, and `worktree remove --force` deletes ignored files.

---

## Appendix A. Bitbucket, an optional third copy

Not part of the setup. Use it if the owner wants a copy on a third company, or as the new standby
if GitLab is lost (5B). Its address: `https://bitbucket.org/memetics-finance/tegridy-farms.git` (call it
`THIRD` below). The Free plan allows 1 GB per workspace; the repo fits.

1. Sign up at `bitbucket.org` with **your email**, not a Google, Apple, Microsoft or GitHub button.
   Turn on two-step verification (`id.atlassian.com` > **Security** > **Two-step verification**).
2. Name the workspace `memetics-finance`. **Create > Repository**: `tegridy-farms`, **private**, "Include a
   README?" = **No**, .gitignore = **No**, default branch `mvp-launch` (advanced settings).
3. Seed it from a mirror clone of GitHub (2B step 1), **without** `--gitlab` (Bitbucket does not
   take GitLab's push option): `push-all.sh "$M" "$THIRD" --dry-run`, then without `--dry-run`.
4. Protect `mvp-launch` **before** anything keeps it current: repository **Settings > Workflow >
   Branch restrictions > Add a branch restriction**, branch `mvp-launch`. Leave **Allow rewriting
   branch history** and **Allow deleting this branch** unticked, with no exemptions, so they bind
   everyone.
5. Keep it current in one of two ways:
   - **By hand, monthly:** a fresh mirror clone of GitHub, then `push-all.sh` again. It only moves
     refs forward, and lists as `EXTRA` the branches deleted on GitHub since. Nothing is deleted.
   - **A GitLab push mirror from the standby.** Make a Bitbucket API token (app passwords stopped
     working on 2026-06-09): avatar > **Account settings** > **Security** > **Create and manage API
     tokens** > **Create API token with scopes**, name `gitlab-push-mirror`, expiry one year (write
     it in 7C), app **Bitbucket**, scopes `read:repository:bitbucket` and
     `write:repository:bitbucket`. It is shown once; paste it only into GitLab's form. In GitLab,
     the standby project: **Settings > Repository > Mirroring repositories**, URL `$THIRD`,
     direction **Push**, username your Bitbucket username exactly as your profile shows it (it is
     case-sensitive) or `x-bitbucket-api-token-auth`, password the token. **Keep divergent refs:
     off** (GitLab lets you change it later only through its API), so a branch force-pushed to the
     standby is overwritten on Bitbucket too; step 4 keeps that from ever rewinding `mvp-launch`.
     **Only mirror protected branches: off.** Then **Mirror repository** and **Update now**.
6. As the standby after 5B: `set-remotes.sh <clone> "$PRIMARY" "$THIRD"` (the remote is named
   `bitbucket`), and the workflow needs Bitbucket's published host key and a deploy key there.
