import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { getProvider } from "../api";
import { SEAPORT_ADDRESS, PLATFORM_FEE_BPS } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useWalletState, useWalletActions } from "../contexts/WalletContext";
import EmptyState from "./EmptyState";

// Compute seller revenue after platform fee
function computeRevenue(totalPrice) {
  if (!totalPrice || totalPrice <= 0) return 0;
  return totalPrice - (totalPrice * PLATFORM_FEE_BPS) / 10000;
}

const REFRESH_INTERVAL = 30_000;

// ═══ STYLES ═══

const styles = {
  container: {
    width: "100%",
    maxWidth: 960,
    margin: "0 auto",
    padding: "24px 16px",
  },
  title: {
    fontFamily: "var(--pixel, var(--display))",
    fontSize: 22,
    color: "var(--text)",
    letterSpacing: "0.04em",
    marginBottom: 20,
  },
  summaryBar: {
    display: "flex",
    alignItems: "center",
    gap: 20,
    padding: "12px 16px",
    marginBottom: 16,
    background: "var(--surface-glass)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
  },
  summaryItem: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  summaryLabel: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
  },
  summaryValue: {
    fontFamily: "var(--display)",
    fontSize: 16,
    fontWeight: 600,
    color: "var(--text)",
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  cancelAllBtn: {
    marginLeft: "auto",
    fontFamily: "var(--mono)",
    fontSize: 9,
    color: "var(--red)",
    background: "rgba(248,113,113,0.06)",
    border: "1px solid rgba(248,113,113,0.15)",
    borderRadius: 5,
    padding: "6px 14px",
    cursor: "pointer",
    whiteSpace: "nowrap",
    letterSpacing: "0.04em",
    textTransform: "uppercase",
  },
  card: {
    background: "var(--border)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "12px 16px",
    marginBottom: 8,
    display: "flex",
    alignItems: "center",
    gap: 14,
    backdropFilter: "blur(12px)",
    WebkitBackdropFilter: "blur(12px)",
  },
  nftThumb: {
    width: 52,
    height: 52,
    borderRadius: 8,
    overflow: "hidden",
    flexShrink: 0,
    cursor: "pointer",
    background: "var(--border)",
  },
  cardInfo: {
    flex: 1,
    minWidth: 0,
  },
  cardName: {
    fontFamily: "var(--display)",
    fontSize: 14,
    fontWeight: 600,
    color: "var(--text)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  cardMeta: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-dim)",
    marginTop: 3,
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    alignItems: "center",
  },
  price: {
    fontFamily: "var(--display)",
    fontSize: 16,
    fontWeight: 600,
    color: "var(--text)",
    whiteSpace: "nowrap",
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  btnCancel: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    color: "var(--red)",
    background: "rgba(248,113,113,0.06)",
    border: "1px solid rgba(248,113,113,0.15)",
    borderRadius: 5,
    padding: "5px 12px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  actions: {
    display: "flex",
    gap: 6,
    flexShrink: 0,
  },
  refreshNote: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    color: "var(--text-muted)",
    textAlign: "right",
    marginBottom: 8,
  },
  badge: (color) => ({
    display: "inline-block",
    fontFamily: "var(--mono)",
    fontSize: 8,
    letterSpacing: "0.04em",
    textTransform: "uppercase",
    padding: "2px 6px",
    borderRadius: 4,
    color,
    background: color === "var(--green, #4ade80)"
      ? "rgba(74,222,128,0.1)"
      : color === "var(--yellow, #facc15)"
        ? "rgba(250,204,21,0.1)"
        : "rgba(248,113,113,0.1)",
    border: `1px solid ${color === "var(--green, #4ade80)"
      ? "rgba(74,222,128,0.2)"
      : color === "var(--yellow, #facc15)"
        ? "rgba(250,204,21,0.2)"
        : "rgba(248,113,113,0.2)"}`,
  }),
};

// Alchemy CDN fallback
const alchemyCdnUrl = (tokenId, contract) =>
  `https://nft-cdn.alchemy.com/eth-mainnet/nft-image/${contract}/${tokenId}`;

// ═══ HELPERS ═══

