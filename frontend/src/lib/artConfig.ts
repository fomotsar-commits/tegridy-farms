export interface ArtPiece {
  id: string;
  src: string;
  title: string;
  description?: string;
}

export const ART = {
  mfersHeaven: { id: 'mfers-heaven', src: '/art/mfers-heaven.jpg', title: 'All MFers Go to Heaven', description: 'In the end God blesses your goofy ass' },
  mumuBull: { id: 'mumu-bull', src: '/art/mumu-bull.jpg', title: 'Mumu the Bull', description: 'COMMUUUUUMU' },
  bobowelie: { id: 'bobowelie', src: '/art/bobowelie.jpg', title: 'Bobowelie', description: 'This towel gets high and thinks it\'s a bear on steroids' },
  jungleBus: { id: 'jungle-bus', src: '/art/jungle-bus.jpg', title: 'Jungle Bay Island', description: 'Get on the bus' },
  poolParty: { id: 'pool-party', src: '/art/pool-party.jpg', title: 'Pool Party', description: 'Just vibin\'' },
  boxingRing: { id: 'boxing-ring', src: '/art/boxing-ring.jpg', title: 'Fight Night', description: 'Der Bar enters the ring' },
  busCrew: { id: 'bus-crew', src: '/art/bus-crew.jpg', title: 'The Crew', description: 'Rolling deep' },
  forestScene: { id: 'forest-scene', src: '/art/forest-scene.jpg', title: 'Enchanted Forest', description: 'Lost in the vibes' },
  swordOfLove: { id: 'sword-of-love', src: '/art/sword-of-love.jpg', title: 'The Sword of Love', description: 'The sword of love' },
  towelieWindow: { id: 'towelie-window', src: '/art/towelie-window.jpg', title: 'Window Watch', description: 'Peeking through' },
  chaosScene: { id: 'chaos-scene', src: '/art/chaos-scene.jpg', title: 'Chaos', description: 'Pure chaos' },
  galleryCollage: { id: 'gallery-collage', src: '/art/gallery-collage.jpg', title: 'The Collection', description: 'All pieces together' },
  // New art
  apeHug: { id: 'ape-hug', src: '/art/ape-hug.jpg', title: 'The Brotherhood', description: 'Together we stand' },
  beachVibes: { id: 'beach-vibes', src: '/art/beach-vibes.jpg', title: 'Beach Vibes', description: 'Brainlet Billions on the beach' },
  danceNight: { id: 'dance-night', src: '/art/dance-night.jpg', title: 'Dance Night', description: 'The night is young' },
  wrestler: { id: 'wrestler', src: '/art/wrestler.jpg', title: 'The Wrestler', description: 'Ready to rumble' },
  jungleDark: { id: 'jungle-dark', src: '/art/jungle-dark.jpg', title: 'Into the Jungle', description: 'The dark side of the jungle' },
  smokingDuo: { id: 'smoking-duo', src: '/art/smoking-duo.jpg', title: 'Smoking Session', description: 'Don\'t forget to bring a towel' },
  jbChristmas: { id: 'jb-christmas', src: '/art/jb-christmas.jpg', title: 'JB Christmas', description: 'Happy holidays from the jungle' },
  beachSunset: { id: 'beach-sunset', src: '/art/beach-sunset.jpg', title: 'Sunset Beach', description: 'Golden hour at the bay' },
  porchChill: { id: 'porch-chill', src: '/art/porch-chill.jpg', title: 'Porch Chill', description: 'Just two homies on the porch' },
  roseApe: { id: 'rose-ape', src: '/art/rose-ape.jpg', title: 'Rose Ape', description: 'A rose for the community' },
  jbacSkeleton: { id: 'jbac-skeleton', src: '/art/jbac-skeleton.png', title: 'JBAC Skeleton', description: 'The bones of the collective' },
  // Nakamigos drop — fresh art for cards across the app
  naka01: { id: 'naka01', src: '/splash/new/1.avif', title: 'Naka #01', description: 'Fresh from the deck' },
  naka02: { id: 'naka02', src: '/splash/new/3.avif', title: 'Naka #03', description: 'Fresh from the deck' },
  naka03: { id: 'naka03', src: '/splash/new/7.avif', title: 'Naka #07', description: 'Fresh from the deck' },
  naka04: { id: 'naka04', src: '/splash/new/28.avif', title: 'Naka #28', description: 'Fresh from the deck' },
  naka05: { id: 'naka05', src: '/splash/new/53.avif', title: 'Naka #53', description: 'Fresh from the deck' },
  naka06: { id: 'naka06', src: '/splash/new/58.avif', title: 'Naka #58', description: 'Fresh from the deck' },
  naka07: { id: 'naka07', src: '/splash/new/61.avif', title: 'Naka #61', description: 'Fresh from the deck' },
  naka08: { id: 'naka08', src: '/splash/new/1.jpg', title: 'Naka #1', description: 'Fresh from the deck' },
  naka09: { id: 'naka09', src: '/splash/new/2.jpg', title: 'Naka #2', description: 'Fresh from the deck' },
  naka10: { id: 'naka10', src: '/splash/new/4.jpg', title: 'Naka #4', description: 'Fresh from the deck' },
  naka11: { id: 'naka11', src: '/splash/new/5.jpg', title: 'Naka #5', description: 'Fresh from the deck' },
  naka12: { id: 'naka12', src: '/splash/new/6.jpg', title: 'Naka #6', description: 'Fresh from the deck' },
  naka13: { id: 'naka13', src: '/splash/new/8.jpg', title: 'Naka #8', description: 'Fresh from the deck' },
  naka14: { id: 'naka14', src: '/splash/new/9.jpg', title: 'Naka #9', description: 'Fresh from the deck' },
  naka15: { id: 'naka15', src: '/splash/new/10.jpg', title: 'Naka #10', description: 'Fresh from the deck' },
  naka16: { id: 'naka16', src: '/splash/new/11.jpg', title: 'Naka #11', description: 'Fresh from the deck' },
  naka17: { id: 'naka17', src: '/splash/new/12.jpg', title: 'Naka #12', description: 'Fresh from the deck' },
  naka18: { id: 'naka18', src: '/splash/new/13.jpg', title: 'Naka #13', description: 'Fresh from the deck' },
  naka19: { id: 'naka19', src: '/splash/new/14.jpg', title: 'Naka #14', description: 'Fresh from the deck' },
  naka20: { id: 'naka20', src: '/splash/new/17.jpg', title: 'Naka #17', description: 'Fresh from the deck' },
  naka21: { id: 'naka21', src: '/splash/new/18.jpg', title: 'Naka #18', description: 'Fresh from the deck' },
  naka22: { id: 'naka22', src: '/splash/new/20.jpg', title: 'Naka #20', description: 'Fresh from the deck' },
  naka23: { id: 'naka23', src: '/splash/new/22.jpg', title: 'Naka #22', description: 'Fresh from the deck' },
  naka24: { id: 'naka24', src: '/splash/new/28.jpg', title: 'Naka #28b', description: 'Fresh from the deck' },
  naka25: { id: 'naka25', src: '/splash/new/29.jpg', title: 'Naka #29', description: 'Fresh from the deck' },
  naka26: { id: 'naka26', src: '/splash/new/39.jpg', title: 'Naka #39', description: 'Fresh from the deck' },
  naka27: { id: 'naka27', src: '/splash/new/41.jpg', title: 'Naka #41', description: 'Fresh from the deck' },
  naka28: { id: 'naka28', src: '/splash/new/46.jpg', title: 'Naka #46', description: 'Fresh from the deck' },
  naka29: { id: 'naka29', src: '/splash/new/48.jpg', title: 'Naka #48', description: 'Fresh from the deck' },
  naka30: { id: 'naka30', src: '/splash/new/50.jpg', title: 'Naka #50', description: 'Fresh from the deck' },
  naka31: { id: 'naka31', src: '/splash/new/7.jpg', title: 'Naka #7', description: 'Fresh from the deck' },
  // Tradermigos splash pool — also wired into Tegridy cards/backgrounds for max variety
  splash01: { id: 'splash01', src: '/splash/HBl2oMKbIAA813y.jpg', title: 'Twitter art #01', description: 'From the wild west of Crypto Twitter' },
  splash02: { id: 'splash02', src: '/splash/HCIMNrZWYAAqbo1.jpg', title: 'Twitter art #02', description: 'From the wild west of Crypto Twitter' },
  splash03: { id: 'splash03', src: '/splash/HA5nUQ_bsAIHd55.jpg', title: 'Twitter art #03', description: 'From the wild west of Crypto Twitter' },
  splash04: { id: 'splash04', src: '/splash/HBbsuPEacAAX0VA.jpg', title: 'Twitter art #04', description: 'From the wild west of Crypto Twitter' },
  splash05: { id: 'splash05', src: '/splash/HBTG_oqa0AAzPs4.jpg', title: 'Twitter art #05', description: 'From the wild west of Crypto Twitter' },
  splash06: { id: 'splash06', src: '/splash/HC6HNXsW4AA-UwM.jpg', title: 'Twitter art #06', description: 'From the wild west of Crypto Twitter' },
  splash07: { id: 'splash07', src: '/splash/HA5Fd6kWMAAMqL_.jpg', title: 'Twitter art #07', description: 'From the wild west of Crypto Twitter' },
  splash08: { id: 'splash08', src: '/splash/G--r5iuXIAEPwLt.jpg', title: 'Twitter art #08', description: 'From the wild west of Crypto Twitter' },
  splash09: { id: 'splash09', src: '/splash/G-FPcYdXMAAKsWR.jpg', title: 'Twitter art #09', description: 'From the wild west of Crypto Twitter' },
  splash10: { id: 'splash10', src: '/splash/G-AVjGGakAAuW7Z.jpg', title: 'Twitter art #10', description: 'From the wild west of Crypto Twitter' },
  splash11: { id: 'splash11', src: '/splash/G24BZRrakAA1M_9.jpg', title: 'Twitter art #11', description: 'From the wild west of Crypto Twitter' },
  splash12: { id: 'splash12', src: '/splash/G_dkPgxX0AA-9SG.jpg', title: 'Twitter art #12', description: 'From the wild west of Crypto Twitter' },
  splash13: { id: 'splash13', src: '/splash/G8jE1EcWMAAvHTy.jpg', title: 'Twitter art #13', description: 'From the wild west of Crypto Twitter' },
  splash14: { id: 'splash14', src: '/splash/GVsANPZW4AAv1XY.jpg', title: 'Twitter art #14', description: 'From the wild west of Crypto Twitter' },
  watercolor: { id: 'watercolor', src: '/splash/watercolor.jpg', title: 'Watercolor', description: 'Soft strokes, hard culture' },
  frogkingArt: { id: 'frogkingArt', src: '/splash/frogking.jpg', title: 'Frog King', description: 'Pixel monarch' },
  skeletonArt: { id: 'skeletonArt', src: '/splash/skeleton.jpg', title: 'Skeleton', description: 'Bones of the chain' },
  ninjaArt: { id: 'ninjaArt', src: '/splash/ninja.jpg', title: 'Ninja', description: 'Stealth mode' },
  sartoshi3d: { id: 'sartoshi3d', src: '/splash/sartoshi3d.jpg', title: 'Sartoshi 3D', description: 'Render of the legend' },
  angelArt: { id: 'angelArt', src: '/splash/angel.jpg', title: 'Angel', description: 'Halo of the diamond hands' },
  gnssart: { id: 'gnssart', src: '/collections/gnssart.jpg', title: 'GNSS Art', description: 'Generative geometry by MGXS' },
};

