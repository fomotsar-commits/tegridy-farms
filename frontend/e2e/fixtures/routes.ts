/**
 * The route table, as the browser sees it.
 *
 * WHY THIS FILE EXISTS. `a11y smoke covers 2 of 43 routes` was a standing
 * finding (docs/EVERYTHING_LEFT_2026_08_15.md) and the reason it stayed true
 * is that nothing in the test tree knew what the 43 were. Every spec picked
 * its own handful of paths by hand, so adding a route added zero obligations.
 * This is the single list; src/test/a11yRouteCoverage.test.ts re-derives the
 * same list from src/App.tsx and fails when the two disagree, which is what
 * makes a new route arrive with coverage attached instead of arriving silently.
 *
 * SEVEN of the pages host what used to be separate pages as TABS, and the tab is
 * selected from the URL path. Three are the originals (ActivityPage / LearnPage /
 * InfoPage — see `tabFromPath` in each); four arrived 2026-09-04 with the "More"
 * menu condensation (LaunchHubPage / EarnPage / StatsPage / TrustPage, all
 * driven by pages/SectionHost.tsx off their nav section). So a per-path sweep
 * does cover the tabs: /security is the LearnPage security tab, /scan is the
 * TrustPage scanner tab.
 *
 * `owner` stays the CONTENT page — the file where a failure is actually fixed —
 * and `tabOf` records the host that wraps it. Collapsing a section changes the
 * second and never the first, which is why nineteen entries here gained a
 * `tabOf` in that change and not one changed its owner. (/tokenomics and
 * /treasury are the exception, and in the other direction: they named their HOST
 * as owner while they were LearnPage/InfoPage tabs, and now name the page a
 * reader would open.)
 */

import type { Page } from '@playwright/test';

/** Why a route cannot be asserted the way the others are. Never left implicit. */
export type RouteGate =
  /** Renders its own content with no wallet and no deployed contract. */
  | null
  /** Not a page — asserts a redirect target instead. */
  | 'redirect'
  /** Only exists in a dev build; production redirects to `/`. */
  | 'dev-only'
  /**
   * Renders in production, but is absent from every nav, sitemap and link —
   * reachable by typing the URL and nothing else. NOT a security boundary:
   * "unlisted" is not "protected". It is acceptable only because the surface
   * is read/export-only in a production build — the save middleware is a vite
   * plugin declared `apply: 'serve'`, so no write endpoint is served at all.
   * Unlike `dev-only` there is no redirect to assert, so no `redirectsTo`.
   */
  | 'unlisted';

export interface RouteSpec {
  /** Path as written in App.tsx. */
  path: string;
  /** Component that owns the rendered surface — where a failure is fixed. */
  owner: string;
  /** Hub tab this path selects, when the owner is a tabbed host. */
  tabOf?: string;
  gate: RouteGate;
  /** Required when `gate` is not null; also used to record what an audited route does NOT reach. */
  why?: string;
  /** Required when `gate === 'redirect'` or `'dev-only'`: the path the router lands on. */
  redirectsTo?: string;
  /**
   * a11y rule ids this route violates today, from e2e/fixtures/a11yAudit.ts,
   * measured against `main#main-content` so shared chrome is not re-reported
   * forty times. Asserted EXACTLY — a new violation fails the route, and a
   * fixed one fails until it is deleted from here. A list that can only be
   * appended to is a list that stops being read.
   */
  knownViolations: readonly string[];
  /**
   * Same, for a second pass with the wallet mock connected. Present only on
   * routes whose DOM materially changes on connect — auditing the
   * disconnected surface alone would report a wallet gate as if it were the
   * page. `undefined` means the connected pass is not run for this route.
   */
  connectedViolations?: readonly string[];
}

/**
 * Lazy chunks + WebKit + parallel workers.
 *
 * Every page in this app is a `lazy()` import behind Suspense, so "navigated"
 * and "mounted" are separated by a chunk fetch. Playwright's default 5s expect
 * timeout covers that on Chromium at any worker count and on WebKit at
 * --workers=1 (which is what CI uses), and does NOT cover it on WebKit at the
 * local default worker count — measured on e2e/trust-pages.spec.ts: five tests
 * green at --workers=1 in ~2s each, red at 9 workers on the same machine and
 * the same build, `locator('h1') element(s) not found` after 5s. The page was
 * never broken; the budget was. Waiting on the mount explicitly is what makes
 * the result depend on the app instead of on the host's core count.
 */
export const ROUTE_MOUNT_TIMEOUT = 20_000;

/**
 * The Tradermigos splash gets its own, larger budget. It is not a lazy chunk
 * behind Suspense — it is a full-viewport animated intro that runs a loading
 * sequence before it reaches `ready`, and on WebKit with nine workers sharing
 * one preview server it has been measured past 20s. This is the one surface in
 * the app whose mount time is a product decision rather than a network cost.
 */
export const SPLASH_MOUNT_TIMEOUT = 60_000;

