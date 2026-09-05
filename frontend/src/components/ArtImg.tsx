import { useState, type ImgHTMLAttributes, type CSSProperties, type SyntheticEvent } from 'react';
import { pageArt } from '../lib/artConfig';
import { PLACEHOLDER_NFT } from '../lib/imageSafety';
import { artSrcSet, artSizes } from '../lib/artSrcSet';

type ArtImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  pageId: string;
  idx: number;
  /** Position used when no /art-studio override is set. */
  fallbackPosition?: string;
};

/**
 * REGRESSION FIX (2026-04-19): An earlier Phase-8 attempt wrapped this in
 * `<picture>` with a derived `.avif` source, on the assumption that
 * browsers would silently fall back when the AVIF 404'd. That's wrong —
 * the `<source>` fallback only kicks in when the browser doesn't support
 * the declared MIME type. If the type is supported but the URL misses,
 * the browser happily renders a broken `<img>`. Reverted to the plain
 * `<img>` until a proper solution lands — either a build-time scan that
 * emits `<source>` only for paths with known AVIF siblings, or a
 * server-side content-negotiation layer. The 7 existing hand-exported
 * AVIFs in /splash/new/ are not currently served; see docs for the
 * follow-up task.
 *
 * PERF-05 (2026-09-03): `loading` is defaulted HERE rather than repeated at
 * every call site. 119 of the 120 `<ArtImg>` sites already passed
 * `loading="lazy"` by hand; the 120th is the home hero, which is the LCP element
 * and passes `fetchPriority="high"` instead. So the rule the codebase already
 * follows is "lazy unless this is the priority image", and it is written down
 * once now — a new surface cannot forget it, and defaulting it can never
 * de-prioritise the hero, because the default reads `fetchPriority` first.
 *
 * SRCSET, ADDED 2026-09-04 — this block used to say it was deliberately absent,
 * for a reason that has now been paid off rather than argued away. The reason was
 * real: a `sizes` without a `srcset` is inert, real `srcset` needs build-time
 * derivatives, and there was no image encoder in the dependency tree.
 *
 * There is one now (`sharp`, devDependency only, never shipped).
 * scripts/generate-image-derivatives.mjs runs first in `build` and emits 128/480/960-wide
 * webp for every source over 150 KB, plus a manifest of what exists;
 * lib/artSrcSet.ts turns that manifest into a `srcset`. Measured before: one
 * homepage view fetched 5,117,404 B of images, with 24 rendered <img> served at
 * more than 2x their display width.
 *
 * The manifest is what makes it safe. A source with no derivative gets no
 * `srcset` and renders exactly as before, so the AVIF trap recorded above cannot
 * repeat: nothing is ever pointed at a URL that might 404. On a checkout that has
 * not run the build the manifest is empty and this component behaves identically
 * to its pre-2026-09-04 self.
 *
 * R041 + R072 hardening:
 * - `width` / `height` defaults reserve layout to prevent CLS when an
 *   override URL 404s. Caller props still win.
 * - `decoding="async"` keeps the main thread free during page art loads.
 * - `onError` swaps to `PLACEHOLDER_NFT` so a missing override doesn't
 *   render a broken `<img>` icon. Caller `onError` is preserved.
 *
 * If a /art-studio override exists for this surface, both fields come
 * from the override. Otherwise `src` falls back to the deterministic
 * rotation and `objectPosition` falls back to `fallbackPosition`.
 */
export function ArtImg({
  pageId,
  idx,
  fallbackPosition,
  style,
  width,
  height,
  decoding,
  loading,
  fetchPriority,
  onError,
  ...rest
}: ArtImgProps) {
  const art = pageArt(pageId, idx);
  const [errored, setErrored] = useState(false);
  const objectPosition = art.objectPosition ?? fallbackPosition;
  const merged: CSSProperties = { ...style };
  if (objectPosition) merged.objectPosition = objectPosition;
  if (art.scale && art.scale !== 1) {
    merged.transform = `scale(${art.scale})`;
    // Anchor the zoom at the same focal point as the pan so X/Y sliders
    // intuitively map to "show this part of the image".
    merged.transformOrigin = objectPosition ?? 'center center';
  }
  // undefined whenever the manifest has no entry — which is every source on a
  // checkout that has not built, and every source under the generator's
  // 80 KB floor.
  // Resolved once: `sizes="auto"` is only valid on a lazy image, so the two must
  // be decided from the same value rather than computed twice.
  const resolvedLoading = loading ?? (fetchPriority === 'high' ? 'eager' : 'lazy');
  const [srcSetFailed, setSrcSetFailed] = useState(false);
  const candidateSet = artSrcSet(art.src);
  // Dropped for the retry: re-rendering without it makes the browser load `src`.
  const srcSet = srcSetFailed ? undefined : candidateSet;
  /**
   * A MISSING DERIVATIVE MUST NOT DESTROY THE IMAGE.
   *
   * This is a two-step fallback, and the first step is the one that matters. If
   * the browser picked a `srcset` candidate that 404s, the <img> errors and the
   * old single-step handler swapped straight to PLACEHOLDER_NFT — so one absent
   * derivative replaced real art with a placeholder. That is exactly what
   * happened in CI: a /bayla surface rendered `/placeholder-nft.svg` and the
   * bungalow-doors spec caught it.
   *
   * The manifest is supposed to prevent that by only ever naming files the
   * generator actually wrote, and `artSrcSet` is gated to PROD on top. Both are
   * still worth having, but they are promises about the BUILD, and this is the
   * runtime consequence if either is ever wrong — a stale committed manifest, a
   * build whose generator step never ran, a partial artifact upload, a CDN miss. So:
   * drop the srcset, retry the ORIGINAL, and only fall back to the placeholder
   * if the original fails too.
   */
  const handleError = (e: SyntheticEvent<HTMLImageElement>) => {
    if (srcSetFailed || !srcSet) {
      // No srcset in play, or we already retried without it — this is a genuinely
      // missing original.
      if (!errored) setErrored(true);
    } else {
      // First failure while a srcset was active: assume a candidate is missing
      // and fall back to the plain original rather than to the placeholder.
      setSrcSetFailed(true);
    }
    onError?.(e);
  };
  return (
    <img
      // Lets /art-studio's Live-page preview find and jump to the exact
      // surface being edited instead of just loading the route's top.
      data-art-surface={`${pageId}:${idx}`}
      src={errored ? PLACEHOLDER_NFT : art.src}
      // No srcset once we have fallen back to the placeholder: the candidates
      // describe the ART, and pointing them at a different image would serve a
      // resized version of something the browser is no longer displaying.
      {...(!errored && srcSet
        ? { srcSet, sizes: (rest.sizes as string) ?? artSizes(resolvedLoading) }
        : {})}
      width={width ?? 1200}
      height={height ?? 800}
      decoding={decoding ?? 'async'}
      loading={resolvedLoading}
      {...(fetchPriority ? { fetchPriority } : {})}
      onError={handleError}
      style={merged}
      {...rest}
    />
  );
}
