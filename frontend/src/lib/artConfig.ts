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
  boxingRing: { src: '/art/boxing-ring.jpg', title: 'Fight Night', description: 'Der Bär enters the ring' },
  busCrew: { src: '/art/bus-crew.jpg', title: 'The Crew', description: 'Rolling deep' },
  forestScene: { src: '/art/forest-scene.jpg', title: 'Enchanted Forest', description: 'Lost in the vibes' },
  swordOfLove: { src: '/art/sword-of-love.jpg', title: 'The Sword of Love', description: 'The sword of love' },
  towelieWindow: { src: '/art/towelie-window.jpg', title: 'Window Watch', description: 'Peeking through' },
  chaosScene: { src: '/art/chaos-scene.jpg', title: 'Chaos', description: 'Pure chaos' },
  galleryCollage: { src: '/art/gallery-collage.jpg', title: 'The Collection', description: 'All pieces together' },
};

export const GALLERY_ORDER: ArtPiece[] = [
  ART.swordOfLove,
  ART.mfersHeaven,
  ART.mumuBull,
  ART.bobowelie,
  ART.jungleBus,
  ART.poolParty,
  ART.boxingRing,
  ART.busCrew,
  ART.forestScene,
  ART.towelieWindow,
  ART.chaosScene,
  ART.galleryCollage,
];
