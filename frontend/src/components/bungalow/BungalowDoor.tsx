import { lazy, Suspense, useLayoutEffect, useState, type ReactNode } from 'react';
import {
  announceActiveBungalow,
  BUNGALOWS,
  getActiveBungalow,
  setActiveBungalow,
} from '../../lib/bungalows';
import { LotFrame } from '../DoorFrame';

// Lazy so the entry chunk, which imports this door, does not carry the landing.
const BungalowDoorLanding = lazy(() =>
  import('./BungalowDoorLanding').then((m) => ({ default: m.BungalowDoorLanding })),
);

/** The no-bungalow choice: resolves to no bungalow, yet `hasChosenBungalow()` reads true. */
export const VENUE_ID = 'venue';

/**
 * Makes `id` the active skin; returns whether it wrote. The venue's door is open
 * when NO bungalow is active, a room's when its own id is. ?bungalow= goes first
 * (the query outranks storage, and the door is the choice). A blocked write
 * leaves the current skin.
 */
function enterDoor(id: string): boolean {
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has('bungalow')) {
      u.searchParams.delete('bungalow');
      window.history.replaceState(window.history.state, '', u);
    }
  } catch { /* no URL API: the stored choice decides */ }
  const isVenue = id === VENUE_ID;
  if (!isVenue && !BUNGALOWS.some((b) => b.id === id && b.live)) return false;
  const activeId = getActiveBungalow()?.id ?? null;
  if (isVenue ? activeId === null : activeId === id) return false;
  return setActiveBungalow(id);
}

/**
 * A bungalow's front door (memetics.finance/<id>), and `/` as the venue's own.
 * The skin changes in place: written on the first render, so the children render
 * in the new room, and announced after commit, so the nav re-reads before paint.
 * A bungalow that is not live renders its landing.
 */
export function BungalowDoor({ id, children }: { id: string; children: ReactNode }) {
  useState(() => enterDoor(id));
  useLayoutEffect(() => {
    announceActiveBungalow();
  }, [id]);

  const bungalow = BUNGALOWS.find((b) => b.id === id);
  if (bungalow && !bungalow.live) {
    // The open lot (no address: the landing heads it with the lot's words) holds its
    // static frame while the landing's chunk arrives, so its heading never leaves.
    return (
      <Suspense fallback={bungalow.address ? null : <LotFrame />}>
        <BungalowDoorLanding bungalow={bungalow} />
      </Suspense>
    );
  }
  return <>{children}</>;
}
