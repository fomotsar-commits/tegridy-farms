// Byte-level picture fixtures for the launch-metadata tests. Only the headers the
// sniffer and the metadata scanner read are real; that is all either function looks at.

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u32le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];

/** A real 1×1 PNG (decodes in any browser). */
export const PNG_1X1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const pngChunk = (type: string, data: number[]) => [...u32be(data.length), ...ascii(type), ...data, 0, 0, 0, 0];

export function png(w: number, h: number, opts: { text?: boolean } = {}): Uint8Array {
  return Uint8Array.from([
    0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk('IHDR', [...u32be(w), ...u32be(h), 8, 6, 0, 0, 0]),
    ...(opts.text ? pngChunk('tEXt', ascii('Comment\0hello')) : []),
    ...pngChunk('IDAT', [0, 0, 0]),
    ...pngChunk('IEND', []),
  ]);
}

export function jpeg(w: number, h: number, opts: { exif?: boolean; xmp?: boolean; iptc?: boolean; progressive?: boolean } = {}): Uint8Array {
  const seg = (marker: number, data: number[]) => [0xff, marker, ...u16be(data.length + 2), ...data];
  return Uint8Array.from([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...(opts.exif ? seg(0xe1, [...ascii('Exif\0\0'), 0x4d, 0x4d, 0, 0x2a]) : []),
    ...(opts.xmp ? seg(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x/>')) : []),
    ...(opts.iptc ? seg(0xed, ascii('Photoshop 3.0\0')) : []),
    ...seg(opts.progressive ? 0xc2 : 0xc0, [8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    ...seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
    0x12, 0x34, 0xff, 0xd9,
  ]);
}

export function gif(w: number, h: number, opts: { xmp?: boolean } = {}): Uint8Array {
  return Uint8Array.from([
    ...ascii('GIF89a'), ...u16le(w), ...u16le(h), 0, 0, 0,
    ...(opts.xmp ? [0x21, 0xff, 0x0b, ...ascii('XMP DataXMP'), 0] : []),
    0x3b,
  ]);
}

const riff = (body: number[]) => Uint8Array.from([...ascii('RIFF'), ...u32le(body.length + 4), ...ascii('WEBP'), ...body]);
const riffChunk = (type: string, data: number[]) => [...ascii(type), ...u32le(data.length), ...data, ...(data.length & 1 ? [0] : [])];

export function webpVp8x(w: number, h: number, opts: { exif?: boolean } = {}): Uint8Array {
  return riff([
    ...riffChunk('VP8X', [opts.exif ? 0x08 : 0, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]),
    ...riffChunk('VP8L', [0x2f, 0, 0, 0, 0]),
    ...(opts.exif ? riffChunk('EXIF', ascii('MM\0*')) : []),
  ]);
}

export function webpVp8l(w: number, h: number): Uint8Array {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff(riffChunk('VP8L', [0x2f, ...u32le(bits >>> 0), 0, 0, 0]));
}

export function webpVp8(w: number, h: number): Uint8Array {
  return riff(riffChunk('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h), 0, 0]));
}

export const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>');
