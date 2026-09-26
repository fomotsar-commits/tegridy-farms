import { useState, useEffect, useRef, memo } from "react";
import { useActiveCollection } from "../contexts/CollectionContext";
import { ipfsGatewayUrls, liveIpfsUrl, nextIpfsGatewayUrl } from "../../lib/ipfsGateways";
import { useIpfsHangTimer } from "../../hooks/useIpfsHangTimer";

// Respect the user's reduced-motion preference for the image fade-in.
// Guard matchMedia itself — jsdom defines window but not matchMedia, and this
// module is imported transitively by code under test.
const prefersReducedMotion =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Touch devices (phones/iPads) report a coarse pointer. We skip the 2x srcSet upgrade
// there: the grid srcSet uses density descriptors (1x/2x) with NO `sizes`, so a retina
// phone would fetch imageLarge (up to a 2000px IPFS original) into a ~200px cell — huge
// wasted bandwidth + slow decode (the "images slow to appear" symptom). The small `src`
// thumbnail is plenty on mobile; desktop retina still gets the crisp 2x variant.
const IS_COARSE_POINTER =
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  (() => { try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; } })();

// (The old nft-cdn.alchemy.com/<contract>/<tokenId> direct-URL fallback was
// removed 2026-06-11: that format now returns 403 for every collection here.
// BidManager/MyListings still carry their own copies as last-resort fallbacks.)

// Alchemy metadata API fallback — routed through server proxy to hide API key
const alchemyMetadataProxy = (tokenId, contract) =>
  `/api/alchemy?endpoint=getNFTMetadata&contractAddress=${contract}&tokenId=${tokenId}`;

// ipfs:// URIs and URLs on a retired gateway (ipfs.io, dweb.link... dead since
// 2026-09-21) move onto the first live gateway of the site-wide list
// (lib/ipfsGateways.ts). A failing gateway is walked forward in handleError and
// by the hang timer below; everything else passes through unchanged.
const resolveIpfs = liveIpfsUrl;

