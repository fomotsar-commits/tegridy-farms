/**
 * Assert that dist/ actually contains every derivative the shipped manifest
 * advertises. Runs at the END of `build`, after vite has copied public/.
 *
 * WHY THIS EXISTS — a real outage, not a hypothetical.
 *
 * The generator was wired as an npm `prebuild` lifecycle hook. frontend/.npmrc
 * sets `ignore-scripts=true`, deliberately and for good reasons, and its comment
 * justified the setting partly on the grounds that "frontend/package.json
 * declares none" of these hooks. That was true when written. Adding `prebuild`
 * silently made it false: npm skips pre/post hooks under ignore-scripts, so on
 * Vercel the generator NEVER RAN, public/_derived was never created, and nothing
 * anywhere failed.
 *
 * What shipped instead: the manifest is committed, so the bundle happily
 * advertised /_derived/... candidates for files that were not deployed. Vercel's
 * SPA fallback answers an unknown path with index.html and HTTP 200, so each
 * candidate resolved to an HTML document rather than a 404 — the browser could
 * not decode it, and 20 of 27 images on the homepage rendered broken, including
 * the nav logo. A 200 is also cacheable, which a 404 mostly is not.
 *
 * Every guard that existed was looking in the wrong place: the generator's own
 * self-check validates public/_derived (never reached, because the generator
 * never ran), and the vitest checks skip when public/_derived is absent, which
 * it always is in CI. The only question that would have caught this is the one
 * asked here — does the thing we are about to SHIP contain what it claims?
 */
import { statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { derivedUrl, widthsForEntry } from './derivative-url.mjs';

const DIST = 'dist';
const MANIFEST = join('src', 'lib', 'artDerivatives.generated.json');

// derivedUrl and the width selection USED to be a private copy in this file, and
// a matching private copy lived in lib/artSrcSet.ts. Both guards then validated
// dist/ against their own idea of the URL set, so drift in the runtime copy alone
// was invisible here -- every file this script looked for would be present, this
// gate would go green, and the browser would ask for different URLs and render
// broken images. Exactly the outage in the header above, by another route.
//
// The shared module is now the single build-side answer, and artSrcSet.test.ts
// imports it to hold the runtime to the same one. See derivative-url.mjs.

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const entries = Object.entries(manifest);
if (entries.length === 0) {
  console.error('\u2716 dist derivatives: the manifest is EMPTY — the generator did not run');
  process.exit(1);
}

const missing = [];
let checked = 0;
for (const [url, entry] of entries) {
  for (const w of widthsForEntry(entry)) {
    const p = join(DIST, derivedUrl(url, w).slice(1));
    try {
      const { size } = statSync(p);
      if (size === 0) missing.push(`${p} is 0 bytes`);
    } catch {
      missing.push(p);
    }
    checked++;
  }
}

if (missing.length > 0) {
  console.error(
    `\u2716 dist derivatives: ${missing.length} of ${checked} advertised candidates are NOT in ${DIST}/.`,
  );
  console.error('  The manifest ships in the JS bundle, so every one of these becomes a');
  console.error('  broken image in production — a srcset candidate does not fall back to src.');
  for (const m of missing.slice(0, 15)) console.error(`    ${m}`);
  if (missing.length > 15) console.error(`    ... and ${missing.length - 15} more`);
  process.exit(1);
}

console.log(`\u2714 dist derivatives: all ${checked} advertised candidates present in ${DIST}/`);
