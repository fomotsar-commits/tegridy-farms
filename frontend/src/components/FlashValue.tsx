import { useRef, useEffect, useState, type ReactNode } from 'react';

interface FlashValueProps {
  value: number;
  children: ReactNode;
}

/**
 * Wraps child content and applies a brief color flash + scale bump
 * when the value changes.
 * - Increase: green flash (#22c55e)
 * - Decrease: red flash (#ef4444)
 *
 * R007 Pattern A — compare during render: the flash direction is derived
 * from the previous render's value (kept in `lastValue` state). The async
 * `setFlash(null)` reset stays inside `setTimeout` so the lint rule (which
 * only flags synchronous setState in effect bodies) is satisfied.
 */
export function FlashValue({ value, children }: FlashValueProps) {
  const [lastValue, setLastValue] = useState(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  if (value !== lastValue) {
    setLastValue(value);
    if (lastValue !== 0) {
      // Set flash direction based on the transition we just observed.
      setFlash(value > lastValue ? 'up' : 'down');
    }
  }

  useEffect(() => {
    if (!flash) return;
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setFlash(null);
      timeoutRef.current = null;
    }, 600);
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [flash]);

  return (
    <span
      style={{
        display: 'inline-block',
        transition: 'color 0.15s ease, transform 0.15s ease',
        color: flash === 'up' ? '#22c55e' : flash === 'down' ? '#ef4444' : undefined,
        transform: flash ? 'scale(1.05)' : 'scale(1)',
      }}
    >
      {children}
    </span>
  );
}
