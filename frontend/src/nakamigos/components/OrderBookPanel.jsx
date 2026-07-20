import { useMemo, useState, useEffect, useCallback } from "react";
import { Eth } from "./Icons";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useWalletState, useWalletActions } from "../contexts/WalletContext";
import { fetchNativeListings, fetchNativeBundles, fulfillNativeOrder } from "../lib/orderbook";
import { recordTransaction } from "../lib/transactions";
import { PLATFORM_FEE_BPS, SEAPORT_ADDRESS, BUNDLE_LISTING_ENABLED } from "../constants";
import { getProvider } from "../api";
import { cancelSeaportOrder } from "../lib/seaportCancel";
import { getFriendlyError } from "../lib/errorMessages";
import NativeListingsList from "./NativeListingsList";

// ═══ ORDER BOOK PANEL ═══
// Two sections:
//   1. Native Listings Table — browse & buy from our 1% fee orderbook
//   2. Depth Chart — bid/ask spread visualization (existing)

// Both marketplaces charge ~1% now (OpenSea has charged ~1% since Sep 2025), so
// this is fee PARITY, not a discount — don't market a savings %. The native edge
// is that fees fund the Tegridy treasury and fills have no marketplace dependency.
const NATIVE_FEE_PCT = PLATFORM_FEE_BPS / 100; // 1%

