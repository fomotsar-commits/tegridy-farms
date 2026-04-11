import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useActiveCollection } from "../contexts/CollectionContext";
import { OPENSEA_ITEM } from "../constants";
import { fulfillSeaportOrder } from "../api";
import { recordTransaction } from "../lib/transactions";
import { Eth } from "./Icons";
import NftImage from "./NftImage";

/* ── Discount threshold: listing must be at least 10% below max trait floor ── */
const DEAL_THRESHOLD = 0.9;

/* ── Format time ago ── */
function formatTimeAgo(ms) {
  if (!ms) return "";
  const diff = Date.now() - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/* ── Styles ── */
const S = {
  page: {
    position: "relative",
    zIndex: 1,
    maxWidth: 1440,
    margin: "0 auto",
    padding: "0 16px 80px",
  },
  header: {
    textAlign: "center",
    marginBottom: 32,
  },
  title: {
    fontFamily: "var(--pixel)",
    fontSize: 28,
    letterSpacing: 3,
    color: "var(--gold)",
    marginBottom: 4,
  },
  subtitle: {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text-dim)",
  },
  statsRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 16,
    justifyContent: "center",
    marginBottom: 28,
  },
  statCard: {
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    border: "1px solid var(--border)",
    borderRadius: 12,
    padding: "14px 22px",
    textAlign: "center",
    minWidth: 130,
  },
  statLabel: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    color: "var(--text-muted)",
    marginBottom: 4,
  },
  statValue: {
    fontFamily: "var(--display)",
    fontSize: 20,
    fontWeight: 700,
    color: "var(--text)",
  },
  filterBar: {
    display: "flex",
    flexWrap: "wrap",
    gap: 12,
    alignItems: "center",
    marginBottom: 24,
    padding: "12px 16px",
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    border: "1px solid var(--border)",
    borderRadius: 12,
  },
  filterGroup: {
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  filterLabel: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "var(--text-muted)",
    whiteSpace: "nowrap",
  },
  filterInput: {
    width: 80,
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 12,
    outline: "none",
  },
  filterSelect: {
    padding: "6px 10px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 12,
    cursor: "pointer",
    outline: "none",
  },
  newDealsBadge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 14px",
    borderRadius: 8,
    background: "rgba(46,204,113,0.15)",
    border: "1px solid rgba(46,204,113,0.4)",
    color: "var(--green, #2ecc71)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    cursor: "pointer",
    animation: "pulse 2s infinite",
  },
  table: {
    width: "100%",
    borderCollapse: "separate",
    borderSpacing: "0 6px",
  },
  th: {
    fontFamily: "var(--mono)",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    color: "var(--text-muted)",
    textAlign: "left",
    padding: "8px 12px",
    borderBottom: "1px solid var(--border)",
    cursor: "pointer",
    userSelect: "none",
    whiteSpace: "nowrap",
  },
  td: {
    padding: "10px 12px",
    fontFamily: "var(--mono)",
    fontSize: 13,
    color: "var(--text)",
    verticalAlign: "middle",
  },
  row: {
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    cursor: "pointer",
    transition: "background 0.12s, transform 0.12s",
    borderRadius: 10,
  },
  dealBadge: {
    display: "inline-block",
    padding: "3px 8px",
    borderRadius: 6,
    fontFamily: "var(--mono)",
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: 0.5,
  },
  buyBtn: {
    padding: "6px 14px",
    borderRadius: 8,
    border: "none",
    fontFamily: "var(--mono)",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    transition: "background 0.15s, transform 0.1s",
    whiteSpace: "nowrap",
  },
  canvasWrap: {
    position: "relative",
    width: "100%",
    height: 400,
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    marginBottom: 32,
    overflow: "hidden",
  },
  canvasLabel: {
    fontFamily: "var(--pixel)",
    fontSize: 12,
    color: "var(--text-dim)",
    letterSpacing: 1,
    padding: "12px 16px",
  },
  emptyState: {
    textAlign: "center",
    padding: "80px 20px",
    fontFamily: "var(--mono)",
    fontSize: 13,
    color: "var(--text-muted)",
  },
};

/* ── Deal badge color by discount ── */
function dealColor(discount) {
  if (discount >= 30) return { bg: "rgba(231,76,60,0.2)", border: "rgba(231,76,60,0.5)", text: "#e74c3c" };
  if (discount >= 20) return { bg: "rgba(243,156,18,0.2)", border: "rgba(243,156,18,0.5)", text: "#f39c12" };
  return { bg: "rgba(46,204,113,0.2)", border: "rgba(46,204,113,0.5)", text: "#2ecc71" };
}

