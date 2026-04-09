import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { fetchWalletNfts, shortenAddress, getProvider } from "../api";
import { fetchTokenOffers, acceptOffer } from "../api-offers";
import { SEAPORT_ADDRESS } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";
import { openseaGet } from "../lib/proxy";
import EmptyState from "./EmptyState";

const TABS = ["My Bids", "Received Offers", "Bid History"];

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
  tabBar: {
    display: "flex",
    gap: 0,
    marginBottom: 20,
    borderBottom: "1px solid var(--border)",
  },
  tab: (active) => ({
    fontFamily: "var(--mono)",
    fontSize: 11,
    letterSpacing: "0.06em",
    padding: "10px 18px",
    cursor: "pointer",
    color: active ? "var(--gold)" : "var(--text-dim)",
    borderBottom: active ? "2px solid var(--gold)" : "2px solid transparent",
    background: "none",
    border: "none",
    borderBottomWidth: 2,
    borderBottomStyle: "solid",
    borderBottomColor: active ? "var(--gold)" : "transparent",
    transition: "color 0.2s, border-color 0.2s",
  }),
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
  btnAccept: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    color: "var(--green, #4ade80)",
    background: "rgba(74,222,128,0.06)",
    border: "1px solid rgba(74,222,128,0.12)",
    borderRadius: 5,
    padding: "5px 12px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  btnCounter: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    color: "var(--naka-blue, #6fa8dc)",
    background: "rgba(111,168,220,0.06)",
    border: "1px solid rgba(111,168,220,0.12)",
    borderRadius: 5,
    padding: "5px 12px",
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  btnConnect: {
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--naka-blue, #6fa8dc)",
    background: "rgba(111,168,220,0.08)",
    border: "1px solid rgba(111,168,220,0.18)",
    borderRadius: 8,
    padding: "10px 22px",
    cursor: "pointer",
    marginTop: 8,
  },
  empty: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text-muted)",
    textAlign: "center",
    padding: "40px 16px",
  },
  status: (color) => ({
    fontFamily: "var(--mono)",
    fontSize: 9,
    letterSpacing: "0.04em",
    color,
    textTransform: "uppercase",
  }),
  actions: {
    display: "flex",
    gap: 6,
    flexShrink: 0,
  },
  // skeleton styles moved to SkeletonRows using shared .skeleton CSS class
  refreshNote: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    color: "var(--text-muted)",
    textAlign: "right",
    marginBottom: 8,
  },
};

// Alchemy CDN fallback for collections without IPFS metadataBase
const alchemyCdnUrl = (tokenId, contract) =>
  `https://nft-cdn.alchemy.com/eth-mainnet/${contract}/${tokenId}`;

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

function bidStatus(order) {
  if (order.cancelled) return { label: "Cancelled", color: "var(--red)" };
  if (order.finalized) return { label: "Fulfilled", color: "var(--green, #4ade80)" };
  if (order.expiry && order.expiry.getTime() <= Date.now()) return { label: "Expired", color: "var(--text-dim)" };
  return { label: "Active", color: "var(--gold)" };
}

function safePrice(wei) {
  try {
    if (!wei || wei === "0") return 0;
    return Number(BigInt(wei) / BigInt(1e14)) / 1e4;
  } catch {
    return 0;
  }
}

