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
 *
 * THE VENUE IS A DOOR TOO (2026-09-04). `id="venue"` makes `/` the venue's own
 * door, with the identical persist-and-reload semantics as every other one.
 *
 * Why this was needed: `getBungalowIdentity()` is read from AMBIENT STORAGE
 * inside HomePage's render, not from the route, so `/` and `/bayla` rendered
 * byte-identical pages whenever bayla was the stored choice — same hero, same
 * lore, same `document.title`, and no door grid, because the grid is gated on
 * `!bungalowIdentity`. A field review found it by clicking the logo and landing
 * back on BAYLA. The nav wordmark already worked (it persisted the sentinel and
 * hard-assigned '/'), but it was the ONLY thing that did: the 404 page's "Back
 * to Home", the footer, and anything else holding a plain <Link to="/"> all
 * walked back into the bungalow.
 *
 * Routing the index through here fixes all of them at once, because the fix now
 * lives at the destination rather than in each link. It also means `/` and
 * `/bayla` stop being two URLs serving one page under one title.
 *
 * The stored skin is NOT discarded on other routes — /farm, /swap and the rest
 * still read the ambient choice, so "walk in where you hold" is unchanged
 * everywhere except the one address that belongs to the venue itself.
 */
/** One-shot reload marker — sessionStorage on purpose (per-tab, cleared on
 *  close) so a single failed entry attempt can never haunt later visits. */
const ENTERING_KEY = 'bungalow-door-entering';

/**
 * The no-bungalow choice. Already the sentinel TopNav and BungalowPicker persist
 * to mean "the venue's own voice, and the visitor HAS chosen" — it resolves to
 * null through `byId()` because no bungalow carries this id, while leaving the
 * storage key non-null so `hasChosenBungalow()` stays true and the picker does
 * not reopen itself. Reused rather than reinvented so there is exactly one value
 * in the system that means this.
 */
export const VENUE_ID = 'venue';

export function BungalowDoor({ id, children }: { id: string; children: ReactNode }) {
  const isVenue = id === VENUE_ID;

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
    // The venue is a real target with no registry row, so it cannot be looked
    // up — and its "already here" test is the INVERSE of a bungalow's: a door
    // is already open when its own id is active, the venue is already open when
    // NOTHING is. Collapsing the two into one `activeId === id` comparison is
    // what would reload forever, since no stored value ever equals 'venue'
    // (`byId` resolves it to null by design).
    const target = isVenue || BUNGALOWS.some((b) => b.id === id && b.live);
    // ARRIVAL IDENTITY 2026-08-27: no more implicit default. The venue's own
    // voice is the no-choice state now, so walking ANY door (the TOWELI door
    // included) is an explicit entry that persists the choice. Before this,
    // /toweli fell through as "already the default" and never persisted.
    const activeId = getActiveBungalow()?.id ?? null;
    if (!target) return false;
    if (isVenue ? activeId === null : activeId === id) return false;
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
    // "The next document will resolve the skin we just asked for" — the guard
    // that decides whether reloading is safe. It cannot be one comparison for
    // both cases. For a bungalow the proof is that the active id now equals
    // ours; for the venue the proof is that there is NO active bungalow, since
    // `byId()` resolves the sentinel to null on purpose. Written the bungalow
    // way, a venue door reads its own successful write as a failure, blocks its
    // own reload, and renders the old skin forever.
    //
    // Both readings degrade correctly under blocked storage: the write fails,
    // the old value survives the read back, this is false, and we render under
    // the current skin rather than reloading into the same mismatch.
    const persisted = isVenue
      ? getActiveBungalow() === null
      : getActiveBungalow()?.id === id;
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
    // `isVenue` is derived from `id` and cannot change without it, so listing it
    // is redundant in practice — but it IS read in here, and a dependency array
    // that quietly omits something it uses is the habit that hides a real stale
    // closure later.
  }, [switching, id, isVenue]);
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
