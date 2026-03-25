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
 */
export function FlashValue({ value, children }: FlashValueProps) {
  const prevRef = useRef(value);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;

    // Skip initial render or same value
    if (prev === value || prev === 0) return;

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    setFlash(value > prev ? 'up' : 'down');

    timeoutRef.current = setTimeout(() => {
      setFlash(null);
      timeoutRef.current = null;
    }, 600);
  }, [value]);

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
