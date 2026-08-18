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
});

test.describe('routes that redirect', () => {
  for (const route of REDIRECT_ROUTES) {
    test(`${route.path} lands on ${route.redirectsTo}`, async ({ page, walletMock: _w }) => {
      await page.goto(route.path);
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