function timeLeft(expiry) {
  if (!expiry) return "";
  const diff = (expiry instanceof Date ? expiry : new Date(expiry)).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const hours = Math.floor(diff / 3600000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d left`;
  if (hours > 0) return `${hours}h left`;
  return `${Math.floor(diff / 60000)}m left`;
}

function getHealthBadge(price, floorPrice) {
  if (!floorPrice || floorPrice <= 0 || !price) return null;
  const pctAbove = ((price - floorPrice) / floorPrice) * 100;
  if (pctAbove <= 10) {
    return { label: "Near Floor", color: "var(--green, #4ade80)", pctAbove };
  }
  if (pctAbove <= 30) {
    return { label: "Above Floor", color: "var(--yellow, #facc15)", pctAbove };
  }
  return { label: "High", color: "var(--red, #f87171)", pctAbove };
}

function SkeletonRows({ count = 4 }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "12px 16px", marginBottom: 8, display: "flex", alignItems: "center", gap: 14 }}>
      <div className="skeleton" style={{ width: 52, height: 52, borderRadius: 8, flexShrink: 0, animationDelay: `${i * 60}ms` }} />
      <div style={{ flex: 1 }}>
        <div className="skeleton" style={{ height: 10, borderRadius: 4, width: "60%", marginBottom: 6, animationDelay: `${i * 60}ms` }} />
        <div className="skeleton" style={{ height: 10, borderRadius: 4, width: "35%", animationDelay: `${i * 60 + 30}ms` }} />
      </div>
    </div>
  ));
}

// ═══ COMPONENT ═══

export default function MyListings({ wallet, onConnect, addToast, onPick, tokens, stats }) {
  const collection = useActiveCollection();
  const { isWrongNetwork } = useWalletState();
  const { switchChain } = useWalletActions();
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState(null);
  const [cancelling, setCancelling] = useState(null);
  const [cancellingAll, setCancellingAll] = useState(false);
  const intervalRef = useRef(null);
  const initialLoadRef = useRef(true);

  const floorPrice = stats?.floor || 0;

  // Token lookup map
  const tokenMap = useMemo(() => {
    const map = new Map();
    if (tokens) {
      for (const t of tokens) map.set(String(t.id), t);
    }
    return map;
  }, [tokens]);

  const resolveToken = useCallback((tokenId) => {
    if (!tokenId) return null;
    return tokenMap.get(String(tokenId)) || null;
  }, [tokenMap]);

  // ═══ FETCH LISTINGS (native orderbook) ═══
  const fetchListings = useCallback(async () => {
    if (!wallet) return;
    setLoading(true);
    setFetchError(null);
    try {
      const params = new URLSearchParams({
        action: "query",
        contract: collection.contract,
        maker: wallet,
        status: "active",
        limit: "200",
        sort: "created_at",
      });
      const res = await fetch(`/api/orderbook?${params}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Failed to fetch listings");
      }
      const data = await res.json();
      // Normalize native orderbook orders to the shape the UI expects
      const normalized = (data.orders || []).map((o) => {
        const endSec = o.end_time ? Math.floor(new Date(o.end_time).getTime() / 1000) : null;
        return {
          orderHash: o.order_hash,
          tokenId: o.token_id,
          price: o.price_eth || 0,
          expiry: endSec ? new Date(endSec * 1000) : null,
          protocolAddress: o.protocol_address || SEAPORT_ADDRESS,
          source: "native",
          // Keep the raw parameters + signature for on-chain cancel
          rawParameters: o.parameters,
          rawSignature: o.signature,
        };
      });
      setListings(normalized);
    } catch (err) {
      console.warn("Fetch my listings failed:", err.message);
      setFetchError("Failed to load listings. Check your connection.");
    } finally {
      setLoading(false);
      initialLoadRef.current = false;
    }
  }, [wallet, collection.contract]);

  // Clear data when collection changes
  useEffect(() => {
    setListings([]);
    setFetchError(null);
  }, [collection.contract]);

  // Fetch on mount and wallet/collection change
  useEffect(() => {
    fetchListings();
  }, [fetchListings]);

  // Auto-refresh
  useEffect(() => {
    if (!wallet) return;
    intervalRef.current = setInterval(() => {
      if (!wallet) return;
      fetchListings();
    }, REFRESH_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [wallet, fetchListings]);

  // ═══ CANCEL SINGLE LISTING (native orderbook) ═══
  // Two-step: 1) Cancel on-chain via Seaport, 2) Update backend status
  const handleCancel = useCallback(async (listing) => {
    if (isWrongNetwork) { addToast?.("Wrong network — please switch to Ethereum Mainnet", "error"); switchChain?.(); return; }
    const provider = getProvider();
    if (!provider) {
      addToast?.("Wallet not connected", "error");
      return;
    }

    setCancelling(listing.orderHash);
    addToast?.("Cancelling listing...", "info");

    try {
      const { ethers } = await import("ethers");
      const browserProvider = new ethers.BrowserProvider(provider);
      const signer = await browserProvider.getSigner();

      // Step 1: Cancel on-chain via Seaport contract (invalidates the signed order)
      if (!listing.rawParameters) {
        addToast?.("Cannot cancel: order parameters missing. Try refreshing.", "error");
        setCancelling(null);
        return;
      }
      const seaportABI = [
        "function cancel(tuple(address offerer, address zone, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems)[] orders) returns (bool)",
      ];
      const seaport = new ethers.Contract(SEAPORT_ADDRESS, seaportABI, signer);
      const tx = await seaport.cancel([listing.rawParameters]);
      await tx.wait();

      // Step 2: Update native orderbook backend status
      const cancelMessage = `Cancel order ${listing.orderHash}`;
      const cancelSignature = await signer.signMessage(cancelMessage);

      try {
        const res = await fetch("/api/orderbook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cancel",
            orderHash: listing.orderHash,
            signature: cancelSignature,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          console.warn("Backend cancel failed (on-chain cancel succeeded):", err.error);
        }
      } catch (backendErr) {
        // Non-critical: on-chain cancel already succeeded
        console.warn("Backend cancel request failed:", backendErr.message);
      }

      addToast?.("Listing cancelled successfully!", "success");
      setListings((prev) => prev.filter((l) => l.orderHash !== listing.orderHash));
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        addToast?.("Cancellation was declined in your wallet.", "info");
      } else {
        console.error("Cancel listing error:", err);
        addToast?.("Failed to cancel listing. Please try again.", "error");
      }
    } finally {
      setCancelling(null);
    }
  }, [addToast, isWrongNetwork, switchChain]);

  // ═══ CANCEL ALL (increment Seaport counter) ═══
  const handleCancelAll = useCallback(async () => {
    if (isWrongNetwork) { addToast?.("Wrong network — please switch to Ethereum Mainnet", "error"); switchChain?.(); return; }
    const provider = getProvider();
    if (!provider) {
      addToast?.("Wallet not connected", "error");
      return;
    }

    setCancellingAll(true);
    addToast?.("Cancelling all listings (incrementing Seaport counter)...", "info");

    try {
      const { ethers } = await import("ethers");
      const browserProvider = new ethers.BrowserProvider(provider);
      const signer = await browserProvider.getSigner();

      const seaportABI = ["function incrementCounter() returns (uint256)"];
      const seaport = new ethers.Contract(SEAPORT_ADDRESS, seaportABI, signer);

      const tx = await seaport.incrementCounter();
      await tx.wait();

      // Update backend: cancel each active listing so the DB stays in sync
      for (const listing of listings) {
        try {
          const cancelMessage = `Cancel order ${listing.orderHash}`;
          const cancelSignature = await signer.signMessage(cancelMessage);
          await fetch("/api/orderbook", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "cancel",
              orderHash: listing.orderHash,
              signature: cancelSignature,
            }),
          });
        } catch (backendErr) {
          // Non-critical: on-chain cancel already succeeded via counter increment
          console.warn("Backend cancel failed for", listing.orderHash, backendErr.message);
        }
      }

      addToast?.("All orders cancelled! Counter incremented.", "success");
      setListings([]);
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        addToast?.("Cancel all was declined in your wallet.", "info");
      } else {
        console.error("Cancel all error:", err);
        addToast?.("Failed to cancel all listings.", "error");
      }
    } finally {
      setCancellingAll(false);
    }
  }, [addToast, listings, isWrongNetwork, switchChain]);

  // ═══ COMPUTED ═══
  // Filter out expired listings on the client side (server filters on fetch, but
  // listings can expire between auto-refresh intervals)
  const activeListings = useMemo(() => {
    const now = Date.now();
    return listings.filter((l) => !l.expiry || new Date(l.expiry).getTime() > now);
  }, [listings]);

  const totalListedPrice = useMemo(() => {
    return activeListings.reduce((sum, l) => sum + (l.price || 0), 0);
  }, [activeListings]);
  const totalRevenue = useMemo(() => {
    return activeListings.reduce((sum, l) => sum + computeRevenue(l.price || 0), 0);
  }, [activeListings]);

  // ═══ NOT CONNECTED ═══
  if (!wallet) {
    return (
      <div style={styles.container}>
        <div className="wallet-connect-prompt">
          <div className="wallet-connect-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
            </svg>
          </div>
          <h3 className="wallet-connect-title">Connect Your Wallet</h3>
          <p className="wallet-connect-desc">
            Connect your wallet to view and manage your active {collection.name} listings.
          </p>
          <button className="btn-primary wallet-connect-btn" onClick={onConnect}>
            Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  // ═══ RENDER ═══
  return (
    <div style={styles.container}>
      <div style={styles.title}>My Listings</div>

      <div style={styles.refreshNote}>Auto-refreshes every 30s</div>

      {/* Wrong network warning */}
      {isWrongNetwork && (
        <div role="alert" style={{
          fontFamily: "var(--mono)", fontSize: 11, marginBottom: 12,
          padding: "10px 14px", borderRadius: 8,
          background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
          color: "var(--red, #f87171)", textAlign: "center", lineHeight: 1.5,
        }}>
          Wrong network detected. Cancel operations require Ethereum Mainnet.{" "}
          <button
            onClick={() => switchChain?.()}
            style={{
              background: "none", border: "none", cursor: "pointer",
              color: "var(--naka-blue)", textDecoration: "underline",
              fontFamily: "var(--mono)", fontSize: 11, padding: 0,
            }}
          >
            Switch Network
          </button>
        </div>
      )}

      {/* Summary Bar */}
      {activeListings.length > 0 && (
        <div style={styles.summaryBar}>
          <div style={styles.summaryItem}>
            <span style={styles.summaryLabel}>Active Listings</span>
            <span style={styles.summaryValue}>{activeListings.length}</span>
          </div>
          <div style={styles.summaryItem}>
            <span style={styles.summaryLabel}>Est. Revenue</span>
            <span style={styles.summaryValue}>
              <Eth size={12} /> {totalRevenue.toFixed(4)}
            </span>
          </div>
          {floorPrice > 0 && (
            <div style={styles.summaryItem}>
              <span style={styles.summaryLabel}>Floor Price</span>
              <span style={styles.summaryValue}>
                <Eth size={12} /> {floorPrice.toFixed(4)}
              </span>
            </div>
          )}
          <button
            style={styles.cancelAllBtn}
            disabled={cancellingAll}
            onClick={handleCancelAll}
            title="Increments your Seaport counter, invalidating ALL open orders (listings + bids)"
          >
            {cancellingAll ? "Cancelling..." : "Cancel All"}
          </button>
        </div>
      )}

      {fetchError && (
        <div className="error-banner" style={{ margin: "0 0 12px" }}>
          {fetchError}
        </div>
      )}

      {/* Listings */}
      {loading && initialLoadRef.current ? (
        <SkeletonRows count={4} />
      ) : activeListings.length === 0 ? (
        <EmptyState type="myListings" />
      ) : (
        activeListings.map((listing) => {
          const token = resolveToken(listing.tokenId);
          const name = token?.name || (listing.tokenId ? `${collection.name} #${listing.tokenId}` : "Listing");
          const image = token?.image || (listing.tokenId && collection.metadataBase ? `${collection.metadataBase}/${listing.tokenId}.png` : null)
            || (listing.tokenId ? alchemyCdnUrl(listing.tokenId, collection.contract) : null);
          const nftForImage = token || { id: listing.tokenId, image, name };
          const health = getHealthBadge(listing.price, floorPrice);
          const distFromFloor = floorPrice > 0 && listing.price
            ? (((listing.price - floorPrice) / floorPrice) * 100).toFixed(1)
            : null;

          return (
            <div key={listing.orderHash} style={styles.card}>
              {listing.tokenId && (
                <div
                  style={styles.nftThumb}
                  onClick={() => token && onPick?.(token)}
                >
                  <NftImage nft={nftForImage} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                </div>
              )}
              <div style={styles.cardInfo}>
                <div style={styles.cardName}>{name}</div>
                <div style={styles.cardMeta}>
                  <span>{timeLeft(listing.expiry)}</span>
                  <span>Native</span>
                  {distFromFloor !== null && (
                    <span>{distFromFloor > 0 ? `+${distFromFloor}%` : `${distFromFloor}%`} from floor</span>
                  )}
                  {health && (
                    <span style={styles.badge(health.color)}>{health.label}</span>
                  )}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={styles.price}>
                  <Eth size={12} /> {computeRevenue(listing.price || 0).toFixed(4)}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
                  Listed: {(listing.price || 0).toFixed(4)}
                </div>
              </div>
              <div style={styles.actions}>
                <button
                  style={styles.btnCancel}
                  disabled={cancelling === listing.orderHash}
                  onClick={() => handleCancel(listing)}
                >
                  {cancelling === listing.orderHash ? "..." : "Cancel"}
                </button>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
