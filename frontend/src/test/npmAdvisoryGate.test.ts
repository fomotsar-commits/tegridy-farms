// The advisory gate (.github/workflows/npm-advisories.yml) and the ways one stops being a gate:
//   1. A report it cannot recognise is an ERROR, never zero advisories.
//   2. A suppression covers one GHSA id in the projects it names: never a package, never everywhere.
//   3. Every suppression expires.
// Also pinned: the committed allowlist, and that the workflow's project matrix matches the
// lockfiles on disk, so a fourth npm project cannot land ungated.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  assertUsableReport,
  collectAdvisories,
  evaluate,
  renderSummary,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
} from '../../../.github/scripts/npm-advisory-gate.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ALLOWLIST_PATH = join(REPO_ROOT, '.github', 'npm-advisory-allowlist.json');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'npm-advisories.yml');

const allowlist = () => JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf-8'));

/** Minimal `npm audit --json` shape: one package, one advisory. */
const reportWith = (
  advisories: { ghsa: string; severity: string; name?: string }[],
): Record<string, unknown> => ({
  vulnerabilities: Object.fromEntries(
    advisories.map((a) => [
      a.name ?? a.ghsa,
      {
        name: a.name ?? a.ghsa,
        severity: a.severity,
        via: [
          {
            source: 1,
            name: a.name ?? a.ghsa,
            title: `synthetic ${a.ghsa}`,
            url: `https://github.com/advisories/${a.ghsa}`,
            severity: a.severity,
          },
        ],
        fixAvailable: false,
      },
    ]),
  ),
  metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: advisories.length } },
});

const emptyAllowlist = { accepted: [], baseline: { expires: '2099-01-01', projects: {} } };

describe('an unusable audit is an error, never a clean result', () => {
  it('rejects a report with no vulnerabilities map (what a registry failure looks like)', () => {
    expect(() => assertUsableReport({ metadata: {} })).toThrow(/vulnerabilities/i);
  });

  it('rejects npm audit s own error envelope', () => {
    expect(() =>
      assertUsableReport({ error: { code: 'ENETUNREACH', summary: 'registry unreachable' } }),
    ).toThrow(/registry unreachable/);
  });

  it('rejects a report with no metadata counts', () => {
    expect(() => assertUsableReport({ vulnerabilities: {} })).toThrow(/metadata/i);
  });

  it('rejects a non-object', () => {
    expect(() => assertUsableReport(null)).toThrow();
    expect(() => assertUsableReport('')).toThrow();
  });

  it('accepts a genuinely clean report', () => {
    const clean = { vulnerabilities: {}, metadata: { vulnerabilities: { total: 0 } } };
    expect(() => assertUsableReport(clean)).not.toThrow();
    expect(evaluate({ report: clean, allowlist: emptyAllowlist, project: 'x' }).blocking).toEqual([]);
  });

  it('propagates the refusal out of evaluate rather than returning an empty verdict', () => {
    expect(() => evaluate({ report: { metadata: {} }, allowlist: emptyAllowlist, project: 'x' })).toThrow();
  });
});

describe('what blocks', () => {
  it('blocks an unlisted high advisory', () => {
    const r = evaluate({
      report: reportWith([{ ghsa: 'GHSA-aaaa-bbbb-cccc', severity: 'high' }]),
      allowlist: emptyAllowlist,
      project: 'frontend',
    });
    expect(r.blocking.map((a: { ghsa: string }) => a.ghsa)).toEqual(['GHSA-aaaa-bbbb-cccc']);
  });

  it('blocks critical too', () => {
    const r = evaluate({
      report: reportWith([{ ghsa: 'GHSA-crit-0000-0000', severity: 'critical' }]),
      allowlist: emptyAllowlist,
      project: 'frontend',
    });
    expect(r.blocking).toHaveLength(1);
  });

  it('ignores moderate and low — the gate is high/critical only', () => {
    const r = evaluate({
      report: reportWith([
        { ghsa: 'GHSA-mod0-0000-0000', severity: 'moderate' },
        { ghsa: 'GHSA-low0-0000-0000', severity: 'low' },
      ]),
      allowlist: emptyAllowlist,
      project: 'frontend',
    });
    expect(r.blocking).toEqual([]);
    expect(r.suppressedTotal).toBe(0);
  });
});

