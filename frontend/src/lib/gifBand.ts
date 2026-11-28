/**
 * A band of words added across the top of a GIF the island made (the add's GIF says what went in: the owner's word,
 * 11-28). The island's clip is a picture of the card, the same for every add of a coin; the card that shares it knows
 * how much of each coin went in. The GIF grows by the band's height and the band is drawn once, by the first frame:
 * every later frame moves down by the band and is otherwise the island's own bytes, so none of them can draw over it
 * and the file stays about its own size (X's cap from a phone is 5,000,000 bytes).
 *
 * The first frame is written again: the band's rows, a clear, then the island's own codes for its own pixels, code
 * for code. The island's encoder packs a frame about twice as tight as writing it afresh would, so its codes are
 * kept rather than its pixels re-packed. A GIF this cannot read, or whose first frame does not cover the whole
 * picture, gets no band, and the caller shares it as it came.
 *
 * Pure: no canvas, no DOM. The band's words are drawn by the caller (lib/momentAmounts.ts).
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What a GIF's frame is, read from its bytes. Offsets index the file. */
export interface Frame {
  /** The Image Descriptor's first byte (0x2C); the frame's Graphic Control Extension is before it and kept as it is. */
  at: number;
  /** Just past the image data's terminating block. */
  end: number;
  rect: Rect;
  packed: number;
  /** The local colour table's bytes, if the frame has one. */
  local: Uint8Array | null;
  /** The colour table in force for this frame. */
  palette: Uint8Array;
  minCode: number;
  /** The image data's first sub-block length byte. */
  data: number;
  disposal: number;
  transparent: number | null;
}

export interface Gif {
  bytes: Uint8Array;
  width: number;
  height: number;
  frames: Frame[];
}

const TRAILER = 0x3b;
const INTERLACED = 0x40;

/** The sub-blocks from `p` on, skipped: where the byte after their terminator is, or -1 if the file ends first. */
function skipBlocks(b: Uint8Array, p: number): number {
  while (p < b.length) {
    const n = b[p]!;
    if (n === 0) return p + 1;
    p += n + 1;
  }
  return -1;
}

/** The GIF's frames, or null when the bytes are not a GIF this can read. */
export function readGif(bytes: Uint8Array): Gif | null {
  const b = bytes;
  if (b.length < 14 || b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46 || b[3] !== 0x38 || (b[4] !== 0x39 && b[4] !== 0x37) || b[5] !== 0x61) return null;
  const width = b[6]! | (b[7]! << 8);
  const height = b[8]! | (b[9]! << 8);
  const screen = b[10]!;
  let p = 13;
  let global: Uint8Array | null = null;
  if (screen & 0x80) {
    const n = 3 * (1 << ((screen & 7) + 1));
    if (p + n > b.length) return null;
    global = b.subarray(p, p + n);
    p += n;
  }
  const frames: Frame[] = [];
  let control: { disposal: number; transparent: number | null } | null = null;
  for (;;) {
    if (p >= b.length) return null;
    const id = b[p]!;
    if (id === TRAILER) break;
    if (id === 0x21) {
      if (p + 2 >= b.length) return null;
      if (b[p + 1] === 0xf9 && b[p + 2] === 4 && p + 7 < b.length) {
        const f = b[p + 3]!;
        control = { disposal: (f >> 2) & 7, transparent: f & 1 ? b[p + 6]! : null };
      }
      p = skipBlocks(b, p + 2);
      if (p < 0) return null;
      continue;
    }
    if (id !== 0x2c || p + 10 > b.length) return null;
    const at = p;
    const rect = { x: b[p + 1]! | (b[p + 2]! << 8), y: b[p + 3]! | (b[p + 4]! << 8), w: b[p + 5]! | (b[p + 6]! << 8), h: b[p + 7]! | (b[p + 8]! << 8) };
    const packed = b[p + 9]!;
    p += 10;
    let local: Uint8Array | null = null;
    if (packed & 0x80) {
      const n = 3 * (1 << ((packed & 7) + 1));
      if (p + n > b.length) return null;
      local = b.subarray(p, p + n);
      p += n;
    }
    const palette = local ?? global;
    if (!palette || p + 1 >= b.length) return null;
    const minCode = b[p]!;
    const data = p + 1;
    const end = skipBlocks(b, data);
    if (end < 0 || minCode < 2 || minCode > 8) return null;
    frames.push({ at, end, rect, packed, local, palette, minCode, data, disposal: control?.disposal ?? 0, transparent: control?.transparent ?? null });
    control = null;
    p = end;
  }
  return frames.length > 0 ? { bytes, width, height, frames } : null;
}

