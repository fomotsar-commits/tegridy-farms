import { useSyncExternalStore } from 'react';

/**
 * The last action that landed on the venue this session (a Solana swap, an add to a pool),
 * for Bayla's line: "Done. Your fee went to the island. Read it." It stands for a minute,
 * then the line goes back to the wallet's state. In memory only.
 */
export type Landed = { kind: 'trade' | 'add'; at: number };
export const LANDED_FOR_MS = 60_000;

let landed: Landed | null = null;
const listeners = new Set<() => void>();

export function markLanded(kind: Landed['kind'], at = Date.now()): void {
  landed = { kind, at };
  for (const l of listeners) l();
}

/** Tests only. */
export function clearLanded(): void {
  landed = null;
  for (const l of listeners) l();
}

export function lastLanded(nowMs = Date.now()): Landed | null {
  return landed && nowMs - landed.at <= LANDED_FOR_MS ? landed : null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLanded(): Landed | null {
  return useSyncExternalStore(subscribe, () => landed, () => null);
}
