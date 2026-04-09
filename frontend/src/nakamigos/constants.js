// ═══ MULTI-COLLECTION CONFIG ═══
export const COLLECTIONS = {
  nakamigos: {
    name: "Nakamigos",
    contract: "0xd774557b647330C91Bf44cfEAB205095f7E6c367",
    slug: "nakamigos",
    openseaSlug: "nakamigos",
    supply: 20000,
    mintBlock: 16893743, // March 2023 — post-merge
    metadataBase: "https://alchemy.mypinata.cloud/ipfs/QmaN1jRPtmzeqhp6s3mR1SRK4q1xWPvFvwqW1jyN6trir9",
    image: "/splash/skeleton.png",
    description: "20,000 unique crypto investors on the blockchain",
    tags: ["ERC-721", "ETHEREUM", "HIFO LABS"],
    pixelated: true,
    highlights: [
      { label: "Commercial Rights", color: "var(--gold)" },
      { label: "Gaming Rights", color: "var(--purple)" },
    ],
  },
  gnssart: {
    name: "GNSS Art",
    contract: "0xa1De9f93c56C290C48849B1393b09eB616D55dbb",
    slug: "gnssart",
    openseaSlug: "gnssart",
    supply: 9696, // On-chain totalSupply (token IDs go up to 9000+)
    mintBlock: 18400000, // Oct 2023 — post-merge
    metadataBase: null,
    image: "/collections/gnssart.jpg",
    description: "GNSS Art is a generative art collection by MGXS featuring algorithmically crafted 3D digital sculptures on the Ethereum blockchain. Each piece is uniquely generated through mathematical parameters including fractal geometry, warp cycles, and convergency algorithms.",
    tags: ["ERC-721", "ETHEREUM", "GENERATIVE ART", "MGXS"],
    pixelated: false,
    highlights: [
      { label: "Generative Art", color: "var(--gold)" },
    ],
  },
  junglebay: {
    name: "Jungle Bay Ape Club",
    contract: "0xd37264c71e9af940e49795F0d3a8336afAaFDdA9",
    slug: "junglebay",
    openseaSlug: "junglebay",
    supply: 5555, // On-chain totalSupply (reflects burns); fallback if API unavailable
    mintBlock: 14150000, // Feb 2022 — pre-merge (PoW era)
    metadataBase: null,
    image: "https://nft-cdn.alchemy.com/eth-mainnet/5da8fc69b3357b9bfe42717280e7c102",
    description: "Jungle Bay Ape Club is a collection of unique hand-drawn apes living on the Ethereum blockchain. Each ape is uniquely generated from over 120 traits across 9 categories, creating a vibrant community of digital primates.",
    tags: ["ERC-721", "ETHEREUM", "PFP", "COMMUNITY"],
    pixelated: false,
    highlights: [
      { label: "PFP Collection", color: "var(--gold)" },
      { label: "Hand-Drawn Art", color: "var(--naka-blue)" },
    ],
  },
};

export const DEFAULT_COLLECTION = "nakamigos";

// Legacy single-collection exports (used as defaults / backwards compat)
export const CONTRACT = COLLECTIONS.nakamigos.contract;
export const COLLECTION_SLUG = COLLECTIONS.nakamigos.slug;

// IPFS metadata base for Nakamigos
export const METADATA_BASE = COLLECTIONS.nakamigos.metadataBase;

export const SORT_OPTIONS = [
  { value: "tokenId", label: "Token ID: Low \u2192 High" },
  { value: "tokenId-desc", label: "Token ID: High \u2192 Low" },
  { value: "rarity", label: "Rarity: Rarest First" },
  { value: "price", label: "Price: High \u2192 Low" },
  { value: "price-asc", label: "Price: Low \u2192 High" },
];

// Chain configuration
const CHAIN_ID = 1; // Ethereum Mainnet

// Seaport / WETH addresses
export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const SEAPORT_ADDRESS = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC"; // Seaport v1.5

// Shared EIP-712 domain — use this everywhere for Seaport signing.
// Single source of truth prevents version mismatch bugs.
export const SEAPORT_DOMAIN = {
  name: "Seaport",
  version: "1.5",
  chainId: CHAIN_ID,
  verifyingContract: SEAPORT_ADDRESS,
};

