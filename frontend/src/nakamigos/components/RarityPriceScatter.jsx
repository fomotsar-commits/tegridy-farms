import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { useActiveCollection } from "../contexts/CollectionContext";
import { Eth } from "./Icons";

/* ══════════════════════════════════════════════════════════════════════
   RARITY-PRICE SCATTER PLOT
   Canvas-rendered scatter showing listed NFTs by rarity rank vs price.
   Highlights underpriced items (below trend), shows collection-specific
   overlays, zoom, tooltip, trait filter, and 24h sales toggle.
   ══════════════════════════════════════════════════════════════════════ */

/* ── Nakamigos type boundaries (approximate rank ranges) ── */
const NAKAMIGOS_TYPES = [
  { label: "Ghost", maxRank: 200, color: "rgba(168,130,255,0.25)" },
  { label: "Balloon", maxRank: 800, color: "rgba(255,200,60,0.2)" },
  { label: "Alien", maxRank: 1800, color: "rgba(80,220,160,0.18)" },
  { label: "Ape", maxRank: 3500, color: "rgba(220,160,80,0.15)" },
  { label: "Zombie", maxRank: 5500, color: "rgba(130,200,100,0.12)" },
  { label: "Bot", maxRank: 8000, color: "rgba(100,180,230,0.12)" },
  { label: "Human", maxRank: 20000, color: "rgba(200,200,200,0.08)" },
];

/* ── GNSS Art species tier bands ── */
const GNSS_TIERS = [
  { label: "Legendary", maxRank: 100, color: "rgba(255,215,0,0.25)" },
  { label: "Rare", maxRank: 500, color: "rgba(168,130,255,0.2)" },
  { label: "Uncommon", maxRank: 2000, color: "rgba(80,180,220,0.15)" },
  { label: "Common", maxRank: 9696, color: "rgba(200,200,200,0.08)" },
];

/* ── Jungle Bay legendary zone ── */
const JUNGLEBAY_TIERS = [
  { label: "Legendary", maxRank: 50, color: "rgba(255,215,0,0.25)" },
];

const DEAL_THRESHOLD = 0.15; // 15% below trend = underpriced

/* ── Linear regression ── */
function linearRegression(points) {
  const n = points.length;
  if (n < 2) return { slope: 0, intercept: 0 };
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
  for (const { x, y } of points) {
    sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x;
  }
  const denom = n * sumX2 - sumX * sumX;
  if (Math.abs(denom) < 1e-10) return { slope: 0, intercept: sumY / n };
  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;
  return { slope, intercept };
}

/* ── Pearson correlation coefficient ── */
function pearsonR(points) {
  const n = points.length;
  if (n < 3) return 0;
  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (const { x, y } of points) {
    sumX += x; sumY += y; sumXY += x * y; sumX2 += x * x; sumY2 += y * y;
  }
  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  return den === 0 ? 0 : num / den;
}

