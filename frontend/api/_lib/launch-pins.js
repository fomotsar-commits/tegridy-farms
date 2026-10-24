// Pinata and chain helpers for api/launch-upload.js: pin a launch's picture and
// details file, and sweep away pins whose mint never became a launch.
//
// Why a sweep exists. The upload endpoint pins files under the owner's Pinata
// account before the launch transaction is signed (the transaction must carry the
// file's address). Anyone with a wallet can therefore get a file pinned without
// launching anything. Signing, per-wallet and per-IP limits and a global cap bound
// how MUCH; the sweep bounds how LONG: a pin whose mint has no curve account 30
// minutes later is removed. A launch transaction cannot land that late (its
// blockhash expires in about a minute), so a pin that old with no curve is an
// orphan, never a launch still on its way.
//
// Fail-safe direction: anything the sweep cannot READ (Pinata list, the RPC, a
// malformed row) is KEPT. Removing a live launch's picture is the worse mistake.
//
// Secrets: PINATA_JWT is only ever placed in an Authorization header. Nothing here
// logs a header, and upstream error bodies are clipped and passed through logSafe.

import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";
import { isPubkeyString, ipfsUri } from "../../src/lib/launchMetadata/validate.js";

const PINATA_API = "https://api.pinata.cloud";
/** The keyvalue that marks a pin as ours; the sweep never touches a pin without it. */
export const PIN_APP = "tegridy-launch";
/** A pin younger than this is never swept: its launch may still be on its way. */
export const ORPHAN_AFTER_MS = 30 * 60 * 1000;
/** Pins older than this are no longer looked at (each is checked ~20 times before then). */
export const SWEEP_LOOKBACK_MS = 6 * 60 * 60 * 1000;
/** Bound on removals per run, so a bug cannot empty the account in one go. */
export const MAX_UNPINS_PER_RUN = 200;
/** The launch program whose curve accounts prove a launch happened. Registered mainnet id. */
export const DEFAULT_LAUNCH_PROGRAM_ID = "64WBTeNcrSHfmBpiqymyifW6FUNNLvJcuiqF9rXmz4q2";

const PINATA_RESPONSE_CAP = 256 * 1024;

export function launchProgramId() {
  const v = process.env.SOLANA_LAUNCH_PROGRAM_ID;
  return isPubkeyString(v) ? v : DEFAULT_LAUNCH_PROGRAM_ID;
}

export function solanaRpcUrl() {
  return process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
}

// ── program-derived addresses ───────────────────────────────────────────────

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function isOnCurve(bytes) {
  try {
    ed25519.ExtendedPoint.fromHex(bytes);
    return true;
  } catch {
    return false;
  }
}

/** Solana's findProgramAddress, without @solana/web3.js. Returns base58. */
export function findProgramAddress(seeds, programId) {
  const program = base58.decode(programId);
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(program);
    h.update(PDA_MARKER);
    const out = new Uint8Array(h.digest());
    if (!isOnCurve(out)) return base58.encode(out);
  }
  throw new Error("no viable program address");
}

/** `["curve", mint]` on tegridy-launch (curve/program.ts curvePda). */
export function curveAddress(mint, programId = launchProgramId()) {
  return findProgramAddress([new TextEncoder().encode("curve"), base58.decode(mint)], programId);
}

// ── Pinata ──────────────────────────────────────────────────────────────────

function auth(jwt) {
  return { Authorization: `Bearer ${jwt}` };
}

async function pinataJson(res, what) {
  const { text, truncated } = await readBoundedText(res, PINATA_RESPONSE_CAP);
  if (!res.ok || truncated) {
    console.error(`[launch-upload] pinata ${what} HTTP ${res.status}: ${logSafe(String(text).slice(0, 200))}`);
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error(`[launch-upload] pinata ${what}: unreadable body`);
    return null;
  }
}

function keyvalues(mint, creator, part, extra = {}) {
  return { app: PIN_APP, mint, creator, part, ...extra };
}

/** Pin the picture. Returns { cid, duplicate } or null. */
export async function pinImage(jwt, bytes, mime, mint, creator, fetchImpl = fetch) {
  const form = new FormData();
  const ext = mime.split("/")[1];
  form.append("file", new Blob([bytes], { type: mime }), `${mint}.${ext}`);
  form.append("pinataMetadata", JSON.stringify({ name: `launch-${mint}-image`, keyvalues: keyvalues(mint, creator, "image") }));
  form.append("pinataOptions", JSON.stringify({ cidVersion: 1 }));
  let res;
  try {
    res = await fetchImpl(`${PINATA_API}/pinning/pinFileToIPFS`, { method: "POST", headers: auth(jwt), body: form });
  } catch (err) {
    console.error("[launch-upload] pinata image fetch error:", logSafe(err));
    return null;
  }
  const body = await pinataJson(res, "image");
  const cid = body?.IpfsHash;
  return ipfsUri(cid) ? { cid, duplicate: body.isDuplicate === true } : null;
}

/** Pin the details file. `imageCid` is recorded so the sweep knows which files belong together. */
export async function pinMetadata(jwt, json, mint, creator, imageCid, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${PINATA_API}/pinning/pinJSONToIPFS`, {
      method: "POST",
      headers: { ...auth(jwt), "Content-Type": "application/json" },
      body: JSON.stringify({
        pinataContent: json,
        pinataMetadata: { name: `launch-${mint}-json`, keyvalues: keyvalues(mint, creator, "json", { image: imageCid }) },
        pinataOptions: { cidVersion: 1 },
      }),
    });
  } catch (err) {
    console.error("[launch-upload] pinata json fetch error:", logSafe(err));
    return null;
  }
  const body = await pinataJson(res, "json");
  const cid = body?.IpfsHash;
  return ipfsUri(cid) ? { cid } : null;
}

export async function unpin(jwt, cid, fetchImpl = fetch) {
  if (!ipfsUri(cid)) return false;
  try {
    const res = await fetchImpl(`${PINATA_API}/pinning/unpin/${cid}`, { method: "DELETE", headers: auth(jwt) });
    if (!res.ok) console.error(`[launch-upload] pinata unpin HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error("[launch-upload] pinata unpin fetch error:", logSafe(err));
    return false;
  }
}

