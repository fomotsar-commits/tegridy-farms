#!/usr/bin/env node
/**
 * Build-time responsive derivatives for the art library.
 *
 * WHY THIS EXISTS. Measured on the production build, one homepage view fetches
 * 5,117,404 B of images — more than its JavaScript. The cause is not format, it
 * is that full-resolution art is used as thumbnails: 24 rendered <img> are served
 * at more than 2x their display width, and the worst are far past that —
 * rose-ape.jpg is 2048x2048 shown at 271x128 (463 KB), island-mark.png is 512x512
 * shown at 26x26. A field review read this as "unoptimised art" and asked for
 * AVIF; the format was never the problem.
 *
 * WHY NOT JUST SHRINK THE SOURCES. The owner's standing rule is that art is never
 * swapped or removed, and it could not work anyway: ART_POOL_ALL rotates the same
 * files through every <ArtImg> surface, so an image that is a 271x128 thumbnail on
 * the homepage is a full-bleed backdrop somewhere else. Downscaling in place would
 * degrade the second surface to fix the first. Derivatives are the only correct
 * answer, and the originals are never touched.
 *
 * WHY A MANIFEST rather than deriving URLs by convention. ArtImg's own header
 * records the trap: an earlier attempt emitted <picture> with a derived .avif
 * source on the assumption that browsers fall back when it 404s. They do not —
 * <source> falls back on unsupported TYPE, not on a missing URL. A srcset
 * candidate that 404s is the same class of bug. So this writes a manifest of what
 * actually exists, ArtImg emits srcset only for paths in it, and a source with no
 * derivative keeps rendering exactly as it does today. In dev, with no manifest
 * generated, the manifest is empty and nothing changes — the failure mode is
 * "no optimisation", never "broken image".
 *
 * CACHING. vercel.json carries a `/_derived/(.*)` rule with the same week-long
 * TTL as `/art` and `/splash`, which staticAssetCaching.test.ts requires of every
 * static media directory. It lives there without an explanatory comment because
 * Vercel's `headers` schema rejects unknown keys — a `_comment` field inside one
 * of those entries fails the DEPLOYMENT, not the JSON parse, so the reason is
 * recorded here instead: a derivative's URL encodes its source path and width, so
 * it changes only when the source does.
 *
 * OUTPUT IS GENERATED, NEVER COMMITTED. public/ is tracked, and 347 sources x 2
 * widths would add hundreds of megabytes to the repo. Both the derivative tree and
 * the manifest are gitignored and rebuilt by `npm run build` (npm runs `prebuild`
 * automatically). Incremental: a derivative newer than its source is skipped, so
 * repeat builds cost almost nothing.
 */
import sharp from 'sharp';
import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative, dirname, extname } from 'node:path';

/** Source roots to scan. Everything under them is fair game. */
const SOURCE_DIRS = ['art', 'splash'];
const PUBLIC_ROOT = 'public';
/** Derivatives live here, mirroring the source tree. Gitignored. */
const DERIVED_DIR = join(PUBLIC_ROOT, '_derived');
/** Where ArtImg reads what exists. Gitignored; a committed empty default ships beside it. */
const MANIFEST = join('src', 'lib', 'artDerivatives.generated.json');

/** The registry the door thumbnails are declared in. Read as TEXT, not imported:
 *  this script runs under plain Node with no TS loader (same constraint as
 *  scripts/render-bungalow-doors.mjs). */
const BUNGALOWS_TS = join('src', 'lib', 'bungalows.ts');
/** Per-thumbnail brightness multipliers for the settled-door grid. Committed. */
const LUMA_MANIFEST = join('src', 'lib', 'doorThumbLuma.generated.json');

