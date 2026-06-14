/**
 * Shared ENS resolution hook with localStorage caching.
 * Reuses the shared ens_cache localStorage key across all whale components.
 */
import { useState, useEffect } from "react";
import { getProvider } from "../api";
import { getReadProvider } from "../lib/rpcProvider";

const CACHE_KEY = "ens_cache";
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const MAX_CACHE_ENTRIES = 500;

// Forward-resolution cache entries (name → address) share the same localStorage
// bucket as reverse lookups but are namespaced so the two directions never
// collide (a key like "vitalik.eth" can't be mistaken for an 0x address).
const FWD_PREFIX = "fwd:";

/**
 * Pure check: does this input look like an ENS name we should try to resolve?
 * Conservative on purpose — only obvious dotted names (e.g. "vitalik.eth",
 * "foo.bar.eth"). Anything starting with 0x, or with no dot, or with spaces is
 * not an ENS name. Used to branch the new-DM input between the raw-address path
 * and the resolve path. Does NOT assert the name actually resolves on-chain.
 */
export function isEnsName(input) {
  if (typeof input !== "string") return false;
  const v = input.trim().toLowerCase();
  if (!v || v.startsWith("0x")) return false;
  // label(.label)+.tld — labels are [a-z0-9-], no leading/trailing/double dots,
  // and a real TLD label of 2+ chars. This admits .eth and other ENS-bridged
  // TLDs without hardcoding the suffix list.
  return /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/.test(v);
}

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

/**
 * Forward ENS resolution: name (e.g. "vitalik.eth") → checksummed address, or
 * null if it doesn't resolve. Reuses the same on/off behavior as reverse:
 * localStorage caching (incl. cached misses), concurrent-lookup dedup, 30-min
 * TTL. Resolves against the shared read-only mainnet FallbackProvider
 * (getReadProvider) rather than the wallet — so it works even when the
 * connected wallet is on the wrong chain or absent, mirroring OnChainProfile.
 *
 * Lookalike-scam safety: this ONLY maps a name to its current on-chain owner.
 * Callers must surface the resolved address to the user and never auto-trust a
 * name as an identity.
 */
export async function resolveEnsName(name) {
  if (!isEnsName(name)) return null;
  const key = FWD_PREFIX + name.trim().toLowerCase();

  // Cache (serves resolved hits AND cached misses, same as reverse)
  const cached = memCache[key];
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.addr || null;
  }

  // Deduplicate concurrent lookups
  if (pendingLookups.has(key)) {
    return pendingLookups.get(key);
  }

  const promise = (async () => {
    try {
      const provider = await getReadProvider();
      const addr = await provider.resolveName(name.trim());
      memCache[key] = { addr: addr || "", ts: Date.now() };
      memCache = pruneCache(memCache);
      saveCache(memCache);
      return addr || null;
    } catch {
      // Don't cache transient RPC/network failures as a confirmed miss —
      // a later attempt should be allowed to resolve.
      return null;
    } finally {
      pendingLookups.delete(key);
    }
  })();

  pendingLookups.set(key, promise);
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
