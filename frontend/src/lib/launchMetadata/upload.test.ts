// @vitest-environment node
// The browser half of the launch upload. The server half, and the two talking to
// each other for real, are in api/__tests__/launch-upload.test.js.

import { describe, it, expect, vi } from 'vitest';
import {
  UPLOAD_REUSE_MS,
  fitWithin,
  prepareLaunchImage,
  readLaunchMetadataJson,
  uploadLaunchMetadata,
  uploadsAvailable,
  type ImageCodec,
  type UploadInput,
} from './upload';
import { buildMetadataJson, sha256Hex } from './validate.js';
import { PNG_1X1, SVG, gif, jpeg, png, webpVp8x } from './testImages.fixture';

const MINT = 'So11111111111111111111111111111111111111112';
const CREATOR = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
const IMG = `https://ipfs.io/ipfs/bafkrei${'a'.repeat(52)}`;
const META = `https://ipfs.io/ipfs/bafkrei${'b'.repeat(52)}`;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const html = (status = 200) => new Response('<!doctype html><div id=root></div>', { status, headers: { 'content-type': 'text/html' } });
const fetchReturning = (r: Response | (() => Promise<Response>)) =>
  vi.fn(async () => (typeof r === 'function' ? r() : r)) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

describe('uploadsAvailable', () => {
  it('is true only for JSON saying configured: true', async () => {
    expect(await uploadsAvailable(fetchReturning(json({ configured: true })))).toBe(true);
    expect(await uploadsAvailable(fetchReturning(json({ configured: false })))).toBe(false);
    expect(await uploadsAvailable(fetchReturning(json({ configured: 'true' })))).toBe(false);
  });

  it('treats the SPA fallback (200 text/html for a missing route) as off', async () => {
    expect(await uploadsAvailable(fetchReturning(html(200)))).toBe(false);
    // Even an HTML-typed page whose text happens to parse as {"configured":true}.
    const lookalike = new Response('{"configured":true}', { status: 200, headers: { 'content-type': 'text/html' } });
    expect(await uploadsAvailable(fetchReturning(lookalike))).toBe(false);
  });

  it('treats errors and outages as off', async () => {
    expect(await uploadsAvailable(fetchReturning(json({ configured: true }, 503)))).toBe(false);
    expect(await uploadsAvailable(vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch)).toBe(false);
  });
});

describe('fitWithin', () => {
  it('shrinks a phone photo to 1024 on the long side and never enlarges', () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 768, height: 1024 });
    expect(fitWithin(500, 300)).toEqual({ width: 500, height: 300 });
  });
});

/** A codec that "decodes" to the given size and encodes with `encodeAs`. */
function fakeCodec(size: { width: number; height: number }, encodeAs: (mime: string, w: number, h: number) => Uint8Array | null) {
  const close = vi.fn();
  const codec: ImageCodec & { calls: string[] } = {
    calls: [],
    decode: vi.fn(async () => ({ ...size, close })),
    encode: vi.fn(async (_s, w, h, mime) => {
      codec.calls.push(`${mime} ${w}x${h}`);
      const bytes = encodeAs(mime, w, h);
      return bytes ? new Blob([bytes as BlobPart]) : null;
    }),
  };
  return { codec, close };
}