/**
 * Navigate and wait for the lazy route chunk to have actually mounted.
 *
 * The probe is deliberately NOT "a heading appeared". That was the first
 * version and it hung for 20s on /solana — correctly, because the gated Solana
 * surface renders FeatureNotDeployed, which emits no heading at all. A mount
 * probe that a real page can fail turns a content defect into a timeout on an
 * unrelated line.
 *
 * What it waits on instead: the layout's `main` exists, no Suspense fallback is
 * still inside it (every skeleton in src/components/PageSkeleton*.tsx carries
 * `aria-busy="true"`), and the route put content there.
 */
export async function gotoRoute(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForFunction(
    () => {
      const main = document.querySelector('main#main-content');
      if (!main) return false;
      if (main.querySelector('[aria-busy="true"]')) return false;
      return (main.textContent ?? '').trim().length > 30;
    },
    undefined,
    { timeout: ROUTE_MOUNT_TIMEOUT },
  );
}

/**
 * Wait until the DOM stops changing.
 *
 * A fixed `waitForTimeout` was here first, and it flaked exactly the way a
 * fixed timeout does: connected /farm audits the LP farming inputs, those
 * inputs arrive with a contract read, and under a loaded full-matrix run the
 * read landed after the sleep — so the sweep audited a page that had not
 * finished arriving and reported FEWER violations than the route declares.
 * That direction is the dangerous one: a slow page would have looked clean.
 *
 * `quietMs` of no mutations is the signal that the page is done, and it scales
 * with the machine instead of guessing at it. `timeout` caps the wait for
 * surfaces that never fully settle (poll-driven price tickers do exist here) —
 * hitting the cap is not an error, it just means the audit runs against the
 * busiest honest snapshot available.
 */
export async function waitForQuiescence(
  page: Page,
  { quietMs = 900, timeout = 15_000 }: { quietMs?: number; timeout?: number } = {},
): Promise<void> {
  await page.evaluate(
    ([quiet, cap]) =>
      new Promise<void>((resolve) => {
        let timer = 0;
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = window.setTimeout(finish, quiet);
        });
        const finish = () => {
          observer.disconnect();
          clearTimeout(timer);
          clearTimeout(hardStop);
          resolve();
        };
        const hardStop = window.setTimeout(finish, cap);
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        timer = window.setTimeout(finish, quiet);
      }),
    [quietMs, timeout] as [number, number],
  );
}

/**
 * `/nakamigos` opens on the Tradermigos splash, a full-viewport gate with no
 * `main` behind it until dismissed. Splash persistence is per-mount by product
 * decision (no sessionStorage flag — see nakamigos/App.jsx), so there is
 * nothing to pre-seed and the gate has to be driven the way a user drives it.
 */
export async function gotoNakamigos(page: Page): Promise<void> {
  await page.goto('/nakamigos');
  // The splash root is itself the control (role="button", tabIndex 0,
  // self-focusing). Click it rather than pressing Enter: the "OR PRESS ENTER
  // TO SKIP" affordance is desktop-only (`!isMobile` in SplashScreen.jsx), so
  // a keypress path passes on chromium and times out on iPhone and iPad.
  const splash = page.getByRole('button', { name: /tradermigos/i }).first();
  await splash.waitFor({ timeout: SPLASH_MOUNT_TIMEOUT });
  await splash.click();
  await page.locator('main').first().waitFor({ state: 'attached', timeout: SPLASH_MOUNT_TIMEOUT });
  await page.locator('main').first().getByRole('heading', { level: 1 }).waitFor({ timeout: SPLASH_MOUNT_TIMEOUT });
}

/**
 * THE MEASUREMENT BEHIND THE FOUR GECKOTERMINAL ROWS.
 *
 * /terminal, /chart, /copy-trading and /competitions each read
 * api.geckoterminal.com browser-direct and keyless, and nothing stubs it. So
 * their audited DOM depends on whether a third party answered — which is
 * exactly the shape that flakes an EQUALITY assertion, if the ready branch and
 * the degraded branch violate different rules. The obvious fix is a route stub;
 * the honest first step is to find out whether one is needed.
 *
 * It is not. Measured 2026-09-02/03 against the production build under
 * `vite preview` (what playwright.config.ts's webServer serves), on all four
 * device projects, in three branches per route:
 *
 *   ready     — every GeckoTerminal path fulfilled from a real capture, so the
 *               table/plot is actually drawn;
 *   degraded  — `page.route('**api.geckoterminal.com/**', r => r.abort())`,
 *               which really intercepts because `use.serviceWorkers: 'block'`
 *               is set (without it public/sw.js answers first and the stub is
 *               a no-op — see the comment on that setting);
 *   rate-limited — every read fulfilled 429, the state the keyless API really
 *               produces around the fifth rapid read from one address.
 *
 * The block was confirmed per run rather than assumed: request/response/
 * requestfailed counters on the page showed 0 succeeded and N failed under the
 * abort, and the pages rendered their unavailable copy.
 *
 * ALL 60 MEASUREMENTS RETURNED THE EMPTY VIOLATED-RULE SET — 48 of them the
 * four routes × three branches × four projects at the sweep's own timing, plus
 * 12 more for /copy-trading with the tape given 45s to settle first, because
 * that is the one route whose feed can still be in flight when the sweep's
 * quiescence wait gives up. (Unstubbed live reads were measured too, and are
 * described per row below; they are not counted here because their DOM depends
 * on the runner's remaining quota.) The DOM difference
 * is enormous — /copy-trading is a 154-row table of ~31.8k chars when the feed
 * answers and a ~5.5k-char list of per-pool "could not be read" notices when it
 * does not; /competitions 77 rows / ~9.3k vs no table / ~3.4k; /chart an SVG
 * plot plus a 117-row candle table vs neither — and the audit finds nothing
 * either way, because both branches are built from the same landmarks: one h1,
 * captioned tables with scoped headers, labelled controls, named buttons.
 *
 * That is why there is no GeckoTerminal fixture in e2e/fixtures/. One was
 * written (geckoTerminalPools.ts) and deleted unused on 2026-09-03: it would
 * have bought determinism these rows do not need, at the cost of auditing a
 * captured DOM instead of the one the app really renders. Re-measure before
 * adding one back — the reason to add it is a route whose two branches DO
 * differ, not the fact that a network read exists.
 */
