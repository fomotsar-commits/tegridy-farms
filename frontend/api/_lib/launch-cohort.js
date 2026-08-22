// Launch-cohort LOG SOURCE — the Airlock `Create` enumeration, and nothing else.
//
// WHY THIS EXISTS
//   `readOurLaunches` (src/lib/launcher/ourLaunches.ts) is two phases: enumerate every
//   Airlock `Create`, then read `getAssetData(asset)` per asset to recover the integrator
//   (the event carries none). Phase two is a multicall the browser can do fine. Phase ONE
//   is an `eth_getLogs` across the Airlock's whole life — millions of blocks — and every
//   shipped RPC refuses it:
//     publicnode -> "Archive requests require a personal token"
//     drpc       -> "ranges over 10000 blocks are not supported on free plan"
//     api/alchemy.js -> 403 (Airlock not in ALLOWED_CONTRACTS) and, even if it were,
//                       MAX_BLOCK_RANGE caps the delta at 10_000 (audit R049 H-5 — a cap
//                       worth keeping, not widening).
//   So the cohort surfaces rendered permanently empty: not "nothing has launched", but
//   "we never asked". This supplies phase one from Etherscan with the key server-side.
//
// SCOPE, DELIBERATELY NARROW
//   It returns the asset addresses only. It does NOT decide which are ours — that stays in
//   ourLaunches.ts so there is exactly ONE implementation of provenance, and it stays where
//   its all-or-nothing integrity rule already lives.
//
// WHY IT IS NOT ITS OWN FUNCTION
//   Vercel Hobby caps a deployment at 12 serverless functions (currently 9). Dispatched
//   from the aggregator catchall via `?resource=launch-cohort` behind a lazy import, exactly
//   like _lib/launch-radar.js and _lib/launcher-outcomes.js. See api/SERVERLESS_BUDGET.md.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isOriginAllowed } from "./aggregator-proxy.js";
import { logSafe } from "./logSafe.js";

const AIRLOCK = "0xde3599a2ec440b296373a983c85c365da55d9dfa";

// keccak256("Create(address,address,address,address)") — the Airlock Create topic0.
//
// DERIVED, NOT GUESSED: computed with viem's toEventSelector from the Doppler SDK's own
// `airlockAbi` export, which gives
//   Create(address asset, address indexed numeraire, address initializer, address poolOrHook)
// => 2 topics, 3 data words, and `asset` at NON-indexed position 0 (i.e. data word 0, which
// is what assetFromCreateLog reads). Only `numeraire` is indexed, so topic0 is the only
// filterable part and the integrator is not in the event at all — which is exactly why the
// caller must still read getAssetData() per asset.
// `launch-cohort.test.js` recomputes this from the SDK so it cannot drift silently.
const CREATE_TOPIC0 = "0x68ff1cfcdcf76864161555fc0de1878d8f83ec6949bf351df74d8a4a1a2679ab";

const AIRLOCK_FIRST_BLOCK = 21_000_000;
const MAX_LOGS = 1000;
const ETH_ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

const ALLOWED_ORIGINS = [
  "https://memetic.fun",
  "https://www.memetic.fun",
  "https://memetics.finance",
  "https://www.memetics.finance",
  "https://tegridyfarms.vercel.app",
];

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  const fallback = process.env.ALLOWED_ORIGIN || ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGINS.includes(origin) ? origin : fallback);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Vary", "Origin");
}

/** The `asset` is data word 0 of a Create log. Returns null on anything malformed. */
export function assetFromCreateLog(log) {
  const data = typeof log?.data === "string" ? log.data : "";
  if (!/^0x[0-9a-fA-F]*$/.test(data) || data.length < 2 + 64) return null;
  const word = data.slice(2, 66);
  // An address word is 12 zero bytes then 20 address bytes. Anything else is not an address.
  if (!/^0{24}[0-9a-fA-F]{40}$/.test(word)) return null;
  const addr = "0x" + word.slice(24);
  return ETH_ADDRESS_RE.test(addr) ? addr : null;
}

