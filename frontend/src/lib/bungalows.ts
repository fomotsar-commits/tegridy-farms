import type { ArtPiece } from './artConfig';
import type { GeckoNetwork } from './geckoTerminal/pools';
import { BUNGALOW_ART_FILES } from './bungalowArtPools';
import { safeGetItem, safeSetItem } from './storage';
import { TOWELI_ADDRESS } from './constants';

// Jungle Bay Island: the 13 bungalows, from the island's published canon (memetics.wtf
// SPOTS + SIGNSV2). Addresses are verbatim: re-read the source, never guess or "fix" one.
// A bungalow re-skins pageArt() backgrounds and, with an `identity`, the hero, farm and
// footer speak its token; buttons, nav, rails and contracts never change. The skin is
// state, read synchronously and never at module scope: a door writes it during render
// and announces after commit (announceActiveBungalow). Nothing reloads.
export interface BungalowIdentity {
  /** H1 first line (the token, big). */
  heroTitle: string;
  /** H1 second line (the island's status line for the spot). */
  heroLine: string;
  /** Hero paragraph. */
  heroCopy: string;
  /** Quote pill under the CTAs (replaces the Towelie ticker). */
  museLine: string;
  museBy: string;
  /** Rotation pool of canon lines (absent -> [museLine]). Island canon, kept; no venue surface paints it. */
  museLines?: readonly string[];
  /** Byline persona (absent -> museBy). Island canon, pinned by bungalows.test.ts; unpainted. */
  museVoice?: string;
  /** The resident's story card on its own home page: CANON copy only. Absent -> no card. */
  lore?: {
    title: string;
    paragraphs: readonly string[];
    links: readonly { href: string; label: string }[];
  };
}

export interface Bungalow {
  /** Stable id — island slug, storage value, ?bungalow= deep-link value. */
  id: string;
  name: string;
  symbol: string;
  chain: 'ethereum' | 'base' | 'solana' | 'tbd';
  /** Token contract (EVM) or mint (Solana), verbatim from the island canon. */
  address?: string;
  /** The island's status word for the spot (SETTLED / NEWEST / QUIET). */
  status: string;
  /** The spot's plaque line. */
  tagline: string;
  /** The spot's accent color on the island map. */
  accent?: string;
  /** Door-art focal point (CSS object-position) for hall and picker tiles: the character's face. */
  thumbPosition?: string;
  /** External trade deep link (canon pattern: Uniswap for TOWELI, Jupiter here). */
  swapUrl?: string;
  /** Live liquidity pools for this token (labels + external pair pages). */
  pools?: { label: string; url: string }[];
  /** The community's own home (site or X), from the island outreach dossier. */
  community?: { label: string; url: string };
  /** Streamflow stake-pool address (the lighthouse pool). Absent -> the panel's "Not deployed yet" card. */
  stakePool?: string;
  /** EVM only: 'plain' (no-lock Synthetix staker) or 'ladder' (LighthouseLadder, floor 0.40x at 7 days); absent = 'plain'.
   *  A Solana pool names its program by field instead: `stakePool` Streamflow, `ladderPool` bayla-ladder. */
  poolKind?: 'plain' | 'ladder';
  /** The venue's own Solana staking program (bayla-ladder), beside `stakePool` while Streamflow locks run.
   *  No fallback: it mounts only when VITE_BAYLA_LADDER_POOL and VITE_BAYLA_LADDER_PROGRAM are both set. */
  ladderPool?: string;

  /** Closed to new deposits (a UI gate, not on chain). Claim, unstake and rescue never close. Absent = open. */
  depositsClosed?: true;
  /** Decimals fallback before the live mint read lands (which wins). */
  decimals?: number;
  /** The primary pool the chart and market strip read, as GeckoTerminal names it. `network` is GeckoTerminal's
   *  slug (Ethereum is `eth`), a closed union so a typo cannot compile. Undefined = no market surface. */
  market?: { network: GeckoNetwork; pool: string; label: string };
  /** Background art pool. Undefined = classic art system. */
  artPool?: ArtPiece[];
  /** Picker card thumbnail. */
  thumb: string;
  /** Selectable in the picker (needs an art pool at minimum). */
  live: boolean;
  /** Token-first copy for surfaces that re-speak in this bungalow's voice. */
  identity?: BungalowIdentity;
}

