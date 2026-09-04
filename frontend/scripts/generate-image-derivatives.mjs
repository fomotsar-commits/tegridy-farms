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
import { readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, extname } from 'node:path';

/**
 * Source roots to scan. Everything under them is fair game.
 *
 * `nakamigos` and `collections` were added 2026-09-04 after measuring what the
 * app actually fetches: 2.5 MB of sources in those two directories had no
 * derivatives at all, purely because nothing had ever listed them here. They are
 * rendered by the same surfaces as everything else. `tokens` is deliberately
 * absent -- all 15 files there are under MIN_SOURCE_BYTES, so it would add a
 * directory walk and produce nothing.
 */
const SOURCE_DIRS = ['art', 'splash', 'nakamigos', 'collections'];
const PUBLIC_ROOT = 'public';
/** Derivatives live here, mirroring the source tree. Gitignored. */
const DERIVED_DIR = join(PUBLIC_ROOT, '_derived');
/** Where ArtImg reads what exists. Gitignored; a committed empty default ships beside it. */
const MANIFEST = join('src', 'lib', 'artDerivatives.generated.json');

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
    } else if (/\.(jpe?g|png|avif|webp)$/i.test(entry.name) && statSync(p).size >= MIN_SOURCE_BYTES) {
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
function readDerivedStats(dir, map = new Map()) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return map; // nothing generated yet: every candidate is correctly "stale"
  }
  for (const entry of entries) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      readDerivedStats(p, map);
    } else {
      try {
        const st = statSync(p);
        map.set(p, { mtimeMs: st.mtimeMs, size: st.size });
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

async function main() {
  const sources = SOURCE_DIRS.flatMap((d) => walk(join(PUBLIC_ROOT, d)));
  const derivedStats = readDerivedStats(DERIVED_DIR);
  const manifest = {};
  let written = 0;
  let skipped = 0;
  let oversized = 0;
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
    // Stat the SOURCE once per file rather than once per width.
    //
    // The initialisers ARE the failure behaviour, so the catch body is empty on
    // purpose. If the stat throws, mtime stays Infinity — no derivative can ever
    // be newer, so nothing is claimed current — and size stays 0, so nothing can
    // ever measure smaller and no candidate is advertised. Both defaults fall the
    // same way: serve the original. (In practice sharp has already read this file
    // one line up, so a throw here is close to unreachable.)
    let sourceMtime = Infinity;
    let sourceSize = 0;
    try {
      const st = statSync(file);
      sourceMtime = st.mtimeMs;
      sourceSize = st.size;
    } catch {
      // deliberately empty — see above
    }

    for (const width of WIDTHS) {
      // Never upscale. A source narrower than the target already IS the small one.
      if (naturalWidth <= width) continue;

      const outPath = join(PUBLIC_ROOT, derivedUrl(file, width).replace(/^\//u, ''));
      // Answered from the pre-read map, so nothing asks the filesystem about
      // outPath before writing to it. A path the walk never saw is absent, and
      // absent is stale.
      const existing = derivedStats.get(outPath);
      const fresh = (existing?.mtimeMs ?? -Infinity) >= sourceMtime;

      if (fresh) {
        // THE SIZE RULE HAS TO BE CHECKED HERE TOO, and originally was not.
        //
        // The guard below only ran when a derivative was WRITTEN. A file that
        // was already on disk from a run predating the guard read as fresh, so
        // it was never weighed and its width was advertised anyway. Found in
        // trunk: splash/new/28-960.webp, 170,824 B standing in for a 101,791 B
        // source, recorded in the manifest as if it were a saving.
        //
        // That made the generator non-idempotent in the worst way -- correct on
        // a clean checkout, quietly wrong on every incremental run, and the
        // committed manifest came from an incremental run.
        if (existing !== undefined && existing.size >= sourceSize) {
          oversized++;
          continue;
        }
        skipped++;
      } else {
        // toBuffer BEFORE the write, because the buffer has to be weighed first.
        const buf = await sharp(file).resize({ width }).webp({ quality: WEBP_QUALITY }).toBuffer();

        // A DERIVATIVE THAT IS NOT SMALLER IS NOT A DERIVATIVE.
        //
        // Found by measurement when avif sources were added to the filter above.
        // webp is not uniformly better than what it replaces: against
        // splash/new/58.avif (2000px, 253,623 B) the 480w webp is 76,810 B, but
        // the 960w webp is 284,776 B -- larger than the full-size original it
        // would be served instead of. Four of the five avif sources do this.
        //
        // srcset makes that a real regression rather than a curiosity: a
        // full-bleed surface picks the smallest candidate at least as wide as it
        // needs, so it would take the 960 and download MORE than before the
        // optimisation existed. Skipping the candidate leaves the original as
        // the next one up, which is exactly the pre-change behaviour.
        //
        // The rule was written for avif and then caught five JPEGs on its first
        // run -- splash/new/8, 14, 17, 18, 20 and 39, all 1000-1700px, all of
        // whose 960w webp came out larger than the jpeg it stands in for. Those
        // were already shipping before avif was ever added to the filter, which
        // means this pipeline has been serving small regressions on them since
        // it was written, and nothing would have reported it. The guard is not
        // an avif special case; avif is just what made it visible.
        if (buf.length >= sourceSize) {
          oversized++;
          continue;
        }

        mkdirSync(dirname(outPath), { recursive: true });
        // toBuffer + write rather than toFile: toFile has been seen to fail on
        // this OneDrive-backed tree while a plain write to the same path succeeds.
        writeFileSync(outPath, buf);
        written++;
        derivedBytes += buf.length;
      }
      entries.push({ width, url: derivedUrl(file, width) });
    }

    if (entries.length > 0) {
      sourceBytes += statSync(file).size;
      // THE MANIFEST STORES THE NATURAL WIDTH, AND THE WIDTH LIST ONLY WHEN IT
      // CANNOT BE DERIVED.
      //
      // The derivative URLs are fully derivable from the source path, and for
      // almost every source the rule for WHICH widths exist is exactly
      // `natural > width`. Storing the URLs too made the manifest 77,633 B, and
      // it ships in the JS bundle, so a feature meant to save bytes was quietly
      // spending them.
      //
      // The size guard above broke that derivation for a handful of sources: a
      // width can now be missing even though the source is wider than it. The
      // runtime cannot infer which, and guessing wrong is not a soft failure —
      // an advertised candidate that 404s is a BROKEN IMAGE, not a fallback.
      //
      // So those sources, and only those, carry an explicit list. Number means
      // "derive it"; array means [natural, ...the widths that really exist].
      // Five entries pay the extra bytes; the other 417 do not. Keep the two
      // derivations in lock-step: `derivedUrl` here and `derivedUrl` in
      // lib/artSrcSet.ts are the same convention, and artSrcSet.test.ts pins
      // them against each other.
      const derivable = WIDTHS.filter((w) => naturalWidth > w);
      const actual = entries.map((e) => e.width);
      manifest[publicUrl(file)] =
        actual.length === derivable.length && actual.every((w, i) => w === derivable[i])
          ? naturalWidth
          : [naturalWidth, ...actual];
    }
  }

  mkdirSync(dirname(MANIFEST), { recursive: true });
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 0) + '\n');

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(
    `✔ image derivatives: ${Object.keys(manifest).length} sources with variants ` +
      `(${written} written, ${skipped} already fresh` +
      `${oversized > 0 ? `, ${oversized} skipped as not smaller` : ''}) in ${secs}s`,
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
