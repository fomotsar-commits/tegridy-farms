// A required status check that can never be reported blocks merges forever.
//
// Four workflows filter `pull_request` by `paths:` — contracts-ci, slither,
// registry-onchain, solana-ci. contracts-ci.yml's own comment names
// "Contracts CI / all-tests-pass" as the check branch protection should
// require. Those two facts are incompatible: a PR that touches only frontend/
// never triggers the workflow, so no check run with that name is created, so
// the rule sits at "Expected — waiting for status to be reported" and the PR
// cannot merge. It reads as an outage, gets called a flake, and ends with
// someone removing the requirement.
//
// The fix is GitHub's documented "skipped but required" recipe: a companion
// workflow with the same workflow name and the same job name, triggered on the
// inverse filter, that reports the same check as a pass. Both names are the
// wire format for the check context, which is exactly what makes it fragile —
// a rename on either side unsolders it with no error anywhere. Hence this
// suite, which re-derives the pairing from the files.
//
// NOT covered here: arming the branch-protection rule. That is a GitHub
// settings action and stays with the operator; this only makes the checks
// reportable so the rule can be armed at all.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
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

/**
 * Enough YAML for this question and no more. The repo has no yaml parser in
 * frontend/ and ciGateIntegrity.test.ts reads these files the same way; adding
 * a dependency to a guard test is a larger change than the guard.
 */
