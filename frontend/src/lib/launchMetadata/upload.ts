// Browser side of a launch's picture and details: shrink the picture, get the
// creator's wallet to sign what is being pinned, send it to /api/launch-upload, and
// read metadata files back from IPFS or Arweave.
//
// Honesty rules this file keeps:
//   * "not configured" is only reported when the server SAYS so (JSON, configured
//     false or a 503 not-configured). A missing route answers 200 text/html through
//     the SPA fallback on Vercel and on `vite preview`, and must not read as "on".
//   * A metadata file we could not fetch is `unreadable`, never `invalid`: a
//     network error, a CSP block or a gateway timeout says nothing about the file.
//   * An upload the server answered with details that differ from what was asked
//     for is a failure, not a success with a warning.

import {
  LIMITS,
  UPLOAD_SIGNATURE_TTL_MS,
  buildMetadataJson,
  checkContentUri,
  checkDescription,
  checkLinks,
  checkName,
  checkSymbol,
  detailsDigestInput,
  displaySafe,
  hasEmbeddedMetadata,
  isPubkeyString,
  parseLaunchMetadataJson,
  sha256Hex,
  sniffImage,
  uploadAuthMessage,
  type ImageMime,
  type LaunchLinks,
  type LaunchMetadataJson,
  type ReadLaunchMetadata,
} from './validate.js';
import { base58 } from '@scure/base';
import { IPFS_GATEWAYS, IPFS_STEP_TIMEOUT_MS, fetchIpfsStep, ipfsGatewayUrls } from '../ipfsGateways';

export type { ImageMime, LaunchLinks, LaunchMetadataJson, ReadLaunchMetadata };

export const UPLOAD_ENDPOINT = '/api/launch-upload';

/** For the file input. Exact types, so iOS converts a HEIC photo to JPEG on pick. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

/**
 * How long an upload may be reused for a launch. The server removes pins whose mint
 * never got a launch 30 minutes after pinning; past this, upload again.
 */
export const UPLOAD_REUSE_MS = 20 * 60 * 1000;

/** Largest file we will even try to open. Phone photos are 2-8 MB; this stops a 200 MB mistake. */
export const MAX_SOURCE_BYTES = 30 * 1024 * 1024;

const STATUS_TIMEOUT_MS = 8_000;
const UPLOAD_TIMEOUT_MS = 60_000;
// Long enough for the whole IPFS gateway walk: each gateway gets IPFS_STEP_TIMEOUT_MS
// to start answering, plus room for the small JSON body (as metadataUri.ts does).
const READ_TIMEOUT_MS = IPFS_STEP_TIMEOUT_MS * IPFS_GATEWAYS.length + 2_000;

// ── is the upload service on ────────────────────────────────────────────────

/** `no` only when the server SAYS uploads are off; a failed or odd answer is `unknown`. */
export type UploadStatus = 'yes' | 'no' | 'unknown';

/**
 * `yes` only when the endpoint answers JSON with `configured: true`; `no` only when
 * it answers JSON saying it is not configured. Anything else (HTML from a fallback,
 * an error, a timeout) is `unknown`: one slow or failed check says nothing about
 * whether uploads are on, so the form offers to check again.
 */
export async function uploadsAvailable(fetchImpl: typeof fetch = fetch): Promise<UploadStatus> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(UPLOAD_ENDPOINT, { method: 'GET', credentials: 'same-origin', signal: ctl.signal });
    if (!isJson(res)) return 'unknown';
    const body = (await res.json()) as { configured?: unknown; reason?: unknown } | null;
    if (!body || typeof body !== 'object') return 'unknown';
    if (res.status === 503 && body.reason === 'not-configured') return 'no';
    if (!res.ok) return 'unknown';
    return body.configured === true ? 'yes' : body.configured === false ? 'no' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

const isJson = (res: Response) => /^application\/json\b/i.test(res.headers.get('content-type') ?? '');

// ── the picture ─────────────────────────────────────────────────────────────

export interface PreparedImage {
  bytes: Uint8Array;
  mime: ImageMime;
  width: number;
  height: number;
}

