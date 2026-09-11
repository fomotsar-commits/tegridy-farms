/**
 * WAVE SEVEN, element I, ruling 1: WHO MAY DECLARE A RECORD.
 *
 * e2e/em-dash-zero.spec.ts skips any subtree marked `data-record`, by
 * structure, because a record keeps its words. That skip is only as narrow as
 * the set of places allowed to use it. The island named two records, /changelog
 * and /contracts, and this pins exactly those two files, one subtree each. A
 * third declaration anywhere in src/ reds here before it can quietly take a
 * page's copy out of the count.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const DECLARES = /data-record\s*=/g;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\.(tsx?|jsx?)$/.test(name) ? [full] : [];
  });
}

const declaring = walk(SRC)
  .map((file) => ({
    file: relative(SRC, file).split(sep).join('/'),
    n: (readFileSync(file, 'utf8').match(DECLARES) ?? []).length,
  }))
  .filter((f) => f.n > 0);

describe('records (ruling 1)', () => {
  it('only the two records the island named may declare one', () => {
    expect(declaring.map((f) => f.file).sort()).toEqual(['pages/ChangelogPage.tsx', 'pages/ContractsPage.tsx']);
  });

  it('each declares exactly one record subtree', () => {
    for (const f of declaring) expect(f.n, f.file).toBe(1);
  });
});
