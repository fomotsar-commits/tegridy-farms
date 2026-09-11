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
