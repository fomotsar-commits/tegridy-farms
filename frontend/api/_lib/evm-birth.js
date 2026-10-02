// The birth transaction of an Ethereum-rail launch, for its maker's plates (island rulings 3, 4).
// The browser cannot find it: every RPC it reaches refuses a whole-history eth_getLogs, and the
// CSP names no indexer. So this answers one question per token from FIXED hosts, and the answer
// is only a hint: the browser reads that receipt itself and checks every log it uses.
// `{ tx: null }` means the history was read and holds no such log. A failed read is a 5xx,
// never null. Dispatched from api/aggregator.js above `const provider`, behind a lazy import.

import { checkRateLimit, checkGlobalLimit } from "./ratelimit.js";
import { isRequestOriginAllowed } from "./aggregator-proxy.js";
import { readBoundedText } from "./bodycap.js";
import { logSafe } from "./logSafe.js";

// keccak256 of each event's signature. evm-birth.test.js recomputes both from the ABIs the
// browser decodes with (curve.ts, the Doppler SDK), so neither can drift silently.
export const LAUNCH_CREATED_TOPIC0 = "0x27bf21dabc3fdff383eb57006a7345f5ff0deaaa4ea3e258bdd07518bef13131";
export const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x" + "0".repeat(64);

const ETH_BLOCKSCOUT = "https://eth.blockscout.com/api";
const BASE_BLOCKSCOUT = "https://base.blockscout.com/api";
const ROBINHOOD_RPC = "https://rpc.mainnet.chain.robinhood.com";

// Each Memetics Curve launcher and the block it was deployed in (its history starts there).
// evm-birth.test.js pins the launchers to src/lib/chains/registry.ts.
export const CURVE_CHAINS = {
  1: { launcher: "0xf4dfa741ad63b3d95dc3fc10d311cae507ce34de", fromBlock: 25_823_303, blockscout: ETH_BLOCKSCOUT },
  8453: { launcher: "0xa517a1cefd961c0dde8155a0fa870aee5bb0d060", fromBlock: 50_466_125, blockscout: BASE_BLOCKSCOUT },
  4663: { launcher: "0xa2e7e7fae91846e4c92af7f4b43b24cdd9abf4f5", fromBlock: 46_343_018, rpc: ROBINHOOD_RPC },
};

// Doppler tokens are Ethereum only, and none predates the Airlock's first block (launch-cohort.js).
const DOPPLER_FROM_BLOCK = 21_000_000;

// The Robinhood RPC refuses an eth_getLogs spanning more than 10,000,000 blocks, counted
// inclusively (read 2026-10-02). MAX_WINDOWS bounds the fan-out: past it we say we could not read.
export const RPC_WINDOW_BLOCKS = 10_000_000;
const MAX_WINDOWS = 40;
// Blockscout returns at most 1,000 logs a page; a full page means we did not see them all.
const BLOCKSCOUT_PAGE = 1000;
const MAX_BYTES = 1_000_000;
const TIMEOUT_MS = 8000;

const TOKEN_RE = /^0x[0-9a-fA-F]{40}$/;
const TX_RE = /^0x[0-9a-fA-F]{64}$/;

const ALLOWED_ORIGINS = [
  "https://memetic.fun",
  "https://www.memetic.fun",
  "https://memetics.finance",
  "https://www.memetics.finance",
  "https://tegridyfarms.vercel.app",
];

function setCors(req, res) {
  const origin = req.headers?.origin || "";
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/** A 20-byte address as the 32-byte topic it is indexed under, lowercase. */
export function addressTopic(address) {
  return "0x" + "0".repeat(24) + address.slice(2).toLowerCase();
}

/**
 * The one transaction the matching logs came from. Logs that do not match the filter are
 * dropped (the browser re-checks anyway). Logs from two transactions throw, because then we
 * do not know which one is the birth, unless `earliest` says the first one is the birth
 * (a token's first mint): then every matching log must say where it sits in the chain.
 */
export function birthTxFrom(logs, want, { earliest = false } = {}) {
  const found = [];
  for (const log of Array.isArray(logs) ? logs : []) {
    const topics = Array.isArray(log?.topics) ? log.topics.map((t) => String(t).toLowerCase()) : [];
    if (String(log?.address).toLowerCase() !== want.address) continue;
    if (topics[0] !== want.topic0) continue;
    if (want.topic1 && topics[1] !== want.topic1) continue;
    const tx = String(log?.transactionHash ?? "");
    if (!TX_RE.test(tx)) throw new Error("a matching log carries no transaction hash");
    const block = Number(log?.blockNumber);
    const index = Number(log?.logIndex);
    const placed = Number.isSafeInteger(block) && block >= 0;
    if (earliest && !(placed && Number.isSafeInteger(index) && index >= 0)) throw new Error("a matching log does not say where it sits");
    found.push({ tx: tx.toLowerCase(), block: placed ? block : null, index });
  }
  if (found.length === 0) return null;
  if (earliest) found.sort((a, b) => a.block - b.block || a.index - b.index);
  else if (new Set(found.map((f) => f.tx)).size > 1) throw new Error("matching logs come from more than one transaction");
  return { tx: found[0].tx, block: found[0].block };
}

async function readJson(url, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
  const { text, truncated } = await readBoundedText(r, MAX_BYTES);
  if (truncated) throw new Error("upstream answer too large");
  return JSON.parse(text);
}

/** Blockscout's Etherscan-style getLogs. `[]` only for its own "No logs found". */
export async function blockscoutLogs(base, { address, topic0, topic1, fromBlock }) {
  const q = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: String(fromBlock), toBlock: "latest", address, topic0 });
  if (topic1) {
    q.set("topic1", topic1);
    q.set("topic0_1_opr", "and");
  }
  const j = await readJson(`${base}?${q}`, { headers: { accept: "application/json" } });
  if (j?.status === "1" && Array.isArray(j.result)) {
    if (j.result.length >= BLOCKSCOUT_PAGE) throw new Error("more logs than one page");
    return j.result;
  }
  if (j?.status === "0" && /^no logs found$/i.test(String(j?.message)) && Array.isArray(j.result) && j.result.length === 0) {
    return [];
  }
  throw new Error("blockscout did not answer the query");
}

