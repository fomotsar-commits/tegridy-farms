import DERIVATIVES from './artDerivatives.generated.json';

/**
 * The runtime half of the responsive-art pipeline. Its partner is
 * scripts/generate-image-derivatives.mjs, which writes both the derivative files
 * and the manifest this reads.
 *
 * THE CONTRACT BETWEEN THE TWO HALVES, because getting it wrong is silent:
 *   - the generator emits `/_derived/<path-without-ext>-<width>.webp`
 *   - it emits a width only when the source is genuinely WIDER than it
 *   - it records the source's natural width in the manifest, and nothing else
 * `derivedUrl` and `widthsFor` below re-derive exactly those rules.
 * artSrcSet.test.ts pins them against the generator's own source so the two
 * cannot drift apart — a drift here does not throw, it 404s a srcset candidate,
 * and a 404 in a srcset is a broken image rather than a graceful fallback.
 *
 * WHY THIS IS SAFE WHEN THE MANIFEST IS EMPTY. A checkout that has not run the
 * build (a dev server, a fresh clone, a CI job that never builds) sees `{}`, every
 * lookup misses, and `artSrcSet` returns undefined — so <img> renders exactly as
 * it did before this existed. The failure mode is "no optimisation", never
 * "broken image", which is the same reason the manifest exists at all instead of
 * deriving URLs by convention and hoping they resolve.
 */

/** Kept in lock-step with WIDTHS in scripts/generate-image-derivatives.mjs. */
export const DERIVATIVE_WIDTHS = [128, 480, 960] as const;

/**
 * `natural` for the ordinary case, `[natural, ...widths]` for the few sources
 * whose width list cannot be derived. See the manifest comment in the generator:
 * a webp that comes out no smaller than its source is not written, which for
 * four of the five avif sources takes out the 960 candidate even though they are
 * 2000px wide. Deriving would advertise a URL that is not there.
 */
type ManifestEntry = number | number[];
const MANIFEST = DERIVATIVES as unknown as Record<string, ManifestEntry>;

