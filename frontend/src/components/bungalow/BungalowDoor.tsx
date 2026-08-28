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
/** One-shot reload marker — sessionStorage on purpose (per-tab, cleared on
 *  close) so a single failed entry attempt can never haunt later visits. */
const ENTERING_KEY = 'bungalow-door-entering';

export function BungalowDoor({ id, children }: { id: string; children: ReactNode }) {
  // Decided once per document: the active bungalow can only change through a
  // reload, so a lazy initializer (not an effect-set state) is the truthful
  // shape and avoids a paint of the wrong skin.
  const [switching] = useState(() => {
    const target = BUNGALOWS.find((b) => b.id === id && b.live);
    const activeId = getActiveBungalow()?.id ?? DEFAULT_BUNGALOW_ID;
    return !!target && activeId !== id;
  });
  // AUDIT 2026-08-28: the reload used to be UNCONDITIONAL. setActiveBungalow's
  // safeSetItem swallows storage failure, so in any storage-blocked context
  // (private-mode Safari, cookie-blocked embeds — and the a11y harness, which
  // is how this surfaced: /bayla, the one live non-default door, timed out on
  // every browser project) the post-reload recompute saw the skin still wrong
  // and reloaded again, FOREVER. Two guards now bound it: the write is
  // verified before reloading, and a per-tab one-shot marker refuses a second
  // attempt. Either guard failing renders the page under the current skin —
  // wrong wallpaper, working bungalow.
  const [entryBlocked, setEntryBlocked] = useState(false);
  useEffect(() => {
    if (!switching) {
      // Healthy post-reload boot (or a non-switching door): clear any marker.
      try { sessionStorage.removeItem(ENTERING_KEY); } catch { /* nothing to clear */ }
      return;
    }
    setActiveBungalow(id);
    const persisted = getActiveBungalow()?.id === id;
    let alreadyTried = false;
    try {
      if (sessionStorage.getItem(ENTERING_KEY) === id) {
        alreadyTried = true;
        sessionStorage.removeItem(ENTERING_KEY);
      } else if (persisted) {
        sessionStorage.setItem(ENTERING_KEY, id);
      }
    } catch {
      // Marker storage is as blocked as the rest — a reload could never be
      // proven once-only, so it must not happen at all.
      alreadyTried = true;
    }
    if (!persisted || alreadyTried) {
      setEntryBlocked(true);
      return;
    }
    window.location.reload();
  }, [switching, id]);
  if (switching && !entryBlocked) return null; // reloading into the right skin — render nothing
  return <>{children}</>;
}