/**
 * SETTLED-DOOR LUMINANCE NORMALISATION (2026-09-04 field review).
 *
 * A settled door is rendered `grayscale` at full brightness. Desaturation alone
 * says nothing about lightness, so where each tile LANDS is whatever exposure
 * its painting happened to have. Measured across the twelve door thumbnails, the
 * mean grey ran from 0.270 (wrestler.jpg, BNKR) to 0.841 (mumu-bull.jpg, PEPE) --
 * a 3.1x spread, which is why the darkest few read as switched off while the
 * brightest read as barely dimmed at all. The set had no rhythm because nothing
 * was giving it one.
 *
 * The review diagnosed this as a flat `brightness(0.45)` multiplier. There is no
 * such multiplier anywhere in the tree and never was -- but the SYMPTOM it
 * described was real and measurable, which is why this exists.
 *
 * Each thumbnail therefore gets its own multiplier, computed from its actual
 * measured mean so they all arrive at the same place. That is the reviewer's
 * second suggestion ("drive the filter from each image's measured average
 * brightness") rather than the first ("normalise the sources"), because the
 * sources are shared: ART_POOL_ALL rotates these same files through full-bleed
 * surfaces where they must stay exactly as painted. The originals are untouched.
 *
 * TARGET is the measured MEDIAN of the current set, not a taste value: aiming at
 * the middle of where the art already sits moves the outliers and leaves the
 * majority almost where they were, so the grid gains evenness without the whole
 * hall being silently re-graded.
 */
const LUMA_TARGET = 0.46;
/**
 * Multipliers are clamped. An unclamped correction for the darkest tile is 1.70x,
 * which lifts compression noise and film grain out of the shadows along with the
 * subject -- the tile stops being too dark and starts being ugly. Clamping leaves
 * the two extremes slightly off-target (0.41 and 0.51 rather than 0.46), which is
 * a 1.25x residual spread against the 3.1x we started with, and no visible
 * artefacts. Evenness is the goal, not uniformity for its own sake.
 */
const LUMA_MIN = 0.6;
const LUMA_MAX = 1.5;

/**
 * Only files big enough to be worth a second copy. Below this the derivative can
 * be LARGER than the original once webp overhead and a re-encode are paid for,
 * and the build time is spent for nothing.
 *
 * LOWERED 150 KB -> 80 KB on 2026-09-04, from measurement rather than taste. After
 * the first pass the homepage's remaining offenders were almost all just under the
 * old floor — mumu-bull 143 KB, sword-of-love 142 KB, boxing-ring 126 KB,
 * dance-night 118 KB, bayla-14 95 KB — every one of them a 271x128 thumbnail
 * carrying a 900-2000px source. The floor was excluding exactly the files the
 * feature exists for.
 */
const MIN_SOURCE_BYTES = 80 * 1024;

/**
 * 128 is for ICON slots and it earns its place on its own: the nav logo renders at
 * 26x26 from a 512x512 PNG, so even the 480 candidate was ~18x its display size.
 * 480 covers a phone at 1x and the card thumbnails that dominate the waste; 960
 * covers a phone at 2x and tablets. Anything wider keeps the original, which stays
 * in the srcset as the largest candidate so full-bleed surfaces are unaffected.
 *
 * Adding a width costs one more file per eligible source and a little build time;
 * it does NOT cost the client anything, because the browser downloads exactly one
 * candidate. Keep this list in lock-step with DERIVATIVE_WIDTHS in
 * lib/artSrcSet.ts — artSrcSet.test.ts compares them.
 */
const WIDTHS = [128, 480, 960];

/** webp, not avif: comparable size at this quality and far cheaper to encode 347 files. */
const WEBP_QUALITY = 78;

