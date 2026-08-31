#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-dist-graph.mjs — the BUILT chunk graph's regression gate.
//
// Why this exists (2026-08-28 frontend audit, bundle lane): the repo has
// shipped the same prod-only failure class TWICE, both times with dev mode,
// vitest, and tsc all green, because only the BUILT graph was wrong:
//   1. uninstalled optional wagmi peers → throwing connector stubs → every
//      wallet but Phantom dead in prod (guarded since by
//      src/lib/walletConnectorDeps.test.ts);
//   2. 2026-08-27: a static `buffer` import let Rollup weld vendor-solana into
//      /eth-curve's first paint — that chunk's top-level Solana code threw
//      "Buffer is not defined" before the polyfill ran, crashing the page into
//      the route error boundary. The fix (entry-chunk polyfill + pinning
//      buffer/base64-js/ieee754 into vendor-shared-wallet-plumbing) was
//      enforced ONLY BY COMMENTS until this script.
//
// Runs as part of `npm run build`, directly after `vite build`, over dist/.
// Three invariants, each of which failed silently in instance 2:
//   A. The ENTRY chunk installs the Buffer/global polyfill — minification
//      keeps property names, so `.Buffer=` / `.global=` survive as markers.
//   B. vendor-solana is NOT in the entry's STATIC import closure. Static ESM
//      imports in Rollup output are `import"./x.js"` / `import{…}from"./x.js"`
//      at module top level; dynamic ones are `import("./x.js")` and are FINE —
//      that's how the lazy Solana pages are supposed to load it.
//   C. dist/index.html does not modulepreload vendor-solana (a preload defeats
//      the laziness even without a static import).
//
// Silent-gate discipline: this script FAILS on a missing/empty dist, on an
// unreadable entry, and on a suspiciously tiny closure — "checked nothing"
// must never exit 0. Pass a dist path as argv[2] to test against a fixture.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'dist'));
const ASSETS = join(DIST, 'assets');

function die(msg) {
  console.error(`✖ dist-graph gate: ${msg}`);
  process.exit(1);
}

if (!existsSync(DIST)) die(`dist not found at ${DIST} — run vite build first`);
if (!existsSync(join(DIST, 'index.html'))) die(`no index.html in ${DIST}`);
if (!existsSync(ASSETS)) die(`no assets/ in ${DIST}`);

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const chunkFiles = readdirSync(ASSETS).filter((f) => f.endsWith('.js'));
if (chunkFiles.length < 3) die(`only ${chunkFiles.length} JS chunks in assets/ — not a real build`);

// ── locate the entry chunk: the module script index.html loads ─────────────
const entryMatch = html.match(/<script[^>]*type="module"[^>]*src="\/?(assets\/[^"]+\.js)"/);
if (!entryMatch) die('could not find the module <script> entry in index.html');
const entryRel = entryMatch[1].replace(/^assets\//, '');
if (!chunkFiles.includes(entryRel)) die(`entry ${entryRel} named by index.html is missing from assets/`);

const read = (f) => readFileSync(join(ASSETS, f), 'utf8');

// ── A: polyfill markers ride the entry chunk itself ────────────────────────
const entrySrc = read(entryRel);
if (!/\.Buffer\s*=/.test(entrySrc) || !/\.global\s*=/.test(entrySrc)) {
  die(
    `entry chunk ${entryRel} is missing the Buffer/global polyfill markers ` +
      `(".Buffer=" / ".global="). src/main.tsx must import './lib/solanaPolyfill' FIRST, ` +
      `and the import must not be tree-shaken or moved into a lazy chunk — ` +
      `this is the 2026-08-27 first-paint crash guard.`,
  );
}

// ── B: BFS the STATIC import closure from the entry ────────────────────────
// Static forms Rollup emits (minified, so no whitespace guarantees):
//   import"./a.js";   import{x}from"./a.js";   import e from"./a.js";
//   export{x}from"./a.js";   import*as t from"./a.js";
// Dynamic form to IGNORE: import("./a.js")
const STATIC_RE = /(?:^|[;}{)\s])(?:import|export)\s*(?:[^"'()]*?from\s*)?["']\.\/([^"']+\.js)["']/g;

const closure = new Set();
const queue = [entryRel];
while (queue.length) {
  const f = queue.pop();
  if (closure.has(f)) continue;
  closure.add(f);
  const src = read(f);
  for (const m of src.matchAll(STATIC_RE)) {
    const dep = m[1];
    if (!closure.has(dep)) {
      if (!chunkFiles.includes(dep)) die(`chunk ${f} statically imports missing ${dep}`);
      queue.push(dep);
    }
  }
}
if (closure.size < 2) {
  die(`static closure from ${entryRel} is only ${closure.size} chunk(s) — the import scanner matched nothing; the gate cannot vouch for a graph it failed to walk`);
}

const solanaInClosure = [...closure].filter((f) => f.startsWith('vendor-solana'));
if (solanaInClosure.length) {
  die(
    `vendor-solana is STATICALLY reachable from the entry chunk (via ${solanaInClosure.join(', ')}). ` +
      `Some eager module gained a static import that drags the Solana stack into first paint — ` +
      `find the new import chain (ANALYZE=true vite build) and either lazy it or pin the shared ` +
      `module into vendor-shared-wallet-plumbing (vite.config.ts).`,
  );
}

// ── C: no modulepreload of vendor-solana in index.html ─────────────────────
const preloads = [...html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="\/?assets\/([^"]+\.js)"/g)].map(
  (m) => m[1],
);
const solanaPreload = preloads.filter((f) => f.startsWith('vendor-solana'));
if (solanaPreload.length) {
  die(`index.html modulepreloads ${solanaPreload.join(', ')} — vendor-solana must stay lazy`);
}

console.log(
  `✔ dist-graph gate: entry=${entryRel}, static closure ${closure.size} chunk(s), ` +
    `polyfill markers present, vendor-solana lazy (${preloads.length} preloads checked).`,
);
