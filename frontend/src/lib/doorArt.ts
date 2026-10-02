/**
 * What picture a bungalow's door card shows, and the island-wide art index that
 * makes it pickable.
 *
 * Kept OUT of bungalowDoorArt.ts on purpose: that file is rewritten end to end
 * by the /door-studio save endpoint, so anything living in it that the render
 * template does not emit would be deleted on the next save.
 *
 * A door is the island's shop window rather than a surface inside one bungalow,
 * so the picker draws from EVERY resident's pool plus the classic map — the
 * right picture for the QR card may well be someone else's drop.
 */
import { ART, type ArtPiece } from './artConfig';
import { BUNGALOWS, type Bungalow } from './bungalows';
import { DOOR_ART_OVERRIDES, type DoorArtOverride } from './bungalowDoorArt';

/**
 * Every piece the island can put on a door: all bungalow pools, then classic.
 *
 * Keyed by artId, which is the filename without its extension. That is unique
 * across all 298 pool pieces today and islandArt.test.ts fails if it stops
 * being — a collision would silently resolve a door to a same-named picture
 * from a different resident's folder.
 *
 * Bungalow pools are inserted first so a classic piece can never shadow one.
 */
let indexCache: Map<string, ArtPiece> | null = null;
export function islandArtIndex(): Map<string, ArtPiece> {
  if (indexCache) return indexCache;
  const index = new Map<string, ArtPiece>();
  for (const b of BUNGALOWS) {
    for (const piece of b.artPool ?? []) if (!index.has(piece.id)) index.set(piece.id, piece);
  }
  for (const piece of Object.values(ART)) if (!index.has(piece.id)) index.set(piece.id, piece);
  indexCache = index;
  return index;
}

/** The island's art as a flat list, pools first, for the studio's picker. */
export function islandArtList(): ArtPiece[] {
  return [...islandArtIndex().values()];
}

export type DoorArt = { src: string; objectPosition?: string };

/**
 * The door picture for a bungalow: the studio's pick if it resolves, otherwise
 * the `thumb` on the registry entry.
 *
 * An override naming an artId that no longer exists (its file was deleted, its
 * pool retired) falls back to the registry thumb rather than rendering nothing.
 * A door with no picture is a broken card on the island's front page, so the
 * unresolvable case has to degrade to the value that was always there.
 */
export function resolveDoorArt(
  b: Bungalow,
  overrides: Record<string, DoorArtOverride>,
): DoorArt {
  const override = overrides[b.id];
  if (override) {
    const piece = islandArtIndex().get(override.artId);
    if (piece) {
      return {
        src: piece.src,
        objectPosition: override.objectPosition ?? piece.objectPosition ?? b.thumbPosition,
      };
    }
  }
  return { src: b.thumb, objectPosition: b.thumbPosition };
}

/** The door as the island renders it, against the overrides that shipped. */
export function doorArt(b: Bungalow): DoorArt {
  return resolveDoorArt(b, DOOR_ART_OVERRIDES);
}