function walk(dir, out = []) {
  // NO EXISTENCE CHECK BEFORE THE READ. Asking whether a path is there and then
  // acting on the answer is a check-then-use race: the path can change in the
  // gap. CodeQL flags the shape as js/file-system-race at HIGH severity, and it
  // is right to. Attempting the read and handling its failure is both correct
  // and one syscall cheaper.
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // absent or unreadable - nothing to derive from
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Never recurse into our own output.
      if (p !== DERIVED_DIR) walk(p, out);
    } else if (/\.(jpe?g|png)$/i.test(entry.name) && statSync(p).size >= MIN_SOURCE_BYTES) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Every derivative already on disk, path -> mtime, from ONE pass over the tree.
 *
 * This exists because of how the freshness check used to be written: stat the
 * output path, compare, then write to that same path. CodeQL flags that as
 * js/file-system-race at HIGH and does not stop flagging it when the guard is
 * rewritten as a try/catch, because the shape it objects to is not the guard --
 * it is asking a question ABOUT A PATH and then acting on that path, with a gap
 * in between that the filesystem is free to change. Removing the question is the
 * only thing that removes the race.
 *
 * So the question is asked once, about the DIRECTORY, before any writing starts,
 * and the answer is carried in memory. Nothing is ever consulted about `outPath`
 * on the write side; the map is. That is also two fewer syscalls per candidate --
 * this replaces 2 stats x 1230 candidates with one walk.
 */
function readDerivedMtimes(dir, map = new Map()) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return map; // nothing generated yet: every candidate is correctly "stale"
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      readDerivedMtimes(p, map);
    } else {
      try {
        map.set(p, statSync(p).mtimeMs);
      } catch {
        // Vanished mid-walk. Leaving it out of the map marks it stale, which
        // regenerates it -- the safe direction to be wrong in.
      }
    }
  }
  return map;
}

/** `public/art/x.jpg` -> `/art/x.jpg`, the URL ArtImg actually renders. */
function publicUrl(file) {
  return '/' + relative(PUBLIC_ROOT, file).split(/[\\/]/u).join('/');
}

/** `public/art/x.jpg` @480 -> `/_derived/art/x-480.webp` */
function derivedUrl(file, width) {
  const rel = relative(PUBLIC_ROOT, file).split(/[\\/]/u).join('/');
  return '/_derived/' + rel.slice(0, rel.length - extname(rel).length) + `-${width}.webp`;
}

/**
 * Measure each door thumbnail and write its brightness multiplier.
 *
 * Keyed by the thumbnail's public URL, which is exactly what `bungalow.thumb`
 * holds, so VenueDoors looks its own value up with no mapping step. Only the
 * door thumbnails are measured -- roughly a dozen entries -- because this file
 * ships in the homepage's JS and the whole art library would be 347 of them for
 * a treatment only the settled-door grid applies.
 *
 * NO EXISTENCE CHECKS HERE EITHER, for the reason `walk` records above: asking
 * whether a path is there and then acting on it is the check-then-use shape
 * CodeQL flags as js/file-system-race at HIGH. Both reads are simply attempted
 * and their failure handled. That is also the honest failure mode -- an
 * unreadable thumbnail gets no entry, and VenueDoors falls back to plain
 * `grayscale`, exactly as it behaved before this existed. "No normalisation",
 * never a broken tile.
 */
