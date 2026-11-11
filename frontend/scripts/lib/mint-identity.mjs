// The tokens this site serves a name and a picture for: the one list. The generator
// (scripts/generate-mint-identity.mjs) writes public/mint/ from it, and the pin test,
// the dist check, the production probe and the receipt script all read it.
// Keep it free of imports and side effects: a vitest run and a bare-node probe load it.

/** The canonical origin. src/lib/mintIdentity.test.ts pins it to SITE_URL. */
export const SITE = 'https://memetics.finance';
const HOST = new URL(SITE).host;

/** The folder under public/ and its picture subfolder, as URL paths. */
export const MINT_PATH = '/mint';
export const MINT_IMG_PATH = '/mint/img';
/** What a mint with no file of its own is answered with (vercel.json rewrites to it). */
export const DEFAULT_FILE = 'default.json';

/** Metaplex's own limits, in bytes: what an on-chain record can hold. */
export const LIMITS = { name: 32, symbol: 10, uri: 200 };

const share = (pair, a, b) =>
  `A share of the ${pair} pool on ${HOST}. Remove liquidity there and it comes back as ${a} and ${b}. Do not burn it.`;

/** The coins in our pools, by mint, as each share's `coins` names them. */
export const COINS = {
  SOL: 'So11111111111111111111111111111111111111112',
  USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  BAYLA: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump',
  RIZZ: '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k',
  SOY: '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump',
  BOBO: '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump',
  BRAINLET: '4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump',
  CRYING: 'Ep5tnKTSkLDeQ12ctS3RhQNcbcApkcyJcGPgHh4dpump',
  GRR: 'DBEjiLMt9USaM3SdC9YtNcKGnXLdFhzokwnykH4Wpump',
  MROCKS: 'moon3CP11XLvrAxUPBnPtueDEJvmjqAyZwPuq7wBC1y',
  'BIG BRAIN': 'J9zjM2nn4DBYpFy3qrReaUzY66g4EFMwLa61YSGCpump',
  STORMIE: 'HqyTxEqk7qmLu2Gnx46eEZwQhzCf2yVqRompLaKYpump',
  APE: '2Wkip2U5x93mjaAvoq8zaedweP73GgRtbaQhNcwXpump',
  TBB: '42cXQvAAr7hcPBPWAS4ocVtDyeJ4Fa6gRR2uG4gppump',
  OGDOGE: 'utLyQQCPvjuCc6zeaXdsFeEC3JNdxKS3vxaZWoGdoge',
  SHOCKER: 'E6LwzUpR2NsdUzAiGzZb1K5PbffkXANagXHt1R4BTRiX',
  GROYPER: '7QAn5wqkBcGuvfLLC16iLvX8fPyqXrzkMqnzHLS9NNna',
  USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
  ZBCN: 'ZBCNpuD7YMXzTHB2fhGkGi78MNsHGLRXUhRewNRm9RU',
  KWIF: '6Rwcmkz9yiYVM5EzyMcr4JsQPGEAWhcUvLvfBperYnUt',
};

/**
 * One row per mint. `picture` is the file's slug; the generator adds a hash of the
 * bytes to it. `ring` names the ring colour in the generator. `art` names the bungalow
 * whose door art sits inside the ring; a row without it carries BAYLA's island mark.
 * A pool share's `coins` are its two coins, the pool's own coin first and the coin it
 * is paired with last, the order its name reads (the site's own reading, quotes.ts
 * `readPair`). The ring is the paired coin's: violet SOL, blue USDC, and the neutral
 * moonlight ring for an island coin paired with, which has no ring colour of its own.
 *
 * Owner rulings 2026-10-24: a pool share is named "<first coin>/<second coin> LP"; only
 * a bungalow's coin gets its own art inside its ring, every other share gets BAYLA's.
 * Every pool of the program with a share anyone can hold is listed. A pool whose only
 * shares are the 100 locked at its opening is not: no wallet can ever show its share.
 */
