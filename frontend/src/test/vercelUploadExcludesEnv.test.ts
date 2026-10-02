// A manual `vercel --prod` from the repo root uploads whatever `.vercelignore` does not
// exclude. This pins that no env file can ride along in that upload.
//
// WHY THIS IS NOT PARANOIA. `.vercelignore` opens with `*` and then re-includes the whole
// frontend tree with `!frontend` / `!frontend/**`. Under last-match-wins semantics that
// makes the file an ALLOW-list inverted into a deny-list: anything under frontend/ that is
// not explicitly re-excluded afterwards gets uploaded. It used to re-exclude exactly two
// filenames, `frontend/.env` and `frontend/.env.local`. Every other env filename Vite
// recognises — `.env.production`, `.env.production.local`, `.env.development.local`, and any
// `.env.<mode>` a future deploy introduces — would therefore have been uploaded WITH ITS
// VALUES the first time someone created one. Nothing had leaked, because only `.env` and
// `.env.example` existed; the hole was one `cp .env .env.production` away from being real.
//
// The invariant is the BEHAVIOUR, not the literal pattern: this evaluates .vercelignore's
// own last-match-wins semantics against a roster of candidate filenames. Rewriting
// `frontend/.env*` as `frontend/.env**` or as an equivalent set of lines keeps it green;
// narrowing it back to a list of specific names does not.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const IGNORE_FILE = join(REPO_ROOT, '.vercelignore');

type Rule = { negated: boolean; re: RegExp };

/**
 * One .vercelignore/.gitignore pattern as a matcher.
 *
 * `*` matches within a path segment, `**` across segments, and a pattern with no wildcard
 * matches that path or anything beneath it (so `frontend/node_modules` covers its contents).
 */
function compile(pattern: string): Rule {
  const negated = pattern.startsWith('!');
  const body = negated ? pattern.slice(1) : pattern;
  // Split on `**` FIRST, translate each piece, then join the pieces with `.*`. No
  // placeholder character is needed to protect `**` from the single-`*` rule, which is
  // what the obvious one-chain version reaches for — and this file's first version did,
  // with a NUL that landed in the source as a raw control byte (eslint no-control-regex).
  const escaped = body
    .split('**')
    .map((piece) => piece.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
    .join('.*');
  // Anchored, and a bare path also matches everything under it.
  return { negated, re: new RegExp(`^${escaped}(?:/.*)?$`) };
}

/** Is `path` excluded from the upload? Last matching rule wins, as git and Vercel do it. */
function isExcluded(path: string, rules: Rule[]): boolean {
  let excluded = false;
  for (const r of rules) if (r.re.test(path)) excluded = !r.negated;
  return excluded;
}

const rules = (): Rule[] =>
  readFileSync(IGNORE_FILE, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map(compile);

// Every env filename Vite loads, plus the ones a deploy is most likely to invent.
const ENV_FILES = [
  'frontend/.env',
  'frontend/.env.local',
  'frontend/.env.production',
  'frontend/.env.production.local',
  'frontend/.env.development',
  'frontend/.env.development.local',
  'frontend/.env.staging',
  'frontend/.env.staging.local',
  'frontend/.env.preview',
  'frontend/.env.example',
];

describe('a repo-root vercel deploy uploads no env file', () => {
  it('excludes every env filename, not just the two that happen to exist', () => {
    const rs = rules();
    const uploaded = ENV_FILES.filter((f) => !isExcluded(f, rs));
    expect(uploaded).toEqual([]);
  });

  it('still uploads the app itself — the guard above must not pass by excluding everything', () => {
    // Without this, `frontend/**` on its own line would satisfy the test above while
    // breaking every deploy. The exclusion has to be narrow as well as complete.
    const rs = rules();
    for (const kept of [
      'frontend/package.json',
      'frontend/index.html',
      'frontend/src/main.tsx',
      'frontend/api/alchemy.js',
      'frontend/vite.config.ts',
    ]) {
      expect(isExcluded(kept, rs), kept).toBe(false);
    }
  });

  it('the matcher itself distinguishes excluded from included', () => {
    // Guard on the guard: a compile() that matched nothing would make both tests above
    // vacuous in opposite directions, and neither would say so.
    const rs = [compile('*'), compile('!frontend'), compile('!frontend/**'), compile('frontend/.env*')];
    expect(isExcluded('frontend/.env.production', rs)).toBe(true);
    expect(isExcluded('frontend/src/main.tsx', rs)).toBe(false);
    expect(isExcluded('contracts/foundry.toml', rs)).toBe(true);
  });
});
