import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchWalletNfts, shortenAddress } from "../api";
import { fetchMyListings, cancelOrder } from "../api-offers";
import { formatPrice } from "../lib/formatPrice";
import { exportCSV } from "../lib/csv";
import { Eth } from "./Icons";
import AnimatedCard from "./AnimatedCard";
import Skeleton from "./Skeleton";
import { useActiveCollection } from "../contexts/CollectionContext";
import BulkListingWizard from "./BulkListingWizard";
import BundleListing from "./BundleListing";

function timeLeft(expiry) {
  if (!expiry) return "";
  const diff = (expiry instanceof Date ? expiry : new Date(expiry)).getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const hours = Math.floor(diff / 3600000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d left`;
  if (hours > 0) return `${hours}h left`;
  return `${Math.floor(diff / 60000)}m left`;
}

export default function MyCollection({ wallet, onPick, onConnect, addToast, stats }) {
  const collection = useActiveCollection();
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [totalCount, setTotalCount] = useState(0);
  const [listings, setListings] = useState([]);
  const [loadingListings, setLoadingListings] = useState(false);
  const [cancelling, setCancelling] = useState(null);
  const [portfolioOpen, setPortfolioOpen] = useState(false);
  const [bulkListOpen, setBulkListOpen] = useState(false);
  const [bundleOpen, setBundleOpen] = useState(false);
  // Monotonic counter to discard stale retry responses after collection switch
  const retryGenRef = useRef(0);

  // Map of tokenId -> token (for O(1) lookup in listings render)
  const tokenMap = useMemo(() => {
    const map = new Map();
    for (const t of tokens) map.set(String(t.id), t);
    return map;
  }, [tokens]);

  // Map of tokenId -> listing
  const listingMap = useMemo(() => {
    const map = new Map();
    for (const l of listings) map.set(String(l.tokenId), l);
    return map;
  }, [listings]);

  // Portfolio stats derived from tokens + floor price
  const floorPrice = stats?.floor != null && isFinite(stats.floor) ? stats.floor : null;

  const portfolioStats = useMemo(() => {
    if (tokens.length === 0) return null;
    const avgRank = tokens.reduce((s, n) => s + (n.rank || 0), 0) / tokens.length;
    const rarest = tokens.reduce(
      (best, n) => (!best || (n.rank && n.rank < best.rank)) ? n : best,
      null,
    );
    return {
      portfolioValue: floorPrice != null ? floorPrice * tokens.length : null,
      avgRank: isFinite(avgRank) ? Math.round(avgRank) : null,
      rarest,
    };
  }, [tokens, floorPrice]);

  // CSV export
  const handleExport = useCallback(() => {
    if (!tokens.length) return;
    const rows = tokens.map((n) => ({
      Collection: collection.name,
      "Token ID": n.id,
      Name: n.name || `#${n.id}`,
      Rank: n.rank || "N/A",
      "Est. Value (ETH)": floorPrice != null ? floorPrice.toFixed(4) : "N/A",
      Traits: (n.attributes || []).map((a) => `${a.key}: ${a.value}`).join(", "),
    }));
    exportCSV(rows, `${collection.slug}-portfolio`);
    addToast?.("Portfolio exported as CSV", "success");
  }, [tokens, collection.name, collection.slug, floorPrice, addToast]);

  useEffect(() => {
    if (!wallet) return;
    let mounted = true;
    // Bump generation so any in-flight retry knows it's stale
    retryGenRef.current += 1;
    // Reset stale data from previous collection immediately
    setTokens([]);
    setTotalCount(0);
    setListings([]);
    setLoading(true);
    setError(null);

    fetchWalletNfts(wallet, collection.contract, collection.metadataBase).then((data) => {
      if (!mounted) return;
      setTokens(data.tokens);
      setTotalCount(data.totalCount);
      setLoading(false);
    }).catch((err) => {
      if (!mounted) return;
      console.warn("MyCollection fetch error:", err.message);
      setError("Failed to load your collection. Please try again.");
      setLoading(false);
    });

    // Fetch active listings for this wallet
    setLoadingListings(true);
    fetchMyListings(wallet, collection.contract).then((data) => {
      if (!mounted) return;
      setListings(data);
      setLoadingListings(false);
    }).catch(() => {
      if (!mounted) return;
      setLoadingListings(false);
    });

    return () => { mounted = false; };
  }, [wallet, collection.contract, collection.metadataBase]);

  const handleRetry = useCallback(() => {
    if (!wallet) return;
    // Capture current generation so we can discard results if collection switches mid-retry
    const gen = ++retryGenRef.current;
    // Clear stale data so the user sees skeleton loading during retry
    setError(null);
    setTokens([]);
    setTotalCount(0);
    setListings([]);
    setLoading(true);
    setLoadingListings(true);

    fetchWalletNfts(wallet, collection.contract, collection.metadataBase).then((data) => {
      if (retryGenRef.current !== gen) return; // stale -- collection switched
      setTokens(data.tokens);
      setTotalCount(data.totalCount);
      setLoading(false);
    }).catch(() => {
      if (retryGenRef.current !== gen) return;
      setError("Failed to load. Please try again.");
      setLoading(false);
    });

    fetchMyListings(wallet, collection.contract).then((data) => {
      if (retryGenRef.current !== gen) return;
      setListings(data);
      setLoadingListings(false);
    }).catch(() => {
      if (retryGenRef.current !== gen) return;
      setLoadingListings(false);
    });
  }, [wallet, collection.contract, collection.metadataBase]);

  const handleCancelListing = useCallback(async (listing) => {
    setCancelling(listing.orderHash);
    addToast?.("Cancelling listing...", "info");

    try {
      const result = await cancelOrder(listing);

      if (result.success) {
        addToast?.("Listing cancelled successfully!", "success");
        setListings((prev) => prev.filter((l) => l.orderHash !== listing.orderHash));
      } else if (result.error === "rejected") {
        addToast?.("Listing cancellation was declined in your wallet.", "info");
      } else {
        addToast?.("Failed to cancel listing. Please try again.", "error");
      }
    } catch (err) {
      console.error("Cancel listing error:", err);
      addToast?.("Failed to cancel listing. Please try again.", "error");
    } finally {
      setCancelling(null);
    }
  }, [addToast]);

  if (!wallet) {
    return (
      <section className="my-collection-section">
        <div className="wallet-connect-prompt">
          <div className="wallet-connect-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" /><path d="M3 5v14a2 2 0 0 0 2 2h16v-5" /><path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
            </svg>
          </div>
          <h3 className="wallet-connect-title">Connect Your Wallet</h3>
          <p className="wallet-connect-desc">
            Connect your wallet to view, manage, and track your {collection.name} portfolio.
          </p>
          <button className="btn-primary wallet-connect-btn" onClick={onConnect}>
            Connect Wallet
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="my-collection-section">
      <div className="my-collection-header">
        <div>
          <h2 style={{ fontFamily: "var(--serif)", fontSize: 28, fontWeight: 600, color: "var(--text)" }}>
            My NFTs
          </h2>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            {shortenAddress(wallet)} {"\u00b7"} {totalCount} {collection.name} owned
            {listings.length > 0 && (
              <span style={{ color: "var(--gold)", marginLeft: 8 }}>
                {"\u00b7"} {listings.length} listed
              </span>
            )}
          </div>
        </div>
        {tokens.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => setBulkListOpen(true)}
              style={{
                fontFamily: "var(--mono)", fontSize: 10, padding: "8px 16px",
                borderRadius: 8, border: "1px solid var(--naka-blue)",
                background: "rgba(111,168,220,0.1)", color: "var(--naka-blue)",
                cursor: "pointer", letterSpacing: "0.04em", fontWeight: 600,
              }}
            >
              Bulk List
            </button>
            <button
              onClick={() => setBundleOpen(true)}
              style={{
                fontFamily: "var(--mono)", fontSize: 10, padding: "8px 16px",
                borderRadius: 8, border: "1px solid var(--gold)",
                background: "rgba(200,170,100,0.1)", color: "var(--gold)",
                cursor: "pointer", letterSpacing: "0.04em", fontWeight: 600,
              }}
            >
              Bundle
            </button>
            <button
              onClick={handleExport}
              style={{
                fontFamily: "var(--mono)", fontSize: 10, padding: "8px 16px",
                borderRadius: 8, border: "1px solid var(--border)",
                background: "var(--surface-glass)", color: "var(--text-dim)",
                cursor: "pointer", letterSpacing: "0.04em",
              }}
            >
              Export CSV
            </button>
          </div>
        )}
      </div>

      {/* Stats Bar */}
      {!loading && tokens.length > 0 && (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10,
          margin: "0 32px 20px",
        }}>
          <div className="analytics-stat-card">
            <div className="analytics-stat-label">NFTs OWNED</div>
            <div className="analytics-stat-value" style={{ color: "var(--naka-blue)" }}>
              {totalCount}
            </div>
          </div>
          <div className="analytics-stat-card">
            <div className="analytics-stat-label">EST. PORTFOLIO VALUE</div>
            <div className="analytics-stat-value" style={{ color: "var(--gold)" }}>
              {portfolioStats?.portfolioValue != null ? (
                <><Eth size={14} /> {formatPrice(portfolioStats.portfolioValue)}</>
              ) : "\u2014"}
            </div>
          </div>
          <div className="analytics-stat-card">
            <div className="analytics-stat-label">FLOOR PRICE</div>
            <div className="analytics-stat-value" style={{ color: "var(--green)" }}>
              {floorPrice != null ? (
                <><Eth size={14} /> {formatPrice(floorPrice)}</>
              ) : "\u2014"}
            </div>
          </div>
          <div className="analytics-stat-card">
            <div className="analytics-stat-label">AVG RANK</div>
            <div className="analytics-stat-value" style={{ color: "var(--purple)" }}>
              {portfolioStats?.avgRank != null ? `#${portfolioStats.avgRank}` : "\u2014"}
            </div>
          </div>
        </div>
      )}

      {/* Active Listings Banner */}
      {listings.length > 0 && (
        <div style={{
          margin: "0 32px 16px", padding: "14px 18px",
          background: "rgba(212,168,67,0.06)", border: "1px solid rgba(212,168,67,0.15)",
          borderRadius: 10,
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--gold)", letterSpacing: "0.06em", marginBottom: 10 }}>
            ACTIVE LISTINGS
          </div>
          {listings.map((listing) => {
            const token = tokenMap.get(String(listing.tokenId));
            return (
              <div key={listing.orderHash} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "8px 0",
                borderBottom: "1px solid rgba(212,168,67,0.08)",
              }}>
                <div style={{ fontFamily: "var(--display)", fontSize: 13, color: "var(--text)", flex: 1 }}>
                  {token?.name || `#${listing.tokenId}`}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", display: "flex", alignItems: "center", gap: 3 }}>
                  <Eth size={10} /> {formatPrice(listing.price)}
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>
                  {timeLeft(listing.expiry)}
                </div>
                <button
                  onClick={() => handleCancelListing(listing)}
                  disabled={cancelling === listing.orderHash}
                  style={{
                    fontFamily: "var(--mono)", fontSize: 9, color: "var(--red)",
                    background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.15)",
                    borderRadius: 5, padding: "5px 12px", cursor: "pointer", whiteSpace: "nowrap",
                  }}
                >
                  {cancelling === listing.orderHash ? "..." : "Cancel"}
                </button>
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div className="error-banner" style={{ margin: "0 32px 16px" }}>
          <span>{error}</span>
          <button onClick={handleRetry}>Retry</button>
        </div>
      )}

      {loading ? (
        <div className="gallery-grid gallery" style={{ padding: "0 32px 40px" }}>
          <Skeleton count={8} view="gallery" />
        </div>
      ) : tokens.length === 0 ? (
        <div className="my-collection-empty" style={{ paddingTop: 40 }}>
          <div className="my-collection-empty-icon">0</div>
          <h3 style={{ fontFamily: "var(--display)", fontSize: 16, color: "var(--text-dim)", fontWeight: 500 }}>
            No {collection.name} Found
          </h3>
          <p style={{ fontFamily: "var(--display)", fontSize: 13, color: "var(--text-dim)", marginTop: 8 }}>
            This wallet doesn't hold any {collection.name} NFTs.
          </p>
          <a
            href={`https://opensea.io/collection/${collection.openseaSlug || collection.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="btn-secondary"
            style={{ marginTop: 16, padding: "10px 24px", display: "inline-block", textDecoration: "none" }}
          >
            Browse on OpenSea
          </a>
        </div>
      ) : (
        <>
          <div className="gallery-grid gallery" style={{ padding: "0 32px 24px" }}>
            {tokens.map((nft, i) => (
              <AnimatedCard
                key={nft.id}
                nft={nft}
                index={i}
                onPick={onPick}
                view="gallery"
                listingPrice={listingMap.get(String(nft.id))?.price}
              />
            ))}
          </div>

          {/* Portfolio Stats expandable section */}
          {portfolioStats && (
            <div style={{ margin: "0 32px 40px" }}>
              <button
                onClick={() => setPortfolioOpen((o) => !o)}
                style={{
                  width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "12px 16px", borderRadius: 10,
                  border: "1px solid var(--border)", background: "var(--surface-glass)",
                  cursor: "pointer", color: "var(--text)",
                }}
              >
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.06em" }}>
                  PORTFOLIO STATS
                </span>
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  strokeLinecap="round" strokeLinejoin="round"
                  style={{ transform: portfolioOpen ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
              {portfolioOpen && (
                <div style={{
                  padding: "16px", marginTop: -1,
                  border: "1px solid var(--border)", borderTop: "none",
                  borderRadius: "0 0 10px 10px", background: "var(--surface-glass)",
                }}>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12 }}>
                    {portfolioStats.rarest?.rank && (
                      <div className="analytics-stat-card">
                        <div className="analytics-stat-label">RAREST HELD</div>
                        <div className="analytics-stat-value" style={{ color: "var(--yellow)" }}>
                          #{portfolioStats.rarest.rank}
                        </div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
                          {portfolioStats.rarest.name || `#${portfolioStats.rarest.id}`}
                        </div>
                      </div>
                    )}
                    <div className="analytics-stat-card">
                      <div className="analytics-stat-label">AVG RANK</div>
                      <div className="analytics-stat-value" style={{ color: "var(--purple)" }}>
                        {portfolioStats.avgRank != null ? `#${portfolioStats.avgRank}` : "\u2014"}
                      </div>
                    </div>
                    <div className="analytics-stat-card">
                      <div className="analytics-stat-label">TOTAL HELD</div>
                      <div className="analytics-stat-value" style={{ color: "var(--naka-blue)" }}>
                        {totalCount}
                      </div>
                    </div>
                  </div>
                  <div style={{ marginTop: 16, display: "flex", justifyContent: "flex-end" }}>
                    <button
                      onClick={handleExport}
                      style={{
                        fontFamily: "var(--mono)", fontSize: 10, padding: "8px 20px",
                        borderRadius: 8, border: "1px solid var(--border)",
                        background: "var(--surface-glass)", color: "var(--text-dim)",
                        cursor: "pointer", letterSpacing: "0.04em",
                      }}
                    >
                      Export CSV
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {bundleOpen && (
        <BundleListing
          tokens={tokens}
          wallet={wallet}
          collection={collection}
          onClose={() => setBundleOpen(false)}
          onListingCreated={() => {
            fetchMyListings(wallet, collection.contract).then(setListings).catch(() => {});
          }}
          stats={stats}
        />
      )}

      {bulkListOpen && (
        <BulkListingWizard
          tokens={tokens}
          wallet={wallet}
          onClose={() => setBulkListOpen(false)}
          onListingCreated={() => {
            // Refresh listings after new listings are created
            fetchMyListings(wallet, collection.contract).then(setListings).catch(() => {});
          }}
          addToast={addToast}
          onConnect={onConnect}
          stats={stats}
          listingMap={listingMap}
        />
      )}
    </section>
  );
}
