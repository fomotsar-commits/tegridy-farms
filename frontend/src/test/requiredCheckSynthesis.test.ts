// A required status check that can never be reported blocks merges forever —
// and a required status check that reports without checking is worse.
//
// Four workflows here (contracts-ci, slither, registry-onchain, solana-ci) once
// filtered `pull_request` by `paths:`. A PR touching none of those paths never
// triggered the workflow, no check run with its name was created, and a branch
// rule requiring that name sat at "Expected — waiting for status to be
// reported" forever. It reads as an outage, gets called a flake, and ends with
// someone removing the requirement.
//
// The fix WAS GitHub's documented "skipped but required" recipe: a companion
// workflow with the same workflow name and the same job name, on the inverse
// filter, reporting the same check as a pass. This suite used to enforce that
// pairing. IT WAS THE WRONG FIX, AND THIS SUITE HELPED IT SURVIVE.
//
// `paths` fires when ANY changed file matches; `paths-ignore` fires when ANY
// changed file does not. They are not complements, so a PR touching both sides
// triggers BOTH workflows and two check runs are created under one name. The
// old suite acknowledged that overlap and argued it was safe on finish order —
// the companion is a single echo, the real matrix takes minutes, "so the real
// result is the last one written". That argument was never measured, and it is
// false. On PR #205 (head a4706efb) two check runs named
// `Slither / Static analysis` existed at once: the real 4-minute analysis
// FAILED, the 2-second companion passed, and the PR's check list surfaced ONLY
// the pass. `all-tests-pass` was doubled on the same PR and agreed by luck.
//
// So the filter moved inside each workflow, into a `scope` job
// (.github/scripts/diff-scope.mjs), and the companions are gone. Exactly one
// check run per name now exists, and a job the scope gate skips reports success
// to branch protection — which is what the companions were for, reached without
// a second run that can disagree.
//
// What this suite enforces now is the shape that cannot regress into the old
// one: no companion workflows, no two workflows sharing a `name:`, no
// workflow-level `paths:` on a `pull_request`, and no gate a broken scope job
// can silently skip.
//
// NOT covered here: arming the branch-protection rule. That is a GitHub
// settings action and stays with the operator; this only makes the checks
// reportable so the rule can be armed at all.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const WORKFLOW_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '.github', 'workflows');

interface Workflow {
  file: string;
  name: string;
  /** Path globs under `pull_request: paths:`, empty when unfiltered. */
  paths: string[];
  /** Path globs under `pull_request: paths-ignore:`, empty when absent. */
  pathsIgnore: string[];
  hasPullRequest: boolean;
  /** Rendered check names: the job's `name:` if it has one, else its id. */
  checkNames: string[];
}

