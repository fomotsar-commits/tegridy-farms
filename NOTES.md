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
- `no-unused-vars` does not flag a bare side-effect `import "x";` — it declares no
  binding. Lint will not remove the warming import; a human might.
