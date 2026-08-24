import type { ArtPiece } from './artConfig';
import { safeGetItem, safeSetItem } from './storage';
import { TOWELI_ADDRESS } from './constants';

/**
 * Jungle Bay Island — the 13 bungalows.
 *
 * Each bungalow is one community token. Entering a bungalow re-skins the app's
 * BACKGROUNDS (every `pageArt()` surface — fullscreen page art, card art,
 * stat-tile art) with that bungalow's own art pool. Nothing else changes:
 * buttons, token logos, copy, contracts and rails all stay exactly as built.
 *
 * Design constraints, in order:
 *  - Additive only. The classic Towelie art system (ART / ART_OVERRIDES /
 *    ART_POOL_ALL) is untouched and remains the default when no bungalow is
 *    chosen. See feedback_preserve_art — existing art is never removed.
 *  - Zero per-surface edits. `pageArt()` is the single choke point every art
 *    surface already goes through, so the swap happens there and nowhere else.
 *  - `pageArt()` is called at module top-level in places (loader constants,
 *    STAT_ARTS), so the active bungalow must resolve synchronously — plain
 *    localStorage/query reads, no context, no async. Switching bungalows is a
 *    persist + full reload, which also keeps every deterministic-rotation
 *    consumer consistent within a single document lifetime.
 *
 * Only bungalows with `live: true` are selectable. The remaining slots are
 * committed placeholders: fill in name/symbol/chain/address/artPool as each
 * bungalow's token + art set is confirmed, flip `live`, and the picker,
 * deep links (?bungalow=<id>) and theming all light up with no other change.
 */
export interface Bungalow {
  /** Stable id — storage value, ?bungalow= deep-link value, picker key. */
  id: string;
  name: string;
  symbol: string;
  /** Chain the bungalow's token lives on. 'tbd' until confirmed. */
  chain: 'ethereum' | 'solana' | 'tbd';
  /** Token contract address (EVM) or mint (Solana). Undefined until confirmed. */
  address?: string;
  /** One-liner shown on the picker card. */
  tagline: string;
  /**
   * Background art pool for this bungalow. Undefined means "classic art
   * system" (Towelie keeps ART_OVERRIDES + ART_POOL_ALL). A non-empty pool
   * fully replaces background rotation while this bungalow is active.
   */
  artPool?: ArtPiece[];
  /** Thumbnail shown on the picker card. */
  thumb: string;
  /** Selectable in the picker. */
  live: boolean;
}

/** Bayla background pool — /public/art/bayla, dropped 2026-08-24 (24 pieces). */
export const BAYLA_ART: ArtPiece[] = Array.from({ length: 24 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return {
    id: `bayla-${n}`,
    src: `/art/bayla/bayla-${n}.jpg`,
    title: `Bayla #${n}`,
    description: 'Bayla bungalow — Jungle Bay Island',
  };
});

export const DEFAULT_BUNGALOW_ID = 'toweli';

export const BUNGALOWS: Bungalow[] = [
  {
    id: 'toweli',
    name: 'Toweli',
    symbol: 'TOWELI',
    chain: 'ethereum',
    address: TOWELI_ADDRESS,
    tagline: 'The original bungalow. Classic Tegridy art.',
    thumb: '/art/bobowelie.jpg',
    live: true,
  },
  {
    id: 'bayla',
    name: 'Bayla',
    symbol: 'BAYLA',
    chain: 'solana',
    address: '7hmVkPXmVagxoptAEpx4jBzZVHwGLdFj6c1y42qxpump',
    tagline: 'The green spirit of the island.',
    thumb: '/art/bayla/bayla-14.jpg',
    artPool: BAYLA_ART,
    live: true,
  },
  {
    id: 'drb',
    name: 'DRB',
    symbol: 'DRB',
    chain: 'tbd',
    tagline: 'Der Bar enters the ring.',
    thumb: '/art/boxing-ring.jpg',
    live: false,
  },
  // Bungalows 4–13: reserved. Confirm token (name/symbol/chain/address) and
  // drop an art set in /public/art/<id>/ to open each one.
  ...Array.from({ length: 10 }, (_, i) => {
    const n = String(i + 4).padStart(2, '0');
    return {
      id: `bungalow-${n}`,
      name: `Bungalow ${i + 4}`,
      symbol: 'TBD',
      chain: 'tbd' as const,
      tagline: 'Unclaimed bungalow.',
      thumb: '/art/jungle-dark.jpg',
      live: false,
    };
  }),
];

/** Storage key — tegridy- prefix keeps it inside the eviction whitelist, same as tegridy-theme. */
export const BUNGALOW_STORAGE_KEY = 'tegridy-bungalow';

/** Custom event the footer (or anything else) dispatches to reopen the picker. */
export const OPEN_BUNGALOWS_EVENT = 'tegridy:open-bungalows';

/**
 * Surfaces that keep classic art in EVERY bungalow:
 *  - nav-logo: the TopNav replay button — a button, not a background.
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
export function getActiveBungalow(): Bungalow | null {
  if (typeof window === 'undefined') return null;
  try {
    const fromUrl = byId(new URLSearchParams(window.location.search).get('bungalow'));
    if (fromUrl) {
      if (safeGetItem(BUNGALOW_STORAGE_KEY) !== fromUrl.id) {
        safeSetItem(BUNGALOW_STORAGE_KEY, fromUrl.id);
      }
      return fromUrl;
    }
  } catch { /* URLSearchParams unavailable — fall through to storage */ }
  return byId(safeGetItem(BUNGALOW_STORAGE_KEY));
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
  if (SHARED_SURFACES.has(pageId)) return null;
  const active = getActiveBungalow();
  if (!active || !active.artPool || active.artPool.length === 0) return null;
  return active.artPool;
}
