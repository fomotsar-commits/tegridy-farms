import { useEffect, useState } from "react";
import { useTOWELIPriceOptional } from "../../contexts/PriceContext";

/**
 * Shared, honest ETH/USD rate for the Tradermigos (Naka) trading surface.
 *
 * Source priority (never fabricates a rate):
 *   1. The main app's PriceContext (`useTOWELIPriceOptional().ethUsd`) when the
 *      Naka tree happens to mount inside AppLayout's <PriceProvider>. That value
 *      is Chainlink-backed + staleness-validated (hooks/useToweliPrice.ts) — the
 *      best source when present. The embedded /nakamigos route and the standalone
 *      gallery build currently mount OUTSIDE that provider, so this is usually
 *      null here — hence the CoinGecko fallback below.
 *   2. A single shared CoinGecko spot fetch (no key required), cached in
 *      localStorage, refreshed on a visibility-gated 5-minute interval.
 *
 * Returns `0` when no real rate is available — callers must treat 0 as "no USD"
 * and render nothing (see formatUsd, which returns its fallback for a 0 rate).
 * We NEVER hardcode a placeholder rate.
 *
 * T8: the CoinGecko poll is module-singleton (one fetch shared across every
 * consumer, not one per mount) and skips while the tab is hidden.
 */

const CACHE_KEY = "naka_eth_usd";
const CACHE_VERSION = 1;
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // reject entries older than 24h
const REFRESH_MS = 5 * 60 * 1000; // 5 minutes — ETH/USD moves slowly enough
const FETCH_TIMEOUT_MS = 10_000;
// Plausibility clamp — mirrors the Chainlink bounds in useToweliPrice.ts so a
// glitched feed value can never paint an absurd USD figure on a money surface.
const ETH_USD_MIN = 100;
const ETH_USD_MAX = 100_000;

// ── Module-singleton state (shared across all hook consumers) ──────────────
let sharedRate = 0;
let lastFetchTs = 0;
let inFlight = null;
const subscribers = new Set();

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== CACHE_VERSION) return 0;
    if (typeof parsed.rate !== "number" || !(parsed.rate > 0)) return 0;
    if (typeof parsed.ts !== "number") return 0;
    if (Date.now() - parsed.ts > CACHE_MAX_AGE_MS) return 0;
    if (parsed.rate < ETH_USD_MIN || parsed.rate > ETH_USD_MAX) return 0;
    return parsed.rate;
  } catch {
    return 0;
  }
}

function writeCache(rate) {
  try {
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ version: CACHE_VERSION, rate, ts: Date.now() }),
    );
  } catch {
    /* localStorage unavailable (private mode / quota) — non-fatal */
  }
}

function broadcast(rate) {
  sharedRate = rate;
  subscribers.forEach((fn) => {
    try {
      fn(rate);
    } catch {
      /* ignore subscriber errors */
    }
  });
}

function fetchEthUsd() {
  // Coalesce concurrent callers onto one network request.
  if (inFlight) return inFlight;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  inFlight = fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
    { signal: controller.signal, headers: { Accept: "application/json" } },
  )
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      const rate = Number(d?.ethereum?.usd);
      if (rate > 0 && rate >= ETH_USD_MIN && rate <= ETH_USD_MAX) {
        lastFetchTs = Date.now();
        writeCache(rate);
        broadcast(rate);
      }
    })
    .catch((err) => {
      // Network/abort failure — keep the last known (cached) rate; do not
      // invent one. Log for diagnostics only.
      if (err?.name !== "AbortError") {
        console.warn("[useEthUsd] CoinGecko fetch failed:", err?.message ?? err);
      }
    })
    .finally(() => {
      clearTimeout(timeout);
      inFlight = null;
    });
  return inFlight;
}

export function useEthUsd() {
  // Prefer the Chainlink-backed context rate when the tree is wrapped in it.
  const ctxRate = useTOWELIPriceOptional()?.ethUsd ?? 0;

  const [rate, setRate] = useState(() => sharedRate || readCache());

  useEffect(() => {
    if (ctxRate > 0) return; // context owns the rate — skip the CoinGecko path

    // Seed from cache immediately if the module hasn't fetched yet.
    if (!sharedRate) {
      const cached = readCache();
      if (cached > 0) {
        sharedRate = cached;
        setRate(cached);
      }
    } else {
      setRate(sharedRate);
    }

    const onUpdate = (r) => setRate(r);
    subscribers.add(onUpdate);

    // Fetch on mount if we have no rate or the shared one is stale.
    if (sharedRate <= 0 || Date.now() - lastFetchTs > REFRESH_MS) {
      fetchEthUsd();
    }

    // Visibility-gated refresh — one shared interval is fine since the fetch
    // itself is coalesced; a hidden tab never fetches.
    const interval = setInterval(() => {
      if (!document.hidden) fetchEthUsd();
    }, REFRESH_MS);

    return () => {
      subscribers.delete(onUpdate);
      clearInterval(interval);
    };
  }, [ctxRate]);

  return ctxRate > 0 ? ctxRate : rate;
}

export default useEthUsd;
