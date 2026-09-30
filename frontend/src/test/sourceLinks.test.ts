// @vitest-environment node
//
// Every "read the source" link goes through our own domain (SOURCE_URL in
// lib/constants.ts), and the /source redirects in frontend/vercel.json pick the git
// host, so moving hosts is one vercel.json edit. A wrong path is a 404 on GitHub but a
// 302 to the repo root on GitLab, so paths are checked against git, not the host:
// every literal path in the code, and every link the source-linking pages render.

import { describe, it, expect, vi } from 'vitest';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITE_URL, SOURCE_URL } from '../lib/constants';
import { collectHeldThrough } from '../lib/heldThrough';
import ContractsPage from '../pages/ContractsPage';
import SecurityPage from '../pages/SecurityPage';
import RisksPage from '../pages/RisksPage';
import TrustHubPage from '../pages/TrustHubPage';

vi.mock('../hooks/useSourceVerification', () => ({ useSourceVerification: () => ({}) }));
vi.mock('../components/ArtImg', () => ({ ArtImg: () => null }));
vi.mock('../components/PageArtBackdrop', () => ({ PageArtBackdrop: () => null }));

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REPO_ROOT = join(FRONTEND, '..');
const TRACKED = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
  .split('\n')
  .map((l) => l.trim())
  .filter(Boolean);
const TRACKED_SET = new Set(TRACKED);
const isTracked = (p: string) => TRACKED_SET.has(p) || TRACKED.some((f) => f.startsWith(`${p.replace(/\/$/, '')}/`));
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
const HOST_URL = /^https:\/\//.test(HOST_REPO) ? new URL(HOST_REPO) : undefined;

/** Each host's URL shapes: the table in docs/DEPLOY_RUNBOOK.md, "Moving the source links". */
const HOST_SHAPES: Record<string, { issues: string; file: string }> = {
  'gitlab.com': { issues: '/-/issues', file: '/-/blob/mvp-launch/:path*' },
  'bitbucket.org': { issues: '', file: '/src/mvp-launch/:path*' },
  'github.com': { issues: '/issues', file: '/blob/mvp-launch/:path*' },
};

/** Every home our repo has, primary and standby. The /source rules may point only at one
 *  of these, and the app links none of them directly. A new home joins this list once it
 *  is ours and public (docs/DEPLOY_RUNBOOK.md, "Moving the source links"). */
const OUR_REPOS = ['https://github.com/fomotsar-commits/tegridy-farms', 'https://gitlab.com/memetics-finance/tegridy-farms'];
const ownerOf = (repo: string) => /^https:\/\/[^/]+\/([^/]+)/.exec(repo)?.[1] ?? '(no owner)';

/** Each home's owner on every known host, so a copy we may add later is caught too. */
const OUR_REPO_URLS = [
  ...new Set([HOST_REPO, ...OUR_REPOS].flatMap((repo) => Object.keys(HOST_SHAPES).map((host) => `${host}/${ownerOf(repo)}`))),
];

/** The pages that link source, rendered so each link is checked where it ends up. */
const PAGES: Record<string, ComponentType> = {
  'frontend/src/pages/ContractsPage.tsx': ContractsPage,
  'frontend/src/pages/SecurityPage.tsx': SecurityPage,
  'frontend/src/pages/RisksPage.tsx': RisksPage,
  'frontend/src/pages/TrustHubPage.tsx': TrustHubPage,
};

/** /contracts rows that linked these before this guard; ship/2026-09-26 unlinks or renames
 *  each. The list only shrinks: an entry no page links, or that git now tracks, fails. */
const KNOWN_UNTRACKED = [
  'contracts/src/TOWELI.sol',
  'contracts/src/TegridyFeeHook.sol',
  'contracts/src/TokenURIReader.sol',
];

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

/** A use of SOURCE_URL. `path` is the repo path it names: '' for the root, null if built at
 *  runtime. `unchecked` says why this file cannot check it. */
type Use = { file: string; url: string; path: string | null; unchecked?: string };

