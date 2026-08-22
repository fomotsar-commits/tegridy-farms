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
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
  // The Solana indexing leg. Same vitest binary as this project — it is
  // installed here and nowhere else — but rooted at the service, because
  // `root` is frontend/ and no include glob can reach above it:
  //   npx vitest run --root ../indexer-solana --environment node
  // ci.yml runs exactly that in the "Solana indexer unit tests" step.
  { prefix: 'indexer-solana/', runner: "vitest --root ../indexer-solana (ci.yml 'Solana indexer unit tests')" },
  // The arb-linkage monitor and its pause consumer. Plain `node --test`, not
  // vitest: they are operational scripts that must run on a bare runner with no
  // frontend toolchain. TWO workflows run them, and both entries are load-bearing:
  //   ci.yml — the PR gate. This is the one that makes a break fail the PR that
  //     caused it. It was missing until 2026-08-21, and its absence was invisible
  //     because the monitor below satisfied the "has a runner" claim on its own.
  //   arb-linkage-monitor.yml:163 — the scheduled monitor, which re-runs them in
  //     the same job as the probe, deliberately AFTER the reporting steps so a
  //     regressed assertion reddens the run without suppressing an alert. Kept
  //     even though ci.yml covers the same files: a verdict about live money
  //     produced by an unverified rule is worth less than no verdict.
  // The cron cannot substitute for the gate — see the pull_request assertion below.
  { prefix: 'contracts/monitoring/', runner: 'node --test (ci.yml PR gate + arb-linkage-monitor.yml cron)' },
  { prefix: 'scripts/monitoring/', runner: 'node --test (ci.yml PR gate + arb-linkage-monitor.yml cron)' },
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

  it('proves the node --test entries run on the PR gate, not only on a cron', () => {
    // An OTHER_RUNNERS entry is a CLAIM that something else executes these
    // files, and an unverified claim is how a test file goes quiet while
    // still looking accounted for — the precise failure this guard exists to
    // prevent, relocated one level up. Two things have to hold.
    //
    // FIRST, a workflow must invoke each file BY NAME. A glob would not survive
    // a rename, and neither would the coverage.
    //
    // SECOND — and this is what the original version of this test missed — at
    // least one workflow naming it must fire on `pull_request`. Until 2026-08-21
    // the only runner was arb-linkage-monitor.yml, which is `schedule` +
    // `workflow_dispatch` only. That satisfies "has a runner" while leaving the
    // PR that breaks the rule green, and GitHub disables schedules outright in a
    // repository idle for 60 days, at which point the coverage lapses with
    // nothing going red. Coverage that can expire quietly is the same ghost
    // condition this file exists to catch, wearing a workflow for a costume.
    const monitoring = gitTrackedTestFiles().filter(
      (f) => f.startsWith('contracts/monitoring/') || f.startsWith('scripts/monitoring/'),
    );
    expect(
      monitoring.length,
      'no monitoring test files matched — this assertion has drifted off its subject and is proving nothing',
    ).toBeGreaterThan(0);

    const dir = join(REPO_ROOT, '.github', 'workflows');
    const workflows = readdirSync(dir)
      .filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'))
      .map((n) => ({ name: n, src: readFileSync(join(dir, n), 'utf-8') }));

    // `on:` at column 0, then a two-space `pull_request:` key under it. Matching
    // the bare word anywhere would be satisfied by the word in a comment.
    const firesOnPullRequest = (src: string): boolean =>
      /^on:/m.test(src) && /^ {2}pull_request:/m.test(src);

    for (const f of monitoring) {
      const named = workflows.filter((w) => w.src.includes('node --test') && w.src.includes(f));
      expect(
        named.map((w) => w.name),
        `${f} is accounted for in OTHER_RUNNERS but no workflow invokes it by name`,
      ).not.toEqual([]);
      expect(
        named.some((w) => firesOnPullRequest(w.src)),
        `${f} is named only by workflows that never fire on a pull request ` +
          `(${named.map((w) => w.name).join(', ')}) — a break in it merges green and surfaces ` +
          'later on a cron, if the schedule is even still enabled',
      ).toBe(true);
    }
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
