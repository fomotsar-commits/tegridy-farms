#!/usr/bin/env node
/**
 * render-og-png.mjs — Rasterize docs/banner.svg to frontend/public/og.png.
 *
 * Why this script exists:
 *   Our social preview ships as SVG (docs/banner.svg + frontend/public/og.svg).
 *   Modern Twitter, LinkedIn, Discord, Slack render SVG correctly, but some
 *   older crawlers and image-proxy CDNs only accept raster formats. This
 *   script produces a PNG sibling so both are available.
 *
 * Usage:
 *   # Recommended (zero install — only during script run):
 *   npx --yes -p @resvg/resvg-js@2 node scripts/render-og-png.mjs
 *
 *   # Or pre-installed:
 *   pnpm add -Dw @resvg/resvg-js       # root or frontend, as a devDep
 *   node scripts/render-og-png.mjs
 *
 * Output:
 *   frontend/public/og.png (1280×640, PNG-8 or PNG-24 depending on content)
 *
 * The script fails loudly with a clear install hint if @resvg/resvg-js isn't
 * resolvable, so CI builds don't silently skip the raster export.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const SVG_PATH = join(REPO_ROOT, 'docs', 'banner.svg');
const PNG_OUT_A = join(REPO_ROOT, 'frontend', 'public', 'og.png');
const PNG_OUT_B = join(REPO_ROOT, 'docs', 'banner.png');

async function main() {
  if (!existsSync(SVG_PATH)) {
    console.error(`ERR: missing source SVG at ${SVG_PATH}`);
    console.error('     Run this script from the repo root.');
    process.exit(1);
  }

  let Resvg;
  try {
    // Dynamic import so we can produce a friendly error instead of a stack trace.
    ({ Resvg } = await import('@resvg/resvg-js'));
  } catch (err) {
    console.error('ERR: @resvg/resvg-js is not installed.');
    console.error('');
    console.error('     Quickest path (one-shot, no persistent devDep):');
    console.error('       npx --yes -p @resvg/resvg-js@2 node scripts/render-og-png.mjs');
    console.error('');
    console.error('     Or install it alongside the other devDeps:');
    console.error('       pnpm add -Dw @resvg/resvg-js');
    console.error('');
    console.error(`     Underlying error: ${err?.message ?? err}`);
    process.exit(1);
  }

  const svg = readFileSync(SVG_PATH);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: 1280 },
    background: '#060c1a',
    font: {
      // Bundled fonts aren't critical; the banner uses system-ui fallbacks
      // and the wordmark renders with the default Playfair-like serif. If
      // you want exact production fonts, point `fontFiles` at the WOFF2s
      // in frontend/public/fonts/.
      loadSystemFonts: true,
    },
  });
  const png = resvg.render().asPng();

  for (const outPath of [PNG_OUT_A, PNG_OUT_B]) {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, png);
    const kb = (png.length / 1024).toFixed(1);
    console.log(`✓ wrote ${outPath} (${kb} KB, 1280×640)`);
  }

  console.log('');
  console.log('Next: update og:image in frontend/index.html to point at /og.png');
  console.log('      (the SVG fallback can stay as og:image:secure_url for modern crawlers).');
}

main().catch((err) => {
  console.error('Rasterize failed:', err);
  process.exit(1);
});
