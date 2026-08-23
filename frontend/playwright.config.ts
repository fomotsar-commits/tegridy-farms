import { defineConfig, devices } from '@playwright/test';

// ─────────────────────────────────────────────────────────────────────────
// THE SIX TESTS WEBKIT CANNOT RUN, AND EXACTLY WHY.
//
// Each of these asserts `expect(pageErrors).toEqual([])` — no uncaught
// JavaScript error during the run. That assertion is engine-dependent, not
// app-dependent. A cross-origin `fetch()` that the browser refuses rejects
// with a TypeError; WebKit surfaces that rejection to the page as an uncaught
// error ("Fetch API cannot load … due to access control checks") while
// Chromium reports it only as a failed network request. The app behaves
// identically in both — it renders, the wallet mock connects, the headings
// appear — but on WebKit the array is never empty, because the mock-mode e2e
// run has no keys for eth.merkle.io or api.geckoterminal.com and those calls
// always fail.
//
// Measured, not assumed: full suite at --workers=1 (the CI setting) across
// both WebKit projects — 121 passed, and the persistent failures were these
// six titles and nothing else. They pass on chromium and mobile-chrome in the
// same run, so the pageerror contract is still gated; it is gated on the
// engines that can express it.
//
// This is deliberately a title list and not `testIgnore` on the six files:
// ignoring the files would drop ~50 WebKit assertions that do pass, to
// suppress six that cannot. The list is kept honest by
// src/test/playwrightDeviceMatrix.test.ts, which re-derives it from the specs
// and fails if a test starts or stops asserting pageErrors.
//
// TO REMOVE AN ENTRY: make the offending fetch not reject in mock mode (route
// stubbing in e2e/fixtures/, or a `page.route` abort that resolves instead of
// throwing). Do not remove the WebKit projects.
// ─────────────────────────────────────────────────────────────────────────
export const WEBKIT_EXCLUDED_TEST_TITLES = [
  '/community renders the gauge / governance surfaces under mock wallet',
  'connected wallet renders without unhandled errors',
  'connected wallet renders the LiquidityTab without page errors',
  'connected /farm renders staking + LP farming surfaces',
  'connect → the app actually authorizes the wallet and swaps the gate for a CTA',
  'page loads without unhandled page errors',
] as const;

const escapeForRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WEBKIT_GREP_INVERT = new RegExp(WEBKIT_EXCLUDED_TEST_TITLES.map(escapeForRegExp).join('|'));

