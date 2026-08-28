import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import {
  BUNGALOWS,
  DEFAULT_BUNGALOW_ID,
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
    const activeId = getActiveBungalow()?.id ?? DEFAULT_BUNGALOW_ID;
    if (!target || activeId === id) return false;
    return setActiveBungalow(id);
  });
  useEffect(() => {
    if (switching) window.location.reload();
  }, [switching]);
  if (switching) return null; // reloading into the right skin — render nothing

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
