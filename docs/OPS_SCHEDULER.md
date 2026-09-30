# Scheduled jobs: where they run, and how you hear about them

Written 2026-09-29. The owner's to-do items for this live in [TODO_OPERATOR.md](TODO_OPERATOR.md).

## The short version

- GitHub used to run the project's six unattended jobs: five monitors and the weekly database
  backup. All of them stopped when the account was suspended on 2026-09-24, and none of them could
  say so, because GitHub was also their alarm and their storage.
- They now run from one script, `scripts/ops/run-job.mjs`, which needs no git host. Any scheduler
  can call it: Windows Task Scheduler, cron on a server, or a CI schedule.
- Every run reports to **healthchecks.io**. A failed run alerts you. So does a missing run: if a job
  stops reporting, healthchecks.io emails you. That second alarm is the one that would have caught
  the suspension on day one.
- Backups go to a folder you control, never only to CI storage.
- Today the scheduler is Task Scheduler on this PC. That is a stopgap: it stops when the PC sleeps.
  Move to an always-on machine when you can (section 7).

## 1. What runs, how often, and what counts as a failure

| Job | What it checks | How often | It fails when |
|---|---|---|---|
| `synthetic-monitor` | The site, three API routes, the two redirect hosts, `memetic.fun` not serving us, and the Railway indexer's `/ready` | every 30 minutes | any probe fails |
| `arb-linkage-monitor` | The TWAP safety condition (native pool vs Uniswap pool), plus the pause plan | every 15 minutes | HALT, an unreadable chain, or the rule failing its own tests. WARN, today's standing state, passes |
| `revenue-watch` | Every fee rail, and fees stranded in `callerCredit` | hourly, at :17 | a rail cannot be read, or the picture changed. A change is news, not a fault; the next run clears it |
| `registry-onchain` | The address registry against the chain, and the ladder pools' bytecode | daily, 06:41 UTC | any mismatch, or nothing was actually read |
| `npm-advisories` | Known high or critical advisories in the three lockfiles | daily, 07:37 UTC | a new advisory that is not on the allowlist |
| `supabase-backup` | The ten tables, dumped, encrypted and checked | weekly, Monday 04:23 UTC | any table was not read whole |

Each job reuses the script its GitHub workflow ran. Where a workflow had its logic inline in bash
(the site probes, the fee-rail reads, the backup), that logic is ported to Node with the same
rules. The cadences are the workflows' crons. Nothing runs more often than every 15 minutes.

