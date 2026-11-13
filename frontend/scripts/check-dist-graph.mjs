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
// Three invariants (A-C), each of which failed silently in instance 2:
//   A. The ENTRY chunk installs the Buffer/global polyfill — minification
//      keeps property names, so `.Buffer=` / `.global=` survive as markers.
//   B. vendor-solana is NOT in the entry's STATIC import closure. Static ESM
//      imports in Rollup output are `import"./x.js"` / `import{…}from"./x.js"`
//      at module top level; dynamic ones are `import("./x.js")` and are FINE —
//      that's how the lazy Solana pages are supposed to load it.
//   C. dist/index.html does not modulepreload vendor-solana (a preload defeats
//      the laziness even without a static import).
// And one for the Solana WalletConnect row (2026-09-25):
//   D. @walletconnect/sign-client stays LAZY. src/lib/solanaWalletConnect.ts
//      loads it with a dynamic import(), so a Solana page pays nothing for it
//      until someone connects. Found by a string only sign-client ships
//      (SIGN_CLIENT_MARKER), every chunk holding it must be: outside the
//      entry's static closure, outside the static closure of the chunk
//      holding the adapter (found by SOLANA_WALLETCONNECT_MARKER, a phrase of
//      its own notice), and never modulepreloaded. Both markers must be FOUND:
//      a gate that found neither checked nothing.
//      A build WITHOUT VITE_WALLETCONNECT_PROJECT_ID (CI, fork PRs, clones)
//      must carry NO sign-client at all (2026-09-26): the adapter's import()
//      sits behind that literal variable, so Vite compiles it out. A lazy
//      sign-client chunk is not enough there — the bundler once hoisted its
//      @noble/@scure deps into the EAGER vendor-crypto chunk (+93 KB on every
//      page) while this gate, looking only at sign-client's own chunk, passed.
//      The id is read the way Vite reads it (loadEnv: .env files, then
//      process.env), for the default 'production' mode `npm run build` uses.
//      If the Solana WalletConnect row is ever removed, remove D with it.
//      Fixtures for every branch: scripts/check-dist-graph.test.mjs.
// And one for the Cardano swap (2026-10-24):
//   E. EMURGO's serialization library (vendor-cardano, plus its .wasm) stays LAZY: the chunk
//      exists, is outside the entry's static closure, and is never preloaded.
// And one for WebKit, the engine under every iPhone browser (2026-11-11):
//   G. No stylesheet arrives with a lazy chunk: every .css in dist/assets is one index.html links.
//
// Silent-gate discipline: this script FAILS on a missing/empty dist, on an
// unreadable entry, and on a suspiciously tiny closure — "checked nothing"
// must never exit 0. Pass a dist path as argv[2] to test against a fixture.
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';

const FRONTEND = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(process.argv[2] ?? join(FRONTEND, 'dist'));
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

function staticClosure(start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length) {
    const f = queue.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = read(f);
    for (const m of src.matchAll(STATIC_RE)) {
      const dep = m[1];
      if (!seen.has(dep)) {
        if (!chunkFiles.includes(dep)) die(`chunk ${f} statically imports missing ${dep}`);
        queue.push(dep);
      }
    }
  }
  return seen;
}

const closure = staticClosure(entryRel);
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

// ── D: WalletConnect's sign-client stays lazy ─────────────────────────────
// Log text sign-client itself prints on init; minification keeps string
// literals. NOT `WALLETCONNECT_DEEPLINK_CHOICE`: RainbowKit carries that key
// too, in the eager vendor-wagmi chunk. AppKit's nested 2.23.7 copy carries
// this marker as well, and is held to the same rules.
const SIGN_CLIENT_MARKER = 'SignClient Initialization Success';
// A phrase of PAIRING_REASONS.startFailed in src/lib/solanaWalletConnect.ts.
const SOLANA_WALLETCONNECT_MARKER = 'Check your connection, or pick another wallet';

// Whether the build had a project id, exactly as `vite build` decided it.
const WALLETCONNECT_PROJECT_ID = loadEnv('production', FRONTEND, 'VITE_').VITE_WALLETCONNECT_PROJECT_ID ?? '';

