/**
 * Hook to check and cache holder status for wallet addresses.
 * Returns tier: "whale" (10+), "collector" (5-9), "holder" (1-4), or null (0).
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { fetchWalletNfts } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";

const CACHE_PREFIX = "holder_cache_";
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function loadCache(contract) {
  try {
    const key = CACHE_PREFIX + (contract || "default").toLowerCase();
    return JSON.parse(localStorage.getItem(key) || "{}");
  } catch { return {}; }
}

function saveCache(cache, contract) {
  try {
    const key = CACHE_PREFIX + (contract || "default").toLowerCase();
    localStorage.setItem(key, JSON.stringify(cache));
  } catch { /* quota */ }
}

export function getHolderTier(count) {
  if (count >= 10) return "whale";
  if (count >= 5) return "collector";
  if (count >= 1) return "holder";
  return null;
}

export function holderTierLabel(tier) {
  if (tier === "whale") return "Whale";
  if (tier === "collector") return "Collector";
  if (tier === "holder") return "Holder";
  return null;
}

export function holderTierColor(tier) {
  if (tier === "whale") return "#d4a843";
  if (tier === "collector") return "#6fa8dc";
  if (tier === "holder") return "#4ade80";
  return "var(--text-dim)";
}

export default function useHolderStatus(address, contract) {
  const [tier, setTier] = useState(null);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const cacheRef = useRef(loadCache(contract));
  const generationRef = useRef(0);

  // Reset state when contract changes so stale tier from a previous
  // collection is never shown while the new fetch is in-flight.
  useEffect(() => {
    generationRef.current++;
    setTier(null);
    setCount(0);
    cacheRef.current = loadCache(contract);
  }, [contract]);

  const check = useCallback(async (addr) => {
    if (!addr) { setTier(null); setCount(0); return; }
    const lower = addr.toLowerCase();

    // Reload cache for current contract
    cacheRef.current = loadCache(contract);

    // Check cache
    const cached = cacheRef.current[lower];
    if (cached && Date.now() - cached.ts < CACHE_TTL) {
      setCount(cached.count);
      setTier(getHolderTier(cached.count));
      return;
    }

    // Capture generation so we can discard stale results
    const gen = generationRef.current;

    setLoading(true);
    try {
      const data = await fetchWalletNfts(addr, contract);
      // Discard result if contract/address changed while fetching
      if (gen !== generationRef.current) return;
      const c = data.totalCount || 0;
      setCount(c);
      setTier(getHolderTier(c));

      // Cache result
      cacheRef.current[lower] = { count: c, ts: Date.now() };
      saveCache(cacheRef.current, contract);
    } catch {
      if (gen !== generationRef.current) return;
      // On error, use cached if available
      if (cached) {
        setCount(cached.count);
        setTier(getHolderTier(cached.count));
      }
    } finally {
      if (gen === generationRef.current) setLoading(false);
    }
  }, [contract]);

  useEffect(() => { check(address); }, [address, check]);

  return { tier, count, loading };
}

/**
 * Inline badge component for holder status.
 */
export function HolderBadge({ tier, size = "small", collectionName }) {
  const collection = useActiveCollection();
  if (!tier) return null;

  const label = holderTierLabel(tier);
  const color = holderTierColor(tier);
  const isSmall = size === "small";
  const name = collectionName || collection?.name || "this collection";

  const icons = {
    whale: "\uD83D\uDC0B",
    collector: "\u2B50",
    holder: "\u2713",
  };

  return (
    <span
      title={`${label} — Verified ${name} holder`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        fontFamily: "var(--mono)",
        fontSize: isSmall ? 8 : 10,
        color,
        background: `${color}15`,
        border: `1px solid ${color}30`,
        borderRadius: 4,
        padding: isSmall ? "1px 5px" : "2px 8px",
        letterSpacing: "0.04em",
        whiteSpace: "nowrap",
        verticalAlign: "middle",
      }}
    >
      <span style={{ fontSize: isSmall ? 9 : 11 }}>{icons[tier]}</span>
      {!isSmall && label.toUpperCase()}
    </span>
  );
}
