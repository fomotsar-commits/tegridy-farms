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

/** Strips // and /* *\/ comments so JSON.parse can read a tsconfig. */
function readJsonc(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  return JSON.parse(raw) as Record<string, unknown>;
}

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
