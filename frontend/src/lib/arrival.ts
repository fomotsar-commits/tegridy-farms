import { getActiveBungalow, BAYLA_ART } from './bungalows';

/**
 * ARRIVAL VOICE: the single choke point for WHO the venue speaks as
 * when a visitor lands.
 *
 *  - 'venue'    : nothing chosen. The venue speaks as itself:
 *                 MEMETICS.FINANCE, the venue of Jungle Bay Island.
 *                 This is the new default first impression.
 *  - 'toweli'   : the visitor is in the TOWELI bungalow (stored choice,
 *                 /toweli or /towelie door, or ?bungalow=toweli). The
 *                 classic Tegridy Farms experience lives here, whole and
 *                 untouched: words, art, Towelie personality, all of it.
 *  - 'bungalow' : a non-default bungalow with its own identity (Bayla).
 *                 Token-first surfaces speak that token, as before.
 *
 * Design notes, in the repo's own culture:
 *  - Synchronous, module-scope safe: pathname + localStorage reads only,
 *    exactly like getActiveBungalow(). The loader resolves its words at
 *    mount and cannot wait for React state.
 *  - Path is read FIRST so /toweli shows the Tegridy intro on the very
 *    first visit, before BungalowDoor has persisted the choice. Without
 *    this the first-ever /toweli arrival would flash the venue intro.
 *  - Additive (feedback_preserve_art): nothing Tegridy is deleted. The
 *    classic experience is relocated behind its own door, not edited.
 */
export type ArrivalVoice = 'venue' | 'toweli' | 'bungalow';

/** Door paths that mean "the TOWELI bungalow", mirroring App.tsx's alias. */
const TOWELI_PATHS = new Set(['toweli', 'towelie']);

export function arrivalVoice(): ArrivalVoice {
  if (typeof window === 'undefined') return 'venue';
  try {
    const seg = window.location.pathname.split('/')[1]?.toLowerCase() ?? '';
    if (TOWELI_PATHS.has(seg)) return 'toweli';
    const q = new URLSearchParams(window.location.search).get('bungalow');
    if (q === 'toweli') return 'toweli';
  } catch { /* fall through to the stored choice */ }
  const active = getActiveBungalow();
  if (!active) return 'venue';
  if (active.id === 'toweli') return 'toweli';
  return active.identity ? 'bungalow' : 'venue';
}

/**
 * ARRIVAL FLOW 2026-08-31: the venue welcome is INVITED, never automatic.
 * The hero's tour pill (and anything else that wants to orient a visitor)
 * dispatches this; OnboardingModal listens. Declared here beside the voice
 * so the arrival contract lives in one file.
 */
export const OPEN_VENUE_WELCOME_EVENT = 'open-venue-welcome';

/** True when the classic Tegridy voice should render (inside its bungalow). */
export function isToweliVoice(): boolean {
  return arrivalVoice() === 'toweli';
}

/* ------------------------------------------------------------------ */
/* The venue's own identity: copy pinned here so every surface quotes  */
/* one source and a rewrite cannot fork the voice.                     */
/* ------------------------------------------------------------------ */

export const VENUE = {
  /** Brand wordmark halves (nav, footer, loader formation). */
  markMain: 'MEMETICS',
  markSub: '.FINANCE',
  name: 'MEMETICS.FINANCE',
  /** One-line world placement. The island authors the standard; the venue
   *  is a place on the island's map. The island never operates the venue. */
  tagline: 'Memetic Finance on Jungle Bay Island',
  heroTitle: 'MEMETICS.FINANCE.',
  heroLine: 'Held time counts here.',
  heroCopy:
    'The venue of Jungle Bay Island. Bungalows for meme communities, launches ' +
    'that open on Heat instead of hype, staking and swaps with every fee routed ' +
    'onchain where you can read it. Heat is held time, measured by the island’s ' +
    'instrument. It cannot be bought and it cannot be faked.',
  /** Second person, present tense, the viewer's own stake. */
  heroHook: 'Your heat already exists. It started counting at your first buy.',
  museLine: 'An island in a sea of rugs.',
  museBy: 'Jungle Bay Island',
  /** Meta description: mirrored by index.html and usePageTitle. Names only
   *  what is live. No certification claim anywhere: the venue is a
   *  candidate under the island's standard and never says otherwise. */
  description:
    'memetics.finance is the venue of Jungle Bay Island. Bungalows for meme ' +
    'communities, Heat-gated launches, and verifiable staking and swaps on ' +
    'Ethereum, Base and Solana.',
} as const;

/* ------------------------------------------------------------------ */
/* Loader identity: which words the particles form, which words the    */
/* glitch flashes, which art the gallery shows.                        */
/* ------------------------------------------------------------------ */

export interface LoaderIdentity {
  main: string;
  sub: string;
  subliminal: string[];
  /** Gallery override: null keeps the classic collection. */
  gallery: Array<{ src: string; title: string }> | null;
}

const VENUE_LOADER: LoaderIdentity = {
  main: VENUE.markMain,
  sub: VENUE.markSub,
  subliminal: ['MEMETICS', 'HEAT', 'HELD TIME', 'JUNGLE BAY'],
  // The island's muse leads the venue arrival: Bayla canon pieces
  // (real art, honest titles, already shipped in /public/art/bayla).
  // The last piece shatters into the vortex that forms the venue's name.
  gallery: BAYLA_ART.map((a) => ({ src: a.src, title: a.title })),
};

const TOWELI_LOADER: LoaderIdentity = {
  main: 'TEGRIDY',
  sub: 'FARMS',
  subliminal: ['TEGRIDY', 'FAFO', 'DM+T', 'WAGMI'],
  gallery: null,
};

export function loaderIdentity(): LoaderIdentity {
  return arrivalVoice() === 'toweli' ? TOWELI_LOADER : VENUE_LOADER;
}