// Same image? Two gateway URLs for one CID path are, so a fallback that only
// changes the gateway is not a new candidate (it would walk the list again).
function sameImage(a, b) {
  const x = ipfsGatewayUrls(a)[0];
  return x ? x === ipfsGatewayUrls(b)[0] : a === b;
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

// Distinguish a cached FAILURE (url is null but we know the token is bad) from a
// cache MISS — without this the 5-min failure TTL is dead and every remount of a
// known-bad token re-hits /api/alchemy (F575). Returns true only for a fresh,
// non-expired failure sentinel.
function isCachedFailure(id) {
  const entry = resolvedUrls.get(id);
  if (!entry || !entry.failed) return false;
  if (Date.now() - entry.ts > CACHE_TTL) {
    resolvedUrls.delete(id);
    return false;
  }
  return true;
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
  const [failCount, setFailCount] = useState(() => (isCachedFailure(`${collection.contract}:${nft.id}`) ? 3 : 0));
  const [dynamicSrc, setDynamicSrc] = useState(() => getCachedUrl(`${collection.contract}:${nft.id}`));
  const [loaded, setLoaded] = useState(false);
  const imgRef = useRef(null);

  const primarySrc = resolveIpfs(large
    ? (nft.imageLarge || nft.image)
    : nft.image);

  const src = dynamicSrc || primarySrc;

  // F603: responsive srcset for the grid thumbnail. Only when we're showing the
  // normalized primary src (not a resolved-fallback dynamicSrc) AND both a small
  // thumbnail and a larger CDN size exist — map thumb -> 1x, large -> 2x so
  // retina displays fetch the crisper variant without bloating 1x bandwidth.
  const srcSet =
    !IS_COARSE_POINTER && !large && !dynamicSrc && nft.imageThumb && nft.imageLarge && nft.imageThumb !== nft.imageLarge
      ? `${nft.imageThumb} 1x, ${nft.imageLarge} 2x`
      : undefined;

  // Re-arm the fade whenever the actual image source changes (e.g. a metadata
  // fetch resolves a real URL after the placeholder) so the new art fades in.
  useEffect(() => { setLoaded(false); }, [src]);

  useEffect(() => {
    // A cached failure within TTL: go straight to the placeholder and skip the
    // metadata refetch (the whole point of the failure sentinel — F575).
    if (isCachedFailure(cacheKey)) {
      setFailCount(3);
      setDynamicSrc(null);
      return;
    }
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
            const url = resolveIpfs(data.image?.cachedUrl || data.image?.pngUrl || data.image?.thumbnailUrl || data.image?.originalUrl || data.raw?.metadata?.image);
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
    // An IPFS image that failed on one gateway is tried on the next one first.
    // Not cached (a success entry has no TTL) and costs no metadata request, so
    // it runs even under noSelfFetch. After the last gateway, the chain below.
    const nextGateway = nextIpfsGatewayUrl(src);
    if (nextGateway) {
      setDynamicSrc(nextGateway);
      return;
    }

    // When a caller is batch-fetching this token's metadata (noSelfFetch), don't
    // fire a per-card /api/alchemy fetch — that's the rate-limit storm the batch
    // path exists to avoid. Mirror the mount-effect guard (F592): leave the
    // pending placeholder up so a URL arriving from the batch can still render.
    if (noSelfFetch) return;

    // F683: the modal/theater hero asks for `imageLarge` — often a full-res IPFS
    // original that 503s or times out while the grid's `image` thumbnail for the
    // same token is already loading fine. Step down to the thumbnail before the
    // metadata API rather than after: a visibly lower-res hero beats the letter
    // placeholder, and it costs no request.
    //
    // Deliberately NOT written to `resolvedUrls`: a success entry has no TTL, so
    // caching a step-down would pin every later hero and theater view of this
    // token to the thumbnail for the rest of the session over one transient 503.
    const thumb = resolveIpfs(nft.image);
    if (large && failCount === 0 && thumb && !sameImage(thumb, src)) {
      setFailCount(1);
      setDynamicSrc(thumb);
      return;
    }

    if (failCount < 2 && nft.id) {
      // First failure: go straight to the metadata API. (The old intermediate
      // hop — nft-cdn.alchemy.com/<contract>/<tokenId> — now 403s for
      // Nakamigos too, and setting an identical failing src never re-fires
      // onError, which stalled the whole chain.)
      setFailCount(2);
      try {
        const res = await fetch(alchemyMetadataProxy(nft.id, collection.contract));
        if (res.ok) {
          const data = await res.json();
          const url = resolveIpfs(data.image?.cachedUrl || data.image?.pngUrl || data.image?.thumbnailUrl || data.image?.originalUrl || data.raw?.metadata?.image);
          if (url && !sameImage(url, src)) {
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

  // A gateway that HANGS never fires onError, so the walk above would stop at
  // it. The shared hang timer treats a hang like an error: the next gateway, or
  // after the last one the fallbacks in handleError (thumbnail, then Alchemy's
  // copy). It only fires when the gateway has sent no image bytes at all, so a
  // large image that is still downloading is left alone.
  useIpfsHangTimer(imgRef, src, {
    lazy: !priority,
    disabled: loaded || failCount >= 3,
    onHang: handleError,
  });

  if (failCount >= 3 || !src) {
    // While a caller-side batch fetch is pending, run a shimmer sweep so the
    // card reads as "fetching art" rather than a wall of static letters. A
    // permanently-missing token (failed, not pending) keeps the plain static
    // placeholder, so the shimmer never implies endless loading.
    const pending = noSelfFetch && failCount < 3;
    return (
      <div className={`nft-placeholder${pending ? " loading" : ""}`} style={style}>
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
      srcSet={srcSet}
      alt={nft.name}
      width={300}
      height={300}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding={priority ? "sync" : "async"}
      onError={handleError}
      onLoad={() => setLoaded(true)}
      ref={(node) => { imgRef.current = node; if (node && node.complete && node.naturalWidth > 0) setLoaded(true); }}
      className={className || ""}
      style={{
        ...style,
        imageRendering: collection.pixelated ? "pixelated" : "auto",
        aspectRatio: "1",
        // Gentle fade from the dark card background to the art instead of a
        // one-frame black→image pop (F623). Reduced-motion users get no fade.
        opacity: loaded || prefersReducedMotion ? 1 : 0,
        transition: prefersReducedMotion ? undefined : "opacity 0.12s ease",
      }}
    />
  );
});
