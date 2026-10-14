import type { CSSProperties } from 'react';
import { ISLAND_SOUND } from '../lib/islandSound';

// Muted plain words. Never in a trade or stake form, a quote, a price, wallet
// connect or a warning: IslandSound.test.tsx pins the files that may mount these.
const LINK = 'underline underline-offset-2 hover:text-white transition-colors';
const OUT = { target: '_blank', rel: 'noopener noreferrer' } as const;

/** "spotify · youtube", each named for a screen reader. */
export function IslandSoundLinks() {
  return (
    <>
      <a href={ISLAND_SOUND.spotify} {...OUT} aria-label="jungle bay on spotify (opens in new tab)" className={LINK}>
        spotify
      </a>
      <span aria-hidden="true"> · </span>
      <a href={ISLAND_SOUND.youtube} {...OUT} aria-label="jungle bay on youtube (opens in new tab)" className={LINK}>
        youtube
      </a>
    </>
  );
}

/** One soft line for a panel whose read came back complete and empty. Never under a load or a failure. */
export function IslandHum({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <p className={className} style={style}>
      <a
        href={ISLAND_SOUND.track}
        {...OUT}
        title="memetic sorcerer, on spotify"
        aria-label="the island hums meanwhile: memetic sorcerer by jungle bay on spotify (opens in new tab)"
        className={LINK}
      >
        the island hums meanwhile.
      </a>
    </p>
  );
}