async function rpcCall(url, method, params) {
  const j = await readJson(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (j?.error || !("result" in (j ?? {}))) throw new Error(`rpc ${method} failed`);
  return j.result;
}

/**
 * [from, to] windows, inclusive, each at most RPC_WINDOW_BLOCKS long, covering from..head.
 * Counted before any is built: the head is the RPC's answer, and a bogus one must not
 * cost a loop of hundreds of millions of arrays.
 */
export function blockWindows(fromBlock, head) {
  if (Math.ceil((head - fromBlock + 1) / RPC_WINDOW_BLOCKS) > MAX_WINDOWS) throw new Error("too many windows to read");
  const out = [];
  for (let s = fromBlock; s <= head; s += RPC_WINDOW_BLOCKS) out.push([s, Math.min(s + RPC_WINDOW_BLOCKS - 1, head)]);
  return out;
}

/** eth_getLogs over the launcher's whole life, in windows the RPC accepts. */
export async function rpcLogs(url, { address, topic0, topic1, fromBlock }) {
  const headHex = await rpcCall(url, "eth_blockNumber", []);
  const head = typeof headHex === "string" && /^0x[0-9a-f]+$/i.test(headHex) ? Number(headHex) : NaN;
  if (!Number.isSafeInteger(head) || head < fromBlock) throw new Error("rpc head unreadable");
  const windows = blockWindows(fromBlock, head);
  const pages = await Promise.all(
    windows.map(([from, to]) =>
      rpcCall(url, "eth_getLogs", [{ address, topics: [topic0, topic1], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]),
    ),
  );
  if (!pages.every(Array.isArray)) throw new Error("rpc getLogs answered without a list");
  return pages.flat();
}

/** The Memetics Curve: the LaunchCreated log with topic1 = this token, on this chain's launcher. */
export async function findCurveBirth(chainId, token) {
  const c = CURVE_CHAINS[chainId];
  const want = { address: c.launcher, topic0: LAUNCH_CREATED_TOPIC0, topic1: addressTopic(token) };
  const filter = { ...want, fromBlock: c.fromBlock };
  const logs = c.rpc ? await rpcLogs(c.rpc, filter) : await blockscoutLogs(c.blockscout, filter);
  return birthTxFrom(logs, want);
}

/**
 * Doppler (/launch): the token's first mint. Every launch mints at birth, with or without a
 * premine (a launch with none emits no vesting event), and the earliest mint is the birth.
 */
export async function findDopplerBirth(token) {
  const want = { address: token.toLowerCase(), topic0: TRANSFER_TOPIC0, topic1: ZERO_TOPIC };
  const logs = await blockscoutLogs(ETH_BLOCKSCOUT, { ...want, fromBlock: DOPPLER_FROM_BLOCK });
  return birthTxFrom(logs, want, { earliest: true });
}

async function gate(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(200).end();
    return false;
  }
  // ENFORCE the origin: setCors only sets a header, and this branch runs before runProxy.
  if (!isRequestOriginAllowed(req)) {
    res.status(403).json({ error: "Origin not allowed" });
    return false;
  }
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET, OPTIONS");
    res.status(405).json({ error: "Method not allowed" });
    return false;
  }
  return true;
}

async function limited(req, res) {
  if (!(await checkRateLimit(req, res, { limit: 30, windowSec: 60, identifier: "evm-birth" }))) return true;
  const underCap = await checkGlobalLimit(res, {
    limit: Number(process.env.EVM_BIRTH_GLOBAL_RPM) || 120,
    windowSec: 60,
    identifier: "evm-birth",
  });
  return !underCap;
}

async function answer(res, find, label) {
  try {
    const found = await find();
    // A birth never changes once found; "none yet" can, minutes after a launch, so it is short.
    res.setHeader("Cache-Control", found ? "s-maxage=300, stale-while-revalidate=900" : "s-maxage=15, stale-while-revalidate=30");
    return res.status(200).json(found ?? { tx: null, block: null });
  } catch (err) {
    console.error(`${label} upstream:`, logSafe(err));
    return res.status(502).json({ error: "The launch transaction could not be looked up right now" });
  }
}

export async function handleCurveBirth(req, res) {
  if (!(await gate(req, res))) return;
  const chain = String(req.query.chain ?? "");
  const token = String(req.query.token ?? "");
  if (!Object.hasOwn(CURVE_CHAINS, chain) || !TOKEN_RE.test(token)) {
    return res.status(400).json({ error: "Invalid chain or token" });
  }
  if (await limited(req, res)) return;
  return answer(res, () => findCurveBirth(chain, token), "curve-birth");
}

export async function handleDopplerBirth(req, res) {
  if (!(await gate(req, res))) return;
  const token = String(req.query.token ?? "");
  const chain = req.query.chain === undefined ? "1" : String(req.query.chain);
  if (chain !== "1" || !TOKEN_RE.test(token)) {
    return res.status(400).json({ error: "Invalid chain or token" });
  }
  if (await limited(req, res)) return;
  return answer(res, () => findDopplerBirth(token), "doppler-birth");
}
