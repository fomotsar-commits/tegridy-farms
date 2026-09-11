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
