# Scheduled jobs: where they run, and how you hear about them

Written 2026-09-29, revised 2026-09-30 after review. The owner's to-do items for this live in
[TODO_OPERATOR.md](TODO_OPERATOR.md).

## The short version

- GitHub ran eight scheduled workflows for this project, plus Dependabot. Six of those jobs move
  here: five monitors and the weekly database backup (section 1 says what happens to the rest).
  All of them stopped when the account was suspended on 2026-09-24, and none of them could say
  so, because GitHub was also their alarm and their storage.
- They can now run from one script, `scripts/ops/run-job.mjs`, which needs no git host. Any
  scheduler can call it: Windows Task Scheduler, cron on a server, or a CI schedule. **Nothing
  runs on a schedule until the owner registers the tasks** (TODO_OPERATOR.md, O-0929-3).
- Every run reports to **healthchecks.io**. A failed run alerts you. So does a missing run: if a job
  stops reporting, healthchecks.io emails you. That second alarm is the one that would have caught
  the suspension on day one.
- Backups go to a folder you control, never only to CI storage.
- The first scheduler is Task Scheduler on this PC. That is a stopgap: nothing runs while the PC
  is off or asleep. Move to an always-on machine when you can (section 7).

## 1. What runs, how often, and what counts as a failure

| Job | What it checks | How often | It fails when |
|---|---|---|---|
| `synthetic-monitor` | The site, three API routes, the two redirect hosts, `memetic.fun` not serving us, and the Railway indexer's `/ready` | every 30 minutes | any probe fails |
| `arb-linkage-monitor` | The TWAP safety condition (native pool vs Uniswap pool), plus the pause plan | every 15 minutes | HALT, an unreadable chain, or the rule failing its own tests. WARN, today's standing state, passes |
| `revenue-watch` | Every fee rail, and fees stranded in `callerCredit` | hourly, at :17 | a rail cannot be read, or the picture changed. A change is news, not a fault; the next run clears it |
| `registry-onchain` | The address registry against the chain, and the ladder pools' bytecode | daily | any mismatch, or nothing was actually read |
| `npm-advisories` | Known high or critical advisories in the three lockfiles | daily | a new advisory appears that the allowlist does not cover. It fails once per new advisory; later runs still list it but pass, so a known one cannot hold the alarm down and hide the next |
| `supabase-backup` | The ten tables, dumped, encrypted and checked | weekly | any table was not read whole, each row exactly once, or the passphrase is not the one you proved (section 4) |

On this PC the daily and weekly jobs run in the early afternoon, local time, because the PC is
off at night. A server uses the old workflows' UTC times (section 7).

Each job reuses the script its GitHub workflow ran. Where a workflow had its logic inline in bash
(the site probes, the fee-rail reads, the backup), that logic is ported to Node with the same
rules. The cadences are the workflows' crons. Nothing runs more often than every 15 minutes.

