// The indexer is its own service, so no api/ test reads its CORS allowlist. This one does:
// the list admits the canonical host and no memetic.fun host, which serves the Island Lab.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITE_URL } from '../lib/constants';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SOURCE = join(REPO_ROOT, 'indexer', 'src', 'api', 'index.ts');

function indexerOrigins(): string[] {
  const block = readFileSync(SOURCE, 'utf-8').match(/const allowedOrigins = \[([\s\S]*?)\];/);
  if (!block) throw new Error('could not locate allowedOrigins in indexer/src/api/index.ts');
  return [...block[1].matchAll(/"(https?:\/\/[^"]+)"/g)].map((m) => m[1]);
}

describe('the indexer CORS allowlist', () => {
  const origins = indexerOrigins();

  it('parses, and admits the canonical host', () => {
    // Guards the guard: a regex that matched nothing would pass the next test vacuously.
    expect(origins).toContain(new URL(SITE_URL).origin);
  });

  it('names no memetic.fun host', () => {
    const lab = origins.filter((o) => /(^|\.)memetic\.fun$/.test(new URL(o).hostname));
    expect(lab).toEqual([]);
  });
});
