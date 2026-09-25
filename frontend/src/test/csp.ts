// Answers "would the CSP that vercel.json serves let the browser reach this URL". The
// header exists only on Vercel, so a missing host looks fine locally and fails in
// production; these checks are where it shows first. Pin the invariant (a URL the app
// reaches is permitted), never the directive's literal text.

import { expect } from 'vitest';
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

export const directive = (name: string): string[] => {
  const found = csp()
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => d.split(/\s+/))
    .find((tokens) => tokens[0].toLowerCase() === name);
  expect(found, `no ${name} directive in the CSP`).toBeTruthy();
  return found!.slice(1);
};

// CSP3 §6.7.2.8 scheme-part match: http covers https, ws covers wss/http/https, wss covers https.
const schemeMatches = (expr: string, url: string): boolean =>
  expr === url
  || (expr === 'http' && url === 'https')
  || (expr === 'ws' && ['wss', 'http', 'https'].includes(url))
  || (expr === 'wss' && url === 'https');

// Minimal CSP source-expression matcher (host-source + scheme-source), per CSP3 §6.7.2.
const matchesSource = (source: string, url: URL): boolean => {
  if (source.startsWith("'")) return false; // keyword/hash/nonce: never matches a URL
  if (source === '*') return true;
  const urlScheme = url.protocol.slice(0, -1).toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return schemeMatches(source.slice(0, -1).toLowerCase(), urlScheme);
  let rest = source;
  const scheme = rest.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (scheme) {
    if (!schemeMatches(scheme[1].toLowerCase(), urlScheme)) return false;
    rest = rest.slice(scheme[0].length);
  }
  const host = rest.split('/')[0].split(':')[0].toLowerCase();
  const hostname = url.hostname.toLowerCase();
  // `*.example.com` matches subdomains only, not the bare registrable domain.
  if (host.startsWith('*.')) return hostname.endsWith(host.slice(1));
  return hostname === host;
};

export const cspAllows = (directiveName: string, url: string): boolean =>
  directive(directiveName).some((s) => matchesSource(s, new URL(url)));