**Not moved, and why:**
- CodeQL (weekly code scanning): it needs GitHub or the CodeQL CLI, so it belongs in the new CI
  host (Semgrep, or GitLab's SAST template). Nothing runs it today: the GitLab CI port does not
  include it yet.
- Contract coverage (weekly): not run, by decision. Its floor enforces nothing yet, and it needs
  forge 1.7.1.
- Dependabot: use Renovate on GitLab. `npm-advisories` already covers the security half.
- The wallet-reputation monitor: never shipped (branch `fix/wallet-reputation-watch`). When it
  ships, make it a job here instead of a GitHub issue flow.

## 2. Set up the alarm once (healthchecks.io, free)

1. Sign up at healthchecks.io with **email and a password, and turn on two-factor**. Never use
   "Sign in with GitHub" for any account in this move.
2. Add your email as a notification channel. Telegram or ntfy also work, if you want your phone.
3. Create one check per job. Use the "Simple" schedule with these values:

   | Check name | Period | Grace |
   |---|---|---|
   | `arb-linkage-monitor` | 15 minutes | 30 minutes |
   | `synthetic-monitor` | 30 minutes | 30 minutes |
   | `revenue-watch` | 1 hour | 1 hour |
   | `registry-onchain` | 1 day | 2 hours |
   | `npm-advisories` | 1 day | 2 hours |
   | `supabase-backup` | 7 days | 1 day |

4. Copy each check's ping URL into `ops.env` (section 3) as `HC_PING_URL_<JOB>`, for example
   `HC_PING_URL_SYNTHETIC_MONITOR`.

**What the emails mean.** "DOWN" arrives when a run fails or when a run is missing. It carries the
job's report, so you can see what broke without opening anything. "UP" arrives when the job passes
again. You get one email per change, not one per run. So a check that stays DOWN hides whatever
happens next, which is why `revenue-watch` and `npm-advisories` fail once per change and then pass.
A `revenue-watch` DOWN can be good news: read the body.

## 3. The env files (secrets live here, and only here)

There are two, both in `C:\Users\jimbo\tegridy-ops-env\`:

- **`ops.env`**, which every job reads: the healthchecks ping URLs and any RPC overrides. Start
  from `scripts/ops/ops.env.example`.
- **`backup.env`**, which only the backup reads: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
  `BACKUP_PASSPHRASE`, and `BACKUP_DIR` if you set one. Start from
  `scripts/ops/backup.env.example`. `register-tasks.ps1` refuses an `ops.env` that holds the
  service key or the passphrase.

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

## 4. Take a backup by hand, today

There is no reachable backup right now: every earlier one is a GitHub artifact, and the oldest
expires around 2026-10-28. Do this first. Use PowerShell, in a checkout outside OneDrive that has
`scripts/ops`. Until this work merges, that is the worktree
`C:\Users\jimbo\dev\wt\ops-off-github-crons`; after it merges, any clone of trunk outside OneDrive.

1. **Find the backup passphrase** (your offline copy, made 2026-07-30). If you cannot find it, say
   so now: every backup stored on GitHub is unreadable without it. New backups can use a new
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
   passphrase always comes from your keyboard. Paste the passphrase from your offline copy when
   asked (nothing shows as you type). You should see `Readable: all 10 tables present.`, then
   `Saved ...passphrase-canary.gpg`. That file is a few bytes encrypted with the passphrase you
   typed. Every later backup first checks that the env file's passphrase opens it, and stops if
   not, so a later edit cannot quietly change the passphrase. To change the passphrase on
   purpose: delete `passphrase-canary.gpg` from the backup folder, change `backup.env`, take a
   backup, and repeat this step.
6. Keep a second copy away from this PC. The default folder, `%USERPROFILE%\OneDrive\backups\supabase`,
   is one offsite copy; the file is encrypted, so that is safe. Add another: a USB drive now, or a
   storage bucket (Cloudflare R2, Backblaze B2) later.

The file format is exactly the old workflow's, so the restore steps in
[`frontend/supabase/RESTORE.md`](../frontend/supabase/RESTORE.md) work unchanged. Each backup is
`supabase-backup-<date>T<time>Z.tar.gz.gpg` plus a `.sha256` file. The newest 26 are kept; files
the tool did not write (old GitHub downloads, the canary) are never deleted.

## 5. Run the monitors on this PC (the stopgap)

1. **Delete the old faucet task first.** `SolanaDevnetFaucet` still runs every two hours. The
   checklist in `docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md` says to delete it. The script below only
   warns about it; it never deletes it for you.
   ```
   Unregister-ScheduledTask -TaskName 'SolanaDevnetFaucet' -Confirm:$false
   ```
2. Make a checkout just for the tasks, **outside OneDrive**. Until this work merges:
   ```
   git -C C:\Users\jimbo\dev\tegridy-farms worktree add --detach C:\Users\jimbo\ops\tegridy-monitors ops/off-github-crons
   ```
   (`--detach` is needed because that branch is already checked out in another worktree.) Then run
   `npm ci --ignore-scripts` in its `frontend\` folder; `registry-onchain` needs it. Run the next
   steps from `C:\Users\jimbo\ops\tegridy-monitors`.
3. Preview what will be created:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\ops\register-tasks.ps1 -DryRun
   ```
   It lists each task, its time limit, and which env files it reads. Only `supabase-backup` reads
   `backup.env`.
4. Register the tasks from an **elevated** PowerShell (Run as administrator):
   ```
   powershell -ExecutionPolicy Bypass -File scripts\ops\register-tasks.ps1
   ```
   The tasks go in the Task Scheduler folder `\Tegridy\`. They run whether or not you are signed
   in, with no window. If you cannot elevate, add `-LogonType Interactive`: the tasks then run
   only while you are signed in, and a console window flashes each time.
5. Test one, then check healthchecks.io shows the ping:
   ```
   Start-ScheduledTask -TaskPath '\Tegridy\' -TaskName 'synthetic-monitor'
   ```
6. Running the script again replaces the tasks. `-Remove` deletes them.

**What to expect.** When this PC is off or asleep, the pings stop and healthchecks.io emails you.
That is correct: it means nothing is watching. The 15-, 30- and 60-minute checks will go DOWN
every night the PC is off, and come back UP in the morning. Each job's last report is in
`%LOCALAPPDATA%\tegridy-ops\<job>.last.txt`. Exit codes: 0 passed, 1 failed, 2 setup or usage
error, 3 passed but the ping was not delivered.

Task Scheduler stores each start time in UTC. After a daylight-saving change, the daily and
weekly jobs run an hour earlier or later by the clock. That is harmless in the afternoon.

The tasks run whatever code is in that checkout. After changes to `scripts/ops` land on trunk,
update it: fetch trunk from the primary git host (GitLab once it exists; GitHub is suspended),
then `git -C C:\Users\jimbo\ops\tegridy-monitors checkout --detach <that remote>/mvp-launch`.

## 6. Run one job by hand

```
node scripts\ops\run-job.mjs synthetic-monitor --env-file C:\Users\jimbo\tegridy-ops-env\ops.env
```

The backup needs both files: add `--env-file C:\Users\jimbo\tegridy-ops-env\backup.env`. Without
`--env-file` (or without that job's ping URL), the job still runs. It prints a loud warning that
no alarm will hear the result.

## 7. Move off this PC (within one to two weeks)

The runner needs only Node 20 or newer, gpg, and a checkout. Good homes:

- **A small always-on Linux machine** (a $5 a month server, or a free cloud VM). Clone the repo,
  run `npm ci --ignore-scripts` in `frontend/`, put both env files outside the clone
  (`chmod 600`), set `BACKUP_DIR` in `backup.env`, and add these crontab lines (with the
  machine's clock on UTC; these are the old workflows' times):
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

## 8. When GitHub comes back

- **Turn off Actions on the GitHub repo before anything is pushed to it.** Otherwise all eight
  old schedules restart, and every monitor runs twice. If the repo's three secrets survived the
  suspension, the old backup also runs and stores backups on GitHub again; if they did not, it
  goes red every week.
- **Then delete those three repo secrets** (`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
  `BACKUP_PASSPHRASE`), so GitHub stops holding a copy of the service key.
