#!/usr/bin/env node
/**
 * Writes dist/llms.txt (answer ten, §2: llms.txt, generated at build).
 *
 * IN THE EXPLICIT BUILD CHAIN, NEVER A pre/post HOOK. .npmrc sets ignore-scripts,
 * which silently skips lifecycle hooks on Vercel; a hook-run generator is exactly how
 * production once shipped a manifest advertising files that were never built. It runs
 * after `vite build` (which empties dist) and after the door prerender.
 *
 * THE CONTENT IS NOT WRITTEN HERE. It comes from src/lib/llmsTxt.ts, the same
 * constants the app renders, loaded through Vite's own module loader in production
 * mode so VITE_* build variables resolve exactly as they did for the bundle. This
 * script only supplies what a module cannot know: the address ledger, the date and
 * the commit. src/lib/llmsTxt.test.ts guards the content.
 *
 * FAILS THE BUILD rather than shipping a doubtful file: missing dist, non-ASCII
 * output (which would also be an em dash), or a first line that is not the title.
 * A static file matters here because a missing one is not a 404 on Vercel: the SPA
 * fallback answers 200 text/html, and an assistant would read the app shell.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(FRONTEND, 'dist');

if (!existsSync(resolve(DIST, 'index.html'))) {
  throw new Error('[llms-txt] dist/index.html not found: run after `vite build`.');
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
try {
  const mod = await server.ssrLoadModule('/src/lib/llmsTxt.ts');
  text = mod.renderLlmsTxt(mod.collectFacts(ledger), { date, commit });
} finally {
  await server.close();
}

const nonAscii = [...text].filter((c) => c.charCodeAt(0) > 127);
if (nonAscii.length > 0) {
  throw new Error(`[llms-txt] ${nonAscii.length} non-ASCII character(s) in the output, e.g. ${JSON.stringify(nonAscii[0])}.`);
}
if (!text.startsWith('# memetics.finance\n')) {
  throw new Error('[llms-txt] the output does not open with its title line.');
}

const out = resolve(DIST, 'llms.txt');
writeFileSync(out, text, 'utf8');
if (readFileSync(out, 'utf8') !== text) throw new Error('[llms-txt] dist/llms.txt did not read back as written.');
console.log(`[llms-txt] wrote dist/llms.txt (${text.length} bytes${commit ? `, commit ${commit}` : ''})`);