/**
 * Single full pool — every art piece in the public folders, in stable order.
 * Used by `pageArt()` to assign unique-per-page art deterministically.
 */
export const ART_POOL_ALL: ArtPiece[] = [
  // Classic Tegridy art
  ART.mfersHeaven, ART.mumuBull, ART.bobowelie, ART.jungleBus, ART.poolParty,
  ART.boxingRing, ART.busCrew, ART.forestScene, ART.swordOfLove, ART.towelieWindow,
  ART.chaosScene, ART.galleryCollage, ART.apeHug, ART.beachVibes, ART.danceNight,
  ART.wrestler, ART.jungleDark, ART.smokingDuo, ART.jbChristmas, ART.beachSunset,
  ART.porchChill, ART.roseApe, ART.jbacSkeleton,
  // Tradermigos splash pool
  ART.splash01, ART.splash02, ART.splash03, ART.splash04, ART.splash05,
  ART.splash06, ART.splash07, ART.splash08, ART.splash09, ART.splash10,
  ART.splash11, ART.splash12, ART.splash13, ART.splash14,
  ART.watercolor, ART.frogkingArt, ART.skeletonArt, ART.ninjaArt,
  ART.sartoshi3d, ART.angelArt,
  // Collection covers
  ART.gnssart,
  // Nakamigos drop
  ART.naka01, ART.naka02, ART.naka03, ART.naka04, ART.naka05, ART.naka06,
  ART.naka07, ART.naka08, ART.naka09, ART.naka10, ART.naka11, ART.naka12,
  ART.naka13, ART.naka14, ART.naka15, ART.naka16, ART.naka17, ART.naka18,
  ART.naka19, ART.naka20, ART.naka21, ART.naka22, ART.naka23, ART.naka24,
  ART.naka25, ART.naka26, ART.naka27, ART.naka28, ART.naka29, ART.naka30,
  ART.naka31,
];

