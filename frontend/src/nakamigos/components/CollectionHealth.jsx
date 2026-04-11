import { useState, useEffect, useMemo, useRef } from "react";
import { Eth } from "./Icons";
import { fetchTopHolders, fetchListings } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";

// ═══ MINI SPARKLINE (canvas-based, no chart library) ═══
function Sparkline({ data, width = 80, height = 28, color = "var(--gold)", fillAlpha = 0.1 }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.length < 2) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const pad = 2;
    const w = width - pad * 2;
    const h = height - pad * 2;

    // Resolve CSS variable color
    const resolved = getComputedStyle(canvas).getPropertyValue(
      color.replace(/var\(/, "").replace(/\)/, "")
    ).trim() || color;

    // Fill area
    ctx.beginPath();
    ctx.moveTo(pad, height - pad);
    data.forEach((v, i) => {
      const x = pad + (i / (data.length - 1)) * w;
      const y = pad + h - ((v - min) / range) * h;
      ctx.lineTo(x, y);
    });
    ctx.lineTo(pad + w, height - pad);
    ctx.closePath();
    ctx.fillStyle = resolved.startsWith("#")
      ? resolved + Math.round(fillAlpha * 255).toString(16).padStart(2, "0")
      : `rgba(200, 170, 100, ${fillAlpha})`;
    ctx.fill();

    // Stroke line
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad + (i / (data.length - 1)) * w;
      const y = pad + h - ((v - min) / range) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = resolved.startsWith("#") ? resolved : "#c8a850";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }, [data, width, height, color, fillAlpha]);

  return (
    <canvas
      ref={canvasRef}
      style={{ width, height, display: "block" }}
    />
  );
}

// ═══ CIRCULAR PROGRESS INDICATOR ═══
function HealthCircle({ score, size = 100 }) {
  const color = score >= 70 ? "var(--green)" : score >= 40 ? "var(--yellow)" : "var(--red)";
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      {/* Background track */}
      <circle cx="50" cy="50" r={radius} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="6" />
      {/* Progress arc */}
      <circle
        cx="50" cy="50" r={radius} fill="none"
        stroke={color} strokeWidth="6" strokeLinecap="round"
        strokeDasharray={circumference} strokeDashoffset={offset}
        style={{ transform: "rotate(-90deg)", transformOrigin: "50px 50px", transition: "stroke-dashoffset 0.8s ease" }}
      />
      {/* Score text */}
      <text x="50" y="46" textAnchor="middle" dominantBaseline="central"
        fill={color} fontSize="22" fontWeight="700" fontFamily="var(--display)">
        {score}
      </text>
      <text x="50" y="64" textAnchor="middle" dominantBaseline="central"
        fill="var(--text-muted)" fontSize="7" fontFamily="var(--mono)" letterSpacing="0.08em">
        HEALTH
      </text>
    </svg>
  );
}

// ═══ HELPER: health color for listing % ═══
function listingHealthColor(pct) {
  if (pct < 5) return "var(--green)";
  if (pct <= 15) return "var(--yellow)";
  return "var(--red)";
}

// ═══ HELPER: trend arrow ═══
function TrendArrow({ value, suffix = "" }) {
  if (value == null || value === 0) return <span style={{ color: "var(--text-muted)" }}>{suffix}</span>;
  const up = value > 0;
  return (
    <span style={{ color: up ? "var(--green)" : "var(--red)", fontFamily: "var(--mono)", fontSize: 9 }}>
      {up ? "\u2191" : "\u2193"}{Math.abs(value).toFixed(1)}{suffix}
    </span>
  );
}