// Shared EIP-712 types for Seaport OrderComponents
export const SEAPORT_ORDER_TYPES = {
  OrderComponents: [
    { name: "offerer", type: "address" },
    { name: "zone", type: "address" },
    { name: "offer", type: "OfferItem[]" },
    { name: "consideration", type: "ConsiderationItem[]" },
    { name: "orderType", type: "uint8" },
    { name: "startTime", type: "uint256" },
    { name: "endTime", type: "uint256" },
    { name: "zoneHash", type: "bytes32" },
    { name: "salt", type: "uint256" },
    { name: "conduitKey", type: "bytes32" },
    { name: "counter", type: "uint256" },
  ],
  OfferItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
  ],
  ConsiderationItem: [
    { name: "itemType", type: "uint8" },
    { name: "token", type: "address" },
    { name: "identifierOrCriteria", type: "uint256" },
    { name: "startAmount", type: "uint256" },
    { name: "endAmount", type: "uint256" },
    { name: "recipient", type: "address" },
  ],
};

// Seaport conduit (shared — was duplicated in 3 files)
export const CONDUIT_KEY = "0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000";
export const CONDUIT_ADDRESS = "0x1E0049783F008A0085193E00003D00cd54003c71";
export const OPENSEA_FEE_RECIPIENT = "0x0000a26b00c1F0DF003000390027140000fAa719";
export const OPENSEA_FEE_BPS = 100; // 1% — OS2 fee since Sep 2025 (was 2.5% pre-2025)

// Platform fee — 0.5% on all trades
export const PLATFORM_FEE_RECIPIENT = "0xE9B7aB8e367bE5AC0e0c865136f1907bd73df53e";
export const PLATFORM_FEE_BPS = 50; // 0.5%

export const OPENSEA_ITEM = (id, contract = CONTRACT) => `https://opensea.io/item/ethereum/${contract}/${id}`;
export const ETHERSCAN_TOKEN = (id, contract = CONTRACT) => `https://etherscan.io/nft/${contract}/${id}`;

export const FALLBACK_NFTS = [
  { id: "0", name: "Nakamigos #0", price: null, lastSale: null, rank: 8420, attributes: [{ key: "Type", value: "Human Pale" }, { key: "Mouth", value: "Smile" }, { key: "Hair", value: "Buzzcut" }, { key: "Shirt/Jacket", value: "Hoodie Orange" }] },
  { id: "1", name: "Nakamigos #1", price: null, lastSale: null, rank: 6230, attributes: [{ key: "Type", value: "Human Latte" }, { key: "Mouth", value: "Flat" }, { key: "Hair", value: "Mohawk" }, { key: "Shirt/Jacket", value: "Vest Black" }] },
  { id: "2", name: "Nakamigos #2", price: null, lastSale: null, rank: 12450, attributes: [{ key: "Type", value: "Human Tan" }, { key: "Mouth", value: "Smile" }, { key: "Hair", value: "Short" }, { key: "Shirt/Jacket", value: "Tee White" }] },
  { id: "3", name: "Nakamigos #3", price: null, lastSale: null, rank: 3752, attributes: [{ key: "Type", value: "Robot" }, { key: "Mouth", value: "LED" }, { key: "Hair", value: "Antenna" }, { key: "Shirt/Jacket", value: "Circuit Board" }] },
  { id: "4", name: "Nakamigos #4", price: null, lastSale: null, rank: 14965, attributes: [{ key: "Type", value: "Human Pale" }, { key: "Mouth", value: "Flat" }, { key: "Hair", value: "Dreads" }, { key: "Shirt/Jacket", value: "Hoodie Blue" }] },
  { id: "5", name: "Nakamigos #5", price: null, lastSale: null, rank: 4282, attributes: [{ key: "Type", value: "Zombie" }, { key: "Mouth", value: "Grin" }, { key: "Hair", value: "Messy" }, { key: "Shirt/Jacket", value: "Torn" }] },
  { id: "6", name: "Nakamigos #6", price: null, lastSale: null, rank: 9800, attributes: [{ key: "Type", value: "Human Tan" }, { key: "Mouth", value: "Smile" }, { key: "Hair", value: "Cap" }, { key: "Shirt/Jacket", value: "Polo" }] },
  { id: "7", name: "Nakamigos #7", price: null, lastSale: null, rank: 8558, attributes: [{ key: "Type", value: "Human Latte" }, { key: "Mouth", value: "Open" }, { key: "Hair", value: "Bald" }, { key: "Shirt/Jacket", value: "Suit" }] },
  { id: "8", name: "Nakamigos #8", price: null, lastSale: null, rank: 12945, attributes: [{ key: "Type", value: "Human Pale" }, { key: "Mouth", value: "Flat" }, { key: "Hair", value: "Long" }, { key: "Shirt/Jacket", value: "Flannel" }] },
  { id: "9", name: "Nakamigos #9", price: null, lastSale: null, rank: 6700, attributes: [{ key: "Type", value: "Ape" }, { key: "Mouth", value: "Grin" }, { key: "Hair", value: "None" }, { key: "Shirt/Jacket", value: "Chain" }] },
  { id: "10", name: "Nakamigos #10", price: null, lastSale: null, rank: 11015, attributes: [{ key: "Type", value: "Human Tan" }, { key: "Mouth", value: "Smile" }, { key: "Hair", value: "Afro" }, { key: "Shirt/Jacket", value: "Tee Black" }] },
  { id: "11", name: "Nakamigos #11", price: null, lastSale: null, rank: 19154, attributes: [{ key: "Type", value: "Human Pale" }, { key: "Mouth", value: "Flat" }, { key: "Hair", value: "Spiky" }, { key: "Shirt/Jacket", value: "Jacket Green" }] },
].map(n => ({ ...n, image: null }));

