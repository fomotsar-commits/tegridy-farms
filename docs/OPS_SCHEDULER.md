# Scheduled jobs: where they run, and how you hear about them

Written 2026-09-29. Retargeted 2026-09-30, when GitHub came back as the primary host. The
owner's steps live in [TODO_OPERATOR.md](TODO_OPERATOR.md).

## The short version

- **GitHub Actions runs the scheduled jobs, day to day.** That is ten scheduled workflows
  (the monitors, the weekly Supabase backup, the hourly 30-day delete of error reports, CodeQL,
  contract coverage, and the daily full copy to the GitLab standby) plus Dependabot. Nothing
  here replaces them.
- **In September 2026 those schedules stopped for more than five days, and nothing told
  anyone.** Every alarm they had lived on GitHub too. Three additions fix that:
  1. **A dead-man switch.** Every 30 minutes, the last step of `synthetic-monitor.yml` pings
     healthchecks.io. If GitHub's schedules stop, the pings stop, and healthchecks.io emails
     you (section 2).
  2. **A second home for the backups.** Once a week this PC copies GitHub's newest Supabase
     backups into OneDrive and checks them. It fails loudly if the weekly backup has stopped
     (section 4). Backups never live only on GitHub again.
  3. **A failover runner.** If GitHub is gone, the six jobs it ran can run on this PC, or any
     machine, through `scripts/ops/run-job.mjs`, still reporting to healthchecks.io
     (section 5).
- **Nothing runs on this PC until you register the task** (TODO_OPERATOR.md, O-0929-OPS3).

## 1. Day to day: what runs where

| Job | Runs on | How often | A problem reaches you through |
|---|---|---|---|
| `synthetic-monitor.yml` | GitHub | every 30 minutes | a `prod-incident` GitHub issue |
| its last step, the heartbeat | GitHub | every 30 minutes | the `github-crons` check, when the pings stop |
| the other scheduled workflows: arb linkage, revenue watch, registry, npm advisories, Supabase backup, error retention, CodeQL, contract coverage | GitHub | as each workflow says | GitHub's own notices |
| `mirror-to-gitlab.yml`, the daily full copy to the standby | GitHub | daily, 06:41 UTC | the `gitlab-standby` check (`docs/GIT_HOSTING.md` 2E) |
| `backup-pull` | this PC (Task Scheduler) | weekly, Wednesday 12:53 local | the `backup-pull` check |
| `git-vault-backup`, the daily git bundles | this PC (Task Scheduler) | daily, 03:30 local | the `git-vault-backup` check (`docs/GIT_HOSTING.md` 2G) |

**What the heartbeat covers, and what it does not.** It shows that GitHub's scheduler is
running. It does not show that each workflow runs. One workflow can stop alone: GitHub runs
nothing from a workflow file it cannot parse, and anyone with access can disable a workflow by
hand. The backup is still watched from outside GitHub, by the pull's STALE check (section 4).
The other scheduled workflows are not. GitHub's rule that disables schedules after 60 days
without repo activity stops them all at once, so the heartbeat catches that.

## 2. Set up the alarms once (healthchecks.io, free)

1. Sign up at healthchecks.io with **email and a password, and turn on two-factor**. Do not
   use "Sign in with GitHub": this alarm must work when GitHub does not.
2. Add your email as a notification channel. Telegram or ntfy also work, if you want your
   phone. Then, in **Account Settings > Email Reports**, turn on **daily reminders**: while
   any check is DOWN, you get a reminder each day, not only the first email.
3. Create these checks, with the "Simple" schedule. This is every check used day to day; the
   last two belong to the git-hosting setup, which says when to make them:

   | Check | Pinged by | Period | Grace |
   |---|---|---|---|
   | `github-crons` | GitHub: the last step of `synthetic-monitor.yml` | 30 minutes | 90 minutes |
   | `backup-pull` | this PC, weekly | 7 days | 1 day |
   | `gitlab-standby` | GitHub: `mirror-to-gitlab.yml`, daily and on each run by hand (`docs/GIT_HOSTING.md` 2E) | 1 day | 12 hours |
   | `git-vault-backup` | this PC, daily (`docs/GIT_HOSTING.md` 2G) | 1 day | 1 day |

