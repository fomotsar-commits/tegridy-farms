// @vitest-environment node
//
// Every "read the source" link goes through our own domain (SOURCE_URL and
// SOURCE_ISSUES_URL in lib/constants.ts), and the /source redirects in
// frontend/vercel.json pick the git host. Moving hosts is one vercel.json edit.
// GitLab answers a path it does not have with a 302 to the repo root, not a 404,
// so a wrong path looks fine to a click: every fixed path is checked against git.

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITE_URL, SOURCE_URL, SOURCE_ISSUES_URL } from '../lib/constants';
import { collectHeldThrough } from '../lib/heldThrough';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(FRONTEND, '..');
const TRACKED = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
const read = (repoPath: string) => readFileSync(join(REPO_ROOT, repoPath), 'utf-8');
const isTest = (f: string) => /\.test\.|\/__tests__\//.test(f);

type Redirect = {
  source: string;
  destination: string;
  permanent?: boolean;
  statusCode?: number;
  has?: unknown[];
  missing?: unknown[];
};
const REDIRECTS: Redirect[] = JSON.parse(read('frontend/vercel.json')).redirects ?? [];
const SOURCE_RULES = REDIRECTS.filter((r) => /^\/source(\/|-|$)/.test(r.source));
const ruleFor = (source: string) => SOURCE_RULES.find((r) => r.source === source);

/** The repo's home on the git host. A host move changes this value and nothing in the app. */
const HOST_REPO = ruleFor('/source')?.destination ?? '(no /source rule)';