/** The codes a frame's data was written with, in order: clears and the end code among them. */
export interface Codes {
  code: Uint16Array;
  n: number;
}

/**
 * A frame's colour indices, row by row (its rect, not the screen), and, when `codes` is given, the codes that wrote
 * them. Null when its data cannot be read. A stream that ends early leaves the rest 0; one that runs long is cut at
 * the frame's size.
 */
export function decodeFrame(gif: Gif, f: Frame, codes?: Codes): Uint8Array | null {
  const b = gif.bytes;
  const size = f.rect.w * f.rect.h;
  const out = new Uint8Array(size);
  const clear = 1 << f.minCode;
  const eoi = clear + 1;
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const first = new Uint8Array(4096);
  const length = new Uint16Array(4096);
  for (let i = 0; i < clear; i++) {
    suffix[i] = i;
    first[i] = i;
    length[i] = 1;
  }
  let codeSize = f.minCode + 1;
  let next = eoi + 1;
  let prev = -1;
  let op = 0;
  let acc = 0;
  let bits = 0;
  let p = f.data;
  let left = 0; // bytes left in the current sub-block
  const note = (code: number) => {
    if (!codes) return;
    if (codes.n === codes.code.length) {
      const grown = new Uint16Array(Math.max(1024, codes.n * 2));
      grown.set(codes.code);
      codes.code = grown;
    }
    codes.code[codes.n++] = code;
  };
  for (;;) {
    while (bits < codeSize) {
      if (left === 0) {
        if (p >= b.length) return out;
        left = b[p++]!;
        if (left === 0) return out;
      }
      acc |= b[p++]! << bits;
      bits += 8;
      left--;
    }
    const code = acc & ((1 << codeSize) - 1);
    acc >>>= codeSize;
    bits -= codeSize;
    if (code === clear) {
      note(code);
      codeSize = f.minCode + 1;
      next = eoi + 1;
      prev = -1;
      continue;
    }
    if (code === eoi) {
      note(code);
      return out;
    }
    if (prev === -1) {
      if (code >= clear) return null;
    } else {
      if (code > next || (code === next && next >= 4096)) return null;
      if (next < 4096) {
        // The new entry is the previous string and the first pixel of this one; when this code IS the new entry,
        // that first pixel is the previous string's own.
        prefix[next] = prev;
        suffix[next] = code === next ? first[prev]! : first[code]!;
        first[next] = first[prev]!;
        length[next] = length[prev]! + 1;
        next++;
        if (next === 1 << codeSize && codeSize < 12) codeSize++;
      }
    }
    note(code);
    const n = length[code]!;
    let k = code;
    for (let i = n - 1; i >= 0; i--) {
      if (op + i < size) out[op + i] = suffix[k]!;
      k = prefix[k]!;
    }
    op += n;
    if (op >= size) return out;
    prev = code;
  }
}

// The writer's table: (a string's code, the next index) -> its code. An entry counts only while its generation is the
// table's, so a clear empties it without touching 6 MB. Made once, kept for the next GIF.
let seen: Uint32Array | null = null;
let coded: Uint16Array | null = null;
let gen = 0;

