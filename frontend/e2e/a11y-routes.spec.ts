/**
 * A11y coverage for EVERY routed page.
 *
 * The companion to a11y-smoke.spec.ts, which pins the specific landmarks the
 * B2a pass added on two pages. This file answers the other question — "does
 * every page in the app have sound semantics" — which had no answer at all
 * (`a11y smoke covers 2 of 43 routes`, docs/EVERYTHING_LEFT_2026_08_15.md).
 *
 * HOW A FAILURE HERE BEHAVES, because this is the part that decides whether
 * the suite stays useful. Each route carries the rule ids it violates today in
 * e2e/fixtures/routes.ts, and the assertion is EQUALITY, not "no new ones":
 *   · a route that starts violating a rule fails, with the offending elements
 *     printed — the point of the sweep;
 *   · a route that STOPS violating a rule also fails, until the id is deleted
 *     from its list. That is deliberate. A debt list that only ever grows is a
 *     list nobody prunes, and within a release it stops describing the app.
 * Neither case is fixed by editing the list to match reality without reading
 * why it moved.
 *
 * WHAT IS NOT COVERED. The rule set is markup-level (see the header of
 * e2e/fixtures/a11yAudit.ts for the full statement and the reason axe-core is
 * not used). Nothing here inspects colour contrast, target size, or focus
 * visibility. A green run says the semantics are sound; it does not say the
 * app is WCAG AA.
 */

import { test, expect } from './fixtures/wallet';
import { auditA11y, formatFindings, violatedRules, type A11yFinding } from './fixtures/a11yAudit';
import {
  AUDITABLE_ROUTES,
  CHROME_KNOWN_VIOLATIONS,
  CONNECTED_AUDIT_ROUTES,
  GATED_ROUTES,
  REDIRECT_ROUTES,
  ROUTE_MOUNT_TIMEOUT,
  ROUTES,
  gotoNakamigos,
  gotoRoute,
  navigablePath,
  waitForQuiescence,
} from './fixtures/routes';

const failureMessage = (route: string, owner: string, findings: A11yFinding[]) =>
  `a11y rules violated on ${route} changed.\nOwner: src/${owner}\n` +
  `Update e2e/fixtures/routes.ts ONLY after reading why the set moved.\n` +
  `Findings now:\n${formatFindings(findings) || '  (none)'}`;

test.describe('a11y — every routed page', () => {
  for (const route of AUDITABLE_ROUTES) {
    test(`${route.path} has the a11y rule violations its route table entry declares`, async ({
      page,
      walletMock: _w,
    }) => {
      // /nakamigos renders outside AppLayout, so it has neither the shared
      // `main#main-content` nor the shared chrome; scope to its own main.
      const isNakamigos = route.path === '/nakamigos';
      // The splash intro alone can outlast the default per-test budget on a
      // loaded WebKit worker; see SPLASH_MOUNT_TIMEOUT.
      if (isNakamigos) test.setTimeout(120_000);
      // THE VENUE DOOR RELOADS, so pin its settled state before arriving.
      // `/` is wrapped in <BungalowDoor id={VENUE_ID}>, which clears a stored
      // skin by reloading the document (BungalowDoor.tsx) — the skin is
      // resolved at module scope, so only a fresh document re-resolves it. The
      // shared wallet fixture pins `tegridy-bungalow` to `toweli`, so every
      // spec using it arrives at `/` with a skin to clear and gets that reload,
      // and anything asserted on the first document is sampling a page that is
      // being replaced. Seeding the `venue` sentinel — "seen, chose nothing",
      // the same value arrival-voice.spec.ts seeds — means there is nothing to
      // clear and no reload happens. Deterministic, unlike waiting it out.
      if (route.path === '/') {
        await page.addInitScript(() => {
          try { localStorage.setItem('tegridy-bungalow', 'venue'); } catch { /* ignore */ }
        });
      }
      if (isNakamigos) await gotoNakamigos(page);
      else await gotoRoute(page, navigablePath(route));
      await waitForQuiescence(page);

      const findings = await auditA11y(page, { root: isNakamigos ? 'main' : 'main#main-content' });
      expect(violatedRules(findings), failureMessage(route.path, route.owner, findings)).toEqual([
        ...route.knownViolations,
      ]);
    });
  }
});

