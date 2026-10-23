// The island today, on the venue's home, under the doors (the island's venue review,
// item 9): $BAYLA locked in the ladder, read from the pool; $BAYLA fed to the fire, the
// island's own served total; the flames, counted from its board. Under them, the
// island's season and its last torch, with the room and how long ago.
//
// READ ON LOAD, NEVER TYPED. Each part is its own read and stands alone: a part that
// could not be read is left out, never shown as a zero, and with nothing read the strip
// is not drawn at all.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useIslandTorches } from '../hooks/useIslandTorches';
import { ageWords, roomOfPlace, seasonLine, wholeNumber } from '../lib/heat/torchesClient';
import { CardArt } from './ui/CardArt';

type Locked = { symbol: string; raw: bigint; decimals: number };

/** The ladder's total principal; null until read, and null for good when it could not be. */
function useLadderLocked(): Locked | null {
  const [locked, setLocked] = useState<Locked | null>(null);
  useEffect(() => {
    let live = true;
    import('../lib/ladder/locked')
      .then((m) => m.readLadderLocked())
      .then((r) => { if (live) setLocked(r); })
      .catch(() => { /* unread: left out */ });
    return () => { live = false; };
  }, []);
  return locked;
}

/** Whole tokens, grouped: the strip has no room for dust. */
function wholeTokens(raw: bigint, decimals: number): string {
  return (raw / 10n ** BigInt(decimals)).toLocaleString('en-US');
}

export function IslandStrip() {
  const torches = useIslandTorches();
  const locked = useLadderLocked();

  const figures: { key: string; text: string }[] = [];
  if (locked) figures.push({ key: 'locked', text: `${wholeTokens(locked.raw, locked.decimals)} $${locked.symbol} locked` });
  if (torches?.fireBurned != null) figures.push({ key: 'fire', text: `${wholeNumber(torches.fireBurned)} $BAYLA fed to the fire` });
  if (torches?.flames != null) figures.push({ key: 'flames', text: `${wholeNumber(torches.flames)} flame${torches.flames === 1 ? '' : 's'}` });

  const season = torches?.season ? seasonLine(torches.season, torches.readAtMs) : null;
  const last = torches?.lastTorch ?? null;
  const lastRoom = last ? roomOfPlace(last.place) : null;

  if (figures.length === 0 && !season && !last) return null;

  return (
    <section aria-label="The island today" className="pb-16" data-testid="island-strip">
      <div
        className="relative isolate rounded-2xl p-5"
        style={{
          background: 'rgba(0,0,0,0.45)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(255,255,255,0.10)',
        }}
      >
        <CardArt pageId="island-strip" idx={0} />
        {figures.length > 0 && (
          <p className="stat-value text-white text-[16px] md:text-[18px] leading-snug m-0">
            {figures.map((f, i) => (
              <span key={f.key} data-testid={`island-strip-${f.key}`}>
                {i > 0 && <span className="text-white/40"> &middot; </span>}
                {f.text}
              </span>
            ))}
          </p>
        )}
        {(season || last) && (
          <p className="text-white/70 text-[13px] mt-2 mb-0">
            {season && <span data-testid="island-strip-season">{season}</span>}
            {season && last && <span className="text-white/40"> &middot; </span>}
            {last && (
              <span data-testid="island-strip-last">
                The last torch:{' '}
                {lastRoom ? (
                  <Link to={`/${lastRoom}`} className="underline underline-offset-4 text-white/90">{last.label ?? lastRoom}</Link>
                ) : (
                  last.label ?? 'a room'
                )}
                , by {last.name ?? 'someone with no name yet'}, {ageWords(last.litAtMs, torches!.readAtMs)}
              </span>
            )}
          </p>
        )}
      </div>
    </section>
  );
}
