// The a11y route sweep, made impossible to quietly outgrow.
//
// e2e/a11y-routes.spec.ts audits one page per entry in e2e/fixtures/routes.ts.
// That closes `a11y smoke covers 2 of 43 routes` exactly once: the moment
// someone adds a 44th <Route> to src/App.tsx, the sweep is back to covering
// "all the routes it knows about", which is the same failure with a better
// number. So the route table is not allowed to be a copy — it is checked
// against App.tsx here, by parsing App.tsx.
//
// This guard is a sibling of playwrightDeviceMatrix.test.ts, which pins the
// device projects the same way and for the same reason.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BUNGALOWS } from '../lib/bungalows';
import { A11Y_RULES } from '../../e2e/fixtures/a11yAudit';
import {
  AUDITABLE_ROUTES,
  CHROME_KNOWN_VIOLATIONS,
  CONNECTED_AUDIT_ROUTES,
  GATED_ROUTES,
  REDIRECT_ROUTES,
  ROUTES,
  navigablePath,
} from '../../e2e/fixtures/routes';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const APP_PATH = join(FRONTEND, 'src', 'App.tsx');
const appSource = () => readFileSync(APP_PATH, 'utf-8');

/**
 * Every path src/App.tsx routes, normalized to the leading-slash form the
 * route table uses. `<Route index>` is `/`; a nested wildcard like
 * `nakamigos/*` is the sub-app's own mount point and is recorded as its base.
 */
