import { useEffect } from 'react';

const BASE_TITLE = 'Tegridy Farms';

/**
 * Sets the document title for the current page.
 * Resets to base title on unmount.
 */
export function usePageTitle(pageTitle: string) {
  useEffect(() => {
    document.title = `${pageTitle} | ${BASE_TITLE}`;
    return () => { document.title = BASE_TITLE; };
  }, [pageTitle]);
}