export const FALLBACK_STATS = {
  floor: 0.1048,
  volume: 52200,
  owners: 5238,
  supply: 20000,
};

export const FALLBACK_WHALES = [
  { addr: "0xd8dA...6045", ens: "vitalik.eth", held: 12, act: "Bought 3", time: "4m ago", d: "+3" },
  { addr: "0x1234...aBcD", ens: "franklinisbored.eth", held: 47, act: "Listed 2", time: "11m ago", d: "-2" },
  { addr: "0xBEEF...c0de", ens: "pranksy.eth", held: 89, act: "Swept 8", time: "23m ago", d: "+8" },
  { addr: "0xCAFE...bAbE", ens: "dingaling.eth", held: 156, act: "Transferred 5", time: "1h ago", d: "5" },
  { addr: "0xDEAD...F00D", ens: "punk6529.eth", held: 34, act: "Bid on #7762", time: "2h ago", d: "bid" },
];

export const FALLBACK_ACTIVITY = [
  { type: "sale", token: { id: "11007", name: "#11007" }, price: 0.11, from: "0xd5a1...c442", to: "0x8cFe...91ab", time: Date.now() - 120000, hash: null },
  { type: "sale", token: { id: "16630", name: "#16630" }, price: 0.1101, from: "0xBb22...c1a8", to: "0x13dF...e70b", time: Date.now() - 1860000, hash: null },
  { type: "sale", token: { id: "3183", name: "#3183" }, price: 0.1123, from: "0xfC12...d8e3", to: "0x55Ab...19c0", time: Date.now() - 5400000, hash: null },
  { type: "sale", token: { id: "2894", name: "#2894" }, price: 0.1099, from: "0x8812...eF03", to: "0xBb22...c1a8", time: Date.now() - 9000000, hash: null },
];

// ═══ COLLECTION LORE ═══

