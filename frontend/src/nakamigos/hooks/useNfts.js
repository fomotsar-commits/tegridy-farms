import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { fetchTokens, extractTraitFilters, computeRarity } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";

export default function useNfts({ onChainSupply } = {}) {
  const collection = useActiveCollection();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hasMore, setHasMore] = useState(true);
  const [isLive, setIsLive] = useState(false);
  const [traitFilters, setTraitFilters] = useState([]);
  const [activeFilters, setActiveFilters] = useState({});
  const [sortBy, setSortBy] = useState("tokenId");
  const continuation = useRef(null);
  const tokensRef = useRef(tokens);
  const abortRef = useRef(null);
  tokensRef.current = tokens;

  const load = useCallback(async (reset = false, signal) => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchTokens({
        contract: collection.contract,
        metadataBase: collection.metadataBase,
        pageKey: reset ? undefined : continuation.current,
        limit: 40,
        signal,
      });

      // If this fetch was aborted (collection switched), discard the result
      if (signal?.aborted) return;

      setIsLive(!data.fallback);

      if (reset) {
        setTokens(data.tokens);
        setTraitFilters(extractTraitFilters(data.tokens));
      } else {
        // Merge new tokens with existing ones, deduplicating by id
        const prev = tokensRef.current;
        const existing = new Set(prev.map((t) => t.id));
        const newTokens = data.tokens.filter((t) => !existing.has(t.id));
        const all = [...prev, ...newTokens];
        setTokens(all);
        // Extract trait filters from ALL accumulated tokens, not just the latest batch
        setTraitFilters(extractTraitFilters(all));
      }

      continuation.current = data.continuation;
      setHasMore(!!data.continuation);
    } catch (err) {
      if (signal?.aborted) return;
      setError("Could not load NFTs. Please check your connection and try again.");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [collection]);

  useEffect(() => {
    // Abort any in-flight fetch from the previous collection
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    continuation.current = null;
    setTokens([]);
    setTraitFilters([]);
    setActiveFilters({});
    load(true, controller.signal);

    return () => controller.abort();
  }, [load]);

  const loadMore = useCallback(() => {
    if (!abortRef.current || abortRef.current.signal.aborted) return;
    if (!loading && hasMore) load(false, abortRef.current?.signal);
  }, [loading, hasMore, load]);

  // Auto-load remaining tokens only for small collections (< 1000 supply)
  // For larger collections, users trigger via Analytics tab or trait filter expansion
  useEffect(() => {
    const shouldAutoLoad = collection.supply && collection.supply < 1000;
    if (!shouldAutoLoad) return;
    if (!hasMore || loading || tokens.length === 0) return;
    if (!abortRef.current || abortRef.current.signal.aborted) return;

    // Throttle: wait 500ms between auto-load pages to avoid API spam
    const timer = setTimeout(() => {
      if (!abortRef.current?.signal.aborted) {
        load(false, abortRef.current?.signal);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [hasMore, loading, tokens.length, load, collection.supply]);

  const [loadingAll, setLoadingAll] = useState(false);

  const loadAll = useCallback(() => {
    setLoadingAll(true);
  }, []);

  // Continuously load pages while loadAll has been requested
  useEffect(() => {
    if (!loadingAll) return;
    if (!hasMore || loading) {
      if (!hasMore) setLoadingAll(false);
      return;
    }
    if (!abortRef.current || abortRef.current.signal.aborted) {
      setLoadingAll(false);
      return;
    }
    const timer = setTimeout(() => {
      load(false, abortRef.current?.signal);
    }, 200);
    return () => clearTimeout(timer);
  }, [hasMore, loading, load, tokens.length, loadingAll]);

  const changeFilter = useCallback((filters) => {
    setActiveFilters(filters);
  }, []);

  // Compute rarity ranks from all loaded tokens.
  // Use actualSupply (prefers stats.supply from API over config) so the
  // denominator reflects the real on-chain supply (e.g. GNSS Art = 9697).
  const rankedTokens = useMemo(() => {
    if (tokens.length < 2) return tokens;
    return computeRarity(tokens, collection.contract, onChainSupply);
  }, [tokens, collection.contract, onChainSupply]);

  // Client-side filtering (memoized to avoid recomputing on every render)
  const filtered = useMemo(() => {
    if (Object.keys(activeFilters).length === 0) return rankedTokens;
    return rankedTokens.filter(token =>
      Object.entries(activeFilters).every(([key, values]) =>
        Array.isArray(values)
          ? token.attributes?.some(a => a.key === key && values.includes(a.value))
          : token.attributes?.some(a => a.key === key && a.value === values)
      )
    );
  }, [rankedTokens, activeFilters]);

  // Client-side sorting (memoized)
  const filteredTokens = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const idA = parseInt(a.id, 10);
      const idB = parseInt(b.id, 10);
      if (sortBy === "tokenId-desc") return idB - idA;
      if (sortBy === "price") return (b.price || 0) - (a.price || 0);
      if (sortBy === "price-asc") return (a.price || 0) - (b.price || 0);
      if (sortBy === "rarity") return (a.rank || Infinity) - (b.rank || Infinity);
      return idA - idB;
    });
  }, [filtered, sortBy]);

  const refresh = useCallback(() => {
    // Abort any in-flight fetch before refreshing
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    continuation.current = null;
    load(true, controller.signal);
  }, [load]);

  return {
    tokens: filteredTokens,
    allTokens: rankedTokens,
    loading,
    error,
    hasMore,
    isLive,
    traitFilters,
    activeFilters,
    sortBy,
    loadMore,
    loadAll,
    changeFilter,
    setSortBy,
    refresh,
  };
}
