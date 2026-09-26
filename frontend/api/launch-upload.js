// Vercel Serverless Function: pin a Solana launch's picture and details file to IPFS.
//
//   GET  /api/launch-upload            → { configured: boolean }
//   POST /api/launch-upload            → { metadataUri, imageUri, metadata, pinnedAt }
//   GET  /api/launch-upload?sweep=1    → Vercel cron only (Authorization: Bearer CRON_SECRET)
//
// OFF until the owner sets PINATA_JWT (Vercel env, server-only). Unset → GET says
// configured:false and POST answers 503 {reason:"not-configured"}; the launch form
// then offers "paste a metadata link" instead. Nothing else changes.
//
// What stops this from being a free "pin anything" service on the owner's account:
//   1. The creator's wallet signs a message binding the mint, the name and symbol,
//      the SHA-256 of the other details and of the picture, and a 10-minute expiry.
//      The server re-builds that message from what it received and verifies the
//      signature over the re-built bytes (src/lib/launchMetadata/validate.js
//      uploadAuthMessage is the one builder both sides use).
//   2. Per-IP, per-wallet and global hourly limits (api/_lib/ratelimit.js).
//   3. Every field is re-checked here with the same rules the form uses; the picture
//      is identified by its bytes, bounded in bytes and pixels, and refused if it
//      still carries EXIF/XMP.
//   4. A sweep (vercel.json cron) removes pins whose mint has no launch 30 minutes
//      later (api/_lib/launch-pins.js).
// None of that is moderation: an allowed picture can still be one the owner would
// not want pinned. That is an owner decision, reported with this change.

