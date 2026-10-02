#!/usr/bin/env node
/**
 * Writes dist/held-through.json: every contract of this venue that holds user positions
 * and the exact read for one wallet. The content comes from src/lib/heldThrough.ts,
 * loaded through Vite in production mode so VITE_* resolve as they did for the bundle.
 * In the explicit build chain, never a pre/post hook: .npmrc sets ignore-scripts.
 * Fails the build on a missing dist, output that is not ASCII JSON under its schema,
 * or a production build that drops the live ladder.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(FRONTEND, 'dist');

if (!existsSync(resolve(DIST, 'index.html'))) {
  throw new Error('[held-through] dist/index.html not found: run after `vite build`.');
}

const ledger = JSON.parse(readFileSync(resolve(FRONTEND, 'scripts', 'addresses.json'), 'utf8'));
const commit = (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || '').slice(0, 12) || null;
const date = new Date().toISOString().slice(0, 10);

const server = await createServer({
  root: FRONTEND,
  configFile: false,
  mode: 'production',
  logLevel: 'error',
  appType: 'custom',
  server: { middlewareMode: true, hmr: false, watch: null },
  optimizeDeps: { noDiscovery: true, include: [] },
});
let text;
let refusal;
let schema;
try {
  const mod = await server.ssrLoadModule('/src/lib/heldThrough.ts');
  const body = mod.collectHeldThrough();
  refusal = mod.ladderMissingInProduction(body, ledger, process.env.VERCEL_ENV);
  text = mod.renderHeldThrough(body, { date, commit });
  schema = mod.HELD_THROUGH_SCHEMA;
} finally {
  await server.close();
}

if (refusal) throw new Error(`[held-through] ${refusal}`);
const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 127);
if (nonAscii.length > 0) {
  throw new Error(`[held-through] ${nonAscii.length} non-ASCII character(s) in the output, e.g. ${JSON.stringify(nonAscii[0])}.`);
}
const doc = JSON.parse(text);
if (doc.schema !== schema) throw new Error('[held-through] the output does not carry its schema.');

const out = resolve(DIST, 'held-through.json');
writeFileSync(out, text, 'utf8');
if (readFileSync(out, 'utf8') !== text) throw new Error('[held-through] dist/held-through.json did not read back as written.');
const counts = Object.entries(doc.chains).map(([chain, list]) => `${chain} ${list.length}`).join(', ');
console.log(`[held-through] wrote dist/held-through.json (${counts}${commit ? `, commit ${commit}` : ''})`);