export const COLLECTION_LORE = {
  nakamigos: {
    tagline: "Nakamoto + Amigos = Friends of Nakamoto",
    origin: "Created by HiFo Labs and artist Michael Mills (@MillsxArt), one of the first 20 artists on SuperRare. Contract deployed October 31, 2022 — Bitcoin whitepaper anniversary. Surpassed BAYC in lifetime trades within 4 days of mint.",
    creator: {
      name: "HiFo Labs",
      artist: "Michael Mills (@MillsxArt)",
      smartContract: "WestCoastNFT",
      anonymous: true,
    },
    dates: {
      contractDeployed: "2022-10-31",
      earlyAccess: "2023-03-22",
      publicMint: "2023-03-23",
    },
    community: {
      discord: null, // initially no Discord — radical minimalism
      twitter: "https://twitter.com/Nakamigos",
      website: "https://nakamigo.ai",
      governance: null,
    },
    ecosystem: [
      { name: "CLOAKS", supply: 20000, chain: "Ethereum", description: "Gaming characters with worldwide gaming rights. Free claim for Nakamigos holders." },
      { name: "Crypto Trading Cards 1880-1979", supply: 837, chain: "Ethereum", description: "AI-generated historical crypto trading cards." },
      { name: "Hal Froggy Bobbleheads", supply: 1621, chain: "Ethereum", description: "Tribute to Bitcoin pioneer Hal Finney." },
      { name: "Fukuhedrons", supply: 10000, chain: "Bitcoin", description: "Bitcoin Ordinals collection." },
      { name: "Cypherpunk Files", supply: null, chain: "Ethereum", description: "Lore series exploring the question: Who is Satoshi Nakamoto?" },
    ],
  },
  gnssart: {
    tagline: "Generative Nature Synthetic Species — recreating Nature from a different timeline",
    origin: "Created by Fernando Magalhaes (MGXS), a Brazilian artist based in Portugal who collaborated with RTFKT/Nike. Generated 20,000 beings, manually curated to 13,333 over 6 months, then holders chose from up to 10 options per seed, yielding ~9,697 unique beings.",
    creator: {
      name: "MGXS Studio",
      artist: "Fernando Magalhaes (MGXS)",
      smartContract: null,
      anonymous: false,
    },
    dates: {
      seedRelease: "2022-03-11",
      seedRevealEnd: "2022-05-17",
      memsLaunch: "2023-10-01",
    },
    community: {
      discord: null,
      twitter: "https://twitter.com/mgxs_gnss",
      website: "https://mgxs.co",
      governance: null,
    },
    ecosystem: [
      { name: "Machine Embedded Memories (MEMs)", supply: 9000, chain: "Off-chain", description: "AI-generated memories for GNSS beings based on unique metadata. Travel with the NFT on transfer." },
      { name: "MEM Seals", supply: null, chain: "Ethereum", description: "ERC-1155 tokens that can be burned to unlock additional MEMs per GNSS being." },
      { name: "Tree of MEM", supply: null, chain: "Off-chain", description: "Expanding collage canvas at tree.mgxs.co displaying all created MEMs." },
      { name: "P0RT_TR41Ts", supply: null, chain: "Physical", description: "Physical digital frames shipped to holders featuring their GNSS artwork." },
    ],
  },
  junglebay: {
    tagline: "Power to the People",
    origin: "Born from the LBAC (Lil Baby Ape Club) rug pull. The community refused to quit, self-organized into a DAO, funded a treasury from their own contributions, and commissioned entirely new art. The OG Lord of the Flies web3 origin story.",
    creator: {
      name: "Jungle Bay Artists Collective",
      artist: "Community artist collective",
      smartContract: null,
      anonymous: false,
    },
    dates: {
      rugPullExposed: "2021-11-16",
      contractCreated: "2022-01-06",
      mintCompleted: "2022-01-28",
    },
    community: {
      discord: null,
      twitter: "https://twitter.com/JungleBayAC",
      website: "https://junglebayisland.com",
      governance: "https://collective.xyz/junglebayapeclub",
    },
    ecosystem: [
      { name: "Meme Cards", supply: null, chain: "Ethereum", description: "Collab with mfers artists featuring dark authentic artwork with burn mechanics." },
      { name: "Seeds from the Memetic Garden", supply: 369, chain: "Base", description: "Tribute rooted in mfers ethos." },
      { name: "Bojungles", supply: 250, chain: "Base", description: "Honoring $BOBO." },
      { name: "Junglets", supply: 208, chain: "Solana", description: "Hand-painted Brainlet Apes by core team artist @rodritoh89." },
      { name: "The Sandbox Land", supply: 1, chain: "Ethereum", description: "Jungle Bay Island at coordinates (14, -69)." },
      { name: "Otherside Land", supply: 1, chain: "Ethereum", description: "Land in Yuga Labs metaverse acquired with community treasury." },
    ],
  },
};

