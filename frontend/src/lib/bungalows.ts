import type { ArtPiece } from './artConfig';
import type { GeckoNetwork } from './geckoTerminal/pools';
import { BUNGALOW_ART_FILES } from './bungalowArtPools';
import { safeGetItem, safeSetItem } from './storage';
import { TOWELI_ADDRESS } from './constants';

/**
 * Jungle Bay Island — the 13 bungalows.
 *
 * "An island in a sea of rugs. Built by the memes. Bungalows for token
 * communities, an artist economy, and time held is what counts." — the
 * island's own landing (memetics.wtf).
 *
 * The roster below is the island's PUBLISHED canon, read from memetics.wtf's
 * SPOTS + SIGNSV2 registries on 2026-08-24: twelve settled/named token
 * bungalows across Ethereum, Base and Solana, plus one unmarked bungalow
 * ("Someone is building here."). Addresses come from the island's painter
 * SIGNS canon verbatim — never guess or "fix" one; if the island updates,
 * re-read the source.
 *
 * Entering a bungalow re-skins the app: every `pageArt()` BACKGROUND surface
 * draws from that bungalow's art pool, and (for bungalows that carry an
 * `identity`) the hero, farm surface and footer contract card speak that
 * token instead of TOWELI. Buttons, nav chrome, rails and contracts never
 * change. The classic Towelie skin is the untouched default.
 *
 * Design constraints, in order:
 *  - Additive only (feedback_preserve_art) — classic art/copy is layered
 *    over, never edited.
 *  - Zero per-surface edits for art: `pageArt()` is the single choke point.
 *  - Synchronous resolution: `pageArt()` runs at module scope in places, so
 *    the active bungalow is a plain localStorage/query read, and switching
 *    is persist + reload.
 */
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
  /** Rotation pool of canon lines. Absent -> [museLine]. Island canon: retained
   *  in the registry, but no venue surface paints it since wave seven element E
   *  retired the floating muse bubble. The hero pill paints museLine/museBy. */
  museLines?: readonly string[];
  /** Byline persona (e.g. 'the muse'). Absent -> museBy. Island canon, kept
   *  and pinned by bungalows.test.ts; unpainted since element E. */
  museVoice?: string;
  /**
   * The resident's story card on the home page (rendered only in its own
   * skin). Absent -> no lore card, which is the honest default: the card
   * holds CANON copy from the community's own material, never invented.
   */
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
  /** Door-art focal point (CSS object-position) for hall + picker tiles.
   *  ISLAND ART PASS 2026-08-31: set by eye so each door leads with its
   *  character's face, not a crop of chest or scenery. */
  thumbPosition?: string;
  /** External trade deep link (canon pattern: Uniswap for TOWELI, Jupiter here). */
  swapUrl?: string;
  /** Live liquidity pools for this token (labels + external pair pages). */
  pools?: { label: string; url: string }[];
  /** The community's own home (site or X), from the island outreach dossier. */
  community?: { label: string; url: string };
  /**
   * Streamflow stake-pool address — the lighthouse pool. Env-keyed so the
   * operator lights it up with a Vercel env var + redeploy, no code commit:
   * the ceremony ends with pasting the pool address into
   * VITE_BAYLA_STAKE_POOL. Absent → the farm panel keeps its honest
   * "Not deployed yet" card. FUNDING-LAST: the pool may go live with an
   * empty reward vault; the live section renders that as a labeled zero.
   */
  stakePool?: string;
  /**
   * Which staking program `stakePool` is. Solana pools are always Streamflow.
   * EVM pools come in two shapes and the card must follow the CONTRACT, never
   * a guess: 'plain' = the vendored no-lock Synthetix staker (the first 2026
   * -08-30 round), 'ladder' = LighthouseLadder, the locked 0d..4y / 1.00x..
   * 4.00x build with the always-open emergency hatch. Absent = 'plain'.
   */
  poolKind?: 'plain' | 'ladder';
  /**
   * Token decimals as a PRE-READ fallback for staking/balance surfaces —
   * the live pool read still wins (it reads the mint on-chain); this field
   * covers the window before that read lands, where a bare hardcoded 6
   * would show a 9-decimal mint 1000× off.
   */
  decimals?: number;
  /**
   * The pool the bungalow's price chart + market strip read, as GeckoTerminal
   * identifies it. Undefined = no market surface (the honest state for a
   * bungalow whose token has no indexed pool).
   *
   * This is the PRIMARY pool, not the whole list: `pools` above is a set of
   * outbound links, and a chart has to name one pair. Bayla's is the graduated
   * pump.fun pool on PumpSwap — the deepest of her two by liquidity.
   *
   * `network` is GeckoTerminal's API slug, NOT this registry's `chain` word:
   * Ethereum is `eth` here (interpolated verbatim into GT URLs, where a wrong
   * slug is a silent 404). The union is closed so a typo'd entry cannot compile
   * — and it is now the SHARED `GeckoNetwork`, so a resident's pool can be
   * handed to the market readers with no adapter in between.
   */
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