describe('suppression is per-advisory and always dated', () => {
  const adv = [{ ghsa: 'GHSA-aaaa-bbbb-cccc', severity: 'high', name: 'axios' }];

  it('a baselined advisory passes while the baseline is live', () => {
    const r = evaluate({
      report: reportWith(adv),
      allowlist: { accepted: [], baseline: { expires: '2099-01-01', projects: { frontend: ['GHSA-aaaa-bbbb-cccc'] } } },
      project: 'frontend',
    });
    expect(r.blocking).toEqual([]);
    expect(r.baselined).toHaveLength(1);
  });

  it('the same advisory blocks once the baseline has expired', () => {
    const r = evaluate({
      report: reportWith(adv),
      allowlist: { accepted: [], baseline: { expires: '2000-01-01', projects: { frontend: ['GHSA-aaaa-bbbb-cccc'] } } },
      project: 'frontend',
    });
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].why).toMatch(/baseline expired/);
  });

  it('a baseline entry for one project does not suppress it in another', () => {
    const r = evaluate({
      report: reportWith(adv),
      allowlist: { accepted: [], baseline: { expires: '2099-01-01', projects: { frontend: ['GHSA-aaaa-bbbb-cccc'] } } },
      project: 'indexer',
    });
    expect(r.blocking).toHaveLength(1);
  });

  it('an acceptance needs a written reason — a bare id is a silencer, not a decision', () => {
    const r = evaluate({
      report: reportWith(adv),
      allowlist: {
        accepted: [{ ghsa: 'GHSA-aaaa-bbbb-cccc', expires: '2099-01-01', projects: ['frontend'] }],
        baseline: { expires: '2099-01-01', projects: {} },
      },
      project: 'frontend',
    });
    expect(r.blocking[0].why).toMatch(/without a written reason/);
  });

  it('an acceptance with no expiry is treated as expired — nothing is forgiven forever', () => {
    const r = evaluate({
      report: reportWith(adv),
      allowlist: {
        accepted: [
          { ghsa: 'GHSA-aaaa-bbbb-cccc', reason: 'not reachable from any shipped code path', projects: ['frontend'] },
        ],
        baseline: { expires: '2099-01-01', projects: {} },
      },
      project: 'frontend',
    });
    expect(r.blocking).toHaveLength(1);
    expect(r.blocking[0].why).toMatch(/acceptance expired/);
  });

  it('a valid, dated, reasoned acceptance passes and is reported as suppressed', () => {
    const r = evaluate({
      report: reportWith(adv),
      allowlist: {
        accepted: [
          {
            ghsa: 'GHSA-aaaa-bbbb-cccc',
            reason: 'not reachable from any shipped code path',
            expires: '2099-01-01',
            projects: ['frontend'],
          },
        ],
        baseline: { expires: '2099-01-01', projects: {} },
      },
      project: 'frontend',
    });
    expect(r.blocking).toEqual([]);
    expect(r.accepted).toHaveLength(1);
    expect(r.suppressedTotal).toBe(1);
  });

  it('suppressing a package does NOT suppress a second advisory in that package', () => {
    const r = evaluate({
      report: reportWith([
        { ghsa: 'GHSA-aaaa-bbbb-cccc', severity: 'high', name: 'axios' },
        { ghsa: 'GHSA-dddd-eeee-ffff', severity: 'high', name: 'axios-second' },
      ]),
      allowlist: { accepted: [], baseline: { expires: '2099-01-01', projects: { frontend: ['GHSA-aaaa-bbbb-cccc'] } } },
      project: 'frontend',
    });
    expect(r.blocking.map((a: { ghsa: string }) => a.ghsa)).toEqual(['GHSA-dddd-eeee-ffff']);
  });

  it('reports a suppression that no longer matches anything, without failing on it', () => {
    const r = evaluate({
      report: reportWith([]),
      allowlist: { accepted: [], baseline: { expires: '2099-01-01', projects: { frontend: ['GHSA-gone-0000-0000'] } } },
      project: 'frontend',
    });
    expect(r.blocking).toEqual([]);
    expect(r.stale).toEqual(['GHSA-gone-0000-0000']);
  });
});