/* ══════════════════════════════════════════════
   ScatterPlot — canvas-based rarity vs price
   ══════════════════════════════════════════════ */
function ScatterPlot({ deals, allListedNfts, onPick }) {
  const canvasRef = useRef(null);
  const tooltipRef = useRef(null);
  const pointsRef = useRef([]);

  const data = useMemo(() => {
    return allListedNfts
      .filter(n => n.rank && n.price)
      .map(n => ({
        x: n.rank,
        y: n.price,
        isDeal: deals.some(d => d.id === n.id),
        nft: n,
      }));
  }, [allListedNfts, deals]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length === 0) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    const pad = { top: 20, right: 30, bottom: 40, left: 60 };

    ctx.clearRect(0, 0, w, h);

    const xs = data.map(d => d.x);
    const ys = data.map(d => d.y);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys) * 1.1;

    const scaleX = (v) => pad.left + (v - xMin) / (xMax - xMin || 1) * (w - pad.left - pad.right);
    const scaleY = (v) => h - pad.bottom - (v - yMin) / (yMax - yMin || 1) * (h - pad.top - pad.bottom);

    // Grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const yVal = yMin + (yMax - yMin) * (i / 4);
      const py = scaleY(yVal);
      ctx.beginPath();
      ctx.moveTo(pad.left, py);
      ctx.lineTo(w - pad.right, py);
      ctx.stroke();

      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "10px monospace";
      ctx.textAlign = "right";
      ctx.fillText(yVal.toFixed(2), pad.left - 8, py + 3);
    }

    // Axis labels
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("Rarity Rank", w / 2, h - 8);
    ctx.save();
    ctx.translate(12, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Price (ETH)", 0, 0);
    ctx.restore();

    // Trend line (simple linear regression)
    if (data.length > 2) {
      const n = data.length;
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (const d of data) {
        sumX += d.x;
        sumY += d.y;
        sumXY += d.x * d.y;
        sumX2 += d.x * d.x;
      }
      const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX || 1);
      const intercept = (sumY - slope * sumX) / n;
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(scaleX(xMin), scaleY(slope * xMin + intercept));
      ctx.lineTo(scaleX(xMax), scaleY(slope * xMax + intercept));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Points
    const points = [];
    for (const d of data) {
      const px = scaleX(d.x);
      const py = scaleY(d.y);
      points.push({ px, py, nft: d.nft, isDeal: d.isDeal });

      ctx.beginPath();
      ctx.arc(px, py, d.isDeal ? 5 : 3, 0, Math.PI * 2);
      if (d.isDeal) {
        ctx.fillStyle = "rgba(46,204,113,0.8)";
        ctx.strokeStyle = "#2ecc71";
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
      } else {
        ctx.fillStyle = "rgba(111,168,220,0.4)";
        ctx.fill();
      }
    }
    pointsRef.current = points;
  }, [data]);

  useEffect(() => {
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [draw]);

  const handleCanvasClick = useCallback((e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const p of pointsRef.current) {
      const dist = Math.hypot(p.px - mx, p.py - my);
      if (dist < 8) {
        onPick(p.nft);
        return;
      }
    }
  }, [onPick]);

  const handleCanvasMove = useCallback((e) => {
    const canvas = canvasRef.current;
    const tooltip = tooltipRef.current;
    if (!canvas || !tooltip) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const p of pointsRef.current) {
      const dist = Math.hypot(p.px - mx, p.py - my);
      if (dist < 8) {
        tooltip.style.display = "block";
        tooltip.style.left = `${p.px + 10}px`;
        tooltip.style.top = `${p.py - 10}px`;
        tooltip.textContent = `#${p.nft.id} | ${p.nft.price?.toFixed(4)} ETH | Rank ${p.nft.rank}`;
        canvas.style.cursor = "pointer";
        return;
      }
    }
    tooltip.style.display = "none";
    canvas.style.cursor = "default";
  }, []);

  if (data.length === 0) return null;

  return (
    <div style={S.canvasWrap}>
      <div style={S.canvasLabel}>RARITY vs PRICE</div>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height: "calc(100% - 36px)", display: "block" }}
        onClick={handleCanvasClick}
        onMouseMove={handleCanvasMove}
      />
      <div
        ref={tooltipRef}
        style={{
          display: "none",
          position: "absolute",
          padding: "4px 10px",
          borderRadius: 6,
          background: "rgba(0,0,0,0.85)",
          color: "#fff",
          fontFamily: "var(--mono)",
          fontSize: 11,
          pointerEvents: "none",
          whiteSpace: "nowrap",
          zIndex: 10,
        }}
      />
    </div>
  );
}

