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
 * Three of the pages (ActivityPage / LearnPage / InfoPage) host what used to be
 * separate pages as TABS, and the tab is selected from the URL path — see
 * `tabFromPath` in each. So a per-path sweep does cover the tabs: /security is
 * the LearnPage security tab, /contracts is the InfoPage contracts tab. The
 * `tabOf` field records which host renders each path, so a reader of a failure
 * knows which component file to open.
 */

import type { Page } from '@playwright/test';

/** Why a route cannot be asserted the way the others are. Never left implicit. */
export type RouteGate =
  /** Renders its own content with no wallet and no deployed contract. */
  | null
  /** Not a page — asserts a redirect target instead. */
  | 'redirect'
  /** Only exists in a dev build; production redirects to `/`. */
  | 'dev-only';

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
 * Every path App.tsx routes, in App.tsx order.
 *
 * KEEP IN SYNC WITH src/App.tsx. You do not have to remember to: the vitest
 * guard parses App.tsx and fails on any path in one and not the other.
 */
export const ROUTES: readonly RouteSpec[] = [
  { path: '/', owner: 'pages/HomePage.tsx', gate: null, knownViolations: ['heading-order'] },
  // ── Bungalow doors (2026-08-28 audit) ────────────────────────────────────
  // App.tsx builds these routes by MAPPING over lib/bungalows.ts (`path={path}`
  // JSX expressions), which the sync-guard's `path="…"` regex cannot see — so
  // for months 14 real routes had zero e2e/a11y coverage while the guard's
  // "covers every routed path" stayed green. The guard now derives door paths
  // from the same BUNGALOWS map (see a11yRouteCoverage.test.ts), so this
  // literal list CANNOT drift: add a bungalow and the vitest guard fails until
  // its door is added here. Every door renders HomePage under a BungalowDoor
  // skin, hence HomePage's known violation set.
  ...(['toweli', 'bayla', 'pepe', 'qr', 'mfer', 'bnkr', 'drb', 'bobo', 'jbm', 'soy', 'brainlet', 'rizz', 'nb1', 'towelie'] as const).map(
    (slug) => ({
      path: `/${slug}`,
      owner: 'pages/HomePage.tsx',
      gate: null,
      // CI-measured 2026-08-28 on the sweep's first pass over these routes:
      // the 13 default-skin doors present HomePage's heading-order violation;
      // /bayla's token-first identity hero orders its headings correctly and
      // measures CLEAN — the exact-assertion refused the over-declared pin.
      knownViolations: slug === 'bayla' ? [] : ['heading-order'],
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
      'isSolanaConfigured() is false in a built e2e run, so this audits the FeatureNotDeployed ' +
      'gate, not the Jupiter swap surface behind it. The live surface needs a configured Solana ' +
      'RPC + program and is not reachable from this suite.',
    knownViolations: ['page-has-heading-one'],
  },
  { path: '/curve-launch', owner: 'pages/CurveLaunchPage.tsx', gate: null, knownViolations: [] },
  { path: '/eth-curve', owner: 'pages/EthCurvePage.tsx', gate: null, knownViolations: [] },
  { path: '/eth-curve/:token', owner: 'pages/CurveTokenPage.tsx', gate: null, knownViolations: [] },
  { path: '/launch', owner: 'pages/LaunchPage.tsx', gate: null, knownViolations: ['form-field-label'] },
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
  { path: '/launch-simulator', owner: 'pages/LaunchSimulatorPage.tsx', gate: null, knownViolations: [] },
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
    gate: null,
    why:
      'Audited with no yield feed configured, which is this build\'s resting state: every rate, peg and ' +
      'exit-liquidity cell renders its unavailable branch and the route controls are disabled because no ' +
      'deposit address is wired. The read/stale branches need a hosted feed this sweep cannot produce and ' +
      'are covered by unit tests instead.',
    knownViolations: [],
  },
  {
    path: '/copy-trading',
    owner: 'pages/CopyTradingPage.tsx',
    gate: null,
    why:
      'Audited with no indexer configured and no wallet, which is this build\'s resting state: all three ' +
      'panels render their "could not be read" notice and NO table is drawn — the follow board, the mirror ' +
      'queue and the personal fill history are each absent rather than empty. The follow form is the only ' +
      'live control (it writes to localStorage and needs no chain). The ready/backfilling boards, the mirror ' +
      'plans and their refusals, and the realised entry-lag figures need a hosted indexer this sweep cannot ' +
      'produce and are covered by unit tests instead.',
    knownViolations: [],
  },
  {
    path: '/competitions',
    owner: 'pages/CompetitionsPage.tsx',
    gate: null,
    why:
      'Audited with no indexer configured, so the standings notice is the page and the table is not rendered ' +
      'at all. The season picker and the scoring rules render from lib/competitions and are fully audited; ' +
      'the ranked board, the wash-strike counts and the truncation banner need a hosted indexer this sweep ' +
      'cannot produce and are covered by unit tests instead.',
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
    owner: 'pages/LearnPage.tsx',
    tabOf: 'LearnPage · tokenomics',
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
    why: 'Hub alias for the LearnPage default tab.',
    redirectsTo: '/tokenomics',
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
  { path: '/treasury', owner: 'pages/InfoPage.tsx', tabOf: 'InfoPage · treasury', gate: null, knownViolations: [] },
  {
    path: '/exposure',
    owner: 'pages/WalletExposurePage.tsx',
    gate: null,
    knownViolations: [],
    connectedViolations: [],
  },
  { path: '/scan', owner: 'pages/ScannerPage.tsx', gate: null, knownViolations: [] },
  { path: '/deployer', owner: 'pages/DeployerPage.tsx', gate: null, knownViolations: [] },
  { path: '/trust', owner: 'pages/TrustHubPage.tsx', gate: null, knownViolations: [] },
  {
    path: '/terminal',
    owner: 'pages/TerminalPage.tsx',
    gate: null,
    why:
      'Audited with no indexer configured, which is this build\'s only reachable state: the feed ' +
      'banner is the page and the table is not rendered at all. The ready/backfilling surfaces ' +
      'need a hosted indexer this sweep cannot produce and are covered by unit tests.',
    knownViolations: [],
  },
  {
    path: '/chart',
    owner: 'components/chart/ChartPage.tsx',
    gate: null,
    why:
      'Audited with no indexer configured, which is this build\'s only reachable state: the pool ' +
      'picker and the chart status banner both say they could not read, and no SVG plot is ' +
      'rendered at all. The ready surface (candles, gap columns, coverage lines) needs a hosted ' +
      'indexer this sweep cannot produce and is covered by unit tests.',
    knownViolations: [],
  },
  {
    path: '/alerts',
    owner: 'pages/AlertsPage.tsx',
    gate: null,
    why:
      'Audited with no wallet, which is the signed-out branch: the builder is disabled with its ' +
      'reason, the inbox says nothing is being watched, and the delivery panel reports the ' +
      'channels this build actually has. The store-side states (schema-missing / not-configured / ' +
      'unreachable) need a server answer this sweep cannot produce and are covered by unit tests.',
    knownViolations: [],
  },
  {
    path: '/referrals',
    owner: 'pages/ReferralsPage.tsx',
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
    gate: null,
    why:
      'Audited on the "Get paid" tab with no wallet and no invoice on the URL, which is where a merchant ' +
      'arriving cold lands: the publish form renders with its validation reasons and the callback ' +
      'no-retry notice, and the publish button is disabled because there is no signed-in wallet to name as ' +
      'payee. The buyer-side surfaces — the pre-sign disclosure, every refusal in buildSettlementPlan, and ' +
      'the store\'s schema-missing / not-found branches — need a published invoice and a live quote this ' +
      'sweep cannot produce and are covered by unit tests instead.',
    knownViolations: [],
  },
  {
    path: '/tax',
    owner: 'pages/TaxPage.tsx',
    gate: null,
    why:
      'Audited with no indexer configured and no wallet, which is this build\'s resting state: the report ' +
      'renders its INCOMPLETE standing line, the whole requested period as a single coverage gap, and no ' +
      'disposal or income table at all. The priced surfaces (matched lots, per-method totals, the three ' +
      'exports) need either a hosted indexer or a pasted lot sheet, and both are covered by unit tests.',
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
  // Zero address: every launcher probe fails -> the page's honest not-found
  // state, which still renders the h1 the sweep asserts.
  if (route.path === '/eth-curve/:token') return '/eth-curve/0x0000000000000000000000000000000000000000';
  return route.path;
}
