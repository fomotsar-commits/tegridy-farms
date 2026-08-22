// CI hardening guard — two audit findings, both of the same shape: a control that
// LOOKS present and enforces nothing.
//
//  1. 16 `testFuzz_` and 5 `invariant_` harnesses ran in ZERO pipelines. The
//     Contracts CI matrix is manifest-driven and every unit slice carries the
//     shared `--no-match-test` `^(invariant_|testFuzz_)`, which strips them BY
//     NAME; the one slice that overrides it (`invariants`) narrows the override
//     to `^testFuzz_` (so fuzz is still skipped) AND is scoped by
//     `--match-path test/invariants/*.t.sol` (so harnesses outside that
//     directory are unreachable by path too). Among the casualties were the
//     AMM's three core safety properties in contracts/test/FuzzInvariant.t.sol.
//
//  2. frontend/.npmrc did not disable install-time lifecycle scripts, so a
//     handful of dependencies execute Node on the runner during `npm ci`.
//
// This pins the INVARIANTS, not literals:
//   * "every fuzz/invariant test declared under contracts/test is selected by
//     the CI job that exists to run them" — a new harness in a new directory
//     passes automatically; a selection regex that drifts away from the tree
//     fails here rather than silently running nothing.
//   * "that job gates the required aggregate check" — a job nothing depends on
//     is the same false-green wearing a different hat.
//   * "install scripts are off" — expressed as a parsed key, so comments,
//     ordering and extra settings are all fine.
//
// Deliberately NOT asserted: any specific job name, step name, wording, or the
// exact regex text. Rename freely; only the behaviour is pinned.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW = join(REPO_ROOT, '.github', 'workflows', 'contracts-ci.yml');
const NPMRC = join(REPO_ROOT, 'frontend', '.npmrc');
const CONTRACTS_TEST = join(REPO_ROOT, 'contracts', 'test');

// ── minimal workflow reader ───────────────────────────────────────────────
// A YAML parser is not a dependency of this app, and the shape we need is
// narrow: split `jobs:` into top-level job blocks by their 2-space indent.
type Job = { name: string; body: string };

const jobs = (): Job[] => {
  const lines = readFileSync(WORKFLOW, 'utf-8').split(/\r?\n/);
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  expect(start, 'contracts-ci.yml has no top-level `jobs:` key').toBeGreaterThanOrEqual(0);

  const out: Job[] = [];
  let current: Job | null = null;
  for (const line of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      current = { name: header[1], body: '' };
      out.push(current);
    } else if (current) {
      current.body += `${line}\n`;
    }
  }
  return out;
};

/**
 * The job that owns the fuzz/invariant selection, found STRUCTURALLY (by the
 * env binding it declares) rather than by a hard-coded job name.
 */
const fuzzJob = (): Job => {
  const found = jobs().filter((j) => /^\s*FUZZ_MATCH_TEST:/m.test(j.body));
  expect(
    found.length,
    'no job in contracts-ci.yml binds FUZZ_MATCH_TEST — the fuzz/invariant harnesses run nowhere',
  ).toBe(1);
  return found[0];
};