describe('an acceptance counts only in the projects it names', () => {
  const ID = 'GHSA-aaaa-bbbb-cccc';
  const present = reportWith([{ ghsa: ID, severity: 'high', name: 'braces' }]);
  const gone = reportWith([]);
  const REASON = 'not reachable from any code the indexer runs';
  const entry = (extra: Record<string, unknown>) => ({ ghsa: ID, reason: REASON, expires: '2099-01-01', ...extra });
  const listing = (...accepted: Record<string, unknown>[]) => ({
    accepted,
    baseline: { expires: '2099-01-01', projects: {} },
  });
  const forIndexer = listing(entry({ projects: ['indexer'] }));

  it('forgives the advisory in a project it names', () => {
    const r = evaluate({ report: present, allowlist: forIndexer, project: 'indexer' });
    expect(r.blocking).toEqual([]);
    expect(r.accepted.map((a: { ghsa: string }) => a.ghsa)).toEqual([ID]);
  });

  it('does not forgive it in a project it does not name, and says where it was accepted', () => {
    for (const project of ['frontend', '.']) {
      const r = evaluate({ report: present, allowlist: forIndexer, project });
      expect(r.accepted, project).toEqual([]);
      expect(r.blocking.map((a: { ghsa: string }) => a.ghsa), project).toEqual([ID]);
      expect(r.blocking[0].why, project).toMatch(/accepted for indexer only/);
    }
  });

  it('is not reported stale by a project outside its scope', () => {
    // The root and frontend runs used to say "prune" about an id the indexer run was using.
    for (const project of ['frontend', '.']) {
      expect(evaluate({ report: gone, allowlist: forIndexer, project }).stale, project).toEqual([]);
    }
  });

  it('is reported stale by a project inside its scope once the advisory is gone', () => {
    expect(evaluate({ report: gone, allowlist: forIndexer, project: 'indexer' }).stale).toEqual([ID]);
  });

  it('counts nowhere without a `projects` list, and the block says so', () => {
    for (const projects of [undefined, [], 'indexer', null]) {
      const unscoped = listing(entry(projects === undefined ? {} : { projects }));
      const r = evaluate({ report: present, allowlist: unscoped, project: 'indexer' });
      expect(r.accepted, JSON.stringify(projects)).toEqual([]);
      expect(r.blocking[0]?.why, JSON.stringify(projects)).toMatch(/without a `projects` list/);
      expect(evaluate({ report: gone, allowlist: unscoped, project: 'indexer' }).stale).toEqual([]);
    }
  });

  it('still needs a reason and a live expiry inside its scope', () => {
    const bare = listing({ ghsa: ID, expires: '2099-01-01', projects: ['indexer'] });
    expect(evaluate({ report: present, allowlist: bare, project: 'indexer' }).blocking[0].why).toMatch(
      /without a written reason/,
    );
    const lapsed = listing(entry({ expires: '2000-01-01', projects: ['indexer'] }));
    expect(evaluate({ report: present, allowlist: lapsed, project: 'indexer' }).blocking[0].why).toMatch(
      /acceptance expired 2000-01-01/,
    );
  });

  it('judges two entries for one advisory each in its own project', () => {
    const both = listing(
      entry({ projects: ['frontend'], reason: 'build-time only in the frontend' }),
      entry({ projects: ['indexer'] }),
    );
    const reasonIn = (project: string) => evaluate({ report: present, allowlist: both, project }).accepted[0]?.reason;
    expect(reasonIn('frontend')).toBe('build-time only in the frontend');
    expect(reasonIn('indexer')).toBe(REASON);
    expect(evaluate({ report: present, allowlist: both, project: '.' }).blocking).toHaveLength(1);
  });

  it('leaves a project outside its scope to that project s own baseline', () => {
    const r = evaluate({
      report: present,
      allowlist: { ...forIndexer, baseline: { expires: '2099-01-01', projects: { frontend: [ID] } } },
      project: 'frontend',
    });
    expect(r.blocking).toEqual([]);
    expect(r.baselined).toHaveLength(1);
  });

  it('tells a project to prune only for itself', () => {
    // Accepted for two projects and gone from one: deleting the entry would turn the other red.
    const shared = listing(entry({ projects: ['frontend', 'indexer'] }));
    const summary = renderSummary('frontend', evaluate({ report: gone, allowlist: shared, project: 'frontend' }));
    const pruneLine = summary.split('\n').find((l: string) => l.includes(ID));
    expect(pruneLine).toMatch(/prune/);
    expect(pruneLine).toContain('`frontend`');
  });
});

