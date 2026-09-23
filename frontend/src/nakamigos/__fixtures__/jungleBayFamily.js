// The Jungle Bay family collections, as READ, not as remembered.
//
// Every value here came from a read made for this change: an eth_call on
// Ethereum or Base (name, symbol, totalSupply, ownerOf, supportsInterface,
// eth_getCode for the deploy block), a Solana RPC read of the Metaplex
// metadata accounts, a saved OpenSea collection page, or the Magic Eden v2
// API. Tests compare the registry against this file, so a registry value that
// drifts from what the chain said goes red here first.
//
// The OpenSea descriptions are VERBATIM, em dashes included (spelled as
// \u2014 escapes so this file adds no U+2014 of its own). The registry stores
// the Seeds text with one mechanical change (see SEEDS_DESCRIPTION_STORED).

export const ADDR = Object.freeze({
  nakamigos: "0xd774557b647330C91Bf44cfEAB205095f7E6c367",
  gnssart: "0xa1De9f93c56C290C48849B1393b09eB616D55dbb",
  junglebay: "0xd37264c71e9af940e49795F0d3a8336afAaFDdA9",
  // Ethereum ERC-721, 123 minted (ids 1..123), maxSupply 150. The same
  // address src/lib/constants.ts already names JBAY_GOLD_ADDRESS.
  junglebaygoldcards: "0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3",
  // Ethereum ERC-1155 (Manifold creator core).
  junglebaymemes: "0x9EdABa801123866F25993914E389924744a07E89",
  raretowelie: "0x2BCAaD3cD618D0C0f87E153b3928e02bab757705",
  // Base ERC-721.
  memeticseeds: "0xb34bB1d81A4e5F9DcA7360C3043ad50db2ea87F3",
  bojungles: "0x36aFeE4FaDC3b77Ff5f1f9a040E264150aFb979A",
});

// The rejected Seeds candidate: an EIP-7702 delegated EOA that appears on the
// OpenSea page as an item owner. It must never be taken for the collection.
export const SEEDS_REJECTED_CANDIDATE = "0xe6da4a4930e896c7e1ff590779b4046d7587b802";

export const JUNGLETS_SOLANA = Object.freeze({
  collectionMint: "5csQYUGtJzUveFCKGRrnVCNZrPpkSAEZCZEsu9nBHuuK",
  updateAuthority: "3zoVsecguqdcLcTBaSjNQyAyYLLLt1tn93agbKBJ9vSw",
  firstCreator: "HqV6jua4x3V527W1JgsNQJ8G8nWPtF1igVm7ReY3avap",
});

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

export const GOLD_DESCRIPTION_OPENSEA_VERBATIM =
  "Gold Cards began as representation of those who invested in JungleBay when the project first emerged from the ashes of a rug. They are now held by the people who believe in the ethos of JungleBay and want to participate to the development of JungleBay island, as well as the governance of its ecosystem.\n\n"
  + "The owner of this card will be granted special benefits on JungleBay Island, which include: \n\n"
  + "-Access to the token-gated Gold Card chat in the JungleBay discord \n\n"
  + "-A 1.5x $JBAC multiplier on all apes held in the same wallet as the GC.\n\n"
  + "-Continued preferred benefits as the project develops. \n\n"
  + "-Additional preference on airdrops for all future JungleBay collaborations.";

// The venue stores ONLY the provenance paragraph. The rest is a list of
// holder benefits, and one of them (a 1.5x $JBAC multiplier) is a promise the
// venue's own staking does not honour: src/hooks/useNFTBoost.ts labels a Gold
// Card holder "Gold Card (no on-chain boost)".
export const GOLD_DESCRIPTION_STORED = GOLD_DESCRIPTION_OPENSEA_VERBATIM.split("\n\n")[0];

