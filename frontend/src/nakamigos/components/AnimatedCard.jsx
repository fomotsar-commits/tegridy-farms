import { memo } from "react";
import { motion, useReducedMotion } from "framer-motion";
import Card from "./Card";
import { springs } from "../lib/interactions";

/**
 * Wraps Card with framer-motion entrance + hover animations.
 * Disables Card's built-in CSS `card-reveal` animation (via skipReveal)
 * to avoid double fade-in.
 * Respects prefers-reduced-motion by skipping entrance + hover animations.
 *
 * @param {number} index - Position in the list, used for stagger delay
 * @param {number} staggerStep - Seconds between each card's entrance (default 0.03)
 * @param {number} maxDelay - Cap on stagger delay in seconds (default 0.6)
 * @param {object} cardProps - All remaining props forwarded to Card
 */
const AnimatedCard = memo(function AnimatedCard({
  index = 0,
  staggerStep = 0.03,
  maxDelay = 0.6,
  ...cardProps
}) {
  const prefersReducedMotion = useReducedMotion();
  const delay = Math.min(index * staggerStep, maxDelay);

  return (
    <motion.div
      initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={prefersReducedMotion ? { duration: 0 } : { delay, ...springs.gentle }}
      whileHover={prefersReducedMotion ? undefined : {
        scale: 1.02,
        boxShadow: "0 8px 30px rgba(0, 0, 0, 0.25)",
        transition: springs.snappy,
      }}
      whileTap={prefersReducedMotion ? undefined : {
        scale: 0.98,
        transition: springs.snappy,
      }}
      style={{ borderRadius: "inherit" }}
    >
      <Card {...cardProps} idx={index} skipReveal />
    </motion.div>
  );
});

export default AnimatedCard;