export type PreparedImageResult = { ok: true; image: PreparedImage } | { ok: false; reason: string };

/** The two browser operations picture preparation needs, injectable for tests. */
export interface ImageCodec {
  decode(file: Blob): Promise<{ width: number; height: number; close?: () => void }>;
  /** Draw `source` at width × height and encode it. `opaque` paints white first (for JPEG). Null when the browser cannot. */
  encode(
    source: { width: number; height: number },
    width: number,
    height: number,
    mime: ImageMime,
    quality: number | undefined,
    opaque: boolean,
  ): Promise<Blob | null>;
}

export const browserImageCodec: ImageCodec = {
  async decode(file) {
    return createImageBitmap(file);
  },
  async encode(source, width, height, mime, quality, opaque) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    if (opaque) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source as CanvasImageSource, 0, 0, width, height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), mime, quality));
  },
};

/** Fit inside a square of `max` pixels, keeping the shape. Never enlarges. */
export function fitWithin(width: number, height: number, max: number = LIMITS.targetImageSide): { width: number; height: number } {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

const isGifBytes = (b: Uint8Array) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38;
const looksLikeText = (b: Uint8Array) => {
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  return b[i] === 0x3c; // '<': SVG, HTML, XML
};

/**
 * Turn whatever the creator picked into the picture that gets pinned.
 *
 * Every picture except a GIF is re-drawn: that shrinks a phone photo to at most
 * 1024 pixels a side (under the 1 MB limit) and drops its EXIF block, which holds
 * the GPS position the photo was taken at. A GIF is kept as it is (re-drawing would
 * stop the animation), so it must already be small and clean.
 */
export async function prepareLaunchImage(file: Blob, codec: ImageCodec = browserImageCodec): Promise<PreparedImageResult> {
  if (file.size === 0) return { ok: false, reason: 'The picture is empty.' };
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, reason: 'That file is too large to use. Pick a picture under 30 MB.' };
  const src = new Uint8Array(await file.arrayBuffer());
  if (file.type === 'image/svg+xml' || looksLikeText(src)) {
    return { ok: false, reason: 'SVG and other text-based pictures are not allowed. Use PNG, JPEG, WebP or GIF.' };
  }

  if (isGifBytes(src)) {
    const s = sniffImage(src);
    if (!s.ok) return { ok: false, reason: src.length > LIMITS.imageBytes ? 'GIFs are kept as they are, so they must be under 1 MB.' : s.reason };
    if (hasEmbeddedMetadata(src, s.mime)) {
      return { ok: false, reason: 'This GIF carries hidden embedded data. Save it again without it, or use a PNG.' };
    }
    return { ok: true, image: { bytes: src, mime: s.mime, width: s.width, height: s.height } };
  }

  let bitmap: Awaited<ReturnType<ImageCodec['decode']>>;
  try {
    bitmap = await codec.decode(file);
  } catch {
    return { ok: false, reason: 'This picture could not be opened. Use PNG, JPEG, WebP or GIF.' };
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    // WebP first (small, keeps transparency). Safari cannot encode WebP and quietly
    // hands back a PNG instead, which is why each result is sniffed, not trusted.
    const attempts: [ImageMime, number | undefined, boolean][] = [
      ['image/webp', 0.9, false],
      ['image/png', undefined, false],
      ['image/jpeg', 0.88, true],
      ['image/jpeg', 0.72, true],
    ];
    for (const [mime, quality, opaque] of attempts) {
      const blob = await codec.encode(bitmap, width, height, mime, quality, opaque);
      if (!blob) continue;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const s = sniffImage(bytes);
      if (!s.ok || s.mime !== mime || hasEmbeddedMetadata(bytes, s.mime)) continue;
      return { ok: true, image: { bytes, mime: s.mime, width: s.width, height: s.height } };
    }
    return { ok: false, reason: 'This picture could not be made small enough. Try a simpler picture.' };
  } finally {
    bitmap.close?.();
  }
}

// ── the upload ──────────────────────────────────────────────────────────────

