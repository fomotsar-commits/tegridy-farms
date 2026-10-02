import { m } from 'framer-motion';
import { useState, type ReactNode } from 'react';
import { pageVariants } from '../../lib/motion';

/**
 * Wraps route content so every page settles in with one consistent entrance
 * (fade + subtle rise + micro-scale) instead of hard-popping. Keyed on the
 * pathname so it re-runs on each navigation. Enter-only (no exit) by design:
 * the existing RouteGlitch overlay already covers the "leaving" beat, and
 * enter-only keeps navigation instant with no wait-for-exit latency.
 *
 * reducedMotion="user" (App.tsx MotionConfig) makes this snap for users who
 * ask for reduced motion — no extra handling here.
 */
export function PageTransition({ pathname, children }: { pathname: string; children: ReactNode }) {
  // ANSWER TEN, RULING 2: THE FIRST FRAME DOES NOT FADE IN. When index.html's static
  // hero was on screen (theme-init stamps html[data-first-frame]), the visitor has
  // been reading the page for seconds; starting it again from opacity 0 would blank
  // the hero at the exact moment React takes over. Only the document's first route
  // skips the entrance. Every navigation after it keeps the settle-in.
  const [firstPath] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.getAttribute('data-first-frame') === 'venue'
      ? pathname
      : null,
  );
  const [navigated, setNavigated] = useState(false);
  if (!navigated && firstPath !== null && pathname !== firstPath) setNavigated(true);
  const alreadyOnScreen = firstPath === pathname && !navigated;
  return (
    <m.div key={pathname} initial={alreadyOnScreen ? false : 'initial'} animate="enter" variants={pageVariants}>
      {children}
    </m.div>
  );
}
