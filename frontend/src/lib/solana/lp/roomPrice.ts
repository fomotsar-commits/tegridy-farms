import { useSyncExternalStore } from 'react';

/**
 * The room pool's own price, as the pool card last read it, with when its outside price
 * was read (the shared list, outsidePrice.ts). Bayla's line reads it for "Jupiter is slow.
 * The pool's own price is {price}, read {age} ago. Adding stays open." (answer
 * twenty-four, build 4): said only while the list is behind, under the ten-minute hold.
 */
export interface RoomPrice {
  mint: string;
  /** "0.00000474 SOL" */
  text: string;
  readAtMs: number;
}
/** The list reads about once a minute; older than this, the line says Jupiter is slow. */
export const SLOW_AFTER_MS = 2 * 60_000;

let current: RoomPrice | null = null;
const listeners = new Set<() => void>();

export function publishRoomPrice(p: RoomPrice): void {
  if (current && current.mint === p.mint && current.text === p.text && current.readAtMs === p.readAtMs) return;
  current = p;
  for (const l of listeners) l();
}

/** Tests only. */
export function clearRoomPrice(): void {
  current = null;
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useRoomPrice(): RoomPrice | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

export interface RoomSlow {
  price: string;
  /** "3 min", "40 s": how long ago the outside price was read. */
  age: string;
}
/** A price older than this holds the form (outsidePrice.ts FRESH_FOR_MS); the line says nothing past it. */
const HOLD_AFTER_MS = 10 * 60_000;

let slowSnapshot: { key: string; value: RoomSlow | null } = { key: '', value: null };
/** The room pool's "Jupiter is slow" reading for `mint`: the pool's own price and the age of its outside price, between two and ten minutes; null otherwise. One object per answer, so a render can compare it. */
function slowFor(mint: string | null, nowMs: number): RoomSlow | null {
  const p = current;
  if (!mint || !p || p.mint !== mint) return cached('', null);
  const age = nowMs - p.readAtMs;
  if (age <= SLOW_AFTER_MS || age > HOLD_AFTER_MS) return cached('', null);
  const s = Math.round(age / 1000);
  const words = s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
  return cached(`${p.mint}|${p.text}|${words}`, { price: p.text, age: words });
}
function cached(key: string, value: RoomSlow | null): RoomSlow | null {
  if (slowSnapshot.key === key && (value === null) === (slowSnapshot.value === null)) return slowSnapshot.value;
  slowSnapshot = { key, value };
  return value;
}

export function useRoomSlow(mint: string | null): RoomSlow | null {
  return useSyncExternalStore(subscribe, () => slowFor(mint, Date.now()), () => null);
}