// ── Native Listings Table ──
function NativeListingsTable({ wallet, onConnect, addToast, floorPrice }) {
  const collection = useActiveCollection();
  const { isWrongNetwork } = useWalletState();
  const { switchChain } = useWalletActions();
  const [orders, setOrders] = useState([]);
  const [bundles, setBundles] = useState([]); // gated: package listings (is_bundle rows)
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [buying, setBuying] = useState(null); // order_hash being purchased
  const [cancelling, setCancelling] = useState(null); // order_hash being cancelled
  // Mobile breakpoint (#8): render the listings as stacked cards instead of a
  // horizontally-scrolling 6-col table below 640px (mirrors DirectMessages).
  const [isNarrow, setIsNarrow] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 640px)").matches
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = (e) => setIsNarrow(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const handleCancel = useCallback(async (order) => {
    // R-CHAINID: mirror MyListings.jsx wrong-network short-circuit so a Seaport
    // cancel never lands on the wrong chain.
    if (isWrongNetwork) { addToast?.("Wrong network — please switch to Ethereum Mainnet", "error"); switchChain?.(); return; }
    const provider = getProvider();
    if (!provider) {
      addToast?.("Wallet not connected", "error");
      return;
    }
    setCancelling(order.order_hash);
    addToast?.("Cancelling listing...", "info");
    try {
      const { ethers } = await import("ethers");
      const browserProvider = new ethers.BrowserProvider(provider);
      const signer = await browserProvider.getSigner();

      // On-chain cancel via Seaport if parameters available.
      // F630: shared helper reads the live counter + rebuilds OrderComponents so
      // the cancel targets the real order hash (not a phantom that stays fillable).
      if (order.parameters) {
        const tx = await cancelSeaportOrder({
          ethers, signer,
          params: order.parameters,
          seaportAddress: order.protocol_address || SEAPORT_ADDRESS,
        });
        await tx.wait();
      }

      // Update backend
      // AUDIT FIX D-FE-M2: chainId + 5-minute timestamp binding to defeat
      // captured-signature replay (see api/orderbook.js cancel handler).
      // The on-chain cancel has ALREADY succeeded by this point; everything below
      // is a best-effort backend notification. signMessage used to sit OUTSIDE this
      // try, so a user rejecting the *notify* signature threw to the outer catch and
      // was reported as "Cancellation declined in wallet" — while the order was in
      // fact cancelled on-chain — leaving the row rendered as still active.
      try {
        const _cancelTs = Math.floor(Date.now() / 1000);
        const _cancelChainId = 1;
        const cancelMessage = `Cancel order ${order.order_hash} | Chain: ${_cancelChainId} | Time: ${_cancelTs}`;
        const cancelSignature = await signer.signMessage(cancelMessage);
        await fetch("/api/orderbook", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "cancel",
            orderHash: order.order_hash,
            signature: cancelSignature,
            chainId: _cancelChainId,
            timestamp: _cancelTs,
          }),
        });
      } catch {
        console.warn("Backend cancel notify failed (on-chain cancel succeeded)");
      }

      addToast?.("Listing cancelled!", "success");
      // Prune BOTH lists: bundles live in their own state, so cancelling a bundle
      // used to leave it on screen with a live Cancel button until the 60s poll —
      // inviting a second, redundant on-chain cancel the seller pays gas for.
      setOrders((prev) => prev.filter((o) => o.order_hash !== order.order_hash));
      setBundles((prev) => prev.filter((o) => o.order_hash !== order.order_hash));
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        addToast?.("Cancellation declined in wallet.", "info");
      } else {
        console.error("Cancel error:", err);
        addToast?.("Failed to cancel listing.", "error");
      }
    } finally {
      setCancelling(null);
    }
  }, [addToast, isWrongNetwork, switchChain]);

  const fetchOrders = useCallback(() => {
    if (!collection?.contract) return;
    setLoading(true);
    setError(null);
    fetchNativeListings(collection.contract).then(result => {
      if (result.error) {
        setError(result.error);
        setOrders([]);
      } else {
        setOrders(result.orders || []);
      }
      setLoading(false);
    });
    // Bundles (gated): a separate fetch so a bundle fetch failure never blocks the main
    // per-token listings. Returns [] while the feature is off.
    if (BUNDLE_LISTING_ENABLED) {
      fetchNativeBundles(collection.contract).then((r) => setBundles(r?.error ? [] : (r?.orders || [])));
    }
  }, [collection?.contract]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  useEffect(() => {
    // Sub (was #14): don't poll the orderbook while the tab is backgrounded —
    // saves the Vercel function budget + mobile battery/data (a backgrounded
    // Floor tab was firing a fetch every minute for nothing). Refetch once on
    // return to foreground so the user sees fresh data on re-focus.
    const t = setInterval(() => { if (!document.hidden) fetchOrders(); }, 60000);
    const onVis = () => { if (!document.hidden) fetchOrders(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", onVis); };
  }, [fetchOrders]);

  const handleBuy = useCallback(async (order) => {
    if (!wallet) {
      onConnect?.();
      return;
    }
    if (isWrongNetwork) { addToast?.("Wrong network — please switch to Ethereum Mainnet", "error"); switchChain?.(); return; }
    // A bundle has no single token_id — label it by its item count for toasts/history.
    const label = order.is_bundle ? `bundle (${order.token_ids?.length || 0} NFTs)` : `#${order.token_id}`;
    setBuying(order.order_hash);
    addToast?.(`Purchasing ${label} for ${order.price_eth} ETH via native orderbook...`, "info");

    const result = await fulfillNativeOrder(order);

    if (result.success) {
      recordTransaction({
        type: "buy",
        nft: { id: order.token_id || order.order_hash, name: `${collection.name} ${label}` },
        price: parseFloat(order.price_eth),
        hash: result.hash,
        wallet,
        slug: collection.slug,
      });
      addToast?.(`Purchased ${label} for ${order.price_eth} ETH! Tx: ${result.hash.slice(0, 10)}...`, "success");
      // Refresh listings after successful purchase
      fetchOrders();
    } else if (result.error === "rejected") {
      addToast?.("Transaction cancelled", "info");
    } else if (result.error === "insufficient") {
      addToast?.("Insufficient ETH balance", "error");
    } else if (result.error === "expired") {
      addToast?.("This listing has expired. Refreshing...", "error");
      fetchOrders();
    } else {
      // #19: plain-language mapping (a stale order reverts with "missing revert
      // data") instead of dumping raw ethers/Seaport text at the buyer.
      addToast?.(getFriendlyError(result.message || result.error || "Transaction failed"), "error");
    }
    setBuying(null);
  }, [wallet, onConnect, addToast, fetchOrders, collection, isWrongNetwork, switchChain]);

  // Filter out expired orders between refresh intervals
  const activeOrders = useMemo(() => {
    const now = Date.now();
    return orders.filter((o) => {
      if (!o.end_time) return true;
      return new Date(o.end_time).getTime() > now;
    });
  }, [orders]);

  const activeBundles = useMemo(() => {
    const now = Date.now();
    return bundles.filter((o) => !o.end_time || new Date(o.end_time).getTime() > now);
  }, [bundles]);

  return (
    <div style={{
      background: "rgba(111,168,220,0.02)",
      border: "1px solid rgba(111,168,220,0.08)",
      borderRadius: 12,
      padding: 20,
      marginBottom: 24,
    }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 10, color: "var(--naka-blue)", letterSpacing: "0.1em" }}>
            NATIVE LISTINGS
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            Direct Seaport orders &middot; {NATIVE_FEE_PCT}% fee
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {/* Flat-fee badge — parity with OpenSea, no creator royalty on native fills */}
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10,
            background: "rgba(76,175,80,0.1)", border: "1px solid rgba(76,175,80,0.2)",
            borderRadius: 8, padding: "5px 10px",
            color: "var(--green)",
          }}>
            Flat {NATIVE_FEE_PCT}% &middot; fees fund the treasury
          </div>
          <button
            onClick={fetchOrders}
            style={{
              background: "transparent", border: "1px solid var(--border)",
              borderRadius: 6, padding: "5px 10px", cursor: "pointer",
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Fee comparison bar */}
      <div style={{
        display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16,
        fontFamily: "var(--mono)", fontSize: 10,
      }}>
        <div style={{
          background: "rgba(76,175,80,0.06)", border: "1px solid rgba(76,175,80,0.15)",
          borderRadius: 8, padding: "8px 12px", textAlign: "center",
        }}>
          <div style={{ color: "var(--green)", fontWeight: 600 }}>Platform fee: {NATIVE_FEE_PCT}%</div>
          <div style={{ color: "var(--text-muted)", fontSize: 9, marginTop: 2 }}>Funds the Tegridy treasury</div>
        </div>
        <div style={{
          background: "rgba(111,168,220,0.06)", border: "1px solid rgba(111,168,220,0.15)",
          borderRadius: 8, padding: "8px 12px", textAlign: "center",
        }}>
          <div style={{ color: "var(--naka-blue)" }}>Creator royalty: 0%</div>
          <div style={{ color: "var(--text-muted)", fontSize: 9, marginTop: 2 }}>Not collected on native fills</div>
        </div>
      </div>

      {/* Loading / Error / Empty states */}
      {loading && (
        <div style={{ textAlign: "center", padding: "20px 0", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
          <span className="pulse-dot" style={{ marginRight: 8 }} />
          Fetching native listings...
        </div>
      )}
      {!loading && error && (
        <div style={{
          textAlign: "center", padding: "16px 0",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)",
        }}>
          {error === "Orderbook database not configured"
            ? "Native orderbook not yet configured for this deployment."
            : "Native listings are temporarily unavailable — try again shortly."}
        </div>
      )}
      {/* Bundles must count here too. "Zero singles plus one live bundle" is precisely
          the go-live state, and without this the panel says "No native listings" directly
          above a rendered, buyable bundle. */}
      {!loading && !error && activeOrders.length === 0 && activeBundles.length === 0 && (
        <div style={{
          textAlign: "center", padding: "20px 0",
          fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)",
        }}>
          No native listings for {collection.name} right now. Create one from the token detail panel.
        </div>
      )}

      {/* Listings — 6-col table on desktop, stacked cards on phones (#8) */}
      {!loading && !error && activeOrders.length > 0 && (
        <NativeListingsList
          orders={activeOrders}
          wallet={wallet}
          isNarrow={isNarrow}
          buying={buying}
          cancelling={cancelling}
          onBuy={handleBuy}
          onCancel={handleCancel}
          floorPrice={floorPrice}
        />
      )}

      {/* Bundles (gated by BUNDLE_LISTING_ENABLED) — package listings, bought atomically
          in one Seaport tx. Reuses the same list + buy/cancel handlers; NativeListingsList
          renders bundle rows with a "Bundle · N NFTs" label. Renders nothing while off. */}
      {BUNDLE_LISTING_ENABLED && !loading && !error && activeBundles.length > 0 && (
        <div style={{ marginTop: 18, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 10, color: "var(--gold)", letterSpacing: "0.1em", marginBottom: 8 }}>
            BUNDLES · buy every NFT in one transaction
          </div>
          <NativeListingsList
            orders={activeBundles}
            wallet={wallet}
            isNarrow={isNarrow}
            buying={buying}
            cancelling={cancelling}
            onBuy={handleBuy}
            onCancel={handleCancel}
          />
        </div>
      )}
    </div>
  );
}

