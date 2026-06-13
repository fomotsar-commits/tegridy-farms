import { useEffect } from 'react';

const BASE_TITLE = 'Tegridy Farms';
const SITE_URL = 'https://tegridyfarms.vercel.app';
const DEFAULT_OG_IMAGE = `${SITE_URL}/art/gallery-collage.jpg`;

// F15: mirror the index.html default description so pages that don't pass one
// reset the tags instead of inheriting the previous route's description.
const DEFAULT_DESCRIPTION =
  'Tegridy Farms — DeFi protocol for swapping, staking, farming, and NFT finance on Ethereum';

function setMetaTag(attr: 'name' | 'property', key: string, content: string) {
  let el = document.querySelector(`meta[${attr}="${key}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    el.setAttribute(attr, key);
    document.head.appendChild(el);
  }
  el.content = content;
}

function setLinkTag(rel: string, href: string) {
  let el = document.querySelector(`link[rel="${rel}"]`) as HTMLLinkElement | null;
  if (!el) {
    el = document.createElement('link');
    el.rel = rel;
    document.head.appendChild(el);
  }
  el.href = href;
}

// F24: toggle the robots meta on/off. On normal pages we proactively REMOVE any
// lingering noindex so a prior 404 view can't leave the next route uncrawlable.
function setRobots(noIndex: boolean) {
  const existing = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null;
  if (noIndex) {
    if (existing) { existing.content = 'noindex'; return; }
    const el = document.createElement('meta');
    el.setAttribute('name', 'robots');
    el.content = 'noindex';
    document.head.appendChild(el);
  } else if (existing) {
    existing.remove();
  }
}

export interface PageTitleOptions {
  /** Optional per-page OG image override. Falls back to site-wide gallery collage. */
  ogImage?: string;
  /** Optional canonical path override (defaults to window.location.pathname). */
  canonicalPath?: string;
  /**
   * F24: skip emitting <link rel=canonical> / og:url. Use on the 404 page so a
   * bogus path isn't canonicalized into a soft-404 served with HTTP 200.
   */
  noCanonical?: boolean;
  /** F24: inject <meta name="robots" content="noindex"> (e.g. on 404). */
  noIndex?: boolean;
}

/**
 * Sets the document title, meta description, OG/Twitter tags, and canonical
 * URL for the current page. Resets to base title on unmount.
 *
 * Extended in the Wave 2 SEO pass to cover:
 *   - og:url / twitter:url (so social shares attribute the right URL)
 *   - og:image / twitter:image (per-page override)
 *   - twitter:title / twitter:description (mirrored from og:)
 *   - canonical link element (reflects current route)
 */
export function usePageTitle(pageTitle: string, description?: string, options: PageTitleOptions = {}) {
  const { noCanonical, noIndex } = options;
  useEffect(() => {
    const fullTitle = `${pageTitle} | ${BASE_TITLE}`;
    document.title = fullTitle;
    setMetaTag('property', 'og:title', fullTitle);
    setMetaTag('name', 'twitter:title', fullTitle);

    // F24: on the 404 page, don't canonicalize the bogus path. Otherwise emit
    // canonical + og:url / twitter:url for the current route.
    if (!noCanonical) {
      const path = options.canonicalPath ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
      const canonicalUrl = `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
      setMetaTag('property', 'og:url', canonicalUrl);
      setMetaTag('name', 'twitter:url', canonicalUrl);
      setLinkTag('canonical', canonicalUrl);
    }
    setRobots(!!noIndex);

    return () => { document.title = BASE_TITLE; };
  }, [pageTitle, options.canonicalPath, noCanonical, noIndex]);

  useEffect(() => {
    // F15: when a page passes no description, reset the tags to the site default
    // rather than leaving the previous route's description in place.
    const desc = description ?? DEFAULT_DESCRIPTION;
    setMetaTag('property', 'og:description', desc);
    setMetaTag('name', 'twitter:description', desc);
    setMetaTag('name', 'description', desc);
  }, [description]);

  useEffect(() => {
    const img = options.ogImage ?? DEFAULT_OG_IMAGE;
    setMetaTag('property', 'og:image', img);
    setMetaTag('name', 'twitter:image', img);
  }, [options.ogImage]);
}
