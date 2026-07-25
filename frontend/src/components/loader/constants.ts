import { pageArt } from '../../lib/artConfig';
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

export const GOLD = '#d4a017';
export const SUBLIMINAL = ['TEGRIDY', 'FAFO', 'DM+T', 'WAGMI'];
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