const BOTH_BRANCHES_MEASURED =
  'BOTH BRANCHES MEASURED (2026-09-03, all four device projects): with the feed answering, with it ' +
  'aborted at the browser, and with it 429ing, this route violated NOTHING in every case — see the ' +
  'BOTH_BRANCHES_MEASURED block above for the numbers and for why no stub fixture exists. ';

/**
 * Every path App.tsx routes, in App.tsx order.
 *
 * KEEP IN SYNC WITH src/App.tsx. You do not have to remember to: the vitest
 * guard parses App.tsx and fails on any path in one and not the other.
 */
export const ROUTES: readonly RouteSpec[] = [
  // `heading-order` DROPPED 2026-09-05, because the page changed rather than the
  // rule. `/` is now wrapped in <BungalowDoor id={VENUE_ID}>, so it renders the
  // VENUE's identity instead of whatever skin happened to be stored — that is
  // the whole point of that change, and the venue hero's heading order is
  // correct where the skinned one's was not. Measured both ways: with the venue
  // pinned (no reload) and without it (letting the door's one reload settle),
  // the audit returns no violations at all.
  { path: '/', owner: 'pages/HomePage.tsx', gate: null, knownViolations: [] },
  // ── Bungalow doors (2026-08-28 audit) ────────────────────────────────────
  // App.tsx builds these routes by MAPPING over lib/bungalows.ts (`path={path}`
  // JSX expressions), which the sync-guard's `path="…"` regex cannot see — so
  // for months 14 real routes had zero e2e/a11y coverage while the guard's
  // "covers every routed path" stayed green. The guard now derives door paths
  // from the same BUNGALOWS map (see a11yRouteCoverage.test.ts), so this
  // literal list CANNOT drift: add a bungalow and the vitest guard fails until
  // its door is added here. LIVE doors render HomePage under the bungalow's
  // skin; settled-but-not-live doors render BungalowDoorLanding (2026-08-30).
  ...(['toweli', 'bayla', 'pepe', 'qr', 'mfer', 'bnkr', 'drb', 'bobo', 'jbm', 'soy', 'brainlet', 'rizz', 'nb1', 'towelie'] as const).map(
    (slug) => ({
      path: `/${slug}`,
      owner: 'pages/HomePage.tsx',
      gate: null,
      // Measured per door class (re-measured 2026-08-30 when settled doors
      // gained LANDINGS): the two TOWELI-skin doors still render HomePage and
      // carry its heading-order violation; /bayla's token-first hero measures
      // CLEAN; every settled door (and the quiet slot) now renders
      // BungalowDoorLanding, whose plaque h1 orders correctly — CLEAN.
      knownViolations: slug === 'toweli' || slug === 'towelie' ? ['heading-order'] : [],
    }),
  ),
  {
    path: '/farm',
    owner: 'pages/FarmPage.tsx',
    gate: null,
    knownViolations: ['page-has-heading-one'],
    // Connecting REMOVES the missing-h1 finding: the disconnected surface is a
    // wallet gate with no top-level heading, and the page's own h1 only exists
    // in the connected branch. Both lists are kept because a fix must satisfy
    // both, and a reader comparing them can see the split.
    connectedViolations: ['form-field-label'],
  },
  {
    path: '/swap',
    owner: 'pages/TradePage.tsx',
    tabOf: 'TradePage · swap',
    gate: null,
    knownViolations: ['aria-valid-attr-value'],
    connectedViolations: ['aria-valid-attr-value'],
  },
  {
    path: '/liquidity',
    owner: 'pages/TradePage.tsx',
    tabOf: 'TradePage · liquidity',
    gate: null,
    knownViolations: ['aria-valid-attr-value'],
  },
  {
    path: '/solana',
    owner: 'pages/SolanaSwapPage.tsx',
    gate: null,
    why:
      'The surface is no longer gated on a fee account (2026-08-29: isSolanaConfigured was split ' +
      'into isSolanaFeeConfigured / isSolanaSwapLive), so this audits the REAL swap form. Quotes ' +
      'still need the Jupiter proxy, so the form renders without live prices in this suite.',
    // Re-measured 2026-08-30 on the reconciled tree: the un-gated page renders
    // its real <h1> ("Solana Swap", SolanaSwapPage.tsx) during the sweep, so
    // page-has-heading-one no longer fires — the pin follows the measurement.
    knownViolations: [],
  },
  {
    path: '/pools',
    owner: 'pages/PoolsPage.tsx',
    gate: null,
    why:
      'The venue AMM is not deployed (its program id was closed 2026-08-13), so this audits the ' +
      'live-probe status card and the proposed fee sheet — which is what the page actually shows until ' +
      'create_amm_config runs, not a placeholder.',
    knownViolations: [],
  },
  { path: '/curve-launch', owner: 'pages/CurveLaunchPage.tsx',
    tabOf: 'LaunchHubPage · curve-launch', gate: null, knownViolations: [] },
  { path: '/eth-curve', owner: 'pages/EthCurvePage.tsx',
    tabOf: 'LaunchHubPage · eth-curve', gate: null, knownViolations: [] },
  { path: '/eth-curve/:token', owner: 'pages/CurveTokenPage.tsx', gate: null, knownViolations: [] },
  { path: '/launch', owner: 'pages/LaunchPage.tsx',
    tabOf: 'LaunchHubPage · launch', gate: null, knownViolations: ['form-field-label'] },
  {
    path: '/launch/:token',
    owner: 'pages/LaunchTokenPage.tsx',
    gate: null,
    why:
      'Audited with a zero-address token, which is the unknown-token branch. A record for a ' +
      'token this deployment actually launched renders disclosure tables this sweep never sees; ' +
      'covering those needs a launched token on the chain the run points at.',
    knownViolations: [],
  },
  { path: '/launch-simulator', owner: 'pages/LaunchSimulatorPage.tsx',
    tabOf: 'LaunchHubPage · launch-simulator', gate: null, knownViolations: [] },
  {
    path: '/airdrop',
    owner: 'pages/AirdropPage.tsx',
    gate: null,
    why:
      'Audited on the Claim tab with no wallet, no campaign address and no manifest — the ' +
      'no-data branch. The Create tab and every verdict other than "wallet not connected" ' +
      'need input this sweep does not supply; the eligibility verdicts are covered by unit ' +
      'tests instead.',
    knownViolations: [],
  },
  {
    path: '/vesting',
    owner: 'pages/VestingPage.tsx',
    gate: null,
    why:
      'Audited on the Streams tab with no wallet, which is the "connect a wallet" branch. ' +
      'The stream cards and the lock snapshot table need a deployed rail to render at all, ' +
      'and both rails are undeployed on this build.',
    knownViolations: [],
  },
  {
    path: '/start',
    owner: 'components/onboarding/OnboardingFlow.tsx',
    gate: null,
    why:
      'Audited on step 1 with no wallet. The funding step mounts the on-ramp panel, which on ' +
      'an unconfigured build (no partner keys in CI) renders its "not configured" branch — the ' +
      'configured branch with a live partner link is not reachable from this suite.',
    knownViolations: [],
  },
  {
    path: '/zap',
    owner: 'components/zap/ZapPage.tsx',
    gate: null,
    why:
      'Audited with no wallet, which is the composer with its connect prompt: the venue menu renders from ' +
      'constants.ts, the plan and its refusals need an account and a live quote, and the run readout needs a ' +
      'transaction. The interrupted-run states — stopped, unread outcome, inconsistent record — are pure state ' +
      'and are covered by src/lib/zap/machine.test.ts instead.',
    knownViolations: [],
  },
  {
    path: '/yield',
    owner: 'pages/YieldPage.tsx',
    tabOf: 'EarnPage · yield',
    gate: null,
    why:
      'Audited with no wallet. Every rate, NAV, market-price and exit cell is read live from Ethereum ' +
      'mainnet over the keyless public RPC roster — a mock-mode run installs no page.route stubs at all ' +
      '(e2e/fixtures/wallet.ts routes the RPC hosts only when ANVIL_RPC_URL is set), so nothing intercepts ' +
      'those reads and each cell renders either its read value or the sentence saying it could not be read. ' +
      'The route buttons are ENABLED: lib/yield/venues.ts now carries real deposit targets, so the audited ' +
      'surface is a routable comparison table, not the all-disabled page this row used to describe. Each ' +
      'deposit panel stays COLLAPSED — YieldRouterPanel opens one only on click and this sweep never clicks ' +
      '— and the signing branches need a funded wallet; both are covered by src/lib/yield/deposit.test.ts ' +
      'and src/hooks/useYieldDeposit.test.ts instead.',
    knownViolations: [],
  },
  {
    path: '/copy-trading',
    owner: 'pages/CopyTradingPage.tsx',
    tabOf: 'EarnPage · copy-trading',
    gate: null,
    why:
      'Audited with no wallet and no indexer. The island tape reads api.geckoterminal.com live and keyless ' +
      'and nothing stubs it, so the tape read-ledger renders whichever answer the feed gives and the leader ' +
      'board is drawn ONLY when that read lands — a refused or rate-limited read leaves every pool unread ' +
      'and draws no board. A rule id pinned here therefore has to hold for both answers. The venue-router ' +
      'section below is always in its unread state (VITE_INDEXER_URL is unset and the Ponder indexer is ' +
      'hosted nowhere), so its three "could not be read" notices render and none of them draws a table. The ' +
      'follow form and the pasted-Solana-address field are the only live controls — both write to ' +
      'localStorage and need no chain. The sized mirror plans, their refusals and the realised entry-lag ' +
      'figures need a connected wallet and a live feed this sweep cannot guarantee, and are pinned ' +
      'deterministically by src/components/copytrade/TapeLeaderBoard.test.tsx and the lib/copytrade tests. ' +
      BOTH_BRANCHES_MEASURED +
      'This is the widest spread of the four: the settled ready DOM is a 154-row leaderboard of ~31.8k ' +
      'chars, the aborted one a ~5.5k-char list of per-pool outage notices with no table, the 429 one a ' +
      '~6.3k-char list that also names the pools it never asked. A fourth state was measured too, because ' +
      'the sweep can genuinely audit it: the tape reads each pool in turn and can still say "Reading the ' +
      'island tape…" when waitForQuiescence gives up at its 15s cap. That in-flight DOM violates nothing ' +
      'either, which is why this row does not need a longer wait to be stable.',
    knownViolations: [],
  },
  {
    path: '/competitions',
    owner: 'pages/CompetitionsPage.tsx',
    tabOf: 'EarnPage · competitions',
    gate: null,
    why:
      'Two halves with two different answers. The Island Cup reads api.geckoterminal.com live and keyless ' +
      'and nothing stubs it, so it renders either the ranked board or its coverage notice depending on what ' +
      'the feed answers at run time; both states carry the same landmarks (one h1, a captioned table with ' +
      'scoped headers, a labelled select and input, named buttons) and both are pinned deterministically by ' +
      'src/components/competitions/CupBoard.test.tsx. Season 1 is the router season and is always unread ' +
      'here — it is scored from an indexer this build does not configure — so its notice renders and its ' +
      'standings table does not. The season picker and the scoring rules render from lib/competitions and ' +
      'are fully audited either way. ' +
      BOTH_BRANCHES_MEASURED +
      'Here the ready DOM is a 77-row Cup board of ~9.3k chars and the degraded one has no table at all ' +
      '(~3.4k). This route also happens to be the one that proves the concern was worth measuring rather ' +
      'than assuming: a live unstubbed read of its 13 pools rate-limits part-way through on a real run ' +
      '(5 answered, 8 refused), so a THIRD, partial DOM is reachable in CI — 227 rows on the pass that ' +
      'was measured. It violates nothing either.',
    knownViolations: [],
  },
  {
    path: '/trade',
    owner: 'App.tsx',
    gate: 'redirect',
    why: 'The nav labels this Trade; the natural URL resolves instead of 404ing.',
    redirectsTo: '/swap',
    knownViolations: [],
  },
  {
    path: '/dashboard',
    owner: 'pages/DashboardPage.tsx',
    gate: null,
    knownViolations: [],
    // Emptied 2026-08-22 — both declared violations are gone, and the list may
    // only shrink without a reason written here.
    // `aria-valid-attr-value`: the three inactive tabs carried aria-controls
    // pointing at panel ids that do not exist, because the panels live in an
    // AnimatePresence keyed on the active tab so only one is ever mounted. The
    // attribute is now emitted only for the selected tab, where its target is
    // real. `heading-order` had already been fixed upstream of this change and
    // the entry was simply stale, which is the failure mode this table exists
    // to prevent in the other direction.
    connectedViolations: [],
  },
  { path: '/gallery', owner: 'pages/GalleryPage.tsx', gate: null, knownViolations: [] },
  {
    path: '/tokenomics',
    owner: 'pages/TokenomicsPage.tsx',
    tabOf: 'StatsPage · tokenomics',
    gate: null,
    knownViolations: [],
  },
  {
    path: '/history',
    owner: 'pages/ActivityPage.tsx',
    tabOf: 'ActivityPage · history',
    gate: null,
    knownViolations: ['page-has-heading-one'],
  },
  { path: '/lore', owner: 'pages/LearnPage.tsx', tabOf: 'LearnPage · lore', gate: null, knownViolations: [] },
  {
    path: '/learn',
    owner: 'App.tsx',
    gate: 'redirect',
    // Landed on /tokenomics until 2026-09-04, when Tokenomics moved to the Stats
    // host — the alias now points at the first tab LearnPage still owns rather
    // than bouncing out of the host it is named after.
    why: 'Hub alias for the LearnPage default tab.',
    redirectsTo: '/lore',
    knownViolations: [],
  },
  {
    path: '/leaderboard',
    owner: 'pages/ActivityPage.tsx',
    tabOf: 'ActivityPage · points',
    gate: null,
    knownViolations: [],
  },
  { path: '/community', owner: 'pages/CommunityPage.tsx', gate: null, knownViolations: ['aria-valid-attr-value'] },
  {
    path: '/grants',
    owner: 'App.tsx',
    gate: 'redirect',
    why: 'GrantsPage was merged into CommunityPage.',
    redirectsTo: '/community',
    knownViolations: [],
  },
  {
    path: '/bounties',
    owner: 'App.tsx',
    gate: 'redirect',
    why: 'BountyPage was merged into CommunityPage as a section anchor.',
    redirectsTo: '/community',
    knownViolations: [],
  },
  {
    path: '/restake',
    owner: 'App.tsx',
    gate: 'redirect',
    why: 'RestakePage was merged into FarmPage.',
    redirectsTo: '/farm',
    knownViolations: [],
  },
  {
    path: '/premium',
    owner: 'pages/ActivityPage.tsx',
    tabOf: 'ActivityPage · gold',
    gate: null,
    why:
      'PREMIUM_LIVE is false, so ActivityPage self-heals this to the Points tab (F523). The ' +
      'Gold Card surface itself is not reachable until the operator un-gates it.',
    knownViolations: [],
  },
  {
    path: '/bribes',
    owner: 'App.tsx',
    gate: 'redirect',
    why: 'BribesPage was merged into CommunityPage as a section anchor.',
    redirectsTo: '/community',
    knownViolations: [],
  },
  { path: '/admin', owner: 'pages/AdminPage.tsx', gate: null, knownViolations: [] },
  {
    path: '/nft-finance',
    owner: 'pages/LendingPage.tsx',
    gate: null,
    knownViolations: ['aria-valid-attr-value', 'form-field-label', 'heading-order'],
    connectedViolations: ['aria-valid-attr-value', 'form-field-label', 'heading-order'],
  },
  {
    path: '/lending',
    owner: 'App.tsx',
    gate: 'redirect',
    why: 'Renamed surface; the sitemap lists the destination, not this.',
    redirectsTo: '/nft-finance',
    knownViolations: [],
  },
  {
    path: '/launchpad',
    owner: 'App.tsx',
    gate: 'redirect',
    why: 'LaunchpadPage was merged into LendingPage.',
    redirectsTo: '/nft-finance',
    knownViolations: [],
  },
  {
    path: '/nft-amm',
    owner: 'App.tsx',
    gate: 'redirect',
    why: 'NFTAMMPage was merged into LendingPage.',
    redirectsTo: '/nft-finance',
    knownViolations: [],
  },
  {
    path: '/governance',
    owner: 'App.tsx',
    gate: 'redirect',
    why: 'The governance surfaces live on CommunityPage.',
    redirectsTo: '/community',
    knownViolations: [],
  },
  { path: '/security', owner: 'pages/LearnPage.tsx', tabOf: 'LearnPage · security', gate: null, knownViolations: [] },
  { path: '/terms', owner: 'pages/InfoPage.tsx', tabOf: 'InfoPage · terms', gate: null, knownViolations: [] },
  { path: '/privacy', owner: 'pages/InfoPage.tsx', tabOf: 'InfoPage · privacy', gate: null, knownViolations: [] },
  { path: '/risks', owner: 'pages/InfoPage.tsx', tabOf: 'InfoPage · risks', gate: null, knownViolations: [] },
  { path: '/faq', owner: 'pages/LearnPage.tsx', tabOf: 'LearnPage · faq', gate: null, knownViolations: ['aria-valid-attr-value'] },
  {
    path: '/changelog',
    owner: 'pages/ActivityPage.tsx',
    tabOf: 'ActivityPage · changelog',
    gate: null,
    knownViolations: [],
  },
  {
    path: '/contracts',
    owner: 'pages/InfoPage.tsx',
    tabOf: 'InfoPage · contracts',
    gate: null,
    knownViolations: ['aria-valid-attr-value'],
  },
  { path: '/treasury', owner: 'pages/TreasuryPage.tsx', tabOf: 'StatsPage · treasury', gate: null, knownViolations: [] },
  {
    path: '/exposure',
    owner: 'pages/WalletExposurePage.tsx',
    tabOf: 'TrustPage · exposure',
    gate: null,
    knownViolations: [],
    connectedViolations: [],
  },
  { path: '/scan', owner: 'pages/ScannerPage.tsx',
    tabOf: 'TrustPage · scan', gate: null, knownViolations: [] },
  { path: '/deployer', owner: 'pages/DeployerPage.tsx',
    tabOf: 'TrustPage · deployer', gate: null, knownViolations: [] },
  { path: '/trust', owner: 'pages/TrustHubPage.tsx',
    tabOf: 'TrustPage · trust', gate: null, knownViolations: [] },
  {
    path: '/terminal',
    owner: 'pages/TerminalPage.tsx',
    tabOf: 'TrustPage · terminal',
    gate: null,
    why:
      'Audited with no indexer configured, on the default view (Ethereum · new pools). The market feed ' +
      'reads api.geckoterminal.com browser-direct and keyless and nothing stubs it, so the audited surface ' +
      'is whichever answer the live feed gives: the ready market table with its safety column, or ' +
      'MarketFeedStatus reporting a failed or rate-limited read with no table drawn. A rule id pinned here ' +
      'has to hold for both. The tab strips, the safety filter and sort controls, the safety inspector and ' +
      'the quick-buy panel render either way. The "Venue pairs" tab is absent by design (VITE_INDEXER_URL ' +
      'unset, lib/terminal/feedSources.ts) and its PairTable is covered by unit tests. ' +
      BOTH_BRANCHES_MEASURED +
      'Here the ready DOM is a drawn table (3 rows from the captures, 20 from a live read, ~2.1k chars of ' +
      'main) and the degraded DOM has no <table> element at all (~1.6k chars) — and both violate nothing.',
    knownViolations: [],
  },
  {
    path: '/chart',
    owner: 'components/chart/ChartPage.tsx',
    tabOf: 'TrustPage · chart',
    gate: null,
    why:
      'Audited on the registry\'s default market with no wallet. The pool picker is a REGISTRY read, not a ' +
      'network one, so it renders every island market as a 44px pressed/unpressed button under its network ' +
      'heading whether or not any host answers, and the timeframe buttons render beside it. The candles ' +
      'come from api.geckoterminal.com live and keyless with nothing stubbing them, so the plot — and the ' +
      'candles-as-a-table view inside it — is drawn when that read lands, and ChartStatus prints the ' +
      'not-a-zero sentence with no SVG when it does not. A rule id pinned here has to hold for both. The ' +
      'gap columns, the open-bucket marker and the coverage lines are pinned against a stubbed envelope in ' +
      'the unit tests. ' +
      BOTH_BRANCHES_MEASURED +
      'Here the ready DOM adds an <svg> plot AND a 117-row candles-as-a-table view that the degraded DOM ' +
      'does not have at all (~1.97k chars of main vs ~1.29k) — and neither draws a finding.',
    knownViolations: [],
  },
  {
    path: '/alerts',
    owner: 'pages/AlertsPage.tsx',
    tabOf: 'TrustPage · alerts',
    gate: null,
    why:
      'Audited with no wallet, which is now the LIVE branch rather than a gate: the rule store is this ' +
      'browser\'s localStorage, so the builder is enabled and empty, the inbox says nothing is being ' +
      'watched, and the delivery panel reports the channels this build actually has. No network call is ' +
      'made in this state — the evaluation loop parks itself while no rule is stored ' +
      '(hooks/useAlertsEvaluation.ts). The unwritable-storage branch needs a quota failure this sweep ' +
      'cannot produce and is covered by unit tests.',
    knownViolations: [],
  },
  {
    path: '/referrals',
    owner: 'pages/ReferralsPage.tsx',
    tabOf: 'EarnPage · referrals',
    gate: null,
    why:
      'Audited with no wallet, which is the disconnected branch: the earning requirement is stated in full ' +
      '(it is deliberately unconditional — a visitor deciding whether to join is exactly who the staking ' +
      'threshold surprises), and the link, balance and attribution cards each say they have no wallet to ' +
      'read rather than rendering an empty figure. The verdict states (qualified / below-threshold / ' +
      'unknown), the claim states and the code-store states need a connected wallet and a server answer ' +
      'this sweep cannot produce; they are covered by unit tests instead.',
    knownViolations: [],
  },
  {
    path: '/checkout',
    owner: 'pages/CheckoutPage.tsx',
    tabOf: 'EarnPage · checkout',
    gate: null,
    why:
      'Audited on the "Get paid" tab with no wallet, no ?invoice= and no #i= fragment, which is where a ' +
      'merchant arriving cold lands: the invoice form renders with its validation reasons, the ' +
      'settlement-asset select is populated from the verified settle-token table, and "Sign the invoice" is ' +
      'disabled because there is no connected wallet to name as payee. The link states — unreadable, ' +
      'verifying, verified, forged, unverifiable and the two-invoices refusal — each need a real signature, ' +
      'a real RPC or a crafted fragment, and are covered by CheckoutWidget.test, CheckoutPage.test, ' +
      'usePaymentLink.test and lib/commerce/paymentLink.test instead. The two states a stranger CAN force ' +
      'with no wallet at all (#i=garbage, and ?invoice= together with #i=) have their own spec at ' +
      'e2e/checkout-link.spec.ts. The buyer-side surfaces — the pre-sign disclosure, every refusal in ' +
      'buildSettlementPlan, the settle-token re-read and the receipt judge — need a published or signed ' +
      'invoice and a live quote this sweep cannot produce.',
    knownViolations: [],
  },
  {
    path: '/tax',
    owner: 'pages/TaxPage.tsx',
    tabOf: 'StatsPage · tax',
    gate: null,
    why:
      'Audited with no wallet, which is the resting state: the ledger card reads idle, the report renders ' +
      'its INCOMPLETE standing line with the whole requested period as a declared not-read gap, and no ' +
      'disposal or income table. With a wallet the page reads Ethereum mainnet history through ' +
      '/api/etherscan and prices trades from both legs of the same transaction (unit-tested in ' +
      'lib/txHistory, lib/tax/ledger and hooks/useWalletLedger); a keyless proxy renders the operator step ' +
      'and a whole-period explorer-unavailable gap (pages/TaxPage.test.tsx). The pasted lot sheet, the ' +
      'matched lots, the per-method totals and the three exports need input this sweep does not supply.',
    knownViolations: [],
  },
  { path: '/developers', owner: 'pages/DeveloperPage.tsx', gate: null, knownViolations: [] },
  {
    path: '/nakamigos',
    owner: 'nakamigos/App.jsx',
    gate: null,
    why:
      'Renders OUTSIDE AppLayout — own header/footer/background, so no main#main-content; the ' +
      'sweep scopes to its own `main` instead. Only the landing surface is audited here; the ' +
      "sub-app's own tab matrix has its own specs under src/nakamigos/.",
    knownViolations: ['aria-valid-attr-value'],
  },
  {
    path: '/art-studio',
    owner: 'App.tsx',
    gate: 'dev-only',
    why:
      'R002 tree-shakes the studio chunk out of production builds and the route redirects to / ' +
      'there. The e2e suite runs against `vite build` output, so there is nothing to audit — ' +
      'auditing it would report the home page filed under this path.',
    redirectsTo: '/',
    knownViolations: [],
  },
  {
    path: '/bayla-studio',
    owner: 'App.tsx',
    gate: 'unlisted',
    why:
      'ISLAND ORDER 2026-08-31 split this from /art-studio: it is UNLISTED in production rather ' +
      'than redirected — reachable by URL, export-only, with no write path, because the save ' +
      'middleware is a `apply: "serve"` vite plugin that production never serves. It is not ' +
      'audited because it is an internal authoring tool, not a visitor surface; if it is ever ' +
      'linked from a nav it stops being unlisted and must move to the audited bucket.',
    knownViolations: [],
  },
  {
    path: '/bungalow-studio/:bungalowId',
    owner: 'App.tsx',
    gate: 'unlisted',
    why:
      'The generic per-resident leg of the same authoring tool (WO-1): any registry id aims it ' +
      'at that bungalow’s art pool. Unlisted in production alongside /bayla-studio, on the same ' +
      'export-only footing. Only an UNKNOWN bungalow id redirects (App.tsx guards the id against ' +
      'the registry); a known id such as /bungalow-studio/bayla renders, which is why this cannot ' +
      'claim a redirect.',
    knownViolations: [],
  },
  {
    path: '/*',
    owner: 'App.tsx · NotFoundPage',
    gate: null,
    why: 'Navigated as a path no route matches.',
    knownViolations: [],
  },
] as const;

