// Is this address a contract? — `eth_getCode` over a batch of addresses.
//
// WHY THIS EXISTS: the token scanner's detection core excludes structural holders
// (LP pairs, CEX wallets, bridges, lockers, vaults) from the person-held
// distribution, and the ONLY input it has for the generic case is `isContract`.
// Ethplorer does not send that field, so on the Ethereum path it was always
// `false` — the exclusion pass ran, matched nothing, and every pool and vault was
// counted as a person.
//
// Measured on TOWELI's own live scan (2026-08-01, top 100 holders): 15 of them have
// code, including the LARGEST at 27.47% — the Uniswap V2 pair itself — and the
// staking contract at 5.1%. Counting those as people reported the largest holder as
// 27.47% where the largest PERSON holds 3.71%, and effective holders as 6.0 where
// the real figure is 23.1. A 7.4x overstatement of concentration on the headline
// number of a page whose entire job is to report concentration honestly.
//
// A field we never read is not a `false`. This reads it.
//
// FAIL-CLOSED: an unreadable code batch throws. The caller maps that to the same
// uncached failure path as any other unreadable upstream — publishing a
// distribution verdict whose exclusion pass silently did not run is precisely the
// class of defect this module exists to remove.

// Ethereum mainnet. Mirrors the failover roster in _lib/seaport-verify.js, which
// documents why ankr / cloudflare / llamarpc are NOT in it (they answer trivial
// methods but fail real reads). Server path — CORS is irrelevant here.
const PUBLIC_RPC_URLS = Object.freeze([
  "https://ethereum-rpc.publicnode.com",
  "https://eth.drpc.org",
  // eth.merkle.io DROPPED 2026-08-25: 429s every request (rate-limited the
  // keyless tier off) — a dead third slot that closed the failover chain and
  // burned a retry on every rotation. Re-verify with a REAL read (eth_blockNumber
  // + Origin) before ever re-adding. publicnode + drpc re-verified live today.
]);

function alchemyUrl(key) {
  if (!key || key === "demo") return null;
  return `https://eth-mainnet.g.alchemy.com/v2/${key}`;
}

/** Configured keys first, then the keyless public roster. */
export function rpcUrlChain() {
  const urls = [];
  const primary = alchemyUrl(process.env.ALCHEMY_API_KEY);
  if (primary) urls.push(primary);
  const fallback = alchemyUrl(process.env.ALCHEMY_API_KEY_FALLBACK);
  if (fallback && fallback !== primary) urls.push(fallback);
  urls.push(...PUBLIC_RPC_URLS);
  return urls;
}

/** Per-attempt bound so one hung node cannot consume the whole request budget. */
const ATTEMPT_TIMEOUT_MS = 6000;

/**
 * POST one JSON-RPC batch and return the parsed array, or throw.
 *
 * Every element is validated: a batch that answers only some of its ids, answers an
 * id twice, or returns a non-hex result is REJECTED rather than partially trusted.
 * Partial trust here would silently mark the unanswered addresses as EOAs — the
 * exact "absent field becomes a confident false" this module exists to prevent.
 */
async function getCodeBatch(url, addresses) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        addresses.map((address, id) => ({
          jsonrpc: "2.0",
          id,
          method: "eth_getCode",
          params: [address, "latest"],
        })),
      ),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);

  const json = await res.json();
  if (!Array.isArray(json)) throw new Error("RPC did not return a batch");

  const seen = new Map();
  for (const row of json) {
    if (!row || typeof row !== "object") throw new Error("malformed batch entry");
    if (row.error) throw new Error(`RPC error: ${row.error.message ?? "unknown"}`);
    const { id, result } = row;
    if (typeof id !== "number" || id < 0 || id >= addresses.length) {
      throw new Error("batch entry carried an unknown id");
    }
    // A duplicated id means arrival order would decide an answer — never a read.
    if (seen.has(id)) throw new Error(`batch answered id ${id} more than once`);
    if (typeof result !== "string" || !/^0x[0-9a-fA-F]*$/.test(result)) {
      throw new Error("eth_getCode returned a non-hex result");
    }
    // "0x" = no code = an externally-owned account. Anything longer is a contract.
    seen.set(id, result.length > 2);
  }
  if (seen.size !== addresses.length) {
    throw new Error(`batch answered ${seen.size} of ${addresses.length} addresses`);
  }
  return seen;
}

/**
 * Contract flags for `addresses`, keyed by the lowercased address.
 *
 * Walks the RPC chain on any transport or shape failure and throws only when every
 * URL has failed. Callers must treat a throw as an unreadable upstream, never as
 * "none of these are contracts".
 *
 * @param {string[]} addresses lowercased 0x addresses
 * @returns {Promise<Map<string, boolean>>}
 */
export async function fetchContractFlags(addresses) {
  const unique = [...new Set(addresses.map((a) => String(a).toLowerCase()))];
  if (unique.length === 0) return new Map();

  let lastErr = null;
  for (const url of rpcUrlChain()) {
    try {
      const byIndex = await getCodeBatch(url, unique);
      const out = new Map();
      unique.forEach((address, i) => out.set(address, byIndex.get(i) === true));
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error("no RPC endpoint available");
}