function sourceUses(): Use[] {
  const uses: Use[] = [{ file: 'frontend/src/lib/constants.ts', url: SOURCE_URL, path: '' }];
  for (const file of APP_FILES.filter((f) => f !== 'frontend/src/lib/constants.ts')) {
    const code = read(file)
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/?\*|\{\/\*)/.test(l)) // comment lines emit nothing
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^import\b[\s\S]*?\bfrom\s+['"][^'"]+['"];?/gm, '');
    for (const m of code.matchAll(/\$\{SOURCE_URL\}([^`]*)`|\bSOURCE_URL\b/g)) {
      const at = `${file}: ${code.slice(m.index, m.index + 60).split('\n')[0]}`;
      if (m[1] !== undefined) {
        const suffix = m[1];
        if (suffix === '' || suffix.startsWith('#')) uses.push({ file, url: SOURCE_URL, path: '' });
        else if (suffix.startsWith('/') && suffix.includes('${')) {
          // A path built at runtime is checked where it renders, so only a rendered page may build one.
          uses.push({ file, url: `${SOURCE_URL}/runtime/Example.sol`, path: null, ...(PAGES[file] ? {} : { unchecked: at }) });
        } else if (suffix.startsWith('/')) {
          const path = suffix.slice(1).replace(/[?#].*$/, '');
          uses.push({ file, url: `${SOURCE_URL}/${path}`, path });
        } else uses.push({ file, url: SOURCE_URL, path: null, unchecked: at });
        continue;
      }
      // Bare, it may only be a whole value (`href: SOURCE_URL,` or `href={SOURCE_URL}`), never
      // concatenated, aliased or handed to a helper, where a path joins it unseen.
      const before = code.slice(0, m.index).trimEnd();
      const after = code.slice(m.index + m[0].length).trimStart();
      const whole = (before.endsWith(':') || (before.endsWith('{') && !before.endsWith('${'))) && /^([,};]|$)/.test(after);
      uses.push({ file, url: SOURCE_URL, path: '', ...(whole ? {} : { unchecked: at }) });
    }
  }
  return uses;
}

describe('no user-facing file links our repo on a git host directly', () => {
  // Hosts come and go; our domain stays. The live host is named only in vercel.json.
  const files = TRACKED.filter(
    (f) =>
      (/^frontend\/(src|public|api|scripts)\//.test(f) || f === 'frontend/index.html') &&
      !isTest(f) &&
      /\.(ts|tsx|js|jsx|mjs|cjs|json|html|txt|css|svg|xml|webmanifest)$/.test(f),
  );

  it('scans the files it means to scan, for every address the repo has', () => {
    expect(files).toContain('frontend/src/lib/constants.ts');
    expect(files).toContain('frontend/public/.well-known/security.txt');
    expect(files).toContain('frontend/scripts/held-through.mjs');
    expect(HOST_REPO).toMatch(/^https:\/\/[^/]+(\/[^/]+){2,}$/); // owner/repo, or a GitLab subgroup path
    for (const repo of [HOST_REPO, ...OUR_REPOS]) {
      expect(OUR_REPO_URLS).toContain(repo.replace(/^https:\/\//, '').split('/').slice(0, 2).join('/'));
    }
  });

  it('finds no git-host URL for this repo in the app, its public files or its scripts', () => {
    const hits = files.flatMap((f) =>
      read(f)
        .split('\n')
        .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
        .filter(({ line }) => OUR_REPO_URLS.some((n) => line.toLowerCase().includes(n.toLowerCase())))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(hits, `use SOURCE_URL instead:\n${hits.join('\n')}`).toEqual([]);
  });

  it('builds every /source link from SOURCE_URL, never by hand', () => {
    const handBuilt = APP_FILES.filter((f) => f !== 'frontend/src/lib/constants.ts').flatMap((f) =>
      read(f)
        .split('\n')
        .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
        .filter(({ line }) => /['"`](?:https?:\/\/[^'"`\s]+)?\/source(?:-issues)?[/#?'"`]|\$\{SITE_URL\}\/source/.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`),
    );
    expect(handBuilt).toEqual([]);
  });

  it('uses SOURCE_URL only in forms this file can check', () => {
    expect(sourceUses().flatMap((u) => (u.unchecked ? [u.unchecked] : []))).toEqual([]);
  });
});

describe('the /source redirects in vercel.json', () => {
  it('are exactly the rules the app and git clients rely on, in this order', () => {
    expect(SOURCE_RULES.map((r) => r.source)).toEqual(['/source', '/source-issues', '/source/info/refs', '/source/:path*']);
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

  it('point at a home of ours, never a name someone else could register', () => {
    // A typo in a failover sends every trust link on the site to whoever takes that name.
    expect(OUR_REPOS, `${HOST_REPO}: check it is ours and public, then add it to OUR_REPOS`).toContain(HOST_REPO);
  });

  it("use the host's own URL shapes, all on one repo", () => {
    const shape = HOST_SHAPES[HOST_URL?.host ?? ''];
    expect(shape, `${HOST_REPO}: add this host's shapes to HOST_SHAPES and the runbook table`).toBeTruthy();
    // Only a blob-style view turns a folder link into a tree; a raw view would 404 it.
    expect(ruleFor('/source/:path*')?.destination).toBe(`${HOST_REPO}${shape.file}`);
    expect(ruleFor('/source/info/refs')?.destination).toBe(`${HOST_REPO}.git/info/refs`);
    // A host with no issue list (Bitbucket) sends /source-issues to the repo root.
    expect([`${HOST_REPO}${shape.issues}`, HOST_REPO]).toContain(ruleFor('/source-issues')?.destination);
  });
});

describe('every source link written in the code', () => {
  const uses = sourceUses();

  it('is first-party', () => {
    expect(SOURCE_URL).toBe(`${SITE_URL}/source`);
    // A scan that found nothing would pass the checks below vacuously.
    expect(uses.filter((u) => u.path).length).toBeGreaterThan(5);
  });

  it('is served by a /source redirect, not by the app shell', () => {
    const unserved = uses
      .map((u) => ({ ...u, to: route(u.url) }))
      .filter(({ to }) => !to || !SOURCE_RULES.includes(to))
      .map(({ file, url, to }) => `${file}: ${url} -> ${to ? to.source : 'the SPA fallback (200 HTML)'}`);
    expect(unserved).toEqual([]);
  });

  it('names a path git tracks, file or directory', () => {
    const missing = uses
      .filter((u): u is Use & { path: string } => !!u.path && !isTracked(u.path))
      .map(({ file, path }) => `${file}: ${path}`);
    expect(missing, 'GitHub would answer 404 for these, and GitLab would quietly open the repo root').toEqual([]);
  });

  it('includes the one held-through.json gives other sites, and git can clone it', () => {
    const { repository } = collectHeldThrough();
    expect(repository).toBe(SOURCE_URL);
    // git asks <repository>/info/refs first; /source/:path* would answer with a web page.
    expect(route(`${repository}/info/refs?service=git-upload-pack`)?.destination).toBe(`${HOST_REPO}.git/info/refs`);
  });
});

describe('every source link the pages render', () => {
  // Server-rendered: the held-through read above needs the node environment.
  const rendered = Object.entries(PAGES).flatMap(([file, Page]) =>
    [...renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Page))).matchAll(/\shref="([^"]*)"/g)]
      .map((m) => m[1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&'))
      .filter((href) => href.startsWith(`${SITE_URL}/source`))
      .map((href) => ({ file, href })),
  );
  const pathOf = (href: string) =>
    href.startsWith(`${SOURCE_URL}/`) ? decodeURIComponent(href.slice(SOURCE_URL.length + 1)).replace(/[?#].*$/, '') : '';

  it('finds links on every page it renders', () => {
    for (const file of Object.keys(PAGES)) expect(rendered.filter((l) => l.file === file).length, file).toBeGreaterThan(0);
    expect(rendered.filter((l) => l.file.endsWith('ContractsPage.tsx')).length).toBeGreaterThan(20);
  });

  it('is served by a /source redirect', () => {
    const unserved = rendered
      .filter(({ href }) => {
        const to = route(href);
        return !to || !SOURCE_RULES.includes(to);
      })
      .map(({ file, href }) => `${file}: ${href}`);
    expect(unserved).toEqual([]);
  });

  it('never sends a reader to the issue list, which can be empty or missing', () => {
    // A new project's list is empty and Bitbucket has none: under a "remaining tasks"
    // label, an empty list reads as nothing left to do.
    const toIssues = rendered.filter(({ href }) => route(href)?.source === '/source-issues');
    expect(toIssues.map(({ file, href }) => `${file}: ${href}`)).toEqual([]);
  });

  it('names a path git tracks, file or directory', () => {
    const missing = rendered
      .map(({ file, href }) => ({ file, path: pathOf(href) }))
      .filter(({ path }) => path && !isTracked(path) && !KNOWN_UNTRACKED.includes(path))
      .map(({ file, path }) => `${file}: ${path}`);
    expect(missing, 'GitHub would answer 404 for these, and GitLab would quietly open the repo root').toEqual([]);
  });

  it('still needs every KNOWN_UNTRACKED entry, so the list only shrinks', () => {
    const linked = new Set(rendered.map(({ href }) => pathOf(href)));
    const stale = KNOWN_UNTRACKED.filter((p) => !linked.has(p) || isTracked(p));
    expect(stale, 'remove these from KNOWN_UNTRACKED').toEqual([]);
  });
});
