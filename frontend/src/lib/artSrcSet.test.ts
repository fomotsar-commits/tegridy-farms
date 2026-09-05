import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { derivedUrl, widthsFor, artSrcSet, naturalWidthOf, DERIVATIVE_WIDTHS } from './artSrcSet';

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
    // Generator: `/_derived/${stem}${tag}-${width}.webp`, tag = '-' + extension
    expect(GENERATOR).toContain('/_derived/${stem}${tag}-${width}.webp');
    expect(derivedUrl('/art/rose-ape.jpg', 480)).toBe('/_derived/art/rose-ape-jpg-480.webp');
    expect(derivedUrl('/art/bayla/x.png', 960)).toBe('/_derived/art/bayla/x-png-960.webp');
  });

  it('keeps the extension, so two sources cannot claim one derived file', () => {
    // THE BUG THIS REPLACED. derivedUrl used to drop the extension, so
    // /splash/new/1.avif and /splash/new/1.jpg -- both in the manifest, with
    // DIFFERENT natural widths (1280 and 940) -- mapped to the same file.
    // Whichever the walk reached last overwrote the other and both entries then
    // advertised it. It happened to be harmless only because those pairs are the
    // same picture in two formats; nothing enforced that.
    expect(derivedUrl('/splash/new/1.avif', 480)).not.toBe(derivedUrl('/splash/new/1.jpg', 480));
    expect(derivedUrl('/splash/new/1.avif', 480)).toBe('/_derived/splash/new/1-avif-480.webp');
    expect(derivedUrl('/splash/new/1.jpg', 480)).toBe('/_derived/splash/new/1-jpg-480.webp');
  });

  it('NO two manifest sources map to the same derived URL', () => {
    // The general form of the above, checked against the real manifest rather
    // than two hand-picked paths, so a NEW colliding pair fails here too.
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), 'src', 'lib', 'artDerivatives.generated.json'), 'utf8'),
    ) as Record<string, number | number[]>;
    const seen = new Map<string, string>();
    for (const src of Object.keys(manifest)) {
      for (const w of DERIVATIVE_WIDTHS) {
        const url = derivedUrl(src, w);
        const prior = seen.get(url);
        expect(prior, `${src} and ${prior} both resolve to ${url}`).toBeUndefined();
        seen.set(url, src);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('uses the same never-upscale rule', () => {
    // Generator: `if (naturalWidth <= width) continue;`
    expect(GENERATOR).toMatch(/naturalWidth <= width/);
  });

  it('still writes an explicit width list when it drops a candidate', () => {
    // The generator may now skip a width whose webp is not smaller than the
    // source. When it does, the derived rule `natural > width` is WRONG for that
    // source, so the generator must record the real list instead. If this
    // branch is ever removed while the size guard stays, every dropped candidate
    // becomes a 404 in a srcset — a broken image, silently.
    expect(GENERATOR).toMatch(/buf\.length >= sourceSize/);
    expect(GENERATOR).toMatch(/\[naturalWidth, \.\.\.actual\]/);
  });

  it('handles a path with no extension without mangling it', () => {
    // No extension means no tag to add — not an empty '-' segment.
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
    ) as Record<string, number | number[]>;
    for (const [src, entry] of Object.entries(manifest).slice(0, 200)) {
      const natural = Array.isArray(entry) ? entry[0]! : entry;
      for (const w of widthsFor(src)) {
        expect(w, `${src} would be upscaled to ${w} from ${natural}`).toBeLessThan(natural);
      }
    }
  });
});