import { timingSafeEqual, createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { checkRateLimit, checkGlobalLimit } from "./_lib/ratelimit.js";
import { isOriginAllowed, isRequestOriginAllowed } from "./_lib/aggregator-proxy.js";
import { logSafe } from "./_lib/logSafe.js";
import { pinImage, pinMetadata, unpin, sweepOrphans } from "./_lib/launch-pins.js";
import {
  LIMITS,
  UPLOAD_SIGNATURE_TTL_MS,
  buildMetadataJson,
  checkDescription,
  checkLinks,
  checkName,
  checkSymbol,
  detailsDigestInput,
  hasEmbeddedMetadata,
  ipfsUri,
  pubkeyBytes,
  sniffImage,
  uploadAuthMessage,
} from "../src/lib/launchMetadata/validate.js";

/** base64 of a 1 MiB picture is ~1.4 MB; the rest of the body is a few hundred bytes. */
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Clock skew allowed on the signed expiry. */
const SKEW_MS = 60 * 1000;

const IP_LIMIT = { limit: 20, windowSec: 3600, identifier: "launch-upload" };
const WALLET_LIMIT = { limit: 6, windowSec: 3600, identifier: "launch-upload-wallet" };
const GLOBAL_LIMIT = {
  limit: Number(process.env.LAUNCH_UPLOAD_GLOBAL_PER_HOUR) > 0 ? Math.floor(Number(process.env.LAUNCH_UPLOAD_GLOBAL_PER_HOUR)) : 200,
  windowSec: 3600,
  identifier: "launch-upload",
};

const pinataJwt = () => (process.env.PINATA_JWT || "").trim();

function setHeaders(req, res) {
  const origin = req.headers?.origin || "";
  // Same-origin callers need no CORS header; a listed cross-origin caller gets its
  // own origin back. Never a wildcard.
  if (origin && isOriginAllowed(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

const refuse = (res, status, error, extra = {}) => res.status(status).json({ error, ...extra });

function decodeBase64Strict(s) {
  if (typeof s !== "string" || s.length === 0 || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  const buf = Buffer.from(s, "base64");
  return buf.toString("base64") === s ? new Uint8Array(buf) : null;
}

const sha256Hex = (data) => createHash("sha256").update(data).digest("hex");

function bearerMatches(req, secret) {
  const got = String(req.headers?.authorization || "");
  const want = `Bearer ${secret}`;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function handleSweep(req, res) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return refuse(res, 503, "Sweep is not set up.", { reason: "sweep-not-configured" });
  if (!bearerMatches(req, secret)) return refuse(res, 401, "Not allowed.");
  const jwt = pinataJwt();
  if (!jwt) return res.status(200).json({ ok: true, skipped: "not-configured" });
  const result = await sweepOrphans(jwt);
  if (!result.ok) console.error(`[launch-upload] sweep: ${result.reason}`);
  return res.status(result.ok ? 200 : 502).json(result);
}

export default async function handler(req, res) {
  setHeaders(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method === "GET") {
    if (req.query?.sweep !== undefined) return handleSweep(req, res);
    return res.status(200).json({ configured: pinataJwt().length > 0 });
  }
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST, OPTIONS");
    return refuse(res, 405, "Method not allowed");
  }

  if (!isRequestOriginAllowed(req)) return refuse(res, 403, "Origin not allowed");

  const jwt = pinataJwt();
  if (!jwt) return refuse(res, 503, "Picture upload is not set up yet.", { reason: "not-configured" });

  if (!(await checkRateLimit(req, res, IP_LIMIT))) return;

  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return refuse(res, 413, "The upload is too large.");
  let body = req.body;
  if (typeof body === "string") {
    if (body.length > MAX_BODY_BYTES) return refuse(res, 413, "The upload is too large.");
    try { body = JSON.parse(body); } catch { return refuse(res, 400, "The upload is not valid JSON."); }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return refuse(res, 400, "The upload is not valid JSON.");

  // ── the same checks the form ran ──
  const name = checkName(body.name);
  if (!name.ok) return refuse(res, 400, name.reason, { field: "name" });
  const symbol = checkSymbol(body.symbol);
  if (!symbol.ok) return refuse(res, 400, symbol.reason, { field: "symbol" });
  const description = checkDescription(body.description);
  if (!description.ok) return refuse(res, 400, description.reason, { field: "description" });
  const links = checkLinks(body.links);
  if (!links.ok) return refuse(res, 400, links.reason, { field: links.field });

  const mintBytes = pubkeyBytes(body.mint);
  const creatorBytes = pubkeyBytes(body.creator);
  if (!mintBytes || !creatorBytes || body.mint === body.creator) {
    return refuse(res, 400, "The mint or wallet address is not valid.");
  }

  const image = body.image && typeof body.image === "object" ? body.image : {};
  const bytes = decodeBase64Strict(image.base64);
  if (!bytes) return refuse(res, 400, "The picture is missing or damaged.", { field: "image" });
  if (bytes.length > LIMITS.imageBytes) return refuse(res, 413, "The picture is larger than 1 MB.", { field: "image" });
  const sniff = sniffImage(bytes);
  if (!sniff.ok) return refuse(res, 400, sniff.reason, { field: "image" });
  if (sniff.mime !== image.mime) return refuse(res, 400, "The picture is not the type it claims to be.", { field: "image" });
  if (hasEmbeddedMetadata(bytes, sniff.mime)) {
    return refuse(res, 400, "The picture still carries embedded camera or editor data. Pick it again on the site.", { field: "image" });
  }

  // ── the signature ──
  const expiresAt = typeof body.expiresAt === "string" ? body.expiresAt : "";
  const exp = Date.parse(expiresAt);
  const now = Date.now();
  if (!Number.isFinite(exp) || new Date(exp).toISOString() !== expiresAt) return refuse(res, 400, "The signed request has no valid expiry.");
  if (exp <= now) return refuse(res, 401, "The signed request expired. Try again.");
  if (exp > now + UPLOAD_SIGNATURE_TTL_MS + SKEW_MS) return refuse(res, 400, "The signed request expires too far ahead.");

  let signature;
  try { signature = base58.decode(String(body.signature || "")); } catch { signature = null; }
  if (!signature || signature.length !== 64) return refuse(res, 401, "The wallet signature is missing or damaged.");

  const details = { name: name.value, symbol: symbol.value, description: description.value, links: links.value };
  const message = uploadAuthMessage({
    name: name.value,
    symbol: symbol.value,
    mint: body.mint,
    creator: body.creator,
    detailsSha256: sha256Hex(detailsDigestInput(details)),
    imageSha256: sha256Hex(bytes),
    expiresAt,
  });
  let valid;
  try { valid = ed25519.verify(signature, new TextEncoder().encode(message), creatorBytes); } catch { valid = false; }
  if (!valid) return refuse(res, 401, "The wallet signature does not match these details.");

  if (!(await checkRateLimit(req, res, { ...WALLET_LIMIT, walletAddress: body.creator }))) return;
  if (!(await checkGlobalLimit(res, GLOBAL_LIMIT))) return;

  // ── pin ──
  const img = await pinImage(jwt, bytes, sniff.mime, body.mint, body.creator);
  if (!img) return refuse(res, 502, "The picture could not be stored. Nothing was launched. Try again.");
  const imageUri = ipfsUri(img.cid);
  const metadata = buildMetadataJson({ ...details, imageUri, mint: body.mint });
  const meta = await pinMetadata(jwt, metadata, body.mint, body.creator, img.cid);
  if (!meta) {
    // Do not leave a picture nobody points at. A duplicate belongs to an earlier
    // upload (maybe a real launch), so it is left alone.
    if (!img.duplicate) await unpin(jwt, img.cid).catch((err) => console.error("[launch-upload] cleanup:", logSafe(err)));
    return refuse(res, 502, "The details could not be stored. Nothing was launched. Try again.");
  }

  return res.status(200).json({ metadataUri: ipfsUri(meta.cid), imageUri, metadata, pinnedAt: new Date(now).toISOString() });
}