// ═══ MAIN COMPONENT ═══
export default function CollectionHealth({ stats, activities }) {
  const collection = useActiveCollection();
  const [holders, setHolders] = useState([]);
  const [totalOwners, setTotalOwners] = useState(0);
  const [totalHeld, setTotalHeld] = useState(0);
  const [listings, setListings] = useState([]);
  const [loading, setLoading] = useState(true);

  const supply = stats.supply ?? collection.supply ?? 0;

  // Guard: if supply is 0, derived percentages would be Infinity
  const safeSupply = supply || 1;

  // Fetch holders + listings on mount / collection change
  useEffect(() => {
    setLoading(true);
    setHolders([]);
    setListings([]);

    Promise.all([
      fetchTopHolders({ contract: collection.contract, limit: 100 }).catch(() => ({ holders: [], totalOwners: 0, totalHeld: 0 })),
      fetchListings(collection.slug, { openseaSlug: collection.openseaSlug, contract: collection.contract }).catch(() => ({ listings: [] })),
    ]).then(([holderData, listingData]) => {
      setHolders(holderData.holders || []);
      setTotalOwners(holderData.totalOwners || 0);
      setTotalHeld(holderData.totalHeld || 0);
      setListings(listingData.listings || []);
    }).finally(() => setLoading(false));
  }, [collection.contract, collection.slug, collection.openseaSlug]);

  // ── Derived metrics ──

  // Snapshot time once per data load so memos don't recompute every render
  const now = useMemo(() => Date.now(), [activities, listings]);
  const DAY_MS = 86400000;
  const HOUR_MS = 3600000;

  // Activities bucketed by time
  const recentSales = useMemo(() => {
    if (!activities.length) return { day: [], week: [], hour: [] };
    const day = activities.filter(a => a.time && (now - a.time) < DAY_MS);
    const week = activities.filter(a => a.time && (now - a.time) < 7 * DAY_MS);
    const hour = activities.filter(a => a.time && (now - a.time) < HOUR_MS);
    return { day, week, hour };
  }, [activities, now]);

  // Floor price metrics
  const floorMetrics = useMemo(() => {
    if (stats.floor == null) return null;
    const prices = activities.filter(a => a.price > 0).map(a => ({ price: a.price, time: a.time }));
    if (!prices.length) return { current: stats.floor, change1h: null, change24h: null, change7d: null };

    const avgInWindow = (start, end) => {
      const inWindow = prices.filter(p => p.time >= start && p.time < end);
      if (!inWindow.length) return null;
      return inWindow.reduce((s, p) => s + p.price, 0) / inWindow.length;
    };

    const prev1h = avgInWindow(now - 2 * HOUR_MS, now - HOUR_MS);
    const prev24h = avgInWindow(now - 2 * DAY_MS, now - DAY_MS);
    const prev7d = avgInWindow(now - 14 * DAY_MS, now - 7 * DAY_MS);

    const pctChange = (current, prev) => prev ? ((current - prev) / prev) * 100 : null;

    return {
      current: stats.floor,
      change1h: pctChange(stats.floor, prev1h),
      change24h: pctChange(stats.floor, prev24h),
      change7d: pctChange(stats.floor, prev7d),
    };
  }, [stats.floor, activities, now]);

  // Listing metrics
  const listingMetrics = useMemo(() => {
    const count = listings.length;
    const pct = (count / safeSupply) * 100;
    return { count, pct };
  }, [listings, safeSupply]);

  // Volume metrics
  const volumeMetrics = useMemo(() => {
    const dayVol = recentSales.day.reduce((s, a) => s + (a.price || 0), 0);
    const weekVol = recentSales.week.reduce((s, a) => s + (a.price || 0), 0);
    const weekAvgDay = recentSales.week.length > 0 ? weekVol / 7 : 0;
    return { dayVol, weekAvgDay };
  }, [recentSales]);

  // Unique buyers vs sellers (24h)
  const buyerSeller = useMemo(() => {
    const buyers = new Set();
    const sellers = new Set();
    for (const a of recentSales.day) {
      if (a.toFull) buyers.add(a.toFull);
      if (a.fromFull) sellers.add(a.fromFull);
    }
    const b = buyers.size;
    const s = sellers.size;
    const ratio = s > 0 ? (b / s).toFixed(1) : b > 0 ? b.toFixed(1) : "0";
    return { buyers: b, sellers: s, ratio, total: b + s };
  }, [recentSales.day]);

  // Floor depth
  const floorDepth = useMemo(() => {
    if (!listings.length || stats.floor == null) return null;
    const floor = stats.floor;
    const threshold = floor * 1.05; // within 5%
    const atFloor = listings.filter(l => l.price <= threshold);
    const aboveFloor = listings.filter(l => l.price > threshold).sort((a, b) => a.price - b.price);
    const gapPct = aboveFloor.length > 0 ? ((aboveFloor[0].price - floor) / floor * 100).toFixed(1) : null;
    const thick = atFloor.length >= 50;
    const thin = atFloor.length < 5;
    return {
      count: atFloor.length,
      thick,
      thin,
      label: thick ? "Thick Floor" : thin ? "Thin Floor" : "Moderate Floor",
      color: thick ? "var(--green)" : thin ? "var(--red)" : "var(--yellow)",
      gapPct,
      nextPrice: aboveFloor.length > 0 ? aboveFloor[0].price : null,
    };
  }, [listings, stats.floor]);

  // Listing velocity
  const listingVelocity = useMemo(() => {
    const count = listings.length;
    // Spike detection: if listed % > 15%, it's a spike
    const spike = (count / safeSupply) * 100 > 15;
    return { count, spike };
  }, [listings, safeSupply]);

  // Whale concentration
  const whaleConcentration = useMemo(() => {
    if (!holders.length) return null;
    const top10Held = holders.slice(0, 10).reduce((s, h) => s + h.count, 0);
    const effectiveSupply = supply || totalHeld || 1;
    const pct = (top10Held / effectiveSupply) * 100;
    return {
      pct: pct.toFixed(1),
      warning: pct > 30, // pct is a number here; the string .toFixed(1) is only used for display
      top10Held,
    };
  }, [holders, supply, totalHeld]);

  // Diamond hands: holders who appear as buyers but never as sellers in activity
  const diamondHands = useMemo(() => {
    if (!activities.length || !totalOwners) return null;
    const sellers = new Set(activities.filter(a => a.fromFull).map(a => a.fromFull.toLowerCase()));
    const allHolderAddresses = holders.map(h => h.address?.toLowerCase()).filter(Boolean);
    const neverSold = allHolderAddresses.filter(addr => !sellers.has(addr)).length;
    const total = allHolderAddresses.length || 1;
    return { pct: ((neverSold / total) * 100).toFixed(0), count: neverSold };
  }, [activities, holders, totalOwners]);

  // Sparkline data from recent sales (7 day buckets)
  const volumeSparkline = useMemo(() => {
    const buckets = Array(7).fill(0);
    for (const a of recentSales.week) {
      const daysAgo = Math.min(6, Math.floor((now - a.time) / DAY_MS));
      buckets[6 - daysAgo] += a.price || 0;
    }
    return buckets;
  }, [recentSales.week, now]);

  // Estimated holder trend sparkline (derived from activity — net accumulation per day)
  const holderSparkline = useMemo(() => {
    const buckets = Array(7).fill(0);
    for (const a of recentSales.week) {
      const daysAgo = Math.min(6, Math.floor((now - a.time) / DAY_MS));
      buckets[6 - daysAgo] += 1; // each sale = potential holder change
    }
    // Cumulative
    let base = totalOwners || 0;
    // Rough directional estimate only — not actual holder count changes
    return buckets.map(v => { base += v * 0.1; return Math.round(base); });
  }, [recentSales.week, totalOwners, now]);

  // ── COMPOSITE HEALTH SCORE ──
  const healthScore = useMemo(() => {
    let score = 50; // baseline

    // Holder trend: more owners = healthier (+15 max)
    if (totalOwners > 0 && supply > 0) {
      const ownerRatio = totalOwners / supply;
      score += Math.min(15, ownerRatio * 30); // 50% unique ownership = +15
    }

    // Listing rate: lower is better (+20 max)
    if (supply > 0) {
      const listPct = listingMetrics.pct;
      if (listPct < 5) score += 20;
      else if (listPct < 10) score += 12;
      else if (listPct < 15) score += 5;
      else score -= 10;
    }

    // Volume trend: volume vs 7d average (+15 max)
    if (volumeMetrics.weekAvgDay > 0) {
      const ratio = volumeMetrics.dayVol / volumeMetrics.weekAvgDay;
      if (ratio > 1.5) score += 15;
      else if (ratio > 0.8) score += 8;
      else score -= 5;
    }

    // Floor stability: small changes = stable (+15 max)
    if (floorMetrics?.change24h != null) {
      const absChange = Math.abs(floorMetrics.change24h);
      if (absChange < 3) score += 15;
      else if (absChange < 10) score += 8;
      else score -= 5;
    }

    // Buyer/seller ratio bonus
    if (buyerSeller.buyers > buyerSeller.sellers) score += 5;
    else if (buyerSeller.sellers > buyerSeller.buyers * 2) score -= 10;

    // Whale concentration penalty
    if (whaleConcentration && parseFloat(whaleConcentration.pct) > 30) score -= 10;

    return Math.max(0, Math.min(100, Math.round(score)));
  }, [totalOwners, supply, listingMetrics.pct, volumeMetrics, floorMetrics, buyerSeller, whaleConcentration]);

  // Skeleton loading
  if (loading) {
    return (
      <div className="analytics-panel" style={{ marginTop: 24 }}>
        <div className="analytics-panel-header"><h3>Collection Health</h3></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "16px 0" }}>
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 24, borderRadius: 4, animationDelay: `${i * 50}ms` }} />
          ))}
        </div>
      </div>
    );
  }

  const panelStyle = {
    padding: "18px 20px",
    background: "rgba(200,170,100,0.02)",
    borderRadius: 12,
    border: "1px solid rgba(200,170,100,0.04)",
  };

  const labelStyle = {
    fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)",
    letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4,
  };

  const bigValueStyle = {
    fontFamily: "var(--display)", fontSize: 16, fontWeight: 700,
  };

  return (
    <div className="health-dashboard" style={{ marginTop: 32 }}>
      {/* Section header */}
      <h3 style={{
        fontFamily: "var(--display)", fontSize: 15, fontWeight: 600,
        color: "var(--text)", marginBottom: 6,
      }}>
        Collection Health
      </h3>
      <div style={{ width: 40, height: 2, background: "linear-gradient(90deg, var(--gold), transparent)", marginBottom: 20 }} />

      {/* ── 1. HEALTH SCORE CARD ── */}
      <div className="analytics-panel" style={{ marginBottom: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
          <HealthCircle score={healthScore} />
          <div style={{ flex: 1, minWidth: 200 }}>
            <div style={{ fontFamily: "var(--display)", fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>
              Composite Health Score
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", lineHeight: 1.6 }}>
              Based on holder trend, listing rate, volume trend, floor stability, buyer/seller ratio, and whale concentration.
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
              {[
                { label: "Holders", ok: totalOwners > 0 && supply > 0 && (totalOwners / supply) > 0.3 },
                { label: "Listings", ok: listingMetrics.pct < 10 },
                { label: "Volume", ok: volumeMetrics.dayVol > 0 },
                { label: "Floor", ok: floorMetrics?.change24h != null && Math.abs(floorMetrics.change24h) < 10 },
              ].map(({ label, ok }) => (
                <div key={label} style={{
                  fontFamily: "var(--mono)", fontSize: 8, letterSpacing: "0.06em",
                  padding: "3px 8px", borderRadius: 6,
                  background: ok ? "rgba(74,222,128,0.08)" : "rgba(255,100,100,0.08)",
                  color: ok ? "var(--green)" : "var(--red)",
                  border: `1px solid ${ok ? "rgba(74,222,128,0.15)" : "rgba(255,100,100,0.15)"}`,
                }}>
                  {ok ? "\u2713" : "\u2717"} {label}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* ── 2. KEY METRICS ROW ── */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(155px, 1fr))",
        gap: 12,
        marginBottom: 20,
      }}>
        {/* Unique Holders */}
        <div className="analytics-stat-card" style={{ position: "relative" }}>
          <div style={labelStyle}>UNIQUE HOLDERS</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ ...bigValueStyle, color: "var(--purple)" }}>
              {totalOwners ? totalOwners.toLocaleString() : "\u2014"}
            </div>
            {recentSales.week.length > 0 && <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>7d</span>}
          </div>
          <div style={{ marginTop: 6 }} title="Estimated trend based on sales activity">
            <Sparkline data={holderSparkline} color="#818cf8" width={100} height={22} />
          </div>
        </div>

        {/* Listed % */}
        <div className="analytics-stat-card">
          <div style={labelStyle}>LISTED %</div>
          <div style={{ ...bigValueStyle, color: listingHealthColor(listingMetrics.pct) }}>
            {listingMetrics.pct.toFixed(1)}%
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
            {listingMetrics.count.toLocaleString()} of {supply ? supply.toLocaleString() : "?"}
          </div>
        </div>

        {/* 24h Volume */}
        <div className="analytics-stat-card">
          <div style={labelStyle}>24H VOLUME</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Eth />
            <span style={{ ...bigValueStyle, color: "var(--gold)" }}>
              {volumeMetrics.dayVol.toFixed(2)}
            </span>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
            7d avg: {volumeMetrics.weekAvgDay.toFixed(2)} ETH/day
          </div>
          <div style={{ marginTop: 6 }}>
            <Sparkline data={volumeSparkline} color="#c8a850" width={100} height={22} />
          </div>
        </div>

        {/* Floor Price */}
        <div className="analytics-stat-card">
          <div style={labelStyle}>FLOOR PRICE</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <Eth />
            <span style={{ ...bigValueStyle, color: "var(--gold)" }}>
              {floorMetrics ? floorMetrics.current.toFixed(4) : "\u2014"}
            </span>
          </div>
          {floorMetrics && (
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              {[
                { label: "1h", val: floorMetrics.change1h },
                { label: "24h", val: floorMetrics.change24h },
                { label: "7d", val: floorMetrics.change7d },
              ].map(({ label, val }) => (
                <span key={label} style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)" }}>
                  {label}: <TrendArrow value={val} suffix="%" />
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Diamond Hands */}
        <div className="analytics-stat-card">
          <div style={labelStyle}>DIAMOND HANDS</div>
          <div style={{ ...bigValueStyle, color: "var(--naka-sky, #22d3ee)" }}>
            {diamondHands ? `${diamondHands.pct}%` : "\u2014"}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>
            {diamondHands ? `${diamondHands.count} never sold` : "No data"}
          </div>
        </div>
      </div>

      {/* ── 3-6: DETAIL PANELS ── */}
      <div className="health-detail-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>

        {/* ── 3. BUYER vs SELLER RATIO ── */}
        <div className="analytics-panel">
          <div className="analytics-panel-header">
            <h3>Buyer vs Seller (24h)</h3>
          </div>
          {buyerSeller.total > 0 ? (
            <>
              {/* Horizontal split bar */}
              <div style={{
                height: 28, borderRadius: 8, overflow: "hidden",
                display: "flex", marginBottom: 12,
              }}>
                <div style={{
                  width: `${(buyerSeller.buyers / buyerSeller.total) * 100}%`,
                  background: "var(--green)", minWidth: 2,
                  transition: "width 0.5s ease",
                }} />
                <div style={{
                  width: `${(buyerSeller.sellers / buyerSeller.total) * 100}%`,
                  background: "var(--red)", minWidth: 2,
                  transition: "width 0.5s ease",
                }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)" }}>
                    {buyerSeller.buyers} buyers
                  </span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", margin: "0 6px" }}>vs</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--red)" }}>
                    {buyerSeller.sellers} sellers
                  </span>
                </div>
                <div style={{
                  fontFamily: "var(--display)", fontSize: 13, fontWeight: 700,
                  color: buyerSeller.buyers >= buyerSeller.sellers ? "var(--green)" : "var(--red)",
                }}>
                  {buyerSeller.ratio}:1
                </div>
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", marginTop: 4 }}>
                {buyerSeller.buyers >= buyerSeller.sellers ? "Accumulation phase" : "Distribution phase"}
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
              No 24h trading activity
            </div>
          )}
        </div>

        {/* ── 4. FLOOR DEPTH INDICATOR ── */}
        <div className="analytics-panel">
          <div className="analytics-panel-header">
            <h3>Floor Depth</h3>
          </div>
          {floorDepth ? (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                <div style={{
                  fontFamily: "var(--display)", fontSize: 13, fontWeight: 700,
                  color: floorDepth.color,
                }}>
                  {floorDepth.label}
                </div>
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 9, padding: "2px 8px",
                  borderRadius: 6, background: "rgba(255,255,255,0.04)",
                  color: "var(--text-dim)",
                }}>
                  {floorDepth.count} within 5% of floor
                </div>
              </div>
              {/* Visual depth bar */}
              <div style={{
                height: 12, borderRadius: 6, background: "rgba(255,255,255,0.04)",
                overflow: "hidden", marginBottom: 8,
              }}>
                <div style={{
                  height: "100%", borderRadius: 6,
                  width: `${Math.min((floorDepth.count / 50) * 100, 100)}%`,
                  background: floorDepth.color,
                  transition: "width 0.5s ease",
                }} />
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
                {floorDepth.gapPct != null
                  ? `Next listing after floor is ${floorDepth.gapPct}% higher`
                  : "No gap data available"
                }
                {floorDepth.nextPrice != null && (
                  <span style={{ color: "var(--text-dim)" }}> ({floorDepth.nextPrice.toFixed(4)} ETH)</span>
                )}
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
              No listing data available
            </div>
          )}
        </div>

        {/* ── 5. LISTING VELOCITY ── */}
        <div className="analytics-panel">
          <div className="analytics-panel-header">
            <h3>Listing Velocity</h3>
            {listingVelocity.spike && (
              <span style={{
                fontFamily: "var(--mono)", fontSize: 8, padding: "2px 8px",
                borderRadius: 6, background: "rgba(255,100,100,0.1)",
                color: "var(--red)", border: "1px solid rgba(255,100,100,0.2)",
                animation: "pulse 2s infinite",
              }}>
                SPIKE
              </span>
            )}
          </div>
          <div style={panelStyle}>
            <div style={labelStyle}>ACTIVE LISTINGS</div>
            <div style={{ ...bigValueStyle, color: "var(--text)" }}>
              {listingVelocity.count.toLocaleString()}
            </div>
          </div>
          {listingVelocity.spike && (
            <div style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--red)",
              marginTop: 10, padding: "6px 10px", borderRadius: 8,
              background: "rgba(255,100,100,0.05)", border: "1px solid rgba(255,100,100,0.1)",
            }}>
              Listing rate above 15% of supply — possible sell pressure
            </div>
          )}
        </div>

        {/* ── 6. WHALE CONCENTRATION ── */}
        <div className="analytics-panel">
          <div className="analytics-panel-header">
            <h3>Whale Concentration</h3>
            {whaleConcentration?.warning && (
              <span style={{
                fontFamily: "var(--mono)", fontSize: 8, padding: "2px 8px",
                borderRadius: 6, background: "rgba(251,191,36,0.1)",
                color: "var(--yellow)", border: "1px solid rgba(251,191,36,0.2)",
              }}>
                HIGH
              </span>
            )}
          </div>
          {whaleConcentration ? (
            <>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
                <div style={{
                  fontFamily: "var(--display)", fontSize: 22, fontWeight: 700,
                  color: whaleConcentration.warning ? "var(--yellow)" : "var(--green)",
                }}>
                  {whaleConcentration.pct}%
                </div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
                  of supply held by top 10
                </div>
              </div>
              {/* Concentration bar */}
              <div style={{
                height: 12, borderRadius: 6, background: "rgba(255,255,255,0.04)",
                overflow: "hidden", marginBottom: 8,
              }}>
                <div style={{
                  height: "100%", borderRadius: 6,
                  width: `${Math.min(parseFloat(whaleConcentration.pct), 100)}%`,
                  background: whaleConcentration.warning
                    ? "linear-gradient(90deg, var(--yellow), var(--red))"
                    : "linear-gradient(90deg, var(--green), var(--naka-sky, #22d3ee))",
                  transition: "width 0.5s ease",
                }} />
              </div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
                Top 10 hold {whaleConcentration.top10Held.toLocaleString()} of {supply ? supply.toLocaleString() : "?"} total
              </div>
              {whaleConcentration.warning && (
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 9, color: "var(--yellow)",
                  marginTop: 8, padding: "6px 10px", borderRadius: 8,
                  background: "rgba(251,191,36,0.05)", border: "1px solid rgba(251,191,36,0.1)",
                }}>
                  Concentrated ownership above 30% — higher manipulation risk
                </div>
              )}
            </>
          ) : (
            <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
              No holder data available
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
