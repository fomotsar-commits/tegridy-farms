// The ratchet on the ratchet.
//
// .github/workflows/contracts-coverage.yml refuses to run without
// .github/coverage-floor.json — deliberately, so an unarmed gate cannot pass
// by default. Arming it created a second failure mode the workflow cannot see:
// the number in that file is not checked against anything. Someone can commit
// a floor nobody measured. Too high and the cron is permanently red, which
// ends with the cron being deleted; that is how this repo lost coverage
// reporting the first time.
//
// So the file carries provenance next to the floor — `measured` and
// `measuredOn`, the last real `forge coverage` run — and this suite enforces
// the only two rules that make the floor a fact rather than a wish:
//
//   * a floor may never exceed the last measurement;
//   * while nothing has been measured, the floor must be 0.
//
// The floor is armed at the owner's 75. The workflow still emits a ::warning::
// and says so in its run summary whenever the floor is 0, rather than
// presenting an unarmed green check as coverage.

import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FLOOR_PATH = join(REPO_ROOT, '.github', 'coverage-floor.json');
const WORKFLOW_PATH = join(REPO_ROOT, '.github', 'workflows', 'contracts-coverage.yml');

const floor = () => JSON.parse(readFileSync(FLOOR_PATH, 'utf-8'));

describe('.github/coverage-floor.json', () => {
  it('exists — without it the weekly job hard-fails as unarmed', () => {
    expect(existsSync(FLOOR_PATH)).toBe(true);
  });

  it('carries the one key the workflow reads, as a number', () => {
    // contracts-coverage.yml: json.load(...)["lines"]. A string here would
    // reach the float() comparison and blow up mid-run.
    expect(typeof floor().lines).toBe('number');
  });

  it('keeps the floor inside 0..100', () => {
    expect(floor().lines).toBeGreaterThanOrEqual(0);
    expect(floor().lines).toBeLessThanOrEqual(100);
  });

  it('never claims a floor above the last real measurement', () => {
    const f = floor();
    if (f.measured === null || f.measured === undefined) return;
    expect(
      f.lines,
      'the committed floor is higher than the coverage anyone has actually measured. That is a ' +
        'permanently red cron, and a permanently red cron gets deleted.',
    ).toBeLessThanOrEqual(f.measured);
  });

  it('stays armed at the 75 the owner chose', () => {
    // Without this, resetting `lines` to 0 passes every other test here and the cron
    // goes back to enforcing nothing. Lower it only by editing this line, on purpose.
    expect(floor().lines).toBeGreaterThanOrEqual(75);
  });

  it('stays at 0 while nothing has been measured', () => {
    const f = floor();
    if (f.measured !== null && f.measured !== undefined) return;
    expect(
      f.lines,
      'measured is null, so no forge coverage run backs this number. Either run the workflow with ' +
        'update_floor and record the result in measured/measuredOn, or leave lines at 0.',
    ).toBe(0);
  });

  it('records provenance for any non-zero floor', () => {
    const f = floor();
    if (f.lines === 0) return;
    expect(f.measuredOn, 'a floor with no measurement date cannot be audited').toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('the workflow discloses when the ratchet is not armed', () => {
  const source = () => readFileSync(WORKFLOW_PATH, 'utf-8');

  it('warns on a zero floor instead of presenting the run as a coverage pass', () => {
    expect(
      source(),
      'a floor of 0 makes the comparison unfailable. The run has to say so, or its green means ' +
        '"no opinion" while looking like "covered".',
    ).toMatch(/::warning title=Coverage ratchet not armed/);
  });

  it('still refuses to run on an empty measurement', () => {
    // The guards that keep a broken `forge coverage` from reading as 0%.
    expect(source()).toMatch(/no src\/ files appear in lcov\.info/);
    expect(source()).toMatch(/nothing was measured/);
  });

  it('still hard-fails when the floor file is absent', () => {
    expect(source()).toMatch(/Coverage floor not armed/);
  });
});

// One `forge coverage` over the whole suite compiles ~480 files under --ir-minimum and is
// killed at about 15 GB on a 16 GB runner (2026-10-19, with the Yul stack-too-deep in
// TegridyTokenURIReader.sol fixed by leaving it out). The workflow therefore runs one job
// per test slice and merges. Each pin below is a way that arrangement goes quietly wrong.
describe('the coverage workflow measures slice by slice and refuses a partial number', () => {
  // Comment lines are not code: a pin must not pass on a sentence that mentions the thing.
  const code = () =>
    readFileSync(WORKFLOW_PATH, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*#/.test(l))
      .join('\n');

  it('builds its matrix from the test-slice manifest, the one list contracts-ci.yml also runs', () => {
    expect(code()).toMatch(/check-test-slice-coverage\.mjs --emit-matrix/);
    expect(code()).toMatch(/matrix:\s*\$\{\{\s*fromJSON\(needs\.slices\.outputs\.matrix\)\s*\}\}/);
  });

  it('compiles only its own slice: every other test file is --skipped', () => {
    // Without the skip, `forge coverage` compiles every test file whatever --match-path says,
    // which is the run that was killed for memory.
    expect(code()).toMatch(/check-test-slice-coverage\.mjs --expect "\$SLICE"/);
    expect(code()).toMatch(/comm -23 \/tmp\/all\.txt \/tmp\/keep\.txt/);
    expect(code()).toMatch(/SKIPS\+=\(--skip "\$f"\)/);
  });

  it('keeps --ir-minimum and leaves the scripts out of the compile', () => {
    expect(code()).toMatch(/forge coverage --ir-minimum /);
    expect(code()).toMatch(/SKIPS=\(--skip script\)/);
  });

  it('names only files that still exist on the list of what cannot be built', () => {
    // A skip of a renamed file silently skips nothing, and the Yul error comes back.
    const list = /UNBUILDABLE=\(([^)]*)\)/.exec(code());
    expect(list, 'the workflow has no UNBUILDABLE list').not.toBeNull();
    const files = list![1].split(/\s+/).filter(Boolean);
    expect(files).toContain('src/TegridyTokenURIReader.sol');
    for (const f of files) {
      expect(existsSync(join(REPO_ROOT, 'contracts', f)), `${f} is on the skip list and is gone`).toBe(true);
    }
  });

  it('excludes the optimized-size tests, and a test contract of that name exists', () => {
    expect(code()).toMatch(/--no-match-contract 'EIP170Size'/);
    const sized = readdirSync(join(REPO_ROOT, 'contracts', 'test')).filter((f) => /EIP170Size\.t\.sol$/.test(f));
    expect(sized.length, 'no EIP170Size test left: the exclusion matches nothing').toBeGreaterThan(0);
  });

  it('merges nothing unless every slice finished, and counts the reports it merges', () => {
    // A number over part of the suite would read as a coverage drop and trip the floor.
    expect(code()).toMatch(/\$COVERAGE_RESULT" != "success"/);
    expect(code()).toMatch(/needs\.coverage\.result/);
    expect(code()).toMatch(/\[ "\$FOUND" = "\$EXPECTED" \]/);
  });

  it('joins the slices with the tested lcov merge', () => {
    expect(code()).toMatch(/node \.\.\/scripts\/lib\/lcov-merge\.mjs lcov\.info slices\/\*\/lcov\.info/);
    expect(existsSync(join(REPO_ROOT, 'scripts', 'lib', 'lcov-merge.mjs'))).toBe(true);
    expect(existsSync(join(REPO_ROOT, 'scripts', 'lib', 'lcov-merge.test.mjs'))).toBe(true);
  });
});
