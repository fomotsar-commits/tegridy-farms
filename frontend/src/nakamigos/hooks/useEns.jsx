/**
 * Shared ENS resolution hook with localStorage caching.
 * Reuses the shared ens_cache localStorage key across all whale components.
 */
import { useState, useEffect } from "react";
import { getProvider } from "../api";

const CACHE_KEY = "ens_cache";
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ENTRIES = 500;

function loadCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "{}"); } catch { return {}; }
}

function saveCache(cache) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* quota */ }
}

/**
 * Remove expired entries and cap size to MAX_CACHE_ENTRIES.
 * Keeps the most recently resolved entries when over the limit.
 */
function pruneCache(cache) {
  const now = Date.now();
  const entries = Object.entries(cache);
  // Remove expired
  const valid = entries.filter(([, v]) => now - v.ts < CACHE_TTL);
  // If still over limit, keep most recent
  if (valid.length > MAX_CACHE_ENTRIES) {
    valid.sort((a, b) => b[1].ts - a[1].ts);
    valid.length = MAX_CACHE_ENTRIES;
  }
  return Object.fromEntries(valid);
}

// Shared in-memory cache across hook instances
let memCache = loadCache();
const pendingLookups = new Map();

// Prune stale entries on startup
memCache = pruneCache(memCache);
saveCache(memCache);

export async function resolveEns(address) {
  if (!address) return null;
  const lower = address.toLowerCase();

  // Check memory cache (serves both resolved names AND cached misses)
  const cached = memCache[lower];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.name || null;
  }

  // Deduplicate concurrent lookups
  if (pendingLookups.has(lower)) {
    return pendingLookups.get(lower);
  }

  const promise = (async () => {
    try {
      const { ethers } = await import("ethers");
      const provider = getProvider();
      if (!provider) return null;
      const browserProvider = new ethers.BrowserProvider(provider);
      const name = await browserProvider.lookupAddress(address);

      memCache[lower] = { name: name || "", ts: Date.now() };
      memCache = pruneCache(memCache);
      saveCache(memCache);
      return name || null;
    } catch {
      memCache[lower] = { name: "", ts: Date.now() };
      memCache = pruneCache(memCache);
      saveCache(memCache);
      return null;
    } finally {
      pendingLookups.delete(lower);
    }
  })();

  pendingLookups.set(lower, promise);
  return promise;
}

export default function useEns(address) {
  const [name, setName] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!address) { setName(null); return; }
    const lower = address.toLowerCase();

    // Immediate cache check -- serve both hits and cached misses (empty name)
    const cached = memCache[lower];
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      setName(cached.name || null);
      return;
    }

    let stale = false;
    setLoading(true);
    resolveEns(address).then((n) => {
      if (!stale) {
        setName(n);
      }
    }).finally(() => {
      if (!stale) {
        setLoading(false);
      }
    });
    return () => { stale = true; setLoading(false); };
  }, [address]);

  return { ensName: name, loading };
}

/**
 * Display component: shows ENS name or shortened address.
 */
export function EnsName({ address, style }) {
  const { ensName } = useEns(address);
  if (!address) return null;

  const display = ensName || `${address.slice(0, 6)}...${address.slice(-4)}`;

  return (
    <span title={address} style={{ cursor: "pointer", ...style }}>
      {display}
    </span>
  );
}
