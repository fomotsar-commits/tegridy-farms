// THE BIRTH CERTIFICATE ROUTE — `GET /record/:chain/:ca.json`.
//
// "That route is the token's birth certificate. The island reads it for enrollment,
//  hygiene watch runs against it, and certification state renders on it later. One
//  build, four consumers."
//
// DERIVED FROM CHAIN ON READ (operator decision, 2026-08-09). Nothing is stored, so
// there is nothing to forge, no write path to defend, and no snapshot that can drift
// away from the chain it describes. The trade is that the fee instruction reads as
// `unread` until a token graduates — the launch-time split is not chain-provable before
// then — and the record fills itself in as facts become provable. "Every lock verifiable
// onchain" is the stamp; a chain-derived record is the most literal form of it.
//
// ## Why it is a `?resource=` branch and not its own function
//
// Vercel Hobby caps a deployment at 12 serverless functions and we are at 11. See
// api/SERVERLESS_BUDGET.md.
//
// ## The two failure modes this file exists to prevent
//
// 1. A 200 of HTML. Without the vercel.json rewrite, `/record/…` is swallowed by the SPA
//    fallback and returns the app shell with status 200 forever. Any smoke check must
//    assert `content-type: application/json` AND `schema_version === 1`, never `res.ok`.
// 2. A cached partial record. A 200 whose fields are all null is honest for one request
//    and a lie for the next 300 seconds. `TRANSIENT_UNREAD` below forces `no-store` on
//    any record that is degraded rather than structurally incomplete.

import { checkGlobalLimit } from "./ratelimit.js";
import { logSafe } from "./logSafe.js";
import { buildBirthRecord } from "./record-core.js";

const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * `unread` entries that mean "a read failed THIS TIME", as opposed to "this rail cannot
 * prove this, ever". Only the first kind must defeat the cache: caching a structural
 * gap is fine and correct, caching a rate-limit is publishing an outage as a fact.
 */
const TRANSIENT_UNREAD = new Set([
  "name",
  "symbol",
  "total_supply",
  "residual_powers",
  "decimals",
  "birth_block",
  "birth_tx",
  "creator",
  "plates",
]);

/**
 * A PUBLIC, read-only document fetched server-to-server by the island.
 *
 * `*`, not the house allowlist: the island's server sends no `Origin` at all, and an
 * allowlist here would also make `origin-allowlist-parity.test.js` red for a route that
 * has no business carrying credentials. No `Vary: Origin` — the response does not vary,
 * and Vary would fragment the edge cache per-Origin exactly when the island polls.
 */
function setRecordCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

export async function handleRecord(req, res) {
  setRecordCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.setHeader("Cache-Control", "no-store");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // NO PER-IP BUCKET. The island is a single server polling for hygiene and
  // certification; a per-IP limit would throttle precisely the intended consumer, and
  // its X-RateLimit-* headers would be cached at the edge and go stale. The global
  // breaker is the right control. Note the signature: `res` first, no `req`.
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.RECORD_GLOBAL_RPM) || 600,
    windowSec: 60,
    identifier: "record",
  });
  if (!underCap) return;

  // Vercel MERGES the incoming query string with the rewrite's, and duplicate keys
  // arrive as ARRAYS. `/record/ethereum/0xabc.json?ca=0xEVIL` must not poison the read.
  const chain = req.query?.chain;
  const ca = req.query?.ca;
  if (typeof chain !== "string" || typeof ca !== "string") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "Malformed record request" });
  }

  if (chain === "base") {
    // `base` is a valid BirthChain and the socket accepts it, but there is no Base
    // address book and no Base RPC server-side. Answering with mainnet addresses would
    // be a fabricated record; 404 is the honest answer.
    res.setHeader("Cache-Control", "s-maxage=300");
    return res.status(404).json({ error: "No record is served for base at this venue." });
  }
  if (chain !== "ethereum" && chain !== "solana") {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "Unknown chain" });
  }

  // The SSRF / injection boundary: anchored, character-class-restricted, and chain-aware
  // so a base58 string can never be interpolated into an EVM call and vice versa.
  const validAddress = chain === "solana" ? SOLANA_ADDRESS_RE.test(ca) : ETH_ADDRESS_RE.test(ca);
  if (!validAddress) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(400).json({ error: "Invalid address for this chain" });
  }

  try {
    const read =
      chain === "solana"
        ? (await import("./record-solana.js")).readSolanaRecordInput
        : (await import("./record-evm.js")).readEvmRecordInput;
    const built = await read(ca);

    if (built.absent) {
      // CREATE2 can deploy to a known address later, so this is a short cache, not a
      // permanent one.
      res.setHeader("Cache-Control", "s-maxage=30");
      return res.status(404).json({ error: built.reason });
    }

    const record = buildBirthRecord(built.input);

    const degraded = record.unread.some((f) => TRANSIENT_UNREAD.has(f));
    res.setHeader(
      "Cache-Control",
      degraded ? "no-store" : "s-maxage=300, stale-while-revalidate=900",
    );
    return res.status(200).json(record);
  } catch (err) {
    if (err && err.contradiction) {
      // Two sources disagreed about the same fact. Publishing either one would be
      // picking a winner between a contract and its own bytecode.
      res.setHeader("Cache-Control", "no-store");
      return res.status(409).json({ error: "This token's on-chain values contradict its template provenance." });
    }
    // `logSafe` redacts 40-hex addresses, so the token will not appear in the log line.
    console.error("record:", logSafe(err));
    res.setHeader("Cache-Control", "no-store");
    return res.status(502).json({ error: "The chain could not be read for this token." });
  }
}
