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

};

/** Key builder — keep in lock-step with the studio and the vite save endpoint. */
export function bungalowOverrideKey(bungalowId: string, pageId: string, idx: number): string {
  return `${bungalowId}|${pageId}:${idx}`;
}
