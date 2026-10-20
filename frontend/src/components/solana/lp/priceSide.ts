import { useSyncExternalStore } from 'react';

/**
 * Which way round every pool price is said: 'token' is "1 BAYLA = 0.000006354 SOL", 'coin'
 * is "1 SOL = 157,381 BAYLA". One switch for every pool on the page, so a press on any
 * price turns them all and they stay side by side comparable. Held for the visit.
 */
export type PriceSide = 'token' | 'coin';

let side: PriceSide = 'token';
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setPriceSide(next: PriceSide): void {
  if (next === side) return;
  side = next;
  listeners.forEach((l) => l());
}

export function usePriceSide(): PriceSide {
  return useSyncExternalStore(subscribe, () => side, () => 'token');
}