// ── Depth Chart (existing visualization) ──

function bucketize(values, bucketCount = 10) {
  if (!values.length) return [];
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return [{ price: min, count: values.length, cumulative: values.length }];
  const step = (max - min) / bucketCount;
  const buckets = [];
  for (let i = 0; i < bucketCount; i++) {
    const lo = min + i * step;
    const hi = lo + step;
    const count = values.filter(v => v >= lo && (i === bucketCount - 1 ? v <= hi : v < hi)).length;
    buckets.push({ price: lo + step / 2, lo, hi, count });
  }
  return buckets;
}

function DepthChart({ listings = [], collectionOffers = [] }) {
  const { bidBuckets, askBuckets, spread, spreadPct, maxCumulative } = useMemo(() => {
    const askPrices = listings.map(l => l.price).filter(p => p != null && p > 0).sort((a, b) => a - b);
    const lowestAsk = askPrices[0] || 0;
    // #12: a collection bid priced well above the floor ask is garbage/stale — a
    // collection offer applies to ANY token, so a bid at/above the floor would
    // fill instantly. One 4.38 ETH outlier on a 0.10 floor was producing a
    // "best bid" above the best ask and a nonsensical -4057% spread. Drop bids
    // beyond 2x the floor before computing the book.
    const bidPrices = collectionOffers.map(o => o.price)
      .filter(p => p != null && p > 0 && (lowestAsk <= 0 || p <= lowestAsk * 2))
      .sort((a, b) => b - a);

    const askBuckets = bucketize(askPrices, 8);
    const bidBuckets = bucketize(bidPrices, 8).reverse();

    let cumAsk = 0;
    for (const b of askBuckets) { cumAsk += b.count; b.cumulative = cumAsk; }
    let cumBid = 0;
    for (const b of bidBuckets) { cumBid += b.count; b.cumulative = cumBid; }

    const bestBid = bidPrices[0] || 0;
    const bestAsk = askPrices[0] || 0;
    const spread = bestAsk && bestBid ? bestAsk - bestBid : 0;
    const spreadPct = bestAsk && bestBid ? ((spread / bestAsk) * 100).toFixed(1) : null;
    const maxCumulative = Math.max(...askBuckets.map(b => b.cumulative), ...bidBuckets.map(b => b.cumulative), 1);

    return { bidBuckets, askBuckets, spread, spreadPct, maxCumulative };
  }, [listings, collectionOffers]);

  const hasBids = bidBuckets.some(b => b.count > 0);
  const hasAsks = askBuckets.some(b => b.count > 0);

  if (!hasBids && !hasAsks) return null;

  const askPricesValid = listings.map(l => l.price).filter(p => p != null && p > 0);
  const bestAsk = askPricesValid.length > 0 ? Math.min(...askPricesValid) : null;
  // #12: same outlier guard as the depth memo above — exclude garbage bids well
  // above the floor so BEST BID isn't an inverted 40x-floor number.
  const bidPricesValid = collectionOffers.map(o => o.price)
    .filter(p => p != null && p > 0 && (bestAsk == null || p <= bestAsk * 2));
  const bestBid = bidPricesValid.length > 0 ? Math.max(...bidPricesValid) : null;

  return (
    <div style={{
      background: "rgba(111,168,220,0.02)",
      border: "1px solid rgba(111,168,220,0.08)",
      borderRadius: 12,
      padding: "20px",
      marginBottom: 24,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 10, color: "var(--naka-blue)", letterSpacing: "0.1em" }}>
            ORDER BOOK
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 4 }}>
            Bid/ask depth &middot; {listings.length} asks &middot; {collectionOffers.length} bids
          </div>
        </div>
        {spreadPct && (
          <div style={{
            fontFamily: "var(--mono)", fontSize: 11,
            background: "rgba(111,168,220,0.08)", borderRadius: 8, padding: "6px 12px",
          }}>
            <span style={{ color: "var(--text-muted)" }}>Spread </span>
            <span style={{ color: "var(--gold)" }}>{spread.toFixed(4)}</span>
            <span style={{ color: "var(--text-muted)" }}> ({spreadPct}%)</span>
          </div>
        )}
      </div>

      {/* Best Bid / Best Ask */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
        <div style={{
          background: "rgba(76,175,80,0.06)", border: "1px solid rgba(76,175,80,0.15)",
          borderRadius: 8, padding: "10px 14px", textAlign: "center",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", letterSpacing: "0.1em", marginBottom: 4 }}>BEST BID</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--green)", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
            <Eth size={12} />{bestBid ? bestBid.toFixed(4) : "\u2014"}
          </div>
        </div>
        <div style={{
          background: "rgba(244,67,54,0.06)", border: "1px solid rgba(244,67,54,0.15)",
          borderRadius: 8, padding: "10px 14px", textAlign: "center",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--red)", letterSpacing: "0.1em", marginBottom: 4 }}>BEST ASK</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 16, color: "var(--red)", display: "flex", alignItems: "center", justifyContent: "center", gap: 4 }}>
            <Eth size={12} />{bestAsk ? bestAsk.toFixed(4) : "\u2014"}
          </div>
        </div>
      </div>

      {/* Depth bars */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.05em" }}>BIDS (BUYERS)</div>
          {bidBuckets.map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, height: 22 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", width: 52, textAlign: "right", flexShrink: 0 }}>{(b.price ?? 0).toFixed(4)}</span>
              <div style={{ flex: 1, position: "relative", height: 16, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${(b.cumulative / maxCumulative) * 100}%`, background: "rgba(76,175,80,0.15)", borderRadius: 3, transition: "width 0.3s ease" }} />
                <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: `${(b.count / maxCumulative) * 100}%`, background: "rgba(76,175,80,0.35)", borderRadius: 3, transition: "width 0.3s ease" }} />
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--green)", width: 28, textAlign: "right", flexShrink: 0 }}>{b.count || ""}</span>
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginBottom: 8, letterSpacing: "0.05em" }}>ASKS (SELLERS)</div>
          {askBuckets.map((b, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2, height: 22 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--red)", width: 28, flexShrink: 0 }}>{b.count || ""}</span>
              <div style={{ flex: 1, position: "relative", height: 16, borderRadius: 3, overflow: "hidden" }}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(b.cumulative / maxCumulative) * 100}%`, background: "rgba(244,67,54,0.15)", borderRadius: 3, transition: "width 0.3s ease" }} />
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(b.count / maxCumulative) * 100}%`, background: "rgba(244,67,54,0.35)", borderRadius: 3, transition: "width 0.3s ease" }} />
              </div>
              <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", width: 52, flexShrink: 0 }}>{(b.price ?? 0).toFixed(4)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ═══ MAIN EXPORT ═══

export default function OrderBookPanel({ listings = [], collectionOffers = [], floorPrice, wallet, onConnect, addToast }) {
  return (
    <>
      <NativeListingsTable wallet={wallet} onConnect={onConnect} addToast={addToast} floorPrice={floorPrice} />
      <DepthChart listings={listings} collectionOffers={collectionOffers} />
    </>
  );
}