/* ── Styles ── */
const S = {
  wrapper: {
    background: "var(--surface-glass)",
    backdropFilter: "var(--glass-blur)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    marginTop: 24,
    overflow: "hidden",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "16px 20px 8px",
    flexWrap: "wrap",
    gap: 8,
  },
  title: {
    fontFamily: "var(--display)",
    fontSize: 16,
    fontWeight: 700,
    color: "var(--text)",
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 12px",
    borderRadius: 8,
    background: "rgba(46,204,113,0.15)",
    border: "1px solid rgba(46,204,113,0.4)",
    color: "var(--green, #2ecc71)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    fontWeight: 600,
  },
  controls: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    alignItems: "center",
    padding: "4px 20px 12px",
  },
  select: {
    padding: "5px 10px",
    borderRadius: 8,
    border: "1px solid var(--border)",
    background: "var(--surface)",
    color: "var(--text)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    cursor: "pointer",
    outline: "none",
  },
  toggleBtn: (active) => ({
    padding: "5px 12px",
    borderRadius: 8,
    border: `1px solid ${active ? "var(--gold)" : "var(--border)"}`,
    background: active ? "rgba(200,168,80,0.15)" : "var(--surface)",
    color: active ? "var(--gold)" : "var(--text-dim)",
    fontFamily: "var(--mono)",
    fontSize: 11,
    cursor: "pointer",
    outline: "none",
    transition: "all 0.15s",
  }),
  canvasWrap: {
    position: "relative",
    width: "100%",
    height: 440,
    cursor: "crosshair",
  },
  tooltip: {
    display: "none",
    position: "absolute",
    padding: "8px 14px",
    borderRadius: 8,
    background: "rgba(0,0,0,0.92)",
    color: "#fff",
    fontFamily: "var(--mono)",
    fontSize: 11,
    pointerEvents: "none",
    whiteSpace: "nowrap",
    zIndex: 10,
    lineHeight: 1.6,
    border: "1px solid rgba(255,255,255,0.1)",
  },
  statsPanel: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
    gap: 12,
    padding: "16px 20px 20px",
    borderTop: "1px solid var(--border)",
  },
  statCard: {
    background: "rgba(255,255,255,0.03)",
    border: "1px solid var(--border)",
    borderRadius: 10,
    padding: "12px 16px",
  },
  statLabel: {
    fontFamily: "var(--mono)",
    fontSize: 9,
    textTransform: "uppercase",
    letterSpacing: 1.5,
    color: "var(--text-muted)",
    marginBottom: 4,
  },
  statValue: {
    fontFamily: "var(--display)",
    fontSize: 16,
    fontWeight: 700,
    color: "var(--text)",
  },
};

