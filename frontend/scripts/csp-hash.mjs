#!/usr/bin/env node
/**
 * Print SHA-256 CSP hashes for every inline <script> in index.html.
 *
 * The CSP in vercel.json drops 'unsafe-inline' from script-src and pins each
 * inline script via 'sha256-…'. If an inline script changes (e.g. the JSON-LD
 * block), re-run this script and paste the new hash(es) into vercel.json.
 *
 * Usage: node scripts/csp-hash.mjs
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, '..', 'index.html');
const html = readFileSync(htmlPath, 'utf8');

// Normalize to LF — Vercel / Linux serves files checked out from git with LF
// endings regardless of the working-copy line endings on Windows.
const normalized = html.replace(/\r\n/g, '\n');

const re = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
let match;
let idx = 0;
const hashes = [];
while ((match = re.exec(normalized)) !== null) {
  const attrs = (match[1] || '').trim();
  const body = match[2];
  // External scripts (src=…) do not have inline bodies → skip.
  if (/\bsrc\s*=/.test(attrs)) continue;
  const hash = createHash('sha256').update(body, 'utf8').digest('base64');
  hashes.push({ idx, attrs, hash, preview: body.trim().slice(0, 60).replace(/\s+/g, ' ') });
  idx += 1;
}

if (hashes.length === 0) {
  console.log('No inline <script> tags found in index.html. CSP can drop script-src sha256 hashes entirely.');
  process.exit(0);
}

console.log(`Found ${hashes.length} inline <script> tag(s) in index.html:\n`);
for (const h of hashes) {
  console.log(`  [${h.idx}] attrs=${h.attrs || '(none)'}`);
  console.log(`      preview: ${h.preview}${h.preview.length >= 60 ? '…' : ''}`);
  console.log(`      hash:    'sha256-${h.hash}'`);
  console.log('');
}

console.log('Paste the above hashes into the script-src directive in vercel.json.');
