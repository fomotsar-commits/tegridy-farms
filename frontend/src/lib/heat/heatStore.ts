import { useSyncExternalStore } from 'react';
import type { HeatReading } from './heatOracle';

/**
 * The last heat reading this tab made, for Bayla's line (components/BaylaLine.tsx): the
 * card reads a wallet (connected, pasted or shared) and the line under the nav speaks from
 * the same reading on every route. In memory only: nothing stored anywhere else.
 */
let last: HeatReading | null = null;
const listeners = new Set<() => void>();

export function lastReading(): HeatReading | null {
  return last;
}

export function setLastReading(reading: HeatReading | null): void {
  last = reading;
  for (const l of listeners) l();
}

export function subscribeLastReading(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLastReading(): HeatReading | null {
  return useSyncExternalStore(subscribeLastReading, lastReading, () => null);
}
