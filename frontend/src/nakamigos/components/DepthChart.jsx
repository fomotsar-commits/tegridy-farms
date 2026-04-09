import { useMemo, useState, useRef, useCallback } from "react";
import { Eth } from "./Icons";

// ═══ DEPTH CHART / ORDERBOOK VISUALIZATION ═══
// Pure SVG stepped area chart — no external chart library.
// Shows cumulative listing depth (ask) and bid depth side by side
// with spread indicator, floor thickness, and auto-generated summary.

const CHART_W = 600;
const CHART_H = 220;
const PAD = { top: 20, right: 20, bottom: 36, left: 50 };
const INNER_W = CHART_W - PAD.left - PAD.right;
const INNER_H = CHART_H - PAD.top - PAD.bottom;

function bucketPrices(prices, count = 12) {
  if (!prices.length) return [];
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  if (max === min) return [{ price: min, count: prices.length, cumulative: prices.length }];
  const step = (max - min) / count;
  const buckets = [];
  for (let i = 0; i < count; i++) {
    const lo = min + i * step;
    const hi = lo + step;
    const n = prices.filter(v => v >= lo && (i === count - 1 ? v <= hi : v < hi)).length;
    buckets.push({ price: +(lo + step / 2).toFixed(5), lo, hi, count: n });
  }
  // cumulative
  let cum = 0;
  for (const b of buckets) { cum += b.count; b.cumulative = cum; }
  return buckets;
}

function computeSpread(floorPrice, bestBid) {
  if (!floorPrice || !bestBid || floorPrice <= 0) return null;
  const abs = floorPrice - bestBid;
  const pct = (abs / floorPrice) * 100;
  let health = "green";
  if (pct >= 15) health = "red";
  else if (pct >= 5) health = "yellow";
  return { abs, pct, health };
}

function floorThickness(listings, floorPrice) {
  if (!listings.length || !floorPrice || floorPrice <= 0) return null;
  const threshold = floorPrice * 1.05;
  const nearFloor = listings.filter(l => l.price != null && l.price <= threshold);
  if (nearFloor.length >= 50) return "thick";
  if (nearFloor.length < 5) {
    // Check gap to next tier
    const sorted = listings.map(l => l.price).filter(Boolean).sort((a, b) => a - b);
    if (sorted.length >= 2) {
      const gap = sorted[Math.min(nearFloor.length, sorted.length - 1)] - sorted[0];
      if (gap > floorPrice * 0.05) return "thin";
    }
    return "thin";
  }
  return "moderate";
}

function generateSummary(askBuckets, bidBuckets, spread, thickness) {
  const parts = [];

  // Bid interest
  const totalBids = bidBuckets.length > 0 ? bidBuckets[bidBuckets.length - 1]?.cumulative || 0 : 0;
  if (totalBids > 10) parts.push("Strong buying interest near floor");
  else if (totalBids > 3) parts.push("Moderate bid support");
  else if (totalBids > 0) parts.push("Light bid activity");
  else parts.push("No active bids");

  // Spread
  if (spread) {
    const pctStr = spread.pct.toFixed(1);
    if (spread.health === "green") parts.push(`Price gap is narrow (${pctStr}%), suggesting healthy trading`);
    else if (spread.health === "yellow") parts.push(`Price gap is moderate (${pctStr}%), watch for volatility`);
    else parts.push(`Price gap is wide (${pctStr}%), low liquidity zone`);
  }

  // Floor thickness
  if (thickness === "thick") parts.push("Thick floor with 50+ items within 5%");
  else if (thickness === "thin") parts.push("Thin floor with a gap to the next tier");

  return parts.join(". ") + ".";
}

// Health color mapping
const HEALTH_COLORS = {
  green: "var(--green)",
  yellow: "var(--yellow)",
  red: "var(--red)",
};

