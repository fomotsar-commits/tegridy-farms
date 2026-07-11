import { m } from 'framer-motion';
import type { ReactNode } from 'react';
import { EASE_OUT, DUR } from '../../lib/motion';

/**
 * Scroll-into-view reveal for sections/cards. Fires once, never re-hides.
 * whileInView is already used across the app under LazyMotion(domAnimation),
 * so this is safe. reducedMotion="user" snaps it for those who opt out.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 18,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
}) {
  return (
    <m.div
      className={className}
      initial={{ opacity: 0, y }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-10% 0px -8% 0px' }}
      transition={{ duration: DUR.base, ease: EASE_OUT, delay }}
    >
      {children}
    </m.div>
  );
}
