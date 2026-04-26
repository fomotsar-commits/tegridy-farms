import { useEffect, useState } from 'react';

/**
 * Tick-once-per-second countdown to a unix-second deadline.
 *
 * AUDIT R011 (HIGH-049-4): centralised so every loan-card surface shares the
 * same 1-Hz cadence. Previously LendingSection's row used a 1s setInterval
 * while NFTLendingSection's card only re-evaluated `Math.floor(Date.now()/1000)`
 * on parent re-render, causing the deadline string to freeze for many seconds
 * at a time. Both components now consume this hook so a borrower's "12s
 * remaining" countdown never stalls into a forced default.
 *
 * @param deadline UNIX seconds when the loan is due (bigint or number).
 *                 `null`/`undefined` is tolerated so callers can defer the
 *                 query until the loan tuple has loaded.
 */
export function useCountdown(deadline: bigint | number | null | undefined): {
  text: string;
  isUrgent: boolean;
  isExpired: boolean;
  secondsRemaining: number;
} {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const iv = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(iv);
  }, []);

  if (deadline === null || deadline === undefined) {
    return { text: '--', isUrgent: false, isExpired: false, secondsRemaining: 0 };
  }
  const deadlineSec = typeof deadline === 'bigint' ? Number(deadline) : deadline;
  const remaining = deadlineSec - now;
  if (remaining <= 0) {
    return { text: 'Expired', isUrgent: true, isExpired: true, secondsRemaining: 0 };
  }
  const d = Math.floor(remaining / 86400);
  const h = Math.floor((remaining % 86400) / 3600);
  const m = Math.floor((remaining % 3600) / 60);
  const isUrgent = remaining < 86400;
  return {
    text: `${d}d:${String(h).padStart(2, '0')}h:${String(m).padStart(2, '0')}m`,
    isUrgent,
    isExpired: false,
    secondsRemaining: remaining,
  };
}
