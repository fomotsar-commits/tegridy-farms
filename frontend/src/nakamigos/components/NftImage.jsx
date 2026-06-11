import { useState, useEffect, memo } from "react";
import { useActiveCollection } from "../contexts/CollectionContext";

// (The old nft-cdn.alchemy.com/<contract>/<tokenId> direct-URL fallback was
// removed 2026-06-11: that format now returns 403 for every collection here.
// BidManager/MyListings still carry their own copies as last-resort fallbacks.)

// Alchemy metadata API fallback — routed through server proxy to hide API key
const alchemyMetadataProxy = (tokenId, contract) =>
  `/api/alchemy?endpoint=getNFTMetadata&contractAddress=${contract}&tokenId=${tokenId}`;

// Convert ipfs:// URLs to an HTTP gateway
function resolveIpfs(url) {
  if (!url) return url;
  if (url.startsWith("ipfs://")) return url.replace("ipfs://", "https://ipfs.io/ipfs/");
  return url;
}

// Cache: maps tokenId -> { url, ts } (survives across renders, TTL for failed entries)
const resolvedUrls = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 2000; // Prevent unbounded growth when browsing many collections

function evictOldest() {
  if (resolvedUrls.size <= MAX_CACHE_SIZE) return;
  // Map iterates in insertion order — delete the oldest entries
  const toRemove = resolvedUrls.size - MAX_CACHE_SIZE;
  let removed = 0;
  for (const key of resolvedUrls.keys()) {
    if (removed >= toRemove) break;
    resolvedUrls.delete(key);
    removed++;
  }
}

function getCachedUrl(id) {
  const entry = resolvedUrls.get(id);
  if (!entry) return null;
  // If it was a failure sentinel and TTL has expired, evict and retry
  if (entry.failed && Date.now() - entry.ts > CACHE_TTL) {
    resolvedUrls.delete(id);
    return null;
  }
  return entry.url;
}

function setCachedUrl(id, url) {
  resolvedUrls.set(id, { url, ts: Date.now(), failed: false });
  evictOldest();
}

function setCachedFailed(id) {
  resolvedUrls.set(id, { url: null, ts: Date.now(), failed: true });
  evictOldest();
}

// noSelfFetch: the caller is batch-fetching metadata for this token (e.g. the
// listings grid via fetchTokensByIds) — render the placeholder without firing
// a per-card /api/alchemy fetch. Sixty cards mounting at once each doing their
// own metadata fetch tripped the proxy rate limit and locked the buy grid into
// letter placeholders for minutes (prod 2026-06-11).
export default memo(function NftImage({ nft, style, className, large, priority, noSelfFetch }) {
  const collection = useActiveCollection();
  const cacheKey = `${collection.contract}:${nft.id}`;
  const [failCount, setFailCount] = useState(0);
  const [dynamicSrc, setDynamicSrc] = useState(() => getCachedUrl(cacheKey));

  const primarySrc = large
    ? (nft.imageLarge || nft.image)
    : nft.image;

  const src = dynamicSrc || primarySrc;

  useEffect(() => {
    setFailCount(0);
    const cached = getCachedUrl(cacheKey);
    setDynamicSrc(cached);

    // If no image URL at all, immediately try metadata API
    if (!cached && !primarySrc && nft.id && !noSelfFetch) {
      (async () => {
        try {
          const res = await fetch(alchemyMetadataProxy(nft.id, collection.contract));
          if (res.ok) {
            const data = await res.json();
            const url = data.image?.cachedUrl || data.image?.pngUrl || data.image?.thumbnailUrl || data.image?.originalUrl || resolveIpfs(data.raw?.metadata?.image);
            if (url) {
              setDynamicSrc(url);
              setCachedUrl(cacheKey, url);
              return;
            }
          }
        } catch { /* fall through */ }
        setCachedFailed(cacheKey);
        setFailCount(3);
      })();
    }
  }, [cacheKey, primarySrc, nft.id, collection.contract, noSelfFetch]);

  const handleError = async () => {
    if (failCount === 0 && nft.id) {
      // First failure: go straight to the metadata API. (The old intermediate
      // hop — nft-cdn.alchemy.com/<contract>/<tokenId> — now 403s for
      // Nakamigos too, and setting an identical failing src never re-fires
      // onError, which stalled the whole chain.)
      setFailCount(2);
      try {
        const res = await fetch(alchemyMetadataProxy(nft.id, collection.contract));
        if (res.ok) {
          const data = await res.json();
          const url = data.image?.cachedUrl || data.image?.pngUrl || data.image?.thumbnailUrl || data.image?.originalUrl || resolveIpfs(data.raw?.metadata?.image);
          if (url && url !== src) {
            setDynamicSrc(url);
            setCachedUrl(cacheKey, url);
            return;
          }
        }
      } catch { /* fall through */ }
      setCachedFailed(cacheKey);
      setFailCount(3);
      return;
    }

    // All fallbacks exhausted
    setCachedFailed(cacheKey);
    setFailCount(3);
  };

  if (failCount >= 3 || !src) {
    // While a caller-side batch fetch is pending, pulse to read as "loading"
    // rather than "missing".
    const pending = noSelfFetch && failCount < 3;
    return (
      <div
        className="nft-placeholder"
        style={pending ? { ...style, animation: "pulse 1.6s ease-in-out infinite" } : style}
      >
        <div style={{ textAlign: "center" }}>
          <div className="nft-placeholder-icon">{collection.name?.[0] || "?"}</div>
          <div className="nft-placeholder-id">#{nft.id}</div>
        </div>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={nft.name}
      width={300}
      height={300}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding={priority ? "sync" : "async"}
      onError={handleError}
      className={className || ""}
      style={{ ...style, imageRendering: collection.pixelated ? "pixelated" : "auto", aspectRatio: "1" }}
    />
  );
});
