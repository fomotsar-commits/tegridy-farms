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
  /**
   * PLAIN LANGUAGE, before the lore. Additive — the island writing below is
   * untouched and stays the voice of the page; this only gives a first-time
   * reader somewhere to stand before it.
   *
   * Every clause is checkable: staking is live on the Farm; the swap surfaces
   * cover the three chains named in `description` (Ethereum, Base and Solana —
   * isSolanaSwapLive() is true); "check any token" is /scan, the Token Scanner,
   * which is also the third CTA below.
   */
  heroPlain:
    'Stake meme tokens, swap on Ethereum, Base and Solana, and check any token before you buy.',
  /** Second person, present tense, the viewer's own stake. */
  heroHook: 'Your heat already exists. It started counting at your first buy.',
  /**
   * HEAT, MECHANICALLY — the sentence that has to be true.
   *
   * Every word here is traceable to lib/heat/heatOracle.ts:
   *   heat_degrees = 100 · (1 − e^(−60 · TWAB / totalSupply)) per (wallet, token),
   *   summed across tokens; one token caps at 100°. The launch floor is 80°
   *   (Resident) per heatGateConfig.heatLaunchFloor().
   *
   * WHAT THIS DELIBERATELY DOES NOT SAY, and must never say: any averaging
   * window, any number of days, any decay schedule. The island has confirmed
   * exactly three properties — continuous, zero-anchored, velocity-blind — and
   * the venue previously published a 180-day window it had invented and built a
   * decay mechanic on. islandClaims.test.ts fails the build if a window length
   * or decay mechanic reappears in user-facing source, and it is right to.
   *
   * It also does not say "days held x the size of your bag". That is wrong three
   * ways: the input is a SHARE of total supply, not an absolute balance; the
   * curve SATURATES, so more of both stops helping; and a fresh bag reads cold
   * however large it is.
   */
  heatPlain:
    'Heat scores how much of a token you have held, and for how long — as a share ' +
    'of its supply, not a dollar amount. Each token you hold scores 0 to 100 degrees; ' +
    'your Heat is those scores added together. Price never enters it, so Heat cannot ' +
    'be bought, and a fresh bag starts cold however large it is.',
  /** The worked example. 80° is the live launch floor, not a round number chosen for prose. */
  heatExample:
    'At 80 degrees you reach Resident, the tier that may plant a launch here.',
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
