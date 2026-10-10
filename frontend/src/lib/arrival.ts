import { getActiveBungalow, BAYLA_ART } from './bungalows';
import { roomSpeaksOn } from './routeVoice';
// Type only, so this eagerly loaded module never pulls the heat oracle into the entry chunk.
import type { HeatTier } from './heat/heatOracle';

/** Who the venue speaks as here: 'venue', 'toweli' (the TOWELI bungalow, the classic
 *  Tegridy experience whole and untouched) or 'bungalow' (a room with its own identity).
 *  Synchronous and module-scope safe: pathname and localStorage only. The path is read
 *  first so /toweli speaks Tegridy on its very first visit. The room opened last speaks
 *  as the farm only on the farm's own pages (roomSpeaksOn): never on a venue route. */
export type ArrivalVoice = 'venue' | 'toweli' | 'bungalow';

/** Door paths that mean "the TOWELI bungalow", mirroring App.tsx's alias. */
const TOWELI_PATHS = new Set(['toweli', 'towelie']);

export function arrivalVoice(): ArrivalVoice {
  if (typeof window === 'undefined') return 'venue';
  return voiceAt(window.location.pathname, window.location.search);
}

/** arrivalVoice for a given path: what a component that already holds the router's
 *  location asks, so its answer never trails the address bar. */
export function voiceAt(pathname: string, search: string): ArrivalVoice {
  if (typeof window === 'undefined') return 'venue';
  try {
    const seg = pathname.split('/')[1]?.toLowerCase() ?? '';
    if (TOWELI_PATHS.has(seg)) return 'toweli';
    const q = new URLSearchParams(search).get('bungalow');
    if (q === 'toweli') return 'toweli';
  } catch { /* fall through to the stored choice */ }
  const active = getActiveBungalow();
  if (!active) return 'venue';
  if (active.id === 'toweli') return roomSpeaksOn(pathname, 'toweli') ? 'toweli' : 'venue';
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

// The island paragraph's first two sentences: VENUE.heatPlain, and heatParagraph's opening.
const HEAT_OPENING =
  'Heat counts your warm days: every day you hold, weighted by size and by the coin. ' +
  'Your deepest room sets your heat; every other room adds a quarter of its own, ' +
  'so breadth amplifies depth and never replaces it.';

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
  heroHook: 'Your heat already exists. Your clock on a token starts at your first hold.',
  /** The island's sentence, verbatim: under the instrument, in the FAQ and in llms.txt. */
  heatOnePerson: 'One person, every wallet: linked wallets read as a single flame.',
  /** The island's sentences, verbatim: the hero and llms.txt carry the first two, the
   *  Maths fold the whole paragraph; islandClaims.test.ts pins them. Never a formula. */
  heatPlain: HEAT_OPENING,
  heatParagraph:
    `${HEAT_OPENING} Degrees are the temperature of that count: one real position held ` +
    'half a year reads 80°, Resident. Past Resident the number reads like fire: every ' +
    'degree costs a little more than the last, and the hottest flames stay in range. ' +
    'Size can raise what a day is worth, it cannot buy a day, and price never enters it. ' +
    'The rate is one curve for every wallet: nothing under 0.0001% of a supply, a full ' +
    'day at 0.01%, two at 1%, and never more. From a real position up, ten times the bag ' +
    'adds half a day. The tier words bind your island heat. Trading speed cannot move it.',
  heatDays: 'Your clock on a token starts at your first hold.',
  heatSize:
    'A real position earns a full day. The largest holders earn up to two. Dust earns ' +
    'nothing. An Ape counts by the piece: one is a full day, ten are two.',
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
