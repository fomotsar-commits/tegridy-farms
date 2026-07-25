import { describe, it, expect } from 'vitest';
import { ART, ART_POOL_ALL, GALLERY_ORDER } from './artConfig';

// The 2026-07 "art on the cards" drop: 26 fresh pieces (card01..card26) added so
// every previously art-less modal/banner/page gets real art, and so the rotation
// pool that feeds every <ArtImg> across the app now includes them. These tests pin
// that wiring — if a refactor drops a piece from the pool, the app silently loses
// art on the cards, which is exactly what this drop was meant to fix.
const CARD_IDS = Array.from({ length: 26 }, (_, i) => `card${String(i + 1).padStart(2, '0')}`);

describe('new "card" art drop (card01..card26)', () => {
  it('registers all 26 pieces in ART with a resolvable /art/new/ source', () => {
    for (const id of CARD_IDS) {
      const piece = (ART as Record<string, { id: string; src: string }>)[id];
      expect(piece, `ART.${id} should exist`).toBeTruthy();
      expect(piece.id).toBe(id);
      expect(piece.src, `${id} src should live under /art/new/`).toMatch(/^\/art\/new\/.+\.(jpg|jpeg|png|webp|avif)$/i);
    }
  });

  it('gives every card piece a unique source file (no accidental dupes)', () => {
    const srcs = CARD_IDS.map((id) => (ART as Record<string, { src: string }>)[id].src);
    expect(new Set(srcs).size).toBe(CARD_IDS.length);
  });

  it('wires every card piece into ART_POOL_ALL so it rotates into all <ArtImg> surfaces', () => {
    const poolSrcs = new Set(ART_POOL_ALL.map((p) => p.src));
    for (const id of CARD_IDS) {
      const { src } = (ART as Record<string, { src: string }>)[id];
      expect(poolSrcs.has(src), `${id} should be in ART_POOL_ALL`).toBe(true);
    }
  });

  it('lists every card piece in the gallery order', () => {
    const gallerySrcs = new Set(GALLERY_ORDER.map((p) => p.src));
    for (const id of CARD_IDS) {
      const { src } = (ART as Record<string, { src: string }>)[id];
      expect(gallerySrcs.has(src), `${id} should be in GALLERY_ORDER`).toBe(true);
    }
  });
});
