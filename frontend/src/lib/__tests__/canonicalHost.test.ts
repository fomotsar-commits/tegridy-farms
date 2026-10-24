// ONE canonical host, SITE_URL in src/lib/constants.ts, on every surface that tells a
// crawler where the venue lives. Nothing here hardcodes it, so moving the venue is one line
// in constants.ts, and a surface left on the old host turns red. The api/ CORS allowlists
// govern access, not declared identity, so they are not pinned here:
// api/__tests__/origin-allowlist-parity.test.js covers them.

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
const ALIAS_HOST = 'www.memetics.finance';

/**
 * A host the venue must never answer on (#478: the venue answers under one name).
 * memetic.fun serves the Island Lab from its own Vercel project, so the venue makes no
 * claim on it. A vercel.json rule for it would mean the domain was re-attached to this
 * project, since a rule is only written to suppress a host this project serves.
 */
const FOREIGN_HOST = 'memetic.fun';

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

  // index.html's own tags (rel=canonical, og:url, twitter:url, the JSON-LD `url` and the
  // bungalow-door pre-render) are pinned to SITE_URL by src/lib/siteIdentity.test.ts.
});

describe('the edge middleware stamps the canonical host, not the requested one', () => {
  // The property is INVARIANCE: a crawler gets the same card whichever host it asked,
  // which "equals the canonical origin" alone would not prove. Both routes answer without
  // the network: an unparseable /scan token and the bare /nakamigos landing card.
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

describe('vercel.json permanently redirects the aliases onto the canonical host', () => {
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
    // `permanent: true` makes Vercel emit 308 (307 for `false`). A `redirects` entry never
    // emits 301, so nothing that checks these hosts may demand one.
    expect(rule!.permanent, 'an alias redirect must be permanent (308), not a 307').toBe(true);
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

    // The filter above only catches a destination that is itself redirected. A rule aimed
    // at a third host with no rule of its own passes it, so land every one ON the canonical.
    const offCanonical = redirects
      .filter((r) => r.has?.some((h) => h.type === 'host'))
      .filter((r) => new URL(r.destination.replace('$1', '')).origin !== CANONICAL_ORIGIN)
      .map((r) => `${r.has!.find((h) => h.type === 'host')!.value} -> ${r.destination}`);
    expect(offCanonical, 'host redirects that do not land on the canonical origin').toEqual([]);
  });

  it('never redirects the canonical host away', () => {
    expect(hostRule(CANONICAL_HOST)).toBeUndefined();
  });

  it('makes no claim on memetic.fun, which is no longer this venue', () => {
    // No rule, in either direction. A redirect FROM it would mean this project is
    // serving it again; a redirect TO it would point the venue's consolidated
    // signal at an application that is not the venue.
    expect(
      hostRule(FOREIGN_HOST),
      `${FOREIGN_HOST} is served by another project now; a rule here means it was re-attached to this one`,
    ).toBeUndefined();

    // Host rules ONLY. `destHost` parses the destination as an absolute URL, and
    // the path redirects in this file ("/tradermigos" -> "/nakamigos") are
    // relative, so handing one to it throws before any assertion is reached.
    const pointingAt = redirects
      .filter((r) => r.has?.some((h) => h.type === 'host'))
      .filter((r) => destHost(r) === FOREIGN_HOST)
      .map((r) => `${r.has!.find((h) => h.type === 'host')!.value} -> ${r.destination}`);
    expect(pointingAt, `redirects aiming this venue's traffic at ${FOREIGN_HOST}`).toEqual([]);
  });

  it('keeps the foreign host out of what a crawler actually reads', () => {
    // Structural, not a substring search: both files name memetic.fun in comments that a
    // crawler never reads. Assert on the machine-read surfaces, the <loc> entries and
    // robots' directive lines with comments stripped.
    const locOrigins = new Set(sitemapLocOrigins(read('public', 'sitemap.xml')));
    const strays = [...locOrigins].filter((o) => new URL(o).host === FOREIGN_HOST);
    expect(strays, `sitemap <loc> entries on ${FOREIGN_HOST}`).toEqual([]);

    const directives = read('public', 'robots.txt')
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean);
    const advertised = directives.filter((l) => l.includes(FOREIGN_HOST));
    expect(advertised, `robots.txt directives naming ${FOREIGN_HOST}`).toEqual([]);
  });
});
