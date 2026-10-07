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

/**
 * One row per mint. `picture` is the file's slug; the generator adds a hash of the
 * bytes to it. `ring` names the ring colour in the generator.
 */
export const MINT_TOKENS = [
  {
    mint: 'BQZth5DhHZT9H1AxZonoLAwGHknWo4LebQBxjKWtzY8e',
    kind: 'pool-share',
    pool: 'ErvzV1NMZmcfAqZtGH4AQhYAjn77nJEworKK1mYPz5w4',
    name: 'BAYLA/SOL Pool Share',
    symbol: 'BAYLA-SOL',
    description: share('BAYLA/SOL', 'BAYLA', 'SOL'),
    picture: 'bayla-sol',
    ring: 'sol',
  },
  {
    mint: '3D3EKJxfePDQ1N8YtNwg8W6eSL4mjVpbYf57pnqgcAQx',
    kind: 'pool-share',
    pool: 'J35mQ6UF9PpB6bQMes2TRVUMbJVPwMYjcfapbkdm8mYm',
    name: 'BAYLA/USDC Pool Share',
    symbol: 'BAYLA-USDC',
    description: share('BAYLA/USDC', 'BAYLA', 'USDC'),
    picture: 'bayla-usdc',
    ring: 'usdc',
  },
  {
    mint: 'g8W2HWmS1dKJwHHKDkR1k7SmtTTx7ic97z1ssAZ8NwN',
    kind: 'staking-receipt',
    stakePool: 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f',
    name: 'Staked BAYLA',
    symbol: 'sBAYLA',
    description:
      `The receipt for BAYLA staked in the lighthouse pool on ${HOST}. Unstake there once your lock ends and it comes back as BAYLA. Do not burn it.`,
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