// ── THE SUITE MUST TEST *THIS* CHECKOUT'S BUILD, AND IT DID NOT ─────────────
//
// `reuseExistingServer: !process.env.CI` means a local run adopts whatever is
// already listening on the preview port — INCLUDING a `vite preview` left
// running by a different clone, worktree or branch. Nothing checks that the
// bytes on that port came from this working tree, so the suite runs, reports a
// number, and the number is about somebody else's `dist/`.
//
// MEASURED, not hypothesised: while diagnosing the heat-door failures on
// 2026-08-22, port 4173 was held by a four-day-old
//   node …\tegriddy farms\frontend\…\vite.js preview --port 4173
// belonging to the MAIN checkout, which carried unrelated uncommitted edits.
// A fresh `vite preview` in the worktree logged "Port 4173 is in use, trying
// another one…" and bound 4175, while Playwright reused 4173 — so every spec,
// and every hand-written probe, exercised the other checkout's `dist/`. That is
// a suite whose result is unrelated to the code under test: it cannot fail for
// the right reason and it cannot pass for the right reason.
//
// E2E_PORT gives each worktree its own port so runs cannot collide. Default and
// CI behaviour are byte-identical to before (CI sets no E2E_PORT, and
// `reuseExistingServer` is already false there).
//
// IF A RUN LOOKS IMPOSSIBLE — a fix that cannot matter changes the result, or a
// change that must matter does not — check this FIRST:
//   Get-NetTCPConnection -LocalPort 4173 -State Listen |
//     %{ (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)").CommandLine }
// and re-run with E2E_PORT set to something free.
const E2E_PORT = Number(process.env.E2E_PORT ?? 4173);
const E2E_ORIGIN = `http://localhost:${E2E_PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: 'html',
  // ── THE TEST TIMEOUT MUST OUTLAST THE LONGEST ASSERTION TIMEOUT ──────────
  //
  // There was no `timeout` here, so Playwright's default 30_000 applied — the
  // SAME 30_000 that `expectTxReceipt` passes to its own `toBeVisible`
  // (e2e/fixtures/wallet.ts:76). Two equal budgets race, and the test-level one
  // wins: the assertion can never reach its own limit, so its message never
  // prints. Every receipt failure in CI has been reporting the generic
  // "Test timeout of 30000ms exceeded" instead of "no /tx/0x… receipt link
  // appeared" — the diagnostic the assertion was written to give.
  //
  // This raises NO assertion's budget and hides no hang. Every `toBeVisible`,
  // `toBeEnabled` and `toHaveText` keeps the timeout it declares (20_000 in the
  // money-path specs, 30_000 for receipts); a genuinely stuck test still fails,
  // just with the reason attached. Keep this strictly greater than the largest
  // per-assertion timeout in e2e/ — grep for `timeout:` there before lowering it.
  timeout: 60_000,
  use: {
    baseURL: E2E_ORIGIN,
    trace: 'on-first-retry',
    // AppLoader auto-skips when the browser advertises `prefers-reduced-motion:
    // reduce` — without this, every test sits behind a fullscreen canvas intro
    // for the entire duration. See frontend/src/components/loader/AppLoader.tsx
    // (`shouldSkipAtMount`).
    //
    // This MUST live under `contextOptions`, not at the top level of `use`.
    // Playwright has no top-level `use.reducedMotion` fixture — the emulation
    // flag is a `BrowserContextOptions` key, and `use` is typed as
    // `UseOptions<PlaywrightTestOptions, PlaywrightWorkerOptions>` which does
    // not accept it. Written at the top level it type-errors (TS2769) and, more
    // importantly, does nothing at runtime: it is never forwarded to
    // `browser.newContext()`, so every test really was sitting behind the intro.
    // The nesting below is Playwright's own documented form for this exact
    // option (see the `contextOptions` JSDoc in playwright/types/test.d.ts).
    contextOptions: {
      reducedMotion: 'reduce',
    },
    // ── WITHOUT THIS, EVERY `page.route` IN e2e/ IS A NO-OP ON WEBKIT ──────
    //
    // `vite preview` serves a PRODUCTION build, so registerAppServiceWorker
    // (src/lib/pwa/serviceWorker.ts — `opts.enabled ?? import.meta.env.PROD`)
    // registers /sw.js on every e2e run, and sw.js's `activate` calls
    // `self.clients.claim()` (public/sw.js:70), so the already-open page
    // becomes CONTROLLED mid-test. On WebKit a controlled document's requests
    // leave Playwright's page-scoped interception entirely.
    //
    // MEASURED against this build, same stub as heat-gate.spec.ts:67:
    //   webkit   + allow -> controller=/sw.js, heat route hits 0, door STALE
    //   webkit   + block -> controller=null,   heat route hits 2, door WARM
    //   chromium + allow -> controller=/sw.js, heat route hits 2, door WARM
    // So the worker controls the page in BOTH engines; only WebKit loses the
    // route. That is why heat-gate is the spec that caught it — it is the only
    // one stubbing a same-origin app API (the Anvil stubs in
    // e2e/fixtures/wallet.ts target cross-origin RPC hosts, chromium-only).
    //
    // The failure mode is this repo's cardinal sin wearing a fixture's clothes:
    // the stub still "installs", the test still runs, and every assertion below
    // it silently becomes an assertion about an outage. `vite preview` has no
    // /api, so the unrouted call falls through to the SPA fallback and returns
    // 200 text/html; heatClient.ts:120 `res.json()` throws, and the door
    // fail-closes to STALE — a state with no verdict word and no degrees.
    //
    // NO COVERAGE IS LOST: nothing in e2e/ asserts service-worker behaviour
    // (grep sw.js/serviceWorker/offline across e2e/ finds only prose), and the
    // worker is exercised directly by src/lib/pwa/serviceWorker.test.ts and
    // serviceWorkerCaching.test.ts. If a PWA spec is ever written, opt that ONE
    // file back in with `test.use({ serviceWorkers: 'allow' })` rather than
    // re-enabling it suite-wide.
    serviceWorkers: 'block',
  },
  // ───────────────────────────────────────────────────────────────────────
  // THE THREE-DEVICE MATRIX.
  //
  // The standing requirement is desktop + phone + tablet. Only the first two
  // existed, and the phone was Pixel 5 — Chromium, which is the one engine
  // iOS does not have. Every iPhone and iPad on earth runs WebKit regardless
  // of the app icon, so a Chromium-only matrix cannot see a WebKit-only break
  // in a wallet flow or a CSS feature.
  //
  // The device descriptors below carry `defaultBrowserType: 'webkit'` and the
  // real viewport/DPR/touch flags; do NOT pin them onto chromium to save a
  // browser download. A phone-shaped Chromium claiming to be an iPhone is the
  // matrix lying about what it covers.
  //
  // Widths are load-bearing, not decorative:
  //   Desktop Chrome  1280  — md: and above; desktop nav
  //   iPhone 15        393  — below md:; mobile bottom nav, touch, no hover
  //   iPad (gen 7)     810  — at/above md:, but touch-only and no hover, the
  //                           combination neither other project produces
  //
  // COST: ci.yml's e2e job installs webkit alongside chromium. The anvil job
  // stays chromium-only — it passes --project=chromium.
  // ───────────────────────────────────────────────────────────────────────
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-chrome', use: { ...devices['Pixel 5'] } },
    { name: 'iphone-safari', use: { ...devices['iPhone 15'] }, grepInvert: WEBKIT_GREP_INVERT },
    { name: 'ipad-safari', use: { ...devices['iPad (gen 7)'] }, grepInvert: WEBKIT_GREP_INVERT },
  ],
  webServer: {
    command: `npx vite preview --port ${E2E_PORT} --strictPort`,
    port: E2E_PORT,
    // --strictPort so a busy port is a hard, loud failure. Without it vite
    // shrugs, binds the next free port, and Playwright waits on — then reuses —
    // whatever the ORIGINAL occupant is serving. See the E2E_PORT note above.
    reuseExistingServer: !process.env.CI,
  },
});
