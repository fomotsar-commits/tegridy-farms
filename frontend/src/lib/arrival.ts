import { getActiveBungalow, BAYLA_ART } from './bungalows';
// Type only, so this eagerly loaded module never pulls the heat oracle into the entry chunk.
import type { HeatTier } from './heat/heatOracle';

/** Who the venue speaks as on arrival: 'venue' (nothing chosen), 'toweli' (the TOWELI
 *  bungalow, the classic Tegridy experience whole and untouched) or 'bungalow' (a room
 *  with its own identity). Synchronous and module-scope safe: pathname and localStorage
 *  only. The path is read first so /toweli speaks Tegridy on its very first visit. */
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

/** Dispatched to invite the venue welcome (OnboardingModal listens); it never opens on its own. */
export const OPEN_VENUE_WELCOME_EVENT = 'open-venue-welcome';

/** True when the classic Tegridy voice should render (inside its bungalow). */
export function isToweliVoice(): boolean {
  return arrivalVoice() === 'toweli';
}

// The venue's own identity: copy pinned here so every surface quotes one source.

/** The launch-floor sentence. The caller passes heatLaunchFloor() and tierAtFloor(floor);
 *  between rungs no tier is named. Arguments, so this module stays free of the oracle. */
export function heatExampleLine(floor: number, tier: HeatTier | null): string {
  return tier
    ? `At ${floor} degrees you reach ${tier}, the tier that may plant a launch here.`
    : `The launch door opens at ${floor} degrees.`;
}

export const VENUE = {
  /** Brand wordmark halves (nav, footer, loader formation). */
  markMain: 'MEMETICS',
  markSub: '.FINANCE',
  name: 'MEMETICS.FINANCE',
  /** The island authors the standard; the venue is a place on its map, never run by it. */
  tagline: 'Memetic Finance on Jungle Bay Island',
  heroTitle: 'MEMETICS.FINANCE',
  heroLine: 'Held time counts here.',
  heroCopy:
    'The venue of Jungle Bay Island. Bungalows for meme communities, launches ' +
    'that open on Heat instead of hype, staking and swaps with every fee routed ' +
    'onchain where you can read it. Heat is held time, measured by the island’s ' +
    'instrument. It cannot be bought and it cannot be faked.',
  /** Plain language before the lore; every clause is live (the Farm, three chains, /scan). */
  heroPlain:
    'Stake meme tokens, swap on Ethereum, Base and Solana, and check any token before you buy.',
  /** Second person, present tense, the viewer's own stake. */
  heroHook: 'Your heat already exists. It started counting at your first buy.',
  /** Under the instrument, and in llms.txt: one source, so the two cannot disagree. */
  heatPerWallet:
    "Held time is measured per wallet. A bag moved to a new wallet starts that wallet's clock at the move.",
  /** The island's own sentences, verbatim: the hero, llms.txt and the Maths fold quote
   *  them, and islandClaims.test.ts pins them word for word. Sentences, never a formula. */
  heatPlain:
    'Heat counts the days you have held each token. It is read per token and ' +
    'added together across everything you hold. Size can raise what a day is ' +
    'worth, it cannot buy a day, and price never enters it.',
  heatDays: 'Your clock on a token starts at your first hold.',
  heatSize:
    'A real position earns a full day. The largest holders earn up to two. Dust earns nothing.',
  museLine: 'An island in a sea of rugs.',
  museBy: 'Jungle Bay Island',
  /** Meta description, mirrored by index.html and usePageTitle. Names only what is live,
   *  and claims no certification: the venue is a candidate under the island's standard. */
  description:
    'memetics.finance is the venue of Jungle Bay Island. Bungalows for meme ' +
    'communities, Heat-gated launches, and verifiable staking and swaps on ' +
    'Ethereum, Base and Solana.',
} as const;

// Loader identity: which words the particles form, which the glitch flashes, which art shows.

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
  // Bayla canon pieces lead; the last shatters into the vortex that forms the venue's name.
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
