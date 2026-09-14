// The venue's icon, everywhere a client can ask for one.
//
// WHY THIS FILE EXISTS. The site shipped with the Nakamigos marketplace icon as its
// apple-touch-icon and its two manifest icons (b0fe56e3), and 340b5050 replaced all
// three with the island mark. The bytes on disk and the bytes Vercel serves were
// correct from that moment on — and the retired pixel icon KEPT SHOWING, for weeks,
// in Phantom's in-app browser, on home screens, and anywhere else that keeps its own
// per-origin icon store.
//
// The reason is that the icon FILENAMES never moved. An HTTP `must-revalidate` governs
// the HTTP cache; it says nothing to a client that resolved this origin's icon once,
// wrote it into its own database keyed by origin, and never asks again. For those
// clients a new icon at an old URL does not exist. The only thing that reaches them is
// a URL they have never seen.
//
// So the invariant here is not "the icon is the island mark" — that was already true
// while the bug was live, which is exactly why asserting it would have proved nothing.
// It is: WHENEVER THE ICON BYTES CHANGE, THE URL CHANGES WITH THEM. The version token
// is derived from the icon bytes below, so art that moves without its URL moving fails
// this file and prints the token to paste in.
//
// The second half covers the other way a client ends up with no answer: /favicon.ico.
// Plenty of in-app browsers probe the well-known root path before they parse any <link>
// tag. vercel.json rewrites `/((?!api/).*)` to /index.html, so until a real file existed
// there that probe returned `200 text/html` — a success, carrying a page. A fetcher that
// cannot decode that has no failure to fall back from, and keeps whatever it already had.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = join(FRONTEND, 'public');
const html = readFileSync(join(FRONTEND, 'index.html'), 'utf-8');