function normalizeOrder(order) {
  const params = order.protocol_data?.parameters;
  const offer = params?.offer?.[0];
  const priceWei = offer?.startAmount || "0";
  // In a Seaport bid the NFT is in consideration — find the ERC721/ERC1155 item (itemType >= 2)
  const nftItem = (params?.consideration || []).find(c => Number(c.itemType) >= 2);
  const tokenId = nftItem?.identifierOrCriteria ? String(nftItem.identifierOrCriteria) : null;
  return {
    orderHash: order.order_hash,
    price: safePrice(priceWei),
    priceWei,
    maker: params?.offerer,
    tokenId,
    tokenContract: nftItem?.token || null,
    expiry: params?.endTime ? new Date(parseInt(params.endTime) * 1000) : null,
    protocolAddress: order.protocol_address,
    cancelled: order.cancelled,
    finalized: order.finalized,
    createdDate: order.created_date,
    rawOrder: order,
  };
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

// ═══ CANCEL BID (Seaport cancelOrders) ═══

async function cancelBid(order) {
  const provider = getProvider();
  if (!provider) return { error: "no-wallet" };

  try {
    const { ethers } = await import("ethers");
    const browserProvider = new ethers.BrowserProvider(provider);
    const signer = await browserProvider.getSigner();

    const seaportABI = [
      "function cancel(tuple(address offerer, address zone, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount)[] offer, tuple(uint8 itemType, address token, uint256 identifierOrCriteria, uint256 startAmount, uint256 endAmount, address recipient)[] consideration, uint8 orderType, uint256 startTime, uint256 endTime, bytes32 zoneHash, uint256 salt, bytes32 conduitKey, uint256 totalOriginalConsiderationItems)[] orders) returns (bool)",
    ];
    const seaport = new ethers.Contract(SEAPORT_ADDRESS, seaportABI, signer);

    const params = order.rawOrder?.protocol_data?.parameters || order.protocol_data?.parameters;
    if (!params) return { error: "failed", message: "Missing order parameters" };

    const tx = await seaport.cancel([params]);
    await tx.wait();
    return { success: true, hash: tx.hash };
  } catch (err) {
    if (err.code === 4001 || err.code === "ACTION_REJECTED") {
      return { error: "rejected", message: "Transaction cancelled" };
    }
    console.error("Cancel bid error:", err);
    return { error: "failed", message: "Failed to cancel bid" };
  }
}

// ═══ COMPONENT ═══

export default function BidManager({ wallet, onConnect, addToast, onPick, tokens }) {
  const collection = useActiveCollection();
  const [tab, setTab] = useState(0);
  const [myBids, setMyBids] = useState([]);
  const [receivedOffers, setReceivedOffers] = useState([]);
  const [bidHistory, setBidHistory] = useState([]);
  const [loadingBids, setLoadingBids] = useState(false);
  const [loadingReceived, setLoadingReceived] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [accepting, setAccepting] = useState(null);
  const [fetchError, setFetchError] = useState(null);
  const intervalRef = useRef(null);

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

  // ═══ FETCH MY BIDS ═══
  const fetchMyBids = useCallback(async () => {
    if (!wallet) return;
    setLoadingBids(true);
    try {
      const data = await openseaGet("orders/ethereum/seaport/offers", {
        maker: wallet,
        asset_contract_address: collection.contract,
        order_by: "created_date",
        order_direction: "desc",
      });
      const orders = (data.orders || []).map(normalizeOrder);
      // Only active (not cancelled, not finalized, not expired)
      const now = Date.now();
      setMyBids(orders.filter(o => !o.cancelled && !o.finalized && o.expiry && o.expiry.getTime() > now));
    } catch (err) {
      console.warn("Fetch my bids failed:", err.message);
      setFetchError("Failed to load bids. Check your connection.");
    } finally {
      setLoadingBids(false);
    }
  }, [wallet, collection.contract]);

  // ═══ FETCH RECEIVED OFFERS ═══
  const fetchReceivedOffers = useCallback(async () => {
    if (!wallet) return;
    setLoadingReceived(true);
    try {
      const { tokens: ownedNfts } = await fetchWalletNfts(wallet, collection.contract, collection.metadataBase);
      if (!ownedNfts || ownedNfts.length === 0) {
        setReceivedOffers([]);
        setLoadingReceived(false);
        return;
      }

      // Fetch offers for each owned token (batch first 20 to avoid rate limits)
      const batch = ownedNfts.slice(0, 20);
      const results = await Promise.all(
        batch.map(async (nft) => {
          const offers = await fetchTokenOffers(nft.id, collection.contract);
          return offers.map((o) => ({ ...o, tokenId: nft.id, tokenName: nft.name, tokenImage: nft.image }));
        }),
      );

      setReceivedOffers(results.flat());
    } catch (err) {
      console.warn("Fetch received offers failed:", err.message);
      setFetchError("Failed to load offers. Check your connection.");
    } finally {
      setLoadingReceived(false);
    }
  }, [wallet, collection.contract]);

  // ═══ FETCH BID HISTORY ═══
  const fetchBidHistory = useCallback(async () => {
    if (!wallet) return;
    setLoadingHistory(true);
    try {
      const data = await openseaGet("orders/ethereum/seaport/offers", {
        maker: wallet,
        asset_contract_address: collection.contract,
        order_by: "created_date",
        order_direction: "desc",
      });
      const orders = (data.orders || []).map(normalizeOrder);
      // History = cancelled, expired, or fulfilled
      const now = Date.now();
      setBidHistory(orders.filter(o => o.cancelled || o.finalized || (o.expiry && o.expiry.getTime() <= now)));
    } catch (err) {
      console.warn("Fetch bid history failed:", err.message);
      setFetchError("Failed to load bid history. Check your connection.");
    } finally {
      setLoadingHistory(false);
    }
  }, [wallet, collection.contract]);

  // Clear data when collection changes to avoid stale cross-collection display
  useEffect(() => {
    setMyBids([]);
    setReceivedOffers([]);
    setBidHistory([]);
    setFetchError(null);
  }, [collection.contract]);

  // ═══ DATA FETCHING ═══
  const fetchCurrentTab = useCallback(() => {
    setFetchError(null);
    if (tab === 0) fetchMyBids();
    else if (tab === 1) fetchReceivedOffers();
    else if (tab === 2) fetchBidHistory();
  }, [tab, fetchMyBids, fetchReceivedOffers, fetchBidHistory]);

  useEffect(() => {
    fetchCurrentTab();
  }, [fetchCurrentTab]);

  // Auto-refresh
  useEffect(() => {
    if (!wallet) return;
    intervalRef.current = setInterval(fetchCurrentTab, REFRESH_INTERVAL);
    return () => clearInterval(intervalRef.current);
  }, [wallet, fetchCurrentTab]);

  // ═══ ACTIONS ═══
  const handleCancel = useCallback(async (bid) => {
    setCancelling(bid.orderHash);
    addToast?.("Cancelling bid...", "info");

    const result = await cancelBid(bid);

    if (result.success) {
      addToast?.("Bid cancelled successfully!", "success");
      setMyBids((prev) => prev.filter((b) => b.orderHash !== bid.orderHash));
    } else if (result.error === "rejected") {
      addToast?.("Bid cancellation was declined in your wallet.", "info");
    } else {
      addToast?.("Failed to cancel bid. Please try again.", "error");
    }
    setCancelling(null);
  }, [addToast]);

  const handleAccept = useCallback(async (offer) => {
    if (!wallet) return;
    setAccepting(offer.orderHash);
    addToast?.("Accepting offer...", "info");

    const result = await acceptOffer(offer);

    if (result.success) {
      addToast?.("Offer accepted successfully!", "success");
      setReceivedOffers((prev) => prev.filter((o) => o.orderHash !== offer.orderHash));
    } else if (result.error === "rejected") {
      addToast?.("Offer acceptance was declined in your wallet.", "info");
    } else {
      addToast?.("Failed to accept offer. Please try again.", "error");
    }
    setAccepting(null);
  }, [wallet, addToast]);

  const handleCounter = useCallback((offer) => {
    // Open make offer modal for this token
    const token = resolveToken(offer.tokenId);
    if (token && onPick) onPick(token);
  }, [resolveToken, onPick]);

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
            Connect your wallet to manage bids, view received offers, and track your {collection.name} bid history.
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
      <div style={styles.title}>Bid Manager</div>

      <div style={styles.refreshNote}>Auto-refreshes every 30s</div>

      {/* Tab bar */}
      <div style={styles.tabBar}>
        {TABS.map((label, i) => (
          <button key={label} style={styles.tab(tab === i)} onClick={() => setTab(i)}>
            {label}
          </button>
        ))}
      </div>

      {fetchError && (
        <div className="error-banner" style={{ margin: "0 0 12px" }}>
          {fetchError}
        </div>
      )}

      {/* ═══ MY BIDS TAB ═══ */}
      {tab === 0 && (
        <div>
          {loadingBids ? (
            <SkeletonRows count={4} />
          ) : myBids.length === 0 ? (
            <EmptyState type="bids" />
          ) : (
            myBids.map((bid) => {
              const token = resolveToken(bid.tokenId);
              const name = token?.name || (bid.tokenId ? `${collection.name} #${bid.tokenId}` : "Collection Offer");
              const image = token?.image || (bid.tokenId && collection.metadataBase ? `${collection.metadataBase}/${bid.tokenId}.png` : null)
                || (bid.tokenId ? alchemyCdnUrl(bid.tokenId, collection.contract) : null);
              const nftForImage = token || { id: bid.tokenId, image, name };

              return (
                <div key={bid.orderHash} style={styles.card}>
                  {bid.tokenId && (
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
                      <span>{timeLeft(bid.expiry)}</span>
                      <span style={styles.status("var(--gold)")}>Active</span>
                    </div>
                  </div>
                  <div style={styles.price}>
                    <Eth size={12} /> {(bid.price || 0).toFixed(4)}
                  </div>
                  <div style={styles.actions}>
                    <button
                      style={styles.btnCancel}
                      disabled={cancelling === bid.orderHash}
                      onClick={() => handleCancel(bid)}
                    >
                      {cancelling === bid.orderHash ? "..." : "Cancel"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ═══ RECEIVED OFFERS TAB ═══ */}
      {tab === 1 && (
        <div>
          {loadingReceived ? (
            <SkeletonRows count={4} />
          ) : receivedOffers.length === 0 ? (
            <EmptyState type="bidsReceived" />
          ) : (
            receivedOffers.map((offer, i) => {
              const token = resolveToken(offer.tokenId);
              const name = offer.tokenName || token?.name || `${collection.name} #${offer.tokenId}`;
              const image = offer.tokenImage || token?.image || (offer.tokenId && collection.metadataBase ? `${collection.metadataBase}/${offer.tokenId}.png` : null)
                || (offer.tokenId ? alchemyCdnUrl(offer.tokenId, collection.contract) : null);
              const nftForImage = token || { id: offer.tokenId, image, name };

              return (
                <div key={offer.orderHash || i} style={styles.card}>
                  {offer.tokenId && (
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
                      <span>From: {shortenAddress(offer.maker)}</span>
                      {offer.expiry && <span>{timeLeft(offer.expiry)}</span>}
                    </div>
                  </div>
                  <div style={styles.price}>
                    <Eth size={12} /> {(offer.price || 0).toFixed(4)}
                  </div>
                  <div style={styles.actions}>
                    <button
                      style={styles.btnAccept}
                      disabled={accepting === offer.orderHash}
                      onClick={() => handleAccept(offer)}
                    >
                      {accepting === offer.orderHash ? "..." : "Accept"}
                    </button>
                    <button
                      style={styles.btnCounter}
                      onClick={() => handleCounter(offer)}
                    >
                      Counter
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ═══ BID HISTORY TAB ═══ */}
      {tab === 2 && (
        <div>
          {loadingHistory ? (
            <SkeletonRows count={4} />
          ) : bidHistory.length === 0 ? (
            <EmptyState type="history" />
          ) : (
            bidHistory.map((bid) => {
              const token = resolveToken(bid.tokenId);
              const name = token?.name || (bid.tokenId ? `${collection.name} #${bid.tokenId}` : "Collection Offer");
              const image = token?.image || (bid.tokenId && collection.metadataBase ? `${collection.metadataBase}/${bid.tokenId}.png` : null)
                || (bid.tokenId ? alchemyCdnUrl(bid.tokenId, collection.contract) : null);
              const nftForImage = token || { id: bid.tokenId, image, name };
              const status = bidStatus(bid);

              return (
                <div key={bid.orderHash} style={{ ...styles.card, opacity: 0.7 }}>
                  {bid.tokenId && (
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
                      {bid.createdDate && (
                        <span>{new Date(bid.createdDate).toLocaleDateString()}</span>
                      )}
                      <span style={styles.status(status.color)}>{status.label}</span>
                    </div>
                  </div>
                  <div style={styles.price}>
                    <Eth size={12} /> {(bid.price || 0).toFixed(4)}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
