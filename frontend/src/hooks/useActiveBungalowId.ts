import { useSyncExternalStore } from 'react';
import { getActiveBungalow, subscribeActiveBungalow } from '../lib/bungalows';

const activeId = (): string | null => getActiveBungalow()?.id ?? null;

/** The active bungalow's id, re-read on each announce. Surfaces that outlive a door
 *  (nav, footer, layout) call it so an in-place switch reaches them before paint. */
export function useActiveBungalowId(): string | null {
  return useSyncExternalStore(subscribeActiveBungalow, activeId, () => null);
}
