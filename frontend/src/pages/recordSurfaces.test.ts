/**
 * WAVE SEVEN: WHO MAY TAKE COPY OUT OF THE VENUE'S COUNT, BY STRUCTURE.
 *
 * Three markers take a subtree out of the venue-voice guards (e2e/em-dash-zero,
 * e2e/voice-census): `data-record` (ruling 1: a dated record keeps its words),
 * `data-voice="toweli"` (ruling 2: TOWELI's protocol, under its own name,
 * on a venue page), and `data-unread-ledger` (a report of a failed read, whose
 * words and length are a third party's behaviour rather than this repo's copy).
 * Each skip is only as narrow as the set of places allowed to
 * use it, so this pins those places exactly. A new
 * declaration anywhere in src/ reds here before it can quietly take a page's
 * copy out of the count.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\.(tsx?|jsx?)$/.test(name) ? [full] : [];
  });
}

const FILES = walk(SRC).map((file) => ({
  file: relative(SRC, file).split(sep).join('/'),
  src: readFileSync(file, 'utf8'),
}));

function declaring(marker: RegExp) {
  return FILES.map((f) => ({ file: f.file, n: (f.src.match(marker) ?? []).length })).filter((f) => f.n > 0);
}

describe('records (ruling 1)', () => {
  const records = declaring(/data-record\s*=/g);

  it('only the two records the island named may declare one', () => {
    expect(records.map((f) => f.file).sort()).toEqual(['pages/ChangelogPage.tsx', 'pages/ContractsPage.tsx']);
  });

  it('each declares exactly one record subtree', () => {
    for (const f of records) expect(f.n, f.file).toBe(1);
  });
});

describe('unread-read ledgers', () => {
  const ledgers = declaring(/data-unread-ledger\s*=/g);

  it('only the Island Cup coverage notice reports a read this way', () => {
    expect(ledgers.map((f) => f.file).sort()).toEqual([
      'components/competitions/CupCoverageNotice.tsx',
    ]);
  });

  // THREE, and each one is argued in that file's header: the heading (five
  // sentences by status), the per-pool chip list (one entry per resident pool
  // that failed) and the distinct-failure list. Widening this to the whole
  // notice would also stop guarding CUP_WASH_LIMIT and CUP_NO_ARCHIVE, which
  // are ordinary written copy sitting in the same box.
  it('marks the three read-derived nodes and nothing else in the box', () => {
    for (const f of ledgers) expect(f.n, f.file).toBe(3);
  });
});

describe('TOWELI sections on venue pages (ruling 2)', () => {
  const sections = declaring(/data-voice\s*=\s*["']toweli["']/g);

  it("only pages that moved TOWELI's protocol under its own name declare one", () => {
    expect(sections.map((f) => f.file).sort()).toEqual(['pages/RisksPage.tsx', 'pages/SecurityPage.tsx']);
  });

  it('each declares exactly one TOWELI section', () => {
    for (const f of sections) expect(f.n, f.file).toBe(1);
  });
});