/** The subset of Vercel's path syntax this file uses: literals, (.*), :name and /:name*. */
function toRegExp(source: string): RegExp {
  let re = '';
  for (const part of source.split(/(\(\.\*\)|\/:[A-Za-z]+\*|:[A-Za-z]+)/)) {
    if (part === '(.*)') re += '(.*)';
    else if (/^\/:[A-Za-z]+\*$/.test(part)) re += '(?:/(.*))?';
    else if (/^:[A-Za-z]+$/.test(part)) re += '([^/]+)';
    else if (/[()[\]{}*+?]/.test(part)) throw new Error(`unsupported redirect pattern ${source}: extend toRegExp`);
    else re += part.replace(/[.\\^$|]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** The redirect Vercel applies to a plain request for `url` on the canonical host: the first match wins. */
function route(url: string): Redirect | undefined {
  const { pathname } = new URL(url);
  // Conditional rules need another host, header or cookie.
  return REDIRECTS.find((r) => !r.has && !r.missing && toRegExp(r.source).test(pathname));
}

// The app's own code, not its tests.
const APP_FILES = TRACKED.filter((f) => /^frontend\/src\/.*\.(ts|tsx|js|jsx)$/.test(f) && !isTest(f));

/** A source link the app builds. `path` is the repo path it names: '' for the root, null if unknown until runtime. */
type Link = { file: string; url: string; path: string | null };

function emittedLinks(): Link[] {
  const links: Link[] = [
    { file: 'frontend/src/lib/constants.ts', url: SOURCE_URL, path: '' },
    { file: 'frontend/src/lib/constants.ts', url: SOURCE_ISSUES_URL, path: null },
  ];
  for (const file of APP_FILES) {
    const code = read(file)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/?\*|\{\/\*)/.test(l)) // comment lines emit nothing
      .join('\n');
    for (const m of code.matchAll(/\$\{SOURCE_URL\}([^`]*)`/g)) {
      const suffix = m[1];
      if (suffix === '' || suffix.startsWith('#')) {
        links.push({ file, url: SOURCE_URL, path: '' });
      } else if (suffix.startsWith('/') && suffix.includes('${')) {
        // A path built at runtime is checked for coverage only.
        links.push({ file, url: `${SOURCE_URL}/runtime/Example.sol`, path: null });
      } else if (suffix.startsWith('/')) {
        const path = suffix.slice(1).replace(/[?#].*$/, '');
        links.push({ file, url: `${SOURCE_URL}/${path}`, path });
      } else {
        links.push({ file, url: `${SOURCE_URL}${suffix}`, path: 'malformed' });
      }
    }
  }
  return links;
}

describe('no user-facing file links our repo on a git host directly', () => {
  // Hosts come and go; our domain stays. The live host is named only in vercel.json.
  const needles = ['github.com/fomotsar-commits', HOST_REPO.replace(/^https?:\/\//, '')];
  const files = TRACKED.filter(
    (f) =>
      (/^frontend\/(src|public|api|scripts)\//.test(f) || f === 'frontend/index.html') &&
      !isTest(f) &&
      /\.(ts|tsx|js|jsx|mjs|cjs|json|html|txt|css|svg|xml|webmanifest)$/.test(f),
  );

  it('scans the files it means to scan', () => {
    expect(files).toContain('frontend/src/lib/constants.ts');
    expect(files).toContain('frontend/public/.well-known/security.txt');
    expect(files).toContain('frontend/scripts/held-through.mjs');
    expect(HOST_REPO).toMatch(/^https:\/\/[^/]+\/[^/]+\/[^/]+$/);
  });

  it('finds no git-host URL for this repo in the app, its public files or its scripts', () => {
    const hits = files.flatMap((f) =>
      read(f)
        .split('\n')
        .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
        .filter(({ line }) => needles.some((n) => line.toLowerCase().includes(n.toLowerCase())))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(hits, `use SOURCE_URL / SOURCE_ISSUES_URL instead:\n${hits.join('\n')}`).toEqual([]);
  });

  it('builds every /source link from the two constants, never by hand', () => {
    const handBuilt = APP_FILES.filter((f) => f !== 'frontend/src/lib/constants.ts').flatMap((f) =>
      read(f)
        .split('\n')
        .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
        .filter(({ line }) => /['"`](?:https?:\/\/[^'"`\s]+)?\/source(?:-issues)?[/#?'"`]|\$\{SITE_URL\}\/source/.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(handBuilt).toEqual([]);
  });
});

describe('the /source redirects in vercel.json', () => {
  it('are exactly the three rules the app relies on', () => {
    expect(SOURCE_RULES.map((r) => r.source)).toEqual(['/source', '/source-issues', '/source/:path*']);
  });

  it('are temporary (307), so no browser caches a host we may leave', () => {
    for (const r of SOURCE_RULES) {
      expect(r.permanent, r.source).toBe(false);
      expect(r.statusCode, r.source).toBeUndefined();
    }
  });

  it('apply on every host and every request', () => {
    for (const r of SOURCE_RULES) expect(r.has ?? r.missing, r.source).toBeUndefined();
  });

  it('all land on one repo, so a host move cannot half-land', () => {
    const elsewhere = SOURCE_RULES.filter((r) => r.destination !== HOST_REPO && !r.destination.startsWith(`${HOST_REPO}/`));
    expect(elsewhere.map((r) => `${r.source} -> ${r.destination}`)).toEqual([]);
  });
});

describe('every source link the app emits', () => {
  const links = emittedLinks();

  it('is first-party', () => {
    expect(SOURCE_URL).toBe(`${SITE_URL}/source`);
    expect(SOURCE_ISSUES_URL).toBe(`${SITE_URL}/source-issues`);
    // A page that linked nothing would pass the checks below vacuously.
    expect(links.filter((l) => l.path).length).toBeGreaterThan(5);
    expect(links.filter((l) => l.path === 'malformed').map((l) => `${l.file}: ${l.url}`)).toEqual([]);
  });

  it('is served by a /source redirect, not by the app shell', () => {
    const unserved = links
      .map((l) => ({ ...l, to: route(l.url) }))
      .filter(({ to }) => !to || !SOURCE_RULES.includes(to))
      .map(({ file, url, to }) => `${file}: ${url} -> ${to ? to.source : 'the SPA fallback (200 HTML)'}`);
    expect(unserved).toEqual([]);
  });

  it('names a path git tracks, file or directory', () => {
    const tracked = new Set(TRACKED);
    const isDir = (p: string) => TRACKED.some((f) => f.startsWith(`${p.replace(/\/$/, '')}/`));
    const missing = links
      .filter((l): l is Link & { path: string } => !!l.path && l.path !== 'malformed')
      .filter(({ path }) => !tracked.has(path) && !isDir(path))
      .map(({ file, path }) => `${file}: ${path}`);
    expect(missing, 'the git host would silently show the repo root for these').toEqual([]);
  });

  it('includes the one held-through.json gives other sites', () => {
    expect(collectHeldThrough().repository).toBe(SOURCE_URL);
  });
});
