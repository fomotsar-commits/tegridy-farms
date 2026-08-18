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
// It is 0 today. `forge coverage --ir-minimum` could not be run at arming
// time (see the file's own _readme), so no honest number exists yet. The
// workflow emits a ::warning:: and says so in its run summary whenever the
// floor is 0, rather than presenting an unarmed green check as coverage.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
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
