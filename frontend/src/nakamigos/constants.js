import { TEGRIDY_NFT_LENDING_ADDRESS, isDeployed } from "../lib/constants";

// CREDIBILITY GATING (same rule as lib/navConfig.ts): loan-desk CTAs render
// only once the relaunch TegridyNFTLending address lands in lib/constants.ts.
// A borrow button that dead-ends in "Contract Not Deployed" costs more trust
// than the funnel earns, so the CTAs light up on deploy with no code change.
export const NFT_LOAN_DESK_LIVE = isDeployed(TEGRIDY_NFT_LENDING_ADDRESS);

// ═══ RANK TIER (F809) ═══
// Single source of truth for rarity-rank thresholds. Three surfaces previously
// disagreed: Modal flagged the top 25%, ShareCard used gold≤0.5%/blue≤2.5%, and
// TheaterMode treated any ranked token as notable. This converges the THRESHOLD
// logic on ShareCard's scale (the most considered), so a token reads the same
// tier everywhere. Each surface keeps its own visual treatment; this only tells
// it which tier a rank falls in. Returns "gold" | "blue" | "plain" | null.
export const RANK_TIER_GOLD_PCT = 0.005; // top 0.5%
export const RANK_TIER_BLUE_PCT = 0.025; // top 2.5%
export function rankTier(rank, supply) {
  const r = Number(rank);
  const s = Number(supply);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(s) || s <= 0) return null;
  if (r <= Math.ceil(s * RANK_TIER_GOLD_PCT)) return "gold";
  if (r <= Math.ceil(s * RANK_TIER_BLUE_PCT)) return "blue";
  return "plain";
}