/** The `--match-test` regex that job runs under, unquoted. */
const fuzzMatchTest = (): string => {
  const m = /^\s*FUZZ_MATCH_TEST:\s*(.+?)\s*$/m.exec(fuzzJob().body);
  expect(m, 'FUZZ_MATCH_TEST has no value').not.toBeNull();
  return (m as RegExpExecArray)[1].replace(/^(['"])(.*)\1$/, '$2');
};

// ── the harnesses that exist on disk ──────────────────────────────────────
/** Every `testFuzz_*` / `invariant_*` function declared under contracts/test. */
const declaredHarnesses = (dir = CONTRACTS_TEST): { file: string; fn: string }[] => {
  const out: { file: string; fn: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...declaredHarnesses(full));
    } else if (entry.name.endsWith('.sol')) {
      const src = readFileSync(full, 'utf-8');
      for (const m of src.matchAll(/function\s+((?:testFuzz_|invariant_)[A-Za-z0-9_]*)\s*\(/g)) {
        out.push({ file: entry.name, fn: m[1] });
      }
    }
  }
  return out;
};

describe('Contracts CI actually executes the fuzz + invariant harnesses', () => {
  it('declares harnesses at all (guards the guard)', () => {
    // If this ever hits zero the assertions below become vacuous, so it is
    // checked separately rather than folded into them.
    expect(declaredHarnesses().length).toBeGreaterThan(0);
  });

  it('selects EVERY declared testFuzz_/invariant_ test', () => {
    const selector = new RegExp(fuzzMatchTest());
    const unselected = declaredHarnesses().filter((h) => !selector.test(h.fn));
    expect(
      unselected.map((h) => `contracts/test/.../${h.file}::${h.fn}`),
      'these fuzz/invariant tests are declared but no CI job selects them — they never run',
    ).toEqual([]);
  });

  it('runs forge under that selection with no name filter that re-hides it', () => {
    // Comment lines are dropped first: this job's rationale block *mentions*
    // `--no-match-test` to explain why it is absent, and a naive substring
    // check would read the explanation as the thing it warns about.
    const body = fuzzJob()
      .body.split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');
    expect(body, 'the fuzz job never invokes `forge test`').toMatch(/forge test/);
    expect(
      body,
      'the fuzz job must consume FUZZ_MATCH_TEST as data via "$FUZZ_MATCH_TEST"',
    ).toMatch(/--match-test\s+"\$FUZZ_MATCH_TEST"/);
    // `--no-match-test` is precisely what hid these harnesses in the matrix.
    expect(body, 'the fuzz job applies a --no-match-test filter, re-hiding what it exists to run').not.toMatch(
      /--no-match-test/,
    );
    // The OTHER half of the original defect was PATH scoping, not name
    // filtering: the `invariants` slice reached only test/invariants/*.t.sol,
    // so FuzzInvariant.t.sol's three AMM safety properties were unreachable by
    // path no matter what the name filter said. A path/contract filter here
    // recreates that half while every name-based assertion above stays green,
    // so it has to be rejected on its own.
    expect(
      body,
      'the fuzz job scopes forge by path/contract — harnesses outside that scope stop running while the name selection still looks correct',
    ).not.toMatch(/--(?:no-)?match-(?:path|contract)/);
  });

  it('is a required dependency of the aggregate check', () => {
    const name = fuzzJob().name;
    const agg = jobs().find((j) => j.name === 'all-tests-pass');
    expect(agg, 'contracts-ci.yml has no all-tests-pass aggregator').toBeDefined();
    const needs = /^\s*needs:\s*\[([^\]]*)\]/m.exec(agg!.body);
    expect(needs, 'all-tests-pass has no needs: [...] list').not.toBeNull();
    expect(
      needs![1].split(',').map((s) => s.trim()),
      'the fuzz job is not in all-tests-pass needs — branch protection would not see it fail',
    ).toContain(name);
    // `needs` alone is not enough: with `if: always()` a failed dependency does
    // not fail the aggregator unless its result is inspected. Either
    // dereference form counts — a hyphenated job id needs bracket notation.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(
      new RegExp(`needs(?:\\.${escaped}|\\[['"]${escaped}['"]\\])\\.result`).test(agg!.body),
      "all-tests-pass never inspects the fuzz job's result",
    ).toBe(true);
  });

  it('binds its selection via env:, never `${{ }}` inside run: (command injection)', () => {
    // `${{ }}` is textual substitution performed BEFORE bash parses the script,
    // so any interpolated value is shell source, not data. Comment lines are
    // NOT stripped here on purpose: an interpolated value containing a newline
    // escapes a shell comment just as readily as a quote.
    //
    // Both YAML forms are collected — a single-line `run: cmd` is exactly where
    // an interpolation is easiest to slip in unnoticed.
    const lines = fuzzJob().body.split('\n');
    const runs: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s*)run:\s*(.*)$/.exec(lines[i]);
      if (!m) continue;
      const [, indent, rest] = m;
      if (!/^[|>][-+]?\d*$/.test(rest.trim()) && rest.trim() !== '') {
        runs.push(rest);
        continue;
      }
      let block = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() !== '' && !lines[j].startsWith(`${indent} `)) break;
        block += `${lines[j]}\n`;
      }
      runs.push(block);
    }
    expect(runs.length, 'the fuzz job has no run: steps at all').toBeGreaterThan(0);
    for (const script of runs) {
      expect(script, 'a run: script interpolates ${{ }} — bind via env: instead').not.toContain('${{');
    }
  });
});

describe('frontend npm installs do not execute dependency lifecycle scripts', () => {
  const settings = (): Map<string, string> => {
    const map = new Map<string, string>();
    for (const raw of readFileSync(NPMRC, 'utf-8').split(/\r?\n/)) {
      const line = raw.trim();
      if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      map.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    return map;
  };

  it('sets ignore-scripts=true', () => {
    expect(
      settings().get('ignore-scripts'),
      'frontend/.npmrc does not disable install scripts — dependencies execute Node on the runner that holds the service key',
    ).toBe('true');
  });

  it('keeps the pre-existing legacy-peer-deps setting', () => {
    // Regression guard: the hardening above must not drop what was already here.
    expect(settings().get('legacy-peer-deps')).toBe('true');
  });
});
