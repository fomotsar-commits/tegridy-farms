// ═══ ALCHEMY KEY FAILOVER ═══
// RESIL-1 (2026-06-11): every Alchemy consumer (api/alchemy.js, api/v1/index.js,
// _lib/seaport-verify.js) hard-depended on the single ALCHEMY_API_KEY. A lapsed
// or disabled key meant: marketplace NFT data dark + order creation 503s, with
// no recourse short of an env change + redeploy. This module adds an OPTIONAL
// second key:
//
//   ALCHEMY_API_KEY_FALLBACK — a second Alchemy app key, ideally provisioned on
//   a separate Alchemy account so a billing lapse can't kill both at once.
//
// Policy (conservative, single retry):
//   - The FIRST attempt always uses the primary key — when the fallback env is
//     unset, behavior is byte-identical to the pre-RESIL-1 code (one fetch).
//   - Retry ONCE with the fallback key only on upstream failures that look
//     like a key/quota/availability problem: HTTP 401/403/429/5xx, or a thrown
//     fetch (network/DNS) error. Other 4xx (400, 404, ...) are deterministic
//     client-side problems — same answer with any key, so no retry.
//   - All call sites send idempotent reads (NFT lookups, eth_call,
//     eth_getLogs, eth_blockNumber), so the retry is always safe.
//
// Battle-tested pattern referenced: viem `fallback()` transport (primary →
// secondary on error), reduced to a single-retry fetch wrapper because the
// Alchemy NFT API is plain REST, not JSON-RPC.

/** Upstream statuses worth one retry with the fallback key. */
export function isRetryableAlchemyStatus(status) {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

/**
 * Ordered key chain: primary first (may be "" — legacy/demo path-embed mode),
 * then the fallback key when configured and distinct. Read at call time, not
 * module load, so tests with vi.resetModules()/env juggling stay deterministic.
 */
export function alchemyKeyChain() {
  const primary = process.env.ALCHEMY_API_KEY || "";
  const fallbackKey = process.env.ALCHEMY_API_KEY_FALLBACK || "";
  const chain = [primary];
  if (fallbackKey && fallbackKey !== "demo" && fallbackKey !== primary) {
    chain.push(fallbackKey);
  }
  return chain;
}

// Best-effort drain of an abandoned (about-to-be-retried) response body so
// undici can release the connection. Mock responses in tests may have no body.
function discardBody(res) {
  try {
    res?.body?.cancel?.()?.catch?.(() => {});
  } catch {
    /* best-effort only */
  }
}

/**
 * Fetch an Alchemy endpoint, retrying once with ALCHEMY_API_KEY_FALLBACK on a
 * retryable upstream failure.
 *
 * @param {(key: string) => { url: string, opts: object }} buildRequest
 *   Builds the full request for a given key. Called per attempt so the URL
 *   (path-embed vs header auth) and Authorization header track the key.
 * @returns {Promise<Response>} the first OK / non-retryable response, or the
 *   final attempt's response. Throws only if every attempt threw.
 */
export async function fetchAlchemyWithFailover(buildRequest) {
  const keys = alchemyKeyChain();
  let lastErr = null;
  for (let i = 0; i < keys.length; i++) {
    const isLast = i === keys.length - 1;
    const { url, opts } = buildRequest(keys[i]);
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      lastErr = err;
      if (isLast) throw err;
      console.warn(`[alchemy-failover] fetch threw on key #${i + 1} (${err?.message ?? err}) — retrying with fallback key`);
      continue;
    }
    if (res.ok || !isRetryableAlchemyStatus(res.status) || isLast) {
      return res;
    }
    console.warn(`[alchemy-failover] upstream ${res.status} on key #${i + 1} — retrying with fallback key`);
    discardBody(res);
  }
  // Unreachable (loop always returns or throws), kept for defensive clarity.
  throw lastErr ?? new Error("alchemy-failover: no attempt made");
}
