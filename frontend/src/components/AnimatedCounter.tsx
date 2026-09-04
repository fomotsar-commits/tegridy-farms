import React, { useEffect, useRef, useState, useCallback } from 'react';

interface AnimatedCounterProps {
  value: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  duration?: number;
  className?: string;
  style?: React.CSSProperties;
}

/** Ease-out cubic: decelerates towards the end */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * How many decimals this counter should show for the WHOLE animation.
 *
 * Derived from the DESTINATION, never from the frame being drawn. That is the
 * whole point: the sub-cent branch below used to be chosen per frame from the
 * intermediate value, so a counter travelling to 1,129.78 started under 0.01,
 * rendered "0.00000000" with eight decimals, and then snapped to two partway
 * through. The digit count changed mid-flight, so the string's width changed
 * mid-flight, and everything laid out beside it moved — which is what a reader
 * sees as the numbers "shifting as they tick".
 *
 * `tabular-nums` (index.css:195) makes each digit the same WIDTH; it cannot help
 * when the number of digits itself changes. This is the half that fixes that.
 */
function animatedDecimals(target: number, decimals: number): number {
  if (!isFinite(target) || isNaN(target)) return decimals;
  // Micro-cap precision, decided once from where we are going.
  if (target > 0 && target < 0.01) return Math.max(decimals, 8);
  return decimals;
}

/**
 * Format a number with commas and proper decimal handling.
 *
 * `decimals` is now fixed for the run by animatedDecimals(), so every frame
 * produces the same decimal count and the only width change left is the integer
 * part growing — which is real information, not jitter.
 */
function formatAnimatedNumber(num: number, decimals: number): string {
  if (!isFinite(num) || isNaN(num)) return '0';

  // Format with fixed decimals then add commas to integer part
  const fixed = num.toFixed(decimals);
  const [intPart, decPart] = fixed.split('.') as [string, string | undefined];
  const withCommas = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart !== undefined ? `${withCommas}.${decPart}` : withCommas;
}

export const AnimatedCounter = React.memo(function AnimatedCounter({
  value,
  prefix = '',
  suffix = '',
  decimals = 2,
  duration = 1000,
  className,
  style,
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
    <span className={className} style={style}>
      {prefix}{formatAnimatedNumber(displayValue, animatedDecimals(value, decimals))}{suffix}
    </span>
  );
});