4. Put each ping URL where its sender reads it:
   - `github-crons`: a GitHub repository secret named `HC_PING_URL_GITHUB_CRONS`
     (Settings > Secrets and variables > Actions > New repository secret).
   - `backup-pull`: `ops.env` (section 3), as `HC_PING_URL_BACKUP_PULL`.
   - `gitlab-standby`: the GitHub secret `HC_PING_URL_GITLAB_STANDBY`; `git-vault-backup`:
     `ops.env`, as `HC_PING_URL_GIT_VAULT_BACKUP` (`docs/GIT_HOSTING.md` 2E and 2G).
5. Create the six failover checks now too (section 5 lists them). A check that has never been
   pinged stays grey and sends nothing, and having them ready saves time in a failover.

The grace is long because GitHub often starts a scheduled run late. With these values, two
hours without a ping means GitHub's schedules have stopped.

**How the heartbeat behaves.** Every run of Synthetic Monitor pings the check, whether its
probe passed or failed. The check answers one question: did GitHub's schedule fire? The ping
never says "fail". A fail would hold the check DOWN for as long as prod is failing, and while
it is DOWN, a stop in GitHub's schedules sends no new email. A failing probe is reported by
the `prod-incident` issue instead. The ping's body still carries the probe's result and
report, so the check's event log shows a failed probe too. The URL reaches curl on stdin,
never on a command line. A missing secret, or a ping that does not get through, is a warning
in the run, never a red run: the missing ping is itself the alarm.

**What the emails mean.**
- `github-crons` DOWN: the pings stopped. GitHub's schedules stopped, Synthetic Monitor was
  disabled, or the secret was removed or changed. A failing probe does not do this.
- `backup-pull` DOWN: read its report. "STALE" means GitHub's weekly backup has not succeeded
  for 9 days.
- You get one email per change, not one per run. While a check is DOWN for one reason, a
  second reason sends no new email; the daily reminder (step 2) keeps it in front of you. Fix
  the first reason, or pause the check on purpose.

## 3. The env files (secrets live here, and only here)

Day to day only `ops.env` matters, and it needs two lines: `HC_PING_URL_BACKUP_PULL`, and
`HC_PING_URL_GIT_VAULT_BACKUP` for the git bundles (`docs/GIT_HOSTING.md` 2G). A failover adds
more (section 5). Both files live in `C:\Users\jimbo\tegridy-ops-env\`:

- **`ops.env`**, which every task reads: the healthchecks ping URLs and any RPC overrides.
  Start from `scripts/ops/ops.env.example`.
- **`backup.env`**, which only the backup reads: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
  `BACKUP_PASSPHRASE`, and `BACKUP_DIR` if you set one. Start from
  `scripts/ops/backup.env.example`. Day to day you do not need it: GitHub takes the backup.
  `register-tasks.ps1` refuses an `ops.env` that holds the service key or the passphrase.

Rules for both:

- They must sit **outside every repo**; the scripts refuse a file inside one. Keep them **out of
  OneDrive** too, so the service key is not synced to the cloud; `register-tasks.ps1` refuses a
  OneDrive path.
- The format is `NAME=value`. Everything after the first `=` is the value, including any `#`.
  Wrap a value in straight single quotes if it starts or ends with a space. The scripts refuse,
  rather than guess at, two things: an unquoted value with ` #` in it (quote it, or put the note
  on its own line), and a value in curly quotes (the kind a document or chat app pastes; retype
  them as straight quotes).
- Always pass a file with the script's own flag, after the script name:
  `node scripts\ops\run-job.mjs <job> --env-file C:\Users\jimbo\tegridy-ops-env\ops.env`.
  **Never use `node --env-file`.** Node's parser cuts every unquoted value at `#`, so a passphrase
  with a `#` in it would silently change, and the backups would be encrypted with a passphrase
  nobody holds.

