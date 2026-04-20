import { type ImgHTMLAttributes, type CSSProperties } from 'react';
import { pageArt } from '../lib/artConfig';

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
 * If a /art-studio override exists for this surface, both fields come
 * from the override. Otherwise `src` falls back to the deterministic
 * rotation and `objectPosition` falls back to `fallbackPosition`.
 *
 * Existing inline `style.objectPosition` on the rendered img is
 * overridden by the resolved value — intentional, so the studio always
 * wins. Other style keys are preserved.
 */
export function ArtImg({ pageId, idx, fallbackPosition, style, ...rest }: ArtImgProps) {
  const art = pageArt(pageId, idx);
  const objectPosition = art.objectPosition ?? fallbackPosition;
  const merged: CSSProperties = { ...style };
  if (objectPosition) merged.objectPosition = objectPosition;
  if (art.scale && art.scale !== 1) {
    merged.transform = `scale(${art.scale})`;
    // Anchor the zoom at the same focal point as the pan so X/Y sliders
    // intuitively map to "show this part of the image".
    merged.transformOrigin = objectPosition ?? 'center center';
  }
  return <img src={art.src} style={merged} {...rest} />;
}