// ═══ MULTI-COLLECTION CONFIG ═══
// Every entry names its chain, standard and home market. venueTrade is true
// only for an Ethereum ERC-721 (registry.test.js pins it), and lib/venue.js
// canTradeOnVenue is the one rule money paths and surfaces read. This file
// stays data only: it never imports lib/venue.js.
export const COLLECTIONS = {
  nakamigos: {
    name: "Nakamigos",
    contract: "0xd774557b647330C91Bf44cfEAB205095f7E6c367",
    slug: "nakamigos",
    openseaSlug: "nakamigos",
    chain: "ethereum",
    standard: "erc721",
    venueTrade: true,
    chip: "NAKA",
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/nakamigos",
      itemUrlTemplate: "https://opensea.io/item/ethereum/0xd774557b647330c91bf44cfeab205095f7e6c367/{id}",
    },
    explorer: { name: "Etherscan", addressUrl: "https://etherscan.io/address/0xd774557b647330C91Bf44cfEAB205095f7E6c367" },
    blurSlug: "nakamigos",
    supply: 20000,
    mintBlock: 16893743, // March 2023 — post-merge
    metadataBase: "https://alchemy.mypinata.cloud/ipfs/QmaN1jRPtmzeqhp6s3mR1SRK4q1xWPvFvwqW1jyN6trir9",
    // metadataBase points at per-token IPFS CIDs (JSON), NOT numbered PNGs, so
    // `${metadataBase}/<id>.png` 404s for Nakamigos (gnss/junglebay DO serve
    // per-id PNGs). Don't emit that dead fallback — let batch enrichment fill it.
    deterministicImage: false,
    image: "/splash/skeleton.jpg",
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
    chain: "ethereum",
    standard: "erc721",
    venueTrade: true,
    chip: "GNSS",
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/gnssart",
      itemUrlTemplate: "https://opensea.io/item/ethereum/0xa1de9f93c56c290c48849b1393b09eb616d55dbb/{id}",
    },
    explorer: { name: "Etherscan", addressUrl: "https://etherscan.io/address/0xa1De9f93c56C290C48849B1393b09eB616D55dbb" },
    blurSlug: "gnssart",
    supply: 9696, // On-chain totalSupply (token IDs go up to 9000+)
    mintBlock: 18400000, // Oct 2023 — post-merge
    metadataBase: "https://assets.mgxs.co",
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
    chain: "ethereum",
    standard: "erc721",
    venueTrade: true,
    chip: "JBAC",
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/junglebay",
      itemUrlTemplate: "https://opensea.io/item/ethereum/0xd37264c71e9af940e49795f0d3a8336afaafdda9/{id}",
    },
    explorer: { name: "Etherscan", addressUrl: "https://etherscan.io/address/0xd37264c71e9af940e49795F0d3a8336afAaFDdA9" },
    blurSlug: "junglebay",
    supply: 5555, // On-chain totalSupply (reflects burns); fallback if API unavailable
    mintBlock: 14150000, // Feb 2022 — pre-merge (PoW era)
    metadataBase: "https://ipfs.io/ipfs/QmaTrk9RrN3yhwyB1EbRFrxBEEtcbBaGs2NppJGn262Bid",
    image: "https://nft-cdn.alchemy.com/eth-mainnet/5da8fc69b3357b9bfe42717280e7c102",
    description: "Jungle Bay Ape Club is a collection of unique hand-drawn apes living on the Ethereum blockchain. Each ape is uniquely generated from over 120 traits across 9 categories, creating a vibrant community of digital primates.",
    tags: ["ERC-721", "ETHEREUM", "PFP", "COMMUNITY"],
    pixelated: false,
    highlights: [
      { label: "PFP Collection", color: "var(--gold)" },
      { label: "Hand-Drawn Art", color: "var(--naka-blue)" },
    ],
  },

  // ─── The Jungle Bay family (memetics.wtf/heat: "the family collections") ───
  // Every value below was READ: an eth_call on Ethereum or Base, a Solana
  // metadata read, the collection's own OpenSea page or the Magic Eden API
  // (registry.test.js holds each one to __fixtures__/jungleBayFamily.js).
  // No lore, loading lines or fun facts exist for them, by design. Only Gold
  // Cards trades here; the other five open read only on their home market.
  junglebaygoldcards: {
    name: "Jungle Bay Gold Cards",
    contract: "0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3", // src/lib/constants.ts JBAY_GOLD_ADDRESS
    slug: "junglebaygoldcards", // equals openseaSlug: money paths read OpenSea by either name
    openseaSlug: "junglebaygoldcards",
    chain: "ethereum",
    standard: "erc721",
    venueTrade: true,
    chip: "GOLD",
    symbol: "JBAY",
    supply: 123,
    tokenIds: { first: 1 }, // ids 1..123; ownerOf(0) and ownerOf(124) revert
    supplyNote: "totalSupply() on Ethereum at block 26041301 (ids 1 to 123). maxSupply() is 150.",
    mintBlock: 13781371,
    deploy: { block: 13781371, date: "2021-12-11" },
    metadataBase: null, // every token shares one S3 image; there are no per-id PNGs
    deterministicImage: false,
    image: "https://i2c.seadn.io/ethereum/a83577bfb307408682cd44520d1c00d4/899e287b319c9faf45c57e2626c8a1/21899e287b319c9faf45c57e2626c8a1.png",
    // The first paragraph of its OpenSea description only. The rest lists holder
    // benefits, one of them a 1.5x $JBAC multiplier the venue's staking does not honour.
    description: "Gold Cards began as representation of those who invested in JungleBay when the project first emerged from the ashes of a rug. They are now held by the people who believe in the ethos of JungleBay and want to participate to the development of JungleBay island, as well as the governance of its ecosystem.",
    descriptionSource: "opensea",
    tags: ["ERC-721", "ETHEREUM", "JUNGLE BAY"],
    pixelated: false,
    highlights: [],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/junglebaygoldcards",
      itemUrlTemplate: "https://opensea.io/item/ethereum/0x6aa03f42c5366e2664c887eb2e90844ca00b92f3/{id}",
    },
    explorer: { name: "Etherscan", addressUrl: "https://etherscan.io/address/0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3" },
    blurSlug: null, // no Blur page was verified
  },
  junglebaymemes: {
    name: "the memes by jungle bay x mfers artists",
    contract: "0x9EdABa801123866F25993914E389924744a07E89",
    slug: "junglebaymemes",
    openseaSlug: "the-memes-by-junglebay-x-mfers-artists",
    chain: "ethereum",
    standard: "erc1155",
    venueTrade: false,
    symbol: "JBMFERS",
    supply: null, // an ERC-1155 has no single supply; see editions
    editions: { tokenIds: 22, total: 975, asOfBlock: 26041365 },
    supplyNote: "22 token ids (1 to 22) holding 975 editions, totalSupply(id) on Ethereum at block 26041365. The creator contract can add more.",
    mintBlock: null,
    deploy: { block: 16531491, date: "2023-02-01" },
    metadataBase: null,
    deterministicImage: false,
    image: "https://i2c.seadn.io/ethereum/c2b8bd39b58546c7b9b4cd57ec000427/e70a60faad9893ac590a8a93ee9d20/1ae70a60faad9893ac590a8a93ee9d20.png",
    description:
      "About ‘the memes by jungle bay x mfers artists':\n\n\n"
      + "Holding a card from this collection is supporting a different artist who stayed during the bear market solely for the art and the culture. They created, with no guaranteed fruitful path forward, and put the community on their backs by seizing the memes of production. They have kept us laughing, inspired, and hopeful throughout the painful and mind-bendingly arduous tests we have collectively endured in this space this past “winter”.\n\n"
      + "Jungle Bay Island is where the dank memes go to recharge. \n\n"
      + "The magic is in the memes, and we dive into them alongside like-minded degens who are crazy enough to still be here, and strong enough to survive.\n\n"
      + "Jungle Bay Genesis Collection: https://opensea.io/collection/junglebay",
    descriptionSource: "opensea",
    tags: ["ERC-1155", "ETHEREUM", "JUNGLE BAY"],
    pixelated: false,
    highlights: [],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/the-memes-by-junglebay-x-mfers-artists",
      itemUrlTemplate: "https://opensea.io/item/ethereum/0x9edaba801123866f25993914e389924744a07e89/{id}",
    },
    explorer: { name: "Etherscan", addressUrl: "https://etherscan.io/address/0x9EdABa801123866F25993914E389924744a07E89" },
    blurSlug: null,
  },
  memeticseeds: {
    name: "Seeds from the Memetic Garden",
    // The ERC-721 clone. The other address on its OpenSea page is an item owner.
    contract: "0xb34bB1d81A4e5F9DcA7360C3043ad50db2ea87F3",
    slug: "memeticseeds",
    openseaSlug: "seeds-from-the-memetic-garden",
    chain: "base",
    standard: "erc721",
    venueTrade: false,
    symbol: "SFTMG",
    supply: 369,
    burnedIds: [88], // held by 0x...dEaD: it cannot be bought
    supplyNote: "totalSupply() on Base at block 51695380 (ids 0 to 368). Token #88 is held by the burn address, so OpenSea lists 368.",
    mintBlock: null,
    deploy: { block: 32896090, date: "2025-07-15" },
    metadataBase: null,
    deterministicImage: false,
    image: "https://i2c.seadn.io/base/5e9fe098b5ce43d4bc0693febb0106f6/d270b900f8b40fc5bbc31834b38934/9dd270b900f8b40fc5bbc31834b38934.png",
    // OpenSea's text with one typographic change: each em dash is set as " - ".
    description:
      "Seeds from the Memetic Garden is a collection of 1/1s from ~40 artists - each contributing their own visual language to a tribute rooted in the ethos mfers helped unlock.\n\n"
      + "“you can state a roadmap that says where you will go, but you can also plant seeds and see where they grow.” - Sartoshi\n"
      + "That spirit lives here. Not through imitation, but through intent.\n"
      + "Each piece was created independently, but released together - unified by respect, not rules.\n"
      + "Formed on Jungle Bay Island, a metaphorical space where memes evolve without instruction, the collection adds new layers to a lineage that never asked for permission.\n\n"
      + "This isn’t about looking back. It’s about continuing the conditions that let culture grow.",
    descriptionSource: "opensea",
    tags: ["ERC-721", "BASE", "JUNGLE BAY"],
    pixelated: false,
    highlights: [],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/seeds-from-the-memetic-garden",
      itemUrlTemplate: "https://opensea.io/item/base/0xb34bb1d81a4e5f9dca7360c3043ad50db2ea87f3/{id}",
    },
    explorer: { name: "Basescan", addressUrl: "https://basescan.org/address/0xb34bB1d81A4e5F9DcA7360C3043ad50db2ea87F3" },
    blurSlug: null,
  },
  junglets: {
    name: "Junglets",
    // Strictly null, never undefined: undefined would fall through to the
    // Nakamigos CONTRACT default parameter of the api.js readers.
    contract: null,
    slug: "junglets",
    openseaSlug: null, // OpenSea has no Junglets page
    magicEdenSymbol: "junglet",
    solana: {
      collectionMint: "5csQYUGtJzUveFCKGRrnVCNZrPpkSAEZCZEsu9nBHuuK",
      updateAuthority: "3zoVsecguqdcLcTBaSjNQyAyYLLLt1tn93agbKBJ9vSw",
      firstCreator: "HqV6jua4x3V527W1JgsNQJ8G8nWPtF1igVm7ReY3avap",
    },
    chain: "solana",
    standard: "spl",
    venueTrade: false,
    symbol: "JGLETS",
    supply: 208,
    supplyNote: "208 Metaplex metadata accounts verified into collection 5csQ...uuK (Junglet #1 to #208), read from Solana mainnet.",
    mintBlock: null,
    deploy: null,
    metadataBase: null,
    deterministicImage: false,
    image: "https://wsrv.nl/?url=https%3A%2F%2Fna-assets.pinit.io%2F3zoVsecguqdcLcTBaSjNQyAyYLLLt1tn93agbKBJ9vSw%2Fb69c398c-8a8f-4b56-8f82-fdb0b1d3a16e%2F0&w=400&output=webp",
    description: "A love letter to $BRAINLET from jungle bay island\u{1F334}",
    descriptionSource: "onchain", // the collection NFT's on-chain metadata JSON
    tags: ["METAPLEX PNFT", "SOLANA", "JUNGLE BAY"],
    pixelated: false,
    highlights: [],
    market: {
      name: "Magic Eden",
      collectionUrl: "https://magiceden.us/marketplace/junglet",
      itemUrlTemplate: null, // no item page pattern was verified
    },
    explorer: { name: "Solana Explorer", addressUrl: "https://explorer.solana.com/address/5csQYUGtJzUveFCKGRrnVCNZrPpkSAEZCZEsu9nBHuuK" },
    blurSlug: null,
  },
  bojungles: {
    name: "Bojungles",
    contract: "0x36aFeE4FaDC3b77Ff5f1f9a040E264150aFb979A",
    slug: "bojungles",
    openseaSlug: "bojungless", // double s, as OpenSea spells it
    chain: "base",
    standard: "erc721",
    venueTrade: false,
    symbol: "BOJUNG",
    supply: 250,
    supplyNote: "totalSupply() on Base at block 51695371 is 250 (ids 0 to 249).",
    mintBlock: null,
    deploy: { block: 23975123, date: "2024-12-21" },
    metadataBase: null,
    deterministicImage: false,
    image: "https://i2c.seadn.io/collection/bojungless/image/8adbd4b81493e3f7de25ca395e66a1/b18adbd4b81493e3f7de25ca395e66a1.png",
    description: "An homage to the powerful $BOBO, from Jungle Bay Island. \u{1F334}\u{1F9F1}",
    descriptionSource: "opensea",
    tags: ["ERC-721", "BASE", "JUNGLE BAY"],
    pixelated: false,
    highlights: [],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/bojungless",
      itemUrlTemplate: "https://opensea.io/item/base/0x36afee4fadc3b77ff5f1f9a040e264150afb979a/{id}",
    },
    explorer: { name: "Basescan", addressUrl: "https://basescan.org/address/0x36aFeE4FaDC3b77Ff5f1f9a040E264150aFb979A" },
    blurSlug: null,
  },
  raretowelie: {
    name: "RARE TOWELIE CARDS",
    contract: "0x2BCAaD3cD618D0C0f87E153b3928e02bab757705",
    slug: "raretowelie",
    openseaSlug: "rare-towelie-cards",
    chain: "ethereum",
    standard: "erc1155",
    venueTrade: false,
    symbol: "TOWELIE",
    supply: null, // an ERC-1155 has no single supply; see editions
    editions: { tokenIds: 61, total: 3529, asOfBlock: 26041365 },
    supplyNote: "61 token ids (1 to 61) holding 3,529 editions, totalSupply(id) on Ethereum at block 26041365. The creator contract can add more.",
    mintBlock: null,
    deploy: { block: 20479699, date: "2024-08-07" },
    metadataBase: null,
    deterministicImage: false,
    image: "https://i2c.seadn.io/ethereum/0x2bcaad3cd618d0c0f87e153b3928e02bab757705/5580374b3cae2de37b5938be860eee5b.jpeg",
    description: "", // OpenSea's is empty, and nothing is written in its place
    descriptionSource: null,
    tags: ["ERC-1155", "ETHEREUM", "JUNGLE BAY"],
    pixelated: false,
    highlights: [],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/rare-towelie-cards",
      itemUrlTemplate: "https://opensea.io/item/ethereum/0x2bcaad3cd618d0c0f87e153b3928e02bab757705/{id}",
    },
    explorer: { name: "Etherscan", addressUrl: "https://etherscan.io/address/0x2BCAaD3cD618D0C0f87E153b3928e02bab757705" },
    blurSlug: null,
  },
};