**What the split protects, and what it does not.** The monitors never load the backup secrets.
But every task runs as your Windows user, so code that a job runs could still read either file
from disk. The stronger fix is to run the backup on its own machine or as its own Windows user.

## 4. The weekly backup pull (day to day)

`backup-pull` copies GitHub's Supabase backups to a folder GitHub does not own,
`%USERPROFILE%\OneDrive\backups\supabase-github\`, in the same layout as the first download on
2026-09-29:

```
<date>-run<id>\supabase-backup-<id>\supabase-backup-<date>.tar.gz.gpg
```

What one run does:
- It makes **one** `gh run list` call, then one download for each run it does not hold yet,
  **at most three, one at a time**. A burst of gh calls came just before the 2026-09-24
  suspension, so it never loops.
- It trusts only runs that the schedule or a person (Run workflow) started. A run started any
  other way, such as by a pull request, is named in the report and skipped. A pull request
  can run an edited copy of the workflow and upload anything.
- It fetches runs newer than the newest one it holds, and any run under 28 days old that it
  is still missing, such as one whose download failed; 28 days is four weekly pulls. Older
  gaps are not tried: runs that never made a backup, runs whose files GitHub has deleted
  (after 90 days), or runs that kept failing for four weeks. If more than three runs are due,
  it takes the newest three.
- It checks every file in the folder, old and new. Each must be non-empty, open with gpg's
  AES256 session-key packet, and end exactly where its encrypted data ends, so a truncated copy
  fails. It does not decrypt: day to day, no passphrase is on this PC.
- It writes `SHA256SUMS` at the top of the folder. A file that changed after it was recorded
  fails the run, and the record is not rewritten.

It fails when:
- GitHub's newest successful backup is **more than 9 days old**: the weekly backup has stopped.
  The pull runs on Wednesdays, so a single missed Monday backup is already past 9 days.
- A download or a file check fails. A failed download does not stop the other downloads. The
  report says whether later pulls try that run again, and until what date.
- A run is due but more than 28 days old, and newer runs took all three downloads. It stays on
  GitHub only, and the report names it so you can download it by hand. A due run under 28 days
  old just waits for the next pull; that is not a failure.

**It needs the GitHub CLI, logged in as you.** gh keeps its login in the Windows credential
store, and a task that runs while you are signed out is not expected to be able to read it. So
this task runs only while you are signed in, **in a console window**. Leave the window open
until it closes by itself: closing it stops the pull, and the `backup-pull` check then goes
DOWN. If the PC was off on Wednesday, it runs at your next sign-in.

By hand, from a checkout: `node scripts\ops\pull-github-backups.mjs`.

**Prove your offline passphrase opens GitHub's backups** (once, and again after any change to
the passphrase):
```
node scripts\ops\supabase-restore-check.mjs <the newest .gpg file in that folder> --prompt
```
Paste the passphrase from your offline copy (nothing shows as you type). You should see
`Readable: all 10 tables present.` If it cannot decrypt, the offline copy is not the passphrase
GitHub uses: stop and say so.

## 5. Failover: GitHub is gone

This is the scheduled-jobs part of the failover drill (`docs/GIT_HOSTING.md` 5A, step 8). The
git remotes, Vercel and the source links are in the rest of that drill.

1. **Pause the `github-crons` and `backup-pull` checks** in healthchecks.io. With GitHub gone,
   `github-crons` goes DOWN within two hours, and `backup-pull` about eight days after its
   last ping (step 4 removes its task). Both are expected. Paused, they cannot hide anything
   else.
2. **Take a backup by hand** (section 6). The newest pulled GitHub backup is up to a week old.
3. **Put the six failover ping URLs in `ops.env`**, as `HC_PING_URL_<JOB>` (for example
   `HC_PING_URL_SYNTHETIC_MONITOR`). The checks, if you have not made them yet:

   | Check | Period | Grace |
   |---|---|---|
   | `arb-linkage-monitor` | 15 minutes | 30 minutes |
   | `synthetic-monitor` | 30 minutes | 30 minutes |
   | `revenue-watch` | 1 hour | 1 hour |
   | `registry-onchain` | 1 day | 2 hours |
   | `npm-advisories` | 1 day | 2 hours |
   | `supabase-backup` | 7 days | 1 day |

4. **Register the failover tasks.** From the tasks' checkout (section 7), in an **elevated**
   PowerShell (Run as administrator):
   ```
   powershell -ExecutionPolicy Bypass -File scripts\ops\register-tasks.ps1 -Failover -DryRun
   powershell -ExecutionPolicy Bypass -File scripts\ops\register-tasks.ps1 -Failover
   ```
   It registers the six jobs and removes `backup-pull`, which has nothing left to pull from. The
   dry run lists each task, its time limit, and the env files it reads; only `supabase-backup`
   reads `backup.env`. The tasks run whether or not you are signed in, with no window. If you
   cannot elevate, add `-LogonType Interactive`: they then run only while you are signed in.
5. **Test one,** then check healthchecks.io shows the ping:
   ```
   Start-ScheduledTask -TaskPath '\Tegridy\' -TaskName 'synthetic-monitor'
   ```

What the failover runs, and what counts as a failure:

| Job | What it checks | How often | It fails when |
|---|---|---|---|
| `synthetic-monitor` | The site, three API routes, the two redirect hosts, `memetic.fun` not serving us, and the Railway indexer's `/ready` | every 30 minutes | any probe fails |
| `arb-linkage-monitor` | The TWAP safety condition (native pool vs Uniswap pool), plus the pause plan | every 15 minutes | HALT, an unreadable chain, or the rule failing its own tests. WARN, today's standing state, passes |
| `revenue-watch` | Every fee rail, and fees stranded in `callerCredit` | hourly, at :17 | a rail cannot be read, or the picture changed. A change is news, not a fault; the next run clears it |
| `registry-onchain` | The address registry against the chain, and the ladder pools' bytecode | daily, 12:41 local | any mismatch, or nothing was actually read |
| `npm-advisories` | Known high or critical advisories in the three lockfiles | daily, 13:37 local | a new advisory appears that the allowlist does not cover. It fails once per new advisory; later runs still list it but pass, so a known one cannot hold the alarm down and hide the next |
| `supabase-backup` | The ten tables, dumped, encrypted and checked | weekly, Monday 12:23 local | any table was not read whole, each row exactly once, or the passphrase is not the one you proved (section 6) |

Each job reuses the script its GitHub workflow ran. Where a workflow had its logic inline in bash
(the site probes, the fee-rail reads, the backup), that logic is ported to Node with the same
rules. Nothing runs more often than every 15 minutes. The daily and weekly jobs run in the early
afternoon because this PC is off at night; a server uses the workflows' UTC times (below).

**Not covered off GitHub:**
- CodeQL: not run off GitHub. Its licence covers CI only for code hosted on GitHub.com, and it
  never blocked a merge. GitLab's failover CI does not run it either; Slither and gitleaks still
  run there (`docs/CI_ON_GITLAB.md`). Nothing on this PC runs it.
- Contract coverage: not run off GitHub, by decision. Its floor enforces nothing yet, and it
  needs forge 1.7.1.
- Dependabot: `npm-advisories` covers its security half. Renovate can replace the rest on GitLab.
- The wallet-reputation monitor never shipped (branch `fix/wallet-reputation-watch`). When it
  ships, add it as a job here too.

**What to expect.** When this PC is off or asleep, the pings stop and healthchecks.io emails you.
That is correct: it means nothing is watching. The 15-, 30- and 60-minute checks go DOWN every
night the PC is off, and come back UP in the morning. Each job's last report is in
`%LOCALAPPDATA%\tegridy-ops\<job>.last.txt`. Exit codes: 0 passed, 1 failed, 2 setup or usage
error, 3 passed but the ping was not delivered. Task Scheduler stores each start time in UTC, so
after a daylight-saving change the daily and weekly jobs run an hour earlier or later by the
clock. That is harmless in the afternoon.

Run one job by hand:
```
node scripts\ops\run-job.mjs synthetic-monitor --env-file C:\Users\jimbo\tegridy-ops-env\ops.env
```
The backup needs both files: add `--env-file C:\Users\jimbo\tegridy-ops-env\backup.env`. Without
`--env-file` (or without that job's ping URL), the job still runs, and prints a loud warning that
no alarm will hear the result.

**If the failover lasts more than a week or two, move it off this PC.** The runner needs only
Node 20 or newer, gpg, and a checkout.

- **A small always-on Linux machine** (a $5 a month server, or a free cloud VM). Clone the repo,
  run `npm ci --ignore-scripts` in `frontend/`, put both env files outside the clone
  (`chmod 600`), set `BACKUP_DIR` in `backup.env`, and add these crontab lines (with the
  machine's clock on UTC; these are the workflows' times):
  ```
  */15 * * * * cd /opt/tegridy && node scripts/ops/run-job.mjs arb-linkage-monitor --env-file /etc/tegridy-ops/ops.env
  */30 * * * * cd /opt/tegridy && node scripts/ops/run-job.mjs synthetic-monitor --env-file /etc/tegridy-ops/ops.env
  17 * * * *   cd /opt/tegridy && node scripts/ops/run-job.mjs revenue-watch --env-file /etc/tegridy-ops/ops.env
  41 6 * * *   cd /opt/tegridy && node scripts/ops/run-job.mjs registry-onchain --env-file /etc/tegridy-ops/ops.env
  37 7 * * *   cd /opt/tegridy && node scripts/ops/run-job.mjs npm-advisories --env-file /etc/tegridy-ops/ops.env
  23 4 * * 1   cd /opt/tegridy && node scripts/ops/run-job.mjs supabase-backup --env-file /etc/tegridy-ops/ops.env --env-file /etc/tegridy-ops/backup.env
  ```
- **Not Vercel for `synthetic-monitor`.** Vercel cannot report its own outage.
- **GitLab scheduled pipelines** suit only the daily and weekly jobs. The free tier allows ten
  schedules, each at most 24 runs a day (so hourly at best), and too few minutes for the 15- and
  30-minute monitors.

Keep the same healthchecks.io checks; point the new machine at the same ping URLs. Then run
`register-tasks.ps1 -Remove` here. Do not leave two machines running the same job: two sets of
pings on one check would hide a dead one.

## 6. Take a backup by hand (in a failover, or before a risky change)

Day to day GitHub takes the backup. Take one by hand when GitHub is gone, or before a risky
database change. Use PowerShell, in the tasks' checkout (section 7) or any checkout outside
OneDrive that has `scripts/ops`.

1. **Find the backup passphrase** (your offline copy, made 2026-07-30). New backups can use a new
   passphrase. Keep both.
2. Get `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from the Supabase dashboard (**Settings > API
   Keys**) or from Vercel's production environment variables. Use the legacy `service_role` key
   (it starts with `eyJ`) or a secret key (it starts with `sb_secret_`). Never the `anon` or
   publishable key: it would copy only what the public can see, so the backup refuses it.
