// A room's picture on its bungalow (lib/isoMural.ts): which copy the walls fetch, how a bright
// picture is brought down at rest, and the one store that reads each picture's size and
// lightness once for every model on the page.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUNGALOWS } from './bungalows';
import { doorArt } from './doorArt';
import { derivedUrl, widthsFor } from './artSrcSet';
import { BLACK_LUMA, REST_LUMA, meanLuma, muralSrc, muralWidth, resetPicturesForTests, restDim, usePictures, type PictureFacts } from './isoMural';

describe('which copy of a picture the walls fetch', () => {
  it('the 128 wherever the picture spans no more than 128 device pixels, the 480 above that or where the span is not known', () => {
    expect(muralWidth(40)).toBe(128);
    expect(muralWidth(127.9)).toBe(128);
    expect(muralWidth(128)).toBe(128);
    expect(muralWidth(128.1)).toBe(480);
    expect(muralWidth(300)).toBe(480);
    expect(muralWidth(0)).toBe(480);
    expect(muralWidth(Number.NaN)).toBe(480);
  });

  it('the built site’s copy where it made one, else the original; a dev server has only originals', () => {
    const doors = BUNGALOWS.map((b) => doorArt(b).src).filter(Boolean);
    const copied = doors.find((src) => widthsFor(src).includes(480));
    expect(copied).toBeDefined();
    expect(muralSrc(copied!, 480, true)).toBe(derivedUrl(copied!, 480));
    expect(muralSrc(copied!, 128, true)).toBe(derivedUrl(copied!, 128));
    expect(muralSrc(copied!, 480, false)).toBe(copied);
    expect(muralSrc('/art/not-in-the-manifest.jpg', 128, true)).toBe('/art/not-in-the-manifest.jpg');
  });

  it('every room’s door picture has both copies, or is too light to be worth one, so no wall fetches a heavy original', () => {
    const pub = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
    for (const b of BUNGALOWS) {
      const src = doorArt(b).src;
      if (!src) continue;
      const widths = widthsFor(src);
      if (widths.length) expect(widths, b.id).toEqual(expect.arrayContaining([128, 480]));
      // The build copies no file under 80 KB (scripts/generate-image-derivatives.mjs MIN_SOURCE_BYTES).
      else expect(statSync(join(pub, src)).size, `${b.id} ${src}`).toBeLessThan(80 * 1024);
    }
  });
});

describe('a bright picture at rest', () => {
  it('reads lightness as Rec. 709 luma over the pixels', () => {
    expect(meanLuma([255, 255, 255, 255])).toBeCloseTo(1, 10);
    expect(meanLuma([0, 0, 0, 255])).toBe(0);
    expect(meanLuma([0, 255, 0, 255])).toBeCloseTo(0.7152, 10);
    expect(meanLuma([255, 255, 255, 255, 0, 0, 0, 255])).toBeCloseTo(0.5, 10);
    expect(meanLuma([])).toBe(0);
  });

  it('is dimmed just enough to rest at the island’s lightness, a white picture most of all', () => {
    for (const m of [0.55, 0.7, 0.85, 1]) {
      const a = restDim(m);
      expect(a).toBeGreaterThan(0);
      // The page's black over the picture at that opacity brings it to REST_LUMA.
      expect(m * (1 - a) + BLACK_LUMA * a).toBeCloseTo(REST_LUMA, 10);
    }
    expect(restDim(1)).toBeCloseTo((1 - REST_LUMA) / (1 - BLACK_LUMA), 12);
    expect(restDim(0.7)).toBeLessThan(restDim(0.85));
  });

  it('a picture no brighter than that, or one whose lightness could not be read, is not dimmed', () => {
    for (const m of [0, 0.2, REST_LUMA, null, undefined, Number.NaN]) expect(restDim(m)).toBe(0);
  });
});

describe('the store that reads each picture once', () => {
  const made: string[] = [];
  /** An Image that loads (or fails, for a src with "broken" in it) a microtask after its src is set. */
  class FakeImage {
    naturalWidth = 0;
    naturalHeight = 0;
    decoding = '';
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    set src(value: string) {
      made.push(value);
      queueMicrotask(() => {
        if (value.includes('broken')) return this.onerror?.();
        this.naturalWidth = value.includes('wide') ? 1600 : 800;
        this.naturalHeight = 1000;
        this.onload?.();
      });
    }
  }

  const seen: ReadonlyMap<string, PictureFacts | 'failed'>[] = [];
  function Probe({ srcs }: { srcs: string[] }) {
    seen.push(new Map(usePictures(srcs)));
    return null;
  }
  const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

  beforeEach(() => {
    resetPicturesForTests();
    made.length = 0;
    seen.length = 0;
    vi.stubGlobal('Image', FakeImage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads each picture’s size once, for every model on the page, and marks one that fails to load', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    render(<><Probe srcs={['/a-wide.jpg', '/b.jpg', '/c-broken.jpg']} /><Probe srcs={['/b.jpg', '/a-wide.jpg']} /></>);
    expect(seen[0]!.size).toBe(0);
    await settle();
    expect([...made].sort()).toEqual(['/a-wide.jpg', '/b.jpg', '/c-broken.jpg']);
    const last = seen.at(-1)!;
    expect(last.get('/a-wide.jpg')).toEqual({ w: 1600, h: 1000, luma: null });
    expect(last.get('/b.jpg')).toEqual({ w: 800, h: 1000, luma: null });
    expect(last.get('/c-broken.jpg')).toBe('failed');
  });

  it('reads a picture’s lightness from a small copy of it, where the browser lets the page read its pixels', async () => {
    const grey = new Uint8ClampedArray(8 * 8 * 4).fill(204);
    const ctx = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: grey })) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    render(<Probe srcs={['/d.jpg']} />);
    await settle();
    const facts = seen.at(-1)!.get('/d.jpg') as PictureFacts;
    expect(facts.luma).toBeCloseTo(0.8, 6);
    expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 8, 8);
  });

  it('a picture whose pixels may not be read keeps its size and has no lightness', async () => {
    const ctx = { drawImage: vi.fn(), getImageData: vi.fn(() => { throw new DOMException('tainted', 'SecurityError'); }) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    render(<Probe srcs={['/e.jpg']} />);
    await settle();
    expect(seen.at(-1)!.get('/e.jpg')).toEqual({ w: 800, h: 1000, luma: null });
  });

  it('asks for nothing where a pool has no picture', async () => {
    render(<Probe srcs={['', '']} />);
    await settle();
    expect(made).toEqual([]);
  });
});
