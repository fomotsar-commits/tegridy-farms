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
};

export const GALLERY_ORDER: ArtPiece[] = [
  ART.swordOfLove,
  ART.mfersHeaven,
  ART.jungleBus,
  ART.poolParty,
  ART.mumuBull,
  ART.bobowelie,
  ART.boxingRing,
  ART.busCrew,
  ART.forestScene,
  ART.towelieWindow,
  ART.chaosScene,
  ART.apeHug,
  ART.beachVibes,
  ART.danceNight,
  ART.wrestler,
  ART.jungleDark,
  ART.smokingDuo,
  ART.jbChristmas,
  ART.beachSunset,
  ART.porchChill,
  ART.roseApe,
  ART.jbacSkeleton,
  ART.galleryCollage,
];