3. Put the three values in `backup.env` (section 3), each in straight single quotes.
4. Run:
   ```
   node scripts\ops\supabase-backup.mjs --env-file C:\Users\jimbo\tegridy-ops-env\backup.env
   ```
   You should see ten tables with row counts, then `Wrote ...` and `decrypted back and matched
   before it was kept`. If any table cannot be read whole, it fails and writes nothing.
5. **Prove your offline passphrase opens it:**
   ```
   node scripts\ops\supabase-restore-check.mjs --latest --prompt --env-file C:\Users\jimbo\tegridy-ops-env\backup.env
   ```
   The env file only tells it where the backups are (`BACKUP_DIR`); with `--prompt` the
   passphrase always comes from your keyboard. You should see `Readable: all 10 tables
   present.`, then `Saved ...passphrase-canary.gpg`. That file is a few bytes encrypted with the
   passphrase you typed. Every later backup first checks that the env file's passphrase opens
   it, and stops if not, so a later edit cannot quietly change the passphrase. To change the
   passphrase on purpose: delete `passphrase-canary.gpg` from the backup folder, change
   `backup.env`, take a backup, and repeat this step.
6. The default folder is `%USERPROFILE%\OneDrive\backups\supabase` (not the pull's folder). The
   file is encrypted, so OneDrive is a safe offsite copy. Add another away from this PC: a USB
   drive now, or a storage bucket later.

The file format is exactly the GitHub workflow's, so the restore steps in
[`frontend/supabase/RESTORE.md`](../frontend/supabase/RESTORE.md) work unchanged. Each backup is
`supabase-backup-<date>T<time>Z.tar.gz.gpg` plus a `.sha256` file. The newest 26 are kept; files
the tool did not write (GitHub downloads, the canary) are never deleted.

## 7. The tasks' checkout

The tasks run whatever code is in a checkout of their own, **outside OneDrive** (OneDrive
hollows `node_modules`). Make it once, day to day, because `backup-pull` needs it too. It is a
detached checkout of the trunk, as your clone last fetched it:
```
git -C C:\Users\jimbo\dev\tegridy-farms fetch origin
git -C C:\Users\jimbo\dev\tegridy-farms worktree add --detach C:\Users\jimbo\ops\tegridy-monitors origin/mvp-launch
```
Before this work is on the trunk, use its branch, `infra/git-host-independence`, in place of
`origin/mvp-launch`. For a failover, also run `npm ci --ignore-scripts` in its `frontend\`
folder; `registry-onchain` needs it.

To update it after changes to `scripts/ops` land:
```
git -C C:\Users\jimbo\ops\tegridy-monitors fetch origin
git -C C:\Users\jimbo\ops\tegridy-monitors checkout --detach origin/mvp-launch
```
`origin` fetches from GitHub day to day and from GitLab after a failover's remote swap, so the same
two lines work in both cases.

Then register the day-to-day task from that checkout. It needs no elevation:
```
powershell -ExecutionPolicy Bypass -File scripts\ops\register-tasks.ps1 -DryRun
powershell -ExecutionPolicy Bypass -File scripts\ops\register-tasks.ps1
Start-ScheduledTask -TaskPath '\Tegridy\' -TaskName 'backup-pull'
```
Running the script again replaces the task. `-Remove` deletes every task this script made. The
task opens a console window each time it runs (section 4): leave it open.

## 8. When GitHub comes back after a failover

This is the scheduled-jobs part of `docs/GIT_HOSTING.md` 5A.2, which has the whole list.

1. **Pause the six failover checks** in healthchecks.io. Then, from the tasks' checkout, in an
   **elevated** PowerShell (Run as administrator), run `register-tasks.ps1 -DryRun` and then
   `register-tasks.ps1`, both without `-Failover`. It removes the six failover tasks and
   registers `backup-pull` again. Elevated, because an elevated shell registered the six
   tasks, and a normal shell may not see them to remove them. One scheduler per job: never let
   this PC and GitHub run the same monitor.
2. **Unpause `github-crons` and `backup-pull`.** `github-crons` should turn UP within 30
   minutes of GitHub's first scheduled run of Synthetic Monitor. `backup-pull` reports STALE
   until GitHub takes a backup again: run Supabase Backup by hand from the Actions tab, then
   `Start-ScheduledTask -TaskPath '\Tegridy\' -TaskName 'backup-pull'`.
3. **If it stays DOWN, GitHub's schedules have not resumed.** That is what happened after the
   2026-09-24 suspension: more than five days with no scheduled run and no notice; the cause
   was not known when this was written. Run Synthetic Monitor by hand from the Actions tab
   (Run workflow). If that turns the check UP, the secret and the step work, and only the
   schedules are missing.
4. **Keep the backups you took by hand during the failover.** The pull copies only GitHub's.

## 9. Settings (names only)

| Name | Where | Used by | Needed? |
|---|---|---|---|
| `HC_PING_URL_GITHUB_CRONS` | GitHub repository secret | the heartbeat step of `synthetic-monitor.yml` | yes; without it each run warns and nothing outside GitHub is watching |
| `HC_PING_URL_BACKUP_PULL` | `ops.env` | `backup-pull` | yes |
| `BACKUP_PULL_DIR`, `GH_BIN` | `ops.env` | `backup-pull` | no (defaults: `%USERPROFILE%\OneDrive\backups\supabase-github`, and `gh` on PATH) |
| `HC_PING_URL_<JOB>`, one per failover job | `ops.env` | the failover jobs | in a failover, or that job reaches no alarm |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BACKUP_PASSPHRASE` | `backup.env` | `supabase-backup` | for a backup by hand |
| `BACKUP_DIR`, `BACKUP_KEEP` | `backup.env` | `supabase-backup`, `supabase-restore-check --latest` | no (defaults: `%USERPROFILE%\OneDrive\backups\supabase`, 26) |
| `GPG_BIN` | either | `supabase-backup` | no (default: gpg from Git for Windows) |
| `OPS_STATE_DIR` | `ops.env` | where `.last.txt` files, the revenue fingerprint and the known advisories live | no (default `%LOCALAPPDATA%\tegridy-ops`) |
| `ETH_RPC_URL`, `RPC`, `ETH_RPC`, `SOL_RPC`, `SOLANA_RPC`, `BASE_RPC`, `RH_RPC` | `ops.env` | the chain-reading jobs | no; keyless public defaults |
| `SOLANA_FEE_ACCOUNT`, `TEGRIDY_LENDING`, `VENUE_INDEXER_URL` | `ops.env` | revenue, arb, synthetic | no |

The monitors never load `backup.env`, and no job passes the Supabase key, the passphrase or the
ping URLs to the scripts or the `gh` it calls. Any secret-looking value is replaced by its name
before it is printed or pinged. Section 3 says what this does not protect against.

## 10. Where the failover runner differs from the GitHub workflows, on purpose

- **Alarms go to healthchecks.io, not GitHub issues.** It alerts once when a check goes down and
  once when it recovers, which replaces the issues' duplicate suppression.
- **`synthetic-monitor`** adds the Railway indexer's `/ready` probe (it had none). An orderbook
  answer of `degraded:true` still passes, as before, but is now printed as a warning. Failing on
  it would flap: it trips whenever one database read takes over 2.5 seconds.
- **`revenue-watch`** fails whenever any rail cannot be read. The workflow let a permanent
  "earned" hide an unreadable rail. A changed revenue picture sends one fail ping, and the next
  run clears it.
- **`npm-advisories`** fails once for each new advisory, not every day until it is fixed. Every
  report still lists every blocking advisory.
- **`arb-linkage-monitor`** reads the verdict from a file the runner owns. A missing verdict or a
  non-zero exit fails; off GitHub, a script's `$GITHUB_OUTPUT` is otherwise written to nowhere.
- **`supabase-backup`** reads each table in primary-key order, and each page starts on the last
  row of the page before. If rows move between pages (an update, delete or insert during the
  dump), the table fails; the workflow could silently skip a row with the count unchanged. Each
  page also asks for an exact row count, so a short page fails, and the whole dump has a
  20-minute limit. The passphrase is checked against your canary first, and the file is
  decrypted and compared before it is kept.
- **Each task's time limit** is longer than its job's own timeouts plus the pings, so a slow run
  is reported by the runner instead of being killed silently by Task Scheduler.
- **`error-retention` has no failover job.** Off GitHub, `/api/errors` still deletes reports
  older than 30 days after it stores one (at most once an hour per server instance), but not
  while no report arrives. In a failover longer than a day, run it by hand from the repo root
  with `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` set: `node frontend/scripts/purge-error-events.mjs`.