/**
 * GIF image data written code by code. It keeps the reader's count of entries, which sets each code's width, so
 * codes copied from another stream come out at the widths they were read at.
 */
class LzwWriter {
  private readonly minCode: number;
  private readonly clearCode: number;
  private readonly eoi: number;
  /** The entry the reader adds on its next code (none on the first after a clear), and so the width it reads at. */
  private read: number;
  /** The entry this writer adds next: one ahead of the reader's once a code is out. */
  private added: number;
  private firstAfterClear = true;
  private body: Uint8Array;
  private len = 0;
  private acc = 0;
  private bits = 0;
  private readonly table: Uint32Array;
  private readonly codes: Uint16Array;

  constructor(minCode: number) {
    this.minCode = minCode;
    this.clearCode = 1 << minCode;
    this.eoi = this.clearCode + 1;
    this.read = this.eoi + 1;
    this.added = this.eoi + 1;
    this.body = new Uint8Array(1 << 16);
    seen ??= new Uint32Array(4096 * 256);
    coded ??= new Uint16Array(4096 * 256);
    this.table = seen;
    this.codes = coded;
    this.newTable();
  }

  private newTable(): void {
    if (gen > 0xfffff000) {
      this.table.fill(0);
      gen = 0;
    }
    gen++;
  }

  private put(code: number): void {
    // The reader's width: enough bits for its next entry's number, from one more than the minimum, at most 12.
    let width = this.minCode + 1;
    while (width < 12 && this.read >= 1 << width) width++;
    this.acc |= code << this.bits;
    this.bits += width;
    while (this.bits >= 8) this.byte();
  }

  private byte(): void {
    if (this.len === this.body.length) {
      const grown = new Uint8Array(this.body.length * 2);
      grown.set(this.body);
      this.body = grown;
    }
    this.body[this.len++] = this.acc & 0xff;
    this.acc >>>= 8;
    this.bits = Math.max(0, this.bits - 8);
  }

  clear(): void {
    this.put(this.clearCode);
    this.read = this.eoi + 1;
    this.added = this.eoi + 1;
    this.firstAfterClear = true;
    this.newTable();
  }

  code(c: number): void {
    this.put(c);
    if (!this.firstAfterClear && this.read < 4096) this.read++;
    this.firstAfterClear = false;
  }

  /** The longest strings first, over all of `px`: a full table is cleared and started again. */
  greedy(px: Uint8Array): void {
    if (px.length === 0) return;
    let s = px[0]!;
    for (let p = 1; p < px.length; p++) {
      const k = px[p]!;
      const key = (s << 8) | k;
      if (this.table[key] === gen) {
        s = this.codes[key]!;
        continue;
      }
      this.code(s);
      if (this.added < 4096) {
        this.table[key] = gen;
        this.codes[key] = this.added++;
      } else {
        this.clear();
      }
      s = k;
    }
    this.code(s);
  }

  /** The end code, and the data as GIF sub-blocks: the minimum code size byte, blocks of at most 255, the 0. */
  finish(): Uint8Array {
    this.put(this.eoi);
    if (this.bits > 0) this.byte();
    const len = this.len;
    const out = new Uint8Array(1 + len + Math.ceil(len / 255) + 1);
    out[0] = this.minCode;
    let o = 1;
    for (let i = 0; i < len; i += 255) {
      const n = Math.min(255, len - i);
      out[o++] = n;
      out.set(this.body.subarray(i, i + n), o);
      o += n;
    }
    out[o] = 0;
    return out;
  }
}

/** The band: its height, and its words as RGBA over the whole width (drawn by the caller; alpha 0 where none). */
export interface Band {
  height: number;
  words: Uint8Array | Uint8ClampedArray;
}

/**
 * The GIF with `band` across its top, or null when that cannot be done faithfully, or the result would be larger than
 * `maxBytes`. The band's ground is the first frame's top row, carried up; its words are laid over that in the first
 * frame's own colours.
 */