/**
 * A bungalow's own background pool, built from public/art/<id>/ via the
 * generated manifest (scripts/gen-bungalow-art.mjs scans the real directory).
 *
 * THE PIECE ID IS THE FILENAME, NOT THE INDEX. This is load-bearing:
 * bungalowArtOverrides.ts stores the curator's placements BY artId
 * ("bayla|home:0" -> artId "bayla-05"), so an index-derived id would silently
 * repoint every saved placement the moment a folder gains a file. Deriving the
 * id from the filename keeps every existing placement valid and makes newly
 * dropped art addressable without touching the studio's saved work.
 */
export function bungalowArtFor(id: string, name: string): ArtPiece[] | undefined {
  const files = BUNGALOW_ART_FILES[id];
  if (!files?.length) return undefined;
  return files.map((f, i) => ({
    id: f.replace(/\.[^.]+$/, ''),
    src: `/art/${id}/${f}`,
    title: `${name} #${String(i + 1).padStart(2, '0')}`,
    description: `${name} bungalow — Jungle Bay Island`,
  }));
}

/** Bayla background pool — /public/art/bayla (the 2026-08-24 drop plus the
 *  2026-08-31 folder). Also the venue arrival's intro gallery (lib/arrival.ts). */
export const BAYLA_ART: ArtPiece[] = bungalowArtFor('bayla', 'Bayla') ?? [];

export const DEFAULT_BUNGALOW_ID = 'toweli';

export const BAYLA_MINT = '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump';

// The lighthouse pool — REPLACED ON MAINNET 2026-08-30 (signer GCCSLE7d…auV9,
// Token-2022 detected), nonce 1:
//   stake pool  EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f
//     (tx 5zBxY9wzvg6C3JHVUh2BAK7nVGn3xSo18Hboib2FZRDV4X6J3BQD1c1hicB6spjE9zrT1XXnbRRYyHw8LcwXjz86)
//   reward pool 3ysyH5py46Q4XUXkumGy3DhWjPbNVhLMfQZmpQMdDruf — 0.0006 BAYLA per
//     staked BAYLA per day at 1.00x, permissionless public funding
//     (tx 4gVcSQR52Jh3wXyeLpDEBUm6yLKVdkU5Gi8KX5SV6kooWsg8aw6kmB2pCFBjrqK3UoVpTWeWG1JWK85AiYpQuBx1)
//
// WHY IT WAS REPLACED: the first pool (4WCpdeQ2…GXPp, 2026-08-26) was created
// with maxWeight == 1.00x, so its 1-365 day lock picker bought nothing — every
// duration earned the same rate. maxWeight is a stake-pool field with no update
// instruction, so the only fix was a new pool at a fresh nonce. This one ramps
// 1.00x → 5.00x across 1-365 days, making the ladder real: ~21.9% APR liquid,
// ~109.5% for a full year. The old pool still holds the operator's own 1,000
// BAYLA dust-test stake, locked until ~2027-08-29 (nothing can release it —
// see BAYLA_BUNGALOW.md §5b), and is otherwise abandoned.
//
// The address ships hardcoded so no env var is load-bearing; the env override
// remains for emergencies (pointing staging at a test pool, or dark-switching
// by setting it to an empty-but-present value is NOT supported — the fallback
// wins whenever the env is unset/blank). ⚠️ If VITE_BAYLA_STAKE_POOL is set in
// Vercel it WINS over this constant — it must be unset or updated to match.
const BAYLA_STAKE_POOL =
  (import.meta.env?.VITE_BAYLA_STAKE_POOL as string | undefined)?.trim()
  || 'EFWpSpH9rU6jGqpMPpo9VavMdBd64CdodakaJtCXEZ9f';

