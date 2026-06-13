import { describe, it, expect } from 'vitest';
import { GALLERY_ORDER, UNIQUE_GALLERY_COUNT } from './artConfig';

// F75: a few gallery pieces ship in two file formats (.avif + .jpg of the same
// image), so GALLERY_ORDER.length double-counts them. UNIQUE_GALLERY_COUNT
// dedupes by source basename (extension stripped) for an honest "N original
// pieces" headline while keeping every file in the gallery.
describe('UNIQUE_GALLERY_COUNT', () => {
  it('dedupes pieces that share a basename across file extensions', () => {
    const basenames = GALLERY_ORDER.map((p) => p.src.replace(/\.[^./]+$/, ''));
    const expected = new Set(basenames).size;
    expect(UNIQUE_GALLERY_COUNT).toBe(expected);
  });

  it('is never larger than the raw GALLERY_ORDER length', () => {
    expect(UNIQUE_GALLERY_COUNT).toBeLessThanOrEqual(GALLERY_ORDER.length);
  });

  it('is strictly smaller when duplicate-format pieces are present', () => {
    // The current gallery has at least one .avif/.jpg pair (e.g. /splash/new/1).
    const hasDupPair =
      GALLERY_ORDER.some((p) => p.src === '/splash/new/1.avif') &&
      GALLERY_ORDER.some((p) => p.src === '/splash/new/1.jpg');
    if (hasDupPair) {
      expect(UNIQUE_GALLERY_COUNT).toBeLessThan(GALLERY_ORDER.length);
    }
  });
});
