import { Modal } from './ui/Modal';
import { artSrcSet } from '../lib/artSrcSet';
import { isToweliVoice } from '../lib/arrival';
// The island's presentation ruling (which doors count as OPEN) lives in one
// place — the hall — and the picker reads it so the two can never disagree.
import { OPEN_DOOR_IDS } from './VenueDoors';
import {
  BUNGALOWS,
  getActiveBungalow,
  setActiveBungalow,
  type Bungalow,
} from '../lib/bungalows';
import { ART } from '../lib/artConfig';

const CHAIN_LABEL: Record<Bungalow['chain'], string> = {
  ethereum: 'Ethereum',
  base: 'Base',
  solana: 'Solana',
  tbd: 'TBD',
};

/**
 * Jungle Bay Island bungalow picker — the screen after the intro.
 *
 * Thirteen bungalows, one per community token. Entering one re-skins every
 * background surface with that bungalow's art pool (see lib/bungalows.ts);
 * buttons, copy and contracts are untouched. Only live bungalows are
 * selectable; the rest render as locked "Soon" cards so the island's shape
 * is visible before every token is confirmed.
 *
 * Dismissal (Escape / "Stay here") persists the CURRENT bungalow so the
 * picker doesn't re-open on the next visit — it is a welcome, not a gate.
 * The footer's Bungalows button reopens it any time (OPEN_BUNGALOWS_EVENT).
 *
 * Switching to a different bungalow persists the choice and reloads:
 * `pageArt()` is consumed at module scope in places (loader constants,
 * STAT_ARTS), so a reload is the only way every surface re-resolves
 * consistently — and it matches the app's existing splash-replay pattern.
 */
export function BungalowPicker({ open, onClose }: { open: boolean; onClose: () => void }) {
  // ARRIVAL IDENTITY 2026-08-27: no implicit Toweli default. Nothing chosen
  // means the visitor is at the venue itself, so no card claims "You are
  // here" until a door has actually been walked.
  const currentId = getActiveBungalow()?.id ?? null;

  const dismiss = () => {
    // Persist the status quo so dismissal counts as a choice and the picker
    // does not re-open. With no bungalow active the sentinel 'venue' marks
    // "seen" while resolving to no bungalow (the venue's own voice).
    setActiveBungalow(currentId ?? 'venue');
    onClose();
  };

  const select = (b: Bungalow) => {
    // The quiet slot is the only locked card. A settled-but-not-live bungalow
    // opens its DOOR LANDING (plaque/contract/trade/heat) — the skin itself
    // still arrives with the community's art drop, so no choice is persisted
    // and the current skin stays.
    if (b.chain === 'tbd') return;
    if (!b.live) {
      onClose();
      window.location.assign(`/${b.id}`);
      return;
    }
    setActiveBungalow(b.id);
    if (b.id === currentId) {
      onClose();
      return;
    }
    // Enter through the bungalow's front door so the address bar carries the
    // memetics.finance/<bungalow> format. The choice is already persisted, so
    // the door renders directly without a second reload.
    window.location.assign(`/${b.id}`);
  };

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title="Jungle Bay Island"
      maxWidth="max-w-3xl"
      dismissOnBackdrop={false}
      art={ART.jungleBus.src}
    >
      <p className="text-white/80 text-[13px] leading-relaxed mb-4">
        {isToweliVoice()
          ? 'Thirteen bungalows, one island. Live bungalows dress the app\u2019s backgrounds in their own art; settled doors are open \u2014 plaque, contract and trade route \u2014 while their art drops arrive. Same farm, same rails, different vibes.'
          /* ARRIVAL IDENTITY 2026-08-31: the venue speaks its own law here
             (island-authored venue strings carry no em dashes, per lane law). */
          : 'Thirteen bungalows, one island. Open doors show in full color; settled doors are greyed while their people move in, and each still opens to its plaque, contract and trade route. Walk in where you hold.'}
      </p>

      <div
        className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[52vh] overflow-y-auto p-2 rounded-xl"
        style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      >
        {/* THE WAY BACK lives on the WORDMARK, not in here (owner, 2026-08-31).
            This hall is the island's residents; the venue is not one of them, and
            listing it as a fourteenth tile read like a bungalow you could move
            into. The two ways to the venue are now: the arrival after the intro,
            and clicking the MEMETICS.FINANCE wordmark in the nav — which clears
            the stored bungalow and walks home. See TopNav. */}
        {BUNGALOWS.map((b) => {
          const isCurrent = b.id === currentId;
          const locked = b.chain === 'tbd'; // only the quiet slot stays locked
          return (
            <button
              key={b.id}
              type="button"
              disabled={locked}
              onClick={() => select(b)}
              aria-current={isCurrent ? 'true' : undefined}
              className={`relative text-left rounded-xl overflow-hidden transition-transform ${
                locked ? 'opacity-55 cursor-not-allowed' : 'hover:scale-[1.02] cursor-pointer'
              }`}
              style={{
                background: 'rgba(4,9,18,0.85)',
                border: isCurrent
                  ? '1px solid var(--color-kyle, #2D8B4E)'
                  : '1px solid rgba(255,255,255,0.14)',
              }}
            >
              <div className="h-16 w-full overflow-hidden">
                {/* RESPONSIVE, 2026-09-04 — same rails as VenueDoors, which
                    renders the same thumbnails on the page behind this modal. */}
                <img
                  src={b.thumb}
                  {...(artSrcSet(b.thumb)
                    ? { srcSet: artSrcSet(b.thumb), sizes: '(max-width: 640px) 50vw, 300px' }
                    : {})}
                  alt=""
                  loading="lazy"
                  width={300}
                  height={64}
                  className={`w-full h-full object-cover ${locked || !OPEN_DOOR_IDS.has(b.id) ? 'grayscale' : ''}`}
                  style={b.thumbPosition ? { objectPosition: b.thumbPosition } : undefined}
                />
              </div>
              <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-white text-[13px] font-semibold tracking-wide">{b.name}</span>
                  <span className="text-white/50 text-[10px] uppercase tracking-wider">
                    {locked
                      ? 'Soon'
                      : `${CHAIN_LABEL[b.chain]}${OPEN_DOOR_IDS.has(b.id) ? ' · Live' : ' · Settled'}`}
                  </span>
                </div>
                <p className="text-white/60 text-[11px] leading-snug mt-0.5">{b.tagline}</p>
                {isCurrent && (
                  <span
                    className="inline-block mt-1.5 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded"
                    style={{ background: 'rgba(45,139,78,0.25)', color: '#7fd89d' }}
                  >
                    You are here
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-white/50 text-[11px]">
          Backgrounds only — buttons and contracts never change.
        </p>
        <button type="button" onClick={dismiss} className="btn-secondary px-4 py-2 text-[13px] flex-shrink-0">
          Stay here
        </button>
      </div>
    </Modal>
  );
}
