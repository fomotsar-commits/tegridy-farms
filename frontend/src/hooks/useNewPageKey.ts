import { useState } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';

interface Opened {
  pathname: string;
  key: string | null;
}

/**
 * ScrollToTop's key for useOpensAtTheTop: a new one each time a press or link moves to another
 * path; null for Back/Forward (the browser restores the place) and for a #section link. A move
 * that changes only the query (a token picked on /pools writes ?mint=) is the same page and keeps
 * the key it had, whatever the navigation's type: it never jumps.
 */
export function useNewPageKey(): string | null {
  const { pathname, hash, key } = useLocation();
  const navType = useNavigationType();
  const opening = (): Opened => ({ pathname, key: navType === 'POP' || hash ? null : key });
  const [opened, setOpened] = useState<Opened>(opening);
  // Set during render, so the jump's layout effect sees the new key in the new page's commit.
  if (opened.pathname !== pathname) {
    const next = opening();
    setOpened(next);
    return next.key;
  }
  return opened.key;
}