export const DEFAULT_COLLECTION = "nakamigos";

// The collections TegridyNFTLending accepts: its constructor whitelists these
// three and reverts CollectionNotWhitelisted for any other contract, so a loan
// link is shown only for them (loanDeskScope.test.jsx pins the .sol list).
export const NFT_LOAN_DESK_CONTRACTS = new Set(
  [COLLECTIONS.junglebay, COLLECTIONS.nakamigos, COLLECTIONS.gnssart].map((c) => c.contract.toLowerCase()),
);

/** True when a loan against this collection can be taken today. */
export function loanDeskAccepts(collection) {
  return NFT_LOAN_DESK_LIVE
    && typeof collection?.contract === "string"
    && NFT_LOAN_DESK_CONTRACTS.has(collection.contract.toLowerCase());
}

// Every routable tab. App.jsx parseRoute() 404s anything not in this list, so
// a tab that ships in any nav but not here is unreachable in production —
// navRouting.test.jsx enforces nav ⊆ VALID_TABS against this single source.
export const VALID_TABS = [
  "gallery", "deals", "whales", "about", "analytics", "collection",
  "listings", "traits", "activity", "favorites", "trade", "trades",
  "watchlist", "bids", "my-listings", "alerts", "chat", "history",
  "sniper", "portfolio", "pro", "integrity",
];

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
// Seaport v1.5 — verify compatibility if OpenSea migrates to v1.6 (0x0000000000000068F116a894984e2DB1123eB395)
export const SEAPORT_ADDRESS = "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC";

