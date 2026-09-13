/**
 * The ONE build-side answer to "which files does a manifest entry advertise?".
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Three places have to agree about the derivative URL scheme, and none of them
 * can import another:
 *
 *   generate-image-derivatives.mjs   WRITES the files (build step 1)
 *   verify-dist-derivatives.mjs      checks dist/ contains them (build step, last)
 *   src/lib/artSrcSet.ts             asks the BROWSER for them (ships in the bundle)
 *
 * The third is TypeScript compiled for a browser, so the scripts cannot import it
 * and it cannot import them. That is a real constraint, not an oversight. What was
 * NOT forced was the first two keeping separate copies of the same fifteen lines,
 * which is what they had.
 *
 * WHY THE DUPLICATION MATTERED. Both build-time guards validated dist/ against
 * THEIR OWN idea of the URL set. So drift in one of them was invisible to the
 * other, and drift in `lib/artSrcSet.ts` alone was invisible to BOTH: the files the
 * scripts looked for would all be present, every gate green, and the browser would
 * request different URLs and render broken images. That is precisely the outage
 * verify-dist-derivatives.mjs was written for -- a bundle advertising candidates
 * that do not resolve -- reached by a different route, with nothing watching it.
 *
 * HOW THE THREE ARE HELD TOGETHER NOW
 *   generator vs. this file     verify-dist-derivatives.mjs fails the BUILD if the
 *                               generator wrote URLs this scheme does not name.
 *   runtime vs. this file       artSrcSet.test.ts imports this module and asserts
 *                               the runtime produces an identical candidate set for
 *                               every entry in the real manifest. That comparison
 *                               reads no derivatives from disk, so unlike the
 *                               on-disk assertions in that file it actually runs in
 *                               CI, where public/_derived never exists.
 *
 * Keep this module dependency-free and side-effect-free: a vitest run imports it.
 */

/** Keep in lock-step with DERIVATIVE_WIDTHS in src/lib/artSrcSet.ts. */
export const WIDTHS = [128, 480, 960];

/**
 * `/art/x.jpg` @480 -> `/_derived/art/x-jpg-480.webp`.
 *
 * THE EXTENSION STAYS IN THE NAME. Dropping it made /splash/new/1.avif and
 * /splash/new/1.jpg -- two manifest entries with DIFFERENT natural widths --
 * resolve to one derived file, so whichever the walk reached last overwrote the
 * other and both entries then advertised it. Those pairs happen to be the same
 * picture in two formats today; nothing enforces that they always will be.
 */
export function derivedUrl(url, width) {
  const dot = url.lastIndexOf('.');
  const stem = dot === -1 ? url : url.slice(0, dot);
  const tag = dot === -1 ? '' : `-${url.slice(dot + 1).toLowerCase()}`;
  return `/_derived${stem}${tag}-${width}.webp`;
}

/**
 * The widths a manifest entry advertises, in manifest order.
 *
 * The two forms are not interchangeable. A bare number means "derive the widths
 * from the natural width"; an ARRAY means `[natural, ...the widths that really
 * exist]` and is AUTHORITATIVE -- it exists precisely because deriving would give
 * more widths than were written (a webp that comes out no smaller than its source
 * is not written at all). Re-deriving over an array form is the bug the array form
 * was added to prevent.
 */
export function widthsForEntry(entry) {
  if (Array.isArray(entry)) return entry.slice(1);
  const natural = entry;
  if (!natural) return [];
  return WIDTHS.filter((w) => natural > w);
}