export default function RarityPriceScatter({ tokens, listings, activities, onPick }) {
  const collection = useActiveCollection();
  const canvasRef = useRef(null);
  const tooltipRef = useRef(null);
  const pointsRef = useRef([]);
  const zoomRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  const dragRef = useRef(null);

  const [traitFilter, setTraitFilter] = useState("all");
  const [show24hSales, setShow24hSales] = useState(false);

  // Reset state on collection change
  useEffect(() => {
    setTraitFilter("all");
    setShow24hSales(false);
    zoomRef.current = { scale: 1, offsetX: 0, offsetY: 0 };
  }, [collection.slug]);

  // Build price map from listings
  const priceMap = useMemo(() => {
    const map = {};
    for (const l of listings) {
      if (l.tokenId && l.price != null) {
        map[String(l.tokenId)] = l.price;
      }
    }
    return map;
  }, [listings]);

  // Merge tokens with listing prices
  const scatterData = useMemo(() => {
    return tokens
      .filter(t => t.rank && priceMap[String(t.id)] != null)
      .filter(t => {
        if (traitFilter === "all") return true;
        const [key, value] = traitFilter.split("::");
        return t.attributes?.some(a => a.key === key && a.value === value);
      })
      .map(t => ({
        id: t.id,
        rank: t.rank,
        price: priceMap[String(t.id)],
        attributes: t.attributes || [],
        token: t,
      }));
  }, [tokens, priceMap, traitFilter]);

  // Recent 24h sales from activities
  const salesData = useMemo(() => {
    if (!show24hSales || !activities?.length) return [];
    const cutoff = Date.now() - 86400000;
    return activities
      .filter(a => a.price > 0 && a.time > cutoff && a.token?.id)
      .map(a => {
        const tok = tokens.find(t => String(t.id) === String(a.token.id));
        if (!tok?.rank) return null;
        return { id: a.token.id, rank: tok.rank, price: a.price, isSale: true };
      })
      .filter(Boolean);
  }, [show24hSales, activities, tokens]);

  // Regression + classification
  const { regression, points, underpricedCount, bestValue, quartileAvgs, correlation } = useMemo(() => {
    if (scatterData.length < 2) {
      return { regression: null, points: [], underpricedCount: 0, bestValue: null, quartileAvgs: [], correlation: 0 };
    }

    const coords = scatterData.map(d => ({ x: d.rank, y: d.price }));
    const reg = linearRegression(coords);
    const r = pearsonR(coords);

    const classified = scatterData.map(d => {
      const expected = reg.slope * d.rank + reg.intercept;
      const deviation = expected > 0 ? (d.price - expected) / expected : 0;
      let category;
      if (deviation < -DEAL_THRESHOLD) category = "underpriced";
      else if (deviation > DEAL_THRESHOLD) category = "overpriced";
      else category = "fair";
      return { ...d, expected, deviation, category };
    });

    const underpriced = classified.filter(d => d.category === "underpriced");

    // Best value: biggest discount vs trend
    let best = null;
    for (const d of underpriced) {
      if (!best || d.deviation < best.deviation) best = d;
    }

    // Quartile averages
    const sorted = [...classified].sort((a, b) => a.rank - b.rank);
    const q = Math.ceil(sorted.length / 4);
    const quartiles = [
      { label: "Top 25% (Rarest)", items: sorted.slice(0, q) },
      { label: "25-50%", items: sorted.slice(q, q * 2) },
      { label: "50-75%", items: sorted.slice(q * 2, q * 3) },
      { label: "Bottom 25%", items: sorted.slice(q * 3) },
    ];
    const qAvgs = quartiles.map(qr => ({
      label: qr.label,
      avg: qr.items.length > 0
        ? qr.items.reduce((s, d) => s + d.price, 0) / qr.items.length
        : 0,
      count: qr.items.length,
    }));

    return {
      regression: reg,
      points: classified,
      underpricedCount: underpriced.length,
      bestValue: best,
      quartileAvgs: qAvgs,
      correlation: r,
    };
  }, [scatterData]);

  // Collection-specific overlays
  const overlays = useMemo(() => {
    const slug = collection.slug;
    if (slug === "nakamigos") return NAKAMIGOS_TYPES;
    if (slug === "gnssart") return GNSS_TIERS;
    if (slug === "junglebay") return JUNGLEBAY_TIERS;
    return [];
  }, [collection.slug]);

  // Trait categories for filter
  const traitOptions = useMemo(() => {
    const map = {};
    for (const t of tokens) {
      for (const a of t.attributes || []) {
        const k = `${a.key}::${a.value}`;
        map[k] = (map[k] || 0) + 1;
      }
    }
    // Group by trait key
    const groups = {};
    for (const [kv, count] of Object.entries(map)) {
      const [key] = kv.split("::");
      if (!groups[key]) groups[key] = [];
      groups[key].push({ kv, count });
    }
    return groups;
  }, [tokens]);

  // ── Canvas draw ──
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || points.length === 0) return;
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);
    const w = rect.width;
    const h = rect.height;
    const pad = { top: 24, right: 36, bottom: 48, left: 68 };

    const { scale, offsetX, offsetY } = zoomRef.current;

    ctx.clearRect(0, 0, w, h);

    // Compute data bounds
    const allX = points.map(d => d.rank);
    const allY = points.map(d => d.price);
    if (salesData.length > 0) {
      allX.push(...salesData.map(d => d.rank));
      allY.push(...salesData.map(d => d.price));
    }
    const xMin = Math.min(...allX);
    const xMax = Math.max(...allX);
    const yMin = Math.min(...allY) * 0.9;
    const yMax = Math.max(...allY) * 1.1;

    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Scale functions with zoom
    const scaleX = (v) => {
      const base = pad.left + ((v - xMin) / (xMax - xMin || 1)) * plotW;
      return (base - w / 2) * scale + w / 2 + offsetX;
    };
    const scaleY = (v) => {
      const base = h - pad.bottom - ((v - yMin) / (yMax - yMin || 1)) * plotH;
      return (base - h / 2) * scale + h / 2 + offsetY;
    };

    // Clip to plot area
    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.left - 2, pad.top - 2, plotW + 4, plotH + 4);
    ctx.clip();

    // Collection-specific overlay bands
    for (const overlay of overlays) {
      const x1 = scaleX(0);
      const x2 = scaleX(overlay.maxRank);
      ctx.fillStyle = overlay.color;
      ctx.fillRect(x1, pad.top, x2 - x1, plotH);

      // Label
      ctx.fillStyle = "rgba(255,255,255,0.2)";
      ctx.font = "9px monospace";
      ctx.textAlign = "center";
      const midX = (x1 + x2) / 2;
      if (midX > pad.left && midX < w - pad.right) {
        ctx.fillText(overlay.label, midX, pad.top + 14);
      }

      // Dashed boundary line
      ctx.strokeStyle = "rgba(255,255,255,0.12)";
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x2, pad.top);
      ctx.lineTo(x2, h - pad.bottom);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.05)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const yVal = yMin + (yMax - yMin) * (i / 5);
      const py = scaleY(yVal);
      if (py >= pad.top && py <= h - pad.bottom) {
        ctx.beginPath();
        ctx.moveTo(pad.left, py);
        ctx.lineTo(w - pad.right, py);
        ctx.stroke();
      }
    }
    for (let i = 0; i <= 5; i++) {
      const xVal = xMin + (xMax - xMin) * (i / 5);
      const px = scaleX(xVal);
      if (px >= pad.left && px <= w - pad.right) {
        ctx.beginPath();
        ctx.moveTo(px, pad.top);
        ctx.lineTo(px, h - pad.bottom);
        ctx.stroke();
      }
    }

    // Trend line (dashed)
    if (regression) {
      ctx.strokeStyle = "rgba(255,255,255,0.2)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(scaleX(xMin), scaleY(regression.slope * xMin + regression.intercept));
      ctx.lineTo(scaleX(xMax), scaleY(regression.slope * xMax + regression.intercept));
      ctx.stroke();
      ctx.setLineDash([]);

      // Underpriced zone (15% below trend) — subtle fill
      ctx.fillStyle = "rgba(46,204,113,0.04)";
      ctx.beginPath();
      const steps = 40;
      for (let i = 0; i <= steps; i++) {
        const xVal = xMin + (xMax - xMin) * (i / steps);
        const trendY = regression.slope * xVal + regression.intercept;
        const belowY = trendY * (1 - DEAL_THRESHOLD);
        const px = scaleX(xVal);
        const py = scaleY(belowY);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.lineTo(scaleX(xMax), scaleY(yMin));
      ctx.lineTo(scaleX(xMin), scaleY(yMin));
      ctx.closePath();
      ctx.fill();
    }

    // 24h sales (faded dots)
    for (const d of salesData) {
      const px = scaleX(d.rank);
      const py = scaleY(d.price);
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,200,60,0.25)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,200,60,0.4)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Points
    const drawnPoints = [];
    for (const d of points) {
      const px = scaleX(d.rank);
      const py = scaleY(d.price);
      drawnPoints.push({ px, py, data: d });

      const isDeal = d.category === "underpriced";
      const isOverpriced = d.category === "overpriced";
      const radius = isDeal ? 5 : 3;

      if (isDeal) {
        // Green glow
        ctx.shadowColor = "rgba(46,204,113,0.6)";
        ctx.shadowBlur = 10;
      }

      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);

      if (isDeal) {
        ctx.fillStyle = "rgba(46,204,113,0.85)";
        ctx.strokeStyle = "#2ecc71";
        ctx.lineWidth = 1.5;
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;
      } else if (isOverpriced) {
        ctx.fillStyle = "rgba(231,76,60,0.5)";
        ctx.fill();
      } else {
        ctx.fillStyle = "rgba(111,168,220,0.5)";
        ctx.fill();
      }
    }
    pointsRef.current = drawnPoints;

    ctx.restore();

    // Axes labels
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.font = "10px monospace";
    ctx.textAlign = "center";
    ctx.fillText("Rarity Rank (1 = rarest)", w / 2, h - 8);
    ctx.save();
    ctx.translate(14, h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Price (ETH)", 0, 0);
    ctx.restore();

    // Y-axis tick labels
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "10px monospace";
    ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const yVal = yMin + (yMax - yMin) * (i / 5);
      const py = scaleY(yVal);
      if (py >= pad.top && py <= h - pad.bottom) {
        ctx.fillText(yVal.toFixed(3), pad.left - 8, py + 3);
      }
    }

    // X-axis tick labels
    ctx.textAlign = "center";
    for (let i = 0; i <= 5; i++) {
      const xVal = xMin + (xMax - xMin) * (i / 5);
      const px = scaleX(xVal);
      if (px >= pad.left && px <= w - pad.right) {
        ctx.fillText(Math.round(xVal).toLocaleString(), px, h - pad.bottom + 16);
      }
    }

    // Legend
    const legendY = h - 10;
    const legendX = w - pad.right;
    ctx.textAlign = "right";
    ctx.font = "9px monospace";
    ctx.fillStyle = "rgba(46,204,113,0.85)";
    ctx.fillRect(legendX - 130, legendY - 6, 8, 8);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText("Underpriced", legendX - 75, legendY + 1);

    ctx.fillStyle = "rgba(231,76,60,0.5)";
    ctx.fillRect(legendX - 68, legendY - 6, 8, 8);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.fillText("Overpriced", legendX - 15, legendY + 1);

    if (salesData.length > 0) {
      ctx.fillStyle = "rgba(255,200,60,0.4)";
      ctx.fillRect(legendX - 200, legendY - 6, 8, 8);
      ctx.fillStyle = "rgba(255,255,255,0.4)";
      ctx.textAlign = "right";
      ctx.fillText("24h Sales", legendX - 145, legendY + 1);
    }
  }, [points, salesData, regression, overlays]);

  useEffect(() => {
    draw();
    const handler = () => draw();
    window.addEventListener("resize", handler);
    return () => window.removeEventListener("resize", handler);
  }, [draw]);

  // ── Zoom via scroll ──
  const handleWheel = useCallback((e) => {
    e.preventDefault();
    const zoom = zoomRef.current;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(1, Math.min(10, zoom.scale * delta));
    // Zoom toward mouse position
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const newOffsetX = mx - (mx - zoom.offsetX) * (newScale / zoom.scale);
    const newOffsetY = my - (my - zoom.offsetY) * (newScale / zoom.scale);
    zoomRef.current = { scale: newScale, offsetX: newScale === 1 ? 0 : newOffsetX, offsetY: newScale === 1 ? 0 : newOffsetY };
    draw();
  }, [draw]);

  // ── Pan via drag ──
  const handleMouseDown = useCallback((e) => {
    if (zoomRef.current.scale <= 1) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, startOX: zoomRef.current.offsetX, startOY: zoomRef.current.offsetY };
  }, []);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  const handleMouseMove = useCallback((e) => {
    // Pan
    if (dragRef.current) {
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      zoomRef.current.offsetX = dragRef.current.startOX + dx;
      zoomRef.current.offsetY = dragRef.current.startOY + dy;
      draw();
      return;
    }

    // Tooltip
    const canvas = canvasRef.current;
    const tooltip = tooltipRef.current;
    if (!canvas || !tooltip) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    for (const p of pointsRef.current) {
      const dist = Math.hypot(p.px - mx, p.py - my);
      if (dist < 10) {
        const d = p.data;
        const type = d.attributes.find(a => a.key === "Type" || a.key === "Species" || a.key === "Background")?.value || "";
        const discountPct = d.deviation != null ? (d.deviation * -100).toFixed(1) : "0.0";
        const sign = d.deviation < 0 ? "" : "+";

        tooltip.style.display = "block";
        // Position tooltip avoiding edge overflow
        const tx = p.px + 14 + 200 > rect.width ? p.px - 200 : p.px + 14;
        const ty = Math.max(10, Math.min(p.py - 20, rect.height - 80));
        tooltip.style.left = `${tx}px`;
        tooltip.style.top = `${ty}px`;
        tooltip.innerHTML =
          `<strong>#${d.id}</strong><br/>` +
          `Price: ${(d.price ?? 0).toFixed(4)} ETH<br/>` +
          `Rank: #${d.rank.toLocaleString()}<br/>` +
          (type ? `Type: ${type}<br/>` : "") +
          `vs Trend: ${sign}${discountPct}%`;
        canvas.style.cursor = "pointer";
        return;
      }
    }
    tooltip.style.display = "none";
    canvas.style.cursor = zoomRef.current.scale > 1 ? "grab" : "crosshair";
  }, [draw]);

  // ── Click to open NFT modal ──
  const handleClick = useCallback((e) => {
    if (!onPick) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    for (const p of pointsRef.current) {
      if (Math.hypot(p.px - mx, p.py - my) < 10) {
        onPick(p.data.token);
        return;
      }
    }
  }, [onPick]);

  // Attach non-passive wheel handler
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // ── Empty state ──
  if (points.length < 3) {
    return (
      <div style={S.wrapper}>
        <div style={S.header}>
          <div style={S.title}>Rarity vs Price</div>
        </div>
        <div style={{
          textAlign: "center", padding: "40px 20px", fontFamily: "var(--mono)",
          fontSize: 12, color: "var(--text-muted)",
        }}>
          Need at least 3 listed items with rarity data to render scatter plot.
          <br />
          <span style={{ fontSize: 10, color: "var(--text-dim)" }}>
            Load more tokens or wait for listing data.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div style={S.wrapper}>
      {/* Header */}
      <div style={S.header}>
        <div style={S.title}>Rarity vs Price</div>
        {underpricedCount > 0 && (
          <div style={S.badge}>
            {underpricedCount} underpriced item{underpricedCount !== 1 ? "s" : ""} found
          </div>
        )}
      </div>

      {/* Controls */}
      <div style={S.controls}>
        {/* Trait filter */}
        <select
          value={traitFilter}
          onChange={(e) => setTraitFilter(e.target.value)}
          style={S.select}
        >
          <option value="all">All Traits</option>
          {Object.entries(traitOptions).map(([key, values]) => (
            <optgroup key={key} label={key}>
              {values.sort((a, b) => b.count - a.count).slice(0, 20).map(({ kv, count }) => {
                const val = kv.split("::")[1];
                return <option key={kv} value={kv}>{val} ({count})</option>;
              })}
            </optgroup>
          ))}
        </select>

        {/* 24h sales toggle */}
        {activities?.length > 0 && (
          <button
            style={S.toggleBtn(show24hSales)}
            onClick={() => setShow24hSales(!show24hSales)}
          >
            24h Sales
          </button>
        )}

        {/* Zoom reset */}
        {zoomRef.current.scale > 1 && (
          <button
            style={S.toggleBtn(false)}
            onClick={() => { zoomRef.current = { scale: 1, offsetX: 0, offsetY: 0 }; draw(); }}
          >
            Reset Zoom
          </button>
        )}

        <div style={{ marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
          {points.length} listed &middot; scroll to zoom
        </div>
      </div>

      {/* Canvas */}
      <div style={S.canvasWrap}>
        <canvas
          ref={canvasRef}
          style={{ width: "100%", height: "100%", display: "block" }}
          onClick={handleClick}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            dragRef.current = null;
            if (tooltipRef.current) tooltipRef.current.style.display = "none";
          }}
        />
        <div ref={tooltipRef} style={S.tooltip} />
      </div>

      {/* Stats Panel */}
      <div style={S.statsPanel}>
        {/* Quartile averages */}
        {quartileAvgs.map((q) => (
          <div key={q.label} style={S.statCard}>
            <div style={S.statLabel}>{q.label}</div>
            <div style={S.statValue}>
              <Eth size={12} /> {q.avg.toFixed(4)}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", marginTop: 2 }}>
              {q.count} item{q.count !== 1 ? "s" : ""}
            </div>
          </div>
        ))}

        {/* Correlation */}
        <div style={S.statCard}>
          <div style={S.statLabel}>Rank-Price Correlation</div>
          <div style={{
            ...S.statValue,
            color: Math.abs(correlation) > 0.5 ? "var(--gold)" : "var(--text-dim)",
          }}>
            {correlation.toFixed(3)}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", marginTop: 2 }}>
            {Math.abs(correlation) > 0.7 ? "Strong" : Math.abs(correlation) > 0.4 ? "Moderate" : "Weak"} correlation
          </div>
        </div>

        {/* Best value */}
        {bestValue && (
          <div
            style={{ ...S.statCard, borderColor: "rgba(46,204,113,0.3)", cursor: onPick ? "pointer" : "default" }}
            onClick={() => onPick?.(bestValue.token)}
          >
            <div style={S.statLabel}>Best Value</div>
            <div style={{ ...S.statValue, color: "var(--green, #2ecc71)" }}>
              #{bestValue.id}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
              <Eth size={10} /> {bestValue.price.toFixed(4)} &middot; {(bestValue.deviation * -100).toFixed(0)}% below trend
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