export const MEMES_DESCRIPTION_OPENSEA_VERBATIM =
  "About ‘the memes by jungle bay x mfers artists':\n\n\n"
  + "Holding a card from this collection is supporting a different artist who stayed during the bear market solely for the art and the culture. They created, with no guaranteed fruitful path forward, and put the community on their backs by seizing the memes of production. They have kept us laughing, inspired, and hopeful throughout the painful and mind-bendingly arduous tests we have collectively endured in this space this past “winter”.\n\n"
  + "Jungle Bay Island is where the dank memes go to recharge. \n\n"
  + "The magic is in the memes, and we dive into them alongside like-minded degens who are crazy enough to still be here, and strong enough to survive.\n\n"
  + "Jungle Bay Genesis Collection: https://opensea.io/collection/junglebay";

export const SEEDS_DESCRIPTION_OPENSEA_VERBATIM =
  "Seeds from the Memetic Garden is a collection of 1/1s from ~40 artists\u2014each contributing their own visual language to a tribute rooted in the ethos mfers helped unlock.\n\n"
  + "“you can state a roadmap that says where you will go, but you can also plant seeds and see where they grow.” \u2014 Sartoshi\n"
  + "That spirit lives here. Not through imitation, but through intent.\n"
  + "Each piece was created independently, but released together\u2014unified by respect, not rules.\n"
  + "Formed on Jungle Bay Island, a metaphorical space where memes evolve without instruction, the collection adds new layers to a lineage that never asked for permission.\n\n"
  + "This isn’t about looking back. It’s about continuing the conditions that let culture grow.";

/** The one typographic change the registry is allowed to make to Seeds' text. */
export const normalizeEmDashes = (text) => text.replace(/\s*\u2014\s*/g, " - ");
export const SEEDS_DESCRIPTION_STORED = normalizeEmDashes(SEEDS_DESCRIPTION_OPENSEA_VERBATIM);

// The collection NFT's metadata JSON (IPFS). The Metaplex account on chain
// holds only its name, symbol and the uri of that JSON; the text is not on chain.
export const JUNGLETS_DESCRIPTION_METADATA = "A love letter to $BRAINLET from jungle bay island\u{1F334}";
export const BOJUNGLES_DESCRIPTION_OPENSEA = "An homage to the powerful $BOBO, from Jungle Bay Island. \u{1F334}\u{1F9F1}";

