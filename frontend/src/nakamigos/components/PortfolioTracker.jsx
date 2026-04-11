import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { fetchWalletNfts, fetchCollectionStats } from "../api";
import { calculatePnL, saveSnapshot, loadSnapshots } from "../lib/portfolio";
import { formatPrice } from "../lib/formatPrice";
import { Eth } from "./Icons";
import Skeleton from "./Skeleton";
import { useActiveCollection } from "../contexts/CollectionContext";

// ── Helpers ────────────────────────────────────────────────────
function pnlColor(value) {
  if (value > 0) return "var(--green, #4ade80)";
  if (value < 0) return "var(--red, #f87171)";
  return "var(--text-dim)";
}

function pnlSign(value) {
  if (value > 0) return "+";
  return "";
}

function formatDays(days) {
  if (days == null) return "N/A";
  if (days === 0) return "<1d";
  if (days >= 365) return `${Math.floor(days / 365)}y ${days % 365}d`;
  return `${days}d`;
}

// TODO: Fetch live ETH/USD price from CoinGecko or use the PriceContext.
// This is a display-only estimate used for USD approximations in the portfolio view.
const ETH_USD_ESTIMATE = 3200;

// ── Mini Canvas Line Chart ─────────────────────────────────────
function ValueChart({ snapshots }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || snapshots.length < 2) return;

    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const values = snapshots.map(s => s.value);
    const min = Math.min(...values) * 0.95;
    const max = Math.max(...values) * 1.05 || 1;
    const range = max - min || 1;

    // Background
    ctx.clearRect(0, 0, w, h);

    // Grid lines
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let i = 0; i < 4; i++) {
      const y = (h / 4) * i;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // Line
    const isUp = values[values.length - 1] >= values[0];
    const lineColor = isUp ? "#4ade80" : "#f87171";

    ctx.beginPath();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";

    for (let i = 0; i < values.length; i++) {
      const x = (i / (values.length - 1)) * w;
      const y = h - ((values[i] - min) / range) * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Gradient fill under line
    const gradient = ctx.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, isUp ? "rgba(74,222,128,0.15)" : "rgba(248,113,113,0.15)");
    gradient.addColorStop(1, "rgba(0,0,0,0)");

    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    // Date labels
    ctx.fillStyle = "rgba(255,255,255,0.3)";
    ctx.font = "9px monospace";
    ctx.textAlign = "center";
    if (snapshots.length > 1) {
      ctx.fillText(snapshots[0].date.slice(5), 30, h - 4);
      ctx.fillText(snapshots[snapshots.length - 1].date.slice(5), w - 30, h - 4);
    }
  }, [snapshots]);

  if (snapshots.length < 2) {
    return (
      <div style={{
        height: 120, display: "flex", alignItems: "center", justifyContent: "center",
        color: "var(--text-dim)", fontFamily: "var(--mono)", fontSize: 11,
      }}>
        Not enough data yet. Check back tomorrow.
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      style={{ width: "100%", height: 120, borderRadius: 8 }}
    />
  );
}