// SECURITY: the ONLY contracts we will ever send a fulfillment (and its ETH) to.
// A native-orderbook row carries its own `protocol_address`, and that value is
// server-supplied — so it must never be trusted as a call target on its own.
// The OpenSea/Seaport sibling path already pins its target this way
// ("Unexpected transaction target — aborting for safety", api.js), and this is
// the same allowlist so the native path can't be the weaker of the two.
// Lowercased for case-insensitive comparison.
export const KNOWN_SEAPORT_ADDRESSES = new Set([
  "0x00000000000000adc04c56bf30ac9d3c0aaf14dc", // Seaport 1.5
  "0x0000000000000068f116a894984e2db1123eb395", // Seaport 1.6
]);

/**
 * Resolve the contract a native order may be fulfilled against.
 * Returns the pinned address, or null if the row names an unknown target
 * (callers MUST abort — never fall back to a default, which would silently
 * execute an order whose signed domain doesn't match where we're sending ETH).
 */
export function resolveSeaportTarget(protocolAddress) {
  if (!protocolAddress) return SEAPORT_ADDRESS;
  return KNOWN_SEAPORT_ADDRESSES.has(String(protocolAddress).toLowerCase())
    ? protocolAddress
    : null;
}

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
// 1% — OpenSea fee since Sep 2025. May vary per collection. Consider fetching from OpenSea API.
export const OPENSEA_FEE_BPS = 100;