/** What each of the six new registry entries must say, field by field. */
export const EXPECTED_FAMILY = Object.freeze({
  junglebaygoldcards: {
    name: "Jungle Bay Gold Cards",
    contract: ADDR.junglebaygoldcards,
    slug: "junglebaygoldcards",
    openseaSlug: "junglebaygoldcards",
    chain: "ethereum",
    standard: "erc721",
    venueTrade: true,
    symbol: "JBAY",
    chip: "GOLD",
    supply: 123,
    tokenIds: { first: 1 },
    mintBlock: 13781371,
    deploy: { block: 13781371, date: "2021-12-11" },
    image: "https://i2c.seadn.io/ethereum/a83577bfb307408682cd44520d1c00d4/899e287b319c9faf45c57e2626c8a1/21899e287b319c9faf45c57e2626c8a1.png",
    description: GOLD_DESCRIPTION_STORED,
    descriptionSource: "opensea",
    // Stored as an excerpt, and every label must say so.
    descriptionExcerpt: "first-paragraph",
    tags: ["ERC-721", "ETHEREUM", "JUNGLE BAY"],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/junglebaygoldcards",
      itemUrlTemplate: "https://opensea.io/item/ethereum/0x6aa03f42c5366e2664c887eb2e90844ca00b92f3/{id}",
    },
    explorer: { name: "Etherscan", addressUrl: "https://etherscan.io/address/0x6Aa03F42c5366E2664c887eb2e90844CA00B92F3" },
    blurSlug: null,
    supplyNoteMentions: ["26041301", "150"],
    // paused() reads true, and what it gates was not read: the note may state
    // maxSupply, not that more can be minted.
    supplyNoteNever: [/can be minted/i, /could mint/i, /more can/i],
  },
  junglebaymemes: {
    name: "the memes by jungle bay x mfers artists",
    contract: ADDR.junglebaymemes,
    slug: "junglebaymemes",
    openseaSlug: "the-memes-by-junglebay-x-mfers-artists",
    chain: "ethereum",
    standard: "erc1155",
    venueTrade: false,
    symbol: "JBMFERS",
    supply: null,
    editions: { tokenIds: 22, total: 975, asOfBlock: 26041365 },
    mintBlock: null,
    deploy: { block: 16531491, date: "2023-02-01" },
    image: "https://i2c.seadn.io/ethereum/c2b8bd39b58546c7b9b4cd57ec000427/e70a60faad9893ac590a8a93ee9d20/1ae70a60faad9893ac590a8a93ee9d20.png",
    description: MEMES_DESCRIPTION_OPENSEA_VERBATIM,
    descriptionSource: "opensea",
    tags: ["ERC-1155", "ETHEREUM", "JUNGLE BAY"],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/the-memes-by-junglebay-x-mfers-artists",
      itemUrlTemplate: "https://opensea.io/item/ethereum/0x9edaba801123866f25993914e389924744a07e89/{id}",
    },
    explorer: { name: "Etherscan", addressUrl: "https://etherscan.io/address/0x9EdABa801123866F25993914E389924744a07E89" },
    blurSlug: null,
    supplyNoteMentions: ["22", "975", "26041365"],
  },
  memeticseeds: {
    name: "Seeds from the Memetic Garden",
    contract: ADDR.memeticseeds,
    slug: "memeticseeds",
    openseaSlug: "seeds-from-the-memetic-garden",
    chain: "base",
    standard: "erc721",
    venueTrade: false,
    symbol: "SFTMG",
    supply: 369,
    burnedIds: [88],
    mintBlock: null,
    deploy: { block: 32896090, date: "2025-07-15" },
    image: "https://i2c.seadn.io/base/5e9fe098b5ce43d4bc0693febb0106f6/d270b900f8b40fc5bbc31834b38934/9dd270b900f8b40fc5bbc31834b38934.png",
    description: SEEDS_DESCRIPTION_STORED,
    descriptionSource: "opensea",
    tags: ["ERC-721", "BASE", "JUNGLE BAY"],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/seeds-from-the-memetic-garden",
      itemUrlTemplate: "https://opensea.io/item/base/0xb34bb1d81a4e5f9dca7360c3043ad50db2ea87f3/{id}",
    },
    explorer: { name: "Basescan", addressUrl: "https://basescan.org/address/0xb34bB1d81A4e5F9DcA7360C3043ad50db2ea87F3" },
    blurSlug: null,
    supplyNoteMentions: ["51695380", "88", "368"],
  },
  junglets: {
    name: "Junglets",
    contract: null,
    slug: "junglets",
    openseaSlug: null,
    magicEdenSymbol: "junglet",
    solana: JUNGLETS_SOLANA,
    chain: "solana",
    standard: "spl",
    venueTrade: false,
    symbol: "JGLETS",
    supply: 208,
    mintBlock: null,
    deploy: null,
    image: "https://wsrv.nl/?url=https%3A%2F%2Fna-assets.pinit.io%2F3zoVsecguqdcLcTBaSjNQyAyYLLLt1tn93agbKBJ9vSw%2Fb69c398c-8a8f-4b56-8f82-fdb0b1d3a16e%2F0&w=400&output=webp",
    description: JUNGLETS_DESCRIPTION_METADATA,
    descriptionSource: "metadata",
    tags: ["METAPLEX PNFT", "SOLANA", "JUNGLE BAY"],
    market: {
      name: "Magic Eden",
      collectionUrl: "https://magiceden.us/marketplace/junglet",
      itemUrlTemplate: null,
    },
    explorer: { name: "Solana Explorer", addressUrl: "https://explorer.solana.com/address/5csQYUGtJzUveFCKGRrnVCNZrPpkSAEZCZEsu9nBHuuK" },
    blurSlug: null,
    supplyNoteMentions: ["208"],
  },
  bojungles: {
    name: "Bojungles",
    contract: ADDR.bojungles,
    slug: "bojungles",
    openseaSlug: "bojungless",
    chain: "base",
    standard: "erc721",
    venueTrade: false,
    symbol: "BOJUNG",
    supply: 250,
    mintBlock: null,
    deploy: { block: 23975123, date: "2024-12-21" },
    image: "https://i2c.seadn.io/collection/bojungless/image/8adbd4b81493e3f7de25ca395e66a1/b18adbd4b81493e3f7de25ca395e66a1.png",
    description: BOJUNGLES_DESCRIPTION_OPENSEA,
    descriptionSource: "opensea",
    tags: ["ERC-721", "BASE", "JUNGLE BAY"],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/bojungless",
      itemUrlTemplate: "https://opensea.io/item/base/0x36afee4fadc3b77ff5f1f9a040e264150afb979a/{id}",
    },
    explorer: { name: "Basescan", addressUrl: "https://basescan.org/address/0x36aFeE4FaDC3b77Ff5f1f9a040E264150aFb979A" },
    blurSlug: null,
    supplyNoteMentions: ["51695371", "250"],
  },
  raretowelie: {
    name: "RARE TOWELIE CARDS",
    contract: ADDR.raretowelie,
    slug: "raretowelie",
    openseaSlug: "rare-towelie-cards",
    chain: "ethereum",
    standard: "erc1155",
    venueTrade: false,
    symbol: "TOWELIE",
    supply: null,
    editions: { tokenIds: 61, total: 3529, asOfBlock: 26041365 },
    mintBlock: null,
    deploy: { block: 20479699, date: "2024-08-07" },
    image: "https://i2c.seadn.io/ethereum/0x2bcaad3cd618d0c0f87e153b3928e02bab757705/5580374b3cae2de37b5938be860eee5b.jpeg",
    // OpenSea's description is empty, and nothing is written in its place.
    description: "",
    descriptionSource: null,
    tags: ["ERC-1155", "ETHEREUM", "JUNGLE BAY"],
    market: {
      name: "OpenSea",
      collectionUrl: "https://opensea.io/collection/rare-towelie-cards",
      itemUrlTemplate: "https://opensea.io/item/ethereum/0x2bcaad3cd618d0c0f87e153b3928e02bab757705/{id}",
    },
    explorer: { name: "Etherscan", addressUrl: "https://etherscan.io/address/0x2BCAaD3cD618D0C0f87E153b3928e02bab757705" },
    blurSlug: null,
    supplyNoteMentions: ["61", "3,529", "26041365"],
  },
});