describe('advisory collection', () => {
  it('collapses the transitive chain — a GHSA is counted once, at the package that has it', () => {
    // npm repeats a finding at every package that drags it in, but only the
    // origin carries the advisory object; the rest carry a parent name string.
    const report = {
      vulnerabilities: {
        'bigint-buffer': {
          name: 'bigint-buffer',
          severity: 'high',
          via: [
            {
              source: 1103747,
              name: 'bigint-buffer',
              title: 'overflow',
              url: 'https://github.com/advisories/GHSA-3gc7-fjrx-p6mg',
              severity: 'high',
            },
          ],
        },
        '@solana/spl-token': { name: '@solana/spl-token', severity: 'high', via: ['@solana/buffer-layout-utils'] },
      },
      metadata: { vulnerabilities: { total: 2 } },
    };
    expect(collectAdvisories(report).map((a: { ghsa: string }) => a.ghsa)).toEqual(['GHSA-3gc7-fjrx-p6mg']);
  });
});

describe('the summary discloses its own suppressions', () => {
  it('names every suppressed advisory even when the gate passes', () => {
    const r = evaluate({
      report: reportWith([{ ghsa: 'GHSA-aaaa-bbbb-cccc', severity: 'high', name: 'axios' }]),
      allowlist: { accepted: [], baseline: { expires: '2099-01-01', projects: { frontend: ['GHSA-aaaa-bbbb-cccc'] } } },
      project: 'frontend',
    });
    const summary = renderSummary('frontend', r);
    expect(summary).toContain('GHSA-aaaa-bbbb-cccc');
    expect(summary).toMatch(/suppressed/i);
  });
});

describe('the workflow leaves the verdict to the gate', () => {
  // GitHub runs each `run:` block under `bash -e`, `set -uo pipefail` does not clear errexit, and
  // `npm audit` exits non-zero whenever it finds anything. An unguarded invocation ends the step
  // before the gate reads the report: red wherever there is an advisory, and the allowlist is
  // never consulted either way.
  const auditStepLine = () =>
    readFileSync(WORKFLOW_PATH, 'utf-8')
      .split('\n')
      .find((l) => l.includes('npm audit --json'));

  it('runs npm audit so its exit code cannot end the step', () => {
    const line = auditStepLine();
    expect(line, 'the workflow no longer runs `npm audit --json`').toBeTruthy();
    expect(
      line,
      'npm audit is unguarded under bash -e: finding an advisory kills the step before the gate can weigh it',
    ).toMatch(/\|\|/);
  });

  it('still treats a report that was never written as fatal', () => {
    // The cost of relaxing errexit above: a failed audit now reaches the gate
    // instead of stopping the job, so the emptiness check has to survive.
    expect(
      readFileSync(WORKFLOW_PATH, 'utf-8'),
      'nothing fails the step when npm produces no report, so an outage reaches the gate as an empty file',
    ).toContain('test -s audit.json');
  });
});

