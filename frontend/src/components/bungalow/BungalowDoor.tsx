import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  BUNGALOWS,
  getActiveBungalow,
  setActiveBungalow,
} from '../../lib/bungalows';

// The landing carries HeatCard + card chrome — lazy so the entry chunk
// (App.tsx imports BungalowDoor directly) doesn't grow for visitors who
// never open a settled door. Import-graph rule: verify against the BUILT
// bundle, not dev.
const BungalowDoorLanding = lazy(() =>
  import('./BungalowDoorLanding').then((m) => ({ default: m.BungalowDoorLanding })),
);

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
 * A door for a bungalow that is not live yet (no art pool) renders that
 * bungalow's LANDING — its plaque, contract, trade route and heat from the
 * registry — instead of a generic home that said nothing about the token.
 * The URL keeps working unchanged the moment the slot flips live.
 */
/** One-shot reload marker — sessionStorage on purpose (per-tab, cleared on
 *  close) so a single failed entry attempt can never haunt later visits. */
const ENTERING_KEY = 'bungalow-door-entering';

export function BungalowDoor({ id, children }: { id: string; children: ReactNode }) {
  // Decided once per document: the active bungalow can only change through a
  // reload, so a lazy initializer (not an effect-set state) is the truthful
  // shape and avoids a paint of the wrong skin. The persist happens IN the
  // initializer (same precedent as getActiveBungalow's deep-link persist):
  // if the choice cannot persist (blocked storage), reloading would loop
  // forever — the next document would see the same mismatch — so a failed
  // persist renders under the current skin instead of switching.
  const [switching] = useState(() => {
    // Strip ?bungalow= BEFORE deciding: getActiveBungalow() re-persists that
    // param on every read, so a crafted /bayla?bungalow=toweli otherwise
    // ping-pongs storage against the door's own persist+reload — an infinite
    // reload loop on a shareable URL. The door IS the choice.
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.has('bungalow')) {
        u.searchParams.delete('bungalow');
        window.history.replaceState(window.history.state, '', u);
      }
    } catch { /* URL API unavailable — the storage read below still decides */ }
    const target = BUNGALOWS.find((b) => b.id === id && b.live);
    // ARRIVAL IDENTITY 2026-08-27: no more implicit default. The venue's own
    // voice is the no-choice state now, so walking ANY door (the TOWELI door
    // included) is an explicit entry that persists the choice. Before this,
    // /toweli fell through as "already the default" and never persisted.
    const activeId = getActiveBungalow()?.id ?? null;
    if (!target || activeId === id) return false;
    return setActiveBungalow(id);
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

  // A settled-but-not-live bungalow gets its LANDING — plaque, contract,
  // trade route, heat — instead of a generic home that says nothing about
  // the token. Lazy: the landing's bytes load only when a settled door opens.
  const bungalow = BUNGALOWS.find((b) => b.id === id);
  if (bungalow && !bungalow.live) {
    return (
      <Suspense fallback={null}>
        <BungalowDoorLanding bungalow={bungalow} />
      </Suspense>
    );
  }
  return <>{children}</>;
}