export default function DepthChart({ listings = [], offers = [], floorPrice, collection }) {
  const svgRef = useRef(null);
  const [tooltip, setTooltip] = useState(null);

  const {
    askBuckets,
    bidBuckets,
    spread,
    thickness,
    summary,
    bestBid,
    maxCum,
    priceMin,
    priceMax,
  } = useMemo(() => {
    const askPrices = listings
      .map(l => l.price)
      .filter(p => p != null && p > 0)
      .sort((a, b) => a - b);

    const bidPrices = offers
      .map(o => o.price)
      .filter(p => p != null && p > 0)
      .sort((a, b) => b - a);

    const askB = bucketPrices(askPrices, 12);
    const bidB = bucketPrices(bidPrices, 12);

    const bestBid = bidPrices[0] || 0;
    const spread = computeSpread(floorPrice, bestBid);
    const thickness = floorThickness(listings, floorPrice);

    const maxAsk = askB.length > 0 ? askB[askB.length - 1].cumulative : 0;
    const maxBid = bidB.length > 0 ? bidB[bidB.length - 1].cumulative : 0;
    const maxCum = Math.max(maxAsk, maxBid, 1);

    // Combined price range
    const allPrices = [
      ...(askB.length ? [askB[0].lo, askB[askB.length - 1].hi] : []),
      ...(bidB.length ? [bidB[0].lo, bidB[bidB.length - 1].hi] : []),
    ];
    const priceMin = allPrices.length > 0 ? Math.min(...allPrices) : 0;
    const priceMax = allPrices.length > 0 ? Math.max(...allPrices) : 1;

    const summary = generateSummary(askB, bidB, spread, thickness);

    return { askBuckets: askB, bidBuckets: bidB, spread, thickness, summary, bestBid, maxCum, priceMin, priceMax };
  }, [listings, offers, floorPrice]);

  // Scale helpers
  const priceRange = priceMax - priceMin || 1;
  const xScale = useCallback((price) => PAD.left + ((price - priceMin) / priceRange) * INNER_W, [priceMin, priceRange]);
  const yScale = useCallback((cum) => PAD.top + INNER_H - (cum / maxCum) * INNER_H, [maxCum]);

  // Build stepped path for ask side (left to right, cumulative ascending)
  const askPath = useMemo(() => {
    if (!askBuckets.length) return "";
    const pts = [];
    pts.push(`M ${xScale(askBuckets[0].lo)} ${yScale(0)}`);
    for (const b of askBuckets) {
      pts.push(`L ${xScale(b.lo)} ${yScale(b.cumulative)}`);
      pts.push(`L ${xScale(b.hi)} ${yScale(b.cumulative)}`);
    }
    pts.push(`L ${xScale(askBuckets[askBuckets.length - 1].hi)} ${yScale(0)}`);
    pts.push("Z");
    return pts.join(" ");
  }, [askBuckets, xScale, yScale]);

  // Build stepped path for bid side (right to left, cumulative ascending)
  const bidPath = useMemo(() => {
    if (!bidBuckets.length) return "";
    // bidBuckets are already sorted high-to-low by price
    const sorted = [...bidBuckets].sort((a, b) => b.price - a.price);
    const pts = [];
    pts.push(`M ${xScale(sorted[0].hi)} ${yScale(0)}`);
    let cum = 0;
    for (const b of sorted) {
      cum += b.count;
      pts.push(`L ${xScale(b.hi)} ${yScale(cum)}`);
      pts.push(`L ${xScale(b.lo)} ${yScale(cum)}`);
    }
    pts.push(`L ${xScale(sorted[sorted.length - 1].lo)} ${yScale(0)}`);
    pts.push("Z");
    return pts.join(" ");
  }, [bidBuckets, xScale, yScale]);

  // Generate tick labels for x-axis
  const xTicks = useMemo(() => {
    const count = 6;
    const step = priceRange / count;
    const ticks = [];
    for (let i = 0; i <= count; i++) {
      const price = priceMin + i * step;
      ticks.push({ price, x: xScale(price) });
    }
    return ticks;
  }, [priceMin, priceRange, xScale]);

  // Y-axis ticks
  const yTicks = useMemo(() => {
    const count = 4;
    const step = maxCum / count;
    const ticks = [];
    for (let i = 0; i <= count; i++) {
      const val = Math.round(i * step);
      ticks.push({ val, y: yScale(val) });
    }
    return ticks;
  }, [maxCum, yScale]);

  const handleMouseMove = useCallback((e) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const scaleX = CHART_W / rect.width;
    const mouseX = (e.clientX - rect.left) * scaleX;
    const mouseY = (e.clientY - rect.top) * (CHART_H / rect.height);

    // Map back to price
    const price = priceMin + ((mouseX - PAD.left) / INNER_W) * priceRange;

    // Find matching bucket
    const allBuckets = [...askBuckets.map(b => ({ ...b, side: "ask" })), ...bidBuckets.map(b => ({ ...b, side: "bid" }))];
    const hit = allBuckets.find(b => price >= b.lo && price < b.hi);
    if (hit && mouseX >= PAD.left && mouseX <= PAD.left + INNER_W && mouseY >= PAD.top && mouseY <= PAD.top + INNER_H) {
      const totalEth = hit.price * hit.cumulative;
      setTooltip({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
        price: hit.price,
        count: hit.count,
        cumulative: hit.cumulative,
        totalEth,
        side: hit.side,
      });
    } else {
      setTooltip(null);
    }
  }, [askBuckets, bidBuckets, priceMin, priceRange]);

  const handleMouseLeave = useCallback(() => setTooltip(null), []);

  const hasData = askBuckets.length > 0 || bidBuckets.length > 0;

  if (!hasData) {
    return (
      <div className="depth-chart-panel">
        <div className="depth-chart-header">
          <h3>Depth Chart</h3>
        </div>
        <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
          Not enough listing or bid data to render depth chart
        </div>
      </div>
    );
  }

  return (
    <div className="depth-chart-panel">
      <div className="depth-chart-header">
        <h3>Depth Chart</h3>
        {thickness && (
          <span className={`depth-chip depth-chip--${thickness}`}>
            {thickness === "thick" ? "Thick Floor" : thickness === "thin" ? "Thin Floor" : "Moderate Floor"}
          </span>
        )}
      </div>

      {/* SVG Chart */}
      <div className="depth-chart-container" onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          className="depth-chart-svg"
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Grid lines */}
          {yTicks.map((t, i) => (
            <line key={i} x1={PAD.left} x2={PAD.left + INNER_W} y1={t.y} y2={t.y}
              stroke="var(--border)" strokeWidth="0.5" strokeDasharray="4 4" />
          ))}

          {/* Bid area (green/teal) */}
          {bidPath && (
            <path d={bidPath} fill="rgba(74, 222, 128, 0.15)" stroke="var(--green)" strokeWidth="1.5" />
          )}

          {/* Ask area (red/orange) */}
          {askPath && (
            <path d={askPath} fill="rgba(255, 100, 100, 0.15)" stroke="var(--red)" strokeWidth="1.5" />
          )}

          {/* Spread zone */}
          {spread && bestBid > 0 && floorPrice > 0 && (
            <rect
              x={xScale(bestBid)}
              y={PAD.top}
              width={Math.max(xScale(floorPrice) - xScale(bestBid), 0)}
              height={INNER_H}
              fill={`${HEALTH_COLORS[spread.health]}08`}
              stroke={HEALTH_COLORS[spread.health]}
              strokeWidth="0.5"
              strokeDasharray="4 2"
            />
          )}

          {/* Floor price line */}
          {floorPrice > 0 && floorPrice >= priceMin && floorPrice <= priceMax && (
            <>
              <line
                x1={xScale(floorPrice)} x2={xScale(floorPrice)}
                y1={PAD.top} y2={PAD.top + INNER_H}
                stroke="var(--gold)" strokeWidth="1" strokeDasharray="6 3"
              />
              <text x={xScale(floorPrice)} y={PAD.top - 6}
                textAnchor="middle" fill="var(--gold)" fontSize="8"
                fontFamily="var(--mono)" fontWeight="600">
                FLOOR
              </text>
            </>
          )}

          {/* Best bid line */}
          {bestBid > 0 && bestBid >= priceMin && bestBid <= priceMax && (
            <>
              <line
                x1={xScale(bestBid)} x2={xScale(bestBid)}
                y1={PAD.top} y2={PAD.top + INNER_H}
                stroke="var(--green)" strokeWidth="1" strokeDasharray="6 3"
              />
              <text x={xScale(bestBid)} y={PAD.top - 6}
                textAnchor="middle" fill="var(--green)" fontSize="8"
                fontFamily="var(--mono)" fontWeight="600">
                BEST BID
              </text>
            </>
          )}

          {/* X-axis labels */}
          {xTicks.map((t, i) => (
            <text key={i} x={t.x} y={PAD.top + INNER_H + 16}
              textAnchor="middle" fill="var(--text-muted)" fontSize="7"
              fontFamily="var(--mono)">
              {t.price.toFixed(3)}
            </text>
          ))}
          <text x={PAD.left + INNER_W / 2} y={CHART_H - 2}
            textAnchor="middle" fill="var(--text-dim)" fontSize="7"
            fontFamily="var(--mono)" letterSpacing="0.06em">
            PRICE (ETH)
          </text>

          {/* Y-axis labels */}
          {yTicks.map((t, i) => (
            <text key={i} x={PAD.left - 6} y={t.y + 3}
              textAnchor="end" fill="var(--text-muted)" fontSize="7"
              fontFamily="var(--mono)">
              {t.val}
            </text>
          ))}
          <text x={12} y={PAD.top + INNER_H / 2}
            textAnchor="middle" fill="var(--text-dim)" fontSize="7"
            fontFamily="var(--mono)" letterSpacing="0.06em"
            transform={`rotate(-90, 12, ${PAD.top + INNER_H / 2})`}>
            CUMULATIVE
          </text>

          {/* Legend */}
          <rect x={PAD.left + 8} y={PAD.top + 4} width={8} height={8} rx="1" fill="rgba(255, 100, 100, 0.4)" stroke="var(--red)" strokeWidth="0.5" />
          <text x={PAD.left + 20} y={PAD.top + 11} fill="var(--text-dim)" fontSize="7" fontFamily="var(--mono)">Listings</text>
          <rect x={PAD.left + 68} y={PAD.top + 4} width={8} height={8} rx="1" fill="rgba(74, 222, 128, 0.4)" stroke="var(--green)" strokeWidth="0.5" />
          <text x={PAD.left + 80} y={PAD.top + 11} fill="var(--text-dim)" fontSize="7" fontFamily="var(--mono)">Bids</text>
        </svg>

        {/* Tooltip */}
        {tooltip && (
          <div
            className="depth-chart-tooltip"
            style={{
              left: tooltip.x + 12,
              top: tooltip.y - 10,
            }}
          >
            <div className="depth-tooltip-row">
              <span className="depth-tooltip-label">Side</span>
              <span style={{ color: tooltip.side === "bid" ? "var(--green)" : "var(--red)" }}>
                {tooltip.side === "bid" ? "Bid" : "Ask"}
              </span>
            </div>
            <div className="depth-tooltip-row">
              <span className="depth-tooltip-label">Price</span>
              <span><Eth size={8} /> {tooltip.price.toFixed(4)}</span>
            </div>
            <div className="depth-tooltip-row">
              <span className="depth-tooltip-label">At Level</span>
              <span>{tooltip.count}</span>
            </div>
            <div className="depth-tooltip-row">
              <span className="depth-tooltip-label">Cumulative</span>
              <span>{tooltip.cumulative}</span>
            </div>
            <div className="depth-tooltip-row">
              <span className="depth-tooltip-label">Total ETH</span>
              <span><Eth size={8} /> {tooltip.totalEth.toFixed(2)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Spread Indicator */}
      {spread && (
        <div className="depth-spread-bar">
          <span className="depth-spread-label">SPREAD</span>
          <span className="depth-spread-value" style={{ color: HEALTH_COLORS[spread.health] }}>
            {spread.abs.toFixed(4)} ETH ({spread.pct.toFixed(1)}%)
          </span>
          <span className="depth-spread-dot" style={{ background: HEALTH_COLORS[spread.health] }} />
          <span className="depth-spread-health" style={{ color: HEALTH_COLORS[spread.health] }}>
            {spread.health === "green" ? "Healthy" : spread.health === "yellow" ? "Moderate" : "Wide"}
          </span>
        </div>
      )}

      {/* Auto-generated summary */}
      <div className="depth-summary">{summary}</div>
    </div>
  );
}