export function addBand(gif: Gif, band: Band, opts: { maxBytes?: number } = {}): Uint8Array<ArrayBuffer> | null {
  const { bytes, width, height } = gif;
  const h = band.height;
  if (h <= 0 || height + h > 0xffff || band.words.length !== width * h * 4) return null;
  const f0 = gif.frames[0]!;
  if (f0.rect.x !== 0 || f0.rect.y !== 0 || f0.rect.w !== width || f0.rect.h !== height || f0.packed & INTERLACED) return null;
  for (const f of gif.frames) if (f.rect.y + h + f.rect.h > 0xffff) return null;
  const codes: Codes = { code: new Uint16Array(1 << 16), n: 0 };
  const idx = decodeFrame(gif, f0, codes);
  if (!idx) return null;
  const pal = f0.palette;
  const t = f0.transparent;
  const colours = pal.length / 3;

  // The band in the first frame's colours: its top row carried up, the words over it at their nearest.
  const px = new Uint8Array(width * h);
  const nearest = new Map<number, number>();
  for (let x = 0; x < width; x++) {
    if (idx[x] === t || idx[x]! >= colours) return null;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < width; x++) {
      const ground = idx[x]!;
      const o = (y * width + x) * 4;
      const a = band.words[o + 3]! / 255;
      if (a === 0) {
        px[y * width + x] = ground;
        continue;
      }
      const r = Math.round(pal[ground * 3]! * (1 - a) + band.words[o]! * a);
      const g = Math.round(pal[ground * 3 + 1]! * (1 - a) + band.words[o + 1]! * a);
      const bl = Math.round(pal[ground * 3 + 2]! * (1 - a) + band.words[o + 2]! * a);
      const key = (r << 16) | (g << 8) | bl;
      let j = nearest.get(key);
      if (j === undefined) {
        let best = Infinity;
        j = ground;
        for (let q = 0; q < colours; q++) {
          if (q === t) continue;
          const dr = pal[q * 3]! - r;
          const dg = pal[q * 3 + 1]! - g;
          const db = pal[q * 3 + 2]! - bl;
          const d = 3 * dr * dr + 4 * dg * dg + 2 * db * db;
          if (d < best) {
            best = d;
            j = q;
          }
        }
        nearest.set(key, j);
      }
      px[y * width + x] = j;
    }
  }

  // The first frame again: the band's rows, then a clear and the island's own codes, each at the width it was read.
  const w = new LzwWriter(f0.minCode);
  const clear = 1 << f0.minCode;
  w.clear();
  w.greedy(px);
  // The island's stream starts afresh: with its own clear, or with this one.
  if (codes.code[0] !== clear) w.clear();
  for (let i = 0; i < codes.n; i++) {
    const c = codes.code[i]!;
    if (c === clear + 1) break;
    if (c === clear) w.clear();
    else w.code(c);
  }
  const data = w.finish();

  const head = new Uint8Array(10);
  head[0] = 0x2c;
  head[5] = width & 0xff;
  head[6] = width >> 8;
  head[7] = (height + h) & 0xff;
  head[8] = (height + h) >> 8;
  head[9] = f0.packed;
  const before = bytes.slice(0, f0.at);
  before[8] = (height + h) & 0xff;
  before[9] = (height + h) >> 8;
  const after = bytes.slice(f0.end);
  // Every later frame one band lower: its descriptor's top, and nothing else of it.
  for (const f of gif.frames.slice(1)) {
    const y = f.rect.y + h;
    after[f.at - f0.end + 3] = y & 0xff;
    after[f.at - f0.end + 4] = y >> 8;
  }
  const local = f0.local ?? new Uint8Array(0);
  const total = before.length + head.length + local.length + data.length + after.length;
  if (opts.maxBytes !== undefined && total > opts.maxBytes) return null;
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of [before, head, local, data, after]) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
