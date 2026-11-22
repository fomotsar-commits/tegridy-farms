// The island's render: one night image of the whole island from the site's own axonometric,
// made in Blender from this plan (scripts/city-render/). The page lays it under the live parts
// (people, plaques, a press on a plot), which are drawn with the same projection, so they land on
// the buildings they belong to.
//
// THE FRAME IS SET HERE AND NOWHERE ELSE. scripts/city-render/plan.json carries it to Blender,
// and lib/city/renderPlan.test.ts fails if that file and this plan ever disagree.

import { ISLAND_CX, ISLAND_CY, type PieceId } from './plan';
import FINGERPRINTS from './renderFingerprints.json';

/**
 * A picture in public/city, linked by its contents' fingerprint. The pictures keep their names
 * each time they are rendered again, and a browser keeps each for a week without asking
 * (frontend/vercel.json, /city/(.*)), so a returning visitor saw last week's island under this
 * week's plaques (owner, 2026-11-21: the grid island under the new layout's labels). A new
 * picture is now a new link, fetched at once. scripts/city-render/render_all.py writes the
 * fingerprints after a render; lib/city/renderFingerprints.test.ts fails if one is stale.
 */
const cityPicture = (file: string): string => `/city/${file}?v=${(FINGERPRINTS as Record<string, string>)[file] ?? ''}`;

/**
 * How tall each building stands in the render, in world units: what each builder in
 * scripts/city-render/buildings.py returns. A plot's plaque hangs above it, and a press on the
 * picture reaches up to it.
 */
export const PIECE_TOP: Record<PieceId, number> = {
  wing: 4.06, pads: 3.86, blade: 3.46, balance: 3.36, ghost: 3.26,
  slouch: 3.46, monolith: 4.06, gridshell: 2.13, wave: 2.81, lantern: 3.26,
  lighthouse: 8.04, canopy: 3.66, hourglass: 5.16, lifeguard: 4.26, lift: 5.06,
  halo: 4.16, stack: 4.96, villa: 2.61, bloom: 3.81, slip: 3.06,
};

/**
 * What each model is made of, as a gallery's wall label gives it (owner, 2026-11-21: "labels").
 * Read off the builders in scripts/city-render/buildings.py through the model stock they are given
 * (stock.py: wood is basswood, thatch is jute, tin is zinc, stone and paint are white card, basalt
 * is walnut, glass is amber or smoked); "glazed tile" is a room's own art; "light" is a lit window,
 * lamp, ring or petal. A piece not rendered yet (QR's lantern) has none rather than a guess.
 */
export const PIECE_MEDIUM: Partial<Record<PieceId, string>> = {
  wing: 'Glazed tile, jute, basswood, card', pads: 'Glazed tile, card, light', blade: 'Zinc, card, light',
  balance: 'Brass, card, light', ghost: 'Basswood, card', slouch: 'Glazed tile, card',
  monolith: 'Glazed tile, walnut, card, light', gridshell: 'Glazed tile, basswood, walnut, card',
  wave: 'Glazed tile, basswood, card', lighthouse: 'Glazed tile, brass, amber glass',
  canopy: 'Card, smoked glass, light', hourglass: 'Brass rod, card', lifeguard: 'White card',
  lift: 'Glazed tile, jute, basswood, card', halo: 'Glazed tile, walnut, card, light',
  stack: 'Glazed tile, jute, basswood, card', villa: 'Card, basswood, jute, light',
  bloom: 'Glazed tile, basswood, light', slip: 'Basswood, walnut, card',
};

/** The world point at the middle of the image: x, y, z. */
export const RENDER_CENTER = [ISLAND_CX, ISLAND_CY + 1.5, 2.6] as const;
/** How much of the world the image spans, in the sheet's own units at zoom 1 (lib/city/kit.ts UNIT pixels each). */
export const RENDER_SPAN = [95, 66] as const;
/** Pixels to one world unit in the full image, and in the half-size one. */
export const RENDER_K = 36;
export const RENDER = {
  full: { src: cityPicture('island.webp'), k: RENDER_K, width: RENDER_SPAN[0] * RENDER_K, height: RENDER_SPAN[1] * RENDER_K },
  half: { src: cityPicture('island-half.webp'), k: RENDER_K / 2, width: (RENDER_SPAN[0] * RENDER_K) / 2, height: (RENDER_SPAN[1] * RENDER_K) / 2 },
} as const;
/** A building's close-up: its art at full size, opened by a press on it. */
export const closeUpSrc = (plotId: string): string => cityPicture(`close/${plotId}.webp`);
