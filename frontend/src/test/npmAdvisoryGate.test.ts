// The advisory gate, and the ways a gate like this normally stops being one.
//
// .github/workflows/npm-advisories.yml is the repo's first workflow that fails
// on a known-exploitable dependency. Three things have to stay true or it is
// theatre:
//
//   1. A report it cannot recognise is an ERROR, never zero advisories. `npm
//      audit` exits non-zero for "found something" and for "the registry was
//      unreachable" alike; reading the second as a clean bill of health is the
//      outage-as-green-check shape the house forbids.
//   2. Suppression is per-GHSA. A package-level mute would absorb next
//      quarter's advisory in the same package silently.
//   3. Every suppression expires. A permanent allowlist entry is a deleted
//      finding with extra steps.
//
// Also pinned here: the seeded baseline is what was actually measured on
// 2026-08-18, and the workflow's project matrix still matches the lockfiles on
// disk — a fourth npm project must not be able to land ungated.

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
        accepted: [{ ghsa: 'GHSA-aaaa-bbbb-cccc', expires: '2099-01-01' }],
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
        accepted: [{ ghsa: 'GHSA-aaaa-bbbb-cccc', reason: 'not reachable from any shipped code path' }],
        baseline: { expires: '2099-01-01', projects: {} },
      },
      project: 'frontend',
    });
    expect(r.blocking).toHaveLength(1);
  });

  it('a valid, dated, reasoned acceptance passes and is reported as suppressed', () => {
    const r = evaluate({
      report: reportWith(adv),
      allowlist: {
        accepted: [
          { ghsa: 'GHSA-aaaa-bbbb-cccc', reason: 'not reachable from any shipped code path', expires: '2099-01-01' },
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