/* ══════════════════════════════════════════════
   Deals — trait floor arbitrage
   ══════════════════════════════════════════════ */
export default function Deals({
  tokens,
  listings,
  listingsLoading,
  stats,
  onPick,
  wallet,
  onConnect,
  addToast,
  onAddToCart,
  onRefresh,
  loadAll,
  hasMore,
}) {
  const collection = useActiveCollection();
  const [buying, setBuying] = useState(null);
  const [hoveredRow, setHoveredRow] = useState(null);
  const [newDealsCount, setNewDealsCount] = useState(0);
  const prevDealsRef = useRef(null);

  // Filters
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const [minDiscount, setMinDiscount] = useState("");
  const [traitCategory, setTraitCategory] = useState("all");
  const [minRank, setMinRank] = useState("");
  const [maxRank, setMaxRank] = useState("");

  // Trigger loading all tokens so we have full trait data
  useEffect(() => {
    if (loadAll && hasMore) loadAll();
  }, [loadAll, hasMore]);

  // Reset state on collection change
  useEffect(() => {
    setBuying(null);
    setHoveredRow(null);
    setNewDealsCount(0);
    prevDealsRef.current = null;
    setMinPrice("");
    setMaxPrice("");
    setMinDiscount("");
    setTraitCategory("all");
    setMinRank("");
    setMaxRank("");
  }, [collection.slug]);

  /* ── Build trait floors from listings + token traits ── */
  // Store the two lowest prices per trait so we can exclude a token's own price
  const traitFloorData = useMemo(() => {
    if (!listings || listings.length === 0 || tokens.length === 0) return {};
    const priceMap = {};
    for (const l of listings) {
      if (l.tokenId && l.price != null) {
        priceMap[String(l.tokenId)] = l;
      }
    }
    const data = {}; // key -> { low1: {price, tokenId}, low2: {price, tokenId} }
    for (const token of tokens) {
      const listing = priceMap[String(token.id)];
      if (!listing) continue;
      const tid = String(token.id);
      for (const attr of token.attributes || []) {
        const k = `${attr.key}::${attr.value}`;
        if (!data[k]) {
          data[k] = { low1: { price: listing.price, tokenId: tid }, low2: null };
        } else if (listing.price < data[k].low1.price) {
          data[k].low2 = data[k].low1;
          data[k].low1 = { price: listing.price, tokenId: tid };
        } else if (!data[k].low2 || listing.price < data[k].low2.price) {
          data[k].low2 = { price: listing.price, tokenId: tid };
        }
      }
    }
    return data;
  }, [tokens, listings]);

  // Helper: get trait floor excluding a specific token
  function getTraitFloorExcluding(traitKey, excludeTokenId) {
    const d = traitFloorData[traitKey];
    if (!d) return null;
    if (d.low1.tokenId === excludeTokenId) return d.low2?.price ?? null;
    return d.low1.price;
  }

  /* ── Trait categories for filter dropdown ── */
  const traitCategories = useMemo(() => {
    const cats = new Set();
    for (const token of tokens) {
      for (const attr of token.attributes || []) {
        cats.add(attr.key);
      }
    }
    return [...cats].sort();
  }, [tokens]);

  /* ── Compute deals ── */
  const { deals, allListedNfts } = useMemo(() => {
    if (!listings || listings.length === 0 || tokens.length === 0 || Object.keys(traitFloorData).length === 0) {
      return { deals: [], allListedNfts: [] };
    }

    const priceMap = {};
    const listingMap = {};
    for (const l of listings) {
      if (l.tokenId && l.price != null) {
        priceMap[String(l.tokenId)] = l.price;
        listingMap[String(l.tokenId)] = l;
      }
    }

    const allListed = [];
    const dealsList = [];

    for (const token of tokens) {
      const price = priceMap[String(token.id)];
      if (price == null) continue;

      const listing = listingMap[String(token.id)];
      let maxTraitFloor = 0;
      let bestTrait = null;
      const keyTraits = [];

      const tid = String(token.id);
      for (const attr of token.attributes || []) {
        const k = `${attr.key}::${attr.value}`;
        const floor = getTraitFloorExcluding(k, tid);
        if (floor != null) {
          keyTraits.push({ key: attr.key, value: attr.value, floor });
          if (floor > maxTraitFloor) {
            maxTraitFloor = floor;
            bestTrait = attr;
          }
        }
      }

      const enriched = {
        ...token,
        price,
        maxTraitFloor,
        bestTrait,
        keyTraits: keyTraits.sort((a, b) => b.floor - a.floor).slice(0, 3),
        discount: maxTraitFloor > 0 ? ((maxTraitFloor - price) / maxTraitFloor) * 100 : 0,
        orderHash: listing?.orderHash || null,
        orderData: listing?.orderData || null,
        protocolAddress: listing?.protocolAddress || null,
        createdAt: listing?.createdAt || null,
        expiry: listing?.expiry || null,
      };

      allListed.push(enriched);

      if (maxTraitFloor > 0 && price < maxTraitFloor * DEAL_THRESHOLD) {
        dealsList.push(enriched);
      }
    }

    dealsList.sort((a, b) => b.discount - a.discount);
    return { deals: dealsList, allListedNfts: allListed };
  }, [tokens, listings, traitFloorData]);

  /* ── Auto-refresh every 60s ── */
  useEffect(() => {
    if (!onRefresh) return;
    const iv = setInterval(() => {
      onRefresh();
    }, 60000);
    return () => clearInterval(iv);
  }, [onRefresh]);

  /* ── Detect new deals ── */
  useEffect(() => {
    if (prevDealsRef.current === null) {
      prevDealsRef.current = new Set(deals.map(d => d.id));
      return;
    }
    const prevSet = prevDealsRef.current;
    const newOnes = deals.filter(d => !prevSet.has(d.id));
    if (newOnes.length > 0) {
      setNewDealsCount(newOnes.length);
    }
    prevDealsRef.current = new Set(deals.map(d => d.id));
  }, [deals]);

  /* ── Apply filters ── */
  const filteredDeals = useMemo(() => {
    let result = deals;
    const pMin = parseFloat(minPrice);
    const pMax = parseFloat(maxPrice);
    const dMin = parseFloat(minDiscount);
    const rMin = parseInt(minRank, 10);
    const rMax = parseInt(maxRank, 10);

    if (!isNaN(pMin)) result = result.filter(d => d.price >= pMin);
    if (!isNaN(pMax)) result = result.filter(d => d.price <= pMax);
    if (!isNaN(dMin)) result = result.filter(d => d.discount >= dMin);
    if (traitCategory !== "all") {
      result = result.filter(d =>
        d.keyTraits.some(t => t.key === traitCategory)
      );
    }
    if (!isNaN(rMin)) result = result.filter(d => (d.rank || 0) >= rMin);
    if (!isNaN(rMax)) result = result.filter(d => (d.rank || Infinity) <= rMax);

    return result;
  }, [deals, minPrice, maxPrice, minDiscount, traitCategory, minRank, maxRank]);

  /* ── Buy handler ── */
  const handleBuy = useCallback(async (nft, e) => {
    e.stopPropagation();
    if (!wallet) {
      onConnect();
      return;
    }
    if (!nft.orderHash) {
      addToast("Order data not available for direct purchase", "error");
      return;
    }
    setBuying(nft.id);
    try {
      const result = await fulfillSeaportOrder(nft);
      if (result.success) {
        addToast(`Purchased #${nft.id} for ${nft.price.toFixed(4)} ETH`, "success");
        recordTransaction({
          type: "buy",
          tokenId: nft.id,
          price: nft.price,
          hash: result.hash,
          collection: collection.slug,
        });
      } else if (result.error === "rejected") {
        addToast("Transaction rejected", "info");
      } else {
        addToast(result.message || "Purchase failed", "error");
      }
    } catch {
      addToast("Purchase failed", "error");
    }
    setBuying(null);
  }, [wallet, onConnect, addToast, collection.slug]);

  /* ── Summary stats ── */
  const summaryStats = useMemo(() => {
    const avgDiscount = deals.length > 0
      ? deals.reduce((s, d) => s + d.discount, 0) / deals.length
      : 0;
    const bestDeal = deals[0] || null;
    const totalValue = deals.reduce((s, d) => s + (d.maxTraitFloor - d.price), 0);
    return { avgDiscount, bestDeal, totalValue, count: deals.length };
  }, [deals]);

  /* ══════════════════════════════════════════════
     LOADING STATE
     ══════════════════════════════════════════════ */
  if (listingsLoading || tokens.length === 0) {
    return (
      <section style={S.page}>
        <div style={S.header}>
          <div style={S.title}>DEALS</div>
          <div style={S.subtitle}>Finding underpriced listings based on trait floor arbitrage...</div>
        </div>
        <div style={S.emptyState}>
          <div className="spinner" style={{ margin: "0 auto 16px" }} />
          Loading listings and trait data...
        </div>
      </section>
    );
  }

  /* ══════════════════════════════════════════════
     EMPTY STATE
     ══════════════════════════════════════════════ */
  if (deals.length === 0 && !listingsLoading) {
    return (
      <section style={S.page}>
        <div style={S.header}>
          <div style={S.title}>DEALS</div>
          <div style={S.subtitle}>Trait floor arbitrage scanner for {collection.name}</div>
        </div>
        <div style={S.emptyState}>
          <div style={{ fontSize: 32, marginBottom: 16, opacity: 0.5 }}>{"🔍"}</div>
          No deals found right now. All listings are priced at or above their trait floors.
          <br />
          <span style={{ fontSize: 11, color: "var(--text-dim)" }}>
            Deals auto-refresh every 60 seconds. Check back soon!
          </span>
        </div>
      </section>
    );
  }

  /* ══════════════════════════════════════════════
     MAIN VIEW
     ══════════════════════════════════════════════ */
  return (
    <section style={S.page}>
      {/* Title */}
      <div style={S.header}>
        <div style={S.title}>DEALS</div>
        <div style={S.subtitle}>
          NFTs listed below their trait floor value &mdash; {collection.name}
        </div>
      </div>

      {/* Summary Stats */}
      <div style={S.statsRow}>
        <div style={S.statCard}>
          <div style={S.statLabel}>Deals Found</div>
          <div style={{ ...S.statValue, color: "var(--green, #2ecc71)" }}>{summaryStats.count}</div>
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Avg Discount</div>
          <div style={{ ...S.statValue, color: "var(--gold)" }}>{summaryStats.avgDiscount.toFixed(1)}%</div>
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Best Deal</div>
          <div style={{ ...S.statValue, color: "#e74c3c" }}>
            {summaryStats.bestDeal ? `${summaryStats.bestDeal.discount.toFixed(0)}% off` : "--"}
          </div>
          {summaryStats.bestDeal && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
              #{summaryStats.bestDeal.id}
            </div>
          )}
        </div>
        <div style={S.statCard}>
          <div style={S.statLabel}>Total Savings</div>
          <div style={S.statValue}>
            {summaryStats.totalValue.toFixed(2)} <span style={{ fontSize: 12 }}>ETH</span>
          </div>
        </div>
      </div>

      {/* New Deals Badge */}
      {newDealsCount > 0 && (
        <div style={{ textAlign: "center", marginBottom: 16 }}>
          <span
            style={S.newDealsBadge}
            onClick={() => {
              setNewDealsCount(0);
              window.scrollTo({ top: 0, behavior: "smooth" });
            }}
          >
            {newDealsCount} new deal{newDealsCount > 1 ? "s" : ""} found! Click to refresh view
          </span>
        </div>
      )}

      {/* Scatter Plot */}
      <ScatterPlot deals={deals} allListedNfts={allListedNfts} onPick={onPick} />

      {/* Filters */}
      <div style={S.filterBar}>
        <div style={S.filterGroup}>
          <span style={S.filterLabel}>Price</span>
          <input
            type="number"
            placeholder="Min"
            value={minPrice}
            onChange={e => setMinPrice(e.target.value)}
            style={S.filterInput}
            step="0.01"
            min="0"
          />
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>-</span>
          <input
            type="number"
            placeholder="Max"
            value={maxPrice}
            onChange={e => setMaxPrice(e.target.value)}
            style={S.filterInput}
            step="0.01"
            min="0"
          />
        </div>

        <div style={S.filterGroup}>
          <span style={S.filterLabel}>Min Discount</span>
          <input
            type="number"
            placeholder="10"
            value={minDiscount}
            onChange={e => setMinDiscount(e.target.value)}
            style={{ ...S.filterInput, width: 60 }}
            step="1"
            min="0"
            max="100"
          />
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>%</span>
        </div>

        <div style={S.filterGroup}>
          <span style={S.filterLabel}>Trait</span>
          <select
            value={traitCategory}
            onChange={e => setTraitCategory(e.target.value)}
            style={S.filterSelect}
          >
            <option value="all">All Traits</option>
            {traitCategories.map(c => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        </div>

        <div style={S.filterGroup}>
          <span style={S.filterLabel}>Rank</span>
          <input
            type="number"
            placeholder="Min"
            value={minRank}
            onChange={e => setMinRank(e.target.value)}
            style={{ ...S.filterInput, width: 70 }}
            min="1"
          />
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>-</span>
          <input
            type="number"
            placeholder="Max"
            value={maxRank}
            onChange={e => setMaxRank(e.target.value)}
            style={{ ...S.filterInput, width: 70 }}
            min="1"
          />
        </div>

        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)", marginLeft: "auto" }}>
          {filteredDeals.length} deal{filteredDeals.length !== 1 ? "s" : ""}
        </div>
      </div>

      {/* Deals Table */}
      <div style={{ overflowX: "auto" }}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>NFT</th>
              <th style={S.th}>Token ID</th>
              <th style={S.th}>Listed Price</th>
              <th style={S.th}>Fair Value</th>
              <th style={S.th}>Discount</th>
              <th style={S.th}>Key Traits</th>
              <th style={S.th}>Rank</th>
              <th style={S.th}></th>
            </tr>
          </thead>
          <tbody>
            {filteredDeals.map(deal => {
              const colors = dealColor(deal.discount);
              const isHovered = hoveredRow === deal.id;
              return (
                <tr
                  key={deal.id}
                  style={{
                    ...S.row,
                    background: isHovered ? "rgba(255,255,255,0.06)" : "var(--surface-glass)",
                  }}
                  onClick={() => onPick(deal)}
                  onMouseEnter={() => setHoveredRow(deal.id)}
                  onMouseLeave={() => setHoveredRow(null)}
                >
                  <td style={S.td}>
                    <div style={{ width: 44, height: 44, borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
                      <NftImage nft={deal} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                    </div>
                  </td>
                  <td style={{ ...S.td, fontWeight: 600 }}>#{deal.id}</td>
                  <td style={S.td}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <Eth size={12} /> {deal.price.toFixed(4)}
                    </span>
                  </td>
                  <td style={{ ...S.td, color: "var(--text-dim)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                      <Eth size={12} /> {deal.maxTraitFloor.toFixed(4)}
                    </span>
                  </td>
                  <td style={S.td}>
                    <span
                      style={{
                        ...S.dealBadge,
                        background: colors.bg,
                        border: `1px solid ${colors.border}`,
                        color: colors.text,
                      }}
                    >
                      {deal.discount.toFixed(0)}% below
                    </span>
                  </td>
                  <td style={{ ...S.td, maxWidth: 200 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {deal.keyTraits.map((t, i) => (
                        <span
                          key={i}
                          style={{
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "rgba(255,255,255,0.06)",
                            fontFamily: "var(--mono)",
                            fontSize: 10,
                            color: "var(--text-dim)",
                            whiteSpace: "nowrap",
                          }}
                          title={`${t.key}: ${t.value} (floor: ${t.floor.toFixed(4)} ETH)`}
                        >
                          {t.value}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td style={{ ...S.td, color: "var(--text-dim)" }}>
                    {deal.rank ? `#${deal.rank}` : "--"}
                  </td>
                  <td style={S.td}>
                    {deal.orderHash ? (
                      <button
                        style={{
                          ...S.buyBtn,
                          background: "var(--green, #2ecc71)",
                          color: "#000",
                        }}
                        disabled={buying === deal.id}
                        onClick={(e) => handleBuy(deal, e)}
                      >
                        {buying === deal.id ? "..." : !wallet ? "Connect" : `Buy`}
                      </button>
                    ) : (
                      <a
                        href={OPENSEA_ITEM(deal.id, collection.contract)}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{
                          ...S.buyBtn,
                          background: "rgba(111,168,220,0.15)",
                          color: "var(--naka-blue)",
                          textDecoration: "none",
                          display: "inline-block",
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        OpenSea
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
