// `npx tsc --noEmit` in this project typechecks NOTHING and exits 0.
//
// frontend/tsconfig.json is a SOLUTION file — `{"files": [], "references": [...]}`.
// Plain `tsc` reads it, finds an empty `files` array and no `include`, has no
// work to do, and reports success. It is the most convincing green tick in the
// repo and it means nothing.
//
// That is not hypothetical. On 2026-08-20 the tree carried 27 real type errors —
// including a checkout that called an ERC-20 `transfer` its own ABI did not
// contain, so it would have thrown at the wallet and settled nothing — while
// `tsc --noEmit` had been reported clean after every build for a day. The
// command was wrong, not the code, and nobody checked what the gate measured.
//
// The correct command is `tsc -b`, which follows the references. ci.yml uses it
// and says why; `npm run precommit` uses it. This file exists so the trap is
// discoverable from the test suite rather than only from a comment in a YAML
// file, and so that flattening the solution file (which would make plain `tsc`
// work) cannot happen silently either — if you do that deliberately, this test
// tells you which other places to update.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(FRONTEND, '..');

/**
 * Reads a tsconfig, which is JSONC.
 *
 * Scans rather than regexing. The regex version of this broke on the first real
 * tsconfig it met: a `//` inside a string literal is not a comment, and blanking
 * it produced a string spanning a newline — which JSON.parse reports as a
 * control-character error pointing at a line that looks fine. Tracking string
 * state is a dozen lines and cannot be wrong in that way.
 */
function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf-8');
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && raw[i + 1] === '/') {
      while (i < raw.length && raw[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && raw[i + 1] === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  // Trailing commas are legal in tsconfig and not in JSON.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1')) as Record<string, unknown>;
}

// The second half of this file exists because the first half was not enough.
//
// The original guard asserted that every script and CI line ran `tsc -b`. They
// did — and `tsc -b` still checked no TEST file, because tsconfig.app.json
// excludes them and tsconfig.test.json was referenced by nothing. Asserting the
// command shape without asserting what it COVERS is the same mistake one level
// up, and it survived a full day and a guard written specifically about it.
//
// So: assert coverage, not spelling.

describe('the typecheck actually covers the files people write', () => {
  it('the solution references a project that includes test files', () => {
    const solution = readJsonc(join(FRONTEND, 'tsconfig.json'));
    const refs = (solution.references as { path: string }[]).map((r) => r.path);

    const coversTests = refs.some((p) => {
      const cfg = readJsonc(join(FRONTEND, p));
      const include = (cfg.include as string[] | undefined) ?? [];
      const exclude = (cfg.exclude as string[] | undefined) ?? [];
      const includesTests = include.some((g) => /\.test\.|(^|\/)src\/test/.test(g));
      const excludesTests = exclude.some((g) => /\.test\./.test(g));
      return includesTests && !excludesTests;
    });

    expect(
      coversTests,
      'no referenced project includes *.test.* files, so `tsc -b` typechecks none of them. ' +
        'That is exactly the gap that hid 53 errors — including a playwright option that was ' +
        'silently doing nothing and several tests passing for the wrong reason.',
    ).toBe(true);
  });

  it('every referenced project is a real file', () => {
    // A reference to a path that does not exist makes `tsc -b` fail loudly rather
    // than quietly, which is fine — but a typo'd path that happens to resolve
    // somewhere harmless would not. Pin that each one is present.
    const solution = readJsonc(join(FRONTEND, 'tsconfig.json'));
    for (const { path } of solution.references as { path: string }[]) {
      expect(existsSync(join(FRONTEND, path)), `${path} is referenced but missing`).toBe(true);
    }
  });
});

describe('the typecheck command is the one that actually checks files', () => {
  it('tsconfig.json is a solution file, so plain `tsc` has no work to do', () => {
    const cfg = readJsonc(join(FRONTEND, 'tsconfig.json'));
    // If either half of this changes, plain `tsc --noEmit` may start meaning
    // something — and every comment and script that calls it a trap needs an edit.
    expect(cfg.files, 'tsconfig.json no longer has an empty `files`').toEqual([]);
    expect(cfg.include, 'tsconfig.json gained an `include`').toBeUndefined();
    expect(Array.isArray(cfg.references)).toBe(true);
    expect((cfg.references as unknown[]).length).toBeGreaterThan(0);
  });

  it('package.json checks types with -b, never with a bare tsc', () => {
    const pkg = JSON.parse(readFileSync(join(FRONTEND, 'package.json'), 'utf-8')) as {
      scripts: Record<string, string>;
    };
    const typeChecking = Object.entries(pkg.scripts).filter(([, cmd]) => /\btsc\b/.test(cmd));
    expect(typeChecking.length, 'no script runs tsc at all').toBeGreaterThan(0);
    for (const [name, cmd] of typeChecking) {
      expect(
        cmd,
        `the "${name}" script runs tsc without -b, so it typechecks zero files and always passes`,
      ).toMatch(/\btsc\s+-b\b/);
    }
  });

  it('CI checks types with -b', () => {
    const ci = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
    expect(existsSync(ci)).toBe(true);
    const src = readFileSync(ci, 'utf-8');
    const tscLines = src
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /\btsc\b/.test(l) && !l.startsWith('#'));
    expect(tscLines.length, 'ci.yml no longer runs tsc').toBeGreaterThan(0);
    for (const line of tscLines) {
      expect(line, `ci.yml runs a bare tsc, which checks nothing: ${line}`).toMatch(/\btsc\s+-b\b/);
    }
  });
});