/**
 * Identity for a settled resident wearing the PLACEHOLDER skin (owner call,
 * 2026-08-30: "put something on so at least they are functional; we will
 * custom art them later"). Honest by construction — registry facts only, no
 * invented lore: the venue speaks the token, the classic island art holds
 * every wall (no artPool = pageArt's classic fallback), and the copy says
 * exactly that. The community's own drop later replaces the walls, not the
 * rails. museBy credits the community's named home when the dossier has one;
 * museVoice keeps the bubble's byline the island's, never another resident's.
 */
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
      `The venue speaks ${symbol} today — trade route, scanner, held-time heat ` +
      `and the live market all work right now — while the walls wear the ` +
      `island's classic art until ${name}'s community brings its own drop.`,
    museLine: 'Built brick by brick by its people.',
    museBy: communityLabel ?? 'Jungle Bay Island',
    museVoice: 'the island',
  };
}

// ISLAND ART PASS 2026-08-31 (seat order: works over scenery -- door art starts
// from the collective's CHARACTERS, never empty landscapes; canon returned to
// its owner): PEPE wears Mumu the Bull (Pepe-lore's own bull), DRB takes back
// Fight Night ("Der Bar enters the ring" -- his own piece, per artConfig's
// description and the roster dossier), BNKR gets The Wrestler, JBM rolls with
// The Crew, BRAINLET wears Chaos, RIZZ offers the Rose Ape. Bungalow doors,
// the picker and the venue hall all read these thumbs from here.
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
    // Live pairs read from Dexscreener 2026-08-24 (pumpswap = the graduated
    // pump.fun pool; the Meteora DYN2 leg pairs her with TBBB).
    pools: [
      { label: 'BAYLA / SOL · PumpSwap', url: 'https://dexscreener.com/solana/8z52phbctyyw8fsmbbz9kewy2n1w4ucgjc9vcsjypk2n' },
      { label: 'BAYLA / TBBB · Meteora', url: 'https://dexscreener.com/solana/bo16t7xgbdta2jdrozqhqnsvsb2irhgbydhmsvsr72wv' },
    ],
    // GeckoTerminal's own id for the PumpSwap pool above (same address, checksum
    // -insensitive). Verified live 2026-08-28: price, FDV, reserve, 24h volume
    // and the buy/sell split all read. `market_cap_usd` comes back null — she
    // has no circulating-supply record upstream, so the strip shows FDV.
    market: {
      network: 'solana',
      pool: '8z52phbctYyW8FsMbbz9KeWY2n1W4ucGJc9vCsjYpK2n',
      label: 'BAYLA / SOL · PumpSwap',
    },
    thumb: '/art/bayla/bayla-14.jpg',
    artPool: BAYLA_ART,
    stakePool: BAYLA_STAKE_POOL,
    // 6 per the mint itself — verified 2026-08-28 against mainnet
    // (getAccountInfo jsonParsed): owner Token-2022, decimals 6, extensions
    // [metadataPointer, tokenMetadata] only — NO transfer-fee extension, so
    // staked/claimed amounts are exact.
    decimals: 6,
    live: true,
    identity: {
      heroTitle: 'BAYLA.',
      heroLine: 'The muse was always here.',
      heroCopy:
        'Bayla is the muse of Jungle Bay Island — brought to light by the Jungle Bay ' +
        'Artists Collective, living on Solana, seated at the lighthouse. Her pull ' +
        'reaches every kind of maker. Trade her, hold her for heat, and stake at the ' +
        // SPELLED OUT, 2026-09-05. This closed on the bare acronym "DM+T", in the
        // FIRST paragraph a stranger reads on this bungalow's hero — a term the
        // page never defines above it. The expansion was already canon two keys
        // below (museLines) and again in `lore`, so this introduces no new
        // vocabulary; it just stops the hero assuming the reader arrived fluent.
        'lighthouse — the pool is live on-chain. Dank Memes + Time = Memetic Finance.',
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
      // Canon copy (pump.fun metadata + the island landing) — moved verbatim
      // from the HomePage card when the card went registry-driven (WO-1).
      lore: {
        title: 'The muse of Jungle Bay Island',
        paragraphs: [
          'An island in a sea of rugs, built by the memes — bungalows for token ' +
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
  // ⚠ TICKER COLLISIONS ARE REAL AND SILENT (RIZZ, SOY, BRAINLET — all three
  // corrected by the owner 2026-08-30). Each dossier row pointed at a token
  // carrying the SAME name and SAME symbol as the island's actual resident,
  // so a name/symbol check passes on both. What separated them was market
  // scale (the real SOY 4.6x the impostor's FDV and 12x its volume; BRAINLET
  // 7.3x / 16x) plus the owner's own knowledge. NEVER take a memecoin address
  // from a scrape or a dossier as settled: verify the mint on-chain AND sanity
  // -check FDV/volume against the community's own links before wiring a
  // market — and certainly before deploying a stake pool against it.
  // market = the deepest ACTIVE GeckoTerminal pool per token, read 2026-08-30
  // (JBM + RIZZ gained indexed pools since the 08-25 dossier said none —
  // numbers move). The strip/chart/tape read live from these ids.
  // swapUrl follows the island's own swapUrlFor fallback (dexscreener
  // <chain>/<ca>) for EVM tokens, and the Jupiter deep-link pattern (same as
  // Bayla's canon) for Solana ones — bungalowTradeRoute() prefers the
  // in-venue /solana preset over these whenever that surface is configured.
  // Dormant until each slot flips live. Market notes (2026-08-25 reads) live
  // in docs/ISLAND_ROSTER_DOSSIER.md — JBM and RIZZ had no indexed pairs
  // that day, so their swapUrl stays the canon fallback page regardless.
  { id: 'pepe', name: 'Pepe', symbol: 'PEPE', chain: 'ethereum', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#5f9e6e', swapUrl: 'https://dexscreener.com/ethereum/0x6982508145454ce325ddbe47a25d4ec3d2311933', thumbPosition: '50% 22%', thumb: '/art/mumu-bull.jpg', community: { label: 'pepe.vip', url: 'https://pepe.vip' }, market: { network: 'eth', pool: '0xa43fe16908251ee70ef74718545e4fe6c5ccec9f', label: 'PEPE / WETH · Uniswap' }, stakePool: '0xBE1905de5FCDe60E13a9F1AfA44BEfdE1C5aaA1D', poolKind: 'ladder', artPool: bungalowArtFor('pepe', 'Pepe'), live: true, identity: settledIdentity('PEPE', 'PEPE', 'Ethereum') },
  { id: 'qr', name: 'QR', symbol: 'QR', chain: 'base', address: '0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#8f8f8f', swapUrl: 'https://dexscreener.com/base/0x2b5050f01d64fbb3e4ac44dc07f0732bfb5ecadf', thumbPosition: '50% 30%', thumb: '/art/gallery-collage.jpg', community: { label: 'qrcoin.fun', url: 'https://qrcoin.fun' }, market: { network: 'base', pool: '0xf02c421e15abdf2008bb6577336b0f3d7aec98f0', label: 'QR / WETH' }, stakePool: '0x55B72f09d31f43834bf7Eba42f53a419a716F554', poolKind: 'ladder', live: true, identity: settledIdentity('QR', 'QR', 'Base', 'qrcoin.fun') },
  { id: 'mfer', name: 'MFER', symbol: 'MFER', chain: 'base', address: '0xe3086852a4b125803c815a158249ae468a3254ca', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#b8b8b8', swapUrl: 'https://dexscreener.com/base/0xe3086852a4b125803c815a158249ae468a3254ca', thumbPosition: '50% 26%', thumb: '/art/mfers-heaven.jpg', market: { network: 'base', pool: '0xb08a99ab559e5456907278727a3b0d968c0a313b', label: '$MFER / WETH' }, stakePool: '0xeCB3C54488A2A0dF764444f67B2Df6b8Ad4EaDd6', poolKind: 'ladder', artPool: bungalowArtFor('mfer', 'MFER'), live: true, identity: settledIdentity('MFER', 'MFER', 'Base') },
  { id: 'bnkr', name: 'BNKR', symbol: 'BNKR', chain: 'base', address: '0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#4ac9a8', swapUrl: 'https://dexscreener.com/base/0x22af33fe49fd1fa80c7149773dde5890d3c76f3b', thumbPosition: '50% 18%', thumb: '/art/wrestler.jpg', community: { label: 'bankr.bot', url: 'https://bankr.bot' }, market: { network: 'base', pool: '0xaec085e5a5ce8d96a7bdd3eb3a62445d4f6ce703', label: 'BNKR / WETH' }, stakePool: '0xe6abC8AcA0415aFaC426ec1242BB17afABe8Dbcf', poolKind: 'ladder', artPool: bungalowArtFor('bnkr', 'BNKR'), live: true, identity: settledIdentity('BNKR', 'BNKR', 'Base') },
  { id: 'drb', name: 'DRB', symbol: 'DRB', chain: 'base', address: '0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#d4b168', swapUrl: 'https://dexscreener.com/base/0x3ec2156d4c0a9cbdab4a016633b7bcf6a8d68ea2', thumbPosition: '50% 28%', thumb: '/art/boxing-ring.jpg', community: { label: 'drb task force', url: 'https://bio.site/drbtaskforce' }, market: { network: 'base', pool: '0x5116773e18a9c7bb03ebb961b38678e45e238923', label: 'DRB / WETH' }, stakePool: '0x0aCB93fcFD5b1950D94064998017a2601b36D7bB', poolKind: 'ladder', artPool: bungalowArtFor('drb', 'DRB'), live: true, identity: settledIdentity('DRB', 'DRB', 'Base', 'drb task force') },
  { id: 'bobo', name: 'BOBO', symbol: 'BOBO', chain: 'solana', address: '4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump', status: 'SETTLED · hammers up', tagline: 'Built brick by brick by its people.', accent: '#dcae60', swapUrl: 'https://jup.ag/swap/SOL-4nV5gNwwP68zUDat26ySChREqVaQaLudfJBkSgEzpump', thumbPosition: '50% 32%', thumb: '/art/ape-hug.jpg', community: { label: 'bobothebear.io', url: 'https://bobothebear.io' }, market: { network: 'solana', pool: '31ZmTzEufRDBGKsJ7NicCkEKxtPQgAEMQvdbCuUfE6GX', label: 'BOBO / SOL' }, stakePool: 'PkwDYVNxyesAukE9STqRQL9H1pBpXbt1tVbiYVMX96w', artPool: bungalowArtFor('bobo', 'BOBO'), live: true, identity: settledIdentity('BOBO', 'BOBO', 'Solana', 'bobothebear.io') },
  { id: 'jbm', name: 'JBM', symbol: 'JBM', chain: 'base', address: '0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#ffd078', swapUrl: 'https://dexscreener.com/base/0x3313338fe4bb2a166b81483bfcb2d4a6a1ebba8d', thumbPosition: '50% 24%', thumb: '/art/bus-crew.jpg', market: { network: 'base', pool: '0xbc6156458bc948cba71dd0be99bfa472bd636331', label: 'JBM / WETH' }, stakePool: '0x3C339692ec7B3b96ad6F8fbEb5F5202164b44465', poolKind: 'ladder', artPool: bungalowArtFor('jbm', 'JBM'), live: true, identity: settledIdentity('JBM', 'JBM', 'Base') },
  { id: 'soy', name: 'SOY', symbol: 'SOY', chain: 'solana', address: '8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#b5c95f', swapUrl: 'https://jup.ag/swap/SOL-8zsZESzrGoYVi1dVH4QNWXJ2EfW4v287aEGNiDvQpump', thumbPosition: '50% 30%', thumb: '/art/dance-night.jpg', community: { label: 'SOY / SOL', url: 'https://soyjak.life' }, market: { network: 'solana', pool: 'H8yiDq5XaNkiT6J3QXDeBVfsFHNaVwTRNicbWZnibexi', label: 'SOY / SOL' }, stakePool: '5hgUVCWW4fwM7oq3SQyaj5ucVQFa2dQ4YqQc4JqrGXHj', artPool: bungalowArtFor('soy', 'SOY'), live: true, identity: settledIdentity('SOY', 'SOY', 'Solana', 'soyjak.life') },
  { id: 'brainlet', name: 'Brainlet', symbol: 'BRAINLET', chain: 'solana', address: '4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#5fc9b0', swapUrl: 'https://jup.ag/swap/SOL-4XKGjKaKowFvL5sYwh2AKx72vj9iwC8MNvpL44E9pump', thumbPosition: '50% 30%', thumb: '/art/chaos-scene.jpg', community: { label: 'BRAINLET / SOL', url: 'https://x.com/brainletbadger' }, market: { network: 'solana', pool: '3whYbw26asxFG5Qh9emHA6Mi6uizvduYg1cVKLQ1eetq', label: 'BRAINLET / SOL' }, stakePool: '2qSZBzjpxKzhJWmyaoN5kP3XQxUikH3SQR5suXuQjkZR', artPool: bungalowArtFor('brainlet', 'Brainlet'), live: true, identity: settledIdentity('Brainlet', 'BRAINLET', 'Solana', '@brainletbadger') },
    // ⚠ CHAIN + CONTRACT CORRECTED 2026-08-30 (owner). The 08-25 dossier had RIZZ
  // as Base 0x58d6e314…b238; that address is a DIFFERENT deployment of the same
  // brainrot name (verified on-chain: name "SigmaGyattOhioFanumSkibidiGooner",
  // symbol "Rizz" — and the Solana mint carries the identical name, so a
  // name check alone could never have caught it). The island's RIZZ is the
  // SOLANA mint below; the Base row would have staked the wrong token.
  { id: 'rizz', name: 'RIZZ', symbol: 'RIZZ', chain: 'solana', address: '5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k', status: 'SETTLED', tagline: 'Built brick by brick by its people.', accent: '#7fe0b0', swapUrl: 'https://jup.ag/swap/SOL-5ad4puH6yDBoeCcrQfwV5s9bxvPnAeWDoYDj3uLyBS8k', thumbPosition: '50% 30%', thumb: '/art/rose-ape.jpg', decimals: 6, market: { network: 'solana', pool: 'dgaDYLCP67MqAzt28WAYtE6pYCHUbRMHtWYLniH1DaL', label: 'RIZZ / SOL' }, stakePool: 'BZ1rGCD8G5kXyKkXxmNh2Xf92QLz4PUZitzauMEdxd5c', artPool: bungalowArtFor('rizz', 'RIZZ'), live: true, identity: settledIdentity('RIZZ', 'RIZZ', 'Solana') },
  // ——— The quiet one ———
  { id: 'nb1', name: 'Unmarked', symbol: '?', chain: 'tbd', status: 'QUIET', tagline: 'Someone is building here.', accent: '#f2ffe9', thumb: '/art/jungle-dark.jpg', live: false },
];

/**
 * Storage key. ⚠️ The tegridy- prefix makes a key EVICTABLE under quota
 * pressure (EVICTABLE_PREFIXES is the sweeper's allowlist, not a protection)
 * — this key survives only because storage.ts lists it in
 * EVICTION_PROTECTED_KEYS. A new choice-class key needs the same listing.
 */
export const BUNGALOW_STORAGE_KEY = 'tegridy-bungalow';

/** Custom event the footer (or anything else) dispatches to reopen the picker. */
export const OPEN_BUNGALOWS_EVENT = 'tegridy:open-bungalows';

/**
 * Ask for a bungalow's three-step welcome (wave seven, element E).
 *
 * The welcome used to open ITSELF on the first visit to every room. Nothing
 * opens over the page unasked any more, so the copy is not deleted — it moves
 * behind the room's own "About this bungalow" link and comes when invited.
 * Same shape as the venue's OPEN_VENUE_WELCOME_EVENT, deliberately: one
 * mechanism for "a modal exists only behind a tap", not two that can drift.
 */
export const OPEN_BUNGALOW_ABOUT_EVENT = 'tegridy:open-bungalow-about';

/**
 * Surfaces that keep classic art in EVERY bungalow:
 *  - nav-logo: the TopNav mark on the way-back link — the venue's identity, not
 *              a room's background. (It sat inside the splash-replay button until
 *              wave seven element A retired that button and re-homed the mark.)
 *  - loader:   the intro splash. The island intro is shared; the bungalow
 *              choice comes AFTER it (and its slide titles are hardcoded to
 *              the classic pieces).
 */
const SHARED_SURFACES = new Set(['nav-logo', 'loader']);

function byId(id: string | null): Bungalow | null {
  if (!id) return null;
  const b = BUNGALOWS.find((x) => x.id === id);
  return b && b.live ? b : null;
}

/**
 * The active bungalow, resolved synchronously:
 *  1. `?bungalow=<id>` (valid + live) — persisted immediately so the deep link
 *     sticks across navigation and reloads;
 *  2. the persisted choice;
 *  3. null (= default Towelie / classic art, and "no choice made yet").
 */
/**
 * `?bungalow=` from the current URL, parsing the query string at most once per
 * distinct query string.
 *
 * PERF-01 (2026-09-03): `getActiveBungalow()` is called from inside React render
 * bodies — `pageArt()` reaches it for every art surface, up to 18 per page render
 * across 192 call sites — and each call built a fresh `URLSearchParams` from
 * `window.location.search`.
 *
 * The cache key IS the whole input: `window.location.search` is the only thing
 * this function reads, so a hit is provably the same answer rather than a
 * plausible one. The storage read below is deliberately NOT memoised — three
 * places write that key without going through `setActiveBungalow`
 * (BungalowArtStudioPage's reset, the e2e harness, and the test suite), and
 * `BungalowDoor` depends on reading its own write back synchronously, so a memo
 * there would render one bungalow's art under another's name to save a
 * `localStorage.getItem`.
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

/**
 * The active bungalow when it speaks for itself (a non-default bungalow
 * carrying an `identity`) — the gate for token-first surfaces (hero, farm,
 * footer card) and for muting Towelie personality surfaces.
 */
export function getBungalowIdentity(): (Bungalow & { identity: BungalowIdentity }) | null {
  const b = getActiveBungalow();
  if (!b || b.id === DEFAULT_BUNGALOW_ID || !b.identity) return null;
  return b as Bungalow & { identity: BungalowIdentity };
}

/** True once the visitor has made any bungalow choice (including the default). */
export function hasChosenBungalow(): boolean {
  return safeGetItem(BUNGALOW_STORAGE_KEY) !== null;
}

/** Persist a choice. Callers decide whether a reload is needed (it is, when the pool changes). */
export function setActiveBungalow(id: string): boolean {
  return safeSetItem(BUNGALOW_STORAGE_KEY, id);
}

/**
 * The art pool `pageArt()` should draw this surface from, or null for the
 * classic system. Null whenever: no bungalow chosen, the default bungalow is
 * active, the bungalow has no pool yet, or the surface is shared.
 */
export function bungalowArtPool(pageId: string): ArtPiece[] | null {
  return bungalowArtContext(pageId)?.pool ?? null;
}

/**
 * Same resolution as `bungalowArtPool`, but also hands back WHICH bungalow the
 * pool belongs to. `pageArt()` needs the id to look up that bungalow's
 * per-surface overrides (bungalowArtOverrides.ts, written by /bayla-studio);
 * resolving pool and id together keeps it to a single storage read.
 */
export function bungalowArtContext(pageId: string): { id: string; pool: ArtPiece[] } | null {
  if (SHARED_SURFACES.has(pageId)) return null;
  const active = getActiveBungalow();
  if (!active || !active.artPool || active.artPool.length === 0) return null;
  return { id: active.id, pool: active.artPool };
}

/**
 * Preferred trade route for a bungalow's token: the IN-VENUE Solana swap
 * when that surface is configured (its platform-fee plumbing is live, though
 * no share-to-bungalow-pools policy exists yet — do not promise one), else
 * the external canon deep link. Returned as { to } (router path) or
 * { href, kind } (external) so callers render <Link> vs <a> correctly AND
 * label honestly: a Dexscreener token page is a CHART, not a swap venue —
 * calling it "Trade" hands a courted community a button that trades nothing.
 */
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

/** Host-anchored check (CodeQL js/regex/missing-regexp-anchor: a bare
 *  substring/regex test would also match evil.com/dexscreener.com/…). */
function isDexscreenerUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'dexscreener.com' || host.endsWith('.dexscreener.com');
  } catch {
    return false;
  }
}

/**
 * In-venue scanner route for a bungalow's token. Every island chain is
 * scannable since 2026-08-28 (Base rides the erc20scan route's Blockscout
 * leg); Base must carry the explicit chain param because a 0x address is
 * format-ambiguous with Ethereum.
 */
export function bungalowScanRoute(b: Bungalow): string | null {
  if (!b.address) return null;
  if (b.chain === 'base') return `/scan?token=${b.address}&chain=base`;
  if (b.chain === 'ethereum' || b.chain === 'solana') return `/scan?token=${b.address}`;
  return null;
}

/**
 * The one sentence that tells a visitor where this resident's token trades.
 * Shared by the footer and the page meta description so they can never drift.
 *
 * 2026-08-30 defect: both hardcoded "Trade <SYM> on Solana" from the days when
 * BAYLA was the only token-first bungalow. Once six EVM residents went live
 * that line was FALSE on half the island — and it shipped in the meta
 * description, so it was the sentence search results and link unfurls carried.
 *
 * It also refuses to call a chart a trade: for a resident whose only outbound
 * route is a Dexscreener page, the honest verb is "lives on", not "trade".
 */
export function bungalowTradeBlurb(b: Bungalow, solanaSwapLive: boolean): string {
  const chainWord =
    b.chain === 'solana' ? 'Solana' : b.chain === 'base' ? 'Base' : b.chain === 'ethereum' ? 'Ethereum' : '';
  const route = bungalowTradeRoute(b, solanaSwapLive);
  if (!route || !chainWord) return `${b.symbol} lives on Jungle Bay Island; scan any token on either chain.`;
  // An in-venue router path (or a real external swap) is a place you can trade.
  const tradable = 'to' in route || route.kind === 'swap';
  return tradable
    ? `Trade ${b.symbol} on ${chainWord}; scan any token on either chain.`
    : `${b.symbol} lives on ${chainWord} — chart and contract on its page; scan any token on either chain.`;
}

/**
 * The island resident behind a market pool, or null if the pool is a stranger's.
 *
 * The market surfaces read pools from GeckoTerminal, which knows a pool by
 * address and by whatever name the pair carries ("BOBO / SOL"). This registry
 * knows which of those addresses is a resident of the island. Joining them here
 * — rather than in each surface — means a row for a bungalow's own pool can say
 * so once, consistently, and a row for any other pool says nothing rather than
 * guessing.
 *
 * Matching follows each chain's own rules: EVM addresses compare
 * case-insensitively (the same address is written both ways all over this repo),
 * Solana keys compare EXACTLY, because base58 is case-sensitive and a
 * lowercased key is a different, valid-looking, wrong address.
 */
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
