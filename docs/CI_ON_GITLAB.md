# CI on GitLab

GitLab CI runs the same checks as GitHub Actions did, from the same files. Each GitLab job
takes one file in `.github/workflows/` and runs it, unchanged, with
[act](https://github.com/nektos/act) on our own runner. No command, path or hash is copied
out of a workflow, so a change to a workflow changes both hosts at once, and the day GitHub
comes back its Actions read the same files.

- Pipeline file: `.gitlab-ci.yml`
- The wrapper every workflow job calls: `scripts/ci/act-job.sh`
- The secret scan: `scripts/ci/gitleaks-range.sh`
- Checks with no runner at all: `scripts/ci/local-gates.sh`
- Runner setup: `scripts/ci/runner/setup-wsl-runner.sh`, tool pins in `scripts/ci/runner/pins.env`
- Guard test: `frontend/src/test/gitlabCi.test.ts`

## What a pipeline does

A pipeline runs for every merge request and for every push to `mvp-launch`. A branch push
with no merge request runs nothing, so no commit gets two pipelines.

| GitLab job | Runs | Blocks a merge when red |
|---|---|---|
| `pipeline-exists` | the wrapper's own self-test; it always runs, so every merge request has a pipeline | yes |
| `gitleaks` | the pinned gitleaks binary over only the new commits | yes |
| `ci` | `ci.yml` | yes |
| `contracts-ci` | `contracts-ci.yml` | yes |
| `slither` | `slither.yml` | yes |
| `solana-ci` | `solana-ci.yml` | yes |
| `npm-advisories` | `npm-advisories.yml` | yes |
| `registry-onchain` | `registry-onchain.yml` (reads mainnet over public RPCs) | no: it shows red, but a flaky RPC must not block a merge |

A change cannot loosen the secret scan with a file or a comment. The config and the ignore
file come from the commit the change builds on. The scan reads a copy with no working tree,
so the change's own `.gitleaksignore` is never loaded, and `gitleaks:allow` comments count
for nothing. A change can still edit the scan script itself, as it could on GitHub, so read
every change under `scripts/ci/` in review. To change `.gitleaks.toml`, merge that change on
its own first.

Not run on GitLab:

| Workflow | Why |
|---|---|
| `codeql.yml` | GitHub only. Its results go to GitHub code scanning, and the CodeQL licence covers CI only for code hosted on GitHub.com. It never blocked a merge. |
| `gitleaks.yml` | Replaced by the `gitleaks` job. Its action needs GitHub's API. |
| `release.yml` | Publishes a GitHub Release through GitHub's API. No `v*` tag has ever been cut. |
| `solana-deploy-artifact.yml` | Manual mainnet builds. Its inputs are pasted into scripts, so it needs an input allowlist before act may run it, and its program build has a known bug (an unset `SIZE`). Build mainnet binaries in WSL for now (`ci-solana-release` audit, section 11). |
| `arb-linkage-monitor.yml`, `revenue-watch.yml`, `synthetic-monitor.yml`, `supabase-backup.yml`, `contracts-coverage.yml` | Schedules. They move to the ops scheduler. |

### What the wrapper adds, and why

act runs GitHub workflows locally, but a few gaps would give a false result. The wrapper
closes each one:

- **act ignores `on.push.paths`.** On a trunk push, the wrapper first asks whether GitHub
  would have started the workflow (`scripts/ci/act/push-paths.sh`, using the repo's own
  `diff-scope.mjs`). Any doubt runs it.
- **act can skip a job and still exit 0.** A matrix it cannot expand runs zero times, and a
  `runs-on` label it cannot map is skipped with one info line. The wrapper lists the jobs
  first, then fails the run if a listed job has no result at all, if any job failed, if
  nothing ran, or if act exits non-zero. One case is allowed: act expands a matrix before it
  looks at the job's `needs`, so when `contracts-ci`'s `slices` job is skipped (a change
  outside contracts), its `test` matrix never starts. GitHub skips that job too, so the
  wrapper reports it as "not reached" and accepts it, but only when a job it needs was
  skipped (`scripts/ci/act/job-needs.sh` reads the needs with yq inside the act image).
- **The `scope` jobs call `gh api .../pulls/N/files`.** There is no GitHub here, and four of
  the six scope scripts would fail outright, which turns every run red. A small stand-in
  (`scripts/ci/act/gh`) answers that one call from `git diff`. Any doubt makes it answer
  "no files", and every scope script reads that as "run everything".
- **Slither's SARIF upload goes to GitHub.** It is replaced by a stand-in that skips it.
  The gate is Slither's own `fail-on: medium`; the report is kept as an artifact.
- **The job image.** act runs every `ubuntu-latest` job in
  `ghcr.io/catthehacker/ubuntu`, pinned by digest (`scripts/ci/act/Dockerfile`). Our layer
  adds the `gh` stand-in, yarn 1, and `/home/runner/.config` (solana-ci points its wallet
  there).
- **The event.** The wrapper builds the `pull_request` or `push` event from GitLab's
  variables: merge request number, diff base, head commit and branch names.

The full act log of each workflow is a job artifact: `.act-out/<workflow>/act.jsonl`.

**One job at a time.** act starts every job container on one shared network, so two jobs
that open the same port collide: `ci.yml`'s two e2e jobs both serve on 4173, and
`solana-ci.yml`'s validator jobs both use 8899. So the runner takes one GitLab job at a
time and act runs one workflow job at a time (`ACT_CONCURRENT_JOBS: "1"`). A matrix still
runs up to four entries at once, which is act's default. Raise the limit only after giving
act its own network per job and testing it. A merge request that touches everything takes
a few hours; a typical one runs `ci.yml` in full and only the scope checks of the rest.
One job at a time also keeps what one run leaves away from the next (see the safety rules),
so the wrapper refuses a runner that says it may take two jobs at once.

## Safety rules the setup enforces

- **Workflow code never gets the Docker socket.** act is always run with
  `--container-daemon-socket -`. By default act mounts the socket into every job container,
  and a job with the socket can start a container that mounts the whole host.
- **No job runs as root.** Jobs run as the user `ci`: not in the `sudo` or `docker` group,
  and the service sets `NoNewPrivileges`. Docker is *rootless* and belongs to `ci`, so even
  full control of Docker is only `ci`'s power. The wrapper refuses to run as root or on a
  root Docker daemon.
- **Only people you trust can start a job here.** The shell executor runs the merge
  request's own `.gitlab-ci.yml` and scripts as `ci`, outside any container. So only project
  members may push branches, and a merge request from a fork must never run in this project.
  GitLab's settings pages have no switch for that: turn it off once through the API (step 1
  below), and never click "Run pipeline" on a fork's merge request.
