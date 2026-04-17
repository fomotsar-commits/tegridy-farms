import { m } from 'framer-motion';

const prefersReducedMotion =
  typeof window !== 'undefined' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function PageTransition({ children }: { children: React.ReactNode }) {
  if (prefersReducedMotion) {
    return <div>{children}</div>;
  }

  return (
    <m.div
      initial={{ opacity: 0, y: 20, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{
        duration: 0.35,
        ease: [0.25, 0.1, 0.25, 1],
      }}
    >
      {children}
    </m.div>
  );
}