/** A bungalow's background pool from public/art/<id>/. Piece ids are FILENAMES: overrides are stored by artId. */
export function bungalowArtFor(id: string, name: string): ArtPiece[] | undefined {
  const files = BUNGALOW_ART_FILES[id];
  if (!files?.length) return undefined;
  return files.map((f, i) => ({
    id: f.replace(/\.[^.]+$/, ''),
    src: `/art/${id}/${f}`,
    title: `${name} #${String(i + 1).padStart(2, '0')}`,
    description: `${name} bungalow, Jungle Bay Island`,
  }));
}

/** Bayla background pool (public/art/bayla); also the venue intro gallery (lib/arrival.ts). */
export const BAYLA_ART: ArtPiece[] = bungalowArtFor('bayla', 'Bayla') ?? [];

export const DEFAULT_BUNGALOW_ID = 'toweli';

export const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';

// The BAYLA lighthouse pool (mainnet, nonce 1); reward pool 3ysyH5py46Q4XUXkumGy3DhWjPbNVhLMfQZmpQMdDruf.
// Hardcoded so no env var is load-bearing. A set VITE_BAYLA_STAKE_POOL WINS over this
// constant, so it must be unset or match.
const BAYLA_STAKE_POOL =
  (import.meta.env?.VITE_BAYLA_STAKE_POOL as string | undefined)?.trim()
  || 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f';

/** The bayla-ladder pool, only when the operator sets it: no fallback, so go-live is the owner's call.
 *  Set VITE_BAYLA_LADDER_PROGRAM too (lib/ladder/program.ts). The operator CLI reads BAYLA_LADDER_PROGRAM
 *  (no VITE_ prefix, devnet default), so a shell set up for it is NOT configured for this. */
const BAYLA_LADDER_POOL =
  (import.meta.env?.VITE_BAYLA_LADDER_POOL as string | undefined)?.trim() || '';

/**
 * The island's read list: staking pools whose locked bags the island counts as held.
 * The staking cards' held-time line reads it through poolReadByIsland, never a flag
 * on a card. Keyed by pool address, so a pool repointed by env reads no until listed.
 * When the island publishes its list, that list replaces this one.
 */
