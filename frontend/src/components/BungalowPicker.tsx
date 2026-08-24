import { Modal } from './ui/Modal';
import {
  BUNGALOWS,
  DEFAULT_BUNGALOW_ID,
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
  const currentId = getActiveBungalow()?.id ?? DEFAULT_BUNGALOW_ID;

  const dismiss = () => {
    // Persist the status quo so dismissal counts as a choice.
    setActiveBungalow(currentId);
    onClose();
  };

  const select = (b: Bungalow) => {
    if (!b.live) return;
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
        Thirteen bungalows, one island. Pick where you&apos;re staying — each
        bungalow dresses the app&apos;s backgrounds in its own art. Same farm,
        same rails, different vibes.
      </p>

      <div
        className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[52vh] overflow-y-auto p-2 rounded-xl"
        style={{ background: 'rgba(0,0,0,0.45)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
      >
        {BUNGALOWS.map((b) => {
          const isCurrent = b.id === currentId;
          return (
            <button
              key={b.id}
              type="button"
              disabled={!b.live}
              onClick={() => select(b)}
              aria-current={isCurrent ? 'true' : undefined}
              className={`relative text-left rounded-xl overflow-hidden transition-transform ${
                b.live ? 'hover:scale-[1.02] cursor-pointer' : 'opacity-55 cursor-not-allowed'
              }`}
              style={{
                background: 'rgba(4,9,18,0.85)',
                border: isCurrent
                  ? '1px solid var(--color-kyle, #2D8B4E)'
                  : '1px solid rgba(255,255,255,0.14)',
              }}
            >
              <div className="h-16 w-full overflow-hidden">
                <img
                  src={b.thumb}
                  alt=""
                  loading="lazy"
                  width={300}
                  height={64}
                  className={`w-full h-full object-cover ${b.live ? '' : 'grayscale'}`}
                />
              </div>
              <div className="p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-white text-[13px] font-semibold tracking-wide">{b.name}</span>
                  <span className="text-white/50 text-[10px] uppercase tracking-wider">
                    {b.chain !== 'tbd' ? CHAIN_LABEL[b.chain] : ''}{!b.live ? (b.chain !== 'tbd' ? ' · Soon' : 'Soon') : ''}
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