- **No secrets on this runner, ever.** None of these workflows needs one, and the wrapper
  passes none. Marking a variable "protected" is not enough here: every job shares this
  machine, so a merge request job could leave something behind that a later trunk job runs.
  A job that needs a secret (a deploy token, for example) must run on a separate runner that
  is marked protected, never on this one.
- **Nothing one run leaves reaches the next.** act mounts one tool folder
  (`/opt/hostedtoolcache`) into every job container and never deletes it, and its
  actions/cache store matches entries by key alone, with no branch scope. The wrapper deletes
  that tool folder before each run. A merge request gets a throwaway copy of the cache store,
  so only trunk pushes write the copy that is kept.
- **No job token inside a job container.** act copies `.git` into each container.
  `.gitlab-ci.yml` sets `FF_GIT_URLS_WITHOUT_TOKENS`, so the runner writes no token there, and
  the wrapper stops if it finds one.
- **Pinned tools.** act, gitleaks and gitlab-runner are installed from pinned versions and
  checked by sha256. The CI scripts refuse other versions.

`frontend/src/test/gitlabCi.test.ts` fails if a job ever passes another socket, mounts
`docker.sock`, runs privileged, or puts the job user in the `docker` or `sudo` group. It also
fails if a job's script is anything but its one command, if a job can be skipped or allowed to
fail (only `registry-onchain` may fail), or if act gets extra container options or variables.

