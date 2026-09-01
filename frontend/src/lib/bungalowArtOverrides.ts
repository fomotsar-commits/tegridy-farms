/**
 * Per-bungalow, per-surface art overrides — written by /bayla-studio.
 *
 * Key format: `${bungalowId}|${pageId}:${idx}`.
 *   e.g. "bayla|farm:0" — the /farm page background, in the Bayla skin.
 *
 * Why a second file instead of reusing ART_OVERRIDES: a bungalow paints every
 * surface from its OWN pool (see bungalows.ts `artPool`), so the classic art
 * ids in ART_OVERRIDES don't exist in that pool. Keying by bungalow keeps the
 * two skins from overwriting each other — the classic picks stay exactly as
 * they are while a bungalow gets its own placement.
 *
 * `artId` resolves against the active bungalow's pool first, then falls back to
 * the classic ART map (so a bungalow may deliberately borrow a classic piece).
 * Unresolvable ids fall through to the deterministic rotation, same as classic.
 *
 * Do not hand-edit during a studio session — the studio overwrites this file on save.
 */
import type { ArtOverride } from './artOverrides';

export type { ArtOverride };

export const BUNGALOW_ART_OVERRIDES: Record<string, ArtOverride> = {
  "bayla|admin-dashboard:0": { artId: "bayla-04", objectPosition: "34% 24%" },
  "bayla|admin:0": { artId: "bayla-03", objectPosition: "37% 76%" },
  "bayla|boost-schedule:0": { artId: "bayla-09", objectPosition: "30% 21%" },
  "bayla|boost-schedule:1": { artId: "bayla-10", objectPosition: "38% 78%" },
  "bayla|boost-schedule:2": { artId: "bayla-11", objectPosition: "39% 49%" },
  "bayla|bungalow-dashboard:0": { artId: "bayla-16", objectPosition: "65% 32%" },
  "bayla|bungalow-dashboard:1": { artId: "bayla-01", objectPosition: "45% 36%" },
  "bayla|bungalow-farm:0": { artId: "bayla-12", objectPosition: "32% 16%" },
  "bayla|bungalow-farm:1": { artId: "bayla-13", objectPosition: "46% 38%" },
  "bayla|bungalow-farm:2": { artId: "bayla-14", objectPosition: "42% 11%" },
  "bayla|bungalow-lore:0": { artId: "bayla-08", objectPosition: "43% 4%" },
  "bayla|changelog:0": { artId: "bayla-08", objectPosition: "53% 70%" },
  "bayla|community:0": { artId: "bayla-22", objectPosition: "78% 83%" },
  "bayla|dashboard:0": { artId: "bayla-18", objectPosition: "41% 30%" },
  "bayla|dashboard:1": { artId: "bayla-05", objectPosition: "53% 45%" },
  "bayla|dashboard:10": { artId: "bayla-04", objectPosition: "42% 0%" },
  "bayla|dashboard:11": { artId: "bayla-05", objectPosition: "47% 86%" },
  "bayla|dashboard:12": { artId: "bayla-06", objectPosition: "60% 8%" },
  "bayla|dashboard:13": { artId: "bayla-07", objectPosition: "46% 78%" },
  "bayla|dashboard:14": { artId: "bayla-08", objectPosition: "36% 46%" },
  "bayla|dashboard:2": { artId: "bayla-20", objectPosition: "55% 5%" },
  "bayla|dashboard:3": { artId: "bayla-21", objectPosition: "49% 0%" },
  "bayla|dashboard:5": { artId: "bayla-23", objectPosition: "49% 11%" },
  "bayla|dashboard:6": { artId: "bayla-24", objectPosition: "37% 9%" },
  "bayla|dashboard:7": { artId: "bayla-01", objectPosition: "52% 62%" },
  "bayla|dashboard:8": { artId: "bayla-02", objectPosition: "48% 75%" },
  "bayla|dashboard:9": { artId: "bayla-03", objectPosition: "45% 79%" },
  "bayla|faq:0": { artId: "bayla-12", objectPosition: "31% 15%" },
  "bayla|farm-stats:0": { artId: "bayla-18", objectPosition: "35% 70%" },
  "bayla|farm-stats:1": { artId: "bayla-19", objectPosition: "45% 100%" },
  "bayla|farm-stats:2": { artId: "bayla-20", objectPosition: "43% 100%" },
  "bayla|farm-stats:3": { artId: "bayla-21", objectPosition: "40% 97%" },
  "bayla|farm:0": { artId: "bayla-19", objectPosition: "74% 0%" },
  "bayla|farm:1": { artId: "bayla-23", objectPosition: "27% 100%" },
  "bayla|history:1": { artId: "bayla-01", objectPosition: "29% 63%" },
  "bayla|home:0": { artId: "bayla-05", objectPosition: "72% 47%" },
  "bayla|home:1": { artId: "bayla-20", objectPosition: "69% 3%" },
  "bayla|home:10": { artId: "bayla-05", objectPosition: "59% 46%" },
  "bayla|home:11": { artId: "bayla-06", objectPosition: "67% 18%" },
  "bayla|home:12": { artId: "bayla-07", objectPosition: "50% 24%" },
  "bayla|home:13": { artId: "bayla-08", objectPosition: "50% 69%" },
  "bayla|home:14": { artId: "bayla-09", objectPosition: "46% 72%" },
  "bayla|home:2": { artId: "bayla-21", objectPosition: "73% 55%" },
  "bayla|home:3": { artId: "bayla-22", objectPosition: "85% 60%" },
  "bayla|home:4": { artId: "bayla-23", objectPosition: "23% 1%" },
  "bayla|home:5": { artId: "bayla-24", objectPosition: "45% 0%" },
  "bayla|home:6": { artId: "bayla-01", objectPosition: "64% 9%" },
  "bayla|home:7": { artId: "bayla-02", objectPosition: "65% 34%" },
  "bayla|home:8": { artId: "bayla-03", objectPosition: "74% 0%" },
  "bayla|home:9": { artId: "bayla-04", objectPosition: "47% 41%" },
  "bayla|leaderboard:0": { artId: "bayla-21", objectPosition: "53% 54%" },
  "bayla|liquidity-tab:0": { artId: "bayla-08", objectPosition: "39% 69%" },
  "bayla|liquidity-tab:1": { artId: "bayla-09", objectPosition: "45% 22%" },
  "bayla|live-pool:0": { artId: "bayla-03", objectPosition: "57% 45%" },
  "bayla|lore:0": { artId: "bayla-02", objectPosition: "59% 81%" },
  "bayla|lp-farming:0": { artId: "bayla-05", objectPosition: "43% 100%" },
  "bayla|lp-farming:1": { artId: "bayla-06", objectPosition: "61% 82%" },
  "bayla|nft-finance:0": { artId: "bayla-21", objectPosition: "46% 0%" },
  "bayla|nft-finance:1": { artId: "bayla-22", objectPosition: "32% 3%" },
  "bayla|premium:0": { artId: "bayla-15", objectPosition: "57% 74%" },
  "bayla|privacy:0": { artId: "bayla-04", objectPosition: "34% 72%" },
  "bayla|security:0": { artId: "bayla-12", objectPosition: "45% 63%" },
  "bayla|staking-card:0": { artId: "bayla-02", objectPosition: "54% 0%" },
  "bayla|terms:0": { artId: "bayla-09", objectPosition: "39% 33%" },
  "bayla|tokenomics:0": { artId: "bayla-06", objectPosition: "58% 23%" },
  "bayla|trade:0": { artId: "bayla-12", objectPosition: "40% 16%" },
  "bayla|trade:1": { artId: "bayla-13", objectPosition: "52% 23%" },
  "bayla|trade:2": { artId: "bayla-14", objectPosition: "43% 100%" },
  "bayla|trade:3": { artId: "bayla-15", objectPosition: "43% 74%" },
  "bayla|upcoming-pools:0": { artId: "bayla-20", objectPosition: "55% 79%" },
  "bayla|upcoming-pools:1": { artId: "bayla-21", objectPosition: "49% 26%" },
  "bayla|upcoming-pools:2": { artId: "bayla-22", objectPosition: "37% 47%" },
  "bayla|upcoming-pools:3": { artId: "bayla-23", objectPosition: "21% 42%" },
  "bayla|yield:0": { artId: "bayla-09", objectPosition: "42% 21%" },
};

/** Key builder — keep in lock-step with the studio and the vite save endpoint. */
export function bungalowOverrideKey(bungalowId: string, pageId: string, idx: number): string {
  return `${bungalowId}|${pageId}:${idx}`;
}