// ── Main Component ─────────────────────────────────────────────
export default function PortfolioTracker({ wallet, onConnect, onPick, addToast }) {
  const collection = useActiveCollection();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [pnlData, setPnlData] = useState(null);
  const [tokens, setTokens] = useState([]);
  const [stats, setStats] = useState(null);
  const [expandedCollection, setExpandedCollection] = useState(false);
  const [snapshots, setSnapshots] = useState(() => wallet ? loadSnapshots(wallet, collection.contract) : []);
  const genRef = useRef(0);

  // Re-load snapshots when wallet or collection changes
  useEffect(() => {
    setSnapshots(wallet ? loadSnapshots(wallet, collection.contract) : []);
  }, [wallet, collection.contract]);

  const loadPortfolio = useCallback(async () => {
    if (!wallet) return;
    const gen = ++genRef.current;
    setLoading(true);
    setError(null);

    try {
      // Fetch wallet NFTs and collection stats in parallel
      const [nftData, statsData] = await Promise.all([
        fetchWalletNfts(wallet, collection.contract, collection.metadataBase),
        fetchCollectionStats({
          contract: collection.contract,
          slug: collection.slug,
          openseaSlug: collection.openseaSlug,
        }),
      ]);

      if (gen !== genRef.current) return;

      setTokens(nftData.tokens);
      setStats(statsData);

      if (nftData.tokens.length === 0) {
        setPnlData(null);
        setLoading(false);
        return;
      }

      // Calculate P&L
      const result = await calculatePnL(wallet, {
        contract: collection.contract,
        name: collection.name,
        floorPrice: statsData.floor,
      }, nftData.tokens);

      if (gen !== genRef.current) return;

      setPnlData(result);

      // Save daily snapshot
      if (result.currentValue > 0) {
        saveSnapshot(result.currentValue, wallet, collection.contract);
        if (gen === genRef.current) {
          setSnapshots(loadSnapshots(wallet, collection.contract));
        }
      }
    } catch (err) {
      if (gen !== genRef.current) return;
      console.warn("Portfolio load error:", err.message);
      setError("Failed to load portfolio data. Please try again.");
    } finally {
      if (gen === genRef.current) setLoading(false);
    }
  }, [wallet, collection.contract, collection.metadataBase, collection.slug, collection.openseaSlug, collection.name]);

  useEffect(() => {
    loadPortfolio();
  }, [loadPortfolio]);

  // Sorted performers
  const { topGainers, topLosers } = useMemo(() => {
    if (!pnlData?.tokenDetails?.length) return { topGainers: [], topLosers: [] };
    const sorted = [...pnlData.tokenDetails]
      .filter(t => t.costBasis > 0)
      .sort((a, b) => b.pnlPercent - a.pnlPercent);
    return {
      topGainers: sorted.slice(0, 3),
      topLosers: sorted.slice(-3).reverse(),
    };
  }, [pnlData]);

  // ── Not connected ──
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
            Connect your wallet to track your {collection.name} portfolio P&L.
          </p>
          <button className="btn-primary wallet-connect-btn" onClick={onConnect}>
            Connect Wallet
          </button>
        </div>
      </section>
    );
  }

  // ── Loading ──
  if (loading) {
    return (
      <section className="my-collection-section" style={{ padding: "32px" }}>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 28, fontWeight: 600, color: "var(--text)", marginBottom: 24 }}>
          Portfolio P&L
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 10 }}>
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="analytics-stat-card">
              <Skeleton count={1} view="list" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  // ── Error ──
  if (error) {
    return (
      <section className="my-collection-section" style={{ padding: "32px" }}>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 28, fontWeight: 600, color: "var(--text)", marginBottom: 16 }}>
          Portfolio P&L
        </h2>
        <div className="error-banner">
          <span>{error}</span>
          <button onClick={loadPortfolio}>Retry</button>
        </div>
      </section>
    );
  }

  // ── No holdings ──
  if (!pnlData || tokens.length === 0) {
    return (
      <section className="my-collection-section" style={{ padding: "32px" }}>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 28, fontWeight: 600, color: "var(--text)", marginBottom: 16 }}>
          Portfolio P&L
        </h2>
        <div className="my-collection-empty" style={{ paddingTop: 40 }}>
          <div className="my-collection-empty-icon">0</div>
          <h3 style={{ fontFamily: "var(--display)", fontSize: 16, color: "var(--text-dim)", fontWeight: 500 }}>
            No {collection.name} Found
          </h3>
          <p style={{ fontFamily: "var(--display)", fontSize: 13, color: "var(--text-dim)", marginTop: 8 }}>
            This wallet doesn't hold any {collection.name} NFTs to track.
          </p>
        </div>
      </section>
    );
  }

  const totalPnL = pnlData.unrealizedPnL + pnlData.realizedPnL;
  const totalPnLUsd = totalPnL * ETH_USD_ESTIMATE;
  const currentValueUsd = pnlData.currentValue * ETH_USD_ESTIMATE;

  return (
    <section className="my-collection-section portfolio-section">
      {/* Title */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24 }}>
        <h2 style={{ fontFamily: "var(--serif)", fontSize: 28, fontWeight: 600, color: "var(--text)" }}>
          Portfolio P&L
        </h2>
        <button
          onClick={loadPortfolio}
          style={{
            fontFamily: "var(--mono)", fontSize: 10, padding: "8px 16px",
            borderRadius: 8, border: "1px solid var(--border)",
            background: "var(--surface-glass)", color: "var(--text-dim)",
            cursor: "pointer", letterSpacing: "0.04em",
          }}
        >
          Refresh
        </button>
      </div>

      {/* ═══ HERO STATS BAR ═══ */}
      <div style={{
        display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10,
        marginBottom: 24,
      }}>
        <div className="analytics-stat-card">
          <div className="analytics-stat-label">PORTFOLIO VALUE</div>
          <div className="analytics-stat-value" style={{ color: "var(--gold)" }}>
            <Eth size={14} /> {formatPrice(pnlData.currentValue)}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", marginTop: 2 }}>
            ~${Math.round(currentValueUsd).toLocaleString()}
          </div>
        </div>
        <div className="analytics-stat-card">
          <div className="analytics-stat-label">TOTAL P&L</div>
          <div className="analytics-stat-value" style={{ color: pnlColor(totalPnL) }}>
            {pnlSign(totalPnL)}<Eth size={14} /> {formatPrice(Math.abs(totalPnL))}
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: pnlColor(totalPnLUsd), marginTop: 2 }}>
            {pnlSign(totalPnLUsd)}${Math.round(Math.abs(totalPnLUsd)).toLocaleString()}
          </div>
        </div>
        <div className="analytics-stat-card">
          <div className="analytics-stat-label">GAS SPENT</div>
          <div className="analytics-stat-value" style={{ color: "var(--red, #f87171)" }}>
            <Eth size={14} /> {formatPrice(pnlData.totalGasSpent)}
          </div>
        </div>
        <div className="analytics-stat-card">
          <div className="analytics-stat-label">NFTs HELD</div>
          <div className="analytics-stat-value" style={{ color: "var(--naka-blue, #6fa8dc)" }}>
            {pnlData.nftCount}
          </div>
        </div>
      </div>

      {/* ═══ PER-COLLECTION BREAKDOWN ═══ */}
      <div style={{
        border: "1px solid var(--border)", borderRadius: 12,
        background: "var(--surface-glass)", marginBottom: 24, overflow: "hidden",
      }}>
        <button
          onClick={() => setExpandedCollection(o => !o)}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "14px 18px", border: "none", background: "transparent",
            cursor: "pointer", color: "var(--text)",
          }}
        >
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, letterSpacing: "0.06em" }}>
            COLLECTION BREAKDOWN
          </span>
          <svg
            width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ transform: expandedCollection ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        {/* Summary row (always visible) */}
        <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
        <div style={{
          display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr",
          padding: "0 18px 12px", gap: 8, minWidth: 520,
          fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
          letterSpacing: "0.04em",
        }}>
          <div>COLLECTION</div>
          <div style={{ textAlign: "right" }}>HELD</div>
          <div style={{ textAlign: "right" }}>AVG COST</div>
          <div style={{ textAlign: "right" }}>FLOOR</div>
          <div style={{ textAlign: "right" }}>UNREAL. P&L</div>
          <div style={{ textAlign: "right" }}>REAL. P&L</div>
        </div>
        <div style={{
          display: "grid", gridTemplateColumns: "2fr 1fr 1fr 1fr 1fr 1fr",
          padding: "10px 18px", gap: 8, borderTop: "1px solid var(--border)",
          fontFamily: "var(--mono)", fontSize: 12, minWidth: 520,
        }}>
          <div style={{ color: "var(--text)", fontFamily: "var(--display)", fontWeight: 500 }}>
            {collection.name}
          </div>
          <div style={{ textAlign: "right", color: "var(--text)" }}>
            {pnlData.nftCount}
          </div>
          <div style={{ textAlign: "right", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
            <Eth size={10} /> {formatPrice(pnlData.nftCount > 0 ? pnlData.costBasis / pnlData.nftCount : 0)}
          </div>
          <div style={{ textAlign: "right", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
            <Eth size={10} /> {formatPrice(pnlData.floorPrice)}
          </div>
          <div style={{ textAlign: "right", color: pnlColor(pnlData.unrealizedPnL) }}>
            {pnlSign(pnlData.unrealizedPnL)}{formatPrice(Math.abs(pnlData.unrealizedPnL))}
          </div>
          <div style={{ textAlign: "right", color: pnlColor(pnlData.realizedPnL) }}>
            {pnlSign(pnlData.realizedPnL)}{formatPrice(Math.abs(pnlData.realizedPnL))}
          </div>
        </div>
        </div>{/* end scroll wrapper */}

        {/* ═══ PER-NFT DETAIL (expandable) ═══ */}
        {expandedCollection && (
          <div style={{ borderTop: "1px solid var(--border)", overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
            <div style={{
              display: "grid", gridTemplateColumns: "40px 2fr 1fr 1fr 1fr 1fr",
              padding: "10px 18px", gap: 8, minWidth: 560,
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)",
              letterSpacing: "0.04em",
            }}>
              <div></div>
              <div>TOKEN</div>
              <div style={{ textAlign: "right" }}>COST BASIS</div>
              <div style={{ textAlign: "right" }}>VALUE</div>
              <div style={{ textAlign: "right" }}>P&L</div>
              <div style={{ textAlign: "right" }}>HOLD TIME</div>
            </div>
            {pnlData.tokenDetails.map(token => (
              <div
                key={token.tokenId}
                onClick={() => onPick?.({ id: token.tokenId, name: token.name, image: token.image })}
                style={{
                  display: "grid", gridTemplateColumns: "40px 2fr 1fr 1fr 1fr 1fr",
                  padding: "8px 18px", gap: 8, borderTop: "1px solid rgba(255,255,255,0.03)",
                  cursor: "pointer", transition: "background 0.15s",
                  fontFamily: "var(--mono)", fontSize: 11, minWidth: 560,
                }}
                onMouseEnter={e => e.currentTarget.style.background = "rgba(255,255,255,0.03)"}
                onMouseLeave={e => e.currentTarget.style.background = "transparent"}
              >
                <div>
                  {token.image ? (
                    <img
                      src={token.image}
                      alt=""
                      width={32}
                      height={32}
                      style={{ borderRadius: 4, objectFit: "cover" }}
                      loading="lazy"
                    />
                  ) : (
                    <div style={{ width: 32, height: 32, borderRadius: 4, background: "var(--surface)" }} />
                  )}
                </div>
                <div style={{ color: "var(--text)", display: "flex", alignItems: "center", gap: 6 }}>
                  {token.name || `#${token.tokenId}`}
                  {token.isMint && (
                    <span style={{
                      fontSize: 8, padding: "1px 5px", borderRadius: 3,
                      background: "rgba(74,222,128,0.1)", color: "var(--green, #4ade80)",
                      border: "1px solid rgba(74,222,128,0.2)",
                    }}>
                      MINT
                    </span>
                  )}
                </div>
                <div style={{ textAlign: "right", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
                  <Eth size={9} /> {formatPrice(token.costBasis)}
                </div>
                <div style={{ textAlign: "right", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 2 }}>
                  <Eth size={9} /> {formatPrice(token.currentValue)}
                </div>
                <div style={{ textAlign: "right", color: pnlColor(token.pnl) }}>
                  {pnlSign(token.pnl)}{formatPrice(Math.abs(token.pnl))}
                  {token.costBasis > 0 && (
                    <span style={{ fontSize: 9, marginLeft: 4, opacity: 0.7 }}>
                      ({pnlSign(token.pnlPercent)}{token.pnlPercent.toFixed(0)}%)
                    </span>
                  )}
                </div>
                <div style={{ textAlign: "right", color: "var(--text-dim)" }}>
                  {/* HOLD TIME BADGE */}
                  {token.holdDays != null ? (
                    <span style={{
                      fontSize: 9, padding: "2px 6px", borderRadius: 4,
                      background: "rgba(111,168,220,0.08)", border: "1px solid rgba(111,168,220,0.15)",
                      color: "var(--naka-blue, #6fa8dc)",
                    }}>
                      Held {formatDays(token.holdDays)}
                    </span>
                  ) : (
                    <span style={{ fontSize: 9, color: "var(--text-dim)" }}>--</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ═══ BEST / WORST PERFORMERS ═══ */}
      {(topGainers.length > 0 || topLosers.length > 0) && (
        <div className="portfolio-performers-grid" style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16,
          marginBottom: 24,
        }}>
          {/* Top Gainers */}
          <div style={{
            border: "1px solid var(--border)", borderRadius: 12,
            background: "var(--surface-glass)", padding: 16,
          }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em",
              color: "var(--green, #4ade80)", marginBottom: 12,
            }}>
              TOP GAINERS
            </div>
            {topGainers.length === 0 ? (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
                No gainers with known cost basis
              </div>
            ) : (
              topGainers.map((t, i) => (
                <div key={t.tokenId} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "6px 0", borderBottom: i < topGainers.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                }}>
                  <div style={{ fontFamily: "var(--display)", fontSize: 12, color: "var(--text)" }}>
                    {t.name || `#${t.tokenId}`}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--green, #4ade80)" }}>
                    +{t.pnlPercent.toFixed(1)}%
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Top Losers */}
          <div style={{
            border: "1px solid var(--border)", borderRadius: 12,
            background: "var(--surface-glass)", padding: 16,
          }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em",
              color: "var(--red, #f87171)", marginBottom: 12,
            }}>
              TOP LOSERS
            </div>
            {topLosers.length === 0 ? (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
                No losers with known cost basis
              </div>
            ) : (
              topLosers.map((t, i) => (
                <div key={t.tokenId} style={{
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  padding: "6px 0", borderBottom: i < topLosers.length - 1 ? "1px solid rgba(255,255,255,0.04)" : "none",
                }}>
                  <div style={{ fontFamily: "var(--display)", fontSize: 12, color: "var(--text)" }}>
                    {t.name || `#${t.tokenId}`}
                  </div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--red, #f87171)" }}>
                    {t.pnlPercent.toFixed(1)}%
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* ═══ VALUE OVER TIME ═══ */}
      <div style={{
        border: "1px solid var(--border)", borderRadius: 12,
        background: "var(--surface-glass)", padding: 16,
      }}>
        <div style={{
          fontFamily: "var(--mono)", fontSize: 10, letterSpacing: "0.06em",
          color: "var(--text-dim)", marginBottom: 12,
        }}>
          PORTFOLIO VALUE OVER TIME
        </div>
        <ValueChart snapshots={snapshots} />
      </div>
    </section>
  );
}