describe('prepareLaunchImage', () => {
  it('refuses SVG without trying to open it', async () => {
    const { codec } = fakeCodec({ width: 1, height: 1 }, () => null);
    const r = await prepareLaunchImage(new Blob([SVG as BlobPart], { type: 'image/png' }), codec);
    expect(r).toMatchObject({ ok: false });
    expect(codec.decode).not.toHaveBeenCalled();
  });

  it('keeps a small clean GIF byte for byte (re-drawing would stop the animation)', async () => {
    const g = gif(64, 64);
    const { codec } = fakeCodec({ width: 1, height: 1 }, () => null);
    const r = await prepareLaunchImage(new Blob([g as BlobPart]), codec);
    expect(r.ok && [...r.image.bytes]).toEqual([...g]);
    expect(codec.decode).not.toHaveBeenCalled();
  });

  it('refuses a GIF with embedded data, and one over 1 MB', async () => {
    const { codec } = fakeCodec({ width: 1, height: 1 }, () => null);
    expect(await prepareLaunchImage(new Blob([gif(8, 8, { xmp: true }) as BlobPart]), codec)).toMatchObject({ ok: false });
    const big = new Uint8Array(1048577);
    big.set(gif(8, 8));
    const r = await prepareLaunchImage(new Blob([big as BlobPart]), codec);
    expect(r.ok === false && r.reason).toMatch(/1 MB/);
  });

  it('re-draws a large phone photo at 1024 px as WebP and releases the bitmap', async () => {
    const { codec, close } = fakeCodec({ width: 4032, height: 3024 }, (mime, w, h) => (mime === 'image/webp' ? webpVp8x(w, h) : null));
    const r = await prepareLaunchImage(new Blob([jpeg(4032, 3024, { exif: true }) as BlobPart], { type: 'image/jpeg' }), codec);
    expect(r).toMatchObject({ ok: true, image: { mime: 'image/webp', width: 1024, height: 768 } });
    expect(codec.calls).toEqual(['image/webp 1024x768']);
    expect(close).toHaveBeenCalledOnce();
  });

  it('does not trust the encoder: Safari hands back PNG when asked for WebP', async () => {
    const { codec } = fakeCodec({ width: 800, height: 600 }, (_mime, w, h) => png(w, h));
    const r = await prepareLaunchImage(new Blob([PNG_1X1 as BlobPart], { type: 'image/png' }), codec);
    expect(r).toMatchObject({ ok: true, image: { mime: 'image/png', width: 800, height: 600 } });
    expect(codec.calls).toEqual(['image/webp 800x600', 'image/png 800x600']);
  });

  it('never returns a picture that still carries EXIF', async () => {
    const { codec } = fakeCodec({ width: 100, height: 100 }, (mime, w, h) => (mime === 'image/jpeg' ? jpeg(w, h, { exif: true }) : null));
    expect(await prepareLaunchImage(new Blob([PNG_1X1 as BlobPart]), codec)).toMatchObject({ ok: false });
  });

  it('says so plainly when the picture cannot be opened', async () => {
    const codec: ImageCodec = { decode: async () => { throw new Error('HEIC'); }, encode: async () => null };
    const r = await prepareLaunchImage(new Blob([new Uint8Array([1, 2, 3, 4]) as BlobPart], { type: 'image/heic' }), codec);
    expect(r.ok === false && r.reason).toMatch(/could not be opened/);
  });
});

function input(over: Partial<UploadInput> = {}): UploadInput & { signMessage: ReturnType<typeof vi.fn> } {
  return {
    image: { bytes: PNG_1X1, mime: 'image/png', width: 1, height: 1 },
    name: 'Pepe',
    symbol: 'pepe',
    description: 'a frog',
    links: { twitter: '@pepe' },
    mint: MINT,
    creator: CREATOR,
    signMessage: vi.fn(async () => new Uint8Array(64).fill(7)),
    ...over,
  } as UploadInput & { signMessage: ReturnType<typeof vi.fn> };
}

const goodServerAnswer = () =>
  json({
    metadataUri: META,
    imageUri: IMG,
    metadata: buildMetadataJson({ name: 'Pepe', symbol: 'PEPE', description: 'a frog', imageUri: IMG, links: { twitter: 'https://x.com/pepe' }, mint: MINT }),
  });

describe('uploadLaunchMetadata', () => {
  it('refuses bad input before asking the wallet anything', async () => {
    const i = input({ symbol: 'SOL' });
    const f = fetchReturning(goodServerAnswer());
    expect(await uploadLaunchMetadata(i, f)).toMatchObject({ ok: false, field: 'symbol', retryable: false });
    expect(i.signMessage).not.toHaveBeenCalled();
    expect(f).not.toHaveBeenCalled();
  });

  it('asks the wallet to sign a message that names the mint, the creator and the exact picture', async () => {
    const i = input();
    await uploadLaunchMetadata(i, fetchReturning(goodServerAnswer()), () => Date.parse('2026-09-26T12:00:00Z'));
    const text = new TextDecoder().decode(i.signMessage.mock.calls[0][0] as Uint8Array);
    expect(text).toContain('Name: Pepe');
    expect(text).toContain('Symbol: PEPE');
    expect(text).toContain(`Mint: ${MINT}`);
    expect(text).toContain(`Creator: ${CREATOR}`);
    expect(text).toContain(`Image: ${await sha256Hex(PNG_1X1)}`);
    expect(text).toContain('Expires: 2026-09-26T12:10:00.000Z');
  });

  it('uploads nothing when the wallet does not sign', async () => {
    const f = fetchReturning(goodServerAnswer());
    const r = await uploadLaunchMetadata(input({ signMessage: vi.fn(async () => { throw new Error('User rejected'); }) }), f);
    expect(r).toMatchObject({ ok: false, retryable: true, notConfigured: false });
    expect(f).not.toHaveBeenCalled();
  });

  it('succeeds only when the server returns exactly what was asked for', async () => {
    const r = await uploadLaunchMetadata(input(), fetchReturning(goodServerAnswer()), () => 1_000);
    expect(r).toMatchObject({ ok: true, metadataUri: META, imageUri: IMG, reuseUntil: 1_000 + UPLOAD_REUSE_MS });
  });

  it('refuses a server answer whose details differ (a swapped name, a foreign picture)', async () => {
    const swapped = buildMetadataJson({ name: 'Pepe2', symbol: 'PEPE', description: 'a frog', imageUri: IMG, links: { twitter: 'https://x.com/pepe' }, mint: MINT });
    expect(await uploadLaunchMetadata(input(), fetchReturning(json({ metadataUri: META, imageUri: IMG, metadata: swapped }))))
      .toMatchObject({ ok: false });
    expect(await uploadLaunchMetadata(input(), fetchReturning(json({ metadataUri: 'https://evil.example/m.json', imageUri: IMG, metadata: {} }))))
      .toMatchObject({ ok: false });
  });

  it('reads the SPA fallback and a 503 not-configured as "use paste mode"', async () => {
    expect(await uploadLaunchMetadata(input(), fetchReturning(html()))).toMatchObject({ ok: false, notConfigured: true });
    expect(await uploadLaunchMetadata(input(), fetchReturning(json({ error: 'x', reason: 'not-configured' }, 503))))
      .toMatchObject({ ok: false, notConfigured: true });
  });

  it('tells retryable failures from refusals, and shows the server reason safely', async () => {
    expect(await uploadLaunchMetadata(input(), fetchReturning(json({ error: 'slow down' }, 429)))).toMatchObject({ ok: false, retryable: true });
    expect(await uploadLaunchMetadata(input(), fetchReturning(json({ error: 'pinata down' }, 502)))).toMatchObject({ ok: false, retryable: true });
    const r = await uploadLaunchMetadata(input(), fetchReturning(json({ error: 'Bad \u202Epicture', field: 'image' }, 400)));
    expect(r).toMatchObject({ ok: false, retryable: false, field: 'image', reason: 'Bad picture' });
    expect(await uploadLaunchMetadata(input(), vi.fn(async () => { throw new TypeError('offline'); }) as unknown as typeof fetch))
      .toMatchObject({ ok: false, retryable: true });
  });
});

