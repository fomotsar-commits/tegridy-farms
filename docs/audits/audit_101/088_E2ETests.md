# Audit 088 — E2E + Test-Utils Forensics

**Agent:** 088 / 101  **Date:** 2026-04-25  **Mode:** AUDIT-ONLY
**Targets:**
- `frontend/e2e/*` (7 spec files + 1 fixture)
- `frontend/test-results/` (1 file: `.last-run.json`)
- `frontend/src/test/setup.ts`
- `frontend/src/test-utils/wagmi-mocks.ts`

## Headline counts

| Metric                                               | Count |
|------------------------------------------------------|------:|
| E2E spec files                                       |     7 |
| E2E test cases (total)                               |   ~36 |
| E2E specs that exercise on-chain state               |     0 |
| E2E specs gated behind a real signed tx              |     0 |
| Decorative "page renders" specs (no flow assertions) |    19 |
| `test.skip` calls in e2e                             |     2 |
| TODOs / FIXMEs in e2e                                |     0 |
| Stale failed e2e runs in `test-results/`             |     0 |
| Hardcoded private keys / mnemonics committed         |     0 |
| Hardhat **public** test address (account #9, public, non-secret) | 1 |
| Vitest unit-test files using `vi.mock('wagmi')`      |     9 |
| Global mock with shared mutable state                |     1 (`src/test-utils/wagmi-mocks.ts`) |

## CRITICAL findings — none

No private keys, no mnemonics, no API secrets in any test artifact. The
single committed wallet address (`0x71be63f3384f5fb98995898a86b02fb2426c5788`,
Hardhat default account #9) is a *public* address only — its private key is
not present, and it is part of Hardhat's published deterministic set, so
disclosure is not a security event. Acceptable.

## HIGH findings

### H-088-1 — All E2E coverage is mock-based; no Anvil fork ever stood up
- **Where:** `frontend/e2e/fixtures/wallet.ts:107-186` installs an EIP-1193
  mock that returns canned values for `eth_call`, `eth_getBalance`,
  `eth_blockNumber`. `eth_sendTransaction` is **not handled at all** — it
  returns `null`. There is *zero* on-chain simulation.
- **Impact:** "False-positive coverage." Every wallet-aware spec
  (`wallet-connect`, `trade-page`, `gauge-voting`, `a11y-smoke`) merely
  asserts the page mounts after the mock fires `accountsChanged`. The mock
  returns `null` for every contract read the hooks didn't explicitly stub,
  so `useReadContract` resolves to empty/zero state, the UI shows the
  empty/disconnected fallback, and the test calls that "passing." A real
  RPC failure, ABI mismatch, or revert path would *also* land in the
  empty/disconnected fallback and the suite would still be green.
- **Documented:** the team is aware — every spec carries a
  `// Things DEFERRED until the fixture is backed by Anvil` block (see
  `trade-page.spec.ts:10-14`, `gauge-voting.spec.ts:13-19`) and the
  fixture itself has an `ANVIL_BACKEND` upgrade recipe at
  `fixtures/wallet.ts:188-204`. None of it is wired up.
- **Fix:** complete the ANVIL_BACKEND upgrade — fork mainnet at a known
  block, forward unhandled JSON-RPC to Anvil, sign via impersonate
  cheatcode. Then add the missing happy-path specs below.

### H-088-2 — Six core user flows have no e2e coverage at all
| Flow                         | Coverage | Notes |
|------------------------------|----------|-------|
| Connect wallet               | partial  | `wallet-connect.spec.ts` asserts the mock is *injected* and the connect button text disappears, never that wagmi reaches a connected state. The `wrong-network banner` test even acknowledges this in a code comment. |
| Swap (approve → swap → toast)| **none** | Only tab-toggle visibility is asserted. No signature, no tx, no success path. |
| Add liquidity                | **none** | No test file references `addLiquidity` against the router or pair. |
| Remove liquidity             | **none** | Same. |
| Stake / unstake LP / Towel   | **none** | Farm page test only asserts h1 contains `/farm|stake/i`. |
| Claim rewards (LP / restaking / bribes) | **none** | Zero references to a claim flow in any spec. |
| Repay loan (NFT lending)     | **none** | Zero references. |
| Borrow against NFT           | **none** | Zero references. |
| Mint from launchpad / drop   | **none** | Specs only assert page loads. |
| Gauge commit + reveal        | **none** | `gauge-voting.spec.ts:36-48` is explicit: "structural rather than functional." |

A grep for `addLiquidity|removeLiquidity|repay|borrow|claim|stake\(|unstake`
across `frontend/e2e/` returns **2 hits**, both inside *comments*
explaining what's *not* tested.

### H-088-3 — `test-results/` is checked into git
- **Where:** `frontend/test-results/.last-run.json` (45 bytes, tracked).
- **Impact:** This directory should be in `.gitignore`. Today it only
  holds the success marker `{"status":"passed","failedTests":[]}` so the
  immediate risk is low, but a future failed run would commit traces and
  screenshots — including potential secret leakage if specs ever start
  using fixtures from `.env`. Add `frontend/test-results/` to
  `.gitignore` now while it's still empty.

## MEDIUM findings

### M-088-1 — Decorative "page loads" coverage masquerades as functional
- 19 of ~36 e2e cases assert only `expect(h1).toBeVisible()` or a
  `toContainText(/.../i)` regex against the body. Examples:
  `smoke.spec.ts` (entire file), `trust-pages.spec.ts:13-58`,
  `gauge-voting.spec.ts:30-34, 52-58, 63-91`. These would still pass if
  the page is a static skeleton with all client-side data fetching
  broken — the React Suspense fallback also contains an `<h1>`.
- **Fix:** every "page loads" test should additionally assert at least one
  data-driven node renders (e.g., a TVL chip from a contract read, a
  pool count, a current-epoch number). Today the success path and the
  "all RPCs return null" path are indistinguishable.

### M-088-2 — Global wagmi mock with shared mutable singleton state
- **Where:** `frontend/src/test-utils/wagmi-mocks.ts:83`
  `const state: WagmiMockState = defaultState();` — a *module-scoped*
  singleton. `wagmiMock.reset()` is required at the top of every
  `beforeEach`. If a developer forgets, state from the previous test
  leaks into the next.
- **Risk:** silent test pollution. A test that "passes because of leftover
  state from the prior test" hides a real regression.
- **Fix:** either (a) auto-reset via Vitest's `afterEach` registered in
  `src/test/setup.ts`, or (b) restructure the mock to expose a factory
  that returns a fresh instance per test.

### M-088-3 — `vi.mock('wagmi')` is duplicated 9 ways across hook tests
- 9 hook test files each define their own minimal `vi.mock('wagmi', ...)`
  factory rather than reuse `wagmi-mocks.ts`. Each one stubs a *subset*
  of the real `wagmi` API, and several disagree about return shapes.
  `useSwap.test.ts:7` admits this: "the shared scaffold doesn't export
  `useBalance`; rather than extend the scaffold and affect other tests,
  we inline a minimal mock here."
- **Risk:** when a real wagmi upgrade lands (e.g. `useReadContract`'s
  return shape changes), only the hook tests using the modified surface
  break — the hooks may silently change behaviour against unstubbed
  paths and *still pass* their own tests.
- **Fix:** extend `test-utils/wagmi-mocks.ts` to be the single source of
  truth, including `useBalance`, `useSimulateContract`, `useGasPrice`.

### M-088-4 — `src/test/setup.ts` is a one-liner — no per-test cleanup
- **Where:** `frontend/src/test/setup.ts:1` is just
  `import '@testing-library/jest-dom';`. No `cleanup()`, no resetMocks,
  no `vi.restoreAllMocks()`, no DOM cleanup hook.
- **Risk:** combined with M-088-2, every test relies on its own discipline
  to clean up. Forgetting once is silent.
- **Fix:** add `afterEach(() => { cleanup(); vi.clearAllMocks(); })` and
  hook the wagmi-mock reset there.

## LOW findings

### L-088-1 — Two `test.skip(true, ...)` calls in `a11y-smoke.spec.ts`
- Lines 61 and 82. Both legitimate (modal not rendered in
  disconnected/non-first-visit runs) — but the skip is *unconditional* on
  the boolean `true`; the comment explains *why*, but the runtime
  condition that should gate the skip is not there. Consider replacing
  with `test.skip` predicates checking the actual DOM precondition.

### L-088-2 — `playwright.config.ts` only runs Chromium + mobile-chrome
- No Firefox, no WebKit. Walletmock works on all engines, so adding the
  other two would be cheap.

### L-088-3 — `forbidOnly: true` on CI is correctly set
- Good. No `.only` calls in any e2e file. Confirmed.

### L-088-4 — `webServer` runs `vite preview` against the prod bundle
- Good — exercises real built output. But `reuseExistingServer:
  !process.env.CI` means a stale dev server can be used locally; once a
  real fork is added, mismatch between locally-served bundle and the
  Anvil-mocked address book becomes a flake source.

## INFO findings

### I-088-1 — No CI-conditional `test.skip` patterns
- Searched for `process.env.CI` and `isCI`. Only `playwright.config.ts`
  uses it (workers/retries). No spec hides itself on CI. Good — flaky
  tests are not being silenced.

### I-088-2 — `e2e/wallet-connect.spec.ts:30-31`
- The "no `eth_requestAccounts` before connect" assertion is genuinely
  useful coverage — it would catch a regression where the app
  auto-prompts on mount.

### I-088-3 — The single committed test address belongs to Hardhat's
  deterministic set
- `0x71be63f3384f5fb98995898a86b02fb2426c5788` = Hardhat account #9.
  Public, well-documented, no secret material. Acceptable.

## Summary table

| Severity | Count | Highest |
|----------|------:|--------|
| CRITICAL |     0 | — |
| HIGH     |     3 | All e2e coverage is mock-based; 6 core flows uncovered; `test-results/` tracked |
| MEDIUM   |     4 | Decorative tests; singleton mock; duplicated mocks; thin setup |
| LOW      |     4 | — |
| INFO     |     3 | — |

**Bottom line:** the test suite has the *shape* of e2e coverage but no
on-chain truth. The team has clearly designed for the Anvil upgrade — the
recipe is in-tree — but it has not been executed. Until then, any swap /
add-liquidity / repay / claim regression will not be caught by CI.
