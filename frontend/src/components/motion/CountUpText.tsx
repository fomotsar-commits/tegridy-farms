import { m, useSpring, useTransform, useReducedMotion } from 'framer-motion';
import { useEffect, useMemo } from 'react';

// Parse a pre-formatted stat string into [prefix, number, suffix]. The number
// keeps a leading sign and thousands commas; the prefix deliberately excludes
// '-' so negatives attach to the number, not the prefix.
const NUM_RE = /^([^\d-]*?)(-?\d[\d,]*(?:\.\d+)?)(.*)$/s;

/**
 * Rolls the numeric part of an already-formatted stat string up from 0 on mount
 * and springs to new values on change — so `$16.41`, `3,555.21%`,
 * `350,084,488 TOWELI` all count up while keeping their exact prefix/suffix,
 * decimal count, and thousands grouping. Non-numeric values (e.g. `–`, "Price
 * data unavailable") render unchanged. Honors prefers-reduced-motion.
 *
 * Drop-in: replace `{value}` with `<CountUpText value={value} />` at any stat
 * site — no change to the underlying hooks/formatting.
 */
export function CountUpText({ value, className }: { value: string; className?: string }) {
  const reduce = useReducedMotion();

  const parsed = useMemo(() => {
    if (typeof value !== 'string') return null;
    const match = value.match(NUM_RE);
    if (!match) return null;
    const [, prefix, numStr, suffix] = match;
    if (numStr === undefined) return null;
    const grouped = numStr.includes(',');
    const clean = numStr.replace(/,/g, '');
    const dot = clean.indexOf('.');
    const decimals = dot === -1 ? 0 : clean.length - dot - 1;
    const target = parseFloat(clean);
    if (!Number.isFinite(target)) return null;
    return { prefix, suffix, grouped, decimals, target };
  }, [value]);

  const spring = useSpring(0, { stiffness: 80, damping: 22, mass: 1 });

  useEffect(() => {
    if (!parsed) return;
    if (reduce) spring.jump(parsed.target);
    else spring.set(parsed.target);
  }, [parsed, reduce, spring]);

  const text = useTransform(spring, (v) =>
    parsed
      ? `${parsed.prefix}${v.toLocaleString(undefined, {
          minimumFractionDigits: parsed.decimals,
          maximumFractionDigits: parsed.decimals,
          useGrouping: parsed.grouped,
        })}${parsed.suffix}`
      : '',
  );

  if (!parsed) return <span className={className}>{value}</span>;
  return <m.span className={className}>{text}</m.span>;
}
