import { useEffect, useSyncExternalStore } from 'react';

/**
 * The move a screen's own green button makes (island answer twenty-five, §2: one green button
 * per screen). A screen that draws a green button doing one of Bayla's moves says so while it is
 * on screen, and her line's button goes quiet there (lib/baylaLine.ts, `sameMove`): the
 * countdown's "Start the clock" starts the clock, the receipt card is the receipt, and the sheet
 * ('sheet') is her move whatever her line says: its own green button is hers, and the header is
 * under its veil. In memory only; the last screen mounted wins.
 */
export type ScreenMove = 'start' | 'add' | 'receipt' | 'sheet';

const held: { move: ScreenMove; key: symbol }[] = [];
const listeners = new Set<() => void>();
let current: ScreenMove | null = null;

function publish(): void {
  current = held.length ? held[held.length - 1]!.move : null;
  for (const l of listeners) l();
}

/** Says `move` while the calling screen is mounted (and `on`); a null move says nothing. */
export function useScreenMove(move: ScreenMove | null, on = true): void {
  useEffect(() => {
    if (!move || !on) return;
    const key = Symbol(move);
    held.push({ move, key });
    publish();
    return () => {
      const at = held.findIndex((h) => h.key === key);
      if (at >= 0) held.splice(at, 1);
      publish();
    };
  }, [move, on]);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The green move of the screen on top, or null. */
export function useCurrentScreenMove(): ScreenMove | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

/** Tests only. */
export function clearScreenMoves(): void {
  held.length = 0;
  publish();
}