export interface UploadInput {
  image: PreparedImage;
  name: string;
  symbol: string;
  description: string;
  links: LaunchLinks;
  /** The new mint's address (its keypair stays in the page). */
  mint: string;
  /** The connected wallet, which signs the upload and will sign the launch. */
  creator: string;
  /** The wallet's signMessage. Called once, with the exact text the server re-builds. */
  signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}

export type UploadResult =
  | {
      ok: true;
      metadataUri: string;
      imageUri: string;
      metadata: LaunchMetadataJson;
      /** Epoch ms after which this upload must not be used for a launch (upload again). */
      reuseUntil: number;
    }
  | { ok: false; reason: string; notConfigured: boolean; retryable: boolean; field?: string };

const fail = (reason: string, retryable: boolean, extra: { notConfigured?: boolean; field?: string } = {}): UploadResult => ({
  ok: false,
  reason,
  retryable,
  notConfigured: extra.notConfigured ?? false,
  ...(extra.field ? { field: extra.field } : {}),
});

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Validate, sign, upload. Nothing is pinned unless the wallet signs. */
export async function uploadLaunchMetadata(
  input: UploadInput,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<UploadResult> {
  const name = checkName(input.name);
  if (!name.ok) return fail(name.reason, false, { field: 'name' });
  const symbol = checkSymbol(input.symbol);
  if (!symbol.ok) return fail(symbol.reason, false, { field: 'symbol' });
  const description = checkDescription(input.description);
  if (!description.ok) return fail(description.reason, false, { field: 'description' });
  const links = checkLinks(input.links);
  if (!links.ok) return fail(links.reason, false, { field: links.field });
  if (!isPubkeyString(input.mint) || !isPubkeyString(input.creator) || input.mint === input.creator) {
    return fail('The mint or wallet address is not valid.', false);
  }
  const sniff = sniffImage(input.image.bytes);
  if (!sniff.ok) return fail(sniff.reason, false, { field: 'image' });
  if (sniff.mime !== input.image.mime || hasEmbeddedMetadata(input.image.bytes, sniff.mime)) {
    return fail('The picture was not prepared for upload. Pick it again.', false, { field: 'image' });
  }

  const expiresAt = new Date(now() + UPLOAD_SIGNATURE_TTL_MS).toISOString();
  const details = { name: name.value, symbol: symbol.value, description: description.value, links: links.value };
  const message = uploadAuthMessage({
    name: name.value,
    symbol: symbol.value,
    mint: input.mint,
    creator: input.creator,
    detailsSha256: await sha256Hex(detailsDigestInput(details)),
    imageSha256: await sha256Hex(input.image.bytes),
    expiresAt,
  });

  let signature: Uint8Array;
  try {
    signature = await input.signMessage(new TextEncoder().encode(message));
  } catch {
    return fail('The wallet did not sign. Nothing was uploaded.', true);
  }
  if (!(signature instanceof Uint8Array) || signature.length !== 64) {
    return fail('The wallet returned a signature this site cannot use. Try another wallet, or paste a metadata link.', false);
  }

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), UPLOAD_TIMEOUT_MS);
  let res: Response;
  let body = {} as Record<string, unknown>;
  let unparsed = false;
  try {
    res = await fetchImpl(UPLOAD_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...details,
        mint: input.mint,
        creator: input.creator,
        expiresAt,
        signature: base58.encode(signature),
        image: { mime: sniff.mime, base64: toBase64(input.image.bytes) },
      }),
      signal: ctl.signal,
    });
    // Read before the timer is cleared: a service that stops part-way was not reached.
    // An abort here can come back as a parse error, so the signal says which it was.
    if (isJson(res)) {
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch (e) {
        if (ctl.signal.aborted) throw e;
        unparsed = true;
      }
    }
  } catch {
    return fail('Could not reach the upload service. Nothing was launched. Try again.', true);
  } finally {
    clearTimeout(timer);
  }

  if (!isJson(res)) {
    // An HTML page here is the SPA fallback: the route does not exist on this deployment.
    return fail('Picture upload is not available here. Paste a metadata link instead.', false, { notConfigured: true });
  }
  if (unparsed) {
    return fail('The upload service sent an answer this page could not read. Nothing was launched. Try again.', true);
  }
  const serverSays = typeof body?.error === 'string' ? displaySafe(body.error, 200) : '';
  const field = typeof body?.field === 'string' ? body.field : undefined;

  if (!res.ok) {
    if (res.status === 503 && body?.reason === 'not-configured') {
      return fail('Picture upload is not set up yet. Paste a metadata link instead.', false, { notConfigured: true });
    }
    if (res.status === 429) return fail('Too many uploads from here. Wait a while and try again.', true);
    if (res.status >= 500) return fail(serverSays || 'The upload service had a problem. Nothing was launched. Try again.', true);
    return fail(serverSays || 'The upload was refused.', false, field ? { field } : {});
  }

  const metadataUri = checkContentUri(body.metadataUri);
  const imageUri = checkContentUri(body.imageUri);
  const expected = imageUri.ok
    ? buildMetadataJson({ ...details, imageUri: imageUri.value, mint: input.mint })
    : null;
  const got = body.metadata as LaunchMetadataJson | undefined;
  if (!metadataUri.ok || !imageUri.ok || !expected || !got || JSON.stringify(got) !== JSON.stringify(expected)) {
    return fail('The upload service answered with details that do not match what you entered. Nothing was launched. Try again.', true);
  }
  return {
    ok: true,
    metadataUri: metadataUri.value,
    imageUri: imageUri.value,
    metadata: expected,
    reuseUntil: now() + UPLOAD_REUSE_MS,
  };
}

