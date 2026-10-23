// A room's torches, read from Jungle Bay Island (the island's venue review, item 6:
// "the room is the island's room"). How many of the open row's twelve are lit, the
// next torch's price, the last torch and who lit it, and Torch it, which opens the
// room's own page on the island, where a torch is lit.
//
// On a room's door it is a card of its own. On a pool that pays nothing it sits inside
// the pool's card, above the pool's notice, and the notice stays (owner, 2026-10-15).
//
// IT UNMOUNTS RATHER THAN APOLOGISING, as FlamesBoard does: a failed read, a room the
// venue has not pinned, or a place the island did not serve renders nothing. Never
// "0 of 12".

import { useIslandTorches } from '../hooks/useIslandTorches';
import { ageWords, roomTorches, wholeNumber, type RoomTorchView } from '../lib/heat/torchesClient';
import { CardArt } from './ui/CardArt';

function Lines({ view }: { view: RoomTorchView }) {
  return (
    <>
      <p className="text-[10px] uppercase tracking-[0.2em] mb-1" style={{ color: 'var(--color-kyle)' }}>
        The island&apos;s torches
      </p>
      <p className="text-white text-[15px] font-semibold leading-snug m-0" data-testid="room-torches-line">
        {view.lit} of {view.of} lit &middot; the next torch {wholeNumber(view.nextPrice)} $BAYLA
      </p>
      {view.last && (
        <p className="text-white/70 text-[13px] mt-1 mb-0">
          Last lit by {view.last.name ?? 'someone with no name yet'}, {ageWords(view.last.litAtMs, view.readAtMs)}
        </p>
      )}
      <a
        href={view.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Torch it, on Jungle Bay Island (opens in new tab)"
        className="mt-3 inline-block px-5 py-2.5 text-[13px] font-semibold rounded-lg transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent focus-visible:ring-[#d4a843]"
        style={{ background: 'linear-gradient(135deg, #d4a843 0%, #b8892e 100%)', color: '#0a0a0f' }}
      >
        Torch it ↗
      </a>
    </>
  );
}

export function RoomTorches({ roomId, compact = false }: { roomId: string; compact?: boolean }) {
  const view = roomTorches(useIslandTorches(), roomId);
  if (!view) return null;
  if (compact) {
    // Inside a pool card, which already carries its art and scrim.
    return (
      <div className="mb-4 rounded-lg p-3" style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(212,168,67,0.35)' }} data-testid="room-torches">
        <Lines view={view} />
      </div>
    );
  }
  return (
    <section aria-label="Torches" className="mt-6" data-testid="room-torches">
      <div
        className="relative isolate rounded-2xl p-5"
        style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(212,168,67,0.35)' }}
      >
        <CardArt pageId="room-torches" idx={0} />
        <Lines view={view} />
      </div>
    </section>
  );
}
