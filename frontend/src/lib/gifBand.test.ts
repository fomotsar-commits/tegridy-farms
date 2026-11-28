import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addBand, decodeFrame, readGif, type Codes, type Gif } from './gifBand';

// Made by Pillow 12.2, an encoder that is not this one: 72 x 100, a 256-colour global table whose first four are the
// island's ground (9,16,26), white, its lavender and Bayla's green; then colour i is (37i, 71i+40, 113i+90) mod 256.
// Frame 0: 20 rows of ground over 80 rows of noise, (xorshift32 from 2463534242) mod 200 + 4, enough codes that its
// stream clears once mid-way. Frame 1: (10,30) 30 x 20 of colour 5. Frame 2: (50,60) 20 x 6 of colour 6. Each later
// frame has its own table; all keep what is under them (disposal 1); 40, 40 and 60 ms.
const PILLOW = new Uint8Array(readFileSync(join(process.cwd(), 'src/lib/__fixtures__/gifBand/pillow-noise.gif')));
const W = 72;
const H = 100;

function islandGif(): Gif {
  const gif = readGif(PILLOW);
  if (!gif) throw new Error('the fixture is not read');
  return gif;
}

/** Frame 0's indices, as they were given to Pillow. */
function frameZero(): Uint8Array {
  const out = new Uint8Array(W * H);
  let x = 2463534242;
  for (let i = 0; i < W * H; i++) {
    if (i < 20 * W) continue;
    x = (x ^ (x << 13)) >>> 0;
    x = (x ^ (x >>> 17)) >>> 0;
    x = (x ^ (x << 5)) >>> 0;
    out[i] = (x % 200) + 4;
  }
  return out;
}

const colour = (i: number): [number, number, number] =>
  i === 0 ? [9, 16, 26] : i === 1 ? [255, 255, 255] : i === 2 ? [165, 153, 201] : i === 3 ? [150, 255, 140] : [(i * 37) % 256, (i * 71 + 40) % 256, (i * 113 + 90) % 256];

/** What every frame shows, as RGB over the whole picture: each frame laid over the last (nothing is ever cleared here). */
function shown(gif: Gif): Uint8Array[] {
  const screen = new Uint8Array(gif.width * gif.height * 3);
  return gif.frames.map((f) => {
    expect(f.disposal === 0 || f.disposal === 1).toBe(true);
    const idx = decodeFrame(gif, f)!;
    for (let y = 0; y < f.rect.h; y++) {
      for (let x = 0; x < f.rect.w; x++) {
        const i = idx[y * f.rect.w + x]!;
        if (i === f.transparent) continue;
        const o = ((f.rect.y + y) * gif.width + f.rect.x + x) * 3;
        screen.set(f.palette.subarray(i * 3, i * 3 + 3), o);
      }
    }
    return screen.slice();
  });
}

/** A band of `h` rows with no words but the ones `paint` puts in. */
function band(h: number, paint: (x: number, y: number) => [number, number, number, number] | null = () => null) {
  const words = new Uint8ClampedArray(W * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < W; x++) {
      const p = paint(x, y);
      if (p) words.set(p, (y * W + x) * 4);
    }
  }
  return { height: h, words };
}

const codesOf = (gif: Gif, i: number): number[] => {
  const c: Codes = { code: new Uint16Array(16), n: 0 };
  decodeFrame(gif, gif.frames[i]!, c);
  return [...c.code.subarray(0, c.n)];
};

