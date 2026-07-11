// Shared motion system — a single source of truth for easing, duration, and
// entrance variants so the app's 60+ framer-motion usages stop each hand-rolling
// their own timing. Pairs with the app-wide LazyMotion(domAnimation) + strict +
// MotionConfig reducedMotion="user" setup in App.tsx (so transforms/opacity snap
// automatically for prefers-reduced-motion users — no per-component handling).
import type { Variants, Transition } from 'framer-motion';

// Premium ease-out (fast attack → gentle settle). This is THE app easing —
// mirrors the "luxury" feel of the serif headings. Use it everywhere entrances
// happen so every page/section/card settles with the same signature.
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const;

export const DUR = { fast: 0.28, base: 0.5, slow: 0.72 } as const;

// Springs for interactive elements (hover lift, tap, number roll-ups).
export const SPRING_SOFT: Transition = { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 };
export const SPRING_SNAPPY: Transition = { type: 'spring', stiffness: 420, damping: 32 };

// Page-level entrance: a subtle rise + fade + micro-scale. Every route gets this
// via <PageTransition>. Deliberately small (12px / 0.5% scale) so it reads as
// "settling into place," not "sliding in from off-screen."
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 12, scale: 0.994 },
  enter: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: { duration: DUR.base, ease: EASE_OUT, when: 'beforeChildren' },
  },
};

// Scroll-into-view section reveal (used by <Reveal>). once:true so it fires a
// single time and never re-hides on scroll-up.
export const revealVariants: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
};

// Stagger a grid/list: parent orchestrates, children ride `staggerItem`.
export const staggerContainer = (staggerChildren = 0.06, delayChildren = 0): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren, delayChildren } },
});

export const staggerItem: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: DUR.base, ease: EASE_OUT } },
};

// Shared interactive presets — a consistent card/button "lift" so hover feedback
// is uniform instead of every component picking its own scale/shadow.
export const liftHover = { y: -3, transition: SPRING_SNAPPY };
export const pressTap = { scale: 0.97, transition: { duration: 0.08 } };