// Platform fee — 1% on all trades
// RELAUNCH 2026-06-06: route to new 2-of-2 treasury Safe (was EOA 0xE9B7aB…, now only a Safe signer)
export const PLATFORM_FEE_RECIPIENT = "0x7D2620243EdAd69Ec81A53c4A063B07995A4Bd7d";
export const PLATFORM_FEE_BPS = 100; // 1%

// ── Bundle listing feature flag ──────────────────────────────────────────────
// Multi-NFT "list as a package" (one atomic Seaport order, one price). This is a
// NEW money-path (multi-item order construction + a dedicated server action + a DB
// migration). It stays OFF until: (1) supabase migration 012 is applied to prod,
// (2) the server env BUNDLE_LISTING_ENABLED=true is set, and (3) the money-path
// passes a re-audit. With this false, BundleListing shows an honest "coming soon"
// state instead of listing anything — it never fakes success. Server also enforces
// its own env gate, so flipping this client flag alone cannot expose the feature.
export const BUNDLE_LISTING_ENABLED = false;

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
  volume: 52200, // Historical total volume, not 24h — do not use for volume comparisons or alerts
  owners: 5238,
  supply: 20000,
};

// NOTE: there is deliberately no fallback holder roster here. Holder counts feed
// derived statistics (average held, whale count, top-10 concentration) that the
// analytics surfaces render as measured facts, so an outage must produce an
// explicit "unavailable" state, never a synthetic owner list.

