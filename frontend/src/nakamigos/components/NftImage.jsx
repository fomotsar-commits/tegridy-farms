import { useState, useEffect, memo } from "react";
import { useActiveCollection } from "../contexts/CollectionContext";

// Alchemy NFT image CDN — direct URL, no API key needed
const alchemyCdnUrl = (tokenId, contract) =>
  `https://nft-cdn.alchemy.com/eth-mainnet/${contract}/${tokenId}`;

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

export default memo(function NftImage({ nft, style, className, large, priority }) {
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
    if (!cached && !primarySrc && nft.id) {
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
  }, [cacheKey, primarySrc, nft.id, collection.contract]);

  const handleError = async () => {
    if (failCount === 0 && nft.id) {
      // First failure: skip CDN for non-Nakamigos (returns 503), go straight to metadata API
      if (!collection.metadataBase) {
        setFailCount(2);
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
        return;
      }
      // Nakamigos: try Alchemy CDN direct URL
      setFailCount(1);
      const cdnUrl = alchemyCdnUrl(nft.id, collection.contract);
      setDynamicSrc(cdnUrl);
      setCachedUrl(cacheKey, cdnUrl);
      return;
    }

    if (failCount === 1 && nft.id) {
      // Second failure: try fetching URL from Alchemy metadata API
      setFailCount(2);
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
      } catch { /* fall through to placeholder */ }
      setCachedFailed(cacheKey);
      setFailCount(3);
      return;
    }

    // All fallbacks exhausted
    setCachedFailed(cacheKey);
    setFailCount(3);
  };

  if (failCount >= 3 || !src) {
    return (
      <div className="nft-placeholder" style={style}>
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
      loading={priority ? "eager" : "lazy"}
      fetchpriority={priority ? "high" : undefined}
      decoding={priority ? "sync" : "async"}
      onError={handleError}
      className={className || ""}
      style={{ ...style, imageRendering: collection.pixelated ? "pixelated" : "auto", aspectRatio: "1" }}
    />
  );
});
