// PERF-11. vercel.json gave long-lived caching to /assets, /fonts and /art, and
// to nothing else. /splash — 7.3 MB of loader artwork, individual files up to
// 637 KB — fell to the platform default, which revalidates on every request, so
// a repeat visitor paid a round trip per splash image on every visit. So did
// /nakamigos (2.3 MB) and /videos (1.4 MB).
//
// This is derived from the REAL public/ tree rather than from a list of names,
// so a new media directory added tomorrow fails here instead of quietly
// shipping uncached. If a new directory genuinely must revalidate, it goes in
// MUST_REVALIDATE with the reason — which is a decision someone made, not a
// default nobody noticed.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

const config = JSON.parse(readFileSync(join(FRONTEND, 'vercel.json'), 'utf8')) as {
  headers: HeaderRule[];
};

/**
 * Directories under public/ that must NOT be cached, each with its reason.
 * `.well-known` serves verification documents that are rotated deliberately and
 * read once; caching one for a week is how a rotation fails to take effect.
 */
const MUST_REVALIDATE = new Set(['.well-known']);

function publicDirs(): string[] {
  const root = join(FRONTEND, 'public');
  return readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory());
}

/** The Cache-Control a rule of the form `/<dir>/(.*)` grants, or null. */
function cacheControlFor(dir: string): string | null {
  const rule = config.headers.find((h) => h.source === `/${dir}/(.*)`);
  return rule?.headers.find((h) => h.key === 'Cache-Control')?.value ?? null;
}

describe('every static media directory under public/ is cacheable', () => {
  it('finds directories to check at all, so a green result is not an empty one', () => {
    expect(publicDirs().length).toBeGreaterThan(3);
  });

  it.each(publicDirs().filter((d) => !MUST_REVALIDATE.has(d)))(
    'public/%s has a long-lived Cache-Control rule',
    (dir) => {
      const value = cacheControlFor(dir);
      expect(value, `public/${dir} has no /${dir}/(.*) Cache-Control rule in vercel.json`).not.toBeNull();

      // "public" and a max-age of at least a day. Anything shorter is a round
      // trip per visit for bytes whose whole point is that they do not change.
      expect(value).toContain('public');
      const maxAge = Number(/max-age=(\d+)/.exec(value ?? '')?.[1] ?? 0);
      expect(maxAge).toBeGreaterThanOrEqual(86_400);
    },
  );
});