export const FAMILY_SLUGS = Object.freeze(Object.keys(EXPECTED_FAMILY));
export const VIEW_ONLY_SLUGS = Object.freeze(["junglebaymemes", "memeticseeds", "junglets", "bojungles", "raretowelie"]);
export const VIEW_ONLY_EVM_SLUGS = Object.freeze(["junglebaymemes", "memeticseeds", "bojungles", "raretowelie"]);
export const VENUE_SLUGS = Object.freeze(["nakamigos", "gnssart", "junglebay", "junglebaygoldcards"]);
export const REGISTRY_ORDER = Object.freeze([
  "nakamigos", "gnssart", "junglebay",
  "junglebaygoldcards",
  "junglebaymemes", "memeticseeds", "junglets", "bojungles", "raretowelie",
]);

// The P2P chip each venue collection wears. Every one names its own
// collection and none reads as another's ("JBAY" would read as the apes).
export const VENUE_CHIPS = Object.freeze({
  nakamigos: "NAKA",
  gnssart: "GNSS",
  junglebay: "JBAC",
  junglebaygoldcards: "GOLD",
});

// The same TOWELI_ONLY rule e2e/voice-census.spec.ts walks the DOM with.
const PROTOCOL = "(stak(e|ed|es|ing)|lock(ed|s|ing)?|emissions?|rewards?|boost(s|ed)?|gold card)";
export const TOWELI_ONLY = new RegExp(
  `\\bveTOWELI\\b|\\bTOWELI\\b[^.!?]{0,60}\\b${PROTOCOL}\\b|\\b${PROTOCOL}\\b[^.!?]{0,60}\\bTOWELI\\b`,
  "i",
);
