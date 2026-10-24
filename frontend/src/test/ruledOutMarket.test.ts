// @vitest-environment node
//
// Owner ruling, 2026-10-02: the venue stays clear of one Solana NFT market
// completely, because of an exploit there. No file the site ships may name it,
// link to it, read from it, proxy it, or let the CSP load anything from it.
//
// This walks everything the site is built and served from: src/, api/,
// middleware.js, vercel.json and index.html, this file included. The patterns
// are spelled so that this file's own text cannot match them, which is why no
// comment here writes the market's name out.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const RULED_OUT: { what: string; re: RegExp }[] = [
  // The name in any case and spacing, its domains, and identifiers built on it.
  { what: 'the market by name', re: /magic[\s_.-]*eden/i },
  // The server read this branch once added for it (/api/aggregator?resource=...).
  { what: 'the server read for it', re: /(^|[^a-z0-9])me[-]read([^a-z0-9]|$)/i },
];

const SHIPPED_DIRS = ['src', 'api'];
const SHIPPED_FILES = ['middleware.js', 'vercel.json', 'index.html'];

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    // statSync follows links, so a file OneDrive keeps as a reparse point is
    // still read as a file.
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (st.isFile()) out.push(full);
  }
}

function shippedFiles(): string[] {
  const out: string[] = [];
  for (const d of SHIPPED_DIRS) walk(join(FRONTEND, d), out);
  for (const f of SHIPPED_FILES) out.push(join(FRONTEND, f));
  return out;
}

const rel = (full: string) => relative(FRONTEND, full).split(sep).join('/');

describe('the ruled-out market appears nowhere the site ships from', () => {
  const files = shippedFiles();

  it('reads every shipped file, this one included (a scan of nothing is not a pass)', () => {
    const names = new Set(files.map(rel));
    expect(files.length).toBeGreaterThan(1000);
    for (const must of [
      'src/test/ruledOutMarket.test.ts',
      'src/nakamigos/constants.js',
      'src/nakamigos/lib/externalMarket.js',
      'api/aggregator.js',
      'middleware.js',
      'vercel.json',
      'index.html',
    ]) {
      expect(names.has(must), `${must} was not scanned`).toBe(true);
    }
  });

  for (const { what, re } of RULED_OUT) {
    it(`no shipped file names ${what}`, () => {
      const hits: string[] = [];
      for (const full of files) {
        const lines = readFileSync(full, 'utf-8').split('\n');
        lines.forEach((line, i) => {
          if (re.test(line)) hits.push(`${rel(full)}:${i + 1}: ${line.trim().slice(0, 120)}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }
});
