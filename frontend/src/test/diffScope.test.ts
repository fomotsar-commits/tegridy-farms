// The scope gate, and the property that makes a CI gate real.
//
// Four workflows here were path-filtered at the workflow level and paired with a
// `-not-applicable.yml` shim that republished the same check name. On PR #205
// two check runs named `Slither / Static analysis` existed at once: the real
// 4-minute analysis FAILED and the 2-second shim passed, and only the pass
// appeared in the PR's check list. A required-status rule on that name would
// have been satisfied by an echo.
//
// The shims are gone and the filter now lives in a `scope` job that calls this
// script. The property that has to hold, and that the rest of this file exists
// to hold down, is an ASYMMETRY: every uncertain answer RUNS the real job. A
// wrong "run" costs CI minutes; a wrong "skip" skips a gate and then reports
// success for having done so.
//
// The workflow SHAPE that keeps a second disagreeing run from existing at all is
// asserted next door in requiredCheckSynthesis.test.ts.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  inScope,
  parseFileList,
  patternToRegExp,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore -- plain .mjs guard script, deliberately untyped and outside src/
} from '../../../.github/scripts/diff-scope.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const WORKFLOW_DIR = join(REPO_ROOT, '.github', 'workflows');

/** The four that carry a `scope` job, i.e. the ones whose filter moved. */
const SCOPED = ['slither.yml', 'contracts-ci.yml', 'registry-onchain.yml', 'solana-ci.yml'];

describe('patternToRegExp — GitHub path patterns', () => {
  it('matches everything under a `**` prefix, including the bare directory', () => {
    const re = patternToRegExp('contracts/**');
    expect(re.test('contracts/src/Foo.sol')).toBe(true);
    expect(re.test('contracts/foundry.toml')).toBe(true);
    expect(re.test('contracts')).toBe(true);
  });

  it('does not let `contracts/**` match a sibling with the same prefix', () => {
    // The bug a naive `startsWith` has: `contracts-docs/` is not `contracts/`.
    const re = patternToRegExp('contracts/**');
    expect(re.test('contracts-docs/x.md')).toBe(false);
    expect(re.test('frontend/contracts/x.ts')).toBe(false);
  });

  it('keeps `*` inside one segment', () => {
    const re = patternToRegExp('scripts/*.mjs');
    expect(re.test('scripts/a.mjs')).toBe(true);
    expect(re.test('scripts/nested/a.mjs')).toBe(false);
  });

  it('escapes the dot rather than treating it as any-character', () => {
    const re = patternToRegExp('.github/contracts-test-slices.json');
    expect(re.test('.github/contracts-test-slices.json')).toBe(true);
    expect(re.test('agithub/contracts-test-slicesXjson')).toBe(false);
  });

  it('anchors both ends — a pattern is a whole path, not a substring', () => {
    const re = patternToRegExp('frontend/src/lib/contracts.ts');
    expect(re.test('frontend/src/lib/contracts.ts')).toBe(true);
    expect(re.test('x/frontend/src/lib/contracts.ts')).toBe(false);
    expect(re.test('frontend/src/lib/contracts.ts.bak')).toBe(false);
  });
});

describe('inScope — the asymmetry is the whole design', () => {
  const PATTERNS = ['contracts/**', 'frontend/src/lib/contracts.ts'];

  it('is true when any one file matches, even among many that do not', () => {
    expect(inScope(['README.md', 'a/b.ts', 'contracts/src/X.sol'], PATTERNS)).toBe(true);
  });

  it('is false only when nothing matches', () => {
    expect(inScope(['README.md', 'frontend/src/pages/Home.tsx'], PATTERNS)).toBe(false);
  });

  it.each([
    ['an empty file list', [] as string[], PATTERNS],
    ['a non-array file list', null as unknown as string[], PATTERNS],
    ['an empty pattern list', ['README.md'], [] as string[]],
    ['a non-array pattern list', ['README.md'], undefined as unknown as string[]],
  ])('RUNS the real job on %s', (_label, files, patterns) => {
    // Each of these is "we were told nothing". Answering `false` would skip the
    // gate and report success for having done so — the exact failure the shims
    // produced. There is no case where silence means "nothing to check".
    expect(inScope(files, patterns)).toBe(true);
  });

  it('reads a git/gh file list the way the workflow pipes it in', () => {
    const stdin = 'contracts/src/X.sol\nREADME.md\n\n  frontend/src/lib/contracts.ts  \n';
    expect(parseFileList(stdin)).toEqual([
      'contracts/src/X.sol',
      'README.md',
      'frontend/src/lib/contracts.ts',
    ]);
  });
});

describe('the scope jobs call this script correctly', () => {
  // Ownership note: the workflow SHAPE — no companions, no duplicate workflow
  // names, no `paths:` on a pull_request, no gate a broken scope job can skip —
  // is asserted in requiredCheckSynthesis.test.ts, which owns that question and
  // has the parser for it. What is left here is the seam between the workflows
  // and this script.

  it('the gate script the scope jobs call actually exists', () => {
    // Every scope job shells out to it. A rename that missed one would make that
    // job fail — which, by the fail-open rule above, runs the real job. Loud in
    // the right direction, but still worth catching here.
    expect(existsSync(join(REPO_ROOT, '.github', 'scripts', 'diff-scope.mjs'))).toBe(true);
    for (const file of SCOPED) {
      expect(readFileSync(join(WORKFLOW_DIR, file), 'utf-8')).toContain(
        'node .github/scripts/diff-scope.mjs',
      );
    }
  });

  it('every pattern the scope jobs pass is one the matcher can express', () => {
    // A pattern this file cannot compile would match nothing and skip silently.
    for (const file of SCOPED) {
      const text = readFileSync(join(WORKFLOW_DIR, file), 'utf-8');
      // `[^\n]*` rather than a trailing `\\?`: the LAST argument line ends with
      // `')` and not a continuation, and a regex that stopped there would check
      // every pattern except the last one of each list, silently.
      const call = /diff-scope\.mjs \\\n(?<args>(?: +'[^']+'[^\n]*\n)+)/.exec(text);
      expect(call, `${file} does not call diff-scope.mjs with a pattern list`).not.toBeNull();
      const patterns = [...call!.groups!.args.matchAll(/'([^']+)'/g)].map((m) => m[1]);
      expect(patterns.length).toBeGreaterThan(0);
      for (const p of patterns) {
        expect(() => patternToRegExp(p)).not.toThrow();
        // Every pattern must match at least the path it names, which catches a
        // pattern that was mangled on its way into the shell argument list.
        const literal = p.replace(/\/?\*\*$/, '/x').replace(/\*/g, 'x');
        expect(patternToRegExp(p).test(literal), `${file}: '${p}' matches nothing`).toBe(true);
      }
    }
  });
});