// ═══ CHARACTER / SPECIES TYPE DATA ═══

export const CHARACTER_TYPES = [
  // Human types
  { name: "Latte", count: 7790, percentage: 38.95, description: "The most common human skin tone, warm and approachable.", isHuman: true },
  { name: "Boba", count: 4250, percentage: 21.25, description: "A rich, deep skin tone named after the beloved tea drink.", isHuman: true },
  { name: "Pumpkin Spice", count: 2562, percentage: 12.81, description: "Warm autumnal tones with a seasonal flair.", isHuman: true },
  { name: "Mocha", count: 1286, percentage: 6.43, description: "Deep, dark coffee tones. Less common than Latte and Boba.", isHuman: true },
  { name: "Coffee", count: 1076, percentage: 5.38, description: "The darkest of the coffee-themed skin tones.", isHuman: true },
  { name: "Invisible", count: 832, percentage: 4.16, description: "Transparent body revealing only clothing and accessories.", isHuman: true },
  // Non-human types
  { name: "Frog", count: 868, percentage: 4.34, description: "Amphibian characters. A nod to Pepe and crypto culture.", isHuman: false },
  { name: "Bot", count: 551, percentage: 2.76, description: "Robotic characters with mechanical features and LED displays.", isHuman: false },
  { name: "Crocodile", count: 495, percentage: 2.48, description: "Reptilian investors with scaly green skin.", isHuman: false },
  { name: "Snowman", count: 245, percentage: 1.23, description: "Frosty characters — rare and distinctive.", isHuman: false },
  { name: "Balloon", count: 36, percentage: 0.18, description: "Extremely rare inflatable characters. Only 36 in existence.", isHuman: false },
  { name: "Ghost", count: 9, percentage: 0.045, description: "The rarest type. Only 9 exist — one acquired by billionaire Adam Weitsman for ~16 ETH.", isHuman: false },
];

export const GNSS_SPECIES = [
  { name: "Eom", letter: "E", supply: 77, subspecies: [], visualDescription: "Red glows, iron metal, always asymmetric.", rarityTier: "legendary" },
  { name: "UOM", letter: "U", supply: 101, subspecies: [], visualDescription: "Flowing ribbons, twins with different palettes.", rarityTier: "legendary" },
  { name: "Fnix", letter: "F", supply: 140, subspecies: [], visualDescription: "Pure forms only, no subspecies variations.", rarityTier: "rare" },
  { name: "AKX", letter: "A", supply: 149, subspecies: [], visualDescription: "Always symmetric, 2 purple lights near eyes.", rarityTier: "rare" },
  { name: "Mar", letter: "M", supply: 170, subspecies: [], visualDescription: "Mid-rare species with distinctive silhouettes.", rarityTier: "rare" },
  { name: "Pqst", letter: "P", supply: 173, subspecies: [], visualDescription: "Complex procedural forms.", rarityTier: "rare" },
  { name: "Harp", letter: "H", supply: 177, subspecies: [], visualDescription: "Flowing, musical forms.", rarityTier: "rare" },
  { name: "Rio", letter: "R", supply: 184, subspecies: [], visualDescription: "Fluid, river-like formations.", rarityTier: "rare" },
  { name: "Koi", letter: "K", supply: 214, subspecies: [], visualDescription: "Aquatic-inspired digital sculptures.", rarityTier: "uncommon" },
  { name: "Inx", letter: "I", supply: 232, subspecies: [], visualDescription: "Always gold metal — distinguishes from Eom's iron.", rarityTier: "uncommon" },
  { name: "Oco", letter: "O", supply: 237, subspecies: [], visualDescription: "Organic, rounded forms.", rarityTier: "uncommon" },
  { name: "VOS", letter: "V", supply: 271, subspecies: ["V", "VA"], visualDescription: "Pure V is symmetric; VA variant is asymmetric.", rarityTier: "uncommon" },
  { name: "WOX", letter: "W", supply: 323, subspecies: [], visualDescription: "Angular, crystalline structures.", rarityTier: "common" },
  { name: "Baron", letter: "B", supply: 351, subspecies: ["AX", "Bess"], visualDescription: "Solid B features a purple halo effect.", rarityTier: "common" },
  { name: "Cipr", letter: "C", supply: null, subspecies: [], visualDescription: "Cipher-like algorithmic forms.", rarityTier: "common" },
  { name: "Duqe", letter: "D", supply: null, subspecies: [], visualDescription: "Regal, structured compositions.", rarityTier: "common" },
  { name: "Genj", letter: "G", supply: null, subspecies: [], visualDescription: "Generative organic shapes.", rarityTier: "common" },
  { name: "Naion", letter: "N", supply: null, subspecies: [], visualDescription: "Nation-like formations.", rarityTier: "common" },
  { name: "Que", letter: "Q", supply: null, subspecies: [], visualDescription: "Questioning, open-ended forms.", rarityTier: "common" },
  { name: "Soco", letter: "S", supply: null, subspecies: [], visualDescription: "Social, interconnected structures.", rarityTier: "common" },
  { name: "Xomodo", letter: "X", supply: 1260, subspecies: ["AX", "Bess", "Caos", "Duum", "Edo", "Fuuz", "X"], visualDescription: "Golden Dragons. 7 subspecies — most of any species (~13% of collection).", rarityTier: "common" },
  { name: "Yami", letter: "Y", supply: null, subspecies: [], visualDescription: "Dark, shadow-inspired beings.", rarityTier: "common" },
  { name: "Zuur", letter: "Z", supply: null, subspecies: [], visualDescription: "Acidic, sharp-edged forms.", rarityTier: "common" },
];

