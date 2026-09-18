# NOTES

A running log of things learned while working in this repo: measured constants,
traps that cost real time, and techniques that are not obvious from the code.

Rules for entries, so this stays worth reading:

- **Measured, not assumed.** If an entry states a number, it came from running
  something. Say what was run. A default you read in docs is not a measurement.
- **Lead with the belief that was wrong.** The useful part of a trap is the thing
  a competent person would otherwise have believed.
- **Transferable only.** Facts about *this codebase's shape* belong in the code
  or its comments. This file is for what you could not have learned by reading.
- Newest first.

---

## 2026-09-17 — a ledger row that holds on trunk today can still be false: read it at the ledger's own commit

**Believed:** a remediation ledger row saying "Closed" can be checked against today's
trunk. If the property it names holds on trunk, the row is right.

**Measured** re-checking the staking and LP Medium rows of
`.audit_101/MICROSCOPE_REMEDIATION_2026_05_01.md` (#608). Three rows each described a
specific change. None of those changes exists on any ref, reflog or stash, and a trunk-only
check passes two of the three rows anyway:

| Row | Ledger's closure | At the ledger's own commit `7e7a4a15` | Trunk today |
|---|---|---|---|
| M-S1 | `emergencyWithdrawPosition` gains `updateReward` | still open | holds, via a different fix (`d6b1f5b1`, next day) |
| M-S5 | `notifyRewardAmount` drops its `duration` argument | still open | holds, via a different fix (`f89c97a7`, next day) |
| M-S7 | floor division becomes ceiling division | still open | still open |

The ledger was committed at 23:31 the night before the fixes that actually closed M-S1 and
M-S5 landed. "The property holds today" gets two rows right while their descriptions stay
fiction. A later session trusting the M-S1 row would then believe `updateReward` guards the
path. It doesn't: three other pieces do, and the committed suite doesn't see them. With all
three reverted, all 554 tests in the 16 suites that deploy and pause staking still pass.

**Do:** check a "Closed" row at three points, not one:
1. **The ledger's own commit:** `git show <ledger-commit>:<file>`. Was the row true when written?
2. **All history:** `git log --all --reflog -G '<pattern>'`. Did the described change ever exist?
3. **Trunk and the deployed build:** does the property hold now, and *by what*?

If (3) holds by a different mechanism than the row names, rewrite the row. The mechanism is the
thing the next reader will rely on.

### A commit message's "no code change" is a claim too

`d6b1f5b1`'s message says DS2-04 "documented the pause-aware accumulator design choice in
NatSpec; no code change". Its diff adds the `&& !paused()` guard, a pre-pause
`_accumulateRewards()` call and the `unpause()` reset: the three lines that actually close M-S1.
Read `git show <c> -- <file>`, not `git show -s`.

### `git log -G` is always an extended regex

`git log -G 'notifyRewardAmount\(uint256 [a-z_]+, *uint256'` matched three commits. Under a
basic regex, `\(` would open a group that never closes, which is an error, and `+` would be a
literal plus sign. So `-G` parses the pattern as an extended regex whether or not `-E` is given,
and `\(` there is a literal parenthesis.

### Under via_ir, `vm.warp(block.timestamp + dt)` can reuse a stale timestamp

A test body that called `vm.warp(block.timestamp + ...)` three times paid out exactly the
pre-unpause share and zero for the day after unpause. That is only possible if the last warp
landed at or before the unpause timestamp, i.e. that `block.timestamp` read returned an earlier
value. The same test paid the exact expected amount once every warp went through a storage
clock seeded from a literal (`uint256 t = 1_000_000;` then `t += dt; vm.warp(t);`), which never
reads `block.timestamp`. The failure was a plausible number, not a revert. Seed the clock from a
literal, not from a local copy of `block.timestamp`, or read time with
`vm.getBlockTimestamp()`, which several suites here already do.

---

## 2026-09-17 — a value handed across a Suspense render is gone if the render that took it is thrown away

**Believed:** carrying a value from pre-React markup into a lazily loaded component is a
module variable plus `useState(() => takeDraft())`, where take reads and clears; a unit
test that the store hands the value over proves the handoff; and an e2e that aborts the
entry chunk covers the seconds before the app loads.

**Measured** on a production build of the venue's static first frame (answer ten, PR #591),
with chunks held by a Playwright route handler and released by hand. All three were wrong,
and the store's own unit test was green the whole time.

### A render thrown away by Suspense runs your initializer again

An address typed into React's fallback was in the store, and the real field mounted empty,
every run. The home page's first render suspends on a sibling lazy chunk, React discards
that render with its state, and the retry's initializer ran again and found the store
already cleared. Reproduced in vitest by rendering the component beside a child that throws
a promise once: red with the take in the initializer, green with a peek in render and the
clear in `useEffect`.

**Do:** in render, only read (repeatable); consume in an effect, which runs only for a render
that committed. Test a handoff through a boundary that really suspends, not through the store.

### DOMContentLoaded waits for module scripts; `readyState === 'interactive'` does not

A classic script in `<head>` deferred its wiring of the static form to `DOMContentLoaded` so
the body markup would exist. On the phone throttle (150 ms RTT, 1.6 Mbps, CPU 4x) the markup
painted at about 0.7 s and `DOMContentLoaded` fired only after the entry module graph had run,
about 7.5 s. With the entry chunk held, the listener never ran at all. A `readystatechange`
listener that acts once `readyState !== 'loading'` wired the form while the chunk was still
held: readiness turns interactive when parsing ends, before deferred and module scripts run.

### Chromium fires `blur` on a focused node as it is removed, while it is still connected

Focus an input, then remove it with `replaceChildren`. Chromium dispatched `blur`
synchronously with `isConnected === true` and `document.activeElement` already moved; WebKit
dispatched no `blur` at all. So at event time a blur handler cannot tell "React swapped this
field out" from "the visitor tapped away". What worked: decide one microtask later and check
`isConnected` then. React's commit, including the replacement field's layout effect, finishes
before any microtask runs.

### An aborted chunk proves the no-script path, not the slow-script path

`route.abort()` on the entry chunk tested the static form's plain GET and could not see any
of the three defects above, which only exist while the markup is on screen and the app is on
its way. Holding the request (`await gate; await route.continue()`) and releasing it by hand
showed all three. Two traps in that harness: `page.waitForURL` waits for `load` by default,
which a page whose entry chunk is held never reaches (use `waitUntil: 'commit'`); and a
`page.goto` that must not wait for scripts needs `waitUntil: 'commit'` too.

### On Windows, stopping the shell that ran `npx vite preview` leaves node serving

Killing the backgrounded Git Bash shell left its `node.exe` child running; four previews
survived that way. The survivor holds `lightningcss.win32-x64-msvc.node` open, and the next
`npm ci` failed EPERM on that file after it had already deleted most of `node_modules`. Find
them by command line (`Get-CimInstance Win32_Process -Filter "Name='node.exe'"`) and stop
them by PID before reinstalling.

---

## 2026-09-17 — `git bundle verify` passes a bundle cut in half, so a safety net is only proven by restoring from it

**Believed:** a bundle that `git bundle verify` accepts is a backup you can delete against.
The command is named for exactly that check, it exits 0, and it prints "The bundle records a
complete history."

**Measured** (git 2.53.0.windows.1). A throwaway repo with 6 commits of random 200 KB files,
bundled with `git bundle create full.bundle --all` (1,201,601 bytes); `half.bundle` is the
first 600,800 bytes of that file:

| check | `full.bundle` | `half.bundle` |
|---|---|---|
| `git bundle verify` in the source repo | pass | **pass** |
| `git bundle list-heads` | pass | **pass** |
| `git bundle verify` in an empty repo | pass | **pass** |
| `git fetch <bundle> 'refs/*:refs/r/*'` in an empty repo | pass | fail: `early EOF`, `index-pack died` |

`verify` and `list-heads` read the bundle's header (its ref list and prerequisite commits) and
check the prerequisites against the current repository. Neither reads the pack data that follows.
A partial copy, an interrupted download or a disk-full write can leave the header intact, and then
both checks still pass.

This was caught while reviewing a branch cleanup whose design was "bundle it, verify the bundle,
then delete": the verify step proved nothing about the part that mattered.

**Do:** prove a bundle by restoring from it before you delete what it backs up. Fetch it into a
fresh repository that holds only the bundle's prerequisites, check that every oid you meant to
keep is present (`git cat-file --batch-check`), and run `git fsck --connectivity-only`. Record a
hash of the proven file, so anything that later trusts the bundle can check that it is still the
file that was proven.

### Two more places a zero-loss cleanup quietly loses the last copy

- **`.git/lost-found/other/` can hold the only copy of a blob.** `git fsck --lost-found` writes
  each dangling blob's *content* into a file named by its oid. Once gc prunes the object, that
  file is all that remains. In this repo 3 of the 13 files there hashed to their own names
  (`git hash-object --no-filters <file>` equals the filename) while `git cat-file -e <oid>`
  failed. A cleanup that treats `lost-found` as a folder of names and deletes it destroys
  content. Move it instead. The files in `lost-found/commit/` really are just names.
- **Loose-ref file timestamps are not evidence of recent use.** A guard that skipped tags whose
  `.git/refs/tags/<name>` file had changed in the last 72h protected nothing within the same
  hour: another session's `gc --auto` packed every ref into `packed-refs`, and the loose files
  disappeared. Use something the packing cannot erase, such as the tagged commit's date, or a
  name convention that live work actually follows.

---

## 2026-09-16 — a merge train's green ticks are claims about a base, a scope and a moment

**Believed:** working a backlog of open PRs is bookkeeping. A PR whose checks read green
is ready, `gh pr checks` exiting 0 means the checks passed, and a stale branch is one
click from current.

**Measured** while triaging the open-PR backlog against `mvp-launch`, every one of those
was wrong in a way that would have merged something nobody had checked.

### `gh pr checks` exits 0 on the checks that exist, not the checks that should

On a PR whose base is not a trunk branch, `gh pr checks <n>` exits **0** with 11 of the 32
gates a trunk-based PR runs. It reports the check-runs that were created, and a job whose
workflow never triggered creates none, so nothing in the output is red and nothing says
"missing". The 2026-09-12 stacked-branch entry below records a stacked PR reading
`all-checks-pass: SUCCESS`; the extra fact here is that the exit code agrees with it, so a
script that gates on `$?` is exactly as blind as a human reading the tick.

**Do:** list the NAMED contexts the touched paths must produce, look each one up in
`gh pr checks --json name,state,workflow`, and treat an absent context as a failure. A
count floor does not fix this (see the 2026-09-12 `all-checks-pass` entry below): which
workflows run at all is path-dependent.

### The aggregators finish before the frontend gate starts

`all-checks-pass` and `all-tests-pass` are the terminal jobs of `solana-ci` and
`Contracts CI` (the 2026-09-12 entry below has the table). On #576, a frontend PR, both
were green at 15:54, `Build` started at 16:03 and both E2E jobs at 16:07, and the long
E2E run finished at 16:47. A reviewer who stopped at the two green "all-*" names would
have merged before the frontend was built, and nearly an hour before its E2E finished.
They are not a frontend gate at any point in the run, not just early in it.

### A green is computed against the base as of the last push

A PR's checks ran against the trunk that existed when it was last pushed. Across the
backlog, PRs sat **48 to 216 commits** behind `mvp-launch`. The oldest of them predate
`em-dash-zero.spec.ts` entirely (it arrived in `350dfa9d` on 2026-09-09), and the rest had
run it only in an earlier revision, before the per-route budgets they would be merged
against were rewritten. Their greens were true statements about a tree that no longer
exists: nothing had re-run them.

**Do:** refresh a PR onto current trunk before trusting its green, and wait for the new
run. An old tick is evidence about its merge base, not about the merge.

### `allow_update_branch: false` does not turn `update-branch` off

The repository reads `allow_update_branch: false`
(`gh api repos/<owner>/<repo> --jq .allow_update_branch`), and the first draft of this
plan concluded from that value that `gh pr update-branch` was unavailable. It is not. On
2026-09-16 `gh pr update-branch 567` answered "PR branch updated" and GitHub pushed
`536976e7`, a two-parent merge committed as GitHub, and the same call then refreshed
fourteen more PRs. The setting governs whether GitHub always *suggests* the button, not
whether the API works; GitHub had authored update-branch merges here on 2026-09-04 too. A
setting's value is only a claim about its effect until the effect has been measured.

**Do:** refresh with `gh pr update-branch <n>`. For a stacked PR, retarget first
(`gh pr edit <n> --base mvp-launch`) and update second, so the one push runs against the
trunk gates. #482's refresh was pushed a minute before its retarget, ran against the old
base, and the retarget did not re-run anything.

### A lockfile marked `binary` cannot be three-way merged

`.gitattributes` declares `package-lock.json  binary`, and the `binary` macro unsets
`merge`, so git will not three-way merge `frontend/package-lock.json`: any two branches
that both change it conflict on the whole file, however disjoint the edits. Dependabot
PRs that touch the lockfile therefore land **one per rebase cycle** — merge one, and every
other lockfile PR goes CONFLICTING until Dependabot regenerates it against the new trunk.
Sequence them, and do not read a wall of conflicts as a wall of broken PRs.

### A monitor alarm about a healthy site, fifteen times

The literal-301 probe in the 2026-09-15 entry below had failed **15 consecutive runs** and
commented **14 times** on issue #566 by the time its fix (#573) was opened, about a site
that was serving correct 308 redirects the whole time. With #573 still open a day later,
the issue held **19** of those comments (the latest at 2026-09-16 10:05Z). The durable rule is that entry's:
assert a redirect's class and target, not a literal code. What the backlog adds is the
count: fourteen false comments on one issue is fourteen chances to learn to skip it.

---

## 2026-09-15 — a monitor that pins a vendor's status code fails the day the vendor is right

**Believed:** a permanent redirect is a 301, so a synthetic probe can assert
`[ "$code" = "301" ]` and thereby be asserting "this alias redirects permanently".

**Measured:** Vercel's `redirects` array never emits 301. `"permanent": true` emits
**308**; `"permanent": false` emits **307**. Measured with `curl -sI` against three
live aliases — all three 308, one hop, path and query preserved. There is no setting
on a `redirects` entry that yields 301; you have to abandon `permanent` for a raw
`statusCode` to get one.

The failure mode this produced is the transferable part. **One commit** both created
the redirect with `permanent: true` *and* rewrote the monitor to demand a literal
`301`. It went red on the first scheduled run after merging and stayed red for **14
consecutive runs** across three trunk commits, while production behaved exactly as
designed. The check asserted a status code the config it shipped alongside could not
emit — and because both halves rode in one commit, there was no "it used to pass"
signal to bisect toward.

**Why a literal is the wrong pin.** The invariant the probe exists to defend is
*permanent, and onto the canonical host*. `301` is one vendor's spelling of half of
that. Pinning the spelling fails on a correct implementation-detail change and, worse,
stays silent if the platform later emits a permanent code you never enumerated. Assert
the property:

```bash
case "$code" in 301|308) : ;; *) fail ;; esac
```

That is *stricter* than the `30[0-9]` it replaced, because 302/303/307 now fail: a
temporary here means someone flipped `permanent` to false and the canonicalisation
signal quietly stopped consolidating.

**308 is not a downgrade.** It is the method-preserving twin of 301 (RFC 7538) and
search engines consolidate on it identically. There was nothing to fix in production
— "make the monitor green" and "fix the site" were different tasks and only one of
them was real. A red monitor is a claim about production that itself needs checking.

**Do:** when probing a managed platform, enumerate every code that satisfies the
property you actually care about, and find out what the platform emits — one
`curl -sI` — rather than inferring it from what the config field is *named*.
`permanent: true` does not mean 301.

### The corollary that cost the two days: an alarm must say what tripped it

The probe wrote its failure text to `$GITHUB_OUTPUT` only, for use as an issue body.
**`gh run view <id> --log-failed` does not render `$GITHUB_OUTPUT`** — it showed the
`run:` script source and a bare `exit 1`. The one fact needed to act (WHICH host, and
what it actually returned) was recoverable only by re-running the probe by hand.

An alarm whose own log cannot name what tripped it gets ignored, and this one was, for
two days, by everyone who looked at it. If a step composes a human-readable failure
report, print it to stdout **as well as** to wherever the automation consumes it. The
duplication costs one line and is the difference between a triaged alarm and wallpaper.

---

## 2026-09-15 — the knob that makes one file input strict does not make the action strict

**Believed:** hand a GitHub Action a path to a file that is not there and the step fails.
`softprops/action-gh-release` even advertises an input called `fail_on_unmatched_files`,
which reads like the action's policy for missing files.

**Read** (not run — see the caveat at the end) from the action's own source at the SHA this
repo pins, `efb35369`:

- `body_path` is **soft, with no opt-out**. `releaseBody()` in `src/util.ts:57-69` wraps the
  read in a try/catch that only `console.warn`s, then returns `config.input_body`:

      if (config.input_body_path) {
        try { return readFileSync(config.input_body_path, 'utf8'); }
        catch (err) { console.warn(`⚠️ Failed to read body_path ... Falling back to 'body' input.`); }
      }
      return config.input_body;

  If `body` is not also set, that returns `undefined`, and the consumer coerces it:
  `src/github.ts:688` reads `releaseBody(config) || ''`. So an unresolvable `body_path`
  publishes an **empty release body on a green run**. Nothing in the action's 19 declared
  inputs can harden this.
- `fail_on_unmatched_files` governs a **different** input. Its only two consumers are
  `src/run.ts:16` and `:46`, both on `config.input_files` — the release *assets*. It never
  reaches `releaseBody`. It also defaults to soft: `parseConfig` reads
  `env.INPUT_FAIL_ON_UNMATCHED_FILES == 'true'`, so unset is `false`, so an asset glob that
  matches nothing warns and publishes a release with no assets.

So one action carries two file inputs with two different policies, and the strictness knob
that exists names the one you were not worried about. **Seeing a hardening option in an
action's input list is not evidence that the action is strict; check which input it is
wired to.**

The same shape has a third policy elsewhere in this repo's workflows. `actions/upload-artifact`
takes `if-no-files-found`, which is configurable *and* defaults to `warn`. Surveyed across
`.github/workflows/` by walking the parsed YAML: 11 upload steps, 8 set the flag (5 `error`,
3 `warn`), and 3 sit on the default — so **6** sites treat "produced nothing" as a warning and
a green job. Three policies for one idea (no opt-out / opt-in-and-defaults-soft /
configurable-and-defaults-soft) across two actions is why this has to be checked per input
rather than remembered per action.

That survey had to be structural, and the first pass of this entry got it wrong by not being.
`grep -c if-no-files-found` over the same files returns **9**, not 8, because one of the matches
is inside a *comment* explaining the setting rather than setting it (`solana-ci.yml:439`). The
grep-derived numbers were in this entry's first draft and were corrected before it left the
worktree. A
comment naming a setting is a claim about configuration, not configuration — the same trap the
2026-09-11 entry records for gate comments and wrong-chain notices, arriving here through a
counting tool instead of a reader.

**How to check it**, without trusting a README that may describe a different version than the
one pinned:

    gh api repos/<owner>/<repo>/contents/src/util.ts?ref=<pinned SHA> --jq '.content' | base64 -d

Reading the pinned SHA is the point. A floating tag's docs and the bytes that actually run in
CI are different artifacts.

**Caveat, stated because this file's rule requires it:** the empty-body consequence is derived
from reading that source plus the fact that the caller leaves `body` unset. It was **not**
observed in a release run — the workflow it was found in has never executed even once. The
line numbers and the input survey are reads; the consequence is an inference from them.

**Why it is worth knowing beyond the warning:** it changes what counts as a safe edit. Renaming
the generated file this repo feeds to `body_path` looked like a free string swap. Because the
failure mode is a silent green, "move it to `${{ runner.temp }}`" — a change to how the path
*resolves*, not just what it says — would have had no rehearsal that could catch it going
wrong. When an input is soft, the cost of being wrong about it is paid silently and later, so
the change that touches the fewest mechanisms wins.

## 2026-09-14 — a wallet adapter's declared capability is the SHIM's opinion, not the wallet's

**Believed:** `supportedTransactionVersions` on an official `@solana/wallet-adapter-*`
package tells you what that wallet can sign. On 2026-09-02 this repo read
`@solana/wallet-adapter-trust`'s `supportedTransactionVersions = null`, correctly
decoded it (null narrows to legacy-only; it does **not** mean "all versions"), and
excluded Trust from every Solana surface on the grounds that the wallet could not
sign the v0 transactions this venue sends. A guard test was written to keep it out.

**Measured, twelve days later:** the package was right about itself and wrong about
Trust. Read from Trust's own sources, not the shim:

- `trustwallet/trust-web3-provider`, `adapter/src/wallet.ts` — Trust's **own** Wallet
  Standard implementation — declares `supportedTransactionVersions: ['legacy', 0]` on
  both `solana:signTransaction` and `solana:signAndSendTransaction`.
- Its injected provider, `src/solana_provider.js`, reads `tx.version` and serializes
  with `requireAllSignatures: false, verifySignatures: false` — the versioned path.
- `wallet-core` has shipped `VersionedTx` / `V0Message` since PR #2935, merged
  **2023-02-20**, which closed "[Solana] Support versioned transactions".

`@solana/wallet-adapter-trust@0.1.18`, published **2026-09-10**, still says `null`.
So the metadata had been wrong for roughly three and a half years and was republished
wrong four days before it was read.

**Why this generalises past Solana.** These adapter packages are third-party shims
around someone else's product. The wallet ships on its own cadence; the shim is
updated when a volunteer gets to it. A capability *claim* in the shim is evidence
about the shim. A capability *denial* is not evidence about the wallet at all.

**Do:** when a wallet shim says a wallet cannot do something, and that denial is the
reason you are about to exclude the wallet, go read the wallet's own provider or
Wallet Standard source before believing it. It is a ten-minute read and it is the
difference between "this wallet is broken" and "this package is stale". Vendor an
adapter with the honest declaration rather than adopting the package — a wallet's own
`registerWallet` implementation is the authority, and it is public.

### The declared capability gates only SOME paths — find out which one your SDK takes

The version check does **not** live in the adapter. In `@solana/wallet-adapter-base`
(`esm/signer.js`) it lives in exactly two methods on `BaseSignerWalletAdapter`:
`sendTransaction` and `signAllTransactions`. **`signTransaction` has no gate at all.**

That matters because SDKs disagree about which one they call. Measured here:

| Path | Route | Hits the declared-version gate? |
| --- | --- | --- |
| swap / limit / DCA | `adapter.sendTransaction` | yes |
| Streamflow staking | `client.execute()` → `signAndExecuteTransaction` → `invoker.signTransaction(tx)` | **no** |

Both send a v0 `VersionedTransaction` (`@streamflow/common` compiles one via
`compileToV0Message`). So a legacy-only adapter throws the adapter's clean
`Sending versioned transactions isn't supported by this wallet` on one path, and on
the other sails past the check and fails inside the wallet with whatever that wallet
says. Same defect, two symptoms, and a guard asserting the declared value catches
neither on the second path.

**Do:** before reasoning about what a declared capability protects, `grep` the SDK for
which method it actually calls. `isSignerWallet(invoker) → invoker.signTransaction` is
the common bypass shape and it appears in more than one SDK.

### A dist grep is evidence only after you prove the code path is REACHABLE in that build

Checking that a wallet refactor had not dropped Trust from the EVM connect modal,
`grep -rl "com.trustwallet.app" dist/assets/*.js` returned **nothing**. Read naively
that says the refactor deleted the wallet. It did not: `wagmi.ts` builds its wallet
list inside an `if (projectId)` branch, no `.env` exists in a fresh worktree, so
`VITE_WALLETCONNECT_PROJECT_ID` was undefined and rolldown eliminated the **entire**
list — Phantom, Trust, WalletConnect, Rainbow, Base and Rabby together. The tell was
cheap and should have been the first check: grep for a *sibling* that the change did
not touch (`phantom.ethereum`). It was also absent, so the absence was about the
build, not the diff.

Rebuilt with `VITE_WALLETCONNECT_PROJECT_ID=<any 32 hex chars>`: `com.trustwallet.app`
present in the wagmi chunk, and the shared icon module resolved into its own chunk
imported by both sides rather than pulling one stack into the other.

**Do:** a zero from a dist grep is a *reading*, and an unreachable code path returns
the same zero as a deleted one. Before believing it, grep for an untouched sibling
symbol from the same branch. If the sibling is missing too, you measured your env.

### `autoConnect` + a `Loadable` deep-link branch = a page that navigates itself away

Wallet adapters model "app not installed, but we can hand off to it" as
`WalletReadyState.Loadable`, and `connect()` in that state is not a connection — it
assigns `window.location.href` to a universal link. `WalletProvider` is commonly
mounted with `autoConnect`, and the default `autoConnect()` just calls `connect()`.
Composed, that is: every returning visitor whose stored wallet selection is the
deep-linkable one gets navigated off the site on page load, having clicked nothing.

Upstream's Phantom adapter guards it (`autoConnect` runs only from `Installed`) with a
two-line comment and no test. Any hand-rolled or vendored adapter has to re-derive the
guard, and nothing fails loudly if it does not — on desktop, where adapters get
written, `Loadable` never occurs.

**Do:** if an adapter has a `Loadable`/redirect branch, override `autoConnect` to run
only from `Installed`, and pin it with a test that asserts `location.href` is
**unchanged** after `autoConnect()`. Also make an injected provider always win over
the redirect, or the wallet's own in-app browser can bounce itself in a loop.

### Incidental

- `useStandardWalletAdapters` dedupes a legacy adapter against a registered Wallet
  Standard wallet by **exact `name` string match** (it drops yours and logs a
  `console.warn`). A vendored adapter's `name` is therefore a load-bearing contract,
  not a label: Trust registers as `"Trust"`, so an adapter calling itself
  `"Trust Wallet"` — which is what the EVM modal calls it — would render a second,
  dead row beside the real one.
- `scopePollingDetectionStrategy` runs its detector **synchronously** as its last step
  ("Strategy #4"), so an adapter's `readyState` is already settled when the constructor
  returns. Tests can assert it without waiting; the 1s interval only covers late
  injection.
- SLIP-44 for Solana is **501**; Trust's dApp-browser handoff is
  `https://link.trustwallet.com/open_url?coin_id=<slip44>&url=<encoded>`. A wrong
  `coin_id` still opens the browser, so this fails silently on the wrong chain.

## 2026-09-13 — correct bytes at an unchanged URL reach nobody who already resolved that URL

**Believed:** if a site's icon files are wrong, replacing the bytes fixes it. The
HTTP cache is the only thing between the file and the viewer, so serving the
icon with `Cache-Control: public, max-age=0, must-revalidate` means every client
re-checks and picks up the new art on its next visit.

**Measured:** the venue's `apple-touch-icon.png` and both manifest icons carried
a retired project's pixel logo, and a commit replaced all three with the correct
mark. Production served the correct bytes from that moment — verified live,
`curl -sI https://<site>/apple-touch-icon.png` returning `200 image/png`,
`Cache-Control: public, max-age=0, must-revalidate`, ETag matching the new file.
Weeks later the retired icon was still showing in a wallet's in-app browser, on
its tab cards and in its search bar.

The reason is that `Cache-Control` governs *the HTTP cache*. It says nothing to
a client that resolved this origin's icon once, wrote the image into its own
store keyed by **origin**, and never asks the network again. Browsers, in-app
webviews, home-screen launchers and link unfurlers all keep a store like this.
For them a new icon at an old filename does not exist — there is no request for
a header to be attached to.

What reaches them is a URL they have never seen, so the version token has to move in
the markup and in every manifest, not just on disk. **Where in the URL it moves
matters too.** The first fix put the token in a query (`/favicon.png?v=<token>`); two
days later it moved into the path (`/icons/<token>/favicon.png`). A store that
normalises or strips the query sees the URL it already holds, and nothing on the
server side reveals which stores do that. A new path is a strict superset of a new
query: every store that would notice the query notices the path, and so do the
ones that ignore queries. Keep the canonical root files (`/favicon.ico`,
`/apple-touch-icon.png`) as copies and never move them, because a deleted one falls
into the SPA rewrite described below.

Two things that follow:

- **The revalidation headers were never the problem, so tightening them is not
  the fix.** It is easy to spend the whole investigation on `Cache-Control`,
  `ETag` and CDN `Age` — all of which were already correct here — because those
  are the knobs a server exposes. The stale copy was never in a layer the server
  can address.
- **Derive the version token from the icon bytes, not by hand.** A hand-bumped
  literal lets someone change the art and leave the token alone, which is the
  original bug reproduced exactly. Hashing the icon files and asserting the
  markup carries that hash means art that moves without its URL moving fails,
  and the failure prints the token to paste in. The invariant worth pinning is
  "when the bytes change, the URL changes with them" — **not** "the icon is the
  right one", which was true for the entire life of the bug and would have
  proved nothing.

**The second half, and the reason a client had nothing better to fall back to:**
under an SPA rewrite, a missing well-known asset is not a 404. The config here
rewrites `/((?!api/).*)` to `/index.html`, and there was no `favicon.ico` on
disk, so `GET /favicon.ico` returned **`200 text/html`, 12801 bytes** — verified
live. Plenty of in-app browsers probe that root path before they parse a single
`<link>` tag. A fetcher that gets a 200 it cannot decode has no failure to fall
back *from*: it does not learn "no icon here", it just keeps whatever it already
had. A real `.ico` on disk both answers the probe and removes the ambiguity.

Generalises past favicons: any SPA-rewritten origin returns a decodable-looking
200 for `/robots.txt`, `/.well-known/*`, `/sitemap.xml` and every other
convention-probed path it does not actually ship. Absence and success are the
same response, and only the client's parser can tell them apart.

---

## 2026-09-13 — a source scanner's exemptions are where the bugs live, and `[^>]*` cannot match a JSX tag

**Believed:** a registry that must stay in step with the code can be held there by
a scan: read every call site, compare against the list, fail on the difference.
Call sites the scan cannot resolve — a computed argument, a loop index — are a
small, harmless remainder, so skipping them keeps the guard honest.

**Measured:** the skipped remainder was where both real defects were.

A hand-maintained inventory of 418 art surfaces had two guards over it, and both
asked only *"is everything the code renders in the list?"*. Running the reverse
question for the first time: **54 of the 418 were rendered by nothing at all** —
whole retired pages, and 17 cards on a page that had been rebuilt down to 2.
Nothing had ever asked, so nothing had ever said.

And the exemption itself hid the opposite defect. The scanners matched
`pageId="literal"`, so a surface selected by a computed value was invisible to
them — it could neither be flagged as missing nor as dead. Two of the most-seen
surfaces on the site were reachable *only* that way:

    pageId={IS_ARRIVAL || identity ? 'home' : 'venue-home'}
    const PAGE_ID = 'eth-curve';  …  <PageArtBackdrop pageId={PAGE_ID} />

The home-page hero was unregistered and unplaceable in the editing tool for
months, while an overrides file carried a saved pick for it the whole time —
a pick nothing could display, edit, or reconcile.

Three things that transfer:

- **Run the reverse direction of any consistency guard at least once.** "Is
  everything used in the list?" and "is everything in the list used?" are
  different questions with different failure modes, and a codebase that only
  ever asks the first accumulates dead entries silently — forever, because the
  guard is green. A dead registry entry is worse than clutter when the registry
  is an editing surface: it accepts input, writes a record, and affects nothing.
- **`[^>]*` cannot match a JSX tag.** Any prop holding an arrow function
  (`onClick={() => x}`) contains a `>` that truncates the match, so the parse
  silently pairs an attribute with one from a *later* tag. This produced
  confident, entirely wrong findings until the extractor was rewritten to walk
  the tag tracking brace and quote depth. Same trap for any regex over a
  brace-delimited language.
- **Enumerate the components before scanning for them, and read each one's
  defaults.** The first pass covered two of the five components that resolve
  this value, and reported live entries as dead because their call sites were in
  the other three. Three of the five default the index to `0`, so a tag with no
  index prop anywhere in it still renders index 0 — a scan looking for an
  explicit index sees nothing and concludes the surface is unused.

The general shape: a static scanner is an argument with premises — *these*
components, *this* call syntax, *these* defaults. The premises are invisible in
the output, and a green result asserts them just as loudly as it asserts the
conclusion. Before trusting a sweep, check the number it resolved: this one
found 282 surfaces before the missing components were added and 302 after, and
the 20-surface gap was the whole difference between a wrong answer and a right
one.

---

## 2026-09-12 — a route stub whose pattern stops matching does not fail, it silently measures the unstubbed page

**Believed:** if a Playwright `page.route(glob, r => r.abort())` is in the spec, the
branch under it is the aborted one. A stub is either applied or the test errors.

**Measured:** neither. When the app moved its GeckoTerminal reads from
`api.geckoterminal.com` to a same-origin edge, the spec's
`'**api.geckoterminal.com/**'` matched nothing and Playwright reported *nothing at
all* — no warning, no unmatched-route error. The spec kept passing for two days
against a branch it was not pinning, then reddened trunk when that branch's copy
happened to differ by one character class.

Proof it was inert, three runs on the same build, same route, identical source:

| stub | prose em dashes on `/competitions` |
|---|---|
| `'**api.geckoterminal.com/**'` (dead) | 16 |
| `'**resource=gecko-read**'` (live) | 17 |
| no `page.route` at all | 16 |

The dead stub and *no stub* agreeing exactly is the signature. If a stub is
load-bearing, assert that: count `requestfailed` under it, or fail the test when
the handler was never invoked. A stub you cannot prove fired is a comment.

### Under `vite preview`, a missing `/api/*` is not a 404 — it is 200 text/html

This is what turned an inert stub into a *wrong* measurement rather than merely a
live one. `vite preview` runs no serverless function, and the SPA fallback answers
any unmatched path with the index document, 200. So a client that checks
`res.ok` before parsing sails through the status check and dies at
`res.json()`. The failure is classified at a different layer:

- aborted at the socket → `network` → *"The trades feed could not be reached — that
  is an outage, not an empty tape."*
- 200 text/html → `schema` → *"The trades feed returned something unreadable."*

Same outage to the user, different sentence, and here a different em-dash count.
Any assertion over the WORDS of a failure — not just its presence — is really an
assertion about which layer the read died at, and `vite preview` moves that layer
relative to production. Fail-closed code paths are not interchangeable just
because they both render "could not read".

### Writing down the correct pattern is not the same as applying it

The fixture had already been updated, in prose, to say the old glob
"intercepts nothing now; the equivalent is `'**resource=gecko-read**'`". Two specs
still holding the old literal were not changed in that commit, so the note
documented the breakage instead of preventing it. A note describing the right
value, next to callers still using the wrong one, reads as done and is not.

**Do:** when a URL a test depends on moves, export the pattern as one constant and
import it. `grep` for the old literal in the same commit that writes the note —
the note is the weakest possible fix.

### An exact count over text built from a failed read cannot hold

The guard budgeted `/competitions` at 17 prose em dashes. Thirteen were the read
ledger: one `not read — <why>` chip per resident pool, plus one sentence per
distinct failure reason. That number is a function of how many pools are
registered, how many answered, and which reason each failure got — a third
party's behaviour, not reviewable copy. It was fated to drift and it did.

**Do:** exclude such a subtree by structure (a marker attribute the walker skips,
plus a source guard pinning who may declare it), rather than budgeting it. The
test of a good exclusion is that the remaining number stops moving: with that
structural fix, proposed in #564 and still open, the route read 4 aborted, 4 on
the fallback, and 4 unstubbed.

---

## 2026-09-12 — the same string at a second site is not automatically the same bug: read the GATE before the copy

**Believed:** a known-bad string still live at a second site, present at the fixing
PR's merge base, is a site the sweep did not reach — the same defect, closed by
applying the same rewrite.

**Measured** (PR #561 against #474, the string `'Trade ETH ↔ TOWELI via Uniswap V2
with custom slippage controls.'`, byte-identical at `TradePage.tsx:92` and
`HomePage.tsx:832`): the two sites render under different gates, so the rule that
condemned the first does not reach the second. TradePage has no arrival-voice gate
at all. The HomePage grid is inside `IS_TOWELI_ARRIVAL && !bungalowIdentity` — one
resident's own page, where naming that resident is correct and deliberate. The
cheapest evidence was two lines down in the SAME array literal: the neighbouring
card names the same ticker on purpose (`farmCardDesc` → "Stake TOWELI to earn now"),
hoisted to a lib and already pinned by a different test. Applying #474's rule here
would have turned a reviewed line red, and the ruling's own test header warns
against exactly that — "banning the word would have forced the venue to hide one
resident to prove it favours none".

There WAS a real defect at the second site, but a different one that the string
match happened to sit on: the copy named one of the NINE sources `useSwapQuote`
races, so it understated the surface rather than mis-voicing it. The correct fix
and the assumed fix pointed opposite ways on the ticker — keep it, not delete it.

**Do:** when a known-bad string turns up at a second site, read the gate that site
renders under before reusing the first site's fix. Two occurrences of one string
can be one bug, two unrelated bugs, or one bug and one correct usage. Check the
siblings in the same literal first: a neighbour that keeps the "bad" pattern
deliberately is the cheapest available proof that the rule does not apply there.

### Incidental — `\b` inside a template literal is a BACKSPACE, and a negated matcher then passes vacuously

A regex assembled as ``new RegExp(`\b(?:W?ETH)\b\s*…`)`` is not the regex you
wrote. In a template literal `\b` is U+0008 and `\s` is a literal `s`, so the
compiled source came out as `\b(?:W?ETH)\bs*[…]+s*TOWELI\b` — measured in node
against the pre-fix string: the intended pattern matches, that one does not. Because
the assertion was `.not.toMatch()`, the broken pattern would have PASSED, silently,
against the very string it existed to ban. The mutation check is what surfaces this;
a guard written this way and never watched fail reads green forever.

Generating the file through a script adds a second, independent backslash level to
lose (heredoc → script → disk ate one here, turning the intended `\\b` into `\b`).
`String.raw` removes both problems at once and is the right default for any regex
source built from a template.

## 2026-09-12 — a green that ran nothing, a green that covers a different workflow, and a red that only timed out

**Believed:** a vitest run that exits 0 ran the suite, a context called
`all-checks-pass` covers the PR's checks, and a pre-fix test that goes red has
done its job whichever way it went red.

### `--reporter=<name-that-does-not-exist>` is a silent no-op

`npx vitest run --reporter=basic` in `frontend/` printed a stack ending in

```
code: 'ERR_LOAD_URL'
...
[exited with code 0]
```

`basic` is not a reporter in this vitest, so vitest tried to resolve it as a
**custom reporter module**, failed to import it, and exited **0** with **zero test
files collected**. Nothing in the output says "0 tests" — the summary lines a real
run prints (`Test Files`, `Tests`) are simply absent, which reads like truncation.
`--reporter=dot` on the same tree reported `Test Files 603 passed (603)`.

Same shape as the cancellation trap in
`reference_trunk_ci_starved_by_cancellation`: the exit code is not the question.
**Gate on the summary line, not the status** — `grep -E "Tests  " out` is the
check, `$?` is not. This bites twice, because piping vitest into anything
(`| tail`, `; echo $?`) also reports the *last* command's status: a run that
printed `VITEST EXIT: 1` was reported by the surrounding shell as exit 0.

### Await a sentinel that exists in BOTH worlds, then assert synchronously

Writing a render-level test for a read-honesty fix, the natural shape is

```js
expect(await screen.findByText(/floor depth not measured/i)).toBeInTheDocument();
```

Against the **pre-fix** component that copy does not exist, so `findByText` burns
the whole `waitFor` budget and fails with a timeout — measured at **1022ms**, next
to 38–627ms for the legs that failed on a value. A timeout is a weak result: it is
also what you get from a component that never finished loading, a mock that never
resolved, or a typo in the matcher. It cannot separate "the copy is absent" from
"nothing rendered at all".

Rewritten to await a heading that renders in both the pre- and post-fix worlds,
then assert synchronously:

```js
expect(await screen.findByRole("heading", { name: /Floor Depth/i })).toBeInTheDocument();
expect(screen.getByText(/floor depth not measured/i)).toBeInTheDocument();
```

the same pre-fix run fails in **241ms** with `TestingLibraryElementError: Unable to
find an element with the text: …` — an immediate, specific statement that the
component rendered and the copy is not in it.

**Do:** in a mutation check, `await` something both versions render. Only the
assertion should target what changed.

### `all-checks-pass` is not the PR's checks

Measured on a docs-only PR (#552). `gh pr checks --json name,bucket,workflow`:

| context | workflow |
| --- | --- |
| `all-checks-pass` | **solana-ci** |
| `all-tests-pass` | **Contracts CI** |
| `Lint, Type Check & Test` | **CI** |
| `CodeQL (javascript-typescript)` | **CodeQL** |

Neither aggregate spans the PR. They are the terminal jobs of the solana and
contracts workflows, so on a docs or frontend change those workflows skip every
job, their aggregate passes **in seconds**, and the frontend's real gate is still
running in a different workflow. Watching the list settle, `all-checks-pass` and
`all-tests-pass` both read `pass` while `Lint, Type Check & Test` and `CodeQL`
were still `pending`.

It looks like a race and is not one — it is a **scope** error. The name claims the
PR; the job covers one workflow. This is the mechanism behind the existing rule
that a check-COUNT floor is unsound: which workflows contribute at all is
path-dependent, so both the count and any "all-*" name mean something different
per PR.

**Do:** assert the NAMED contexts that matter for the paths you touched — for a
frontend change that is `Lint, Type Check & Test`, not `all-checks-pass`. Add
`workflow` to the `gh pr checks --json` field list; without it a context's real
scope is invisible.

### Incidental

- `getByText` with a **regex** matches every node whose text contains it, so adding
  the same phrase to a summary line and to a detail line breaks a query that was
  unique the day before (`Found multiple elements`). Matching the exact full string
  separates them without scoping to a container.
- A render-level outage test does not automatically need fake timers. Retry sleeps
  only exist on paths that retry: in `frontend/src/nakamigos`, a proxy rejection
  carrying a plain `Error` is non-retryable to `api.js`'s `withRetry` (it retries
  `TypeError` and `ApiError.isRetryable` only), and the orderbook's `degraded: true`
  answer is deliberately not retried. Picking those legs let 11 render tests run on
  real timers in 3.81s of test time.

## 2026-09-12 — an equality-based invariance test is blind to every field that is equal for the wrong reason

**Believed:** the strongest way to pin "X must not change what this reports" is to
assert the whole report is equal with X set and unset. Nothing can hide in an
object comparison.

**Measured** (PR #514's `farmReadsWalletChain.test.ts`, whose stated subject is
"the wallet's chain does not decide what the farm reports"; the subject under test
was `usePoolData`'s `batchRan`, carrying a `chainId === CHAIN_ID` term the
`enabled` gate beside it had already lost):

- The suite builds one all-success fixture and asserts
  `figures(reportOn(hook, 8453))` equals `figures(reportOn(hook, CHAIN_ID))`, with
  one scalar checked non-zero first so two unread reports cannot pass as equal.
- Put the chain term back on `batchRan` and that suite still passes **10/10**, run
  alone, while the hook's own suite fails 4 of 31 on the same tree. The three
  unread flags are `false` on both sides of the equality, because under an
  all-success fixture there is nothing to be unread about. The equality held, and
  held for the wrong reason.
- The 4 that fail are the ones that break **one** read off mainnet. Breaking a read
  is what makes a failure flag take a value worth comparing.

The guard against "two unread reports are equal too" was already there and was not
enough: it proves the READS landed, not that any FLAG was exercised.

**Do:** for each boolean in a report, ask what fixture makes it `true`. If no case
in the invariance suite produces that fixture, the equality assertion is not
covering that field, however wide the object comparison looks. An invariance test
needs one fixture per interesting value, not one fixture and a wide `toEqual`.

## 2026-09-12 — a stacked branch can hold a reference that exists in neither parent

**Believed:** a semantic conflict between a branch and trunk shows up as a merge
conflict, a type error in the branch, or a red check. A clean `merge-tree` and a
green branch mean the merge is sound.

**Measured** (PR #490 `fix/pool-reserve-unread`, stacked four deep under
`mvp-launch`; trunk's #514 had deleted the `onMainnet` declaration from
`usePoolData.ts` while #490 added a new line using it):

- Both parents are internally consistent. On #490's branch `onMainnet` is declared
  and `npx tsc -b --force` is clean; on trunk the name does not appear at all. The
  dangling reference exists **only in the merge**, so neither branch's own build
  can see it, and there is nothing for `merge-tree` to report: all nine commits
  cherry-pick onto trunk with zero conflicts.
- In the merged tree `npx tsc -b --force` gives
  `src/hooks/usePoolData.ts(59,34): error TS2304: Cannot find name 'onMainnet'`.
- That undersells it. An undeclared free variable is a **runtime**
  `ReferenceError`, not a type complaint: vitest on the cherry-picked stack gives
  27 failures, all `ReferenceError: onMainnet is not defined`, across every test
  that renders the hook. So the hook throws on every render rather than returning
  a wrong number — a different and louder class of consequence for the pages
  that call it, which a type error alone does not suggest.
- The branch's own CI cannot catch it, and says so in green. Of 15 workflows, the 7
  with a `pull_request` trigger and a branch filter all read `branches: [main,
  mvp-launch]`; the only unfiltered one is `solana-ci.yml`. On a PR opened with
  base `fix/pool-reserve-unread`, `gh pr checks` reported **`all-checks-pass:
  SUCCESS`** with only `scope` and `all-checks-pass` actually run: the other 7
  Actions jobs, `build` and `diff-guard` among them, were `SKIPPED`, so the
  frontend was never built. A stacked PR's green tick is an assertion
  about which jobs were eligible, not about the code — and a job that did run
  would be testing the parent that compiles.

**Do:** for a branch whose base is not trunk, `git merge-tree --write-tree trunk
<head>` and then typecheck **and run the tests of** the resulting tree; a clean
merge-tree exit only means git found no textual conflict. When trunk has DELETED a
declaration a stacked branch still reads, expect a free variable rather than a type
mismatch, and expect it to throw rather than to compute wrongly.

## 2026-09-12 — a guard whose two operands come from one source, hidden by a correct refusal from the wrong cause

**Believed:** the zap had a chain guard. `planZap(descriptor, routes, expectedChainId)`
refuses on `descriptor.chainId !== expectedChainId` with a dedicated refusal code
(`chain-mismatch`), a message naming both chains, and a passing test. The hook that calls
it reads `useChainId()`. Every part a reviewer looks for was present.

**Measured:** the caller built `descriptor.chainId` from `useChainId()` and then passed
that same `chainId` as `expectedChainId`. Two different expressions, two sensible names,
one variable — so the comparison was `x !== x`. Unreachable on every chain, for every
wallet, under every config. Not weakened: absent.

Rendering the hook with the wallet on 8453 and on 4663, with usable routes in hand,
returned `{ ok: true }` — a composed plan for contracts that exist on neither chain.
`planner.test.ts` was green throughout, because it calls `planZap` directly and supplies
both numbers itself: it pinned the FUNCTION, and the defect was in the CALL. Restoring
the old argument after the fix failed exactly the three new caller-level tests and
nothing else — including a positive control on the right chain, which passed both before
and after.

**What made it read as working:** a wallet on the wrong chain *was* refused — by
something else. `useSwapQuote` gates its reads on the wallet's chain, so off mainnet
every leg came back without a floor and the zap refused with `route-unavailable`:
"no floor to submit". The user saw a refusal, so nobody went looking. But it blamed the
route for a network problem, and the real guard sat dead behind two unrelated gates,
either of which could move without anyone knowing it was load-bearing.

**Do:**

- Read a guard's operands back to their **source**, not their names. A parameter named
  for what it *should* be is not evidence that it is that. The question is not "does this
  compare the right things" but "can these two expressions ever differ".
- A unit test that supplies **both** sides of a comparison cannot see this class, however
  thorough it is. The test has to be written at the caller, where only one side is free.
  This is the same shape as a mock that answers a query the real thing would refuse
  (2026-09-10, below): the double removes the very degree of freedom under test.
- When a bad state *is* refused, check **which** refusal. A misattributed refusal is the
  strongest camouflage available: the visible behaviour is correct, so the wrong
  component gets the credit and the right one rots. Grep the refusal a user actually
  sees back to the branch that emits it before concluding a guard works.
- A guard standing behind other gates is not redundancy — it is untested code with a
  test-shaped comment on it. Either something must reach it, or it should not be there.

## 2026-09-12 — a threshold fitted to a sample with a GAP is a guess wearing a measurement's clothes

**Believed:** a Streamflow CLASSIC reward entry stops being payable once its cumulative
`accounted_amount` passes `u64::MAX`. This was not reasoned from an IDL — it was established by
simulating the real `claim_rewards` against all eight live entries of a mainnet pool, with every
entry above the value reverting 6000 and every entry below it succeeding. Eight for eight.

**Measured, six days later:** wrong twice over. Scanning the whole program with
`getProgramAccounts` plus a `dataSlice` over just the counter field, **5,868 of 9,797** entries
with a non-zero counter are already past that value, and the largest is **22,000,000x past it** —
each written by a successful claim, since only a successful claim writes that field. And on the
pool itself the verdicts split perfectly on something else entirely: the pool's reward RATE was
changed at a known instant, and the 2 entries created before it revert while all 16 created after
it pay.

**Why eight-for-eight was not enough.** The sample had a hole in exactly the wrong place — its
successes topped out at 78% of the candidate threshold and its reverts started at 265%. Nothing
measured the band between, so a LOWER BOUND was indistinguishable from an exact line. And the two
reverting entries were also the two oldest, so a second variable ("predates a rate change") fit
the same eight points just as well. The first hypothesis named won by default.

**Technique, whenever a boundary is inferred from live samples:**

- **Check the sample BRACKETS the boundary.** Points either side of a gap do not locate a line,
  they bound a region. If nothing was measured between the highest pass and the lowest fail, the
  honest output is an interval — and code must not act as though it is a point.
- **Ask what else explains the same split.** Sort the failures by every field you have, not only
  the one you suspect. Here, sorting by `created_ts` against the pool's `last_amount_update_ts`
  gave a perfect 2/16 split that the counter could not improve on.
- **Widen the population before trusting the mechanism.** One pool's 8 entries said one thing and
  the program's 9,797 said the opposite. A program-wide scan over a single sliced field is cheap:
  `dataSize` + `dataSlice` returns thousands of rows in one call.
- **Measure the PAYOUT, not the exit code.** Simulate with
  `{sigVerify:false, replaceRecentBlockhash:true, accounts:{encoding:'base64', addresses:[ata]}}`
  and diff the returned post-state against the current balance. A claim that "succeeds" while
  transferring zero is not evidence a position is alive. (That config-object overload needs a
  `VersionedTransaction`; a legacy `Transaction` fails with "Invalid arguments".)

**The design rule this produced, which is the durable part:** a threshold may WARN; only the
program may VETO. The cost asymmetry is enormous and one-directional — a claim that reverts costs
a network fee, a claim never offered costs the whole balance. The code now attempts every claim
that has a pending balance and takes its verdict from the chain's own error, even where a
predicate is right 18 times out of 18.

---

## 2026-09-12 — a source guard that searches the whole file answers about the file, not the code it names

**Believed:** a guard for "this timer is armed in a layout effect" could be written
as: find the timer, then compare the last `useLayoutEffect(` before it against the
last `useEffect(` before it. Whichever is nearer is the effect it sits in.

**Measured:** nearness in a file is not enclosure. With the deadline moved back into
a passive effect AND one comment above the timer naming the layout hook in passing,
the guard stayed GREEN: the exact mutation it exists to catch walked through it. The
fooling text was not hypothetical either, since that effect's own comments name both
kinds of hook.

**Technique:** a source guard must read the construct that ENCLOSES the code it is
about, and must ignore comments. Walk back from the line you matched to the nearest
line that opens the construct, skipping comment lines, and assert on that line. Then
mutate twice: the plain break (it must red), and the plain break PLUS the text that
could fool it (it must still red). A guard is only as good as its second mutation.

## 2026-09-12 — a timeout and the animation it bounds can be counting from different moments

**Believed:** one line of arithmetic settles whether a deadline cuts an animation
short: the deadline fires at 2,500 ms, the animation needs 2,400 ms, so the animation
always finishes first.

**Measured:** the two numbers start from different moments. The deadline was armed in
a layout effect, during the commit that puts the overlay in the DOM. The animation's
clock is stamped later, in a passive effect that first builds a WebGL post-processing
pass. Whatever that gap costs -- paint, chunk parse, GL context creation -- is spent
before the animation starts counting and not before the deadline does, so the real
margin is smaller than the arithmetic, and on a slow machine the deadline can cut an
animation that is running on time.

**Technique:** before comparing a timeout against a duration, write down which moment
each side counts from. If they differ, either anchor both to the same stamp, or keep
the bound and say in the test what it is: a floor, short by however long the gap runs.
The arithmetic is not wrong, it is optimistic, and the comment is where that belongs.

---

## 2026-09-12 — `Page.captureScreenshot` is served by the renderer it is screenshotting

**Believed:** a CDP screenshot is taken by the browser, so it can observe a page
whose main thread is blocked.

It cannot. Probing whether a compositor-driven opacity animation still advances
during a long task, the driver slept to a wall-clock instant and called
`Page.captureScreenshot`. Every sample came back *after* the block ended: asking
for +2,000 / +2,600 / +2,900 / +3,500 ms returned frames at +3,261 / +3,295 /
+3,326 / +3,396 ms. The screenshot path waits on the same blocked renderer, so
the clock it appears to offer is the clock being investigated. It read "the
overlay was still opaque at the deadline" — agreeing with the bug, for the wrong
reason.

**`Page.startScreencast` is a different channel.** Frames are *pushed* as the
compositor produces them, and each carries `metadata.timestamp` (epoch seconds),
so delivery latency does not smear the measurement. Re-probed with a solid
3,000 ms busy loop across the deadline: 20 frames arrived *during* the block, with
the overlay's opacity ramping smoothly to 0.

**Do:** to answer "what was on screen at time T" for any T where script might be
busy, use the screencast and the frame's own timestamp. Convert the page's clock
with `performance.timeOrigin + performance.now()` to compare against it. Treat
`captureScreenshot`, `page.screenshot()`, and anything routed through
`page.evaluate` as main-thread instruments — fine for a quiescent page, useless
for this question.

---

## 2026-09-12 — a compositor animation's `startTime` is set at the first frame, not at creation

**Believed:** `el.animate(...)` starts the animation now, so a fade given the same
duration as a deadline finishes at the same moment.

It starts at the first frame the browser produces after creation, and on a loaded
machine that frame is not soon. Measured on a real app under a blocked main
thread: the overlay's first painted frame came **107 ms** after a MutationObserver
stamped the node's insertion, and the fade finished at **3,002 ms** against a
3,000 ms budget — having spent an entire 100 ms slack allowance on nothing but
waiting to begin. The animation was correct; its zero was late.

`animation.startTime = document.timeline.currentTime` dates it from the current
commit instead. Same build, same block: the fade completed at **2,892 ms**.

**Not the same trap as "a timeout and the animation it bounds can be counting from
different moments" above**, though it is the same theme. That one is about a clock
*your own code* stamps in a later effect; this one is the browser assigning a clock
you never wrote, inside an API that looks synchronous.

**Do:** pin `startTime` whenever an animation's *end* is a deadline rather than a
decoration. `document.timeline.currentTime` is `null` before the document's first
frame, so guard it. Note this is the same error as arming a `setTimeout` *at* a
budget instead of inside it, one layer down — a deadline that begins late can only
end late, and the lateness is invisible because the animation's own duration is
exactly right.

---

## 2026-09-12 — a compositor emits frames only when something changes, so "assert a frame in [a, b]" fails correct code

**Believed:** with a screencast running at `everyNthFrame: 1`, frames arrive
continuously, so a test can assert that some frame inside a window shows the
expected state.

Frames are produced on change. Once a fade settles at opacity 0 the compositor has
nothing further to draw and goes quiet: in one run the last frame of the fade was
at **+2,918 ms** and the next at **+3,598 ms**, a 680 ms hole straddling the
3,000 ms instant under test. An assertion requiring a frame inside
`[budget, budget + 400]` therefore failed a curtain that was demonstrably gone.

The opposite shape fails too, and more dangerously. "The first frame at or after
the budget" was satisfied on one run by a frame at **+3,568 ms** — 168 ms after
the blocked thread came back — so the *ordinary timers* answered it and the
assertion would have passed on the unfixed build.

**Do:** what is on screen at time T is **the last frame at or before T**, because
that frame persists until the next one. Assert on that, and separately assert it
post-dates whatever perturbation the test introduced, so a stale pre-test frame
cannot answer for it.

---

## 2026-09-12 — a timing constant can make a whole code path unreachable, and the profile will not mention it

**Believed:** the expensive function you can see in the phase that is running is
the one to optimise.

An arrival overlay's suspected cost was a glitch effect doing a full-canvas
`getImageData` → per-pixel loop → `putImageData`, twice per call. It never ran.
The phase branches on `pieceTime >= 1400`, and the variant's own `artDuration` is
1,200, so `pieceTime` is bounded at 1,200 and the branch is dead — for that
variant only; the other one, at 2,600, runs it every time.

Reading the arithmetic found it, but **counting** is what settled it: patching
`CanvasRenderingContext2D.prototype.getImageData`/`putImageData` to log size and
count over one full overlay lifetime returned **0 `putImageData` calls** and 2
`getImageData`, both at viewport size and both belonging to a different function
entirely. A sampling profile agreed by omission, which is the weakest possible
form of agreement — absent entries are indistinguishable from cheap ones.

The same profile named the real top consumer: a decorative background component
animating 530 particles **behind the opaque overlay**, at 597 ms per run, more
than anything the overlay itself spent. It was not in the file under
investigation.

**Do:** before optimising a named suspect, instrument the primitive it is accused
of over-using and count calls over one real run. A census answers "did this run at
all, and how much", which is two questions a flame chart answers only by
inference. And profile the whole page, not the component you suspect: work that is
invisible is still work.

---

## 2026-09-11 — dropping a read gate re-arms every control the unread state was holding down

**Believed:** a gate like `enabled: … && useChainId() === CHAIN_ID`, on reads already pinned
with `chainId: CHAIN_ID`, only decides whether a figure shows. Delete it and the worst case is
one more RPC call.

**Found** (#526): CollectionDetailV2's Mint button had no chain term in its `disabled` expression.
Off mainnet it was held down by `!drop.priceReadOk`, and that was false only because the gated
price read never ran. Deleting the gate, correctly, lets the price land on Base, and the button
arms under its own label "Switch to Ethereum Mainnet". `mint()` refused by itself, so a click
only toasted, but the disabled state had been an accident of the read gate. Measured with the
fix in place: removing the explicit `!drop.onMainnet` from `mintDisabled` fails both connected
off-mainnet cases in `CollectionDetailV2.offMainnet.test.tsx`, on `toBeDisabled()`.

**Do:** before deleting a read gate, grep its consumers for controls that need a positive read
(`*ReadOk`, `status === 'success'`, `!== undefined`) and ask whether the gate was that control's
real guard. If it was, write the guard into the control.

**The test-side twin, same session: a guard's test can be held by an upstream copy of the
guard.** `useAutoRefreshBoost` gates on the wallet's chain, and its test "stays quiet on the
wrong chain" looked like it pinned that. It did not. The hook's input `holdsJBAC` came from
`useNFTBoost`, which carried the same gate, so off mainnet it was `null` and the hook was
disabled regardless. Measured (vitest, the original test file):
- with the pre-fix `useNFTBoost` and `useAutoRefreshBoost`'s own gate deleted, the test
  **passes**;
- with `useNFTBoost`'s gate dropped, the same deletion **fails** it.

The mutation that proves a guard is "delete this guard, with every upstream copy of it gone",
not "delete this guard" in a tree where something else still holds the line.

## 2026-09-11 — the partial-coverage scan over- AND under-reports, and a pre-fix run can fail for the wrong reason

**Believed:** the per-index scan's gap list (method: #502) is the set of reads that
publish an outage as a zero. Fix the list and the file is clean.

**Measured** on six candidate files at trunk `1325f685`. Each gap index was
adjudicated by what its zero *asserts*, then fixed and mutation-checked in PRs #508
#512 #515 #517 #518, which are still open, so those fixes are not on trunk yet:

- **It over-reports.** 25 gap indices; 15 made a claim or armed a control. Of the
  other 10: a fail-closed owner panel, two reads with no consumer, a display
  fallback, three allowances whose only failure mode is an extra Approve, two reads
  whose failure renders the same `–` as a real zero, and one claim that is **true by
  construction**. An unread `paidPerWallet` renders "No refund owed", but only on a
  cancelled sale, and `cancelSale()` reverts `CancelAfterFirstMint` once anything has
  minted. Read the contract before signalling.
- **It under-reports.** Four claim sites have no `status === 'success' ? … : 0` to
  match:
  - a collapse through an intermediate `undefined`
    (`x = ok ? r : undefined; n = x ? f(x) : 0`), twice in one hook;
  - a separate `useBalance` feeding the same "Not enough ETH" claim as a batch read;
  - an early `return { …, lpSupply: 0n }` that zeroed a value the hook *had* read,
    whenever the price feed was stale. That became "0.00% of LP supply" on the
    treasury page.
- **The claim can be the bug when the control is already safe.** A CTA was disabled
  on an unread balance before any fix, because a collapsed 0 is short of any amount.
  "Fails closed" was true, and the button still said "Not enough TOWELI" about a
  wallet nobody read.

**New vacuity shape for the pre-fix run.** Testing an unexported component meant
adding `export` in the fix. Restoring trunk's file for the pre-fix run then fails
*every* test on the missing named export. That is a red run that proves nothing about
behaviour. Reconstruct pre-fix as trunk **plus only the test-enabling change**. The
honest split was then 4 fail / 2 pass, and the 2 are the genuine-zero guard rails.

**Redundant gates make equivalent mutants.** Gating `insufficientX` on
`balanceXKnown` *and* the CTA's `disabled` on `balanceUnknown` makes removing either
one unobservable: the label checks "unknown" first, and `disabled` has the other
gate. One of two belt-and-braces gates always survives a single-line mutation.
Decide which one the tests pin and say so, rather than chasing it.

**An animated figure asserted at t=0 proves nothing.** A score ring that eases
from 0 over 1200ms of `requestAnimationFrame` is empty one frame after render
whatever the score is, so "the ring is empty during an outage" passed — and a
mutation that fills the ring from the UNDERSTATED score survived it. Driving the
clock instead killed it: `vi.useFakeTimers({ toFake: ['requestAnimationFrame',
'cancelAnimationFrame', 'performance'] })` then `act(() =>
vi.advanceTimersByTime(1500))`. That also took the file from ~4s of real waiting
(one `waitFor` was already timing out at 4000ms) to 70ms. A wall-clock wait would
have been the threshold flake this file warns about elsewhere.

**Tooling trap.** JSX *text* does not process `\u` escapes: `Minting closed —
the creator…` rendered six literal characters with tsc and eslint clean. The Claude
Code Edit tool normalises `—` in both strings, so it cannot target the literal
escape ("old_string and new_string are exactly the same"). Fix it with a script that
builds the backslash from `String.fromCharCode(92)`.

**Do:** read the scan's output as a lower bound on where to look and an upper bound
on what to fix. For each gap, write down what the zero asserts before touching it.
Reconstruct pre-fix states rather than just `git show`-ing them.

---

## 2026-09-11 — a callee that never rejects has failure shapes a `.catch` cannot see

**Believed:** a flag set in the `.catch` around a fetcher tells an outage from an empty
result. `fetchListings` relied on one to choose between "temporarily unavailable" and
"No active listings", and the first fix proposed was to read the fetcher's returned
`error` instead.

**Measured** (PR #535, vitest 4.1.11, trunk `ce4fac5e`): the native-orderbook fetcher
fails in three shapes, and the `.catch` saw only the rarest.

- A network failure **resolves** as `{ orders: [], error }`, because the fetcher's own
  `try` wraps its retry loop. With the proxy down, the real function resolved in
  3015ms, and `fetchListings` returned the healthy `source: "opensea"` with no error,
  3 runs of 3.
- The server's soft-fail for an unreachable database is a **200** with
  `degraded: true` and no `error` field at all. Reading `error` still misses it. Only
  the server's handler shows the shape exists.
- Only a chunk-load failure of the lazily imported module **rejects**.

The rule on top was too narrow as well. It called an outage only when *every* source
failed, so OpenSea down beside an empty native book still read as an empty market. A
one-line mutation back to that rule, with the flag already fixed, left 4 of 6
unread-source tests reading as healthy.

**Do:** before choosing a failure detector, list every shape the callee can produce: a
rejection, a resolved error field, and a success status carrying a soft-fail flag. For
the third, read the server. Then fold them into one shape at the callee, so no caller
has to know there were three.

### A turn-capped fake-timer drain passes alone and times out in the file

**Believed:** `for (let i = 0; i < 120 && !settled; i++) await
vi.advanceTimersByTimeAsync(500)` is a bounded way to skip a retry's sleeps.

**Measured:** in the full file two tests hit `Test timed out in 5000ms`, while alone
each ran correctly in 8–9ms. Instrumented, the trigger was an
`afterEach(() => vi.doUnmock(...))`. After it, 6 of 11 tests spent all 120 turns with
the request under test still unsent: 0 `fetch` calls when the loop exited. Four of
those settled on their own afterwards, because they had no timers left to run. The two
whose request fails needed the retry's fake timers advanced, and nothing advanced them
any more. Without that `afterEach`, the request went out at turn 0–1 in every test
that sent one. Across five variants, moving a `vi.resetModules()` test to the start or
the end changed nothing; removing the `afterEach`, or draining until settled, fixed it.

That first pre-fix run went red on the two timeouts, one of them a counter-test that
should have passed: a red for the wrong reason, like the missing export in #520.

**Do:** drain until the promise settles (`while (!settled) await
vi.advanceTimersByTimeAsync(n)`) and let the test's timeout be the bound. A turn cap
bounds turns, not the work they wait on.

## 2026-09-11 — an exact gas estimate is only good for the second it was taken in

**Believed:** if `eth_estimateGas` returns N, the same transaction against the same
state mines at limit N. (A step earlier in the same chase: that the cost was
"non-monotonic in the gas limit" — offer more gas, burn less. It was neither.)

**Measured** (anvil 1.5.1, mainnet fork, `removeLiquidityETH` on a Uniswap-V2-style
pair; automine off, every block timestamp pinned by hand with
`evm_setNextBlockTimestamp` + `evm_mine`; byte-identical calldata and state):

| estimate taken at | mined at | limit | used | result |
|---|---|---|---|---|
| T (= the pair's last update) | T | 207,033 | 163,888 | success |
| T | **T+1** | 207,033 | **206,923** | **reverted — out of gas** |
| T | T+1 | 310,549 (×1.5) | 172,080 | success |

A V2 pair's `_update` writes both cumulative prices only when `block.timestamp` has
moved since its last update. `pair.burn` cost 101,958 in the same second and 112,199
one second later: the +10,241 is exactly those two SSTOREs. **Anvil lets consecutive
blocks share a timestamp**, and a transaction sent with no `gas` is priced by anvil's
own estimate against the pending block, exact to the gas — so anything estimated in
the same second as the pair's last touch and mined in the next one is ~10k short.
"Burn less at a higher limit" was the same-second block being cheaper, not the limit.

Where it bit: an e2e bridge that forwarded the app's gas-less `eth_sendTransaction`
unpadded. The UI runs add → approve → remove inside about a second, so the remove
was often estimated in the add's second. The real spec against a fresh fork, trunk
code: 2 of 9 runs failed, both out of gas one second after the add. Padded +50%, as a
wallet would: 0 of 14, including one run where the race happened and the padding
absorbed it.

**Also measured:** anvil does **not** reject a gas-less send whose estimate fails. It
mines it at the block gas limit (60,000,000 observed) and it reverts on-chain.

**Do:** pad any transaction you hand a node without a limit. When a revert's
`gasUsed` is within ~1% of its limit it ran out of gas — look at what changed
between estimate and inclusion (timestamp, block, state), not at the arguments.

### A test that dies at 3.0m and passes in 4.8s is an unbounded wait

The first attempt ran into the whole 180s test budget; every assertion in the spec
had a 20-30s budget. The error was `locator.getAttribute: Test timeout of 180000ms
exceeded`: a Playwright locator read with no `timeout` inherits the TEST's, and the
receipt link it wanted had been removed (the surface clears it 4s after a success).
So the run printed nothing about what went wrong. A duration far beyond every
assertion budget means an unbounded wait, not a slow system — find it, and bound
every locator read that sits inside a poll.

## 2026-09-11 — anvil's `--retries` never retries a 408, and `--compute-units-per-second` never throttles

**Believed:** anvil's fork flags let it ride out a flaky upstream. Raise `--retries`,
lengthen `--fork-retry-backoff`, lower `--compute-units-per-second`, and a free RPC
plan's intermittent timeout gets absorbed.

**Checked** in the source of anvil 1.7.1 (tag `v1.7.1`, the version CI pins) and the
alloy-transport 2.0.1 it locks. The fork provider retries through alloy's
`RetryBackoffLayer`, whose `should_retry` is `TransportErrorKind::is_retry_err`: HTTP
**429 and 503** and no other status (plus a few rate-limit JSON-RPC bodies, a null
response, a missing batch item). A 408 returns on the first answer. `--retries` caps that
layer and `--fork-retry-backoff` is its sleep, so neither ever engages on a 408.
`compute_units_per_second` is read only *inside* the retry branch, to lengthen a backoff.
It is not a rate limiter and never delays a first attempt; `--no-rate-limit` just sets it
to `u64::MAX`.

**Measured** on anvil 1.5.1 (alloy-transport 1.1.1, the same predicate), with a logging
shim between anvil and drpc that answered drpc's own 408 body to the first ask of a fresh
account's reads:

| arm | `anvil_setBalance` | upstream asked |
|---|---|---|
| 408, no flags | `failed to get account … HTTP error 408` | once |
| 408, `--retries 10 --fork-retry-backoff 100` | same error | once |
| 408, `--no-rate-limit --compute-units-per-second 50 --timeout 90000` | same error | once |
| **429**, no flags (control) | ok | twice (`429,200`) |

The control is what makes "once" mean something: the counter sees a retry when anvil
makes one.

**Worse on 1.7.1 — and reproduced there.** A failed fork read inside block building hits
`apply_pre_execution_changes().expect(…)`, a panic. CI's anvil died with SIGABRT on the
EIP-2935 history-contract read (`GetStorage(0x0000f908…2935, …, HTTP error 408`) and
every later test failed in ~150ms. anvil 1.5.1 does not read that contract when mining
(checked, also under `--hardfork prague`), so this one needs the pinned binary: unzip the
release into a scratch dir and point the harness at it with an env var, leaving the
machine's `~/.foundry/bin` alone. Done that way, the panic reproduces byte-for-byte, down
to `mem/mod.rs:1324`, under every flag combination in the table — and does not happen at
all with the retry sitting below anvil.

**Do:**

- Retry *below* anvil, in front of `--fork-url`, and pass refusals (401/403/404/410)
  through on the first answer so a dead endpoint still fails in its own words.
- To learn whether a client retries status X, put a counting shim in front of it and
  inject X, **with a control status the client is known to retry**. A soak against the real
  endpoint cannot stand in for this. On 2026-09-11, 40 drpc forks at ~180 reads each saw
  zero 408s, though the same endpoint had cost 2 of 30 CI jobs. The rate moves with the
  provider's load and cannot be summoned.
- A deadline-bounded retry loop must hand back the last *real* answer when the deadline
  cuts a retry short. A first draft turned drpc's 408 into a relay-made 504 whenever a
  backoff landed the next attempt just before the deadline (a 504 at 431ms against a 400ms
  deadline, in the unit test that caught it). That swaps the upstream's words for the
  retrier's.
- **A proxy owes the client the upstream's response HEADERS, not just its body.** anvil
  builds the `HTTP diagnostics:` block in its error out of them — on a real failure that is
  `cf-ray` and `server`, the ids the provider asks you to quote. A relay answering with
  `content-type` alone loses them on the one answer that matters, the one it gave up on.
  Encoding and framing headers still stop at the proxy, because `fetch` has already decoded
  the body.

## 2026-09-11 — a gate's comment and a hook's wrong-chain notice are claims, not evidence

**Believed:** when sweeping read gates, a gate whose comment explains it, or a hook
that already tells the user it is on the wrong chain, can be left as it is.

**Measured** (PR #537: eight hooks gated on `useChainId() === CHAIN_ID`, every
read in them pinned `chainId: CHAIN_ID`):

- Three comments justified the gate with a wrong-chain read that would "silently
  return garbage" (useSwapQuote), "returns 0 garbage" (useSwapAllowance) or would
  "price another chain's assets" (`lib/portfolio/sources.ts`). All three were
  false: the per-call pin sends each of those reads to mainnet. Two of the gates
  were still right to keep, for reasons nobody had written down. A quote is the
  swap's arguments, and its aggregator leg is scoped to the wallet's chain on
  purpose. An allowance is displayed nowhere and only decides writes. The third
  gate was wrong to keep: the portfolio refused to total legs that the Dashboard
  showed beside it, read from the same contracts.
- `useWalletExposure` did signal the wrong chain. Its page said "Switch to Ethereum
  mainnet to read your holdings." Directly beneath, the same page said "No tracked
  ERC-20 balances in this wallet": the gated read left `holdings` empty, and the
  empty-state branch never looked at the flag.

**Technique:** decide a gate by what its value reaches. A displayed figure loses
the gate. A write's argument, or the only thing disarming a control, keeps it.
Re-derive the reason from the code rather than inheriting the comment, and write
the real one down. Judge "already honest" by every branch the collapsed value
reaches, not by whether a notice exists somewhere on the page.

## 2026-09-11 — a line-ending check that fires on every file is counting lines

**Believed:** `git show <rev>:<path> | grep -c $'\r'` counts a blob's CRLF lines.

**Measured:** inside a `$( … )` substitution, in the Git Bash this repo's agents
run on, it returned each file's total line count: 272 of 272, 609 of 609, and
"CRLF" for all 40 of 40 sampled hooks. It nearly got #526's replayed files
re-committed to "fix" endings that were already LF. The same substitution over a
known-LF string (`printf 'a\nb\n'`) returned 2. `tr -dc '\r' | wc -c` read 0 CR
bytes in every blob, and the replayed blobs had the same OIDs as the originals.

**Technique:** before acting on a check that reports "all N", run it on a known
negative. Count the byte (`tr -dc '\r' | wc -c`), not lines matching a pattern.
Prove a replay exact with blob OIDs (`git rev-parse <rev>:<path>`), not
`git patch-id`, which ignores whitespace.

## 2026-09-11 — a per-test timeout is a third clock, and a slow body can be a sleep

**Believed** (the candidate list in the 2026-09-10 entry "a flake-candidate list
ranked by duration mixes two clocks"): `holderOutageRender` was the one thin test
— 3528ms, "about 1.4x headroom" against the 5000ms body bound — because of its
in-body `await import()`, and `--testTimeout=2000` would reproduce it on demand,
as it had for the previous instance of this class.

**Measured** (vitest 4.1.11, trunk `dd7885ba`, each body split with
`performance.now()`, 3 runs of the file alone):

| test | bound | in-body import | the rest of the body |
|---|---|---|---|
| CollectionHealth (the "thin" one) | **20000ms**: `it(name, fn, 20000)` | 36–41ms | `findByText` **3160–3198ms** |
| HolderAnalytics | 5000ms | **276–315ms** | ~70ms |

All three beliefs were wrong.

1. **The third argument to `it()` is its own clock**, and the CLI does not
   override it. Under `--testTimeout=200` the 20000ms test passed at ~3170ms
   while its 5000ms neighbour timed out, 3 runs of 3. So read the closing
   `}, N)` before calling a test near-timeout. That entry's table is wrong for
   `holderOutageRender` :53 and for every in-body import in
   `offerBookOutageHonesty` — each of those tests passes 20000 or 30000.
2. **The slow part was a sleep, not a load.** Three seconds of that body is a
   retry backoff: `lib/orderbook.js`'s `withRetry` sleeps 1s, then 2s. It runs
   because Node's `fetch` cannot parse the relative URL `/api/orderbook` under
   jsdom (`Failed to parse URL from /api/orderbook?...`), and the code treats
   that as transient. It measured 3012–3027ms every run. A cold import grows
   with CPU load and a timer barely does, so a split that shows one near-constant
   segment of whole seconds is a timer. No import hoist moves it.
3. **A repro gate has to be sized from the split, not the reported duration.**
   `--testTimeout=2000` **passed** on the unfixed file, because the real in-body
   cost was ~300ms. A 200ms gate then failed one post-fix run of three at 235ms
   during a load spike. What separated the two cleanly: a threshold between the
   quiet pre-fix (≥292ms) and post-fix (≤98ms) durations, 165ms, with pristine
   and fixed runs **interleaved** so load drift lands on both. The unfixed file
   timed out 6 of 6 and the fixed one passed 6 of 6 (45–147ms, CPU load 3–100%).

**Do:** split a slow test with `performance.now()` before choosing a fix; read the
`it()` call's third argument before naming its bound; size any timeout gate from
the split, interleave it, and record the load next to every number.

### A timeout's second failure is a ghost

The full-suite run after the fix was the heavier of the two (415s vs 314s). In
it, `volumeFallbackHonesty`'s Hero test — 4921ms in the run before — hit `Test
timed out in 5000ms.`, and the test after it failed as well, with
`expected [ <span …(2)></span> ] to have a length of +0 but got 1`. That second
failure is not a second defect. Forcing the first test to time out
(`-t Hero --testTimeout=400`) produced the identical assertion 3 runs of 3;
letting it finish (`--testTimeout=1500`) passed 6 of 6. A timeout does not cancel
the body. Vitest stops waiting, runs cleanup and moves on, and the body resumes
when its import resolves — rendering into the next test's document.

**Do:** in a red run, fix the first timeout in a file and re-run before reading
any failure that follows it.

### Incidental

- A relative-URL `fetch` under jsdom is an instant `TypeError`. Any component
  that calls its own `/api/...` therefore runs its error path, and its retry
  schedule, in every test that renders it — whatever the test thinks it covers.
- A "mutation applied" check can be defeated by the fix's own comment. `grep -c
  'await import('` counted the new comment explaining why the import was hoisted,
  and the script correctly refused to run. Anchor the check on the code's shape
  (`= await import(`), not on a phrase a comment can repeat.
- The fix itself, full suite on the same base, before → after: HolderAnalytics
  874ms → 208ms, and a botLink signature test with the same shape 1033ms → 2ms.
  Both were measured in the heavier of the two runs.

## 2026-09-11 — a test that lets two endings race pins only the one that wins

**Believed:** the arrival curtain has a hard deadline so that it is gone within its
3,000 ms budget, and `arrival.spec.ts` asserted exactly that budget with no input, so the
deadline was taken to be under test.

**Measured:** the curtain ends on whichever comes first, its own animation or the
deadline, and on an unloaded box the animation won at about 2,880 ms. So the test never
ran the deadline: deleting the deadline timer left it green. The deadline's own bug
(armed at the budget, so always a few ms late) surfaced only when a slow CI runner let
the animation lose, at 3,002 to 3,010 ms in three tries of three (PR #524). Throttling the
CPU makes that path likely, never certain. Taking the curtain's 2D context away stops the
animation outright, and then only the deadline can end the curtain. That test failed 10
of 10 on the pre-fix build (3,011 to 3,021 ms), passed 20 of 20 on #530's fix (2,903 to
2,916 ms), and failed 4 of 4 with the deadline timer deleted.

**Technique:** when two mechanisms race to end something, test each one with the other
disabled. A test that lets them race pins only the winner on the machine running it, so
a mutation of the loser cannot fail it. Disable the rival at a boundary the test can
reach (here, an init script that makes `getContext` return null for the curtain's canvas
only), assert that the disabling happened, and assert something only the loser's path
produces (the curtain was still up when the deadline's dissolve began), so that a third
way of ending cannot pass for it.

## 2026-09-11 — a deadline armed at the budget can only be met late

**Believed:** `setTimeout(finish, BUDGET)` enforces "gone within BUDGET". The arrival
curtain's timer was armed at exactly 3,000 ms, and its e2e asserted `lifetime <= 3000`.

**Measured:** CI read the curtain at 3,002 to 3,010 ms in five tries on one PR, and the
same commit passed at 2,935 ms on a retry. A timer fires at or after its delay, the
removal it triggers still costs a render, and this timer was armed in a passive effect,
which runs after paint, so its clock started after the one the test reads. With the CPU
throttled locally, trunk's curtain lived 3,105 to 3,288 ms (x4) and 3,421 to 3,542 ms
(x6). Arming it in a layout effect and ending it 100 ms early brought those to 2,982 to
3,021 ms and 3,030 to 3,090 ms. That holds the budget at CI's load, and at x4 in five
runs of six. At x6 it still misses: the timer cannot fire until the frame in progress
ends, and on a saturated main thread nothing fires on time.

**Technique:** a timer can keep an "at most N ms" promise only by firing early. Keep a
measured slack back from the budget, bound it in a test from both sides (larger than the
lateness measured, smaller than the time the on-time path needs), and start the timer's
clock where the test's clock starts. To reproduce a few-ms timing flake locally, throttle
the CPU with CDP (`Emulation.setCPUThrottlingRate`) until the slow path is the one that
runs. Then measure the old build and the new build interleaved at the same rate, because
back-to-back batches measure the box's load as much as the change.

## 2026-09-11 — a callback prop in a useCallback's deps restarts every effect that lists it

**Believed:** listing `finalize` in a long-lived effect's dependencies was harmless,
because nothing about the component changes while it plays.

**Measured:** `finalize` was `useCallback(..., [onComplete])`, and the parent passed
`onComplete={() => setSplashDone(true)}`, a new function on every render (this build has
no React Compiler). So every render of the parent cleared the curtain's deadline and
armed a fresh one, and re-ran the canvas effect, which starts the animation again from
its first phase. A unit test showed it on trunk code: after a re-render at 2,000 ms the
deadline had not fired by 3,000 ms, and the canvas effect had run 3 times for one mount.

**Technique:** keep a callback prop out of long-lived effects' dependency chains. Hold it
in a ref updated in a layout effect, and call `ref.current` from a stable callback. Test
it by re-rendering with a NEW function and asserting two things: the effect did not
re-run (count something it does once per run, here `getContext`), and the new function
is the one that gets called.

### A callback prop in an effect's deps is only a bug if the SETUP has side effects

A sweep flagged five components that list an `onClose` prop in an effect's deps
while the parent passes an inline arrow, so the effect tears down and re-runs on
every parent render. Only **two** were worth changing.

The separator is what the effect's *setup* does:

- **Real:** setup focuses an element or locks body scroll. Every parent render
  runs cleanup (restore focus to the opener) then setup (focus the panel), so the
  caret is yanked away from whoever is typing and the scroll-lock save/restore
  churns. `SolanaSwapPage` re-renders about once a second while a quote is live.
- **Benign:** setup only does `addEventListener`. Removing and re-adding the same
  document listener in the same tick is invisible. Three of the five were this,
  and their focus / scroll-lock effects already carried correct deps.

**Do:** classify by what the setup *does* before fixing all N. "Prop in deps" is a
smell, not a defect; fixing the benign ones is churn in files you then owe a
re-verify.

**The measurement that settles it**, and it is cheap: spy on
`HTMLElement.prototype.focus`, render the component under a parent that re-renders,
and count. Pre-fix, one re-render moved the count 1 -> 3 -- +2 per render, one from
the cleanup and one from the setup. That +2 *is* the caret theft, and it makes the
invariant ("a parent re-render adds no focus calls") pinnable without asserting any
literal about dep arrays.

Fix shape is the latest-ref: hold the prop in a ref updated in a layout effect, read
`ref.current` from the handler, and let the setup effect be mount-scoped.

## 2026-09-11 — a local fallback that accepts a bad argument hides it until production

**Believed:** a green unit suite plus a working dev server means a rate-limited
API handler works, because every call to the limiter goes through the same module
in both places.

**Measured:** `/api/aggregator?resource=tape` answered `500
FUNCTION_INVOCATION_FAILED` on every production request (both domains, reproduced
with curl) while its unit suite and every local run were green. The handler called
the global limiter without `windowSec`. The shared limiter builds Upstash's sliding
window as `` `${windowSec} s` ``, so production built `"undefined s"` and Upstash
threw ("Unable to parse window size"). Off Vercel the same module falls back to an
in-memory limiter, which took `undefined` without complaint: the window became
`NaN` and never reset, and nothing threw. The handler's own suite mocked the limiter
module entirely. Three layers each looked fine: the mock, the fallback, and an
untyped options object.

**Technique:** when a library has a lenient local fallback and a strict production
backend, test the ARGUMENTS a caller passes, not the fallback's behaviour. Here:
assert the mocked limiter was called with `windowSec`, and add a source check that
every call site passes one (45 of them; one was missing it). No runtime test can see
this class, because every path the tests reach is the lenient one.

## 2026-09-11 — a guard calibrated in CI measures CI's environment, not production's

**Believed:** an exact-count e2e guard that is green in CI means the deployed page
reads the same, because the bundle is byte-identical.

**Measured:** the same per-route spec (a count of prose em dashes, asserted exactly),
run against production after a deploy, read five routes differently: `/chart` 36
against CI's 0, `/developers` 11 (10), `/copy-trading` 12 (11), `/alerts` 14 (17),
`/launch` 30 (31). The bundle was identical; the environment was not. Production had
an indexer URL configured and answering, serverless functions running, and push
keys set. CI's `vite preview` build had none of the three, so no branch gated on them
ever rendered there. `/chart`'s 36 were tooltips and table rows on the indexed chart,
a branch CI can never reach.

**Technique:** write down where a guard's numbers hold, and for branches CI cannot
render, pin the copy at the source instead (here, a scan of the chart's components,
its lib and the hooks that feed it). Then run the same guard against production
after each deploy: every difference is an environment-gated branch the CI run never
saw.

## 2026-09-11 — a test for one clause of an OR is vacuous under an all-fail fixture

**Believed:** "every read fails" is the strongest fixture for an unread flag. If the
flag fires when everything fails, it fires.

**Measured** (PR #514, `useLPFarming`'s
`statsUnread = poolStatsUnread || minStakeUnread || <clause over four more reads>`):
with a chain term put back on the clause alone, both new tests, one hook-level and
one rendered, still PASSED, 60/60, under an all-fail fixture. `poolStatsUnread` had
set the union by itself, so the clause under test never decided anything. Failing
ONE leg that only the clause covers, while the totals and the minimum land, the same
mutation failed exactly 6 of 63.

**Do:** to test one member of an OR, make every other member false, and assert that
they are false in the test itself. Then the member under test is the only thing
that can answer. "Everything failed" tests the union, not the clause.

## 2026-09-10 — a reverted tx renders no receipt, so DOM assertions blame the UI

**Believed:** asserting a receipt link appeared is a sufficient check that a money-path
transaction landed.

It is not, and the failure mode is actively misleading. These surfaces render **one**
receipt line, for **any** confirmed transaction (an approval included), and render
**nothing at all** for a reverted one. So when a burn reverts, the assertion is left
looking at whichever earlier receipt is still on screen. The same single root cause
produced three different messages depending only on poll timing — the previous step's
receipt still being up, an approval's receipt satisfying the check and a puzzling
failure four lines later, or no link at all. None of them says "it reverted".

**Do:** on a fork, read the transaction's fate off the node, not off the DOM —
`expectMinedSuccessfully(page, what, forkTxCount(page))` in `e2e/fixtures/wallet.ts`.
Assert the chain *first*, then keep the DOM assertion; one pins the chain, the other
pins the UI.

---

## 2026-09-10 — pinning a fork block costs you the archive, and then the deadline

Two traps that both look like "the app is broken", both hit while pinning
`ANVIL_FORK_BLOCK` to reproduce a flake.

**1. A pinned block is an archive request.** Forking at *latest* works on every public
endpoint; forking at a block a few hours old does not. Measured, forking at a block
~1,900 behind head: `eth.drpc.org` 408 "Request timeout on the free plan",
`ethereum-rpc.publicnode.com` 403, `eth.merkle.io` 429, `1rpc.io` and
`eth.rpc.blxrbdn.com` "historical state not available". Working:
`eth-mainnet.public.blastapi.io`, `gateway.tenderly.co/public/mainnet`,
`rpc.flashbots.net`. CI does not pin, so CI is unaffected — this bites the person
reproducing.

**2. A pinned block's clock lags, and every router call then reverts.** The app stamps
`deadline = Date.now()/1000 + 1800` from the *browser's* clock;
`TegridyRouter.MAX_DEADLINE` is 2 hours. So once the fork's `block.timestamp` lags
wall-clock by more than **90 minutes**, every add, remove and swap reverts
`DEADLINE_TOO_FAR` — not `EXPIRED`. Pinning a block that was fresh in the morning and
re-running it after lunch silently converts a working suite into a wall of failures.
This is the mirror of the `advanceForkTime` trap already noted in `wallet.ts`: pushing
the chain *ahead* gives `EXPIRED`, letting it fall *behind* gives `DEADLINE_TOO_FAR`.

---

## 2026-09-10 — zeroing an input does not withdraw the claim built on it

**Believed:** F100 fixed "the LP farm advertises a live APR after its reward
period ends" by zeroing the reward rate once `periodFinish` passed. Its commit
said the UI would "never advertise a dead emission schedule". The per-day tile
did read 0, so the fix looked complete.

**Measured** by mounting the real `useLPFarming` hook under `LPFarmingSection`
with mainnet's own state: past `periodFinish` 1781493095, and a residual
`rewardRate` of 3306878306878306 still in storage. The APR hero rendered `0.00%`
in green, captioned "estimated from staked TVL · falls as more LP is staked".
The derived figure's null-guard tested whether its *inputs* were present (pool
loaded, supply non-zero, something staked, price positive), and they all were.
A zero numerator over a finite denominator is a well-formed number, so the guard
let it through as a confident, live-looking APR. The caption written for the
ended state sat in the null branch the guard never took, so it was unreachable
in exactly the state it was written for.

**Do:** when a fix neutralises an input by setting it to 0, don't stop at that
input. Trace every value derived from it, and ask whether the zero reaches the
screen as "absent" or as "zero". Guards that test whether data is present cannot
see a semantic state such as "ended". The state has to be passed down as its own
flag and checked first. An unreachable branch whose copy names a real state is
the cheapest detector there is.

### A counter-test's fixture default can pin the next bug

A sibling PR on the same section added a "genuine zero" counter-test, `reports
a real empty farm as 0, and keeps the invitation`. Its point was sound: an empty
farm is publishable, and a fix that blanked every zero would be a bug. But its
base fixture was documented as "all reads landed, on an **ended** schedule with
nothing staked". So it asserted "be the first to stake LP" on a farm paying
nothing, which is exactly the bug above. Merging the two branches locally left
**1 failure in 103: that test**. Giving it a live schedule made it 103/103.
"Every read landed, every value zero" is not a neutral state. It is a specific
state of the system, with claims attached.

**Do:** in a counter-test ("the honest case must still render X"), set the state
the claim depends on explicitly, and never inherit it from a base fixture's
defaults. Before calling a fix done, list open PRs (`gh pr list --state open`),
check which of them touch your files (`gh pr diff <n> --name-only`), merge the
overlapping ones into a throwaway branch, and run both suites. Two PRs can each
be green and still contradict each other.

Aside, from the same simulation: `git merge --abort` refuses ("not uptodate")
once you edit a file the merge *added*. On a throwaway branch that still points
at your own HEAD, `git reset --hard` is the clean exit.

## 2026-09-10 — "deployed == source" means the BROADCAST's commit, and a write mock never encodes

**Believed:** to confirm a live contract behaves like `contracts/src`, build trunk
and compare it with the chain; and a hook test that asserts
`functionName: 'x'` on the wagmi write mock proves the button can send `x`.

**Measured** on TegridyStaking (`0xcaDc93E96De58EA554c71ca609974625615E046D`) while
re-wiring its paused exit (#510):

- **Trunk was the wrong build target.** Five commits had touched
  `TegridyStaking.sol` since the deploy. The Foundry broadcast
  (`contracts/broadcast/<Script>.s.sol/<chainId>/run-latest.json`) records a
  top-level `"commit"`, here `833b757`. Built at that commit in a detached
  worktree (`forge build src/TegridyStaking.sol`, via_ir, 21 s wall), the executable
  runtime matched the chain byte for byte: **24,284 of 24,337 bytes.**
- **The other 53 bytes are CBOR metadata, and they did not match although the
  code did.** A metadata mismatch is not a code mismatch. Strip
  `2 + uint16(last two bytes)` from the end of both before comparing.
- **Two kinds of slot differ by construction; handle both rather than skipping
  them.** Library link slots (`deployedBytecode.linkReferences`): fill them from
  the broadcast's `libraries` and assert the chain holds the same 20 bytes at
  every offset (10 of 10 matched). Immutables (`immutableReferences`) compile as
  zeros: adopt the chain's values and PRINT them, so a wrong constructor argument
  is visible (20 slots, 2 addresses).
- **A wagmi write mock never ABI-encodes.** With the new ABI entry deleted
  (mutation), 58 of 59 tests in the affected files still passed, including the
  one asserting `functionName: 'emergencyWithdrawPosition'`. A real wallet would
  have thrown `AbiFunctionNotFoundError` at encode time. The only test that
  failed runs `encodeFunctionData` against the real ABI and checks the selector
  (`0x5f667fc0`) read out of the deployed dispatcher, which pins the ABI to the
  chain and not just to itself.
- **Fork-proving behaviour does not need the repo's build.** A standalone Foundry
  project (only `forge-std` plus an inline interface) compiled 20 files in 2.3 s,
  and 4 tests against `vm.createSelectFork("https://eth.drpc.org")` ran in 10 s.
  Every call hit the on-chain bytecode, so repo source was not what got tested.
  Make the rig BINDING first: top up the reward reserve and assert
  `earned() > 0` before comparing "pays" with "forfeits". Otherwise both look
  like "returned the principal".

**Do:** before changing UI semantics on a live contract, build the broadcast's
`commit`, not trunk, and compare with metadata stripped, link slots asserted and
immutables printed. Then diff just the functions you depend on between that
commit and trunk. For every hand-written ABI entry a button relies on, keep one
test that ENCODES the call against the real ABI.

---

## 2026-09-10 — the retry's error is not the failure's error

**Believed:** when an E2E test fails all three attempts, the last attempt's error
is the failure — and a money-path spec that goes red on the first trunk commit
containing a PR that touched that page is that PR's regression.

**Observed** (`E2E Tests (Anvil fork — money paths)`, trunk `1325f685`, run
`34558450845`, `e2e/stake.spec.ts` stake → claim → unstake):

| attempt | error |
|---|---|
| 1 | `anvil_setBalance: failed to get account … HTTP error 408 … "Request timeout on the free plan, please upgrade to paid plan"` |
| retry #1 | `stake: no explorer link to a transaction hash appeared` (30s) |
| retry #2 | the same, 30s |

Only attempt 1 named the cause: the fork's upstream RPC refused during test
setup. Both retries reported a downstream symptom that reads exactly like an app
defect — on a commit that had just merged a change to `/farm`.

**Re-running the same job on the same SHA: 22/22 clean, 0 flaky.** Same code,
different outcome — the upstream, not the merge.

**Do**, when a fork-backed E2E goes red:

1. Read attempt 1's error, not the last retry's. Here only attempt 1 named the
   cause.
2. Grep the log for the upstream's own words — `free plan`, `HTTP error 4`,
   `failed to get account` — before reading any assertion.
3. Re-run the job on the same SHA. It is the one test that separates "the code
   changed" from "the world changed", and it costs a single job.

The fork upstream is `eth.drpc.org`'s keyless tier (`.github/workflows/ci.yml`).
Until a funded key goes in `secrets.ANVIL_FORK_URL`, expect this to recur — and
to land on whichever PR merged last.

## 2026-09-10 — a guard that cannot fire is armed, not inert

**Believed:** a condition that is always true under the current config is dead
weight at worst. `enabled: isDeployed && chainId === CHAIN_ID` on a read that is
already pinned `chainId: CHAIN_ID` looks like harmless belt-and-braces.

**Measured** (`@wagmi/core` 3.6.5 source as installed, git history, and a real
browser):

- Under a ONE-chain wagmi config, `useChainId()` cannot leave that chain.
  `createConfig` ignores a connector's move to an unconfigured chain ("If chain
  is not configured, then don't switch over to it"), and `validatePersistedChainId`
  rejects an unconfigured persisted one. The gate was added (R043, 2026-04-26)
  under `chains: [mainnet]`, so it was always true and never observed doing
  anything.
- Adding Base and Robinhood (2026-08-21) made `useChainId()` follow the wallet.
  That commit pinned 135 reads so they would come from mainnet "exactly as
  before", and left the gates next to those pins alone. From that day the gates
  fired, and nothing had ever tested what happens when they do.
- `useChainId()` is a PERSISTED store value, not "the wallet's chain":
  `partialize` writes `chainId` to localStorage and `actions/disconnect.js` never
  resets it. In Playwright Chromium, logged out, with `wagmi.store` seeded
  `{ chainId: 8453, current: null }` (what a disconnect leaves behind), the store
  still read 8453 after the app loaded.
- A disabled TanStack query is neither loading nor failed. `isLoading` is
  `isPending && isFetching` (query-core `queryObserver.js`), fetchStatus is
  `idle`, and `data` is undefined. So there is no skeleton, every per-index
  `status` check reads as not-success, and any unread flag scoped by the same
  gate stays silent. In that browser run the LP farm printed "Total LP Staked
  0.0000", "Total Funded 0 TOWELI" and "be the first to stake LP" on 8453, while
  the same run on chain 1 printed 528.1998 and 2,000 TOWELI. With the gate
  removed, both chains printed the chain-1 text.

**Why no test saw it:** the shared wagmi mock answered reads whatever
`query.enabled` said, so every gate was invisible to every test that used it.
Making it honour `enabled` broke exactly one suite of 38 (`useBribes.test.ts`,
5 tests). Those tests stubbed reads of a contract whose address is zeroed, which
are reads production never issues.

**Do:**
- When a config widens (one chain to many, a flag to a list), grep for guards
  that compare against the OLD single value. They change meaning with no diff.
- Treat `useChainId()` as "last known chain", including for disconnected
  visitors. Gate WRITES on it; pin READS with `chainId` instead of gating them.
- A test double must refuse what the real thing refuses. A mock that serves
  disabled queries turns every `enabled:` condition into untested code.

## 2026-09-10 — a partial-coverage gap gets fixed one leg at a time, by whoever trips on which leg

**Believed:** a green `node frontend/scripts/check-unread-signal.mjs` means no file
outside its baseline publishes an unread contract read as a zero.

**Measured:** the guard's verdict is one `SIGNAL_RE.test(src)` per **file**, so one
`…Unread` flag anywhere passes a file that collapses eleven reads and signals three.
At `f8bda8b9`, `useLPFarming.ts` was exactly that: `positionUnread` over indices 5–7,
nothing over the other eight, beside a green guard. It then took **three separate
changes** to cover the farm-wide reads of that one file, each fixing the leg it had
tripped over: `3610c147` (MIN_STAKE, [10]), `7d6fdab6` (the pool totals, [0][4]) and
#499 (the rest of the set, [1][2][3][9]). `032af111` has since put this shape on the
guard's printed blind-spot list and added a census, which on trunk `1325f685` reads
**16 files, 69 collapse sites** exempted by a file-scoped signal. By its own comment
the census measures exposure and does not go down as legs are fixed — so it cannot
say *which* reads are unguarded.

**Do:** turn the census into findings with a per-index diff, per `data`-ish variable:

- collapsed = `X?.[i]?.status === 'success' ? … : 0n | 0 | [] | false | ''`
- covered = `X?.[i]?.status !== 'success'` — **and** the bare `X[i]?.status` form
  written after a `!!data` guard, **and** `=== 'success'` inside a positive-polarity
  `const …ReadOk = …;` flag. Without the last two the scan reported covered reads as
  gaps (two false alarms on trunk) and missed a real signal (`useNFTDropV2.ts:111`).
- Match the ternary's middle with `[^;]{0,200}?`, **not** `[\s\S]{0,200}?`. The
  permissive form lets a lazy match run into the next statement, pairing an index
  whose fallback is *not* a zero with the next line's `: ''` — it reported the wrong
  index and hid the real one until tightened.

The output is a candidate list, not a verdict. On trunk `1325f685` it finds eight
guard-passing files with uncovered collapses. Adjudicated: `useLPFarming` [1][2][3][9]
(#499; [8] is left out on purpose, see below); `useUserPosition` [3], where `paused`
collapses to `false`; and `useNFTDropV2`, which signals index 1 of its eleven
collapses, so an unread `maxSupply` makes `isSoldOut = maxSupply > 0 && …` read "not
sold out". Not yet adjudicated: `AMMSection`, `useAddLiquidity`, `useFarmStats`,
`usePoints`, `usePoolTVL`.

**A gap is not automatically a bug — ask which way the zero fails, then what it
costs.** In the same batch, `allowance → 0n` reads "not approved": no stake is ever
armed on it, but Approve re-arms after every approval while the read keeps failing,
so "fails closed" is not a bound on cost. `MIN_STAKE → 0n` fails the other way —
`minStake > 0n && …` *disarms* the minimum guard — and is still deliberately not
blocked: the contract enforces the minimum regardless, so the section says the
minimum is unread and leaves Stake armed, because refusing a legitimate stake over one
unanswered read of a constant costs more than a revert. Same collapse, same batch,
three different right answers.

### How a read failure actually arrives on this stack

**Believed:** a whole-batch failure leaves `data` undefined; and one hook's eleven
calls cannot be split across requests, because `lib/wagmi.ts` configures no `batch`.
Both wrong — and #499 was first written, reviewed and committed against them.

**Measured** (installed wagmi 3.7.7, @wagmi/core 3.6.5, viem 2.56.1 — read from source):

- The query does **not** reject. `allowFailure` defaults to `true` (viem
  `actions/public/multicall.js:54`; @wagmi/core `actions/readContracts.js:5`). A
  rejected aggregate3 request becomes one `status: 'failure'` entry per call
  (`multicall.js:164-174`), and any other throw falls back to per-call `allSettled`
  failure entries (`readContracts.js:33-42`; only `ContractFunctionExecutionError` is
  rethrown). A total outage is eleven `'failure'` entries with `data` **defined** and
  `isError` **false**. `data` is undefined only before the first fetch or while the
  query is disabled.
- Absent config is not "off": @wagmi/core `createConfig.js:132` defaults
  `batch: { multicall: true }`. Every call is then queued into one scheduler shared by
  the whole client and cut into aggregate3 requests at 1024 bytes of calldata, so one
  hook's reads can land in different requests and fail independently.

So on this stack `!data` and `isError` catch **no** RPC failure, whole or partial —
only per-index `status` checks do. Partial failure exists by construction; how often
it happens in production has not been measured.

**Do:** before reasoning from what a config file leaves out, read the library's
default for it. Before writing "the query failed", check whether the library can make
the query fail at all.

---

## 2026-09-10 — an accordion that unmounts closed answers is invisible to every DOM audit

**Believed:** mounting an accordion's answer only while it is open
(`{isOpen && <div id={panelId}>…</div>}`, framer-motion's `AnimatePresence`
pattern) is the accessible shape, as long as the button carries `aria-expanded`
and `aria-controls`.

**Measured** on `/faq` with the repo's axe sweep (`e2e/a11y-routes.spec.ts`,
Chromium, production build under `vite preview`, `--workers=1`). The route carried
`aria-valid-attr-value` as a known violation: every closed button's
`aria-controls` named an id that was not in the document. With every panel always
rendered and given the `hidden` attribute while closed, the finding is gone. The
route's exact known-violation list went from `['aria-valid-attr-value']` to `[]`
and the sweep stayed green.

**The second cost is silent.** Anything that reads the page's text (a
banned-string guard, a copy census, an em-dash count) has nothing to read in an
answer that is not mounted, so on an unmount-on-close page it checks the
questions and nothing else. Seen directly with the panels mounted: one forbidden
answer added under a harmless question ("How does staking work?") turned the
voice census red, although that answer was closed and nothing on screen showed
it.

**Technique:** keep the panel mounted and toggle `hidden`. That takes it out of
view and out of the accessibility tree, so a screen reader still meets only the
open answer, while its text stays in the DOM. A walker that judges a page's copy
must then NOT skip `hidden` subtrees. Skipping `aria-hidden` is still right,
because that marks decoration rather than content.

## 2026-09-10 — `toHaveURL(/x$/)` anchors on the query string, and a redirect inside a lazy page waits for that page

**Believed:** after `page.goto('/swap?tab=liquidity')`, `await expect(page).toHaveURL(/liquidity$/)`
proves the app redirected to `/liquidity`.

**Measured** (Playwright 1.62, chromium, `frontend/e2e/liquidity.spec.ts`, 50 runs with an
init script logging every `history.replaceState`): the assertion passed on its first poll
while the page was still on `http://host/swap?tab=liquidity` in **48 of 50** runs — that
URL ends in "liquidity" too. The line asserted nothing; the only real wait was the next
one (the `h1`), so a failure "at the URL check" was really the heading line. Assert the
path: `toHaveURL(url => url.pathname === '/liquidity')`.

**Second trap, same test.** The redirect was a `useEffect` inside the lazy page it was
redirecting *away from*. A stack captured inside the `replaceState` hook named
`TradePage-<hash>.js` as the caller, and the request log gave the order: host chunk →
page chunk (109 KB) → full swap render → *then* the destination's two chunks — four
serial lazy loads where a direct visit has two. Moving it to a route-level `<Navigate>`,
normalised to each run's `load` event under 8 workers: redirect p50 665ms → 164ms,
heading p50 1274ms → 728ms, runs that fetched the swap chunks 30/30 → 0/30.

**Reproducing it:** 50 unthrottled runs, at 1 and at 8 workers, never failed. A 6x CDP
CPU throttle (`Emulation.setCPUThrottlingRate`, chromium only) reproduced the reported
failure in 1 of 5 — URL check passed on `/swap?tab=liquidity`, then the heading timed
out after 5s with `Received string: "Swap"`, the redirect firing 6.6s after `load` —
while the fixed build passed 5/5 with the redirect at most 1.05s after `load`. A load
flake you cannot reproduce is a throttle level you have not tried.

**Do:** decide URL-only redirects where the URL is first read (the route element), never
in an effect inside a lazy component. To pin it, *hold* the chunks the redirect must not
need — `page.route(pattern, () => {})` never answers — so a regression fails every run,
not only the slow one (pre-fix: 4/4 device projects failed; post-fix: 4/4 passed). Pair
it with a control that the pattern still matches a request somewhere, or a chunk rename
silently turns the hold into a no-op.

---

## 2026-09-10 — a waited `count()` can still be vacuous: the role was wrong

**Believed:** a `count()`-gated assertion that reads 0 right after `page.goto` is
a timing bug. Wait for the page to mount and the count becomes honest.

**Measured** (#519: `e2e/a11y-smoke.spec.ts`, "TradePage swap amount input has a
contextual aria-label", instrumented; all four device projects at `--workers=1`,
production build under `vite preview`). The old test ran `goto('/swap')`, then
`if ((await getByRole('textbox', { name: /amount of .* to pay/i }).count()) > 0)`
assert visible. `count()` read 0 on every project:

| project | count() ran at | route mounted then? | count() |
|---|---|---|---|
| chromium | +153ms after load | no (skeleton `aria-busy`) | 0 |
| iphone-safari | +739ms | no | 0 |
| ipad-safari | +152ms | no | 0 |
| mobile-chrome | +902ms | **yes**, input in the DOM | **0** |

After mount, on every project: textbox **0**, spinbutton **1**.

`<input type="number">` has the implicit role **spinbutton**, not textbox, and
Playwright's role engine follows that mapping. So `getByRole('textbox')` never
matches a number input. There's no error and no timeout, just 0. A fix that
waited for mount and kept the textbox locator would have been exactly as vacuous,
with a convincing-looking wait in front of it. mobile-chrome is the proof: the
timing was already fine there, and the count was still 0.

Mutation check: with the label changed so it no longer matched, the OLD test
still PASSED 4/4. The rewrite locates the input by structure, then asserts
`toHaveAccessibleName`. It FAILED 4/4 with
`Received string: "Amount of ETH a11ymutant"`, a value rather than
"element not found".

**Do:** before trusting a role locator on an `<input>`, read its `type`: number →
spinbutton, range → slider, search → searchbox. When a conditional reads 0,
separate "not there yet" from "never matches": count the raw CSS selector next to
the role locator, before and after mount.

### A fix recipe derived from one gate can miss the second

Its sibling test (OnboardingModal) skipped on every run. The known reason was
real: the fixture pre-seeds the modal's seen-key. But clearing the key alone still
rendered nothing: no dialog within 8s, 4/4 projects. That's because a second,
unrelated condition decides whether the auto-open variant is mounted at all.
Written straight into the test, the one-gate recipe would have turned a false
green into a new red.

**Do:** run a fix recipe as a probe (log the state it claims to produce) before
encoding it as an assertion. A skip reason that was never measured can be wrong
twice.

---

## 2026-09-10 — a flake-candidate list ranked by duration mixes two clocks

**Believed:** a list of slow tests with "headroom vs 5000ms" is a fix queue, and
the fix for a cold `await import(...)` inside a test is to hoist it to a static
import at the top of the file.

**Checked** against the source of four candidates listed that way:

| file | the import sits in | bound |
|---|---|---|
| `holderOutageRender.test.jsx` :34, :53 | `it()` body | 5000ms |
| `offerBookOutageHonesty.test.jsx` :48 (and 9 more at the same depth) | `it()` body | 5000ms |
| `offerErrorHonesty.test.jsx` :85 | top-level `beforeEach` | **10000ms** |
| `cancelAllWalletGuard.test.jsx` :124-125 | top-level `beforeEach` | **10000ms** |

*Corrected 2026-09-11 (see "a per-test timeout is a third clock, and a slow body
can be a sleep"): `holderOutageRender` :53 and every in-body import in
`offerBookOutageHonesty` sit in tests that pass an explicit `20000` or `30000`,
so neither is on the 5000ms clock.*

Half the list was on the other clock. And `cancelAllWalletGuard` calls
`vi.resetModules()` before that import **on purpose**: its comment says a static
import "would give them two" `CollectionContext` instances, so the provider and the
component would stop sharing state. Hoisting it would not fix a flake; it would
break the thing the test exists to check.

**Do**, before touching any slow-test candidate:

1. Find where the cost sits — body (5s) or hook (10s). See the entry below.
2. `grep resetModules` in the file. If it resets, a hoist is illegal. The only move
   that keeps module identity is a bare warming import at the top, because every
   post-reset import still comes from one registry.
3. Only then rank by duration.

Measured on merged trunk `f8bda8b9` (full suite, 588 files / 8343 tests, 0
failures, a quiet 188s run), slowest test per file: `holderOutageRender` **3528ms,
its import in the body — about 1.4x headroom, the only thin one** ·
`offerBookOutageHonesty` 1810ms · `offerErrorHonesty` 1638ms (hook plus one body
import, not split) · `cancelAllWalletGuard` 1494ms (hook) · `bot-noncustodial`
251ms — the same test that was seen timing out at 5020ms under heavy load. One run
ranks nothing.

**The general form:** a conclusion is only as wide as the population screened. The
first sweep for this flake class looked only at files that reset inside hooks,
found nothing close to its bound, and reported that — while a body-bound test sat
at 1.4x in a directory the sweep never covered.

## 2026-09-10 — "flaky" can be a UI defect, and a warn-only gate hides it forever

**Believed:** a test that fails then passes on retry is nondeterministic — timing
noise in the harness — and a CI job that ends green has nothing to report.

**Measured** (`e2e/claim-rewards.spec.ts`, the Anvil-fork job, six consecutive CI
runs on trunk, read from the job logs):

| outcome | attempt 1 | retry #1 |
|---|---|---|
| clean pass | 2.5s / 3.8s / 3.9s | — |
| fail → pass | 6.4s / 6.4s / 6.7s | 2.6s / 2.6s / 3.3s |

(Whole-test durations, not read latency — 5s of each failure was the assertion
waiting and giving up, so the underlying read is known only to EXCEED 5s. Its
ceiling was never observed, because nothing waited long enough to see it. Worth
saying out loud: a failed assertion measures your budget, not the thing.)

The retry is not a second roll of the same die. Attempt 1 pays an Anvil fork's
COLD state — the first read of every storage slot is a round trip to the public
upstream — and by retry the fork has cached it. **A retry that is consistently
~2.5x faster than the attempt it replaces is measuring a warm cache, not luck.**
That signature separates "slow" from "broken" before you read any app code.

The 5s number on the other side of it is Playwright's default `expect` timeout.
Nothing in the repo chose it; the assertion simply never named one, and the
cold-fork cost straddles it.

**Do:** when a test is called flaky, diff attempt-1 against retry duration first.
Comparable → nondeterminism. Retry much faster → first-run cost, and the fix is
either a named budget or removing the dependency on that cost.

### The gate that let it live on trunk

`playwright.config.ts` sets `retries: process.env.CI ? 2 : 0`, and ci.yml's
money-path guard fails the run on `skipped != 0` but only `::warning`s on
`flaky != 0` — deliberately, so one fork-RPC flake cannot read as a coverage
loss. Both decisions are individually right. Together they mean a defect that
fails EVERY first attempt still produces a green job, forever, with the evidence
sitting in a warning nobody opens.

**Do:** a warn-only flaky lane needs someone reading the warnings. Grep job logs
for `passed only on retry` across recent runs — a title that appears in most of
them is not flaky, it is failing with a retry budget covering for it.

### The defect underneath: a skeleton that hides its section's name

`LPFarmingSection` early-returned a loading skeleton that drew two grey
`animate-pulse` bars where its `<h2>LP Farming</h2>` and subtitle go. Both are
compile-time constants — no read gates them — so the section withheld its own
identity for the length of an RPC round trip: an unnamed region to a screen
reader, and the one unlabelled box among five labelled sections to everyone else.

That is not a brief flicker. Read from the installed packages, not from docs:
viem 2.56.1's `http` transport defaults to a **10s** timeout and retries **3x**
per transport (`buildRequest.js`: `retryCount = 3`), the app puts two endpoints
behind a `fallback`, and `App.tsx` sets `retry: 2` on the QueryClient with
TanStack's default backoff (`min(1000 * 2**n, 30000)` — 1s then 2s). A degraded
RPC therefore holds a "loading" state for tens of seconds.

**Do:** a skeleton should shimmer what the read decides and print what it does
not. Text that is a literal in the component has nothing to wait for.

### Why this made the test unfixable-by-timeout

The assertion was `getByRole('heading', {name: /lp farming/i})`. With no heading
in the skeleton, that single locator had to mean two different things — "the
section mounted" and "its reads landed" — so there was no budget that was both
tight enough to catch a section wedged in its skeleton and loose enough to
tolerate a cold fork. Splitting it (heading = mounted, a read-derived stat =
landed, each with its own budget) is what made a named timeout honest rather
than a way to stop the test complaining.

**Do:** if you cannot pick a timeout without trading away a real failure, the
assertion is conflating two facts. Split it before tuning the number.

### Incidental

- `anvil.exe` and `cast.exe` are blocked by Windows Application Control on this
  box, sandboxed or not ("An Application Control policy has blocked this file").
  The fork job cannot be reproduced locally here — CI job logs are the
  measurement of record. `vitest` and `playwright` (mock mode) run fine.
- The default preview port 4173 is routinely held by another session's `vite
  preview`, and `playwright.config.ts` sets `reuseExistingServer: !CI` — so a
  local run silently tests whatever build that server holds. Verify the port is
  free (`netstat -ano | grep :4173`) or run with a config on another port.

---

## 2026-09-10 — a slow vitest "test" is often a slow *hook*, and hooks get 10s

**Believed:** a test reported at 2353ms is 2353ms from its 5000ms `testTimeout`,
so ranking tests by reported duration ranks them by flake risk.

**Measured** (vitest 4.1.11, `frontend/`):

| construct | bound | failure text |
|---|---|---|
| test body | **5000ms** | `Test timed out in 5000ms.` |
| `beforeEach` | **10000ms** | `Hook timed out in 10000ms.` |

A 6s `beforeEach` **passes**, and vitest reports the test as 6016ms — hook time is
folded into the *test's* duration. So a "2.3s test" whose body is
`expect(x).toBe(1)` is really a 2.3s hook with 4x headroom, not 2x.

**Do:** before calling a slow test near-timeout, find out whether its cost is in a
hook or a body. Duration alone does not rank risk.

### The cheap fix when the cost is one cold module load

Files that do `vi.resetModules()` + `await import(...)` pay the cold
fetch+transform **once**, in whichever block runs first; every later re-import is
~1ms, because `resetModules` clears the module *registry*, not the transform
cache. A bare top-level `import "../thing.js";` warms the graph during collection,
which nothing bounds, and leaves every reset in place.

Measured under full-suite load (581 files / 8145 tests): 2353ms → **5ms** and
3173ms → **11ms**, with zero source changes. Comment it as NOT dead code, or the
next reader deletes an import that appears unused.

### When you may NOT replace resets with a seam

Swapping per-test `vi.resetModules()` + re-import for a static import plus an
exported `__resetXCaches()` is only sound if the module reads env **exclusively
inside functions** and the seam clears **all** its top-level mutable state.

- `frontend/api/_lib/apiAuth.js` **qualifies** — env is read inside `getRedis()` /
  `getKeyStore()`, and `__resetApiAuthCaches()` clears all five memos.
- `frontend/api/_lib/seaport-verify.js` **does not** — `SEAPORT_CHAIN_ID` and
  `IS_PRODUCTION` are read at module scope, `_publicClient` has no seam, and two
  tests assert the *throw module scope raises* on a bad chain id, which a static
  import cannot express at all.
- `frontend/api/orderbook.js` **does not** — `SUPABASE_URL` / `SUPABASE_SERVICE_KEY`
  are read at module scope and feed a `createClient` **singleton**, with no seam.

**Do:** grep the module for top-level `let` / `var` / `new Map()` / `new Set()` and
for `process.env` outside a function body, *before* touching the test.

### Run the mutation check AFTER the change, not only before

Neutering the resets in `orderbook.bundle-guards.test.js` failed **0** tests before
the warming import — the reset was inert, true only by coincidence, because every
block set identical env. After the import it fails **22**: the warmed instance is
evaluated before any `beforeEach` sets the Supabase env, so its client is `null`
and only the per-block re-import picks up a live one.

The change turned a coincidence into a pinned invariant — but a pre-change mutation
check alone would have reported the weaker, and by then stale, conclusion.
Mutation-check both sides of a change that alters *when* a module is evaluated.

### Incidental

- Suite wall-clock is a poor signal on a shared box. Between two runs of the same
  581 files it moved 249s → 307s, driven by jsdom `environment` setup going
  2169s → 2823s across *untouched* files. Compare per-test durations, not totals.
  Load moves the verdict too, not only the total. Two later full-suite runs of one
  tree, ~4 hours apart (2026-09-12), went 196.65s and 450.16s,
  with jsdom `environment` at 1787s and 3638s — across *untouched* files. The slow
  one failed 4 tests in 2 files, each a 5000ms body timeout plus one follow-on
  failure from the timed-out test's un-cleaned DOM (`Found multiple elements`,
  `expected length 0 got 1`). Both files passed in isolation and neither imported
  the change under test. **A timeout cascade under load is not a defect in the code
  you just wrote** — re-run before believing it, and compare per-phase durations,
  not the verdict.
- `no-unused-vars` does not flag a bare side-effect `import "x";` — it declares no
  binding. Lint will not remove the warming import; a human might.