const publicFile = (urlPath: string) => join(PUBLIC, urlPath.replace(/^\//, ''));
const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** The icons a browser or webview can be handed, in the order it tends to look. */
const REQUIRED_ICONS = [
  '/favicon.ico',
  '/favicon.png',
  '/apple-touch-icon.png',
  '/splash/icon-192.png',
  '/splash/icon-512.png',
] as const;

/**
 * Well-known icon paths this venue does NOT ship, kept in the token below so that
 * re-adding one still moves every icon URL.
 *
 * /favicon.svg was the `<link rel="icon">` target until 340b5050 and was left on disk
 * afterwards, still serving a purple bolt from a retired brand at a path some browsers
 * prefer over the PNG. It is deleted rather than redrawn: an SVG that wraps a raster
 * costs bytes and buys no fidelity over the PNG set, and nothing probes /favicon.svg by
 * convention the way it probes /favicon.ico. A real vector island mark may land here
 * later — the token sweep is what makes that safe.
 */
const OPTIONAL_ICONS = ['/favicon.svg'] as const;

const ICON_PATHS = [...REQUIRED_ICONS, ...OPTIONAL_ICONS] as const;

/**
 * The retired Nakamigos marketplace icons, by content hash. Pinned by HASH and not by
 * filename on purpose: the bug was never that a path was wrong, it was that these exact
 * bytes were the venue's identity. Re-landing them under any name is the regression.
 */
const RETIRED_ICON_SHA256: Record<string, string> = {
  'b9a7becb3f07199782d26e5c0e360e3f4d6468e6d5cc3902a8bce8842aeca526':
    'the Nakamigos 192px marketplace icon (shipped as apple-touch-icon.png and splash/icon-192.png until 340b5050)',
  '4d9566fb4d2ebdbc7c18b2aad7ec85865cd119c787d5147259f37b90df50aa6e':
    'the Nakamigos 512px marketplace icon (shipped as splash/icon-512.png until 340b5050)',
};

/** Every icon URL declared in index.html, with its query string intact. */
function declaredInHtml(): string[] {
  const out: string[] = [];
  const linkRe = /<link\b[^>]*\brel="(icon|apple-touch-icon|mask-icon)"[^>]*>/gi;
  for (const [tag] of html.matchAll(linkRe)) {
    const href = tag.match(/\bhref="([^"]+)"/i)?.[1];
    if (href) out.push(href);
  }
  return out;
}

/** Every icon URL declared in a manifest, with its query string intact. */
function declaredInManifest(name: string): string[] {
  const parsed = JSON.parse(readFileSync(join(PUBLIC, name), 'utf-8')) as {
    icons?: { src?: string }[];
  };
  return (parsed.icons ?? []).map((i) => i.src ?? '').filter(Boolean);
}

const MANIFESTS = ['manifest.webmanifest', 'manifest.json'] as const;

/**
 * The token every icon URL must carry, derived from the icon bytes themselves.
 *
 * Content-addressed on purpose. A hand-picked literal would let someone swap the art
 * and leave the token alone — which is the whole bug, reproduced. This recomputes from
 * whatever is on disk, so the only way to satisfy it is to move the URLs when the art
 * moves.
 */
function expectedVersionToken(): string {
  const h = createHash('sha256');
  for (const p of ICON_PATHS) {
    const file = publicFile(p);
    // A missing icon must not silently drop out of the token — it would let a deleted
    // icon keep the old token alive. Fold the absence in so it changes the answer.
    h.update(p);
    h.update(existsSync(file) ? readFileSync(file) : Buffer.from('ABSENT'));
  }
  return h.digest('hex').slice(0, 8);
}

describe('site icons — the bytes', () => {
  it.each(REQUIRED_ICONS)('%s exists in public/', (p) => {
    expect(existsSync(publicFile(p)), `${p} is declared or probed but missing from public/`).toBe(
      true,
    );
  });

  it('/favicon.ico is a real ICO, not the SPA fallback page', () => {
    const file = publicFile('/favicon.ico');
    expect(existsSync(file), '/favicon.ico missing — vercel.json rewrites it to index.html').toBe(
      true,
    );
    const buf = readFileSync(file);
    // ICONDIR: reserved=0, type=1 (icon), then the image count.
    expect(
      [buf[0], buf[1], buf[2], buf[3]],
      '/favicon.ico is not an ICO container',
    ).toEqual([0, 0, 1, 0]);
    const count = buf.readUInt16LE(4);
    expect(count, '/favicon.ico declares no images').toBeGreaterThan(0);
  });

  it.each(ICON_PATHS)('%s is not a retired Nakamigos icon', (p) => {
    const file = publicFile(p);
    if (!existsSync(file)) return; // the existence test above owns that failure
    const hash = sha256(readFileSync(file));
    expect(RETIRED_ICON_SHA256[hash], `${p} is ${RETIRED_ICON_SHA256[hash]}`).toBeUndefined();
  });
});

describe('site icons — the URLs move when the bytes move', () => {
  const token = expectedVersionToken();

  const declarations: [string, string[]][] = [
    ['index.html', declaredInHtml()],
    ...MANIFESTS.map((m) => [m, declaredInManifest(m)] as [string, string[]]),
  ];

  it('index.html declares at least one icon', () => {
    expect(declaredInHtml().length).toBeGreaterThan(0);
  });

  it.each(declarations)('%s carries the current icon version token on every icon', (where, urls) => {
    expect(urls.length, `${where} declares no icons`).toBeGreaterThan(0);
    for (const url of urls) {
      expect(
        url,
        `${where} declares "${url}" without the current icon version token. The icon bytes ` +
          `hash to "${token}" — every icon URL must end in "?v=${token}" so a client that ` +
          `cached this origin's icon under the old URL is forced to fetch the new one. ` +
          `Bump the token in index.html and both manifests together.`,
      ).toContain(`?v=${token}`);
    }
  });

  it.each(declarations)('%s points every icon at a file that exists', (where, urls) => {
    for (const url of urls) {
      const path = url.split('?')[0]!;
      expect(existsSync(publicFile(path)), `${where} declares "${url}" but ${path} is missing`).toBe(
        true,
      );
    }
  });

  it('both manifests declare byte-identical icon lists', () => {
    // manifest.json is served alongside manifest.webmanifest for older PWA tooling. If
    // they disagree, whichever one a given client reads decides the home-screen icon.
    const [a, b] = MANIFESTS.map(declaredInManifest);
    expect(a).toEqual(b);
  });
});
