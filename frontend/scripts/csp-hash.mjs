#!/usr/bin/env node
/**
 * Compute the SHA-256 CSP hash of every inline <script> the site serves, and keep
 * vercel.json's script-src pinning exactly those.
 *
 * The CSP in vercel.json drops 'unsafe-inline' from script-src and pins each inline
 * script via 'sha256-…'. The site serves index.html and one page per bungalow door
 * (scripts/render-bungalow-doors.mjs), and each door page carries its own JSON-LD, so
 * the list is computed from the pages themselves, never typed (scripts/lib/csp-hashes.mjs).
 *
 * Usage: node scripts/csp-hash.mjs           print the hashes; exit 1 if vercel.json differs
 *        node scripts/csp-hash.mjs --write   rewrite vercel.json's script-src to pin them
 */
import { readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, resolve } from 'node:path';
import { pageHashes, pinnedHashes, pinHashes } from './lib/csp-hashes.mjs';
import { DOORS, transform } from './render-bungalow-doors.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vercelPath = resolve(root, 'vercel.json');
const shell = readFileSync(resolve(root, 'index.html'), 'utf8');

/** Every page the site serves with inline scripts of its own, as [route, html].
 *  @param {string} [html] the venue's index.html
 *  @returns {[string, string][]} */
export const servedPages = (html = shell) => [
  ['/', html],
  ...DOORS.map((door) => [`/${door.path}`, transform(html, door)]),
];

/** The hashes vercel.json must pin, once each, in page order.
 *  @param {string} [html] the venue's index.html
 *  @returns {string[]} */
export const expectedHashes = (html = shell) => [...new Set(servedPages(html).flatMap(([, page]) => pageHashes(page)))];

// Run only when launched, not when a test imports it; compared by real path, as
// render-bungalow-doors.mjs does, so a link or a drive-letter case never skips it silently.
const real = (p) => { const r = realpathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
const self = fileURLToPath(import.meta.url);
const launched = Boolean(process.argv[1]) && basename(process.argv[1]) === basename(self);
if (launched && real(resolve(process.argv[1])) !== real(self)) {
  throw new Error(`[csp-hash] launched as ${process.argv[1]} but this file is ${self}.`);
}
if (launched) {
  for (const [route, page] of servedPages()) {
    for (const hash of pageHashes(page)) console.log(`  ${route.padEnd(10)} ${hash}`);
  }
  const vercel = readFileSync(vercelPath, 'utf8');
  const want = expectedHashes();
  if (process.argv.includes('--write')) {
    writeFileSync(vercelPath, pinHashes(vercel, want));
    console.log(`\nvercel.json now pins ${want.length} inline script hash(es).`);
  } else if (pinnedHashes(vercel).join(' ') !== want.join(' ')) {
    console.log('\nvercel.json does not pin exactly these. Run: node scripts/csp-hash.mjs --write');
    process.exit(1);
  } else {
    console.log(`\nvercel.json pins exactly these ${want.length}.`);
  }
}
