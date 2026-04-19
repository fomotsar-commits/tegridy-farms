import { type ImgHTMLAttributes, type CSSProperties } from 'react';
import { pageArt } from '../lib/artConfig';

type ArtImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  pageId: string;
  idx: number;
  /** Position used when no /art-studio override is set. */
  fallbackPosition?: string;
};

/**
 * Wraps `<img>` and resolves both `src` and `objectPosition` from `pageArt()`.
 *
 * If a /art-studio override exists for this surface, both fields come from
 * the override. Otherwise `src` falls back to the deterministic rotation and
 * `objectPosition` falls back to `fallbackPosition` (or browser default).
 *
 * Existing inline `style.objectPosition` on the rendered img is overridden by
 * the resolved value — that's intentional, so the studio always wins. Other
 * style keys are preserved.
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
