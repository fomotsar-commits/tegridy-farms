import { useEffect, useState, type ReactNode } from 'react';
import {
  BUNGALOWS,
  DEFAULT_BUNGALOW_ID,
  getActiveBungalow,
  setActiveBungalow,
} from '../../lib/bungalows';

/**
 * A bungalow's front door — the memetics.finance/<bungalow> URL format.
 *
 * Visiting /bayla (or /towelie — App.tsx maps the alias) IS entering that
 * bungalow: if the skin isn't already active the door persists the choice
 * and reloads IN PLACE, so the address bar keeps the door path and every
 * module-scope art consumer re-resolves consistently (same reload semantics
 * as the picker). Once active, the door simply renders the app home under
 * that skin — so each bungalow has a stable, shareable address.
 *
 * A door for a bungalow that is not live yet (no art pool) renders the
 * current skin unchanged: the URL exists from day one and starts working
 * the moment the slot flips live, with no route change.
 */
export function BungalowDoor({ id, children }: { id: string; children: ReactNode }) {
  // Decided once per document: the active bungalow can only change through a
  // reload, so a lazy initializer (not an effect-set state) is the truthful
  // shape and avoids a paint of the wrong skin.
  const [switching] = useState(() => {
    const target = BUNGALOWS.find((b) => b.id === id && b.live);
    const activeId = getActiveBungalow()?.id ?? DEFAULT_BUNGALOW_ID;
    return !!target && activeId !== id;
  });
  useEffect(() => {
    if (switching) {
      setActiveBungalow(id);
      window.location.reload();
    }
  }, [switching, id]);
  if (switching) return null; // reloading into the right skin — render nothing
  return <>{children}</>;
}
