import { useEffect, useState } from 'react';
import { safeGetItem, safeSetItem } from '../storage';

/**
 * The three ticks on the heat card (island answer twenty-four, §2b, "oddly satisfying"):
 * the degrees roll up from 0 to the number over 600 ms once a session; the card shows the
 * change since the last visit from the browser's own memory ("+0.44° since yesterday";
 * nothing stored anywhere else). Nothing moves for longer than a second, and nothing moves
 * at all for a visitor who asked for reduced motion, or where the browser cannot say.
 */
export const ROLL_MS = 600;
const ROLLED_KEY = 'heat-rolled';
const SEEN_KEY = 'heat-seen';

/** True for a visitor who asked for reduced motion, and where the browser cannot say (no matchMedia): nothing moves unless motion is known to be wanted. */
export function reducedMotion(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return true;
  }
}

function rolledThisSession(address: string): boolean {
  try {
    return sessionStorage.getItem(`${ROLLED_KEY}:${address}`) === '1';
  } catch {
    return true;
  }
}
function markRolled(address: string): void {
  try {
    sessionStorage.setItem(`${ROLLED_KEY}:${address}`, '1');
  } catch {
    /* private mode: the roll plays again next time, which is fine */
  }
}

/** 0 to `target` over ROLL_MS, eased out; the target at once when it rolled already this session, or motion is not wanted. */
export function useRollUp(target: number, address: string): number {
  const skip = () => reducedMotion() || rolledThisSession(address);
  const [shown, setShown] = useState(() => (skip() ? target : 0));
  // A new reading starts a new roll (or lands at once): state adjusted during render, as React advises for derived state.
  const [seen, setSeen] = useState({ target, address });
  if (seen.target !== target || seen.address !== address) {
    setSeen({ target, address });
    setShown(skip() ? target : 0);
  }
  useEffect(() => {
    if (skip()) return;
    markRolled(address);
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ROLL_MS);
      const eased = 1 - (1 - t) * (1 - t);
      setShown(target * eased);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
    // `skip` reads storage and the media query: the same answer for the same address within a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, address]);
  return shown;
}

/** "yesterday", "3 days ago", "earlier today": when the last visit was, from its age. */
export function sinceWords(ageMs: number): string {
  const day = 24 * 3600_000;
  if (ageMs < day) return 'earlier today';
  if (ageMs < 2 * day) return 'yesterday';
  return `${Math.floor(ageMs / day)} days ago`;
}

export interface Seen {
  degrees: number;
  at: number;
}

/** The line under the number: the change since the last visit, or null on a first visit, an unchanged number, or a visit under an hour ago. */
export function deltaLine(previous: Seen | null, degrees: number, nowMs: number): string | null {
  if (!previous || !Number.isFinite(previous.degrees)) return null;
  const age = nowMs - previous.at;
  if (age < 3600_000) return null;
  const delta = degrees - previous.degrees;
  if (Math.abs(delta) < 0.005) return null;
  return `${delta > 0 ? '+' : '−'}${Math.abs(delta).toFixed(2)}° since ${sinceWords(age)}`;
}

export function readSeen(address: string): Seen | null {
  try {
    const raw = safeGetItem(`${SEEN_KEY}:${address}`);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Seen>;
    return typeof v.degrees === 'number' && typeof v.at === 'number' ? { degrees: v.degrees, at: v.at } : null;
  } catch {
    return null;
  }
}

export function writeSeen(address: string, seen: Seen): void {
  safeSetItem(`${SEEN_KEY}:${address}`, JSON.stringify(seen));
}
