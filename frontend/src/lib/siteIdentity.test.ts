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

  // Not an identity check, but it lives or dies with the block above: the JSON-LD is an
  // INLINE script pinned by a CSP sha256 in vercel.json, and the CSP header only exists
  // on Vercel — so editing index.html without re-running scripts/csp-hash.mjs blocks the
  // structured data in production while everything looks fine locally.
  it('every inline script in index.html is pinned by the CSP in vercel.json', () => {
    const vercelJson = readFileSync(join(dirname(INDEX_HTML), 'vercel.json'), 'utf-8');
    // Same normalization scripts/csp-hash.mjs uses: Vercel serves the git checkout
    // with LF endings whatever the working copy has.
    const normalized = html.replace(/\r\n/g, '\n');
    const inline: string[] = [];
    // `i` because HTML tag names are case-insensitive: without it a <SCRIPT> block is
    // silently skipped and its missing pin passes this guard (CodeQL js/bad-tag-filter).
    // Must stay identical to the pattern in scripts/csp-hash.mjs.
    for (const m of normalized.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script(?:\s[^>]*)?>/gi)) {
      if (/\bsrc\s*=/.test((m[1] ?? '').trim())) continue; // external → no body to pin
      inline.push(m[2]);
    }
    expect(inline.length, 'no inline <script> in index.html').toBeGreaterThan(0);
    for (const body of inline) {
      const hash = createHash('sha256').update(body, 'utf8').digest('base64');
      expect(vercelJson, `vercel.json does not pin 'sha256-${hash}' — an inline script in `
        + 'index.html changed without re-running `node scripts/csp-hash.mjs`, so the CSP '
        + 'will block it in production (the header only exists on Vercel, so this is '
        + 'invisible locally)').toContain(`sha256-${hash}`);
    }
  });
});