const holding = (marker) => chunkFiles.filter((f) => read(f).includes(marker));
const adapterChunks = holding(SOLANA_WALLETCONNECT_MARKER);
if (!adapterChunks.length) {
  die(
    `no chunk contains "${SOLANA_WALLETCONNECT_MARKER}", so invariant D cannot find the Solana ` +
      `WalletConnect adapter. It is a phrase of PAIRING_REASONS.startFailed in ` +
      `src/lib/solanaWalletConnect.ts: reworded there, it must be reworded here.`,
  );
}
const signClientChunks = holding(SIGN_CLIENT_MARKER);
// One path through, whichever kind of build: an early exit here would skip
// any invariant added after D.
let signClientVerdict;
if (!WALLETCONNECT_PROJECT_ID) {
  if (signClientChunks.length) {
    die(
      `this build has no VITE_WALLETCONNECT_PROJECT_ID, yet ${signClientChunks.join(', ')} carries ` +
        `@walletconnect/sign-client. A no-id build must carry none: its @noble/@scure deps land in ` +
        `eager chunks even when sign-client's own chunk is lazy. Keep every import() of it in ` +
        `src/lib/solanaWalletConnect.ts behind the literal import.meta.env.VITE_WALLETCONNECT_PROJECT_ID, ` +
        `and find what else now reaches it (ANALYZE=true vite build).`,
    );
  }
  signClientVerdict = 'no project id: sign-client in no chunk';
} else {
  if (!signClientChunks.length) {
    die(
      `no chunk contains "${SIGN_CLIENT_MARKER}", so invariant D checked nothing. Either ` +
        `@walletconnect/sign-client no longer prints it (pick a new string only its dist ships), ` +
        `or nothing loads sign-client any more — then the Solana WalletConnect row is gone, and D goes with it.`,
    );
  }
  const eagerSignClient = signClientChunks.filter((f) => closure.has(f));
  if (eagerSignClient.length) {
    die(
      `sign-client (${eagerSignClient.join(', ')}) is STATICALLY reachable from the entry chunk — ` +
        `WalletConnect's core would load on every first paint. Find the new static import chain ` +
        `(ANALYZE=true vite build).`,
    );
  }
  for (const adapterChunk of adapterChunks) {
    const reached = signClientChunks.filter((f) => staticClosure(adapterChunk).has(f));
    if (reached.length) {
      die(
        `sign-client (${reached.join(', ')}) is STATICALLY reachable from ${adapterChunk}, the chunk holding ` +
          `the Solana WalletConnect adapter. src/lib/solanaWalletConnect.ts must load it with import() ` +
          `inside loadWalletConnect(), never a static import.`,
      );
    }
  }
  const preloadedSignClient = signClientChunks.filter((f) => preloads.includes(f));
  if (preloadedSignClient.length) {
    die(`index.html modulepreloads ${preloadedSignClient.join(', ')} — sign-client must stay lazy`);
  }
  signClientVerdict = `sign-client lazy (${signClientChunks.join(', ')})`;
}

// ── E: the Cardano serialization library stays lazy (2026-10-24) ──────────
// EMURGO's CSL is 940 KB of JS glue and a 2.8 MB .wasm. Only the Cardano swap page loads it,
// through src/lib/cardano/csl.ts's import(); vite.config.ts pins it into vendor-cardano. The
// chunk must exist (an E that found nothing checked nothing), must be outside the entry's
// static closure, and neither it nor any .wasm may be modulepreloaded.
const cardanoChunks = chunkFiles.filter((f) => f.startsWith('vendor-cardano'));
if (!cardanoChunks.length) {
  die(
    `no vendor-cardano chunk, so invariant E checked nothing. Either the manualChunks rule for ` +
      `node_modules/@emurgo/ in vite.config.ts is gone, or nothing loads the Cardano library any more — ` +
      `then the Cardano swap is gone, and E goes with it.`,
  );
}
const eagerCardano = cardanoChunks.filter((f) => closure.has(f));
if (eagerCardano.length) {
  die(
    `${eagerCardano.join(', ')} is STATICALLY reachable from the entry chunk — the Cardano library would ` +
      `load on every first paint. src/lib/cardano/csl.ts must load it with import(); find the new static ` +
      `import chain (ANALYZE=true vite build).`,
  );
}
const htmlPreloads = [...html.matchAll(/<link[^>]*rel="(?:modulepreload|preload|prefetch)"[^>]*href="\/?assets\/([^"]+)"/g)].map((m) => m[1]);
const preloadedCardano = htmlPreloads.filter((f) => f.startsWith('vendor-cardano') || f.endsWith('.wasm'));
if (preloadedCardano.length) {
  die(`index.html preloads ${preloadedCardano.join(', ')} — the Cardano library must stay lazy`);
}