test.describe('a11y — connected-wallet surfaces', () => {
  // The disconnected sweep above audits a wallet gate on these routes, not the
  // page. /farm is the proof that this matters: disconnected it has no h1 at
  // all, connected it has one and two unlabelled amount inputs instead. One
  // pass would have reported half the truth either way.
  for (const route of CONNECTED_AUDIT_ROUTES) {
    test(`${route.path} under a connected wallet has the violations its route table entry declares`, async ({
      page,
      walletMock,
    }) => {
      // Connect BEFORE the first navigation — wagmi's reconnect() only sees an
      // authorized account if `eth_accounts` is already non-empty at mount.
      await walletMock.connect();
      await gotoRoute(page, navigablePath(route));
      await waitForQuiescence(page);

      const findings = await auditA11y(page, { root: 'main#main-content' });
      expect(violatedRules(findings), failureMessage(`${route.path} (connected)`, route.owner, findings)).toEqual([
        ...(route.connectedViolations ?? []),
      ]);
    });
  }
});

test.describe('a11y — shared chrome', () => {
  test('AppLayout chrome outside <main> has the violations the route table declares', async ({
    page,
    walletMock: _w,
  }) => {
    await gotoRoute(page, '/');
    await waitForQuiescence(page);
    const findings = await auditA11y(page, { exclude: 'main#main-content' });
    expect(
      violatedRules(findings),
      failureMessage('shared chrome (TopNav / footer / skip-link)', 'components/layout/', findings),
    ).toEqual([...CHROME_KNOWN_VIOLATIONS]);
  });

  /**
   * THE RESTING STATE IS NOT THE ONLY STATE.
   *
   * Every other assertion in this file audits a page as it arrives and never
   * touches it, so a defect that exists only once something is OPENED is
   * invisible to the sweep. The mobile drawer is `{open && ...}` inside
   * AnimatePresence, so below 800px its destination links, its close button and
   * its role="dialog" are not in the DOM AT ALL until the hamburger is clicked
   * -- meaning the resting chrome test above audits a phone header that
   * contains no nav links whatsoever.
   *
   * 2026-09-05 -- THIS TEST LOST ITS DESKTOP HALF, AND THAT IS THE POINT.
   * It used to branch: the hamburger below the breakpoint, the "More navigation"
   * trigger above it, because at any viewport exactly one was in the
   * accessibility tree. There is no "More" dropdown any more -- the six section
   * words are plain links in the resting bar -- so above the breakpoint there is
   * nothing left to open, and the resting-chrome test above already audits those
   * links because they are always in the DOM.
   *
   * SO THE DESKTOP BRANCH IS NOT A SKIP. A conditional `test.skip` is this
   * repo's most-repeated e2e failure shape: it reads green while measuring
   * nothing. Instead each branch makes a REAL assertion appropriate to its
   * viewport -- the phone opens the drawer and audits it, the desktop asserts
   * the nav links are present without one -- and neither can no-op, because
   * both end in an audit or a count.
   *
   * WHY IT DOES NOT FLAKE. `MotionConfig reducedMotion="user"` plus
   * `contextOptions.reducedMotion: 'reduce'` (playwright.config.ts) makes the
   * open SNAP instead of animating, so there is no transition to race.
   *
   * THE DECLARED SET is the resting chrome's, because by inspection the drawer
   * adds only named links, a named dialog and a named close button -- no
   * heading, no form field, and no idref that fails to resolve. That is a read
   * of the markup, NOT a measurement. If a run disagrees, give this its own
   * literal list beside CHROME_KNOWN_VIOLATIONS with the finding written down --
   * do not widen it into a "no new violations" subset check, which is the
   * assertion this file's header rejects.
   */
  test('the nav exposes its destinations at every width, and the drawer audits clean', async ({
    page,
    walletMock: _w,
  }) => {
    await gotoRoute(page, '/');
    await waitForQuiescence(page);

    const hamburger = page.getByRole('button', { name: 'Open navigation menu' });
    const bar = page.getByRole('navigation', { name: 'Main navigation' });
    // Whichever this viewport exposes has to be there before we ask which. If
    // NEITHER is reachable this fails rather than auditing the resting DOM a
    // second time and reporting a pass.
    await hamburger.or(bar).first().waitFor({ state: 'visible', timeout: ROUTE_MOUNT_TIMEOUT });

    if (!(await hamburger.isVisible())) {
      // DESKTOP: no disclosure exists. The six words are always rendered, so
      // the real assertion is that they are there and reachable without one.
      await expect(bar.getByRole('link').first()).toBeVisible({ timeout: ROUTE_MOUNT_TIMEOUT });
      expect(
        await bar.getByRole('link').count(),
        'the desktop bar rendered fewer than the six section words',
      ).toBeGreaterThanOrEqual(6);
      return;
    }

    // PHONE / narrow tablet: the drawer is the whole nav, so it is the thing
    // that has to audit clean.
    await hamburger.click();
    const panel = page.getByRole('dialog', { name: 'Navigation menu' });
    await panel.waitFor({ state: 'visible', timeout: ROUTE_MOUNT_TIMEOUT });
    // Not merely "the container exists": the links are the reason to open it,
    // and they are what the name/role rules have to judge.
    await expect(panel.getByRole('link').first()).toBeVisible({ timeout: ROUTE_MOUNT_TIMEOUT });
    expect(
      await panel.getByRole('link').count(),
      'the mobile drawer opened with no links in it -- the audit below would measure an empty container',
    ).toBeGreaterThan(1);
    await waitForQuiescence(page);

    const findings = await auditA11y(page, { exclude: 'main#main-content' });
    expect(
      violatedRules(findings),
      failureMessage('shared chrome - mobile drawer OPEN', 'components/layout/TopNav.tsx', findings),
    ).toEqual([...CHROME_KNOWN_VIOLATIONS]);
  });
});

