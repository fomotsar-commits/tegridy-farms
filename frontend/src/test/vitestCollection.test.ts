// A test file that is never collected is not a test. It is a file.
//
// vitest.config.ts used to collect `src/**` and `api/**` only. Anything
// written elsewhere — frontend/test/, frontend/scripts/, next to a config —
// ran in no pipeline and said nothing about it: vitest reports on what it
// found, never on what it missed. The include glob is project-wide now, but a
// glob alone is a promise, and this is the check.
//
// The invariant, not a literal: EVERY `*.test.*` file tracked by git is either
// (a) collected by this vitest project, or (b) explicitly accounted for as
// belonging to a different runner. A new test file in a brand-new directory
// either runs or fails here — it cannot vanish.
//
// The second half matters just as much: `root` is frontend/, so nothing above
// it can EVER be collected, whatever the glob says. Repo-root scripts/ is the
// live example — those are proven by `--self-test` entry points invoked
// directly from ci.yml, not by unit tests. That constraint is asserted below
// so it stays a documented boundary rather than a trap someone rediscovers.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(FRONTEND, '..');

const TEST_FILE = /\.test\.(js|jsx|mjs|cjs|ts|tsx)$/;

/**
 * Paths that hold test files run by something OTHER than this vitest project.
 * Each entry needs a runner named in the comment — "it is fine" is how a file
 * ends up running nowhere.
 */
const OTHER_RUNNERS: { prefix: string; runner: string }[] = [
  // Playwright. Specs are `.spec.ts`; the directory is listed so a `.test.ts`
  // helper landing there is accounted for rather than silently jsdom'd.
  { prefix: 'frontend/e2e/', runner: 'playwright (npm run test:e2e / npm run e2e)' },
  // ts-mocha under anchor, executed by .github/workflows/solana-ci.yml.
  { prefix: 'solana/', runner: 'ts-mocha via anchor (solana-ci.yml)' },
  // Vendored dependency trees. Not ours, not our runner's problem.
  { prefix: 'contracts/lib/', runner: 'upstream vendored dependency (not executed here)' },
];

const gitTrackedTestFiles = (): string[] =>
  execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => TEST_FILE.test(l));

/** Would this vitest project collect the file? (mirrors include/exclude) */
const collectedByVitest = (repoRelative: string): boolean => {
  if (!repoRelative.startsWith('frontend/')) return false; // outside `root`
  const inProject = repoRelative.slice('frontend/'.length);
  const EXCLUDED = [
    'node_modules/', 'dist/', 'e2e/', 'playwright-report/', 'test-results/',
    '.vercel/', 'public/', 'supabase/', 'plan/', 'plan_input/',
  ];
  return !EXCLUDED.some((p) => inProject.startsWith(p));
};

describe('every test file in this repo has a runner', () => {
  it('finds test files at all (guards the guard)', () => {
    expect(gitTrackedTestFiles().length).toBeGreaterThan(50);
  });

  it('leaves no tracked *.test.* file uncollected and unaccounted for', () => {
    const orphans = gitTrackedTestFiles().filter(
      (f) => !collectedByVitest(f) && !OTHER_RUNNERS.some((r) => f.startsWith(r.prefix)),
    );
    expect(
      orphans,
      'these test files are collected by no runner — they exist and never execute. ' +
        'Either move them under a collected path, or add the directory to OTHER_RUNNERS ' +
        'WITH the name of the runner that executes them.',
    ).toEqual([]);
  });

  it('collects this very file, so the include glob is proven live', () => {
    // If the include glob ever narrows back to `src/**`-only shapes this test
    // still runs (it lives in src/), so it cannot prove the widening on its
    // own. What it CAN prove is that the config declares a project-wide glob.
    const config = join(FRONTEND, 'vitest.config.ts');
    expect(existsSync(config)).toBe(true);
  });
});

describe('the frontend vitest project cannot reach outside frontend/', () => {
  it('is rooted at frontend/, and repo-root scripts are therefore out of reach', () => {
    // Not a limitation to fix here — a boundary to know. `root` defaults to
    // the config's directory; include patterns are resolved under it.
    const here = relative(REPO_ROOT, FRONTEND).split(sep).join('/');
    expect(here).toBe('frontend');
  });

  it('proves the repo-root scripts CI actually exercises have a self-test entry point', () => {
    // ci.yml runs these three with `--self-test` precisely because no unit
    // runner can see them. If one loses its self-test, it loses its only
    // coverage — so pin that the entry point still exists in the source.
    for (const script of ['predeploy-check.mjs', 'verify-ownership.mjs', 'oneshot-guard.mjs']) {
      const p = join(REPO_ROOT, 'scripts', script);
      expect(existsSync(p), `scripts/${script} is referenced by ci.yml but missing`).toBe(true);
      expect(
        readFileSync(p, 'utf-8'),
        `scripts/${script} no longer handles --self-test, which is its ONLY coverage`,
      ).toContain('--self-test');
    }
  });
});