export const JB_LEGENDARIES = [
  { name: "The One Ape", tokenId: null, description: "The singular leader of the Jungle Bay." },
  { name: "Cake Ape", tokenId: null, description: "A sweet, celebratory legendary." },
  { name: "Kumo Ape", tokenId: null, description: "Cloud-inspired, ethereal legendary." },
  { name: "Skull Ape", tokenId: null, description: "Dark skeletal legendary with gothic aesthetics." },
  { name: "Slime Ape", tokenId: null, description: "Oozing, toxic green legendary." },
  { name: "Medusa Ape", tokenId: null, description: "Snake-haired mythological legendary." },
  { name: "Thanos Ape", tokenId: null, description: "Purple-skinned titan legendary." },
  { name: "Wolverine Ape", tokenId: null, description: "Clawed berserker legendary." },
  { name: "Sketch Ape", tokenId: null, description: "Hand-drawn pencil-sketch style legendary." },
  { name: "Groot Ape", tokenId: null, description: "Tree-like nature legendary." },
  { name: "Saiyan Ape", tokenId: null, description: "Super-powered anime-inspired legendary." },
  { name: "Pepe Ape", tokenId: null, description: "Iconic meme culture legendary." },
  { name: "Dr. Apehattan", tokenId: null, description: "Glowing blue omnipotent legendary." },
  { name: "Super Ape", tokenId: null, description: "Caped superhero legendary." },
  { name: "Tiger Ape", tokenId: null, description: "Striped feline legendary." },
  { name: "Mummy Ape", tokenId: null, description: "Bandaged ancient Egyptian legendary." },
  { name: "Alien Ape", tokenId: null, description: "Extraterrestrial green legendary." },
  { name: "Joker Ape", tokenId: null, description: "Chaotic trickster legendary." },
  { name: "Ghost Ape", tokenId: null, description: "Translucent spectral legendary." },
  { name: "Devil Ape", tokenId: null, description: "Horned infernal legendary." },
];

// ═══ TRAIT LORE ═══

