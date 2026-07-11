import { m, useSpring, useTransform, useReducedMotion } from 'framer-motion';
import { useEffect } from 'react';

/**
 * A number that rolls up from 0 on mount and springs to new values on change —
 * the small premium touch that makes stat tiles feel alive instead of static.
 * Honors prefers-reduced-motion (jumps straight to the value). Pass a `format`
 * fn for anything non-trivial (tiny prices, compact notation, etc.).
 */
export function AnimatedNumber({
  value,
  decimals = 0,
  prefix = '',
  suffix = '',
  className,
  format,
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
  format?: (v: number) => string;
}) {
  const reduce = useReducedMotion();
  const spring = useSpring(0, { stiffness: 90, damping: 22, mass: 1 });

  useEffect(() => {
    if (!Number.isFinite(value)) return;
    if (reduce) spring.jump(value);
    else spring.set(value);
  }, [value, reduce, spring]);

  const text = useTransform(spring, (v) =>
    format
      ? format(v)
      : `${prefix}${v.toLocaleString(undefined, {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        })}${suffix}`,
  );

  return <m.span className={className}>{text}</m.span>;
}
