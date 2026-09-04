import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { derivedUrl, widthsFor, artSrcSet, DERIVATIVE_WIDTHS } from './artSrcSet';

/**
 * THE GENERATOR AND THE RUNTIME MUST AGREE, and nothing else enforces it.
 *
 * scripts/generate-image-derivatives.mjs writes the files; lib/artSrcSet.ts
 * re-derives their URLs from the source path. Neither imports the other — they
 * cannot, one is a build script and one ships to the browser — so a change to the
 * naming convention, the width list, or the never-upscale rule on one side is
 * invisible to the other.
 *
 * Drift does not throw. It emits a `srcset` candidate that 404s, and a 404 in a
 * srcset is a BROKEN IMAGE, not a fallback to `src`. That is the same trap
 * ArtImg's header records from the reverted `<picture>`/AVIF attempt, which
 * assumed `<source>` falls back on a missing URL (it falls back on unsupported
 * type). This file is the thing standing between that and a repeat.
 */

const GENERATOR = readFileSync(
  join(process.cwd(), 'scripts', 'generate-image-derivatives.mjs'),
  'utf8',
);

describe('the runtime agrees with the generator', () => {
  it('reads the generator source at all', () => {
    // A guard that reads nothing passes forever.
    expect(GENERATOR.length).toBeGreaterThan(1000);
    // Sentinels that live in the BODY, not just the filename — an earlier version
    // asserted on the filename string, which the file never contains.
    expect(GENERATOR).toContain('const WIDTHS');
    expect(GENERATOR).toContain('_derived');
  });

  it('uses the same width list', () => {
    const m = GENERATOR.match(/const WIDTHS = \[([^\]]+)\]/);
    expect(m, 'WIDTHS not found in the generator').toBeTruthy();
    const generatorWidths = m![1]!.split(',').map((s) => Number(s.trim()));
    expect(generatorWidths).toEqual([...DERIVATIVE_WIDTHS]);
  });

  it('uses the same URL convention', () => {
    // Generator: '/_derived/' + stem + `-${width}.webp`
    expect(GENERATOR).toContain("'/_derived/'");
    expect(GENERATOR).toContain('-${width}.webp');
    expect(derivedUrl('/art/rose-ape.jpg', 480)).toBe('/_derived/art/rose-ape-480.webp');
    expect(derivedUrl('/art/bayla/x.png', 960)).toBe('/_derived/art/bayla/x-960.webp');
  });

  it('uses the same never-upscale rule', () => {
    // Generator: `if (naturalWidth <= width) continue;`
    expect(GENERATOR).toMatch(/naturalWidth <= width/);
  });

  it('handles a path with no extension without mangling it', () => {
    expect(derivedUrl('/art/noext', 480)).toBe('/_derived/art/noext-480.webp');
  });
});

describe('artSrcSet', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('emits nothing in dev, whatever the manifest says', () => {
    // The safety rail: the manifest is committed but the 56 MB of derivatives it
    // describes are not, so in dev those URLs do not exist.
    vi.stubEnv('PROD', false);
    expect(artSrcSet('/art/rose-ape.jpg')).toBeUndefined();
  });

  it('emits nothing for a source the manifest does not know', () => {
    vi.stubEnv('PROD', true);
    expect(artSrcSet('/art/not-a-real-file-anywhere.jpg')).toBeUndefined();
  });

  it('keeps the ORIGINAL as the widest candidate', () => {
    // Load-bearing: ART_POOL_ALL rotates one file through both a 271px thumbnail
    // and a full-bleed backdrop. Drop the original and the backdrop gets a 960px
    // upscale.
    vi.stubEnv('PROD', true);
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'src', 'lib', 'artDerivatives.generated.json'), 'utf8'),
    ) as Record<string, number>;
    const entry = Object.entries(manifest).find(([, natural]) => natural > 960);
    if (!entry) return; // empty manifest in a fresh clone — nothing to assert
    const [src, natural] = entry;
    const set = artSrcSet(src);
    expect(set).toBeDefined();
    expect(set!.endsWith(`${src} ${natural}w`)).toBe(true);
    expect(set).toContain(`${derivedUrl(src, 480)} 480w`);
  });

  it('never offers a candidate wider than the original', () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'src', 'lib', 'artDerivatives.generated.json'), 'utf8'),
    ) as Record<string, number>;
    for (const [src, natural] of Object.entries(manifest).slice(0, 200)) {
      for (const w of widthsFor(src)) {
        expect(w, `${src} would be upscaled to ${w} from ${natural}`).toBeLessThan(natural);
      }
    }
  });
});