export const TRAIT_LORE = {
  nakamigos: {
    categories: {
      "Hat/Helmet": "35 variants from casual caps to rare helmets. Headwear defines the investor persona.",
      "Shirt/Jacket": "81 variants — the largest trait category. Ranges from hoodies to suits, reflecting crypto culture.",
      "Hair": "13 styles including Buzzcut, Mohawk, Dreads, Afro, and Bald.",
      "Glasses": "7 styles. Eye accessories that modify the character's vibe.",
      "Headband": "7 variants. Sporty and functional headwear.",
      "Headphones": "5 styles. Audio gear for the always-online investor.",
      "Facial Hair": "3 options. Beards and mustaches for the distinguished trader.",
      "Mouth": "3 expressions: Smile, Flat, and specialized variants per type.",
      "Tie": "3 variants. Formal neckwear for the corporate crypto crowd.",
    },
    rareCombos: [
      { name: "Gold Mouth + Gold Medallion", count: 4, description: "The rarest known trait combination — only 4 exist across the entire collection." },
      { name: "Ninja Midnight", count: 319, description: "Community-discovered ninja subtype with dark coloring." },
      { name: "Ninja Snow", count: 90, description: "Community-discovered white ninja subtype." },
      { name: "Ninja Crimson", count: 16, description: "Community-discovered red ninja subtype — extremely rare." },
    ],
  },
  gnssart: {
    alignmentColors: {
      XEN: { color: "Purple", description: "Confirmed purple alignment glow." },
      RADI: { color: "Unknown", description: "Radiant alignment — color unconfirmed by artist." },
      LIT: { color: "Unknown", description: "Lit alignment — color unconfirmed by artist." },
      SILI: { color: "Unknown", description: "Silicate alignment — color unconfirmed by artist." },
      MAGN: { color: "Unknown", description: "Magnetic alignment — color unconfirmed by artist." },
      NIO: { color: "Unknown", description: "Nio alignment — color unconfirmed by artist." },
      CHROM: { color: "Unknown", description: "Chromatic alignment — color unconfirmed by artist." },
      PROTAC: { color: "Unknown", description: "Protactic alignment — color unconfirmed by artist." },
    },
    atomicNumbers: {
      26: { element: "Iron", description: "Dark metallic appearance. Characteristic of Eom species." },
      70: { element: "Ytterbium", description: "Silvery-gold metallic sheen. Found on Inx and other species." },
    },
    traitParams: {
      "Glass Amount": "Range 0.0-0.7 across 5 discrete values. Higher values produce more crystalline, translucent forms.",
      "Metal Fission": "Range 0.0-1.0. Controls fragmented metallic texture density.",
      "Stable Ratio": "1.0 in 69% of the collection — low values are rare and produce dynamic, unstable forms.",
      "Warp Cycles": "Values: 1, 4, 5, 6, 7, 8. Skips 2-3, creating a dramatic jump from minimal to moderate distortion.",
      "Symmetry": "Three modes: Yes (bilateral), No (asymmetric), Reverse (mirrored flip of bilateral).",
      "Convergency Amount": "Controls how tightly forms converge toward a central point.",
      "Fractal Bend": "Degree of fractal curvature applied to the sculpture's geometry.",
      "Frizz": "Surface noise and texture irregularity.",
    },
  },
  junglebay: {
    rarestTraits: [
      { trait: "Gold Card", category: "Mouth", count: 5, percentage: 0.09 },
      { trait: "Blue Beams", category: "Eyes", count: 6, percentage: 0.11 },
      { trait: "Gold Suit", category: "Clothes", count: 12, percentage: 0.22 },
      { trait: "Diamond Grill", category: "Mouth", count: 14, percentage: 0.25 },
      { trait: "Red Lasers", category: "Eyes", count: 17, percentage: 0.31 },
      { trait: "King's Crown", category: "Hats", count: 18, percentage: 0.32 },
      { trait: "Black Suit", category: "Clothes", count: 19, percentage: 0.34 },
      { trait: "Diamond", category: "Skins", count: 21, percentage: 0.38 },
      { trait: "Gold", category: "Skins", count: 24, percentage: 0.43 },
    ],
    skinTiers: {
      ultraRare: ["Diamond", "Gold"],
      rare: ["Deep Space", "Trippy", "Noise"],
      uncommon: ["Giraffe", "Zebra", "Leopard", "Cheetah"],
      common: "Solid color skins form the base tier.",
    },
  },
};

// ═══ LOADING MESSAGES ═══

