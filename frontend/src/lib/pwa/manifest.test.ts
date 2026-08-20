// The two manifests, and the assets they promise.
//
// public/manifest.json and public/manifest.webmanifest are byte-duplicates on
// purpose (index.html links the .webmanifest; the .json is kept for tooling that
// still looks for it). Duplicates drift, and a drifted manifest is a
// hard-to-notice install bug — the browser reads one file and every reviewer
// reads the other. This holds them equal and holds both to the facts an install
// depends on: icons that exist on disk, a scope the service worker can actually
// cover, and an id that does not move.

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PUBLIC = join(process.cwd(), 'public');
const FILES = ['manifest.json', 'manifest.webmanifest'];

function read(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(PUBLIC, name), 'utf-8'));
}

describe('the manifests agree', () => {
  it('are identical documents', () => {
    const [a, b] = FILES.map(read);
    expect(a).toEqual(b);
  });

  it('is the file index.html actually links', () => {
    const html = readFileSync(join(process.cwd(), 'index.html'), 'utf-8');
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
  });
});

describe('what an install depends on', () => {
  for (const file of FILES) {
    describe(file, () => {
      const manifest = read(file);

      it('declares a scope the app-shell worker can cover', () => {
        // The worker registers at "/" (lib/pwa/serviceWorker.ts). A narrower
        // manifest scope would put installed navigations outside it; a broader
        // one is impossible.
        expect(manifest.scope).toBe('/');
        expect(manifest.start_url).toBe('/');
      });

      it('pins a stable install id, so answering the naming question renames rather than duplicates', () => {
        // `id` defaults to start_url when absent, so "/" changes nothing for an
        // existing installation — it just stops a future `name` change from
        // being able to create a second one.
        expect(manifest.id).toBe('/');
      });

      it('points every icon at a file that exists', () => {
        const icons = manifest.icons as { src: string; sizes: string; type: string }[];
        expect(icons.length).toBeGreaterThan(0);
        for (const icon of icons) {
          expect(icon.src.startsWith('/'), `${icon.src} must be an absolute path`).toBe(true);
          expect(existsSync(join(PUBLIC, icon.src.slice(1))), `${icon.src} is declared but not on disk`).toBe(true);
        }
      });

      it('carries the 192 and 512 sizes an installable app needs', () => {
        const sizes = (manifest.icons as { sizes: string }[]).map((i) => i.sizes);
        expect(sizes).toContain('192x192');
        expect(sizes).toContain('512x512');
      });
    });
  }
});

describe('the offline shell the worker precaches exists and stays honest', () => {
  const offline = readFileSync(join(PUBLIC, 'offline.html'), 'utf-8');

  it('is on disk under the path public/sw.js names', () => {
    expect(readFileSync(join(PUBLIC, 'sw.js'), 'utf-8')).toContain("'/offline.html'");
  });

  it('carries no script — it must not depend on anything working', () => {
    expect(offline).not.toMatch(/<script/i);
  });

  it('says plainly that nothing was read, rather than showing a placeholder figure', () => {
    expect(offline).toMatch(/No price, balance, pool or transaction/i);
    expect(offline).toMatch(/Nothing here is a zero/i);
  });
});
