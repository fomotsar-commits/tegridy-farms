// ONE canonical host, asserted across every surface that tells a crawler where
// this site lives.
//
// WHY THIS FILE EXISTS. The venue served two hosts, and the signals disagreed
// about which one was authoritative: index.html said `memetics.finance` while
// robots.txt handed out a sitemap on `memetic.fun` and all 43 <loc> entries in
// that sitemap named the alias. A crawler was therefore told the canonical host
// by one file and given the URL set on the other — the duplicate-content
// collision a single-canonical policy exists to prevent. The edge middleware
// was worse than either: it stamped `rel=canonical` and `og:url` from
// `req.url`'s origin, so it echoed back whichever host the crawler happened to
// arrive on and could never converge.
//
// WHAT IS PINNED, AND WHAT DELIBERATELY IS NOT. Every assertion below is
// derived from `SITE_URL` in src/lib/constants.ts — the one place trunk decided
// the host (see its ARRIVAL IDENTITY 2026-08-27 note). Nothing here hardcodes
// "memetics.finance", so moving the venue is a ONE-LINE change in constants.ts
// and this file follows; and a surface left behind on the old host turns red
// instead of quietly disagreeing.
//
// NOT pinned here: the api/ CORS allowlists. Those deliberately admit BOTH
// hosts (constants.ts says so in as many words) because they govern ACCESS, not
// declared identity — an alias that 301s still has in-flight clients. They are
// covered by api/__tests__/origin-allowlist-parity.test.js, and widening the
// scope of this file to them would break a live surface for a cosmetic tidy.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SITE_URL } from '../constants';
import middleware from '../../../middleware.js';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (...p: string[]) => readFileSync(join(FRONTEND, ...p), 'utf-8');

const CANONICAL = new URL(SITE_URL);
const CANONICAL_ORIGIN = CANONICAL.origin;
const CANONICAL_HOST = CANONICAL.host;

/** A host this venue also answers on that is NOT the canonical one. */
const ALIAS_HOST = 'memetic.fun';

const BOT_UA = 'Mozilla/5.0 (compatible; Twitterbot/1.0)';

/** Every origin appearing in a `<loc>`, in document order. */
function sitemapLocOrigins(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => new URL(m[1]).origin);
}

async function botStamp(path: string, host: string): Promise<{ canonical: string; ogUrl: string }> {
  const res: Response | undefined = await middleware(
    new Request(`https://${host}${path}`, { headers: { 'user-agent': BOT_UA } }),
  );
  // `undefined` is middleware's "fall through to the SPA" — a real answer for a
  // human, but it means this bot UA stopped matching and the test is measuring
  // nothing. Throw rather than assert, so the failure names the cause.
  if (!res) throw new Error(`middleware served no card for https://${host}${path}`);
  const html: string = await res.text();
  const canonical = html.match(/<link rel="canonical" href="([^"]+)">/)?.[1];
  const ogUrl = html.match(/<meta property="og:url" content="([^"]+)">/)?.[1];
  expect(canonical, 'card emitted no rel=canonical').toBeTruthy();
  expect(ogUrl, 'card emitted no og:url').toBeTruthy();
  return { canonical: canonical!, ogUrl: ogUrl! };
}

describe('the site names exactly one canonical host', () => {
  it('sitemap.xml puts every <loc> on the canonical origin', () => {
    const origins = sitemapLocOrigins(read('public', 'sitemap.xml'));
    expect(origins.length, 'sitemap has no <loc> entries at all').toBeGreaterThan(20);
    const strays = [...new Set(origins.filter((o) => o !== CANONICAL_ORIGIN))];
    expect(strays, `sitemap <loc> entries off ${CANONICAL_ORIGIN}`).toEqual([]);
  });

  it('robots.txt points at the sitemap on the canonical origin', () => {
    const line = read('public', 'robots.txt')
      .split(/\r?\n/)
      .find((l) => /^\s*Sitemap:/i.test(l));
    expect(line, 'robots.txt declares no Sitemap:').toBeTruthy();
    const url = new URL(line!.replace(/^\s*Sitemap:\s*/i, '').trim());
    expect(url.origin).toBe(CANONICAL_ORIGIN);
  });

  // index.html's own tags — rel=canonical, og:url, twitter:url, the JSON-LD `url`,
  // and the bungalow-door pre-render that carries a second copy of the origin — are
  // NOT re-asserted here. src/lib/siteIdentity.test.ts already pins all of them to
  // SITE_URL, and it also guards the CSP sha256 over the inline JSON-LD. They were
  // already correct when this file was written; duplicating them would have added
  // four assertions that are green before AND after the fix, which is not coverage.
});

describe('the edge middleware stamps the canonical host, not the requested one', () => {
  // The real property is INVARIANCE: the card a crawler gets must be the same
  // document whichever host it knocked on. Asserting only "equals the canonical
  // origin" would still pass a middleware that merely happened to be handed the
  // canonical host by the test; asserting the two requests AGREE cannot.
  //
  // Both routes below answer without touching the network: /scan with an
  // unparseable token short-circuits to the generic scanner card, and
  // /nakamigos with no slug is the collection landing card.
  for (const path of ['/scan?token=not-an-address', '/nakamigos']) {
    it(`serves a host-independent card for ${path}`, async () => {
      const onCanonical = await botStamp(path, CANONICAL_HOST);
      const onAlias = await botStamp(path, ALIAS_HOST);

      expect(onAlias).toEqual(onCanonical);
      expect(new URL(onAlias.canonical).origin).toBe(CANONICAL_ORIGIN);
      expect(new URL(onAlias.ogUrl).origin).toBe(CANONICAL_ORIGIN);
    });
  }
});

describe('vercel.json 301s the aliases onto the canonical host', () => {
  type Redirect = {
    source: string;
    destination: string;
    permanent?: boolean;
    has?: { type: string; value: string }[];
  };
  const config = JSON.parse(read('vercel.json')) as { redirects?: Redirect[] };
  const redirects = config.redirects ?? [];

  /** The catch-all host redirect that claims `host`, if any. */
  const hostRule = (host: string): Redirect | undefined =>
    redirects.find(
      (r) =>
        /^\/\(\.\*\)$/.test(r.source) &&
        r.has?.some((h) => h.type === 'host' && h.value === host),
    );

  const destHost = (r: Redirect) => new URL(r.destination.replace('$1', '')).host;

  it('sends the bare alias host to the canonical origin, permanently', () => {
    const rule = hostRule(ALIAS_HOST);
    expect(rule, `no catch-all host redirect for ${ALIAS_HOST}`).toBeTruthy();
    expect(rule!.permanent, 'an alias redirect must be a 301, not a 307').toBe(true);
    expect(new URL(rule!.destination.replace('$1', '')).origin).toBe(CANONICAL_ORIGIN);
  });

  it('lands every host redirect on the canonical origin in ONE hop', () => {
    // A `www.alias -> alias -> canonical` chain costs a crawler an extra round
    // trip and dilutes the very signal the redirect exists to consolidate.
    const chained = redirects
      .filter((r) => r.has?.some((h) => h.type === 'host'))
      .filter((r) => destHost(r) !== CANONICAL_HOST && hostRule(destHost(r)) !== undefined)
      .map((r) => `${r.has!.find((h) => h.type === 'host')!.value} -> ${r.destination}`);
    expect(chained, 'host redirects that hop through another redirected host').toEqual([]);
  });

  it('never redirects the canonical host away', () => {
    expect(hostRule(CANONICAL_HOST)).toBeUndefined();
  });
});