/** The source's true pixel width, whichever form the entry takes. */
export function naturalWidthOf(src: string): number | undefined {
  const v = MANIFEST[src];
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/** `/art/x.jpg` @480 -> `/_derived/art/x-480.webp`. Mirrors the generator. */
export function derivedUrl(src: string, width: number): string {
  // The extension stays IN the name. Two sources differing only by extension
  // (/splash/new/1.avif and /splash/new/1.jpg are both in the manifest, with
  // different natural widths) would otherwise resolve to one derived file and
  // silently share it. Mirrors derivedUrl in the generator.
  const dot = src.lastIndexOf('.');
  const stem = dot === -1 ? src : src.slice(0, dot);
  const tag = dot === -1 ? '' : `-${src.slice(dot + 1).toLowerCase()}`;
  return `/_derived${stem}${tag}-${width}.webp`;
}

/** The widths that actually exist for this source — never wider than the original. */
export function widthsFor(src: string): number[] {
  const v = MANIFEST[src];
  if (v === undefined) return [];
  // An explicit list is authoritative: it exists precisely because the derived
  // answer would be wrong. Never fall back to deriving when one is present.
  if (Array.isArray(v)) return v.slice(1);
  if (!v) return [];
  return DERIVATIVE_WIDTHS.filter((w) => v > w);
}

/**
 * The `srcset` for an art URL, or `undefined` when there is nothing to offer.
 *
 * The ORIGINAL is always the last candidate, at its true natural width. That is
 * what keeps full-bleed surfaces honest: the same file is rotated through both a
 * 271px thumbnail and a 1280px backdrop by ART_POOL_ALL, so the large candidate
 * has to stay available or the backdrop would be served a 960px upscale.
 */
export function artSrcSet(src: string): string | undefined {
  // PRODUCTION ONLY, and this is the load-bearing safety rail.
  //
  // The manifest is COMMITTED (tsc and vitest need it in a fresh clone) but the
  // derivatives it describes are NOT — the generator makes them, and it is called
  // explicitly as the first step of `build`. So in a dev server that has never
  // built, the manifest lists candidates whose files are absent, and a 404 in a
  // srcset is a broken image, not a graceful fallback.
  //
  // Do NOT restate this as "prebuild has run by construction". It was a prebuild
  // hook once, .npmrc sets ignore-scripts=true, npm skipped it, and production
  // shipped a manifest advertising files that were never built.
  if (!import.meta.env.PROD) return undefined;

  const natural = naturalWidthOf(src);
  if (!natural) return undefined;
  const widths = widthsFor(src);
  if (widths.length === 0) return undefined;
  return [
    ...widths.map((w) => `${derivedUrl(src, w)} ${w}w`),
    `${src} ${natural}w`,
  ].join(', ');
}

/**
 * The `sizes` hint. `srcset` with `w` descriptors is INERT without one, and the
 * value is what decides whether any of this saves a single byte.
 *
 * THE FIRST ATTEMPT HERE WAS '100vw' AND IT SAVED NOTHING. Measured: images at
 * boot were 5,117,404 B before the change and 5,117,404 B after — byte for byte
 * identical. '100vw' tells the browser the image occupies the full viewport, so
 * for a 271px thumbnail on a 1280px page it dutifully picks the 2048px original.
 * The reasoning behind it ("an over-wide sizes only costs a slightly larger
 * candidate") was simply wrong: over-wide costs you the WHOLE optimisation.
 *
 * `auto` is the fix and is purpose-built for this: the browser uses the element's
 * actual laid-out width, which is the one thing ArtImg genuinely cannot know at
 * render time while backing surfaces from 26px icons to full-bleed heroes. It is
 * only valid on a lazy-loaded image, which is ArtImg's default for everything
 * except the LCP hero — and for that hero '100vw' is not a guess, it is true.
 *
 * A browser without `sizes=auto` support ignores the value and falls back to the
 * 100vw default, i.e. exactly the pre-change behaviour: the original is served,
 * nothing breaks, nobody sees a soft image.
 */
export function artSizes(loading: string | undefined): string {
  return loading === 'lazy' ? 'auto' : '100vw';
}

/**
 * The `srcSet`/`sizes` pair for a raw `<img>`, or `{}` when there is nothing to
 * offer. Spread it: `<img src={art.src} {...artImgProps(art.src)} />`.
 *
 * WHY A HELPER RATHER THAN TWO ATTRIBUTES AT EACH SITE. `sizes` is only
 * meaningful alongside `srcSet`, and `sizes="auto"` is only VALID on a
 * lazy-loaded image. Writing the pair by hand at two dozen call sites is two
 * dozen chances to set one without the other, and neither mistake throws — the
 * first is inert, the second silently reverts to the 100vw default and serves
 * the full-size original, which is exactly the bug this whole pipeline exists
 * to fix and exactly the bug that is invisible in review.
 *
 * ArtImg does the same thing internally; this is for the surfaces that cannot
 * use ArtImg because they need their own object-position, filter or transform
 * styling on the element itself.
 */
export function artImgProps(
  src: string | undefined,
  loading: 'lazy' | 'eager' = 'lazy',
  explicitSizes?: string,
): { srcSet: string; sizes: string } | Record<string, never> {
  // `string | undefined` rather than `string` on purpose. Several call sites read
  // their art out of a Record with noUncheckedIndexedAccess on, so the value is
  // legitimately optional there; requiring a non-null assertion at each of them
  // would be asking callers to promise something they cannot, to satisfy a helper
  // whose honest answer for a missing source is "no candidates" anyway.
  if (!src) return {};
  const srcSet = artSrcSet(src);
  if (!srcSet) return {};
  // `explicitSizes` is for surfaces whose box is FIXED and known at author time --
  // the nav logo is 28px on desktop and 44px on mobile, full stop. `auto` cannot
  // help there because it is only valid on a lazy image, and the nav logo is the
  // one image on the page that must not be lazy; without an explicit value it
  // would fall back to the 100vw default and pull the largest candidate, which is
  // the whole optimisation thrown away. Everything with a fluid box should keep
  // passing nothing and let `auto` measure it.
  return { srcSet, sizes: explicitSizes ?? artSizes(loading) };
}
