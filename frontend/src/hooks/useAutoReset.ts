import { useEffect } from 'react';

/**
 * Automatically resets a boolean value to false after a specified delay.
 * Used for confirmation dialogs that should auto-dismiss.
 * Pass `0` or omit delay to disable auto-reset.
 */
export function useAutoReset(
  value: boolean,
  setter: (v: boolean) => void,
  delayMs: number = 5000,
): void {
  useEffect(() => {
    if (!value || delayMs <= 0) return;
    const t = setTimeout(() => setter(false), delayMs);
    return () => clearTimeout(t);
  }, [value, setter, delayMs]);
}
