// Stands in for /api/launch-upload and for the IPFS gateway, so the e2e pins nothing.
//
// It is not a rubber stamp: like the real endpoint (api/launch-upload.js) it re-validates
// the fields with the SAME shared validator (src/lib/launchMetadata/validate.js),
// rebuilds the exact message the wallet was asked to sign and verifies the Ed25519
// signature over it before "pinning". The content ids it returns are real CIDv1 (raw,
// sha2-256) of the bytes it serves, so the page's content-address checks see genuine
// values. What it serves back at https://ipfs.io/ipfs/<cid> is exactly what was posted.
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { BrowserContext, Route } from '@playwright/test';
import { PublicKey } from '@solana/web3.js';
import {
  buildMetadataJson, checkDescription, checkLinks, checkName, checkSymbol, detailsDigestInput, sniffImage, uploadAuthMessage,
} from '../../src/lib/launchMetadata/validate.js';

export interface UploadRecord { at: string; mint: string; creator: string; name: string; symbol: string; imageBytes: number; metadataUri: string; imageUri: string }
export interface UploadStub {
  readonly uploads: UploadRecord[];
  readonly refusals: string[];
  /** Answer GET with configured:false and POST with 503 not-configured (the paste-link path). */
  setConfigured(on: boolean): void;
}

/** CIDv1, raw codec, sha2-256, base32 lower: what `ipfs add --cid-version 1 --raw-leaves` gives a small file. */
export function cidV1Raw(bytes: Uint8Array): string {
  const digest = crypto.createHash('sha256').update(bytes).digest();
  const cid = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), digest]);
  const A = 'abcdefghijklmnopqrstuvwxyz234567';
  let bits = 0; let value = 0; let out = '';
  for (const b of cid) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += A[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += A[(value << (5 - bits)) & 31];
  return `b${out}`;
}

/** A valid w×h RGB PNG (a diagonal gradient), built here so the repo carries no binary fixture. */
export function makePng(w = 96, h = 96): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf: Buffer) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * 255) / w; raw[o + 1] = 160; raw[o + 2] = (y * 255) / h;
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

export const SVG_WITH_SCRIPT = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>');

function verifyEd25519(message: string, signatureB58: string, signer: string): boolean {
  try {
    const sig = Buffer.from(base58Decode(signatureB58));
    const pub = new PublicKey(signer).toBuffer();
    const key = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub.toString('base64url') }, format: 'jwk' });
    return sig.length === 64 && crypto.verify(null, Buffer.from(message, 'utf8'), key, sig);
  } catch {
    return false;
  }
}
function base58Decode(s: string): Uint8Array {
  const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = 0n;
  for (const ch of s) { const i = A.indexOf(ch); if (i < 0) throw new Error('bad base58'); n = n * 58n + BigInt(i); }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of s) { if (ch !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

/** What "IPFS" holds, shared by every context in the worker: a buyer's page must read what the creator pinned. */
const served = new Map<string, { body: Buffer; type: string }>();

export async function installUploadStub(context: BrowserContext): Promise<UploadStub> {
  const uploads: UploadRecord[] = [];
  const refusals: string[] = [];
  let configured = true;
  const json = (route: Route, status: number, body: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

  await context.route('**/api/launch-upload', async (route) => {
    const req = route.request();
    if (req.method() === 'GET') return json(route, 200, { configured });
    if (req.method() !== 'POST') return json(route, 405, { error: 'Method not allowed' });
    if (!configured) return json(route, 503, { error: 'Picture upload is not set up yet.', reason: 'not-configured' });
    const refuse = (status: number, error: string, field?: string) => { refusals.push(error); return json(route, status, { error, ...(field ? { field } : {}) }); };
    let b: Record<string, unknown>;
    try { b = JSON.parse(req.postData() ?? ''); } catch { return refuse(400, 'Invalid JSON'); }
    const name = checkName(String(b.name ?? ''));
    if (!name.ok) return refuse(400, name.reason, 'name');
    const symbol = checkSymbol(String(b.symbol ?? ''));
    if (!symbol.ok) return refuse(400, symbol.reason, 'symbol');
    const description = checkDescription(String(b.description ?? ''));
    if (!description.ok) return refuse(400, description.reason, 'description');
    const links = checkLinks((b.links ?? {}) as Record<string, string>);
    if (!links.ok) return refuse(400, links.reason, links.field);
    const img = b.image as { mime?: string; base64?: string } | undefined;
    const bytes = Buffer.from(String(img?.base64 ?? ''), 'base64');
    const sniff = sniffImage(bytes);
    if (!sniff.ok || sniff.mime !== img?.mime) return refuse(400, sniff.ok ? 'The picture type does not match its bytes.' : sniff.reason, 'image');
    const details = { name: name.value, symbol: symbol.value, description: description.value, links: links.value };
    const sha = (x: string | Uint8Array) => crypto.createHash('sha256').update(x).digest('hex');
    const message = uploadAuthMessage({
      name: name.value, symbol: symbol.value, mint: String(b.mint), creator: String(b.creator),
      detailsSha256: sha(detailsDigestInput(details)), imageSha256: sha(bytes), expiresAt: String(b.expiresAt),
    });
    if (!verifyEd25519(message, String(b.signature ?? ''), String(b.creator))) return refuse(401, 'The wallet signature does not match these details.');
    if (!(Date.parse(String(b.expiresAt)) > Date.now())) return refuse(401, 'The signed request has expired.');

    const imageCid = cidV1Raw(bytes);
    served.set(imageCid, { body: bytes, type: sniff.mime });
    const imageUri = `https://ipfs.io/ipfs/${imageCid}`;
    const metadata = buildMetadataJson({ ...details, imageUri, mint: String(b.mint) });
    const metaBytes = Buffer.from(JSON.stringify(metadata));
    const metaCid = cidV1Raw(metaBytes);
    served.set(metaCid, { body: metaBytes, type: 'application/json' });
    const metadataUri = `https://ipfs.io/ipfs/${metaCid}`;
    uploads.push({ at: new Date().toISOString(), mint: String(b.mint), creator: String(b.creator), name: name.value, symbol: symbol.value, imageBytes: bytes.length, metadataUri, imageUri });
    return json(route, 200, { metadataUri, imageUri, metadata, pinnedAt: new Date().toISOString() });
  });

  await context.route('https://ipfs.io/ipfs/**', async (route) => {
    const cid = new URL(route.request().url()).pathname.split('/').pop() ?? '';
    const hit = served.get(cid);
    if (!hit) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
    return route.fulfill({ status: 200, contentType: hit.type, body: hit.body, headers: { 'access-control-allow-origin': '*' } });
  });

  return { uploads, refusals, setConfigured(on) { configured = on; } };
}
