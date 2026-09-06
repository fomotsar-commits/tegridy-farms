import { pageArt } from '../../lib/artConfig';
import { loaderIdentity } from '../../lib/arrival';

/**
 * ARRIVAL IDENTITY 2026-08-27: the intro used to hardcode TEGRIDY / FARMS
 * for every visitor. The words, the subliminal set and the gallery now
 * resolve per arrival voice (see lib/arrival.ts): the venue's own name for
 * the default arrival, the classic Tegridy intro inside the TOWELI
 * bungalow. Resolved once at module scope, same synchronous contract as
 * pageArt(): the loader mounts before any React state exists.
 */
const IDENTITY = loaderIdentity();

/** The words the particle vortex forms (main over sub). */
export const LOADER_WORDS = { main: IDENTITY.main, sub: IDENTITY.sub } as const;

export const ART_COLLECTION: Array<{ src: string; title: string }> = [
  { src: pageArt('loader', 0).src, title: 'All MFers Go to Heaven' },
  { src: pageArt('loader', 1).src, title: 'Mumu the Bull' },
  { src: pageArt('loader', 2).src, title: 'Bobowelie' },
  { src: pageArt('loader', 3).src, title: 'Jungle Bay Island' },
  { src: pageArt('loader', 4).src, title: 'Pool Party' },
  { src: pageArt('loader', 5).src, title: 'Fight Night' },
  { src: pageArt('loader', 6).src, title: 'Enchanted Forest' },
  { src: pageArt('loader', 7).src, title: 'Chaos' },
  { src: pageArt('loader', 8).src, title: 'The Brotherhood' },
  { src: pageArt('loader', 9).src, title: 'Beach Vibes' },
  { src: pageArt('loader', 10).src, title: 'Dance Night' },
  { src: pageArt('loader', 11).src, title: 'The Wrestler' },
  { src: pageArt('loader', 12).src, title: 'Smoking Session' },
  { src: pageArt('loader', 13).src, title: 'Sunset Beach' },
  { src: pageArt('loader', 14).src, title: 'Porch Chill' },
  { src: pageArt('loader', 15).src, title: 'Rose Ape' },
  { src: pageArt('loader', 16).src, title: 'The Sword of Love' },
  { src: pageArt('loader', 17).src, title: 'Window Watch' },
  { src: pageArt('loader', 18).src, title: 'The Crew' },
  { src: pageArt('loader', 19).src, title: 'The Collection' },
  { src: pageArt('loader', 20).src, title: 'Into the Jungle' },
  { src: pageArt('loader', 21).src, title: 'JB Christmas' },
  { src: pageArt('loader', 22).src, title: 'Naka #61' },
  { src: pageArt('loader', 23).src, title: 'Naka #2' },
  { src: pageArt('loader', 24).src, title: 'Naka #50' },
  { src: pageArt('loader', 25).src, title: 'Naka #48' },
  { src: pageArt('loader', 26).src, title: 'Naka #28' },
  { src: pageArt('loader', 27).src, title: 'Naka #58' },
  { src: pageArt('loader', 28).src, title: 'Naka #41' },
  { src: pageArt('loader', 29).src, title: 'Naka #53' },
  { src: pageArt('loader', 30).src, title: 'Naka #29' },
  { src: pageArt('loader', 31).src, title: 'Naka #17' },
  { src: pageArt('loader', 32).src, title: 'Naka #46' },
  { src: pageArt('loader', 33).src, title: 'Naka #1' },
  { src: pageArt('loader', 34).src, title: 'Naka #14' },
  { src: pageArt('loader', 35).src, title: 'Naka #20' },
  { src: pageArt('loader', 36).src, title: 'Naka #3' },
  { src: pageArt('loader', 37).src, title: 'Naka #18' },
  { src: pageArt('loader', 38).src, title: 'Naka #5' },
  { src: pageArt('loader', 39).src, title: 'Naka #39' },
];

/**
 * The gallery the intro actually shows: the classic collection inside the
 * TOWELI bungalow, the arrival identity's own set (Bayla canon) for the
 * venue default. The last piece shown is the one that shatters into the
 * vortex that forms the venue's name.
 */
export const LOADER_GALLERY: Array<{ src: string; title: string }> =
  IDENTITY.gallery ?? ART_COLLECTION;

export const GOLD = '#d4a017';
export const SUBLIMINAL = IDENTITY.subliminal;
export const STIFFNESS = 0.07;
export const DAMPING = 0.87;

/* Timings (ms) */
export const T_VOID_END = 1500;
export const T_ART_START = T_VOID_END;
export const T_ART_DURATION = 2600;
export const T_ART_COUNT = 4;
export const T_ART_END = T_ART_START + T_ART_DURATION * T_ART_COUNT;
export const T_SHATTER_END = 11000;
export const T_VORTEX_END = 12500;
export const T_TEXT_END = 14500;

/* Exit timings */
export const T_CRACK_DURATION = 500;
export const T_EXIT_FINALIZE = 2000;

/**
 * THE TWO ARRIVALS (wave seven, element A).
 *
 * The timings above are THE FILM: four pieces, the shatter, the vortex, the hold,
 * ~14.5 s to the wordmark and a crack on the way out. Nothing about it changes —
 * it is the best art on the site and it keeps every frame. It simply stops being
 * the thing standing between a stranger and the venue.
 *
 * The CURTAIN is what the arrival plays now: one piece, the name forming, gone in
 * about two and a half seconds, and pass-through the whole time so the hero
 * underneath is live from the first paint. It is a curtain over an
 * already-rendered home rather than a wall in front of one.
 *
 * The film keeps its home: "Watch the arrival" in the Island lobby mounts
 * <AppLoader full /> and plays the whole thing, deliberately, for somebody who
 * came to see it. That mount is why the curtain is allowed to be short — no art
 * is removed, it is re-homed.
 */
export interface ArrivalTiming {
  voidEnd: number;
  artCount: number;
  artDuration: number;
}

export const FILM_TIMING: ArrivalTiming = {
  voidEnd: T_VOID_END,
  artCount: T_ART_COUNT,
  artDuration: T_ART_DURATION,
};

export const CURTAIN_TIMING: ArrivalTiming = {
  voidEnd: 400,
  artCount: 1,
  artDuration: 1200,
};

/**
 * What the curtain must not exceed, end to end, with no input at all.
 *
 * 400 void + 1200 art + the textForm settle + the 400 ms dissolve. Stated as one
 * number because it is the element's promise ("the curtain is gone by 3000 ms"),
 * and a test can hold a promise where four separate constants cannot.
 */
export const CURTAIN_BUDGET_MS = 3000;