describe('reading a GIF another encoder wrote', () => {
  it('reads each frame Pillow wrote, pixel for pixel, its clear mid-stream included', () => {
    const gif = islandGif();
    expect([gif.width, gif.height, gif.frames.length]).toEqual([W, H, 3]);
    expect(decodeFrame(gif, gif.frames[0]!)).toEqual(frameZero());
    // The first frame's stream clears once besides its first code: the reader keeps up across it.
    expect(codesOf(gif, 0).filter((c) => c === 256).length).toBe(2);
    const [, one, two] = gif.frames;
    expect([one!.rect, two!.rect]).toEqual([{ x: 10, y: 30, w: 30, h: 20 }, { x: 50, y: 60, w: 20, h: 6 }]);
    const screens = shown(gif);
    for (const [frame, x, y, i] of [[1, 10, 30, 5], [1, 39, 49, 5], [2, 50, 60, 6], [2, 69, 65, 6]] as const) {
      expect([...screens[frame]!.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)]).toEqual(colour(i));
    }
  });

  it('is not a GIF: nothing is read', () => {
    expect(readGif(new TextEncoder().encode('<!doctype html><html></html>'))).toBeNull();
    expect(readGif(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    expect(readGif(PILLOW.subarray(0, PILLOW.length - 200))).toBeNull();
  });
});

describe('the band across the top', () => {
  it('every frame below it is the island’s, pixel for pixel, and the band stays as the first frame drew it', () => {
    const gif = islandGif();
    const out = readGif(addBand(gif, band(8, (x, y) => (x > 20 && x < 50 && y > 1 && y < 6 ? [255, 255, 255, 255] : null)))!)!;
    expect([out.width, out.height, out.frames.length]).toEqual([W, H + 8, 3]);
    const before = shown(gif);
    const after = shown(out);
    const top = after[0]!.slice(0, W * 8 * 3);
    after.forEach((screen, i) => {
      expect(screen.subarray(W * 8 * 3)).toEqual(before[i]);
      expect(screen.subarray(0, W * 8 * 3)).toEqual(top);
    });
  });

  it('the band’s ground is the first frame’s top row carried up; its words are in the first frame’s own colours', () => {
    const gif = islandGif();
    // White at full cover, lavender at full cover, Bayla's green at half over the ground.
    const out = readGif(addBand(gif, band(6, (x) => (x < 10 ? [255, 255, 255, 255] : x < 20 ? [165, 153, 201, 255] : x < 30 ? [150, 255, 140, 128] : null)))!)!;
    const screen = shown(out)[0]!;
    const at = (x: number, y: number) => [...screen.subarray((y * W + x) * 3, (y * W + x) * 3 + 3)];
    expect(at(5, 3)).toEqual([255, 255, 255]);
    expect(at(15, 3)).toEqual([165, 153, 201]);
    // Half of Bayla's green over the ground is no colour of the table: it is the table's nearest.
    const a = 128 / 255;
    const half = [Math.round(9 * (1 - a) + 150 * a), Math.round(16 * (1 - a) + 255 * a), Math.round(26 * (1 - a) + 140 * a)];
    const pal = out.frames[0]!.palette;
    let best = Infinity;
    let nearest: number[] = [];
    for (let q = 0; q < pal.length / 3; q++) {
      const [r, g, b] = [pal[q * 3]!, pal[q * 3 + 1]!, pal[q * 3 + 2]!];
      const d = 3 * (r - half[0]!) ** 2 + 4 * (g - half[1]!) ** 2 + 2 * (b - half[2]!) ** 2;
      if (d < best) {
        best = d;
        nearest = [r, g, b];
      }
    }
    expect(at(25, 3)).toEqual(nearest);
    for (const y of [0, 5]) expect(at(60, y)).toEqual([9, 16, 26]);
  });

  it('only the first frame is written again, and its own codes follow the band’s, code for code', () => {
    const gif = islandGif();
    const bytes = addBand(gif, band(8, (x, y) => (x % 3 === 0 && y > 2 ? [255, 255, 255, 255] : null)))!;
    const out = readGif(bytes)!;
    // Every later frame is its own bytes; only its top moved down by the band.
    for (const i of [1, 2]) {
      const a = gif.frames[i]!;
      const b = out.frames[i]!;
      expect(b.rect).toEqual({ ...a.rect, y: a.rect.y + 8 });
      expect(bytes.subarray(b.at + 9, b.end)).toEqual(PILLOW.subarray(a.at + 9, a.end));
      expect(bytes.subarray(b.at, b.at + 3)).toEqual(PILLOW.subarray(a.at, a.at + 3));
    }
    // The first frame: the band's codes, then the island's own, its clears included, at the widths it read them.
    const island = codesOf(gif, 0);
    const ours = codesOf(out, 0);
    expect(ours.slice(-island.length)).toEqual(island);
    expect(out.frames[0]!.rect).toEqual({ x: 0, y: 0, w: W, h: H + 8 });
    // So the file grows by about the band alone.
    expect(bytes.length - PILLOW.length).toBeLessThan(400);
  });

  it('words in many colours fill the writer’s table: it clears and starts again, and they read back as drawn', () => {
    const gif = islandGif();
    let x32 = 99;
    const rnd = () => {
      x32 = (x32 ^ (x32 << 13)) >>> 0;
      x32 = (x32 ^ (x32 >>> 17)) >>> 0;
      x32 = (x32 ^ (x32 << 5)) >>> 0;
      return x32;
    };
    const want: number[] = [];
    const out = readGif(
      addBand(
        gif,
        band(90, () => {
          const c = colour(rnd() % 256);
          want.push(...c);
          return [...c, 255];
        }),
      )!,
    )!;
    const ours = codesOf(out, 0);
    // More codes than one table holds: the band's own part of the stream clears again after its first code.
    const bandPart = ours.slice(0, ours.length - codesOf(gif, 0).length);
    expect(bandPart[0]).toBe(256);
    expect(bandPart.slice(1).filter((c) => c === 256).length).toBeGreaterThanOrEqual(1);
    expect([...shown(out)[0]!.subarray(0, W * 90 * 3)]).toEqual(want);
  });

  it('a band that would take the GIF past the cap, a first frame that does not cover the picture, an interlaced one, or words of the wrong size: no band', () => {
    const gif = islandGif();
    const ok = addBand(gif, band(8))!;
    expect(addBand(gif, band(8), { maxBytes: ok.length - 1 })).toBeNull();
    expect(addBand(gif, band(8), { maxBytes: ok.length })).toEqual(ok);
    expect(addBand(gif, { height: 8, words: new Uint8ClampedArray(W * 8 * 4 - 4) })).toBeNull();
    expect(addBand(gif, band(0))).toBeNull();
    const at = gif.frames[0]!.at;
    const narrow = PILLOW.slice();
    narrow[at + 5] = W - 1;
    expect(addBand(readGif(narrow)!, band(8))).toBeNull();
    const interlaced = PILLOW.slice();
    interlaced[at + 9]! |= 0x40;
    expect(addBand(readGif(interlaced)!, band(8))).toBeNull();
  });
});