test.describe('routes that redirect', () => {
  for (const route of REDIRECT_ROUTES) {
    test(`${route.path} lands on ${route.redirectsTo}`, async ({ page, walletMock: _w }) => {
      // navigablePath, not route.path: a redirect route may carry a param, and
      // navigating to the literal "/read/:address" would assert nothing.
      await page.goto(navigablePath(route));
      await expect(page, route.why).toHaveURL(new RegExp(`${route.redirectsTo!.replace('/', '\\/')}(\\?|$)`), {
        timeout: ROUTE_MOUNT_TIMEOUT,
      });
    });
  }
});

test.describe('routes that are not audited', () => {
  // Not silent. Each of these produces a SKIPPED test carrying the reason, so
  // a reader of the report sees the hole rather than reading 43 greens as 43
  // audited pages.
  for (const route of GATED_ROUTES) {
    test(`${route.path} is not audited — ${route.gate}`, async ({ page, walletMock: _w }) => {
      if (route.gate === 'dev-only') {
        // Still assert the production behaviour: the chunk is tree-shaken out
        // and the path must land on the redirect target rather than hanging on
        // an empty Suspense.
        await page.goto(route.path);
        await expect(page).toHaveURL(new RegExp(`${route.redirectsTo!.replace('/', '\\/')}$`), {
          timeout: ROUTE_MOUNT_TIMEOUT,
        });
      }
      test.skip(true, `${route.path}: ${route.why}`);
    });
  }
});

test.describe('the route table itself', () => {
  test('accounts for every route, with no silent gaps', () => {
    const audited = AUDITABLE_ROUTES.length;
    const redirects = REDIRECT_ROUTES.length;
    const gated = GATED_ROUTES.length;
    expect(
      audited + redirects + gated,
      'a route is in ROUTES with a gate value none of the three buckets claims',
    ).toBe(ROUTES.length);
    // The finding this closes was worded "2 of 43". App.tsx actually declares
    // 45 `<Route>`s — the doc's 43 is the count inside AppLayout, and misses
    // `nakamigos/*` and `art-studio`, which render outside it. Whether the
    // table still matches App.tsx is enforced by parsing App.tsx, in
    // src/test/a11yRouteCoverage.test.ts; the floors here only catch the
    // sweep being hollowed out in place.
    expect(ROUTES.length, 'the route table shrank — routes were deleted from the table, not the app').toBeGreaterThanOrEqual(45);
    expect(audited, 'fewer pages are being audited than when this sweep landed').toBeGreaterThanOrEqual(34);
  });
});