// ── reading a metadata file back ────────────────────────────────────────────

export type MetadataRead =
  | { kind: 'ok'; json: ReadLaunchMetadata; mintMatches: boolean; issues: string[] }
  | { kind: 'unreadable'; detail: string }
  | { kind: 'invalid'; reason: string };

/** Read a response body, stopping at `max` bytes. Null means it was larger. */
async function readCapped(res: Response, max: number): Promise<Uint8Array | null> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => undefined);
    return null;
  }
  if (!res.body) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > max ? null : buf;
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

/**
 * Fetch and check the metadata file a launch points at. Works for launches made
 * anywhere: every field is re-checked on read, and the result says whether the file
 * names the same mint (a copied file from another token will not).
 */
export async function readLaunchMetadataJson(
  uri: string,
  expectedMint: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = READ_TIMEOUT_MS,
): Promise<MetadataRead> {
  const at = checkContentUri(uri);
  if (!at.ok) return { kind: 'invalid', reason: 'The details are not stored at a content address, so they are not shown.' };
  // IPFS is read through the site's gateway list, one after another: a single
  // gateway failing (retired, rate-limited, hanging) says nothing about the file.
  const gateways = ipfsGatewayUrls(at.value);
  const urls = gateways.length ? gateways : [at.value];
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const init: RequestInit = { credentials: 'omit', referrerPolicy: 'no-referrer' };
  let detail = 'Could not reach the file host.';
  try {
    for (const url of urls) {
      let res: Response;
      try {
        res = gateways.length
          ? await fetchIpfsStep(fetchImpl, url, ctl.signal, IPFS_STEP_TIMEOUT_MS, init)
          : await fetchImpl(url, { ...init, signal: ctl.signal });
      } catch {
        if (ctl.signal.aborted) break;
        detail = 'Could not reach the file host.';
        continue;
      }
      if (!res.ok) {
        detail = `The file host answered ${res.status}.`;
        continue;
      }
      if (/^text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
        detail = 'The file host sent a web page instead of the file.';
        continue;
      }
      let bytes: Uint8Array | null;
      try {
        bytes = await readCapped(res, LIMITS.metadataJsonBytes);
      } catch {
        detail = 'The file stopped arriving part way.';
        continue;
      }
      if (bytes === null) return { kind: 'invalid', reason: 'The details file is larger than 64 KB.' };
      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        return { kind: 'invalid', reason: 'The details file is not text.' };
      }
      return parseLaunchMetadataJson(text, expectedMint);
    }
    return { kind: 'unreadable', detail };
  } finally {
    clearTimeout(timer);
  }
}