/** Our pins matching `filter` (keyvalue → value), pinned inside [start, end]. Null = unreadable. */
export async function listPins(jwt, filter, { start, end } = {}, fetchImpl = fetch) {
  const kv = {};
  for (const [k, v] of Object.entries({ app: PIN_APP, ...filter })) kv[k] = { value: v, op: "eq" };
  const q = new URLSearchParams({ status: "pinned", pageLimit: "1000", pageOffset: "0" });
  if (start) q.set("pinStart", new Date(start).toISOString());
  if (end) q.set("pinEnd", new Date(end).toISOString());
  q.set("metadata[keyvalues]", JSON.stringify(kv));
  let res;
  try {
    res = await fetchImpl(`${PINATA_API}/data/pinList?${q}`, { headers: auth(jwt) });
  } catch (err) {
    console.error("[launch-upload] pinata list fetch error:", logSafe(err));
    return null;
  }
  const body = await pinataJson(res, "list");
  if (!body || !Array.isArray(body.rows)) return null;
  return body.rows
    .map((r) => ({
      cid: r?.ipfs_pin_hash,
      pinnedAt: Date.parse(r?.date_pinned),
      kv: r?.metadata?.keyvalues ?? {},
    }))
    .filter((r) => ipfsUri(r.cid) && Number.isFinite(r.pinnedAt) && r.kv.app === PIN_APP && isPubkeyString(r.kv.mint));
}

// ── chain ───────────────────────────────────────────────────────────────────

/**
 * Which mints have a curve account owned by the launch program. Returns a Map
 * mint → true | false, with a mint ABSENT when its read failed (unreadable is
 * never "no launch").
 */
export async function launchedMints(mints, fetchImpl = fetch) {
  const program = launchProgramId();
  const out = new Map();
  for (let i = 0; i < mints.length; i += 100) {
    const chunk = mints.slice(i, i + 100);
    const curves = chunk.map((m) => curveAddress(m, program));
    let body;
    try {
      const res = await fetchImpl(solanaRpcUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getMultipleAccounts",
          params: [curves, { encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed" }],
        }),
      });
      const { text, truncated } = await readBoundedText(res, 1_000_000);
      body = res.ok && !truncated ? JSON.parse(text) : null;
    } catch (err) {
      console.error("[launch-upload] sweep rpc error:", logSafe(err));
      body = null;
    }
    const values = body?.result?.value;
    if (!Array.isArray(values) || values.length !== chunk.length) continue;
    chunk.forEach((mint, j) => {
      const acc = values[j];
      // A curve address holding lamports but owned by someone else is not a launch:
      // anyone can send SOL to any address.
      out.set(mint, acc !== null && typeof acc === "object" && acc.owner === program);
    });
  }
  return out;
}

// ── the sweep ───────────────────────────────────────────────────────────────

/**
 * Remove our pins whose mint never became a launch.
 *
 * A picture can be shared: Pinata keeps ONE pin per content id, so the same
 * picture used for a second attempt (a new mint after the first attempt was lost)
 * is the first attempt's pin. So a picture is removed only when EVERY details file
 * that points at it belongs to a mint with no launch, and none of them is young.
 */
export async function sweepOrphans(jwt, now = Date.now(), fetchImpl = fetch) {
  const rows = await listPins(jwt, {}, { start: now - SWEEP_LOOKBACK_MS, end: now - ORPHAN_AFTER_MS }, fetchImpl);
  if (rows === null) return { ok: false, reason: "pin list unreadable" };
  const mints = [...new Set(rows.map((r) => r.kv.mint))];
  const launched = await launchedMints(mints, fetchImpl);

  const toUnpin = [];
  let kept = 0;
  let unreadable = 0;
  for (const r of rows) {
    const state = launched.get(r.kv.mint);
    if (state === undefined) { unreadable++; continue; }
    if (state) { kept++; continue; }
    if (r.kv.part === "json") { toUnpin.push(r.cid); continue; }
    if (r.kv.part !== "image") { kept++; continue; }
    // Every details file, of any age, that points at this picture.
    const refs = await listPins(jwt, { part: "json", image: r.cid }, {}, fetchImpl);
    if (refs === null) { unreadable++; continue; }
    if (refs.some((x) => now - x.pinnedAt < ORPHAN_AFTER_MS)) { kept++; continue; }
    const refMints = [...new Set(refs.map((x) => x.kv.mint).filter((m) => m !== r.kv.mint))];
    const refLaunched = refMints.length ? await launchedMints(refMints, fetchImpl) : new Map();
    if (refMints.some((m) => refLaunched.get(m) !== false)) { kept++; continue; }
    toUnpin.push(r.cid);
  }

  let unpinned = 0;
  for (const cid of [...new Set(toUnpin)].slice(0, MAX_UNPINS_PER_RUN)) {
    if (await unpin(jwt, cid, fetchImpl)) unpinned++;
  }
  return { ok: true, checked: rows.length, kept, unreadable, unpinned, deferred: Math.max(0, new Set(toUnpin).size - MAX_UNPINS_PER_RUN) };
}
