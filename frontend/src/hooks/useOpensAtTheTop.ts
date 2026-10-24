import { useLayoutEffect, useRef } from 'react';

/**
 * Puts the window at the top each time `key` changes to a value that is not null,
 * before the paint: a passive effect runs after the view is on screen and undoes
 * a scroll the visitor has already started. React re-runs layout effects when a
 * Suspense boundary re-shows its subtree, so the ref holds the key last handled
 * and a re-shown view does not jump again.
 */
export function useOpensAtTheTop(key: string | null): void {
  const handled = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (handled.current === key) return;
    handled.current = key;
    if (key !== null) window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [key]);
}
