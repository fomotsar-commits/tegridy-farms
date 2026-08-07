// The CSP in vercel.json is the ONLY place image hosts are allowlisted, and the header
// only exists on Vercel — so a host the app renders but the CSP omits looks perfect
// locally and is a broken placeholder in production. That is exactly how every large NFT
// image on the live site ended up broken: Alchemy serves NFT media from
// `nft2-cdn.alchemy.com` now, while img-src still listed only the legacy
// `nft-cdn.alchemy.com`.
//
// This pins the INVARIANT ("a URL the app will put in an <img src> is permitted by the
// served img-src"), not the literal directive text — a wildcard or a re-ordered list that
// still permits the URL passes.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const VERCEL_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'vercel.json');

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

const csp = (): string => {
  const cfg = JSON.parse(readFileSync(VERCEL_JSON, 'utf-8')) as { headers: Rule[] };
  const values = cfg.headers
    .flatMap((r) => r.headers)
    .filter((h) => h.key.toLowerCase() === 'content-security-policy')
    .map((h) => h.value);
  expect(values.length, 'no Content-Security-Policy header in vercel.json').toBe(1);
  return values[0];
};

const directive = (name: string): string[] => {
  const found = csp()
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.split(/\s+/))
    .find((tokens) => tokens[0].toLowerCase() === name);
  expect(found, `no ${name} directive in the CSP`).toBeTruthy();
  return found!.slice(1);
};

// Minimal CSP source-expression matcher (host-source + scheme-source), per CSP3 §6.6.2.3.
const matchesSource = (source: string, url: URL): boolean => {
  if (source.startsWith("'")) return false; // keyword/hash/nonce — never matches a URL
  if (source === '*') return true;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return url.protocol.toLowerCase() === source.toLowerCase();
  let rest = source;
  const scheme = rest.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    if (url.protocol.toLowerCase() !== `${scheme[1].toLowerCase()}:`) return false;
    rest = rest.slice(scheme[0].length);
  }
  const host = rest.split('/')[0].split(':')[0].toLowerCase();
  const hostname = url.hostname.toLowerCase();
  // `*.example.com` matches subdomains only, not the bare registrable domain.
  if (host.startsWith('*.')) return hostname.endsWith(host.slice(1));
  return hostname === host;
};

const allowsImage = (url: string): boolean =>
  directive('img-src').some((s) => matchesSource(s, new URL(url)));

describe('vercel.json CSP img-src', () => {
  // Alchemy's NFT API hands back `image.thumbnailUrl` / `image.cachedUrl` on its CDN and
  // the app renders those verbatim (src/nakamigos/api.js). It now serves nft2-cdn; the
  // legacy host is still hardcoded in src/nakamigos/constants.js + middleware.js, so BOTH
  // must be renderable.
  it.each([
    'https://nft2-cdn.alchemy.com/eth-mainnet/5da8fc69b3357b9bfe42717280e7c102',
    'https://nft-cdn.alchemy.com/eth-mainnet/5da8fc69b3357b9bfe42717280e7c102',
  ])('permits Alchemy NFT media at %s', (url) => {
    expect(allowsImage(url), `img-src blocks ${url} — NFT images render as broken `
      + 'placeholders in production (the CSP header only exists on Vercel, so this is '
      + 'invisible locally)').toBe(true);
  });

  it('stays tight — no catch-all image sources', () => {
    const sources = directive('img-src');
    expect(sources).not.toContain('*');
    expect(sources).not.toContain('https:');
    expect(sources).not.toContain('http:');
    // An unrelated host must still be refused, i.e. the allowlist is a real allowlist.
    expect(allowsImage('https://evil.example.com/x.png')).toBe(false);
  });
});
