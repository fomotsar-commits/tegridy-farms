export const ART_COLLECTION: Array<{ src: string; title: string }> = [
  { src: '/art/mfers-heaven.jpg', title: 'All MFers Go to Heaven' },
  { src: '/art/mumu-bull.jpg', title: 'Mumu the Bull' },
  { src: '/art/bobowelie.jpg', title: 'Bobowelie' },
  { src: '/art/jungle-bus.jpg', title: 'Jungle Bay Island' },
  { src: '/art/pool-party.jpg', title: 'Pool Party' },
  { src: '/art/boxing-ring.jpg', title: 'Fight Night' },
  { src: '/art/forest-scene.jpg', title: 'Enchanted Forest' },
  { src: '/art/chaos-scene.jpg', title: 'Chaos' },
  { src: '/art/ape-hug.jpg', title: 'The Brotherhood' },
  { src: '/art/beach-vibes.jpg', title: 'Beach Vibes' },
  { src: '/art/dance-night.jpg', title: 'Dance Night' },
  { src: '/art/wrestler.jpg', title: 'The Wrestler' },
  { src: '/art/smoking-duo.jpg', title: 'Smoking Session' },
  { src: '/art/beach-sunset.jpg', title: 'Sunset Beach' },
  { src: '/art/porch-chill.jpg', title: 'Porch Chill' },
  { src: '/art/rose-ape.jpg', title: 'Rose Ape' },
  { src: '/art/sword-of-love.jpg', title: 'The Sword of Love' },
  { src: '/art/towelie-window.jpg', title: 'Window Watch' },
  { src: '/art/bus-crew.jpg', title: 'The Crew' },
  { src: '/art/gallery-collage.jpg', title: 'The Collection' },
  { src: '/art/jungle-dark.jpg', title: 'Into the Jungle' },
  { src: '/art/jb-christmas.jpg', title: 'JB Christmas' },
  // Nakamigos drop — fresh art for the loader rotation
  { src: '/splash/new/61.avif', title: 'Naka #61' },
  { src: '/splash/new/2.jpg', title: 'Naka #2' },
  { src: '/splash/new/50.jpg', title: 'Naka #50' },
  { src: '/splash/new/48.jpg', title: 'Naka #48' },
  { src: '/splash/new/28.jpg', title: 'Naka #28' },
  { src: '/splash/new/58.avif', title: 'Naka #58' },
  { src: '/splash/new/41.jpg', title: 'Naka #41' },
  { src: '/splash/new/53.avif', title: 'Naka #53' },
  { src: '/splash/new/29.jpg', title: 'Naka #29' },
  { src: '/splash/new/17.jpg', title: 'Naka #17' },
  { src: '/splash/new/46.jpg', title: 'Naka #46' },
  { src: '/splash/new/1.avif', title: 'Naka #1' },
  { src: '/splash/new/14.jpg', title: 'Naka #14' },
  { src: '/splash/new/20.jpg', title: 'Naka #20' },
  { src: '/splash/new/3.avif', title: 'Naka #3' },
  { src: '/splash/new/18.jpg', title: 'Naka #18' },
  { src: '/splash/new/5.jpg', title: 'Naka #5' },
  { src: '/splash/new/39.jpg', title: 'Naka #39' },
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
