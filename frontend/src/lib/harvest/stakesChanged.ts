import { useEffect, useRef } from 'react';

/**
 * One page can show the same reward twice: Harvest, and the pool's own card or the room's
 * dashboard (owner, 2026-10-30: Harvest on every pool page and the dashboard). A claim either
 * one makes changes what the other shows, so whichever wrote says so and the rest read again.
 * Without it, the card beside a harvest kept its pre-claim "earned" and a live Claim button,
 * and Harvest kept a claim the card had already paid.
 *
 * The same shape as lib/consent.ts's `tegridy:consent-changed`: a window event, no store.
 */
const STAKES_CHANGED = 'tegridy:stakes-changed';

/** A staking write landed, or a harvest ran. `from` is the writer, which skips its own note. */
export function noteStakesChanged(from: object): void {
  window.dispatchEvent(new CustomEvent(STAKES_CHANGED, { detail: from }));
}

/** Calls `fn` whenever another part of the page notes a staking write. */
export function useOnStakesChanged(self: object, fn: () => void): void {
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent<object>).detail !== self) latest.current();
    };
    window.addEventListener(STAKES_CHANGED, on);
    return () => window.removeEventListener(STAKES_CHANGED, on);
  }, [self]);
}