describe('readLaunchMetadataJson', () => {
  const file = buildMetadataJson({ name: 'Pepe', symbol: 'PEPE', description: '', imageUri: IMG, links: {}, mint: MINT });

  it('reads a good file and checks the mint it names', async () => {
    expect(await readLaunchMetadataJson(META, MINT, fetchReturning(json(file)))).toMatchObject({ kind: 'ok', mintMatches: true });
    expect(await readLaunchMetadataJson(META, CREATOR, fetchReturning(json(file)))).toMatchObject({ kind: 'ok', mintMatches: false });
  });

  it('never fetches a location that is not a content address', async () => {
    const f = fetchReturning(json(file));
    expect(await readLaunchMetadataJson('https://evil.example/m.json', MINT, f)).toMatchObject({ kind: 'invalid' });
    expect(f).not.toHaveBeenCalled();
  });

  it('calls a failed fetch unreadable, never invalid', async () => {
    const offline = vi.fn(async () => { throw new TypeError('Failed to fetch (CSP)'); }) as unknown as typeof fetch;
    expect(await readLaunchMetadataJson(META, MINT, offline)).toMatchObject({ kind: 'unreadable' });
    expect(await readLaunchMetadataJson(META, MINT, fetchReturning(new Response('gone', { status: 504 })))).toMatchObject({ kind: 'unreadable' });
    expect(await readLaunchMetadataJson(META, MINT, fetchReturning(html(200)))).toMatchObject({ kind: 'unreadable' });
  });

  it('gives up on a host that never answers', async () => {
    const hang = vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    })) as unknown as typeof fetch;
    expect(await readLaunchMetadataJson(META, MINT, hang, 20)).toMatchObject({ kind: 'unreadable' });
  });

  it('stops reading at 64 KB, with or without a declared length', async () => {
    // A VALID file that is simply too big, so only the cap can refuse it.
    const big = JSON.stringify({ ...file, description: 'x'.repeat(70_000) });
    const bytes = new TextEncoder().encode(big);
    const streamed = new Response(new ReadableStream({
      start(c) { for (let i = 0; i < bytes.length; i += 10_000) c.enqueue(bytes.slice(i, i + 10_000)); c.close(); },
    }));
    const r = await readLaunchMetadataJson(META, MINT, fetchReturning(streamed));
    expect(r).toEqual({ kind: 'invalid', reason: 'The details file is larger than 64 KB.' });
    expect(await readLaunchMetadataJson(META, MINT, fetchReturning(new Response(big, { headers: { 'content-length': '70000' } }))))
      .toMatchObject({ kind: 'invalid' });
  });

  it('calls a non-JSON body invalid', async () => {
    expect(await readLaunchMetadataJson(META, MINT, fetchReturning(new Response('not json', { headers: { 'content-type': 'text/plain' } }))))
      .toMatchObject({ kind: 'invalid' });
  });
});