// Anchored to a FIXED timestamp (not Date.now() - offset) so sample sales don't
// perpetually re-render as "2 minutes ago" and masquerade as fresh live trades.
// 2026-01-01T00:00:00Z — a stable, obviously-past reference point (F540).
const FALLBACK_ACTIVITY_REF = 1767225600000;
export const FALLBACK_ACTIVITY = [
  { type: "sale", token: { id: "11007", name: "#11007" }, price: 0.11, from: "0xd5a1...c442", to: "0x8cFe...91ab", time: FALLBACK_ACTIVITY_REF - 120000, hash: null, sample: true },
  { type: "sale", token: { id: "16630", name: "#16630" }, price: 0.1101, from: "0xBb22...c1a8", to: "0x13dF...e70b", time: FALLBACK_ACTIVITY_REF - 1860000, hash: null, sample: true },
  { type: "sale", token: { id: "3183", name: "#3183" }, price: 0.1123, from: "0xfC12...d8e3", to: "0x55Ab...19c0", time: FALLBACK_ACTIVITY_REF - 5400000, hash: null, sample: true },
  { type: "sale", token: { id: "2894", name: "#2894" }, price: 0.1099, from: "0x8812...eF03", to: "0xBb22...c1a8", time: FALLBACK_ACTIVITY_REF - 9000000, hash: null, sample: true },
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
    // The six family collections are COLLECTIONS entries above (`slug`), with the
    // chain and supply read there. Nothing is said of them here that their reads
    // do not support: no artist credit, no launch year, no mechanics.
    ecosystem: [
      { name: "Jungle Bay Gold Cards", slug: "junglebaygoldcards", supply: 123, chain: "Ethereum", description: null },
      { name: "the memes by jungle bay x mfers artists", slug: "junglebaymemes", supply: null, chain: "Ethereum", description: null },
      { name: "Seeds from the Memetic Garden", slug: "memeticseeds", supply: 369, chain: "Base", description: null },
      { name: "Junglets", slug: "junglets", supply: 208, chain: "Solana", description: null },
      { name: "Bojungles", slug: "bojungles", supply: 250, chain: "Base", description: null },
      { name: "RARE TOWELIE CARDS", slug: "raretowelie", supply: null, chain: "Ethereum", description: null },
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
