import { type ImgHTMLAttributes, type CSSProperties } from 'react';
import { pageArt } from '../lib/artConfig';

type ArtImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  pageId: string;
  idx: number;
  /** Position used when no /art-studio override is set. */
  fallbackPosition?: string;
};

/**
 * Given a raster URL (e.g. `/splash/new/28.jpg` or `/art/foo.png`), returns
 * the AVIF sibling path (`/splash/new/28.avif`). Browsers silently ignore
 * `<source>` entries whose URL 404s, so pointing at a non-existent AVIF
 * is safe — browsers with AVIF support fall back to the `<img>` and
 * older browsers skip `<source type="image/avif">` entirely.
 *
 * Deliberately skips:
 *   - URLs with query strings or hashes (preserve as-is)
 *   - GIFs / SVGs (AVIF of those makes no sense)
 *   - Already-AVIF/WebP paths (would create .avif.avif etc.)
 *   - Absolute external URLs (we don't control what the origin serves)
 */
function avifSibling(src: string): string | null {
  if (!src || src.includes('?') || src.includes('#')) return null;
  if (/^(https?:)?\/\//i.test(src) && !src.startsWith(window.location.origin)) return null;
  const m = src.match(/^(.+)\.(jpg|jpeg|png)$/i);
  if (!m) return null;
  return `${m[1]}.avif`;
}

/**
 * Wraps `<picture>` and resolves both `src` and `objectPosition` from
 * `pageArt()`. The `<source>` sibling ahead of `<img>` serves AVIF to
 * supporting browsers when a same-path `.avif` exists (Phase 8 image
 * pipeline — 7 splash assets have hand-exported AVIFs today; more can
 * be generated offline and dropped in with zero code change).
 *
 * If a /art-studio override exists for this surface, both fields come from
 * the override. Otherwise `src` falls back to the deterministic rotation
 * and `objectPosition` falls back to `fallbackPosition` (or browser
 * default).
 *
 * Existing inline `style.objectPosition` on the rendered img is overridden
 * by the resolved value — intentional, so the studio always wins. Other
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
  // Can't call window.location inside ssr — guard the avifSibling lookup.
  const avif = typeof window !== 'undefined' ? avifSibling(art.src) : null;
  if (!avif) {
    return <img src={art.src} style={merged} {...rest} />;
  }
  // className/style on <picture> don't affect layout — we put them on the
  // <img> fallback so sizing/object-fit behavior is identical to before.
  return (
    <picture>
      <source srcSet={avif} type="image/avif" />
      <img src={art.src} style={merged} {...rest} />
    </picture>
  );
}