- **Do not let GitHub's schedules run alongside this runner.** One scheduler per job. This runner
  stays in charge; GitHub becomes a read-only mirror.
- If the old backup artifacts are still there, download them into the backup folder and check
  each one: `node scripts\ops\supabase-restore-check.mjs <file> --prompt`. (A GitHub-era file never
  replaces your passphrase canary: it may use the old passphrase.)
- Repository variables (`SOLANA_FEE_ACCOUNT`, `TEGRIDY_LENDING`, `SOLANA_RPC`, `ETH_RPC`,
  `BASE_RPC`) can be read back then. Copy any that were set into `ops.env`. Secrets cannot be
  read back.

## 9. Settings the runner reads (names only)

| Name | File | Used by | Needed? |
|---|---|---|---|
| `HC_PING_URL_<JOB>` | `ops.env` | every job | yes, one per job, or the job reaches no alarm |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BACKUP_PASSPHRASE` | `backup.env` | `supabase-backup` | yes |
| `BACKUP_DIR`, `BACKUP_KEEP` | `backup.env` | `supabase-backup`, `supabase-restore-check --latest` | no (defaults: the OneDrive folder, 26) |
| `GPG_BIN` | either | `supabase-backup` | no (default: gpg from Git for Windows) |
| `OPS_STATE_DIR` | `ops.env` | where `.last.txt` files, the revenue fingerprint and the known advisories live | no (default `%LOCALAPPDATA%\tegridy-ops`) |
| `ETH_RPC_URL`, `RPC`, `ETH_RPC`, `SOL_RPC`, `SOLANA_RPC`, `BASE_RPC`, `RH_RPC` | `ops.env` | the chain-reading jobs | no; keyless public defaults |
| `SOLANA_FEE_ACCOUNT`, `TEGRIDY_LENDING`, `VENUE_INDEXER_URL` | `ops.env` | revenue, arb, synthetic | no |

The monitors never load `backup.env`, and no job passes the Supabase key, the passphrase or the
ping URLs to the scripts it calls. Any secret-looking value is replaced by its name before it is
printed or pinged. Section 3 says what this does not protect against.

## 10. Where this differs from the old GitHub workflows, on purpose

- **Alarms go to healthchecks.io, not GitHub issues.** It alerts once when a check goes down and
  once when it recovers, which replaces the issues' duplicate suppression.
- **`synthetic-monitor`** adds the Railway indexer's `/ready` probe (it had none). An orderbook
  answer of `degraded:true` still passes, as before, but is now printed as a warning. Failing on
  it would flap: it trips whenever one database read takes over 2.5 seconds.
- **`revenue-watch`** fails whenever any rail cannot be read. The workflow let a permanent "earned"
  hide an unreadable rail. A changed revenue picture sends one fail ping, and the next run clears
  it.
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
