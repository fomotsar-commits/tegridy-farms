import { m } from 'framer-motion';
import type { ReactNode } from 'react';
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
  return (
    <m.div key={pathname} initial="initial" animate="enter" variants={pageVariants}>
      {children}
    </m.div>
  );
}
