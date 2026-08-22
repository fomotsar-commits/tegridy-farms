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
// live example — those are proven by `--self-test` entry points and `node --test`
// steps invoked directly from ci.yml, not by unit tests. That constraint is
// asserted below so it stays a documented boundary rather than a trap someone
// rediscovers.
//
// One more level up, added after the accounting was found to be technically true
// and practically empty: naming a runner is not coverage unless that runner runs
// when a change is made. contracts/monitoring/ and scripts/monitoring/ were
// accounted for by a workflow with no `pull_request` trigger, so 48 tests gave a
// verdict on zero pull requests while every check here stayed green. Every
// workflow cited as a runner is now asserted to have a pull-request trigger.

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
 *
 * Cite the runner's workflow FILENAME in the `runner` string wherever CI is what
 * executes it. That is not decoration: the checks below parse those filenames
 * back out and assert the workflow exists AND has a pull-request trigger. An
 * entry that deliberately has no CI runner must say `not executed here`.
 */
const OTHER_RUNNERS: { prefix: string; runner: string }[] = [
  // Playwright. Specs are `.spec.ts`; the directory is listed so a `.test.ts`
  // helper landing there is accounted for rather than silently jsdom'd.
  // ci.yml runs it in the "Run E2E Tests" step (and the money paths again in
  // "Money-path E2E against an Anvil mainnet fork").
  { prefix: 'frontend/e2e/', runner: "playwright (ci.yml 'Run E2E Tests', npm run e2e)" },
  // ts-mocha under anchor, executed by .github/workflows/solana-ci.yml.
  { prefix: 'solana/', runner: 'ts-mocha via anchor (solana-ci.yml)' },
  // The Solana indexing leg. Same vitest binary as this project — it is
  // installed here and nowhere else — but rooted at the service, because
  // `root` is frontend/ and no include glob can reach above it:
  //   npx vitest run --root ../indexer-solana --environment node
  // ci.yml runs exactly that in the "Solana indexer unit tests" step.
  { prefix: 'indexer-solana/', runner: "vitest --root ../indexer-solana (ci.yml 'Solana indexer unit tests')" },
  // The Telegram bot. Same arrangement and the same reason as indexer-solana: a
  // long-running service outside frontend/, so no include glob here can reach it.
  //   npx vitest run --root ../bot --environment node
  // ci.yml runs exactly that in the "Telegram bot unit tests" step. Note that the
  // bot's NON-CUSTODIAL guard deliberately does NOT live there — it is
  // api/__tests__/bot-noncustodial.test.js, collected by this project, so a change
  // to the API or the migration cannot skip it.
  { prefix: 'bot/', runner: "vitest --root ../bot (ci.yml 'Telegram bot unit tests')" },
  // The arb-linkage monitor and its pause consumer. Plain `node --test`, not
  // vitest: they are operational scripts that must run on a bare runner with no
  // frontend toolchain.
  //   node --test contracts/monitoring/lib/arbLinkage.test.mjs scripts/monitoring/lib/pausePlan.test.mjs
  // ci.yml runs exactly that in the "Monitoring rule unit tests" step. The tests
  // are pure — no chain read, no secrets — so they cost a PR nothing.
  //
  // arb-linkage-monitor.yml runs the SAME command on its */15 cron, after the
  // reporting steps, so a live verdict is never produced by an unverified rule.
  // It is deliberately NOT the runner cited here: it triggers on `schedule` +
  // `workflow_dispatch` only, and GitHub disables schedules after 60 days of
  // repository inactivity. A runner that can switch itself off, in a workflow no
  // pull request ever reaches, is the exact hole these entries used to have.
  { prefix: 'contracts/monitoring/', runner: "node --test (ci.yml 'Monitoring rule unit tests')" },
  { prefix: 'scripts/monitoring/', runner: "node --test (ci.yml 'Monitoring rule unit tests')" },
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

/** Workflow filenames cited inside a runner string, e.g. "…(ci.yml 'Unit Tests')". */
const workflowsCitedIn = (runner: string): string[] => runner.match(/[\w.-]+\.ya?ml/g) ?? [];

/**
 * Does this workflow run on pull requests?
 *
 * A deliberately narrow scan rather than a YAML dependency — frontend/ has no
 * yaml parser and adding one to prove a two-line fact is a poor trade. Find the
 * top-level `on:` key, then look for a `pull_request` key nested directly under
 * it. Blank and comment-only lines never end the block; the next column-0 key
 * does. `pull_request_target` deliberately does NOT count: it runs with base-repo
 * write scope and is not something this guard should quietly bless.
 */
const runsOnPullRequest = (yaml: string): boolean => {
  let inOn = false;
  for (const raw of yaml.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!inOn) {
      const m = /^["']?on["']?:\s*(.*)$/.exec(line);
      if (!m) continue;
      // Inline forms: `on: pull_request`, `on: [push, pull_request]`
      if (m[1].trim()) return /(?:^|[[,\s])pull_request(?:$|[\],\s])/.test(m[1]);
      inOn = true;
      continue;
    }
    if (/^\S/.test(line)) return false; // a new top-level key: the on: block ended
    if (/^\s{1,4}pull_request\s*:/.test(line)) return true;
  }
  return false;
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

  it('proves the node --test entries actually name files their workflow runs', () => {
    // An OTHER_RUNNERS entry is a CLAIM that something else executes these
    // files, and an unverified claim is how a test file goes quiet while
    // still looking accounted for — the precise failure this guard exists to
    // prevent, relocated one level up. The workflow must invoke each file by
    // name; a glob would not survive a rename, and neither would the coverage.
    //
    // The workflow is read back OUT of the runner string rather than hardcoded,
    // so moving the invocation and updating the entry keeps this honest instead
    // of pointing the check at a file that no longer runs anything.
    const entries = OTHER_RUNNERS.filter((r) => r.runner.startsWith('node --test'));
    expect(entries.length, 'no entry claims node --test any more — did a prefix lose its runner?')
      .toBeGreaterThan(0);
    const tracked = gitTrackedTestFiles();
    for (const entry of entries) {
      const cited = workflowsCitedIn(entry.runner);
      expect(cited.length, `${entry.prefix} claims node --test but cites no workflow`).toBeGreaterThan(0);
      const files = tracked.filter((f) => f.startsWith(entry.prefix));
      expect(files.length, `${entry.prefix} is accounted for but holds no tracked test files`)
        .toBeGreaterThan(0);
      for (const name of cited) {
        const wf = join(REPO_ROOT, '.github', 'workflows', name);
        expect(existsSync(wf), `${name} is cited as a runner but missing`).toBe(true);
        const src = readFileSync(wf, 'utf-8');
        expect(src, `${name} no longer invokes node --test`).toContain('node --test');
        for (const f of files) {
          expect(src, `${f} is accounted for by ${name} but not named in it`).toContain(f);
        }
      }
    }
  });

  it('proves every workflow cited as a runner actually runs on pull requests', () => {
    // THE HOLE THIS CLOSES, in full.
    //
    // contracts/monitoring/ and scripts/monitoring/ were accounted for by
    // arb-linkage-monitor.yml, whose triggers are `schedule` and
    // `workflow_dispatch` — no pull_request, no push. The check above passed the
    // whole time and was telling the truth: the files WERE named in that
    // workflow. 48 tests still returned a verdict on zero pull requests, and a
    // GitHub schedule disabled for 60 days of inactivity would have taken them
    // to zero runs of any kind with nothing here going red.
    //
    // Naming a runner is not coverage. The runner has to run when the code
    // changes, and only a pull-request trigger guarantees that.
    const cited = [...new Set(OTHER_RUNNERS.flatMap((r) => workflowsCitedIn(r.runner)))];
    expect(cited.length, 'no OTHER_RUNNERS entry cites a workflow at all').toBeGreaterThan(0);
    for (const name of cited) {
      const wf = join(REPO_ROOT, '.github', 'workflows', name);
      expect(existsSync(wf), `${name} is cited as a runner but does not exist`).toBe(true);
      expect(
        runsOnPullRequest(readFileSync(wf, 'utf-8')),
        `${name} is cited as the runner for test files that this project does not collect, ` +
          'but it has no pull_request trigger. Every test it accounts for is invisible to ' +
          'code review: a PR that breaks them merges green.',
      ).toBe(true);
    }
  });

  it('proves an entry with no CI workflow says why it has none', () => {
    // The escape hatch from the check above is "cite no workflow", so it has to
    // cost something. An entry with no workflow must state that nothing executes
    // these files, which is a claim a reader can weigh — unlike a runner string
    // that merely sounds like a pipeline.
    for (const r of OTHER_RUNNERS) {
      if (workflowsCitedIn(r.runner).length > 0) continue;
      expect(
        r.runner,
        `OTHER_RUNNERS entry "${r.prefix}" cites no workflow and does not say the files are ` +
          'unexecuted, so nothing distinguishes it from coverage that quietly does not exist. ' +
          'Name the workflow that runs them, or say "not executed here" and mean it.',
      ).toContain('not executed here');
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