const sources = () => readdirSync(WORKFLOW_DIR).filter((f) => /\.ya?ml$/.test(f));
const strip = (src: string) => src.split(/\r?\n/).filter((l) => !/^\s*#/.test(l));

/**
 * Read one trigger's path filters out of the `on:` block.
 *
 * Enough YAML for this question and no more. The repo has no yaml parser in
 * frontend/ and ciGateIntegrity.test.ts reads these files the same way; adding
 * a dependency to a guard test is a larger change than the guard.
 */
export function parseOnBlock(src: string, trigger: 'pull_request' | 'push') {
  const code = strip(src);
  const paths: string[] = [];
  const pathsIgnore: string[] = [];
  let inOn = false;
  let inTrigger = false;
  let listKey: 'paths' | 'paths-ignore' | null = null;

  for (const line of code) {
    if (/^on:/.test(line)) { inOn = true; inTrigger = false; continue; }
    if (/^\S/.test(line)) { inOn = false; inTrigger = false; continue; }
    if (!inOn) continue;

    if (new RegExp(`^ {2}${trigger}:`).test(line)) { inTrigger = true; listKey = null; continue; }
    if (/^ {2}\S/.test(line)) { inTrigger = false; listKey = null; continue; }
    if (!inTrigger) continue;

    // Inline form first — `paths: ["solana/**", "…"]` also matches the block
    // opener below, and reading it as an opener would swallow the values.
    const inline = /^ {4}(paths|paths-ignore):\s*\[(.+)\]/.exec(line);
    if (inline) {
      const target = inline[1] === 'paths' ? paths : pathsIgnore;
      for (const raw of inline[2].split(',')) target.push(raw.trim().replace(/^["']|["']$/g, ''));
      listKey = null;
      continue;
    }
    const opener = /^ {4}(paths|paths-ignore):\s*$/.exec(line);
    if (opener) { listKey = opener[1] as 'paths' | 'paths-ignore'; continue; }
    if (/^ {4}\S/.test(line)) { listKey = null; continue; }
    const item = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
    if (listKey && item) (listKey === 'paths' ? paths : pathsIgnore).push(item[1]);
  }
  return { paths, pathsIgnore };
}

const parse = (file: string): Workflow => {
  const src = readFileSync(join(WORKFLOW_DIR, file), 'utf-8');
  const code = strip(src);
  const raw = code.join('\n');
  const name = /^name:\s*(.+?)\s*$/m.exec(raw)?.[1] ?? '';

  const checkNames: string[] = [];
  let inJobs = false;
  let pendingJobId: string | null = null;
  for (const line of code) {
    if (/^jobs:/.test(line)) { inJobs = true; continue; }
    if (/^\S/.test(line)) { inJobs = false; }
    if (!inJobs) continue;
    const jobId = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (jobId) {
      if (pendingJobId) checkNames.push(pendingJobId);
      pendingJobId = jobId[1];
      continue;
    }
    const jobName = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (jobName && pendingJobId) { checkNames.push(jobName[1]); pendingJobId = null; }
  }
  if (pendingJobId) checkNames.push(pendingJobId);

  const pr = parseOnBlock(src, 'pull_request');
  return {
    file,
    name,
    paths: pr.paths,
    pathsIgnore: pr.pathsIgnore,
    hasPullRequest: /^ {2}pull_request:/m.test(raw),
    checkNames,
  };
};

const all = (): Workflow[] => sources().map(parse);

describe('the parser understands these files (guards the guard)', () => {
  it('reads names, triggers and jobs', () => {
    const ws = all();
    expect(ws.length).toBeGreaterThan(10);
    expect(ws.every((w) => w.name.length > 0)).toBe(true);
    const contracts = ws.find((w) => w.file === 'contracts-ci.yml')!;
    expect(contracts.checkNames).toContain('all-tests-pass');
    expect(contracts.checkNames).toContain('scope');
    expect(contracts.hasPullRequest).toBe(true);
  });

  it('still reads both `paths:` forms, so the assertions below cannot pass vacuously', () => {
    // Nothing filters `pull_request` by path any more — which is the point, and
    // also the risk: a reader that had quietly stopped parsing `paths:` would
    // make every "no path filter" assertion below trivially true. `push:` still
    // uses the block form (contracts-ci) and the inline-array form (solana-ci),
    // so the reader is exercised against real input either way.
    expect(parseOnBlock(readFileSync(join(WORKFLOW_DIR, 'contracts-ci.yml'), 'utf-8'), 'push').paths).toContain(
      'contracts/**',
    );
    expect(parseOnBlock(readFileSync(join(WORKFLOW_DIR, 'solana-ci.yml'), 'utf-8'), 'push').paths).toContain(
      'solana/**',
    );
  });
});

describe('the shape that cannot regress into the companion recipe', () => {
  it('has no companion workflows left', () => {
    // A `-not-applicable.yml` republishing another workflow's check name is the
    // defect itself, not a workaround for it.
    expect(readdirSync(WORKFLOW_DIR).filter((f) => f.includes('not-applicable'))).toEqual([]);
  });

  it('gives every workflow a distinct `name:`', () => {
    // The check context is `<workflow name> / <job name>`. Two workflows sharing
    // a name is the precondition for two check runs that can disagree, and the
    // one GitHub surfaces need not be the one that did the work.
    const byName = new Map<string, string[]>();
    for (const w of all()) byName.set(w.name, [...(byName.get(w.name) ?? []), w.file]);
    expect([...byName.entries()].filter(([, files]) => files.length > 1)).toEqual([]);
  });

  it('never filters a `pull_request` trigger by path', () => {
    // This trigger decides whether a check run exists at all. A path filter here
    // is what forced the companion recipe into existence.
    const filtered = all()
      .filter((w) => w.hasPullRequest && w.paths.length > 0)
      .map((w) => `${w.file} (${w.paths.join(', ')})`);
    expect(
      filtered,
      'filter inside the workflow with a `scope` job instead. A workflow-level `paths:` on ' +
        'pull_request means no check run is created on an out-of-scope PR, and the companion ' +
        'workflow that papered over that could report a pass while the real job failed.',
    ).toEqual([]);
  });

  it('has no `paths-ignore` left on any pull_request trigger', () => {
    // The inverse filter only ever existed to drive a companion.
    const inverse = all()
      .filter((w) => w.hasPullRequest && w.pathsIgnore.length > 0)
      .map((w) => w.file);
    expect(inverse).toEqual([]);
  });

  it('lets a broken scope job run the real work rather than skip it', () => {
    // A job skipped by `if:` reports SUCCESS to branch protection. Gating on the
    // scope verdict alone would therefore turn any failure of the scope job into
    // a silent green — the same class of defect, one layer down.
    const bad: string[] = [];
    for (const f of sources()) {
      const lines = readFileSync(join(WORKFLOW_DIR, f), 'utf-8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (!line.includes("needs.scope.outputs.run == 'true'")) return;
        const window = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
        if (!window.includes("needs.scope.result != 'success'")) bad.push(`${f}:${i + 1}`);
      });
    }
    expect(bad, 'these gates skip when the scope job itself failed, which reports success').toEqual([]);
  });

  it('finds scope jobs at all, so the rule above is not asserted over nothing', () => {
    const scoped = sources().filter((f) => /^ {2}scope:$/m.test(readFileSync(join(WORKFLOW_DIR, f), 'utf-8')));
    expect(scoped.sort()).toEqual(
      ['ci.yml', 'codeql.yml', 'contracts-ci.yml', 'registry-onchain.yml', 'slither.yml', 'solana-ci.yml'].sort(),
    );
  });

  it('ci.yml and codeql.yml narrow pull requests only, and read both sides of a rename', () => {
    // Neither has a push path filter, so the scope job itself answers run=true for every
    // event that is not a pull request. A rename lists its old path too: a code file
    // moved into docs/ is still a code change.
    for (const f of ['ci.yml', 'codeql.yml']) {
      const src = readFileSync(join(WORKFLOW_DIR, f), 'utf-8');
      expect(src, `${f}: a push or schedule must run everything`).toMatch(
        /\[ -n "\$\{PR:-\}" \] \|\| \{[^\n]*say true; \}/,
      );
      expect(src, `${f}: the file list must include previous_filename`).toContain(
        '.filename, (.previous_filename // empty)',
      );
      expect(src, `${f}: only an all-docs diff may skip`).toMatch(
        /diff-scope\.mjs --outside \\\n +'\*\*\/\*\.md' \\\n +'docs\/\*\*'\)\n/,
      );
    }
  });

  it('keeps each scope job in sync with the `push:` filter it was split from', () => {
    // The two lists are one rule written twice: `push: paths:` decides whether
    // the workflow runs on a merge, the scope job decides whether it runs on a
    // PR. A path added to one and not the other means the gate watches a file on
    // trunk that it ignores on the PR that introduces it — which is the half
    // that matters, and it fails silently in the permissive direction.
    const drift: string[] = [];
    for (const f of ['contracts-ci.yml', 'registry-onchain.yml', 'slither.yml', 'solana-ci.yml']) {
      const src = readFileSync(join(WORKFLOW_DIR, f), 'utf-8');
      const push = parseOnBlock(src, 'push').paths;
      const call = /diff-scope\.mjs \\\n((?: +'[^']+'[^\n]*\n)+)/.exec(src);
      expect(call, `${f}: no diff-scope invocation found`).not.toBeNull();
      const scoped = [...call![1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
      for (const p of push) if (!scoped.includes(p)) drift.push(`${f}: push watches "${p}", scope does not`);
      for (const p of scoped) if (!push.includes(p)) drift.push(`${f}: scope watches "${p}", push does not`);
    }
    expect(drift).toEqual([]);
  });
});

describe('solana-ci exposes one aggregate check to require', () => {
  it('has an all-checks-pass job depending on every other job', () => {
    const src = readFileSync(join(WORKFLOW_DIR, 'solana-ci.yml'), 'utf-8');
    expect(src).toMatch(/^ {2}all-checks-pass:/m);
    const solana = parse('solana-ci.yml');
    const others = solana.checkNames.filter((n) => n !== 'all-checks-pass');
    const needs = /needs:\s*\[([^\]]+)\]/.exec(src.slice(src.indexOf('all-checks-pass:')))?.[1] ?? '';
    const listed = needs.split(',').map((s) => s.trim());
    expect(
      others.filter((n) => !listed.includes(n)),
      'a job outside the aggregate is a job branch protection does not see',
    ).toEqual([]);
  });

  it('treats a skipped dependency as a failure', () => {
    // Under `if: always()` a skipped dependency still lets the aggregator run,
    // so `needs` alone gates nothing — the results have to be read.
    const src = readFileSync(join(WORKFLOW_DIR, 'solana-ci.yml'), 'utf-8');
    const job = src.slice(src.indexOf('  all-checks-pass:'));
    expect(job).toMatch(/if:\s*always\(\)/);
    expect(job).toMatch(/!=\s*"success"/);
  });

  it('does not read a scope-skipped run as a failure, and does not read it as a pass either', () => {
    // Out of scope, every dependency IS skipped, and the aggregate step above
    // would correctly call that a failure — so it must not be the step that
    // speaks. The two steps' conditions are exact complements: precisely one
    // runs, and neither can be reached when the scope job itself failed.
    const src = readFileSync(join(WORKFLOW_DIR, 'solana-ci.yml'), 'utf-8');
    const job = src.slice(src.indexOf('  all-checks-pass:'));
    expect(job).toContain("if: needs.scope.result == 'success' && needs.scope.outputs.run != 'true'");
    expect(job).toContain("if: needs.scope.result != 'success' || needs.scope.outputs.run == 'true'");
  });
});

describe('ci.yml: docs skip the build, never the doc guards', () => {
  const CI = () => readFileSync(join(WORKFLOW_DIR, 'ci.yml'), 'utf-8');
  const GATE = [
    'if: >-',
    '!cancelled() &&',
    "(needs.scope.result != 'success' || needs.scope.outputs.run == 'true')",
  ];

  /** The config lines of one job before its `steps:`, trimmed, comments dropped. */
  const jobHead = (src: string, id: string): string[] => {
    const lines = src.split(/\r?\n/);
    const start = lines.findIndex((l) => l === `  ${id}:`);
    expect(start, `no job ${id}`).toBeGreaterThan(-1);
    const out: string[] = [];
    for (const l of lines.slice(start + 1)) {
      if (/^ {2}\S/.test(l) || /^ {4}steps:/.test(l)) break;
      if (l.trim() && !/^\s*#/.test(l)) out.push(l.trim());
    }
    return out;
  };
  const gateOf = (head: string[]) => {
    const i = head.indexOf('if: >-');
    return i === -1 ? head.filter((l) => l.startsWith('if:')) : head.slice(i, i + 3);
  };

  it('gates the first job on the scope verdict, failing open', () => {
    const head = jobHead(CI(), 'lint-typecheck-test');
    expect(head).toContain('needs: scope');
    expect(gateOf(head)).toEqual(GATE);
    expect(head.filter((l) => l.startsWith('if:'))).toEqual(['if: >-']);
  });

  it('keeps build, e2e and e2e-anvil behind it, so a skip reaches all four', () => {
    // A job with no `if:` runs only when its needs succeeded; a skipped need skips it.
    const src = CI();
    for (const [id, need] of [
      ['build', 'lint-typecheck-test'],
      ['e2e', 'build'],
      ['e2e-anvil', 'build'],
    ]) {
      const head = jobHead(src, id);
      expect(head, `${id} must need ${need}`).toContain(`needs: ${need}`);
      expect(head.filter((l) => l.startsWith('if:')), `${id} must not override the skip`).toEqual([]);
    }
  });

  it('gates CodeQL the same way', () => {
    const head = jobHead(readFileSync(join(WORKFLOW_DIR, 'codeql.yml'), 'utf-8'), 'analyze');
    expect(head).toContain('needs: scope');
    expect(gateOf(head)).toEqual(GATE);
  });

  it('runs the tests that read markdown on every change, docs-only included', () => {
    const src = CI();
    const head = jobHead(src, 'docs-guards');
    expect(head.filter((l) => l.startsWith('needs:') || l.startsWith('if:'))).toEqual([]);
    const job = src.slice(src.indexOf('\n  docs-guards:'));
    const step = job.slice(job.indexOf('- name: Tests that read markdown'));
    const body = step.slice(0, step.indexOf('\n      - ', 5) === -1 ? undefined : step.indexOf('\n      - ', 5));
    const listed = [...body.matchAll(/(\S+\.test\.(?:ts|tsx|js|jsx|mjs))\b/g)].map((m) => m[1]).sort();
    expect(listed, 'the step must run the list below, derived from the test files themselves').toEqual(
      markdownReaders(),
    );
  });

  it('derives that list from something (guards the guard)', () => {
    expect(markdownReaders().length).toBeGreaterThanOrEqual(8);
    expect(markdownReaders()).toContain('src/lib/docsClaimHonesty.test.ts');
    expect(markdownReaders()).toContain('src/test/frontDoor.test.ts');
  });
});

/**
 * Every frontend test file that reads a markdown file or walks docs/, found the same way
 * each time: a markdown path handed to a reader, a walker filtering on a markdown
 * extension, or the docs directory joined as a path, in a file that reads the disk.
 * Paths are relative to frontend/, where the docs-guards job runs vitest.
 */
function markdownReaders(): string[] {
  const REPO_ROOT = join(WORKFLOW_DIR, '..', '..');
  const ext = String.raw`\.m` + 'd';
  const SIGNS = [
    new RegExp(String.raw`(?:join|readFileSync|read|doc)\([^)]*['"\x60][^'"\x60\n]*${ext}['"\x60]`),
    new RegExp(String.raw`\/\\.\(?(?:md|markdown)\b`),
    new RegExp(String.raw`\${ext}\$`),
    new RegExp(String.raw`['"]doc` + String.raw`s['"]`),
    new RegExp(String.raw`\\.\((?:\?:)?[^)\n]*\bmd\b[^)\n]*\)`),
  ];
  return execFileSync('git', ['ls-files', 'frontend'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
    .split('\n')
    .map((l) => l.trim())
    .filter((f) => /\.test\.(?:ts|tsx|js|jsx|mjs)$/.test(f))
    .filter((f) => {
      const s = readFileSync(join(REPO_ROOT, f), 'utf-8');
      return /readFileSync|readdirSync/.test(s) && SIGNS.some((re) => re.test(s));
    })
    .map((f) => f.slice('frontend/'.length))
    .sort();
}