export const LOADING_MESSAGES = {
  nakamigos: [
    "Assembling your Nakamigos...",
    "Checking wallets across the metaverse...",
    "24x24 pixels of pure alpha...",
    "Scanning for Ghost sightings (only 9 exist)...",
    "Brewing coffee-themed skin tones...",
    "Friends of Nakamoto reporting in...",
    "Surpassed BAYC in 4 days. Loading that energy...",
  ],
  gnssart: [
    "Generating synthetic species...",
    "Calibrating fractal geometry...",
    "Aligning warp cycles...",
    "Curating from 20,000 to perfection...",
    "Rendering Houdini sculptures...",
    "Searching for Eom sightings (only 77 exist)...",
    "Reconstructing nature from a different timeline...",
  ],
  junglebay: [
    "Swinging through the jungle canopy...",
    "Power to the People. Loading...",
    "Assembling the Artists Collective...",
    "Survived a rug pull. Loading is nothing...",
    "Checking Diamond and Gold skins...",
    "Only 0.98% listed. True diamond hands...",
    "From rug pull to DAO in 7 weeks...",
  ],
};

// ═══ FUN FACTS ═══

export const FUN_FACTS = {
  nakamigos: [
    "Nakamigos contract was deployed on October 31 — the anniversary of the Bitcoin whitepaper.",
    "The name combines 'Nakamoto' and 'Amigos' — Friends of Nakamoto.",
    "Only 9 Ghost Nakamigos exist, making them the rarest character type at 0.045%.",
    "Nakamigos surpassed BAYC in lifetime trades within just 4 days of minting.",
    "The Gold Mouth + Gold Medallion combo exists on only 4 Nakamigos.",
    "Artist Michael Mills was one of the first 20 artists on SuperRare.",
    "HiFo Labs famously said: 'Not Larva. Not Yuga. Nakamigos.'",
    "The community self-organized a Discord because HiFo Labs intentionally launched without one.",
    "Community-discovered Ninja subtypes: Midnight (319), Snow (90), Crimson (16).",
    "Billionaire Adam Weitsman acquired Ghost #3648 for approximately 16 ETH.",
    "Smart contract was built by WestCoastNFT, who also built the Doodles and mfers contracts.",
    "Only 36 Balloon characters exist — the second rarest type after Ghost.",
  ],
  gnssart: [
    "GNSS stands for Generative Nature Synthetic Species.",
    "MGXS curated 20,000 generated beings down to 13,333 over 6 months by hand.",
    "Eom is the rarest species with only 77 beings — always asymmetric with red glows.",
    "MGXS created the first physical Nike sneakers for RTFKT, selling one for 22 ETH.",
    "Three species (J, L, T) were eliminated for not meeting MGXS's curatorial standards.",
    "The seed reveal featured 24/7 Discord voice chat for 2 months straight.",
    "Xomodo ('Golden Dragons') make up ~13% of the collection with 7 subspecies.",
    "Only 3.6% of GNSS are listed for sale — one of the lowest list rates in NFTs.",
    "Machine Embedded Memories (MEMs) are AI-generated and travel with the NFT when sold.",
    "All GNSS art is created using SideFX Houdini, a professional 3D procedural software.",
    "MGXS's URUCU series bridges Japanese samurai and Brazilian indigenous culture.",
    "29 'A-void' beings exist as placeholders from holders who never completed their selection.",
  ],
  junglebay: [
    "Jungle Bay was born from the LBAC rug pull — the community rebuilt from scratch in 7 weeks.",
    "Only 0.98% of Jungle Bay NFTs are listed — one of the lowest list rates in all of NFTs.",
    "The Gold Card mouth trait exists on only 5 apes — the rarest standard trait at 0.09%.",
    "Jungle Bay owns land in both The Sandbox and Otherside metaverses.",
    "The community rebranded to 'Jungle Bay Artists Collective' but kept the JBAC acronym.",
    "20 legendary 1/1 apes exist, including Pepe Ape, Thanos Ape, and Dr. Apehattan.",
    "Roh (0xRoh), a 25-year-old Canadian, exposed the original LBAC fraud.",
    "NFTs are customizable — holders can replace, remove, or add accessories.",
    "The Jungle Bay community formula: J=m(f)^3*r+s.",
    "Their $JBM memecoin on Base was born from an accidental BANKR bot glitch.",
    "The collection spans 3 chains: Ethereum, Base, and Solana.",
    "Jungle Bay survived a 95.8% drawdown from ATH with the community still active.",
  ],
};
