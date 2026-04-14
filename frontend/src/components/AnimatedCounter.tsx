import { useEffect, useRef, useState, useCallback } from 'react';

interface AnimatedCounterProps {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  duration?: number;
  className?: string;
}

/** Ease-out cubic: decelerates towards the end */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Format a number with commas and proper decimal handling.
 * For very small numbers (< 0.01), show all significant decimals up to 8.
 */
function formatAnimatedNumber(num: number, decimals: number): string {
  if (!isFinite(num) || isNaN(num)) return '0';

  // Very small numbers: show up to 8 decimals for micro-cap precision
  if (num > 0 && num < 0.01) {
    const maxDec = Math.max(decimals, 8);
    return num.toFixed(maxDec);
  }

  // Format with fixed decimals then add commas to integer part
  const fixed = num.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.') as [string, string | undefined];
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart !== undefined ? `${withCommas}.${decPart}` : withCommas;
}

export function AnimatedCounter({
  value,
  prefix = '',
  suffix = '',
  decimals = 2,
  duration = 1000,
  className,
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = useState(value);
  const previousValue = useRef(value);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);

  const animate = useCallback((from: number, to: number) => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    // Skip animation for initial zero or identical values
    if (from === to) {
      setDisplayValue(to);
      return;
    }

    startTimeRef.current = performance.now();

    const step = (now: number) => {
      const elapsed = now - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeOutCubic(progress);
      const current = from + (to - from) * eased;

      setDisplayValue(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        setDisplayValue(to);
      }
    };

    rafRef.current = requestAnimationFrame(step);
  }, [duration]);

  useEffect(() => {
    const from = previousValue.current;
    previousValue.current = value;
    animate(from, value);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [value, animate]);

  return (
    <span className={className}>
      {prefix}{formatAnimatedNumber(displayValue, decimals)}{suffix}
    </span>
  );
}