describe('the two manifest forms', () => {
  const manifest = JSON.parse(
    readFileSync(join(process.cwd(), 'src', 'lib', 'artDerivatives.generated.json'), 'utf8'),
  ) as Record<string, number | number[]>;

  it('EVERY advertised candidate has a file behind it', () => {
    // THE assertion this whole contract exists for, and the only one that would
    // have caught the bug the array form prevents. A srcset candidate whose file
    // is absent renders as a broken image; it does not fall back to `src`.
    //
    // Derivatives are gitignored, so this can only run where a build has run.
    // Skipping quietly where they are absent is deliberate — but the skip is
    // reported, because a guard that silently passes on a fresh clone and in CI
    // is not a guard.
    const derivedRoot = join(process.cwd(), 'public', '_derived');
    if (!existsSync(derivedRoot)) {
      console.warn('[artSrcSet] public/_derived absent — candidate-existence check skipped');
      return;
    }
    let checked = 0;
    for (const src of Object.keys(manifest)) {
      for (const w of widthsFor(src)) {
        const onDisk = join(process.cwd(), 'public', derivedUrl(src, w).replace(/^\//u, ''));
        expect(existsSync(onDisk), `${src} advertises ${w}w but ${onDisk} is missing`).toBe(true);
        checked++;
      }
    }
    expect(checked, 'nothing was checked — the manifest read as empty').toBeGreaterThan(0);
  });

  it('NO advertised candidate is larger than the source it stands in for', () => {
    // THE POINT OF THE SIZE GUARD, pinned as the property rather than as a
    // count of manifest entries.
    //
    // A candidate bigger than its source is a REGRESSION, not a saving: with
    // srcset a full-bleed surface picks the smallest candidate wide enough for
    // it, so it would download more than it did before any of this existed.
    //
    // This is not hypothetical. splash/new/28-960.webp shipped to trunk at
    // 170,824 B standing in for a 101,791 B source, because the guard only ran
    // when a derivative was WRITTEN — a file left over from a run predating the
    // guard read as "fresh" and was never weighed. The generator was correct on
    // a clean checkout and wrong on every incremental run, which is exactly the
    // shape that survives review.
    const derivedRoot = join(process.cwd(), 'public', '_derived');
    if (!existsSync(derivedRoot)) {
      console.warn('[artSrcSet] public/_derived absent — size-guard check skipped');
      return;
    }
    let checked = 0;
    for (const src of Object.keys(manifest)) {
      const srcPath = join(process.cwd(), 'public', src.replace(/^\//u, ''));
      if (!existsSync(srcPath)) continue;
      const sourceBytes = statSync(srcPath).size;
      for (const w of widthsFor(src)) {
        const p = join(process.cwd(), 'public', derivedUrl(src, w).replace(/^\//u, ''));
        if (!existsSync(p)) continue; // covered by the candidate-existence test
        expect(
          statSync(p).size,
          `${src} advertises ${w}w at ${statSync(p).size} B for a ${sourceBytes} B source`,
        ).toBeLessThan(sourceBytes);
        checked++;
      }
    }
    expect(checked, 'nothing was checked — no derivatives on disk').toBeGreaterThan(0);
  });

  it('reads the natural width the same way from both forms', () => {
    const arrayEntry = Object.entries(manifest).find(([, v]) => Array.isArray(v));
    const numberEntry = Object.entries(manifest).find(([, v]) => !Array.isArray(v));
    if (numberEntry) {
      expect(naturalWidthOf(numberEntry[0])).toBe(numberEntry[1]);
    }
    if (arrayEntry) {
      const [src, v] = arrayEntry as [string, number[]];
      expect(naturalWidthOf(src)).toBe(v[0]);
      // And the list is taken verbatim, NOT re-derived — re-deriving is exactly
      // the bug, since the entry only exists because deriving gives more widths
      // than were written.
      expect(widthsFor(src)).toEqual(v.slice(1));
      expect(widthsFor(src).length).toBeLessThan(
        DERIVATIVE_WIDTHS.filter((w) => v[0]! > w).length,
      );
    }
  });

  it('has at least one of each form, or the test above proves nothing', () => {
    const forms = Object.values(manifest).map((v) => (Array.isArray(v) ? 'list' : 'number'));
    expect(forms).toContain('number');
    // If this ever fails, the size guard stopped firing — which is fine in
    // itself, but it means the array branch is no longer covered by real data.
    expect(forms).toContain('list');
  });
});
