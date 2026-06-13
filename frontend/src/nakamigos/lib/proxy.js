// ═══ API PROXY HELPERS ═══
// Routes all external API calls through Vercel serverless functions
// to hide API keys from the browser. Battle-tested pattern used by
// Blur, Reservoir, and every serious marketplace.

const PROXY_BASE = ""; // same-origin — serverless functions live alongside the app

// Custom error class that preserves HTTP status for retry logic
export class ApiError extends Error {
  constructor(message, status, retryAfter = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.retryAfter = retryAfter; // seconds (from Retry-After header)
  }

  /** True for network errors (status 0), 429, 5xx — errors the server may recover from */
  get isRetryable() {
    return this.status === 0 || this.status === 429 || (this.status >= 500 && this.status < 600);
  }
}

// Default request timeout (ms). A stalled proxy request (sent, no response)
// would otherwise leave a promise that never settles — which latches loading
// skeletons forever (F692/F611/F516). 30s is far beyond any healthy response,
// so it only ever fires on a genuinely hung request, and surfaces as a
// retryable network error (status 0) via withRetry.
const REQUEST_TIMEOUT_MS = 30000;

// fetch() with a timeout that also respects the caller's abort signal.
// Uses a local controller so we don't depend on AbortSignal.any/timeout
// being present; aborts on either a timeout or the caller aborting.
function fetchWithTimeout(url, opts, callerSignal, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort(callerSignal.reason);
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Request timed out", "TimeoutError"));
  }, timeoutMs);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() => {
    clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  });
}

// Parse Retry-After header: may be seconds (integer) or HTTP-date
function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs > 0) return secs;
  // Try HTTP-date
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(1, Math.ceil((date - Date.now()) / 1000));
  return null;
}

// ── OpenSea Proxy ──────────────────────────────────────────────
// All OpenSea API calls route through /api/opensea?path=...
export async function opensea(path, { method = "GET", body, params = {}, signal } = {}) {
  const url = new URL(`${PROXY_BASE}/api/opensea`, window.location.origin);
  url.searchParams.set("path", path);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });

  const opts = {
    method,
    headers: { Accept: "application/json" },
  };
  if (signal) opts.signal = signal;

  if (body && (method === "POST" || method === "PUT")) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetchWithTimeout(url.toString(), opts, signal);
  } catch (err) {
    // Propagate a real caller-abort so withRetry / callers don't retry it.
    if (err.name === "AbortError" && signal?.aborted) throw err;
    // fetch() throws TypeError on CORS/network-down; TimeoutError on our
    // request timeout — both are transient, surface as retryable (status 0).
    throw new ApiError(`OpenSea proxy: network/timeout error — ${err.message}`, 0);
  }
  if (!res.ok) {
    const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
    const text = await res.text().catch(() => "");
    throw new ApiError(`OpenSea proxy ${res.status}: ${text}`, res.status, retryAfter);
  }
  // Safe JSON parse — proxy may return non-JSON on edge-case Vercel errors
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`OpenSea proxy: non-JSON response`, 502);
  }
}

// Convenience: OpenSea GET with params
export function openseaGet(path, params = {}, { signal } = {}) {
  return opensea(path, { params, signal });
}

// Convenience: OpenSea POST with body
export function openseaPost(path, body, { signal } = {}) {
  return opensea(path, { method: "POST", body, signal });
}

// ── Alchemy Proxy ──────────────────────────────────────────────
// All Alchemy NFT API calls route through /api/alchemy?endpoint=...
export async function alchemy(endpoint, { method = "GET", body, params = {}, signal } = {}) {
  const url = new URL(`${PROXY_BASE}/api/alchemy`, window.location.origin);
  url.searchParams.set("endpoint", endpoint);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  });

  const opts = {
    method,
    headers: { Accept: "application/json" },
  };
  if (signal) opts.signal = signal;

  if (body && (method === "POST" || method === "PUT")) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetchWithTimeout(url.toString(), opts, signal);
  } catch (err) {
    // Propagate a real caller-abort so withRetry / callers don't retry it.
    if (err.name === "AbortError" && signal?.aborted) throw err;
    // fetch() throws TypeError on CORS/network-down; TimeoutError on our
    // request timeout — both are transient, surface as retryable (status 0).
    throw new ApiError(`Alchemy proxy: network/timeout error — ${err.message}`, 0);
  }
  if (!res.ok) {
    const retryAfter = parseRetryAfter(res.headers.get("Retry-After"));
    const text = await res.text().catch(() => "");
    throw new ApiError(`Alchemy proxy ${res.status}: ${text}`, res.status, retryAfter);
  }
  // Safe JSON parse — proxy may return non-JSON on edge-case Vercel errors
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(`Alchemy proxy: non-JSON response`, 502);
  }
}

// Convenience: Alchemy GET with params (matches existing alchemyGet pattern)
export function alchemyGet(endpoint, params = {}, { signal } = {}) {
  return alchemy(endpoint, { params, signal });
}

// Convenience: Alchemy POST with body (for getNFTMetadataBatch)
export function alchemyPost(endpoint, body, { signal } = {}) {
  return alchemy(endpoint, { method: "POST", body, signal });
}
