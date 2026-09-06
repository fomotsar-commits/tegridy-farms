// The island's board, on the venue.
//
// WHY IT IS HERE AT ALL. Held time is invisible until it is COMPARABLE. A number on
// your own screen is a private fact; the same number beside named people with days
// against their names is a place you can be in. This card is the second of the wave's
// four states of time (visible, COMPARABLE, consequential, shareable), and it is what
// makes the island's door worth walking to for a holder who never cared about a score.
//
// IT IS THE ISLAND'S RANKING, NOT OURS. We paint what the board served, in the order it
// served it. Nothing here re-ranks, re-tiers, sums or recomputes, and the tier words
// render verbatim.
//
// IT UNMOUNTS RATHER THAN APOLOGISING. If the island's board is off (204) or we could
// not read it, this renders NOTHING — no error card, no empty state, no zero. A home
// page that says "nobody is on the island" because a proxy hiccuped is worse than a
// home page with one fewer section. The distinction between the two failures is kept
// in flamesClient; it just does not reach the visitor's eye.

import { useEffect, useState } from 'react';
import { fetchFlames, type Flame } from '../lib/heat/flamesClient';

const TIER_COLOR: Record<string, string> = {
  Elder: '#f5e4b8',
  Builder: '#4CAF50',
  Resident: '#31d0aa',
  Observer: '#8b5cf6',
  Drifter: 'rgba(255,255,255,0.55)',
};

/** "since Jan 2022". UTC so the month cannot shift by viewer. */
function sinceLabel(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/** "read Sep 6, 09:12 UTC". Stated in UTC because the island reckons in UTC. */
function readLabel(unix: number): string {
  const d = new Date(unix * 1000);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const time = d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'UTC',
  });
  return `read ${date}, ${time} UTC`;
}

export interface FlamesBoardProps {
  /** 5 on the home, 25 in the Island lobby. */
  limit: number;
  /** Named flames only. The card wants this; the insertion rank does not. */
  claimed?: boolean;
}

export function FlamesBoard({ limit, claimed = true }: FlamesBoardProps) {
  const [rows, setRows] = useState<Flame[] | null>(null);
  const [asOf, setAsOf] = useState<number | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    let live = true;
    fetchFlames({ limit, claimed, signal: ac.signal })
      .then((board) => {
        if (!live || !board) return; // board off: stay unmounted
        setRows(board.flames);
        setAsOf(board.asOfUnix);
      })
      .catch(() => {
        /* unreachable or unreadable: stay unmounted, never an error card on the home */
      });
    return () => {
      live = false;
      ac.abort();
    };
  }, [limit, claimed]);

  if (!rows || rows.length === 0) return null;

  return (
    <section aria-label="The board" className="pb-16">
      <div
        className="rounded-2xl p-5"
        style={{
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,0.10)',
        }}
      >
        <h2 className="heading-luxury text-xl text-white tracking-tight mb-1">The board</h2>
        <p className="text-white/60 text-[13px] leading-relaxed mb-4">
          Who has held the longest on Jungle Bay Island. Named by their own hand at the
          island&apos;s door.
        </p>

        <ol className="space-y-2">
          {rows.map((f, i) => (
            <li
              key={`${f.xHandle ?? 'unnamed'}-${i}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px]"
            >
              <span className="w-6 shrink-0 text-white/35 stat-value">{i + 1}</span>

              <span className="min-w-[120px] font-medium">
                {f.xHandle ? (
                  <a
                    href={`https://x.com/${f.xHandle}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4 text-white/90"
                  >
                    @{f.xHandle}
                  </a>
                ) : (
                  <a
                    href="https://memetics.wtf/register"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-4"
                    style={{ color: 'var(--color-kyle)' }}
                  >
                    No name yet. Yours?
                  </a>
                )}
              </span>

              <span className="stat-value" style={{ color: TIER_COLOR[f.tier] ?? '#f5e4b8' }}>
                {f.degrees.toFixed(1)}°
              </span>
              <span
                className="text-[11px] uppercase tracking-[0.14em]"
                style={{ color: TIER_COLOR[f.tier] ?? '#f5e4b8' }}
              >
                {f.tier}
              </span>

              {f.heldSinceUnix !== null && (
                <span className="text-white/45">since {sinceLabel(f.heldSinceUnix)}</span>
              )}
              <span className="text-white/45">
                {f.tokenCount} token{f.tokenCount === 1 ? '' : 's'}
              </span>
            </li>
          ))}
        </ol>

        <div className="flex flex-wrap gap-x-4 gap-y-1 mt-4 text-[12.5px]">
          <a
            href="https://memetics.wtf/flames"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 text-white/70"
          >
            See the whole board
          </a>
          <a
            href="https://memetics.wtf/register"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4"
            style={{ color: 'var(--color-kyle)' }}
          >
            Put your name on it
          </a>
        </div>

        {/* THE RECKONING DATE, on screen. Same law the reading follows: a board with no
            stated read time is a ranking pretending to be current. */}
        {asOf !== null && <p className="text-white/30 text-[11px] mt-3">{readLabel(asOf)}</p>}
      </div>
    </section>
  );
}