## The runner: a dedicated WSL distro on the owner's PC

This runs on the owner's PC today, so building does not wait for a server. It must be a
**new, separate WSL distro**, never the everyday Ubuntu one, and never a copy of it.

### First, a decision: this breaks a rule in the audits

The audits and `docs/GIT_HOSTING.md` (section 9) say: never a shell executor on the PC that
holds the keys. A runner runs code from branches, and the mainnet keys live on this PC. This
setup is still a shell executor on that PC. It makes the risk small (a separate distro with no
Windows drives, no root for jobs, rootless Docker, members' branches only), but it does not
remove it. "What risk remains" below lists what is left. The owner picks one:

- **WSL on this PC, now.** CI runs today, at no cost. Accept the remaining risk in writing:
  change GIT_HOSTING.md section 9 to allow this setup, with the reasons, in the same pull
  request that records the decision.
- **A VPS from day one.** No keys are on it. It costs about 10 to 70 euros a month, and the
  same script sets it up.

Until that decision is written down, GIT_HOSTING.md's rule stands: do not register a runner on
this PC. Nothing is blocked meanwhile, because `scripts/ci/local-gates.sh` runs the gates with
no runner at all.

Why the shell executor: act needs a Docker daemon of its own. With GitLab's Docker executor,
the job container would need the host's Docker socket or privileged Docker-in-Docker, and
either one is root on the host. With the shell executor, the job script runs as `ci` and
talks to `ci`'s own rootless Docker, and the workflow code runs inside act's containers,
which get no socket.

### Steps (the owner runs these)

1. **In GitLab** (the project, as a Maintainer):
   - Settings > CI/CD > Runners: turn **off** instance runners for this project. Then
     "New project runner": tag `tegridy-runner`, **Run untagged jobs off**, maximum job
     timeout `3h`. Copy the token (it starts with `glrt-`). A project runner serves only
     this project.
   - Settings > CI/CD > Auto DevOps: clear **Default to Auto DevOps pipeline**.
   - Settings > CI/CD > General pipelines: if the project is public, clear
     "Project-based pipeline visibility" so job logs stay members-only.
   - **Fork pipelines off.** This is API only; no settings page has it. In PowerShell, from
     a clone whose `origin` is the GitLab project, with `glab` signed in
     (`docs/GIT_HOSTING.md` section 3):
     ```powershell
     glab api -X PUT projects/:id -f ci_allow_fork_pipelines_to_run_in_parent_project=false
     glab api projects/:id | Select-String '"ci_allow_fork_pipelines_to_run_in_parent_project": *false'
     ```
     The second line must print a match. If it prints nothing, stop: the setting is still on.
   - Settings > Merge requests: merge method **Merge commit with semi-linear history** (the
     same as `docs/GIT_HOSTING.md` section 2A). A merge request can then merge only when its
     branch already contains `mvp-launch`, so the tree its pipeline tested is the tree that
     lands. "Skipped pipelines are considered successful" off. Leave **Pipelines must
     succeed** off for now: a merge request with no pipeline cannot merge at all, so turn it
     on only after the runner passes its first pipeline (checklist step 7).
   - Protected branch `mvp-launch`: push "No one", merge "Maintainers".
2. **Make the distro** (PowerShell):
   ```powershell
   wsl --update
   wsl --install Ubuntu-24.04 --name tegridy-runner --location C:\wsl\tegridy-runner
   ```
   It asks for a Linux user name; that is the distro's admin, not the job user. If
   `--name` is not recognised, import Ubuntu's official 24.04 WSL image instead with
   `wsl --import tegridy-runner C:\wsl\tegridy-runner <image file>`, after checking its
   SHA256 against Ubuntu's published list.
3. **Phase 1: cut it off from Windows.** From any clone of this repo outside OneDrive:
   ```powershell
   wsl -d tegridy-runner -u root -- bash /mnt/c/Users/jimbo/dev/<clone>/scripts/ci/runner/setup-wsl-runner.sh
   wsl --terminate tegridy-runner
   ```
   This writes `/etc/wsl.conf`: no Windows drives, no starting Windows programs, systemd on.
   It copies itself to `/root/tegridy-runner-setup/` first, because `/mnt/c` is gone after
   the restart.
4. **Phase 2: install and register.**
   ```powershell
   wsl -d tegridy-runner -u root -- bash /root/tegridy-runner-setup/setup-wsl-runner.sh
   ```
   It checks the isolation is live (no Windows drive mounted, interop off), installs Docker
   (rootless for `ci`, no root daemon), act, gitleaks and gitlab-runner, asks for the
   `glrt-` token without echoing it, and starts the runner with one job at a time.
5. **Check** that GitLab shows the runner online, then follow the first-run checklist below.

On a VPS instead, skip steps 2 and 3. Copy `scripts/ci/runner/` (two files) to a fresh
Ubuntu 24.04 server and run the script there as root. It sees it is not in WSL and goes
straight to phase 2.

Re-running phase 2 is safe: it re-installs the pinned tools and keeps the registration.

**To change a tool version** (act, gitleaks or gitlab-runner):

1. Open the bump merge request: edit `scripts/ci/runner/pins.env` (the version, and the
   sha256 from the tool's release checksums file).
2. Phase 2 reads its own copy inside the distro, never your clone, and `/mnt/c` is gone. So
   copy both files in. In Git Bash, from a clone checked out at the bump branch:
   ```bash
   for f in pins.env setup-wsl-runner.sh; do
     MSYS_NO_PATHCONV=1 wsl.exe -d tegridy-runner -u root --exec sh -c 'tr -d "\r" > "/root/tegridy-runner-setup/$1"' _ "$f" < "scripts/ci/runner/$f"
   done
   ```
3. Re-run phase 2. Its first line names the versions it installs. They must match `pins.env`.
4. Merge the bump merge request at once, then rebase the other open ones. From the moment the
   runner has the new tools until the bump lands, every other pipeline, trunk included, is
   red: the scripts refuse a tool that does not match their own pins.

### What risk remains, compared with a separate server (VPS)

The setup makes a job's reach small, but this machine also holds the mainnet keys, so it
is worth being plain about what is left.

- **One kernel for all WSL distros.** Every WSL distro shares one Linux kernel. A job that
  exploits a kernel bug could reach the other distros, and root in any distro can mount the
  Windows drive again. Turning off automount stops the easy path, not a kernel exploit.
  That is why no job ever gets root: it would need a kernel exploit, not a setting.
- **The network.** Every WSL2 distro runs in one VM and shares its network. So jobs can reach
  what listens in your other WSL distros (a local validator, anvil, a dev server), and the job
  script, which runs outside any container, can reach even what listens only on localhost
  there. Jobs can also reach programs on the Windows side that listen on the network, such as
  wallet software. Do not run any of those while CI runs.
- **Who can push.** Anyone who can push a branch here can run any command as `ci` on this
  machine. Keep project membership to people you trust, and keep fork pipelines off.
- **Shared memory and CPU.** A heavy pipeline slows the PC, and running out of memory in
  WSL can stop work in the other distro too. If jobs die with "Killed", raise `memory` and
  `swap` in `%UserProfile%\.wslconfig` (this setting covers every distro).
- **Only while the PC is on.** CI runs only when the PC is on, awake and logged in. If the
  runner goes offline whenever no WSL window is open, add a Task Scheduler task at log on
  that runs `wsl.exe -d tegridy-runner --exec /bin/sleep infinity`.
- **Still visible to the distro:** WSL's read-only Windows GPU driver folder
  (`/usr/lib/wsl`), and the `/mnt/wsl` folder that all distros share.

A small VPS removes all of these: the keys are simply not on that machine, so the worst a
job escape can do is take over the VPS. A 4-8 vCPU, 8-16 GB server costs roughly 10 to 70
euros a month. The same script sets it up (it skips the WSL phase on its own). If the owner
picks WSL now, the plan is to move the runner to a VPS when there is budget. Both can be
registered at once with the same tag, and GitLab uses whichever is free.

## Checks with no runner at all

Until the runner exists, or whenever a host is down, run the gates on this PC in Git Bash,
from a clone outside OneDrive:

```bash
bash scripts/ci/local-gates.sh root        # seconds: the repo-root self-tests
bash scripts/ci/local-gates.sh frontend    # lint, types, unit, build, e2e (about 40 minutes)
bash scripts/ci/local-gates.sh contracts   # forge build, every test slice, fuzz (slow)
bash scripts/ci/local-gates.sh solana      # the Rust math and layout tests, when rustc/cargo exist
bash scripts/ci/local-gates.sh all
```

It prints a PASS, FAIL or SKIP table and exits non-zero on any FAIL. Every command it runs
is one CI runs, word for word; the guard test fails otherwise. Gates CI runs as inline
scripts (the bytecode size budget, the anvil e2e run, Slither, the Solana SBF builds and
validator suites) are listed as "CI only". Set `LOCAL_GATES_SKIP_INSTALL=1` to skip
`npm ci` when `node_modules` is fresh. The contracts area refuses to run forge where a
`contracts/.env` exists, because forge loads it into every test.

## First-run checklist

Nothing here has run on a live runner yet. Go through this once, in order.

1. **Runner online.** In WSL: `systemctl status tegridy-gitlab-runner` is active; GitLab
   shows the runner green.
2. **Docs-only merge request first** (cheap). Expect: `pipeline-exists` and `gitleaks`
   green. In `ci`, the wrapper's table shows `scope` and `docs-guards` passed and the build
   jobs "skipped by its if:". `contracts-ci` shows `scope` and `all-tests-pass` passed, the
   others skipped, and `test` "not reached". `npm-advisories` shows `audit` passed three times.
   - If `test` shows "NEVER STARTED" instead of "not reached", the needs map came back
     empty: check that `yq` exists in the act image (`scripts/ci/act/job-needs.sh`).
   - If `act-job: act is 'missing'`: phase 2 did not finish; re-run it.
   - If `ACT_EXCLUSIVE_RUNNER is not 1`: the runner was registered some other way. Register
     it again with the setup script, which sets that and `concurrent = 1` together.
   - If `the job token is under .git`: this runner version wrote the token into the checkout
     although `FF_GIT_URLS_WITHOUT_TOKENS` is on. Stop and report it. Never remove the check.
   - If the image build fails to pull `ghcr.io/catthehacker/ubuntu@sha256:62d5...`: the
     digest in `scripts/ci/act/Dockerfile` was read from the package page, not pulled. Run
     `docker pull ghcr.io/catthehacker/ubuntu:act-24.04` as `ci`, take the digest it prints,
     and commit it.
   - If a scope job says "no base/head sha": check `CI_MERGE_REQUEST_DIFF_BASE_SHA` is set
     (merge request pipelines only) and that the clone is full (`GIT_DEPTH: "0"`).
3. **A merge request that touches `contracts/`.** Expect `test` "passed x11" (one per
   slice in `.github/contracts-test-slices.json`) and `fuzz-invariant` passed. Watch memory
   on the first run. `actions/cache` warnings are expected and harmless: act's cache server
   may not speak the newest cache protocol, which only costs compile time.
4. **Slither.** Expect the "SARIF upload skipped" line. If the codeql step instead fails
   with a token error, the stand-in did not take: check that the `--local-repository`
   argument in the log names the same commit as `slither.yml`.
5. **A merge request that touches `solana/`.** The three validator jobs are the least
   tested under act. If `solana-test-validator` complains about open files, the file limit
   did not apply (phase 2 sets it to 1048576). If `yarn` is missing, the image layer did
   not install it.
6. **The first push to `mvp-launch`.** Each workflow whose `on.push.paths` did not match
   prints "GitHub would not start it. Not run." and passes.
7. **Now** turn on "Pipelines must succeed" (Settings > Merge requests > Merge checks), and
   treat a green pipeline as the merge gate. Not before: a merge request with no pipeline
   cannot merge at all. `pipeline-exists` runs in every pipeline, so a docs-only merge
   request still has one.
