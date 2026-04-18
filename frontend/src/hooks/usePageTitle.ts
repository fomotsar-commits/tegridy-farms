import { useEffect } from 'react';

const BASE_TITLE = 'Tegridy Farms';
const SITE_URL = 'https://tegridyfarms.xyz';
const DEFAULT_OG_IMAGE = `${SITE_URL}/art/gallery-collage.jpg`;

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

export interface PageTitleOptions {
  /** Optional per-page OG image override. Falls back to site-wide gallery collage. */
  ogImage?: string;
  /** Optional canonical path override (defaults to window.location.pathname). */
  canonicalPath?: string;
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
  useEffect(() => {
    const fullTitle = `${pageTitle} | ${BASE_TITLE}`;
    document.title = fullTitle;
    setMetaTag('property', 'og:title', fullTitle);
    setMetaTag('name', 'twitter:title', fullTitle);

    // Canonical URL + og:url / twitter:url
    const path = options.canonicalPath ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
    const canonicalUrl = `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`;
    setMetaTag('property', 'og:url', canonicalUrl);
    setMetaTag('name', 'twitter:url', canonicalUrl);
    setLinkTag('canonical', canonicalUrl);

    return () => { document.title = BASE_TITLE; };
  }, [pageTitle, options.canonicalPath]);

  useEffect(() => {
    if (description) {
      setMetaTag('property', 'og:description', description);
      setMetaTag('name', 'twitter:description', description);
      setMetaTag('name', 'description', description);
    }
  }, [description]);

  useEffect(() => {
    const img = options.ogImage ?? DEFAULT_OG_IMAGE;
    setMetaTag('property', 'og:image', img);
    setMetaTag('name', 'twitter:image', img);
  }, [options.ogImage]);
}