export const ISLAND_READ_POOLS: readonly { chain: Bungalow['chain']; pool: string }[] = [
  { chain: 'solana', pool: 'Bq6jovnQhayMjr5RqsezGMxgmF5851mqFAhX6LrsXTXV' }, // lock ladder
  { chain: 'solana', pool: 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f' }, // BAYLA lighthouse
];

/** Read by the island: yes or no. Exact on Solana (base58), case-blind on EVM. */
export function poolReadByIsland(
  chain: Bungalow['chain'],
  pool: string | undefined,
  list: readonly { chain: Bungalow['chain']; pool: string }[] = ISLAND_READ_POOLS,
): boolean {
  const raw = pool?.trim();
  if (!raw) return false;
  const key = (a: string) => (chain === 'solana' ? a.trim() : a.trim().toLowerCase());
  return list.some((r) => r.chain === chain && key(r.pool) === key(raw));
}

/**
 * Streamflow pools the venue no longer offers that still hold stakers' positions.
 * No card reads them; held-through.json lists them as retired.
 */
export const RETIRED_STAKE_POOLS: readonly { bungalow: string; chain: 'solana'; pool: string }[] = [
  { bungalow: 'bayla', chain: 'solana', pool: '4WCpdeQ2pKLNECNDTXepwsdeePZPoNCp9AQqfACNGXPp' },
];

/** A settled resident in the placeholder skin: registry facts only, no invented lore. The venue speaks
 *  the token while the island's classic art holds the walls until the community's own drop. */
function settledIdentity(
  name: string,
  symbol: string,
  chainWord: string,
  communityLabel?: string,
): BungalowIdentity {
  return {
    heroTitle: `${symbol}.`,
    heroLine: 'Settled on Jungle Bay Island.',
    heroCopy:
      `${name} holds a bungalow on Jungle Bay Island, living on ${chainWord}. ` +
      `The venue speaks ${symbol} today: trade route, scanner, held-time heat ` +
      `and the live market all work right now, while the walls wear the ` +
      `island's classic art until ${name}'s community brings its own drop.`,
    museLine: 'Built brick by brick by its people.',
    museBy: communityLabel ?? 'Jungle Bay Island',
    museVoice: 'the island',
  };
}

// Door art leads with the collective's characters, never empty scenery; the doors, the
// picker and the venue hall all read these thumbs from here.
export const BUNGALOWS: Bungalow[] = [
  {
    id: 'toweli',
    name: 'Toweli',
    symbol: 'TOWELI',
    chain: 'ethereum',
    address: TOWELI_ADDRESS,
    status: 'SETTLED',
    tagline: 'The original bungalow. Classic Tegridy art.',
    accent: '#6fd9a8',
    swapUrl: `https://app.uniswap.org/swap?outputCurrency=${TOWELI_ADDRESS}&chain=mainnet`,
    thumb: '/art/bobowelie.jpg',
    live: true,
  },
  {
    id: 'bayla',
    name: 'Bayla',
    symbol: 'BAYLA',
    chain: 'solana',
    address: BAYLA_MINT,
    status: 'NEWEST',
    tagline: 'The muse was always here.',
    accent: '#8ef0d8',
    swapUrl: `https://jup.ag/swap/SOL-${BAYLA_MINT}`,
    // PumpSwap is the graduated pump.fun pool; the Meteora leg pairs her with TBBB.
    pools: [
      { label: 'BAYLA / SOL · PumpSwap', url: 'https://dexscreener.com/solana/8z52phbctyyw8fsmbbz9kewy2n1w4ucgjc9vcsjypk2n' },
      { label: 'BAYLA / TBBB · Meteora', url: 'https://dexscreener.com/solana/bo16t7xgbdta2jdrozqhqnsvsb2irhgbydhmsvsr72wv' },
    ],
    // GeckoTerminal's id for the PumpSwap pool; market_cap_usd reads null upstream, so the strip shows FDV.
    market: {
      network: 'solana',
      pool: '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n',
      label: 'BAYLA / SOL · PumpSwap',
    },
    thumb: '/art/bayla/bayla-14.jpg',
    artPool: BAYLA_ART,
    stakePool: BAYLA_STAKE_POOL,
    ladderPool: BAYLA_LADDER_POOL || undefined,
    // Retiring for `bayla-ladder`: positions keep claim, unstake and rescue; only the stake form goes.
    depositsClosed: true,
    // Token-2022, 6 decimals, no transfer-fee extension: staked and claimed amounts are exact.
    decimals: 6,
    live: true,
    identity: {
      heroTitle: 'BAYLA.',
      heroLine: 'The muse was always here.',
      heroCopy:
        'Bayla is the muse of Jungle Bay Island, brought to light by the Jungle Bay ' +
        'Artists Collective, living on Solana, seated at the lighthouse. Her pull ' +
        'reaches every kind of maker. Trade her, hold her for heat, and stake at the ' +
        // Spelled out: this is the first paragraph a stranger reads here.
        'lighthouse: the pool is live on-chain. Dank Memes + Time = Memetic Finance.',
      museLine: 'The work is yours. The light is hers.',
      museBy: 'Jungle Bay Artists Collective',
      museLines: [
        'The work is yours. The light is hers.',
        'The muse was always here.',
        'Her pull reaches every kind of maker.',
        'Time held is what counts.',
        'Dank Memes + Time = Memetic Finance.',
      ],
      museVoice: 'the muse',
      // Canon copy (pump.fun metadata and the island landing).
      lore: {
        title: 'The muse of Jungle Bay Island',
        paragraphs: [
          'An island in a sea of rugs, built by the memes: bungalows for token ' +
          'communities, an artist economy, and time held is what counts. Bayla is ' +
          'its muse: brought to light by the Jungle Bay Artists Collective, seated ' +
          'at the lighthouse, the newest name on the island map.',
          'Her pull reaches every kind of maker. The work is yours. The light is ' +
          'hers. Dank Memes + Time = Memetic Finance.',
        ],
        links: [
          { href: 'https://memetics.wtf/', label: 'The island' },
          { href: 'https://opensea.io/collection/junglebay', label: 'Jungle Bay on OpenSea' },
          { href: 'https://x.com/JungleBayAC', label: '@JungleBayAC' },
        ],
      },
    },
  },
  // ——— The settled residents (island canon order) ———
  // Ticker collisions are real: verify each mint on chain, and its FDV and volume, before wiring a pool.
  // market = the deepest active GeckoTerminal pool; swapUrl = the island's fallback (Dexscreener, Jupiter).
  { id: 'pepe', name: 'Pepe', symbol: 'PEPE', chain: 'ethereum', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#5f9e6e', swapUrl: 'https://dexscreener.com/ethereum/0x6982508145454ce325ddbe47a25d4ec3d2311933', thumbPosition: '50% 22%', thumb: '/art/mumu-bull.jpg', community: { label: 'pepe.vip', url: 'https://pepe.vip' }, decimals: 18, market: { network: 'eth', pool: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f', label: 'PEPE / WETH · Uniswap' }, stakePool: '0xBE1905de5FCDe60E13a9F1AfA44BEfdE1C5aaA1D', poolKind: 'ladder', artPool: bungalowArtFor('pepe', 'Pepe'), live: true, identity: settledIdentity('PEPE', 'PEPE', 'Ethereum') },
  { id: 'qr', name: 'QR', symbol: 'QR', chain: 'base', address: '0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#8f8f8f', swapUrl: 'https://dexscreener.com/base/0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf', thumbPosition: '50% 30%', thumb: '/art/gallery-collage.jpg', community: { label: 'qrcoin.fun', url: 'https://qrcoin.fun' }, decimals: 18, market: { network: 'base', pool: '0xf02c421e15abdf2008bb6577336b0f3d7aec98f0', label: 'QR / WETH' }, stakePool: '0x55B72f09d31f43834bf7Eba42f53a419a716F554', poolKind: 'ladder', artPool: bungalowArtFor('qr', 'QR'), live: true, identity: settledIdentity('QR', 'QR', 'Base', 'qrcoin.fun') },
  { id: 'mfer', name: 'MFER', symbol: 'MFER', chain: 'base', address: '0xe3086852a4b125803c815a158249ae468a3254ca', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#b8b8b8', swapUrl: 'https://dexscreener.com/base/0xe3086852a4b125803c815a158249ae468a3254ca', thumbPosition: '50% 26%', thumb: '/art/mfers-heaven.jpg', decimals: 18, market: { network: 'base', pool: '0xb08a99ab559e5456907278727a3b0d968c0a313b', label: '$MFER / WETH' }, stakePool: '0xeCB3C54488A2A0dF764444f67B2Df6b8Ad4EaDd6', poolKind: 'ladder', artPool: bungalowArtFor('mfer', 'MFER'), live: true, identity: settledIdentity('MFER', 'MFER', 'Base') },
  { id: 'bnkr', name: 'BNKR', symbol: 'BNKR', chain: 'base', address: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#4ac9a8', swapUrl: 'https://dexscreener.com/base/0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', thumbPosition: '50% 18%', thumb: '/art/wrestler.jpg', community: { label: 'bankr.bot', url: 'https://bankr.bot' }, decimals: 18, market: { network: 'base', pool: '0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703', label: 'BNKR / WETH' }, stakePool: '0xe6abC8AcA0415aFaC426ec1242BB17afABe8Dbcf', poolKind: 'ladder', artPool: bungalowArtFor('bnkr', 'BNKR'), live: true, identity: settledIdentity('BNKR', 'BNKR', 'Base') },
  { id: 'drb', name: 'DRB', symbol: 'DRB', chain: 'base', address: '0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#d4b168', swapUrl: 'https://dexscreener.com/base/0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2', thumbPosition: '50% 28%', thumb: '/art/boxing-ring.jpg', community: { label: 'drb task force', url: 'https://bio.site/drbtaskforce' }, decimals: 18, market: { network: 'base', pool: '0x5116773e18a9c7bb03ebb961b38678e45e238923', label: 'DRB / WETH' }, stakePool: '0x0aCB93fcFD5b1950D94064998017a2601b36D7bB', poolKind: 'ladder', artPool: bungalowArtFor('drb', 'DRB'), live: true, identity: settledIdentity('DRB', 'DRB', 'Base', 'drb task force') },
  { id: 'bobo', name: 'BOBO', symbol: 'BOBO', chain: 'solana', address: '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump', status: 'SETTLED · hammers up', tagline: 'Built brick by brick by its people.', accent: '#dcae60', swapUrl: 'https://jup.ag/swap/SOL-4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump', thumbPosition: '50% 32%', thumb: '/art/ape-hug.jpg', community: { label: 'bobothebear.io', url: 'https://bobothebear.io' }, decimals: 6, market: { network: 'solana', pool: '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX', label: 'BOBO / SOL' }, stakePool: 'PkwDYVNxyesAukE9STqRQL9H1pBpXbt1tVbiYVMX96w', artPool: bungalowArtFor('bobo', 'BOBO'), live: true, identity: settledIdentity('BOBO', 'BOBO', 'Solana', 'bobothebear.io') },
  { id: 'jbm', name: 'JBM', symbol: 'JBM', chain: 'base', address: '0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#ffd078', swapUrl: 'https://dexscreener.com/base/0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d', thumbPosition: '50% 24%', thumb: '/art/bus-crew.jpg', decimals: 18, market: { network: 'base', pool: '0xbc6156458bc948cba71dd0be99bfa472bd636331', label: 'JBM / WETH' }, stakePool: '0x3C339692ec7B3b96ad6F8fbEb5F5202164b44465', poolKind: 'ladder', artPool: bungalowArtFor('jbm', 'JBM'), live: true, identity: settledIdentity('JBM', 'JBM', 'Base') },
  { id: 'soy', name: 'SOY', symbol: 'SOY', chain: 'solana', address: '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#b5c95f', swapUrl: 'https://jup.ag/swap/SOL-8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump', thumbPosition: '50% 30%', thumb: '/art/dance-night.jpg', community: { label: 'SOY / SOL', url: 'https://soyjak.life' }, decimals: 6, market: { network: 'solana', pool: 'H8yiDq5XaNkiT6J3QXDeBVfsFHNaVwTRNicbWZnibexi', label: 'SOY / SOL' }, stakePool: '5hgUVCWW4fwM7oq3SQyaj5ucVQFa2dQ4YqQc4JqrGXHj', artPool: bungalowArtFor('soy', 'SOY'), live: true, identity: settledIdentity('SOY', 'SOY', 'Solana', 'soyjak.life') },
  { id: 'brainlet', name: 'Brainlet', symbol: 'BRAINLET', chain: 'solana', address: '4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#5fc9b0', swapUrl: 'https://jup.ag/swap/SOL-4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump', thumbPosition: '50% 30%', thumb: '/art/chaos-scene.jpg', community: { label: 'BRAINLET / SOL', url: 'https://x.com/brainletbadger' }, decimals: 6, market: { network: 'solana', pool: '3whYbw26asxFG5Qh9emHA6Mi6uizvduYg1cVKLQ1eetq', label: 'BRAINLET / SOL' }, stakePool: '2qSZBzjpxKzhJWmyaoN5kP3XQxUikH3SQR5suXuQjkZR', artPool: bungalowArtFor('brainlet', 'Brainlet'), live: true, identity: settledIdentity('Brainlet', 'BRAINLET', 'Solana', '@brainletbadger') },
  // RIZZ is the SOLANA mint below: a Base deployment carries the same name and symbol.
  { id: 'rizz', name: 'RIZZ', symbol: 'RIZZ', chain: 'solana', address: '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#7fe0b0', swapUrl: 'https://jup.ag/swap/SOL-5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k', thumbPosition: '50% 30%', thumb: '/art/rose-ape.jpg', decimals: 6, market: { network: 'solana', pool: 'dgaDYLCP67MqAzt28WAYtE6pYCHUbRMHtWYLniH1DaL', label: 'RIZZ / SOL' }, stakePool: 'BZ1rGCD8G5kXyKkXxmNh2Xf92QLz4PUZitzauMEdxd5c', artPool: bungalowArtFor('rizz', 'RIZZ'), live: true, identity: settledIdentity('RIZZ', 'RIZZ', 'Solana') },
  // ——— The quiet one ———
  { id: 'nb1', name: 'Unmarked', symbol: '?', chain: 'tbd', status: 'QUIET', tagline: 'Someone is building here.', accent: '#f2ffe9', thumb: '/art/jungle-dark.jpg', live: false },
];

/** Storage key. Survives quota eviction only because storage.ts lists it in EVICTION_PROTECTED_KEYS. */
export const BUNGALOW_STORAGE_KEY = 'tegridy-bungalow';

/** Custom event the footer (or anything else) dispatches to reopen the picker. */
export const OPEN_BUNGALOWS_EVENT = 'tegridy:open-bungalows';

/** Asks for a bungalow's three-step welcome, which opens only on request (like OPEN_VENUE_WELCOME_EVENT). */
export const OPEN_BUNGALOW_ABOUT_EVENT = 'tegridy:open-bungalow-about';

/** Surfaces with classic art in every bungalow: nav-logo (the venue's way-back mark) and loader (the
 *  shared intro). They may be read at module scope; src/lib/skinIsState.test.ts exempts exactly these. */
const SHARED_SURFACES = new Set(['nav-logo', 'loader']);

function byId(id: string | null): Bungalow | null {
  if (!id) return null;
  const b = BUNGALOWS.find((x) => x.id === id);
  return b && b.live ? b : null;
}

/**
 * The active bungalow: `?bungalow=<id>` (live; persisted on read so a deep link sticks), then the stored
 * choice, then null (the venue). The query is parsed once per distinct string; storage is NOT memoised,
 * because other code writes the key directly and a door reads its own write back on the same render.
 */
let queryCache: { search: string; bungalow: string | null } | null = null;

function bungalowFromQuery(): string | null {
  const search = window.location.search;
  if (queryCache === null || queryCache.search !== search) {
    queryCache = { search, bungalow: new URLSearchParams(search).get('bungalow') };
  }
  return queryCache.bungalow;
}

export function getActiveBungalow(): Bungalow | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromUrl = byId(bungalowFromQuery());
    if (fromUrl) {
      if (safeGetItem(BUNGALOW_STORAGE_KEY) !== fromUrl.id) {
        safeSetItem(BUNGALOW_STORAGE_KEY, fromUrl.id);
      }
      return fromUrl;
    }
  } catch { /* URLSearchParams unavailable — fall through to storage */ }
  return byId(safeGetItem(BUNGALOW_STORAGE_KEY));
}

/** The active bungalow when it speaks for itself (non-default, with an identity): the token-first gate. */
export function getBungalowIdentity(): (Bungalow & { identity: BungalowIdentity }) | null {
  const b = getActiveBungalow();
  if (!b || b.id === DEFAULT_BUNGALOW_ID || !b.identity) return null;
  return b as Bungalow & { identity: BungalowIdentity };
}

/** True once the visitor has made any bungalow choice (including the default). */
export function hasChosenBungalow(): boolean {
  return safeGetItem(BUNGALOW_STORAGE_KEY) !== null;
}

/** Persist a choice. Silent, so a door may call it during render; announce after commit. */
export function setActiveBungalow(id: string): boolean {
  return safeSetItem(BUNGALOW_STORAGE_KEY, id);
}

const skinListeners = new Set<() => void>();

/** Subscribe to skin changes (useActiveBungalowId). Returns the unsubscribe. */
export function subscribeActiveBungalow(listener: () => void): () => void {
  skinListeners.add(listener);
  return () => {
    skinListeners.delete(listener);
  };
}

/** Tells subscribers to re-read the skin; each re-renders only if its value moved. */
export function announceActiveBungalow(): void {
  for (const listener of [...skinListeners]) listener();
}

/** The pool pageArt draws this surface from; null for no pool, the default bungalow or a shared surface. */
export function bungalowArtPool(pageId: string): ArtPiece[] | null {
  return bungalowArtContext(pageId)?.pool ?? null;
}

/** bungalowArtPool plus WHICH bungalow owns the pool, for its per-surface overrides, in one read. */
export function bungalowArtContext(pageId: string): { id: string; pool: ArtPiece[] } | null {
  if (SHARED_SURFACES.has(pageId)) return null;
  const active = getActiveBungalow();
  if (!active || !active.artPool || active.artPool.length === 0) return null;
  return { id: active.id, pool: active.artPool };
}

/** Where a bungalow's token trades: the in-venue Solana swap when configured, else the canon link, as
 *  { to } (router) or { href, kind }. A Dexscreener page is a CHART: it trades nothing, so it says so. */
export function bungalowTradeRoute(
  b: Bungalow,
  solanaConfigured: boolean,
): { to: string } | { href: string; kind: 'swap' | 'chart' } | null {
  if (b.chain === 'solana' && b.address && solanaConfigured) {
    return { to: `/solana?out=${b.address}` };
  }
  if (!b.swapUrl) return null;
  return { href: b.swapUrl, kind: isDexscreenerUrl(b.swapUrl) ? 'chart' : 'swap' };
}

/** Host-anchored, so evil.com/dexscreener.com/… does not match (CodeQL js/regex/missing-regexp-anchor). */
function isDexscreenerUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'dexscreener.com' || host.endsWith('.dexscreener.com');
  } catch {
    return false;
  }
}

