export interface ArtPiece {
  src: string;
  title: string;
  description?: string;
}

export const ART: Record<string, ArtPiece> = {
  mfersHeaven: { src: '/art/mfers-heaven.jpg', title: 'All MFers Go to Heaven', description: 'In the end God blesses your goofy ass' },
  mumuBull: { src: '/art/mumu-bull.jpg', title: 'Mumu the Bull', description: 'COMMUUUUUMU' },
  bobowelie: { src: '/art/bobowelie.jpg', title: 'Bobowelie', description: 'This towel gets high and thinks it\'s a bear on steroids' },
  jungleBus: { src: '/art/jungle-bus.jpg', title: 'Jungle Bay Island', description: 'Get on the bus' },
  poolParty: { src: '/art/pool-party.jpg', title: 'Pool Party', description: 'Just vibin\'' },
  boxingRing: { src: '/art/boxing-ring.jpg', title: 'Fight Night', description: 'Der Bar enters the ring' },
  busCrew: { src: '/art/bus-crew.jpg', title: 'The Crew', description: 'Rolling deep' },
  forestScene: { src: '/art/forest-scene.jpg', title: 'Enchanted Forest', description: 'Lost in the vibes' },
  swordOfLove: { src: '/art/sword-of-love.jpg', title: 'The Sword of Love', description: 'The sword of love' },
  towelieWindow: { src: '/art/towelie-window.jpg', title: 'Window Watch', description: 'Peeking through' },
  chaosScene: { src: '/art/chaos-scene.jpg', title: 'Chaos', description: 'Pure chaos' },
  galleryCollage: { src: '/art/gallery-collage.jpg', title: 'The Collection', description: 'All pieces together' },
  // New art
  apeHug: { src: '/art/ape-hug.jpg', title: 'The Brotherhood', description: 'Together we stand' },
  beachVibes: { src: '/art/beach-vibes.jpg', title: 'Beach Vibes', description: 'Brainlet Billions on the beach' },
  danceNight: { src: '/art/dance-night.jpg', title: 'Dance Night', description: 'The night is young' },
  wrestler: { src: '/art/wrestler.jpg', title: 'The Wrestler', description: 'Ready to rumble' },
  jungleDark: { src: '/art/jungle-dark.jpg', title: 'Into the Jungle', description: 'The dark side of the jungle' },
  smokingDuo: { src: '/art/smoking-duo.jpg', title: 'Smoking Session', description: 'Don\'t forget to bring a towel' },
  jbChristmas: { src: '/art/jb-christmas.jpg', title: 'JB Christmas', description: 'Happy holidays from the jungle' },
  beachSunset: { src: '/art/beach-sunset.jpg', title: 'Sunset Beach', description: 'Golden hour at the bay' },
  porchChill: { src: '/art/porch-chill.jpg', title: 'Porch Chill', description: 'Just two homies on the porch' },
  roseApe: { src: '/art/rose-ape.jpg', title: 'Rose Ape', description: 'A rose for the community' },
  jbacSkeleton: { src: '/art/jbac-skeleton.png', title: 'JBAC Skeleton', description: 'The bones of the collective' },
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