const parse = (file: string): Workflow => {
  const lines = readFileSync(join(WORKFLOW_DIR, file), 'utf-8').split(/\r?\n/);
  const code = lines.filter((l) => !/^\s*#/.test(l));

  const name = /^name:\s*(.+?)\s*$/m.exec(code.join('\n'))?.[1] ?? '';

  // Walk the `on:` block, then the `pull_request:` sub-block inside it.
  let inOn = false;
  let inPr = false;
  let listKey: 'paths' | 'paths-ignore' | null = null;
  const paths: string[] = [];
  const pathsIgnore: string[] = [];
  const checkNames: string[] = [];
  let inJobs = false;
  let pendingJobId: string | null = null;

  for (const line of code) {
    if (/^on:/.test(line)) { inOn = true; inPr = false; continue; }
    if (/^jobs:/.test(line)) { inOn = false; inPr = false; inJobs = true; continue; }
    if (/^\S/.test(line) && !/^on:/.test(line)) { inOn = false; inPr = false; inJobs = false; }

    if (inOn) {
      if (/^ {2}pull_request:/.test(line)) { inPr = true; listKey = null; continue; }
      if (/^ {2}\S/.test(line)) { inPr = false; listKey = null; continue; }
      if (inPr) {
        const m = /^ {4}(paths|paths-ignore):/.exec(line);
        if (m) { listKey = m[1] as 'paths' | 'paths-ignore'; continue; }
        if (/^ {4}\S/.test(line)) { listKey = null; continue; }
        const item = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
        if (listKey && item) (listKey === 'paths' ? paths : pathsIgnore).push(item[1]);
        // Inline form: paths: ["solana/**", ".github/…"]
        const inline = /^ {4}(paths|paths-ignore):\s*\[(.+)\]/.exec(line);
        if (inline) {
          const target = inline[1] === 'paths' ? paths : pathsIgnore;
          for (const raw of inline[2].split(',')) target.push(raw.trim().replace(/^["']|["']$/g, ''));
        }
      }
    }

    if (inJobs) {
      const jobId = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (jobId) {
        if (pendingJobId) checkNames.push(pendingJobId);
        pendingJobId = jobId[1];
        continue;
      }
      const jobName = /^ {4}name:\s*(.+?)\s*$/.exec(line);
      if (jobName && pendingJobId) { checkNames.push(jobName[1]); pendingJobId = null; }
    }
  }
  if (pendingJobId) checkNames.push(pendingJobId);

  // The inline-array form is also written on the `pull_request:` key's own
  // lines above; re-scan the raw source for it so indentation variants cannot
  // hide a filter.
  const raw = code.join('\n');
  for (const m of raw.matchAll(/^\s{4}paths:\s*\[(.+)\]\s*$/gm)) {
    for (const item of m[1].split(',')) {
      const v = item.trim().replace(/^["']|["']$/g, '');
      if (!paths.includes(v)) paths.push(v);
    }
  }

  return { file, name, paths, pathsIgnore, hasPullRequest: /^ {2}pull_request:/m.test(raw), checkNames };
};

const all = (): Workflow[] =>
  readdirSync(WORKFLOW_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map(parse);

describe('the parser understands these files (guards the guard)', () => {
  it('reads names, triggers and jobs', () => {
    const ws = all();
    expect(ws.length).toBeGreaterThan(10);
    expect(ws.every((w) => w.name.length > 0)).toBe(true);
    const contracts = ws.find((w) => w.file === 'contracts-ci.yml')!;
    expect(contracts.paths).toContain('contracts/**');
    expect(contracts.checkNames).toContain('all-tests-pass');
    const solana = ws.find((w) => w.file === 'solana-ci.yml')!;
    expect(solana.paths, 'inline-array paths form not parsed').toContain('solana/**');
  });
});

describe('every path-filtered PR workflow has a companion that can report its check', () => {
  const filtered = () => all().filter((w) => w.hasPullRequest && w.paths.length > 0);
  const companions = () => all().filter((w) => w.hasPullRequest && w.pathsIgnore.length > 0);

  it('finds path-filtered workflows at all', () => {
    expect(filtered().length).toBeGreaterThan(0);
  });

  it('pairs each one by workflow name', () => {
    const companionNames = new Set(companions().map((w) => w.name));
    const orphans = filtered()
      .filter((w) => !companionNames.has(w.name))
      .map((w) => `${w.file} (name: ${w.name})`);
    expect(
      orphans,
      'these workflows are skipped entirely on some PRs, so any required status check they own ' +
        'can never be reported and those PRs can never merge. Add a companion workflow with the ' +
        'same `name:` and the same job name, triggered on paths-ignore of the same globs.',
    ).toEqual([]);
  });

  it('mirrors the filter exactly, so the companion fires precisely when the real one does not', () => {
    const mismatched: string[] = [];
    for (const real of filtered()) {
      const companion = companions().find((w) => w.name === real.name);
      if (!companion) continue;
      const missing = real.paths.filter((p) => !companion.pathsIgnore.includes(p));
      if (missing.length > 0) mismatched.push(`${companion.file} does not ignore: ${missing.join(', ')}`);
    }
    expect(
      mismatched,
      'a glob the real workflow watches but the companion does not ignore means both run on the ' +
        'same PR and two check runs share one name.',
    ).toEqual([]);
  });

  it('reports check names the real workflow actually owns', () => {
    const bogus: string[] = [];
    for (const companion of companions()) {
      const real = all().find((w) => w.name === companion.name && w.file !== companion.file && w.paths.length > 0);
      if (!real) continue;
      for (const check of companion.checkNames) {
        if (!real.checkNames.includes(check)) bogus.push(`${companion.file}: "${check}" is not a job in ${real.file}`);
      }
    }
    expect(
      bogus,
      'a companion job name that does not exist in the real workflow synthesises a check nothing ' +
        'ever verifies — a permanent green under a name that looks like a gate.',
    ).toEqual([]);
  });

  it('keeps every companion job to a single fast step, so the real verdict always lands last', () => {
    // The overlap case (a PR touching both filtered and unfiltered paths) runs
    // both workflows. That is only safe because the companion finishes in
    // seconds while the real matrix takes minutes, so the real result is the
    // last one written to the shared check name. A companion that could
    // outlive the real run becomes a way to mask a red build.
    for (const companion of companions()) {
      const src = readFileSync(join(WORKFLOW_DIR, companion.file), 'utf-8');
      expect(src, `${companion.file} has a needs: — it could now finish after the real workflow`).not.toMatch(
        /^\s+needs:/m,
      );
      expect(src, `${companion.file} has a matrix — companions must stay single-shot`).not.toMatch(/^\s+strategy:/m);
      expect(src, `${companion.file} has no timeout-minutes`).toMatch(/timeout-minutes:/);
    }
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
});