/** In-venue scanner route. Base carries the explicit chain: a 0x address is ambiguous with Ethereum. */
export function bungalowScanRoute(b: Bungalow): string | null {
  if (!b.address) return null;
  if (b.chain === 'base') return `/scan?token=${b.address}&chain=base`;
  if (b.chain === 'ethereum' || b.chain === 'solana') return `/scan?token=${b.address}`;
  return null;
}

/** The one sentence on where a resident's token trades, shared by the footer and the meta description.
 *  It names the real chain, and says "lives on", not "trade", when the only route is a chart. */
export function bungalowTradeBlurb(b: Bungalow, solanaSwapLive: boolean): string {
  const chainWord =
    b.chain === 'solana' ? 'Solana' : b.chain === 'base' ? 'Base' : b.chain === 'ethereum' ? 'Ethereum' : '';
  const route = bungalowTradeRoute(b, solanaSwapLive);
  if (!route || !chainWord) return `${b.symbol} lives on Jungle Bay Island; scan any token on either chain.`;
  // An in-venue router path (or a real external swap) is a place you can trade.
  const tradable = 'to' in route || route.kind === 'swap';
  return tradable
    ? `Trade ${b.symbol} on ${chainWord}; scan any token on either chain.`
    : `${b.symbol} lives on ${chainWord}. Chart and contract on its page; scan any token on either chain.`;
}