/**
 * Shared chrome — TopNav, footer, skip-link, anything AppLayout renders outside
 * `main`. Audited once, on `/`, with `main` excluded. Without this the footer's
 * heading levels would be reported on all forty routes and each route's own
 * defect would be buried under a duplicate.
 */
export const CHROME_KNOWN_VIOLATIONS: readonly string[] = ['heading-order'];

/** Routes that render a page and are audited. */
export const AUDITABLE_ROUTES = ROUTES.filter((r) => r.gate === null);

/** Routes that only assert where the router lands. */
export const REDIRECT_ROUTES = ROUTES.filter((r) => r.gate === 'redirect');

/** Routes deliberately not audited, each carrying the reason. */
export const GATED_ROUTES = ROUTES.filter((r) => r.gate !== null && r.gate !== 'redirect');

/** Routes audited a second time with the wallet mock connected. */
export const CONNECTED_AUDIT_ROUTES = ROUTES.filter((r) => r.connectedViolations !== undefined);

/** The concrete URL to navigate for a route whose path carries a param or a wildcard. */
export function navigablePath(route: RouteSpec): string {
  if (route.path === '/*') return '/this-path-matches-no-route-a11y-sweep';
  if (route.path === '/launch/:token') return '/launch/0x0000000000000000000000000000000000000000';
  // Any registry id works; in the built app this leg redirects to / anyway.
  if (route.path === '/bungalow-studio/:bungalowId') return '/bungalow-studio/bayla';
  // Zero address: every launcher probe fails -> the page's honest not-found
  // state, which still renders the h1 the sweep asserts.
  if (route.path === '/eth-curve/:token') return '/eth-curve/0x0000000000000000000000000000000000000000';
  return route.path;
}