/** Distinct assets, order preserved (Etherscan returns ascending by block). */
export function assetsFromLogs(logs) {
  const out = [];
  const seen = new Set();
  for (const log of Array.isArray(logs) ? logs : []) {
    const a = assetFromCreateLog(log);
    if (!a) continue;
    const k = a.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

/** The Etherscan getLogs URL for the Airlock's whole `Create` history. */
function createLogsUrl(key) {
  return (
    `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs` +
    `&address=${AIRLOCK}&topic0=${CREATE_TOPIC0}` +
    `&fromBlock=${AIRLOCK_FIRST_BLOCK}&toBlock=latest&page=1&offset=${MAX_LOGS}&apikey=${key}`
  );
}

/**
 * Find ONE asset's `Create` log — its birth block and transaction.
 *
 * Exported for the birth-record route, which needs `birth_block` as chain truth. It
 * reuses this module's enumeration rather than writing a second one because the Airlock's
 * `Create` event does NOT index `asset` (only `numeraire` is), so there is no per-asset
 * topic filter and the only way to find one is to walk the same window.
 *
 * Returns `{ blockNumber, transactionHash }`, or `{ truncated: true }` when the window
 * hit MAX_LOGS without a match (we did not find it — NOT proof it does not exist), or
 * null when the asset genuinely is not in the history. The caller must keep those apart:
 * a truncated window that returned null would publish "this token was never launched".
 */
export async function createLogFor(asset, key) {
  if (!key) return null;
  const want = String(asset).toLowerCase();
  const r = await fetch(createLogsUrl(key), { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`etherscan ${r.status}`);
  const j = await r.json();
  if (!Array.isArray(j?.result)) {
    const msg = String(j?.result ?? j?.message ?? "");
    if (/no records found/i.test(msg)) return null;
    throw new Error("etherscan non-array result");
  }
  for (const log of j.result) {
    const a = assetFromCreateLog(log);
    if (a && a.toLowerCase() === want) {
      // Etherscan returns these as hex strings.
      const blockNumber = Number(log.blockNumber);
      return {
        blockNumber: Number.isSafeInteger(blockNumber) && blockNumber >= 0 ? blockNumber : null,
        transactionHash: typeof log.transactionHash === "string" ? log.transactionHash : null,
      };
    }
  }
  return j.result.length >= MAX_LOGS ? { truncated: true } : null;
}

export async function handleLaunchCohort(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // ENFORCE the origin — `setCors` only sets a header. Dispatched before runProxy, so
  // this branch does not inherit aggregator-proxy.js's 403 and must apply it itself.
  if (!isOriginAllowed(req.headers?.origin || "")) {
    return res.status(403).json({ error: "Origin not allowed" });
  }

  const allowed = await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "launch-cohort" });
  if (!allowed) return;

  // Spends the keyed Etherscan budget, which is shared with /api/etherscan and the
  // deployer graph — bound the fleet, not just the visitor. Own identifier so the two
  // surfaces cannot shed each other.
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.LAUNCH_COHORT_GLOBAL_RPM) || 90,
    windowSec: 60,
    identifier: "launch-cohort",
  });
  if (!underCap) return;

  const key = process.env.ETHERSCAN_API_KEY;
  // FAIL LOUD, NOT EMPTY. An empty `assets` array is indistinguishable from "nothing has
  // ever launched", and the caller renders that as a track record. A missing key is our
  // problem, so say so and let the client show "couldn't check".
  if (!key) return res.status(503).json({ error: "Launch history is unavailable (no upstream key configured)" });

  const url =
    `https://api.etherscan.io/v2/api?chainid=1&module=logs&action=getLogs` +
    `&address=${AIRLOCK}&topic0=${CREATE_TOPIC0}` +
    `&fromBlock=${AIRLOCK_FIRST_BLOCK}&toBlock=latest&page=1&offset=${MAX_LOGS}&apikey=${key}`;

  try {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) return res.status(502).json({ error: "Launch history is temporarily unavailable" });
    const j = await r.json();

    // Etherscan signals BOTH "no results" and several throttle/error conditions with
    // status "0", and puts a human string in `result` where the array belongs. Treating
    // that string as an empty list is how a throttle becomes a fabricated empty cohort.
    if (!Array.isArray(j?.result)) {
      const msg = String(j?.result ?? j?.message ?? "");
      if (/no records found/i.test(msg)) return res.status(200).json({ assets: [], truncated: false });
      console.error("launch-cohort upstream:", logSafe(msg));
      return res.status(502).json({ error: "Launch history is temporarily unavailable" });
    }

    const assets = assetsFromLogs(j.result);
    res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=900");
    return res.status(200).json({ assets, truncated: j.result.length >= MAX_LOGS });
  } catch (err) {
    console.error("launch-cohort error:", logSafe(err));
    return res.status(502).json({ error: "Launch history is temporarily unavailable" });
  }
}