/**
 * Returns the Nth art piece for a given page, deterministically.
 * Each pageId hashes to a stable starting offset in ART_POOL_ALL, then we
 * take consecutive pieces — guaranteeing no same-page duplicates as long as
 * the page uses indexes 0..N-1 with N <= ART_POOL_ALL.length.
 */
export function pageArt(pageId: string, idx: number): ArtPiece {
  let hash = 5381;
  for (let i = 0; i < pageId.length; i++) {
    hash = ((hash * 33) ^ pageId.charCodeAt(i)) >>> 0;
  }
  const offset = hash % ART_POOL_ALL.length;
  return ART_POOL_ALL[(offset + idx) % ART_POOL_ALL.length]!;
}

// Interleave classic art with new pieces so card grids cycle through both
// instead of clumping new images at the end.
export const GALLERY_ORDER: ArtPiece[] = [
  ART.swordOfLove, ART.naka01,
  ART.mfersHeaven, ART.naka02,
  ART.jungleBus, ART.naka03,
  ART.poolParty, ART.naka04,
  ART.mumuBull, ART.naka05,
  ART.bobowelie, ART.naka06,
  ART.boxingRing, ART.naka07,
  ART.busCrew, ART.naka08,
  ART.forestScene, ART.naka09,
  ART.towelieWindow, ART.naka10,
  ART.chaosScene, ART.naka11,
  ART.apeHug, ART.naka12,
  ART.beachVibes, ART.naka13,
  ART.danceNight, ART.naka14,
  ART.wrestler, ART.naka15,
  ART.jungleDark, ART.naka16,
  ART.smokingDuo, ART.naka17,
  ART.jbChristmas, ART.naka18,
  ART.beachSunset, ART.naka19,
  ART.porchChill, ART.naka20,
  ART.roseApe, ART.naka21,
  ART.jbacSkeleton, ART.naka22,
  ART.galleryCollage, ART.naka23,
  ART.naka24, ART.naka25, ART.naka26, ART.naka27,
  ART.naka28, ART.naka29, ART.naka30, ART.naka31,
];
