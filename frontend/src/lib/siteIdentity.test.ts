// index.html's static site identity must agree with SITE_URL.
//
// WHY THIS IS NOT COVERED BY THE E2E SPEC. The e2e check reads the canonical tag AFTER
// usePageTitle has mounted and rewritten it. Crawlers and social unfurlers read the
// SERVED HTML, before any JS runs — so the static tags in index.html are a separate
// surface with its own failure mode, and it drifted independently: the API origin
// allowlists were corrected to memetic.fun in #180 while every tag here still declared
// the .vercel.app alias.
//
// Runs in vitest (milliseconds, no browser), so the drift is caught on every push rather
// than only when someone runs Playwright.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITE_URL } from './constants';
import { inlineScriptBodies, pinnedHashes } from '../../scripts/lib/csp-hashes.mjs';

const INDEX_HTML = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'index.html');
const html = readFileSync(INDEX_HTML, 'utf-8');

const attr = (re: RegExp): string | null => html.match(re)?.[1] ?? null;
const origin = (u: string) => u.replace(/\/$/, '');

describe('index.html static site identity', () => {
  it('declares SITE_URL as the canonical origin', () => {
    const canonical = attr(/<link\s+rel="canonical"\s+href="([^"]+)"/);
    expect(canonical, 'no <link rel="canonical"> in index.html').toBeTruthy();
    expect(origin(canonical!)).toBe(origin(SITE_URL));
  });

  it.each([
    ['og:url', /<meta\s+property="og:url"\s+content="([^"]+)"/],
    ['og:image', /<meta\s+property="og:image"\s+content="([^"]+)"/],
    ['og:image:secure_url', /<meta\s+property="og:image:secure_url"\s+content="([^"]+)"/],
    ['twitter:url', /<meta\s+name="twitter:url"\s+content="([^"]+)"/],
    ['twitter:image', /<meta\s+name="twitter:image"\s+content="([^"]+)"/],
  ] as const)('%s points at SITE_URL', (name, re) => {
    const value = attr(re);
    expect(value, `${name} missing from index.html`).toBeTruthy();
    expect(value!.startsWith(origin(SITE_URL))).toBe(true);
  });

  it('the JSON-LD url agrees too', () => {
    // Same block the CSP sha256 in vercel.json pins — see the note below.
    const ld = html.match(/<script[^>]*application\/ld\+json[^>]*>(.*?)<\/script(?:\s[^>]*)?>/is)?.[1];
    expect(ld, 'no JSON-LD block in index.html').toBeTruthy();
    const parsed = JSON.parse(ld!.trim()) as { url?: string };
    expect(origin(parsed.url ?? '')).toBe(origin(SITE_URL));
  });

  // ARRIVAL IDENTITY 2026-08-27: the per-door unfurls are pre-rendered at build time by
  // scripts/render-bungalow-doors.mjs, which carries its OWN copy of the canonical origin
  // (it runs under bare Node and cannot import the TS constant). That copy drifted the
  // moment SITE_URL moved to memetics.finance: every bungalow door would have declared
  // canonical/og:url on the old origin while index.html declared the new one — the exact
  // two-halves-disagree failure this file was written for, one directory over and outside
  // its reach. Pin it here so the next origin move cannot leave the doors behind.
  it('the bungalow door pre-render declares the same canonical origin', () => {
    const script = readFileSync(
      join(dirname(INDEX_HTML), 'scripts', 'render-bungalow-doors.mjs'),
      'utf-8',
    );
    const m = script.match(/const SITE = '([^']+)'/);
    expect(m, "no `const SITE = '…'` in scripts/render-bungalow-doors.mjs").toBeTruthy();
    expect(origin(m![1]!)).toBe(origin(SITE_URL));
  });

  // Island, answer nineteen §3: the card a shared link unfurls as is the home page's own
  // first picture, Bayla at the door, not the old text card. Every tag that names the
  // picture names the same file, and the file is the size the tags declare.
  it('the default card is Bayla at the door, og.jpg at 1280 by 640', () => {
    const card = `${origin(SITE_URL)}/og.jpg`;
    expect(attr(/<meta\s+property="og:image"\s+content="([^"]+)"/)).toBe(card);
    expect(attr(/<meta\s+property="og:image:secure_url"\s+content="([^"]+)"/)).toBe(card);
    expect(attr(/<meta\s+name="twitter:image"\s+content="([^"]+)"/)).toBe(card);
    expect(attr(/<meta\s+property="og:image:type"\s+content="([^"]+)"/)).toBe('image/jpeg');
    expect(attr(/<meta\s+property="og:image:width"\s+content="([^"]+)"/)).toBe('1280');
    expect(attr(/<meta\s+property="og:image:height"\s+content="([^"]+)"/)).toBe('640');
    const alt = 'Bayla at the door. Held time counts here.';
    expect(attr(/<meta\s+property="og:image:alt"\s+content="([^"]+)"/)).toBe(alt);
    expect(attr(/<meta\s+name="twitter:image:alt"\s+content="([^"]+)"/)).toBe(alt);

    // The size from the file's own frame header, not from its name.
    const jpg = readFileSync(join(dirname(INDEX_HTML), 'public', 'og.jpg'));
    expect(jpg.readUInt16BE(0), 'public/og.jpg is not a JPEG').toBe(0xffd8);
    let at = 2;
    let size: [number, number] | null = null;
    while (at + 9 < jpg.length && jpg[at] === 0xff) {
      const marker = jpg[at + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        size = [jpg.readUInt16BE(at + 7), jpg.readUInt16BE(at + 5)];
        break;
      }
      at += 2 + jpg.readUInt16BE(at + 2);
    }
    expect(size, 'no frame header in public/og.jpg').toEqual([1280, 640]);
  });

  // Not an identity check, but it lives or dies with the block above: the JSON-LD is an
  // INLINE script pinned by a CSP sha256 in vercel.json, and the CSP header only exists
  // on Vercel — so editing index.html without re-running scripts/csp-hash.mjs blocks the
  // structured data in production while everything looks fine locally.
  // The door pages' pins are asserted, both ways, in bungalowDoors.test.ts.
  it('every inline script in index.html is pinned by the CSP in vercel.json', () => {
    const vercelJson = readFileSync(join(dirname(INDEX_HTML), 'vercel.json'), 'utf-8');
    // The same reader scripts/csp-hash.mjs writes the pins with: LF endings, as Vercel
    // serves the git checkout, and case-insensitive tags (CodeQL js/bad-tag-filter).
    const inline = inlineScriptBodies(html);
    expect(inline.length, 'no inline <script> in index.html').toBeGreaterThan(0);
    // An independent hash, so a broken cspHash() cannot agree with itself.
    for (const body of inline) {
      const hash = createHash('sha256').update(body, 'utf8').digest('base64');
      expect(pinnedHashes(vercelJson), `vercel.json does not pin 'sha256-${hash}' — an inline script in `
        + 'index.html changed without re-running `node scripts/csp-hash.mjs --write`, so the '
        + 'CSP will block it in production (the header only exists on Vercel, so this is '
        + 'invisible locally)').toContain(`'sha256-${hash}'`);
    }
  });
});
