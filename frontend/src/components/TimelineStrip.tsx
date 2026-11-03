// THE TIMELINE (island answer twenty-four, build 7): in every room and on the home, one strip
// with the newest piece hung on the island, its picture, its title and its artist, the island's
// line, and one tap to the island's page where it hangs. The code is open; the timeline is the
// thing nobody can fork, so it sits in the room where the swap happens.
//
// It rides the same read of the island's torches the room's door and the home's strip make
// (lib/heat/torchesClient.ts, cached at the edge). Read and nothing hung, or not read at all,
// it draws nothing. The title and the artist are the island's, printed as a gallery label is.

import { useState } from 'react';
import { useIslandTorches } from '../hooks/useIslandTorches';
import { TRENCHER_WORDS } from '../lib/arrival';
import { tick } from '../lib/tick';
import { CardArt } from './ui/CardArt';

export function TimelineStrip({ className }: { className?: string }) {
  const piece = useIslandTorches()?.lastPiece ?? null;
  const [broken, setBroken] = useState(false);
  if (!piece) return null;
  return (
    <section className={className} data-testid="timeline-strip">
      <a
        href={piece.door}
        target="_blank"
        rel="noopener noreferrer"
        onClick={tick}
        className="relative isolate flex items-center gap-4 rounded-2xl p-4 transition-all hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8b5cf6]"
        style={{ background: 'rgba(0,0,0,0.45)', border: '1px solid rgba(255,255,255,0.10)' }}
      >
        <CardArt pageId="timeline-strip" idx={0} />
        {!broken && (
          <img
            src={piece.image}
            alt=""
            width={88}
            height={88}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(true)}
            className="w-[88px] h-[88px] shrink-0 rounded-xl object-cover"
          />
        )}
        <span className="min-w-0 flex-1">
          {piece.title && <span className="block text-white text-[15px] font-semibold italic truncate">{piece.title}</span>}
          <span className="block text-white/75 text-[13px] truncate">{piece.artist}</span>
          <span className="block text-[13px] mt-1.5" style={{ color: 'var(--color-kyle)' }}>{TRENCHER_WORDS.timeline}</span>
        </span>
        <span aria-hidden="true" className="shrink-0 self-start text-white/60">↗</span>
      </a>
    </section>
  );
}