async function writeDoorThumbLuma() {
  const out = {};
  let registry = '';
  try {
    registry = readFileSync(BUNGALOWS_TS, 'utf8');
  } catch {
    // No registry to read: no entries, and every tile keeps plain grayscale.
  }
  // Only the path is needed -- the map is keyed by URL, so there is no id to
  // pair up and no fragile proximity matching to get wrong.
  const thumbs = [...new Set([...registry.matchAll(/thumb:\s*'([^']+)'/gu)].map((m) => m[1]))];
  for (const url of thumbs) {
    const file = join(PUBLIC_ROOT, url.replace(/^\//u, ''));
    try {
      const stats = await sharp(file).greyscale().stats();
      const mean = (stats.channels[0]?.mean ?? 0) / 255;
      if (!(mean > 0)) continue;
      const k = Math.min(LUMA_MAX, Math.max(LUMA_MIN, LUMA_TARGET / mean));
      out[url] = Number(k.toFixed(3));
    } catch {
      // Absent or unreadable by sharp -- no entry, plain grayscale, as before.
    }
  }
  mkdirSync(dirname(LUMA_MANIFEST), { recursive: true });
  writeFileSync(LUMA_MANIFEST, JSON.stringify(out, null, 0) + '\n');
  return Object.keys(out).length;
}

async function main() {
  const sources = SOURCE_DIRS.flatMap((d) => walk(join(PUBLIC_ROOT, d)));
  const derivedMtimes = readDerivedMtimes(DERIVED_DIR);
  const manifest = {};
  let written = 0;
  let skipped = 0;
  let sourceBytes = 0;
  let derivedBytes = 0;
  const startedAt = Date.now();

  for (const file of sources) {
    let meta;
    try {
      meta = await sharp(file).metadata();
    } catch {
      // A file sharp cannot read is not a build failure — it simply gets no
      // derivative and keeps rendering from its original, which is the same
      // outcome as not being in the manifest at all.
      continue;
    }
    const naturalWidth = meta.width ?? 0;
    const entries = [];
    // Stat the SOURCE once per file rather than once per width. A source that
    // vanished between the walk and here gets -Infinity, which makes every
    // candidate stale -- sharp then fails on it and the catch above skips it.
    let sourceMtime = Infinity;
    try {
      sourceMtime = statSync(file).mtimeMs;
    } catch {
      sourceMtime = Infinity; // unknowable: never claim a derivative is current
    }

    for (const width of WIDTHS) {
      // Never upscale. A source narrower than the target already IS the small one.
      if (naturalWidth <= width) continue;

      const outPath = join(PUBLIC_ROOT, derivedUrl(file, width).replace(/^\//u, ''));
      // Answered from the pre-read map, so nothing asks the filesystem about
      // outPath before writing to it. A path the walk never saw is absent, and
      // absent is stale.
      const fresh = (derivedMtimes.get(outPath) ?? -Infinity) >= sourceMtime;

      if (fresh) {
        skipped++;
      } else {
        mkdirSync(dirname(outPath), { recursive: true });
        // toBuffer + write rather than toFile: toFile has been seen to fail on
        // this OneDrive-backed tree while a plain write to the same path succeeds.
        const buf = await sharp(file).resize({ width }).webp({ quality: WEBP_QUALITY }).toBuffer();
        writeFileSync(outPath, buf);
        written++;
        derivedBytes += buf.length;
      }
      entries.push({ width, url: derivedUrl(file, width) });
    }

    if (entries.length > 0) {
      sourceBytes += statSync(file).size;
      // THE MANIFEST STORES ONLY THE NATURAL WIDTH, nothing else.
      //
      // The derivative URLs are fully derivable from the source path, and the
      // rule for WHICH widths exist is exactly `natural > width` — the same test
      // used above. Storing the URLs too made the manifest 77,633 B, and it ships
      // in the JS bundle, so a feature meant to save bytes was quietly spending
      // them. Keep the two derivations in lock-step: `derivedUrl` here and
      // `derivedUrl` in lib/artSrcSet.ts are the same convention, and
      // artSrcSet.test.ts pins them against each other.
      manifest[publicUrl(file)] = naturalWidth;
    }
  }

  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 0) + '\n');

  const luma = await writeDoorThumbLuma();

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`✔ door thumbnail luminance: ${luma} normalised`);
  console.log(
    `✔ image derivatives: ${Object.keys(manifest).length} sources with variants ` +
      `(${written} written, ${skipped} already fresh) in ${secs}s`,
  );
  if (written > 0) {
    console.log(
      `  new derivative bytes ${derivedBytes.toLocaleString()} against ` +
        `${sourceBytes.toLocaleString()} B of originals they stand in for`,
    );
  }
}

main().catch((err) => {
  // Fail the build loudly. A silently missing manifest would just mean "no
  // optimisation", which is safe — but a half-written one is not worth guessing at.
  console.error('image-derivatives: ' + (err?.message ?? err));
  process.exit(1);
});
