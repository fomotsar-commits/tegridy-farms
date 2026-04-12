import { useEffect } from 'react';

const BASE_TITLE = 'Tegridy Farms';

function setMetaTag(name: string, content: string) {
  let el = document.querySelector(`meta[name="${name}"]`) as HTMLMetaElement | null;
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

/**
 * Sets the document title and optional OG meta tags for the current page.
 * Resets to base title on unmount.
 */
export function usePageTitle(pageTitle: string, description?: string) {
  useEffect(() => {
    const fullTitle = `${pageTitle} | ${BASE_TITLE}`;
    document.title = fullTitle;
    setMetaTag('og:title', fullTitle);

    return () => { document.title = BASE_TITLE; };
  }, [pageTitle]);

  useEffect(() => {
    if (description) {
      setMetaTag('og:description', description);
    }
  }, [description]);
}
