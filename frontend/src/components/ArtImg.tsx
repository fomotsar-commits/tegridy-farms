import { useState, type ImgHTMLAttributes, type CSSProperties, type SyntheticEvent } from 'react';
import { pageArt } from '../lib/artConfig';
import { PLACEHOLDER_NFT } from '../lib/imageSafety';

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
 * WHAT THIS DOES NOT DO: emit `srcset`. 135 of the 423 files under public/art
 * exceed 300 KB (largest 1.29 MB) and a 390px phone still downloads what a
 * 1280px desktop does. Fixing that needs 480/960/1600-wide derivatives generated
 * at build time, and there is no image encoder in this project's dependency tree
 * — adding one is a separate change with its own review. A `sizes` attribute
 * without a `srcset` is inert, so none is emitted: a hint the browser cannot act
 * on would only look like the problem had been addressed.
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
  const handleError = (e: SyntheticEvent<HTMLImageElement>) => {
    if (!errored) setErrored(true);
    onError?.(e);
  };
  return (
    <img
      // Lets /art-studio's Live-page preview find and jump to the exact
      // surface being edited instead of just loading the route's top.
      data-art-surface={`${pageId}:${idx}`}
      src={errored ? PLACEHOLDER_NFT : art.src}
      width={width ?? 1200}
      height={height ?? 800}
      decoding={decoding ?? 'async'}
      loading={loading ?? (fetchPriority === 'high' ? 'eager' : 'lazy')}
      {...(fetchPriority ? { fetchPriority } : {})}
      onError={handleError}
      style={merged}
      {...rest}
    />
  );
}