/** The island resident behind a market pool, or null. EVM addresses compare case-insensitively,
 *  Solana keys EXACTLY (base58 is case-significant). */
export function residentLabelForPool(network: GeckoNetwork, pool: string): string | null {
  const target = network === 'solana' ? pool.trim() : pool.trim().toLowerCase();
  if (!target) return null;
  for (const b of BUNGALOWS) {
    const m = b.market;
    if (!m || m.network !== network) continue;
    const known = network === 'solana' ? m.pool : m.pool.toLowerCase();
    if (known === target) return b.name;
  }
  return null;
}

/** The room a token belongs to, by chain WORD (Solana has no numeric chain id here), compared like
 *  residentLabelForPool. No room is ETH, so the native pseudo-address cannot match; bungalows.test.ts
 *  pins that on the registry. */
export function bungalowByAddress(chain: Bungalow['chain'], address: string): Bungalow | null {
  const raw = address.trim();
  if (!raw) return null;
  const target = chain === 'solana' ? raw : raw.toLowerCase();
  for (const b of BUNGALOWS) {
    if (!b.address || b.chain !== chain) continue;
    const known = chain === 'solana' ? b.address.trim() : b.address.trim().toLowerCase();
    if (known === target) return b;
  }
  return null;
}

/** Block-explorer link for a bungalow's token, per its chain. */
export function bungalowExplorerUrl(b: Bungalow): string | null {
  if (!b.address) return null;
  switch (b.chain) {
    case 'ethereum': return `https://etherscan.io/token/${b.address}`;
    case 'base': return `https://basescan.org/token/${b.address}`;
    case 'solana': return `https://solscan.io/token/${b.address}`;
    default: return null;
  }
}

/**
 * Owner, 2026-09-21: a Streamflow pool closed in favour of the ladder is shown only to
 * wallets still staked in it. Every UI surface naming the pool asks this. It needs the
 * ladder too: with none configured, hiding the pool would leave no pool at all. Machine
 * surfaces (held-through.json, llms.txt, ISLAND_READ_POOLS) keep listing it.
 */
export function stakePoolMembersOnly<T extends { chain: string; stakePool?: string; ladderPool?: string; depositsClosed?: true }>(
  b: T,
): b is T & { stakePool: string; ladderPool: string } {
  return b.chain === 'solana' && Boolean(b.stakePool) && Boolean(b.ladderPool) && b.depositsClosed === true;
}