function routedPathsFromApp(): string[] {
  const src = appSource();
  const paths = new Set<string>();
  if (/<Route\s+index\b/.test(src)) paths.add('/');
  for (const m of src.matchAll(/<Route\s+path="([^"]+)"/g)) {
    const raw = m[1];
    if (raw === '*') { paths.add('/*'); continue; }
    // `nakamigos/*` — the star belongs to the sub-app's own router, not to a
    // path this sweep can enumerate.
    paths.add('/' + raw.replace(/\/\*$/, ''));
  }
  // 2026-08-28: App.tsx ALSO builds routes by mapping over BUNGALOWS with
  // `path={path}` JSX expressions — invisible to the regex above, which let 14
  // real routes live with zero coverage while this guard passed. Derive them
  // from the SAME map App.tsx maps over, gated on the block still existing so
  // the derivation can never outlive the code (if the block is rewritten and
  // the gate stops matching, the doors drop out of this set and the equality
  // test fails LOUDLY toward the fixture's extras — never silently).
  if (/BUNGALOWS\.map\(\(b\) => \(\{ path: b\.id/.test(src)) {
    for (const b of BUNGALOWS) paths.add('/' + b.id);
    paths.add('/towelie'); // the alias spelling App.tsx appends to the map
  }
  return [...paths].sort();
}

describe('the a11y route table matches the app', () => {
  it('parses App.tsx at all (guards the guard)', () => {
    const found = routedPathsFromApp();
    expect(found.length, 'no <Route path=…> parsed out of src/App.tsx — the parser drifted, not the app').toBeGreaterThan(
      20,
    );
    expect(found).toContain('/');
    expect(found).toContain('/swap');
    // The expression-built bungalow doors must be derivable — if this fails,
    // App.tsx's BUNGALOWS.map block changed shape and the gate in
    // routedPathsFromApp needs its regex updated IN THE SAME CHANGE.
    expect(appSource()).toMatch(/BUNGALOWS\.map\(\(b\) => \(\{ path: b\.id/);
    expect(found).toContain('/toweli');
    expect(found).toContain('/towelie');
  });

  it('covers every routed path, and invents none', () => {
    expect(
      ROUTES.map((r) => r.path).sort(),
      'e2e/fixtures/routes.ts and src/App.tsx disagree. A path only in App.tsx is a page with no ' +
        'a11y coverage; a path only in the table is a test navigating somewhere that no longer exists.',
    ).toEqual(routedPathsFromApp());
  });

  it('lists each path exactly once', () => {
    const paths = ROUTES.map((r) => r.path);
    expect(new Set(paths).size, `duplicate path in the route table: ${paths.join(', ')}`).toBe(paths.length);
  });
});

describe('every route is accounted for, none silently', () => {
  it('splits cleanly into audited / redirect / gated', () => {
    expect(AUDITABLE_ROUTES.length + REDIRECT_ROUTES.length + GATED_ROUTES.length).toBe(ROUTES.length);
  });

  it('gives every non-audited route a written reason', () => {
    for (const route of [...REDIRECT_ROUTES, ...GATED_ROUTES]) {
      expect(route.why?.trim(), `${route.path} is not audited and says nothing about why`).toBeTruthy();
      expect(route.why!.length, `${route.path}'s reason is too short to be a reason`).toBeGreaterThan(20);
    }
  });

  it('gives every redirect a destination that App.tsx actually declares', () => {
    const src = appSource();
    for (const route of REDIRECT_ROUTES) {
      expect(route.redirectsTo, `${route.path} is a redirect with no destination`).toBeTruthy();
      // `<Navigate to="/community?section=bribes" replace />` — compare on the
      // path, the query is the section anchor.
      const targets = [...src.matchAll(/<Navigate\s+to="([^"]+)"/g)].map((m) => m[1].split('?')[0]);
      expect(
        targets,
        `${route.path} claims it lands on ${route.redirectsTo}, but App.tsx declares no <Navigate> there`,
      ).toContain(route.redirectsTo);
    }
  });

  it('names an owner file that exists, for every audited route', () => {
    for (const route of AUDITABLE_ROUTES) {
      // `owner` may carry a component suffix ("App.tsx · NotFoundPage") — the
      // path is the part before it, and it is the part a reader opens.
      const file = route.owner.split('·')[0].trim();
      expect(
        existsSync(join(FRONTEND, 'src', file)),
        `${route.path} points at src/${file}, which does not exist — a rename left the sweep ` +
          'naming a file nobody can open',
      ).toBe(true);
    }
  });
});

describe('the known-violation lists stay readable', () => {
  const lists: [string, readonly string[]][] = [
    ...ROUTES.map((r) => [`${r.path} knownViolations`, r.knownViolations] as [string, readonly string[]]),
    ...CONNECTED_AUDIT_ROUTES.map(
      (r) => [`${r.path} connectedViolations`, r.connectedViolations!] as [string, readonly string[]],
    ),
    ['shared chrome', CHROME_KNOWN_VIOLATIONS],
  ];

  it('names only rules the audit can actually emit', () => {
    for (const [label, list] of lists) {
      for (const rule of list) {
        expect(
          A11Y_RULES as readonly string[],
          `${label} names "${rule}", which no rule in e2e/fixtures/a11yAudit.ts emits — the ` +
            'entry can never be satisfied and never be cleared',
        ).toContain(rule);
      }
    }
  });

  it('is sorted and duplicate-free, because the sweep compares sorted sets', () => {
    for (const [label, list] of lists) {
      expect([...list], `${label} is not sorted — the equality assertion in the sweep will never match`).toEqual(
        [...new Set(list)].sort(),
      );
    }
  });

  it('only declares a connected pass for routes that are audited at all', () => {
    for (const route of CONNECTED_AUDIT_ROUTES) {
      expect(route.gate, `${route.path} declares a connected-wallet audit but is not an audited route`).toBeNull();
    }
  });
});

describe('parameterised paths resolve to something navigable', () => {
  it('substitutes every :param and wildcard', () => {
    for (const route of ROUTES) {
      const url = navigablePath(route);
      expect(url, `${route.path} still contains a route pattern after substitution: ${url}`).not.toMatch(/[:*]/);
      expect(url.startsWith('/'), `${route.path} produced a non-absolute URL: ${url}`).toBe(true);
    }
  });
});