export const MINT_TOKENS = [
  {
    mint: 'BQZth5DhHZT9H1AxZonoLAwGHknWo4LebQBxjKWtzY8e',
    kind: 'pool-share',
    pool: 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4',
    coins: [COINS.BAYLA, COINS.SOL],
    name: 'BAYLA/SOL LP',
    symbol: 'BAYLA-SOL',
    description: share('BAYLA/SOL', 'BAYLA', 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: '3D3EKJxfePDQ1N8YtNwg8W6eSL4mjVpbYf57pnqgcAQx',
    kind: 'pool-share',
    pool: 'J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm',
    coins: [COINS.BAYLA, COINS.USDC],
    name: 'BAYLA/USDC LP',
    symbol: 'BAYLA-USDC',
    description: share('BAYLA/USDC', 'BAYLA', 'USDC'),
    picture: 'bayla-usdc',
    ring: 'usdc',
  },
  {
    mint: '8LUVkr5K9PFuLnXeZ2GfgiRXHxrQQQdzjnw1EiCQxcgZ',
    kind: 'pool-share',
    pool: '3yDDaZtABgj7z4BNtPKpfnK4yrx5bvEphDXYGGTnTmfA',
    coins: [COINS.RIZZ, COINS.SOL],
    name: 'RIZZ/SOL LP',
    symbol: 'RIZZ-SOL',
    description: share('RIZZ/SOL', 'RIZZ', 'SOL'),
    picture: 'rizz-sol',
    ring: 'sol',
    art: 'rizz',
  },
  {
    mint: '3YMYSG627S1gFMtG8GMWpzqVYd3DThRPMbxrgyqtpzUj',
    kind: 'pool-share',
    pool: '5M4SZy9Ytu1LGWWjBUwiDZ98bGdpQL4fD3PHETEXPAN8',
    coins: [COINS.SOY, COINS.SOL],
    name: 'SOY/SOL LP',
    symbol: 'SOY-SOL',
    description: share('SOY/SOL', 'SOY', 'SOL'),
    picture: 'soy-sol',
    ring: 'sol',
    art: 'soy',
  },
  {
    mint: 'CcLsQeUD1dWhrR3aNW3sjcKHeLbMdPvzFRyBniUTCtNJ',
    kind: 'pool-share',
    pool: '9mHGFULXNFjcdkZ9fLy24A3pp4iYVk6y889NNcUvSgRV',
    coins: [COINS.BOBO, COINS.SOL],
    name: 'BOBO/SOL LP',
    symbol: 'BOBO-SOL',
    description: share('BOBO/SOL', 'BOBO', 'SOL'),
    picture: 'bobo-sol',
    ring: 'sol',
    art: 'bobo',
  },
  {
    mint: 'AgSTcTMvo2U3hhRMxq6UVbaSNuiaBJSQRZ5b78A5ymc4',
    kind: 'pool-share',
    pool: 'HaRnur2ETP44bFtjUU4haQcFVYrCDTSaJfjKY3E3bDDD',
    coins: [COINS.BRAINLET, COINS.SOL],
    name: 'BRAINLET/SOL LP',
    // "BRAINLET-SOL" is past the 10 bytes a symbol may hold. Owner, 2026-10-24: "use brain instead drop the L".
    symbol: 'BRAIN-SOL',
    description: share('BRAINLET/SOL', 'BRAINLET', 'SOL'),
    picture: 'brainlet-sol',
    ring: 'sol',
    art: 'brainlet',
  },
  {
    mint: '4HPgmQyPSEXMGcCQHUDeo1EhJWKpjrnugPBSNLkyrrzh',
    kind: 'pool-share',
    pool: '8T2ErLrntFdGMZaVHXNqX6z96Ay1qh5xGMm67mVeGrgB',
    coins: [COINS.CRYING, COINS.SOL],
    name: 'CRYING/SOL LP',
    symbol: 'CRYING-SOL',
    // Not one of the island's coins, so its whole address is said: a copy can share a ticker.
    description: share('CRYING/SOL', `CRYING (${COINS.CRYING})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: '45SMHUNbwLi91E792o3auPy7v8C4F58v6Yk5Yre7a4pC',
    kind: 'pool-share',
    pool: 'CvAVyjZk1A4hLuNDvEseCYHAn98mU1f4mKpveGvAM2UC',
    coins: [COINS.SOL, COINS.USDC],
    name: 'SOL/USDC LP',
    symbol: 'SOL-USDC',
    description: share('SOL/USDC', 'SOL', 'USDC'),
    picture: 'bayla-usdc',
    ring: 'usdc',
  },
  {
    mint: 'tCzVHDSMxQ1ANFZZ2bA3JnxYXRws9uj84GdrbejLTWQ',
    kind: 'pool-share',
    pool: 'rD73MYkgDq7RKDxaJMFmiBu1feCAg2hQKHnVucZ5cZH',
    coins: [COINS.GRR, COINS.SOL],
    name: 'GRR/SOL LP',
    symbol: 'GRR-SOL',
    description: share('GRR/SOL', `GRR (${COINS.GRR})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: '5uicWVk3D85RLjNmcexohqCDyuZjyHnpzd1aWiUMBQ29',
    kind: 'pool-share',
    pool: 'raEFEHUYRBYVSJ5jiu5KLm2BQeVCNS5g8W7YoAJVYBd',
    coins: [COINS.MROCKS, COINS.SOL],
    name: 'MROCKS/SOL LP',
    symbol: 'MROCKS-SOL',
    description: share('MROCKS/SOL', `MROCKS (${COINS.MROCKS})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: '85PrZH8qw15Yq22P2jhhBUWSFZzsC1XSdarmeaEq7q5j',
    kind: 'pool-share',
    pool: '3YRW6wJscukRaWutB6QgPwtK1EQM9KA7CXcXTtmN3GJK',
    coins: [COINS['BIG BRAIN'], COINS.SOL],
    name: 'BIG BRAIN/SOL LP',
    // "BIGBRAIN-SOL" is past the 10 bytes a symbol may hold: shortened the way the owner shortened BRAINLET.
    symbol: 'BIGB-SOL',
    description: share('BIG BRAIN/SOL', `BIG BRAIN (${COINS['BIG BRAIN']})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: 'GtVoiErMqFDZpf592kHTFMxM7xoZ4knQ2Gvc2m8UrQXx',
    kind: 'pool-share',
    pool: '3sw9bPyEk29AMkwr2fHeQiyKiptNkUgfvtY8u5QrJdWh',
    coins: [COINS.STORMIE, COINS.SOL],
    name: 'STORMIE/SOL LP',
    // "STORMIE-SOL" is past the 10 bytes a symbol may hold: the owner chose dropping a vowel (2026-11-11).
    symbol: 'STRMIE-SOL',
    description: share('STORMIE/SOL', `STORMIE (${COINS.STORMIE})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: 'F793raKNWfn11PmqWdwMNp7A6kkfFqFjGG199M2CfGPj',
    kind: 'pool-share',
    pool: '6EESMGsgzDc2N3PaVsue5FizVDvi2ZRuY8j3iPLkrkxs',
    coins: [COINS.APE, COINS.SOL],
    name: 'APE/SOL LP',
    symbol: 'APE-SOL',
    description: share('APE/SOL', `APE (${COINS.APE})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: 'BTHYKjLHCJtBaKWVvBeqAgBF6aU7fwCYheoPH8ztpJr3',
    kind: 'pool-share',
    pool: '75n4yk8teGKvS4mkREUzYe56CQTFQwWo75V6nFHon4vs',
    coins: [COINS.TBB, COINS.SOL],
    name: 'TBB/SOL LP',
    symbol: 'TBB-SOL',
    description: share('TBB/SOL', `TBB (${COINS.TBB})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: '7P5oYhpAhnssPasq6iedy5ebVP279CHJJXotwZ4qgP4W',
    kind: 'pool-share',
    pool: '7JZ4Qnjh86s2aRc514LRTFJvJa2Wb6ZLuN6FdhMrs8vh',
    coins: [COINS.BRAINLET, COINS.SOY],
    name: 'BRAINLET/SOY LP',
    // "BRAINLET-SOY" is past the 10 bytes a symbol may hold: shortened the way the owner shortened BRAINLET.
    symbol: 'BRAIN-SOY',
    description: share('BRAINLET/SOY', 'BRAINLET', 'SOY'),
    picture: 'brainlet-soy',
    ring: 'moonlight',
    art: 'brainlet',
  },
  {
    mint: 'BibsjCKijbUYmDJwKWVH9Qsvn4Dq1hUrczynKxRvQj2x',
    kind: 'pool-share',
    pool: '7zaN5voCmWe4U6CwxPQLxqcf7UffJfo3kiLLLtBjQQgx',
    coins: [COINS.OGDOGE, COINS.SOL],
    name: 'OGDOGE/SOL LP',
    symbol: 'OGDOGE-SOL',
    description: share('OGDOGE/SOL', `OGDOGE (${COINS.OGDOGE})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: 'J2xnphDfxXHAd4WExGw4soxRhwy8bCTbGvw6q24mfiTj',
    kind: 'pool-share',
    pool: '9P1KhvycWZiEb2hYidGoc5U9Lji8mgjZHRn4CdGcFkVy',
    coins: [COINS.SHOCKER, COINS.SOL],
    name: 'SHOCKER/SOL LP',
    // "SHOCKER-SOL" is past the 10 bytes a symbol may hold: the owner chose dropping a vowel (2026-11-11).
    symbol: 'SHOCKR-SOL',
    description: share('SHOCKER/SOL', `SHOCKER (${COINS.SHOCKER})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: 'A7QFFs9XAvd8NQwBShy5fuGwgTg8zAzm3Rgs4DF3bhwE',
    kind: 'pool-share',
    pool: '9wNsvpuV94Jc8BaSk25SHahzmrDs8DKqgVMm1AjeGVnQ',
    coins: [COINS.GROYPER, COINS.SOL],
    name: 'GROYPER/SOL LP',
    // "GROYPER-SOL" is past the 10 bytes a symbol may hold: the owner chose dropping a vowel (2026-11-11).
    symbol: 'GROYPR-SOL',
    description: share('GROYPER/SOL', `GROYPER (${COINS.GROYPER})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: 'CK4s5DWKVwBpvBmW3isKTNv2YiPTuvtwQZ6NUCsh9rCc',
    kind: 'pool-share',
    pool: 'BVkaypc3tiKHDjka7SnCGeKG2Uc2D3n5rh2w3mDTjdK4',
    coins: [COINS['BIG BRAIN'], COINS.BRAINLET],
    name: 'BIG BRAIN/BRAINLET LP',
    // "BIGBRAIN-BRAINLET" is past the 10 bytes a symbol may hold: shortened the way the owner shortened BRAINLET.
    symbol: 'BIGB-BRAIN',
    description: share('BIG BRAIN/BRAINLET', `BIG BRAIN (${COINS['BIG BRAIN']})`, 'BRAINLET'),
    picture: 'pool-share',
    ring: 'moonlight',
  },
  {
    mint: 'AZbCsNo77ETPa2E2bER8pF65GbS9r9Lhkt1mwNEgJWKf',
    kind: 'pool-share',
    pool: 'G23uSnADCtgMdRfBdRhYj3JRVL9Ky9GEVdyy7jK9ughx',
    coins: [COINS.USDT, COINS.USDC],
    name: 'USDT/USDC LP',
    symbol: 'USDT-USDC',
    description: share('USDT/USDC', `USDT (${COINS.USDT})`, 'USDC'),
    picture: 'bayla-usdc',
    ring: 'usdc',
  },
  {
    mint: 'EJpDTWGtM43uih26eBM7tSG7AJuMGQgfjMY2Sdq92hBo',
    kind: 'pool-share',
    pool: 'H8TVzALWtq9CJDfnkKtgnfjNcRXUShvxYArwmBfj7Kkd',
    coins: [COINS.ZBCN, COINS.SOL],
    name: 'ZBCN/SOL LP',
    symbol: 'ZBCN-SOL',
    description: share('ZBCN/SOL', `ZBCN (${COINS.ZBCN})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: 'FnqVeoNc95YDpfo8WGboFjujxWzxuHdhafJ3i7rSziEh',
    kind: 'pool-share',
    pool: 'HBGZFvYZnKMsrjn42C9ZbQCKYd5a1NAt4MaXnrKNuMES',
    coins: [COINS.KWIF, COINS.SOL],
    name: 'KWIF/SOL LP',
    symbol: 'KWIF-SOL',
    description: share('KWIF/SOL', `KWIF (${COINS.KWIF})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: '2FKSKBGStzrTfcF8evAEQkCwA6eXnMdKdCAvNfY9c1ux',
    kind: 'pool-share',
    pool: 'Hb6naTh2QFrRioeAhNToFEPgKaN1iiyDzGacYi1c7gm1',
    coins: [COINS.USDT, COINS.SOL],
    name: 'USDT/SOL LP',
    symbol: 'USDT-SOL',
    description: share('USDT/SOL', `USDT (${COINS.USDT})`, 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: 'g8W2HWmS1dKJwHHKDkR1k7SmtTTx7ic97z1ssAZ8NwN',
    kind: 'staking-receipt',
    stakePool: 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f',
    name: 'Bayla Staking',
    symbol: 'sBAYLA',
    // The receipt count is the stake times its lock boost (about 3.1 receipts per BAYLA
    // staked on 2026-10-07), so the number a wallet shows is not a count of BAYLA.
    description:
      `The receipt for BAYLA staked in the lighthouse pool on ${HOST}. Unstake there once your lock ends and it comes back as BAYLA. The amount shown is your stake multiplied by your lock boost, not a count of BAYLA. Do not burn it.`,
    picture: 'staked-bayla',
    ring: 'gold',
  },
];

/** Every other pool share: the words the pool program writes for any pool. */
export const DEFAULT_TOKEN = {
  name: 'Memetics Pool Share',
  symbol: 'MEM-LP',
  description:
    `A share of a pool on ${HOST}. Remove liquidity there and it comes back as the two tokens in the pool. Do not burn it.`,
  picture: 'pool-share',
  ring: 'moonlight',
};

/** The link written on chain for a mint: fixed prefix, the mint address, `.json`. */
export const metadataPath = (mint) => `${MINT_PATH}/${mint}.json`;
export const metadataUri = (mint) => `${SITE}${metadataPath(mint)}`;
export const imagePath = (file) => `${MINT_IMG_PATH}/${file}`;

/** The picture's file name: the slug, then the first 8 hex of the sha256 of its bytes. */
export const pictureFile = (slug, sha256Hex) => `${slug}-${sha256Hex.slice(0, 8)}.png`;

/**
 * Pictures no metadata file names any more, by file name, kept in public/mint/img/ for
 * good. A picture that was deployed is NEVER deleted: a wallet that kept yesterday's
 * metadata still asks for the old address, and a missing file there answers JSON, marked
 * unchanging for a year. When a picture is redesigned, its old file name goes here.
 * @type {string[]}
 */
export const RETIRED_PICTURES = [];

/** Does a picture file name carry the hash of these bytes? True for any slug. */
export const carriesOwnHash = (file, sha256Hex) =>
  /^[a-z-]+-[0-9a-f]{8}\.png$/.test(file) && file.endsWith(`-${sha256Hex.slice(0, 8)}.png`);

/**
 * Why a picture folder is wrong, as sentences; none when it is right. `onDisk` is every
 * file in it as { name, sha256 }; `named` is the pictures the metadata files point at.
 */
export function pictureFolderProblems(onDisk, named, retired = RETIRED_PICTURES) {
  const problems = [];
  const have = new Map(onDisk.map((f) => [f.name, f.sha256]));
  for (const name of named) if (!have.has(name)) problems.push(`${name} is missing, and a metadata file points at it`);
  for (const name of retired) {
    if (named.includes(name)) problems.push(`${name} is retired and a metadata file still points at it`);
    else if (!have.has(name)) problems.push(`${name} is retired and missing: a picture that was deployed is never deleted`);
  }
  for (const [name, sha256] of have) {
    if (!named.includes(name) && !retired.includes(name)) problems.push(`${name} is named by no metadata file and is not in RETIRED_PICTURES`);
    else if (!carriesOwnHash(name, sha256)) problems.push(`${name} does not carry the hash of its own bytes in its name`);
  }
  return problems;
}

/** The file a wallet reads: exactly these four fields, in this order. */
export function metadataFor(token, pictureFileName) {
  return {
    name: token.name,
    symbol: token.symbol,
    description: token.description,
    image: `${SITE}${imagePath(pictureFileName)}`,
  };
}

/** The bytes of a metadata file as committed: two-space JSON and one final newline. */
export const serialize = (metadata) => `${JSON.stringify(metadata, null, 2)}\n`;

/** Every file `public/mint/` must hold, by exact name: one per mint, and the default. */
export const metadataFileNames = () => [...MINT_TOKENS.map((t) => `${t.mint}.json`), DEFAULT_FILE];