**Not moved, and why:**
- CodeQL (weekly code scanning): it needs GitHub or the CodeQL CLI. It belongs in the new CI host
  (Semgrep, or GitLab's SAST template).
- Contract coverage (weekly): its floor enforces nothing yet, and it needs forge 1.7.1.
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

4. Copy each check's ping URL into the env file (section 3) as `HC_PING_URL_<JOB>`, for example
   `HC_PING_URL_SYNTHETIC_MONITOR`.

**What the emails mean.** "DOWN" arrives when a run fails or when a run is missing. It carries the
job's report, so you can see what broke without opening anything. "UP" arrives when the job passes
again. You get one email per change, not one per run. A `revenue-watch` DOWN can be good news:
read the body.

## 3. The env file (secrets live here, and only here)

- Put it at `C:\Users\jimbo\tegridy-ops-env\ops.env`. It must sit **outside every repo**; the
  scripts refuse a file inside one. Keep it **out of OneDrive** too, so the service key is not
  synced to the cloud; `register-tasks.ps1` refuses a OneDrive path.
- Start from `scripts/ops/ops.env.example`. The format is `NAME=value`. Everything after the first
  `=` is the value, including any `#`. Wrap a value in single quotes if it starts or ends with a
  space.
- Always pass it with the script's own flag, after the script name:
  `node scripts\ops\run-job.mjs <job> --env-file C:\Users\jimbo\tegridy-ops-env\ops.env`.
  **Never use `node --env-file`.** Node's parser cuts every unquoted value at `#`, so a passphrase
  with a `#` in it would silently change, and the backups would be encrypted with a passphrase
  nobody holds.

## 4. Take a backup by hand, today

There is no reachable backup right now: every earlier one is a GitHub artifact, and the oldest
expires around 2026-10-28. Do this first. Use PowerShell, in a checkout outside OneDrive that has
`scripts/ops`.

1. **Find the backup passphrase** (your offline copy, made 2026-07-30). If you cannot find it, say
   so now: every backup stored on GitHub is unreadable without it. New backups can use a new
   passphrase. Keep both.
2. Get `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from the Supabase dashboard (Project Settings,
   API) or from Vercel's production environment variables.
3. Put the three values in the env file, each in single quotes.
4. Run:
   ```
   node scripts\ops\supabase-backup.mjs --env-file C:\Users\jimbo\tegridy-ops-env\ops.env
   ```
   You should see ten tables with row counts, then `Wrote ...` and `decrypted back and matched
   before it was kept`. If any table cannot be read whole, it fails and writes nothing.
5. **Prove your offline passphrase opens it:**
   ```
   node scripts\ops\supabase-restore-check.mjs --latest --prompt
   ```
   Paste the passphrase from your offline copy when asked (nothing shows as you type). You should
   see `Readable: all 10 tables present.` This also proves the env file did not change the
   passphrase.
6. Keep a second copy away from this PC. The default folder, `%USERPROFILE%\OneDrive\backups\supabase`,
   is one offsite copy; the file is encrypted, so that is safe. Add another: a USB drive now, or a
   storage bucket (Cloudflare R2, Backblaze B2) later.

The file format is exactly the old workflow's, so the restore steps in
[`frontend/supabase/RESTORE.md`](../frontend/supabase/RESTORE.md) work unchanged. Each backup is
`supabase-backup-<date>T<time>Z.tar.gz.gpg` plus a `.sha256` file. The newest 26 are kept; files
the tool did not write (such as old GitHub downloads) are never deleted.

## 5. Run the monitors on this PC (the stopgap)

1. **Delete the old faucet task first.** `SolanaDevnetFaucet` still runs every two hours. The
   checklist in `docs/BAYLA_LADDER_GOLIVE_CHECKLIST.md` says to delete it. The script below only
   warns about it; it never deletes it for you.
   ```
   Unregister-ScheduledTask -TaskName 'SolanaDevnetFaucet' -Confirm:$false
   ```
2. Use a checkout **outside OneDrive** that has `scripts/ops`, for example
   `C:\Users\jimbo\ops\tegridy-monitors`. Run `npm ci --ignore-scripts` in its `frontend\`
   folder; `registry-onchain` needs it.
3. Preview what will be created:
   ```
   powershell -ExecutionPolicy Bypass -File scripts\ops\register-tasks.ps1 -DryRun
   ```
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

**What to expect.** When this PC sleeps or is off, the pings stop and healthchecks.io emails you.
That is correct: it means nothing is watching. Each job's last report is in
`%LOCALAPPDATA%\tegridy-ops\<job>.last.txt`. Exit codes: 0 passed, 1 failed, 2 setup or usage
error, 3 passed but the ping was not delivered.

The tasks run whatever code is in that checkout. After changes to `scripts/ops` land on trunk,
update the checkout (`git pull`).

## 6. Run one job by hand

```
node scripts\ops\run-job.mjs synthetic-monitor --env-file C:\Users\jimbo\tegridy-ops-env\ops.env
```

Without `--env-file` (or without that job's ping URL), the job still runs. It prints a loud
warning that no alarm will hear the result.

## 7. Move off this PC (within one to two weeks)

The runner needs only Node 20 or newer, gpg, and a checkout. Good homes:

- **A small always-on Linux machine** (a $5 a month server, or a free cloud VM). Clone the repo,
  run `npm ci --ignore-scripts` in `frontend/`, put the env file outside the clone (`chmod 600`),
  set `BACKUP_DIR`, and add these crontab lines (with the machine's clock on UTC):
  ```
  */15 * * * * cd /opt/tegridy && node scripts/ops/run-job.mjs arb-linkage-monitor --env-file /etc/tegridy-ops/ops.env
  */30 * * * * cd /opt/tegridy && node scripts/ops/run-job.mjs synthetic-monitor --env-file /etc/tegridy-ops/ops.env
  17 * * * *   cd /opt/tegridy && node scripts/ops/run-job.mjs revenue-watch --env-file /etc/tegridy-ops/ops.env
  41 6 * * *   cd /opt/tegridy && node scripts/ops/run-job.mjs registry-onchain --env-file /etc/tegridy-ops/ops.env
  37 7 * * *   cd /opt/tegridy && node scripts/ops/run-job.mjs npm-advisories --env-file /etc/tegridy-ops/ops.env
  23 4 * * 1   cd /opt/tegridy && node scripts/ops/run-job.mjs supabase-backup --env-file /etc/tegridy-ops/ops.env
  ```
- **Not Vercel for `synthetic-monitor`.** Vercel cannot report its own outage.
- **GitLab scheduled pipelines** suit only the daily and weekly jobs. The free tier allows ten
  schedules and too few minutes for the 15- and 30-minute monitors.

Keep the same healthchecks.io checks; point the new machine at the same ping URLs. Then run
`register-tasks.ps1 -Remove` here. Do not leave two machines running the same job: two sets of
pings on one check would hide a dead one.

## 8. When GitHub comes back

- **Turn off Actions on the GitHub repo before anything is pushed to it.** Otherwise all eight old
  schedules restart without their secrets: the backup goes red every week and every monitor runs
  twice.
- **Do not let GitHub's schedules run alongside this runner.** One scheduler per job. This runner
  stays in charge; GitHub becomes a read-only mirror.
- If the old backup artifacts are still there, download them into the backup folder and check
  each one: `node scripts\ops\supabase-restore-check.mjs <file> --prompt`.
- Repository variables (`SOLANA_FEE_ACCOUNT`, `TEGRIDY_LENDING`, `SOLANA_RPC`, `ETH_RPC`,
  `BASE_RPC`) can be read back then. Copy any that were set into the env file. Secrets cannot be
  read back.

## 9. Settings the runner reads (names only)

| Name | Used by | Needed? |
|---|---|---|
| `HC_PING_URL_<JOB>` | every job | yes, one per job, or the job reaches no alarm |
| `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `BACKUP_PASSPHRASE` | `supabase-backup` | yes |
| `BACKUP_DIR`, `BACKUP_KEEP`, `GPG_BIN` | `supabase-backup` | no (defaults: OneDrive folder, 26, gpg from Git for Windows) |
| `OPS_STATE_DIR` | where `.last.txt` files and the revenue fingerprint live | no (default `%LOCALAPPDATA%\tegridy-ops`) |
| `ETH_RPC_URL`, `RPC`, `ETH_RPC`, `SOL_RPC`, `SOLANA_RPC`, `BASE_RPC`, `RH_RPC` | the chain-reading jobs | no; keyless public defaults |
| `SOLANA_FEE_ACCOUNT`, `TEGRIDY_LENDING`, `VENUE_INDEXER_URL` | revenue, arb, synthetic | no |

The runner never passes the Supabase key, the passphrase or the ping URLs to the scripts it
calls, and it replaces any secret-looking value with its name before printing or pinging.

## 10. Where this differs from the old GitHub workflows, on purpose

- **Alarms go to healthchecks.io, not GitHub issues.** It alerts once when a check goes down and
  once when it recovers, which replaces the issues' duplicate suppression.
- **`synthetic-monitor`** adds the Railway indexer's `/ready` probe (it had none). An orderbook
  answer of `degraded:true` still passes, as before, but is now printed as a warning. Failing on
  it would flap: it trips whenever one database read takes over 2.5 seconds.
- **`revenue-watch`** fails whenever any rail cannot be read. The workflow let a permanent "earned"
  hide an unreadable rail. A changed revenue picture sends one fail ping, and the next run clears
  it.
- **`arb-linkage-monitor`** reads the verdict from a file the runner owns. A missing verdict or a
  non-zero exit fails; off GitHub, a script's `$GITHUB_OUTPUT` is otherwise written to nowhere.
- **`supabase-backup`** asks each page for an exact row count, so a short page fails the table
  instead of ending the dump early. The file is decrypted and compared before it is kept.