// F. THE EVM WALLET CHUNK CARRIES ONLY WHAT IT LOADS UP FRONT.
//
// vendor-wagmi rides in the entry's static closure: every page, on every chain, downloads
// and parses it. RainbowKit ships 18 language files (1.8 MB unpacked), every wallet's and
// chain's icon and its install illustrations as modules it imports ON DEMAND. A manualChunks
// rule that named the whole package 'vendor-wagmi' welded all of them into this chunk:
// 1,874 KB unpacked (291 KB gzipped), measured on the live site 2026-11-11. With only its
// statically imported files pinned it is about 340 KB. The ceiling sits well above that and
// far below the welded size, so the weld cannot come back unseen.
const WAGMI_CHUNK_CEILING = 700 * 1024;
const wagmiChunks = chunkFiles.filter((f) => f.startsWith('vendor-wagmi'));
if (wagmiChunks.length === 0) die('no vendor-wagmi chunk in dist/assets — invariant F checked nothing');
for (const f of wagmiChunks) {
  const bytes = Buffer.byteLength(read(f), 'utf8');
  if (bytes > WAGMI_CHUNK_CEILING) {
    die(
      `${f} is ${Math.round(bytes / 1024)} KB unpacked, over the ${WAGMI_CHUNK_CEILING / 1024} KB ceiling — ` +
        "RainbowKit's on-demand modules (language files, wallet icons) have been welded into the chunk every page loads; " +
        'see the @rainbow-me rule in vite.config.ts manualChunks',
    );
  }
}
const wagmiKb = wagmiChunks.map((f) => `${Math.round(Buffer.byteLength(read(f), 'utf8') / 1024)} KB`).join(', ');

// G. NO STYLESHEET ARRIVES WITH A LAZY CHUNK (2026-11-11).
//
// CSS a lazy chunk imports is a file of its own (vite.config.ts cssCodeSplit), fetched by a <link>
// Vite adds to the document when the chunk is asked for. WebKit, the engine under Safari and under
// every browser on an iPhone (a wallet app's own included), does not draw what a page adds while
// such a stylesheet is still loading. So a page that mounted as such a chunk was asked for went
// blank for about a second: the bar, nothing, then the footer (recorded in Playwright's WebKit,
// 0.76 to 2.0 s, and never with the stylesheet already there; a script that reads layout while it
// loads hides the blank, so only a recording shows it). It was the home and every room's door,
// with src/styles/wallet-adapter-ui.css imported by the lazy SolanaProviders; the owner met the
// flash on his iPhone. Chromium never does this, so no Chromium rig will see it come back. Every
// stylesheet the build emits must be one the first HTML already links; a module that needs CSS of
// its own gets it imported from src/main.tsx, as that file's note says.
const styleFiles = readdirSync(ASSETS).filter((f) => f.endsWith('.css'));
if (styleFiles.length === 0) die('no stylesheet in dist/assets — invariant G checked nothing');
const linkedStyles = (html.match(/<link\b[^>]*>/g) ?? [])
  .filter((tag) => /\brel="stylesheet"/.test(tag))
  .map((tag) => /\bhref="\/?assets\/([^"]+\.css)"/.exec(tag)?.[1])
  .filter(Boolean);
const lazyStyles = styleFiles.filter((f) => !linkedStyles.includes(f));
if (lazyStyles.length) {
  die(
    `${lazyStyles.join(', ')} is a stylesheet index.html does not link, so it arrives with a lazy chunk. ` +
      `WebKit does not draw a page's new content while such a stylesheet loads (Safari, every iPhone browser, a wallet app's own included): ` +
      `the page goes blank between its first frame and itself. Import that CSS from src/main.tsx, so it rides the entry's stylesheet.`,
  );
}

console.log(
  `✔ dist-graph gate: entry=${entryRel}, static closure ${closure.size} chunk(s), ` +
    `polyfill markers present, vendor-solana lazy (${preloads.length} preloads checked), ` +
    `${signClientVerdict}; adapter in ${adapterChunks.join(', ')}; ` +
    `Cardano library lazy (${cardanoChunks.join(', ')}); vendor-wagmi ${wagmiKb}. ` +
    `Every stylesheet is in the first HTML (${styleFiles.join(', ')}).`,
);