describe('the committed allowlist', () => {
  it('exists and parses', () => {
    expect(existsSync(ALLOWLIST_PATH)).toBe(true);
    expect(allowlist().baseline).toBeTruthy();
  });

  it('records the bigint-buffer overflow rather than quietly dropping it', () => {
    // GHSA-3gc7-fjrx-p6mg reaches this app through @solana/spl-token, in a
    // build that signs transactions. It is the one advisory in the baseline
    // whose disappearance from this file would most likely be an accident.
    expect(allowlist().baseline.projects.frontend).toContain('GHSA-3gc7-fjrx-p6mg');
  });

  it('has a baseline expiry, so inherited debt comes due', () => {
    expect(allowlist().baseline.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('gives every acceptance a reason and an expiry', () => {
    for (const entry of allowlist().accepted) {
      expect(entry.ghsa, JSON.stringify(entry)).toMatch(/^GHSA-/);
      expect(String(entry.reason ?? '').length, `${entry.ghsa} has no written reason`).toBeGreaterThan(9);
      expect(entry.expires, `${entry.ghsa} never expires`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('names the audited projects every acceptance was judged for', () => {
    const { accepted, baseline } = allowlist();
    const audited = Object.keys(baseline.projects);
    for (const entry of accepted) {
      expect(Array.isArray(entry.projects), `${entry.ghsa} names no projects, so it forgives nothing`).toBe(true);
      expect(entry.projects.length, `${entry.ghsa} names no projects, so it forgives nothing`).toBeGreaterThan(0);
      expect(
        entry.projects.filter((p: string) => !audited.includes(p)),
        `${entry.ghsa} names a project the workflow does not audit`,
      ).toEqual([]);
    }
  });

  it('forgives each accepted advisory in the projects its entry names, and in no other', () => {
    const list = allowlist();
    for (const entry of list.accepted) {
      const report = reportWith([{ ghsa: entry.ghsa, severity: 'high' }]);
      const now = new Date(`${entry.expires}T00:00:00Z`);
      const named = list.accepted
        .filter((e: { ghsa: string }) => e.ghsa === entry.ghsa)
        .flatMap((e: { projects?: string[] }) => e.projects ?? []);
      for (const project of Object.keys(list.baseline.projects)) {
        const forgiven = evaluate({ report, allowlist: list, project, now }).accepted.length === 1;
        expect(forgiven, `${entry.ghsa} in ${project}`).toBe(named.includes(project));
      }
    }
  });

  it('covers exactly the projects the workflow audits', () => {
    const workflow = readFileSync(WORKFLOW_PATH, 'utf-8');
    const matrix = /project:\s*\[([^\]]+)\]/.exec(workflow);
    expect(matrix, 'the workflow no longer declares a project matrix').toBeTruthy();
    const projects = matrix![1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
    expect(Object.keys(allowlist().baseline.projects).sort()).toEqual([...projects].sort());
  });

  it('audits every directory in the repo that has its own package-lock.json', () => {
    // A new npm project must not be able to land without a gate. Top level
    // only — nothing here vendors a lockfile deeper than one directory.
    const locked = readdirSync(REPO_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
      .filter((d) => existsSync(join(REPO_ROOT, d.name, 'package-lock.json')))
      .map((d) => d.name);
    if (existsSync(join(REPO_ROOT, 'package-lock.json'))) locked.push('.');
    const audited = Object.keys(allowlist().baseline.projects);
    expect(
      locked.filter((p) => !audited.includes(p)),
      'these npm projects have a lockfile but no advisory gate — add them to the matrix in ' +
        '.github/workflows/npm-advisories.yml and to baseline.projects',
    ).toEqual([]);
  });
});
