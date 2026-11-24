import { useSyncExternalStore } from 'react';

// What a pool page's staircase tells its drawing (components/dwg/LadderHouse.tsx): the rungs it
// offers, the one picked, the wallet's positions by weight, and whether its meter runs. Published
// by the card that owns the pick, per room, in memory. It imports no ladder code: lib/ladder pulls
// @solana/web3.js, which the page's own chunk must not carry.

/** One lock the staircase offers: its weight in bps, and its two labels as the staircase prints them. */
export interface LadderRung {
  bps: number;
  lock: string;
  weight: string;
}

export interface LadderPick {
  rungs: readonly LadderRung[];
  /** The rung pressed, an index into `rungs`; null when none is. */
  picked: number | null;
  /** The wallet's open positions as weights in bps; null with no wallet, or one not read. */
  held: readonly number[] | null;
  meter: 'live' | 'idle';
}

const picks = new Map<string, LadderPick>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The room's pick, or null when its staircase has none to give (not mounted, or gone). */
export function publishLadderPick(roomId: string, pick: LadderPick | null): void {
  if ((picks.get(roomId) ?? null) === pick) return;
  if (pick) picks.set(roomId, pick);
  else picks.delete(roomId);
  listeners.forEach((l) => l());
}

/** The pick the room's staircase published: the very object, so it holds between publishes. */
export function useLadderPick(roomId: string): LadderPick | null {
  return useSyncExternalStore(subscribe, () => picks.get(roomId) ?? null, () => null);
}
