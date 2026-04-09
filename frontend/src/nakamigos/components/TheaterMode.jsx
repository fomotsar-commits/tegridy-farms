import { useState, useEffect, useRef, useCallback } from "react";
import NftImage from "./NftImage";
import { useActiveCollection } from "../contexts/CollectionContext";

/* ─── Ambient Particle Canvas ─── */
function AmbientParticles({ width, height }) {
  const canvasRef = useRef(null);
  const particlesRef = useRef(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    c.width = width;
    c.height = height;

    if (!particlesRef.current) {
      const COLORS = [
        "rgba(200,168,80,", // gold
        "rgba(111,168,220,", // naka-blue
        "rgba(129,140,248,", // purple
        "rgba(255,255,255,", // white
      ];
      particlesRef.current = Array.from({ length: 35 }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 1 + Math.random() * 2.5,
        vx: (Math.random() - 0.5) * 0.25,
        vy: (Math.random() - 0.5) * 0.2 - 0.1,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        opacity: 0.04 + Math.random() * 0.1,
        pulseSpeed: 0.001 + Math.random() * 0.002,
        pulseOffset: Math.random() * Math.PI * 2,
      }));
    }

    let raf;
    let paused = false;

    const onVisibility = () => {
      if (document.hidden) {
        paused = true;
        cancelAnimationFrame(raf);
      } else {
        paused = false;
        raf = requestAnimationFrame(draw);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    const draw = (t) => {
      if (paused) return;
      ctx.clearRect(0, 0, c.width, c.height);
      particlesRef.current.forEach((p) => {
        const pulse = Math.sin(t * p.pulseSpeed + p.pulseOffset) * 0.5 + 0.5;
        const alpha = p.opacity * (0.5 + pulse * 0.5);
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = p.color + alpha.toFixed(3) + ")";
        ctx.fill();

        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -10) p.x = c.width + 10;
        if (p.x > c.width + 10) p.x = -10;
        if (p.y < -10) p.y = c.height + 10;
        if (p.y > c.height + 10) p.y = -10;
      });
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      // Dispose canvas context to free GPU memory
      c.width = 0;
      c.height = 0;
    };
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 1,
      }}
    />
  );
}

/* ─── Ken Burns keyframes (injected once) ─── */
const STYLE_ID = "theater-mode-keyframes";
function ensureKeyframes() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes theater-ken-burns {
      0%   { transform: scale(1.0); }
      50%  { transform: scale(1.02); }
      100% { transform: scale(1.0); }
    }
    @keyframes theater-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
    @keyframes theater-glow-pulse {
      0%   { opacity: 0.5; }
      50%  { opacity: 0.75; }
      100% { opacity: 0.5; }
    }
  `;
  document.head.appendChild(style);
}

/* ─── Main Component ─── */
export default function TheaterMode({ nft, onClose, isFavorite, onToggleFavorite }) {
  const collection = useActiveCollection();
  const [showTraits, setShowTraits] = useState(false);
  const [visible, setVisible] = useState(false);
  const [dimensions, setDimensions] = useState({ w: window.innerWidth, h: window.innerHeight });

  // Fade in on mount
  useEffect(() => {
    ensureKeyframes();
    requestAnimationFrame(() => setVisible(true));
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; };
  }, []);

  // Window resize
  useEffect(() => {
    const onResize = () => setDimensions({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Keyboard controls
  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") handleClose();
      if (e.key === "t" || e.key === "T") setShowTraits((p) => !p);
      if (e.key === "f" || e.key === "F") onToggleFavorite?.(nft.id);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [nft, handleClose, onToggleFavorite]);

  if (!nft) return null;

  const supply = collection.supply || 10000;
  const hasRank = nft.rank && nft.rank <= supply;
  const attrs = nft.attributes || [];

  /* ─── Styles ─── */
  const overlay = {
    position: "fixed",
    inset: 0,
    zIndex: 9999,
    background: "rgba(0,0,0,0.97)",
    opacity: visible ? 1 : 0,
    transition: "opacity 0.3s ease",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    animation: "theater-fade-in 0.3s ease",
  };

  const imageContainer = {
    position: "relative",
    zIndex: 2,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: 1,
    width: "100%",
    transition: "padding-right 0.3s ease",
    paddingRight: showTraits ? 300 : 0,
  };

  const ambientGlow = {
    position: "absolute",
    width: "60%",
    height: "60%",
    borderRadius: "50%",
    background: "radial-gradient(circle, rgba(200,168,80,0.15) 0%, rgba(111,168,220,0.08) 40%, transparent 70%)",
    filter: "blur(80px)",
    zIndex: 0,
    animation: "theater-glow-pulse 6s ease-in-out infinite",
    pointerEvents: "none",
  };

  const imageStyle = {
    maxHeight: "80vh",
    maxWidth: "70vw",
    objectFit: "contain",
    borderRadius: 4,
    zIndex: 1,
    animation: "theater-ken-burns 20s ease-in-out infinite",
    boxShadow: "0 0 80px rgba(200,168,80,0.08), 0 0 160px rgba(111,168,220,0.04)",
  };

  const hudBar = {
    position: "fixed",
    bottom: 0,
    left: 0,
    right: showTraits ? 300 : 0,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "14px 28px",
    background: "rgba(16,16,18,0.6)",
    backdropFilter: "var(--glass-blur)",
    WebkitBackdropFilter: "var(--glass-blur)",
    borderTop: "1px solid var(--border)",
    transition: "right 0.3s ease",
  };

  const hudLeft = {
    display: "flex",
    alignItems: "center",
    gap: 16,
  };

  const nftName = {
    fontFamily: "var(--display)",
    fontSize: 18,
    fontWeight: 700,
    color: "#fff",
    letterSpacing: "-0.02em",
  };

  const tokenId = {
    fontFamily: "var(--mono)",
    fontSize: 12,
    color: "var(--text-dim)",
    letterSpacing: "0.04em",
  };

  const rankBadge = {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--gold)",
    background: "rgba(200,168,80,0.1)",
    border: "1px solid rgba(200,168,80,0.25)",
    borderRadius: 4,
    padding: "3px 8px",
    letterSpacing: "0.06em",
  };

  const hudRight = {
    display: "flex",
    alignItems: "center",
    gap: 10,
  };

  const hudBtn = {
    background: "var(--border)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 6,
    color: "var(--text-muted)",
    cursor: "pointer",
    padding: "6px 12px",
    fontSize: 16,
    lineHeight: 1,
    transition: "all 0.2s ease",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  };

  const favBtn = {
    ...hudBtn,
    color: isFavorite ? "var(--red)" : "var(--text-dim)",
    fontSize: 18,
  };

  /* ─── Trait Sidebar ─── */
  const sidebar = {
    position: "fixed",
    top: 0,
    right: 0,
    bottom: 0,
    width: 300,
    zIndex: 10,
    background: "rgba(16,16,18,0.75)",
    backdropFilter: "var(--glass-blur)",
    WebkitBackdropFilter: "var(--glass-blur)",
    borderLeft: "1px solid var(--border)",
    transform: showTraits ? "translateX(0)" : "translateX(100%)",
    transition: "transform 0.3s ease",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
  };

  const sidebarHeader = {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-dim)",
    letterSpacing: "0.1em",
    padding: "24px 20px 12px",
    borderBottom: "1px solid var(--border)",
  };

  const traitCard = {
    background: "rgba(255,255,255,0.025)",
    border: "1px solid var(--border)",
    borderRadius: 8,
    padding: "12px 14px",
  };

  const traitLabel = {
    fontFamily: "var(--mono)",
    fontSize: 9,
    color: "var(--text-dim)",
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    marginBottom: 4,
  };

  const traitValue = {
    fontFamily: "var(--display)",
    fontSize: 14,
    color: "#fff",
    fontWeight: 600,
    lineHeight: 1.3,
  };

  const traitCount = {
    fontFamily: "var(--mono)",
    fontSize: 10,
    color: "var(--text-muted)",
    marginTop: 4,
  };

  const toggleBtn = {
    position: "fixed",
    right: showTraits ? 300 : 0,
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 11,
    background: "rgba(16,16,18,0.7)",
    backdropFilter: "var(--glass-blur)",
    WebkitBackdropFilter: "var(--glass-blur)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRight: showTraits ? "none" : "1px solid rgba(255,255,255,0.08)",
    borderLeft: showTraits ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(255,255,255,0.08)",
    borderRadius: showTraits ? "6px 0 0 6px" : "6px 0 0 6px",
    color: "var(--text-dim)",
    cursor: "pointer",
    padding: "12px 8px",
    fontSize: 12,
    fontFamily: "var(--mono)",
    letterSpacing: "0.04em",
    writingMode: "vertical-rl",
    transition: "right 0.3s ease",
  };

  return (
    <div style={overlay} onClick={handleClose}>
      {/* Ambient Particles */}
      <AmbientParticles width={dimensions.w} height={dimensions.h} />

      {/* Centered Image Area */}
      <div style={imageContainer} onClick={(e) => e.stopPropagation()}>
        <div style={ambientGlow} />
        <NftImage nft={nft} large style={imageStyle} />
      </div>

      {/* Bottom HUD */}
      <div style={hudBar} onClick={(e) => e.stopPropagation()}>
        <div style={hudLeft}>
          <span style={nftName}>{nft.name}</span>
          <span style={tokenId}>#{nft.id}</span>
          {hasRank && <span style={rankBadge}>RANK #{nft.rank}</span>}
        </div>
        <div style={hudRight}>
          <button
            style={favBtn}
            onClick={() => onToggleFavorite?.(nft.id)}
            title={isFavorite ? "Remove from favorites (F)" : "Add to favorites (F)"}
          >
            {isFavorite ? "\u2665" : "\u2661"}
          </button>
          <button
            style={hudBtn}
            onClick={handleClose}
            title="Close (ESC)"
          >
            {"\u2715"}
          </button>
        </div>
      </div>

      {/* Trait Sidebar Toggle */}
      <button
        style={toggleBtn}
        onClick={(e) => { e.stopPropagation(); setShowTraits((p) => !p); }}
        title="Toggle traits (T)"
      >
        {showTraits ? "HIDE" : "TRAITS"}
      </button>

      {/* Trait Sidebar */}
      <div style={sidebar} onClick={(e) => e.stopPropagation()}>
        <div style={sidebarHeader}>
          ATTRIBUTES {attrs.length > 0 ? `(${attrs.length})` : ""}
        </div>
        <div style={{ padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          {attrs.length === 0 && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>
              No traits available
            </div>
          )}
          {attrs.map((attr, i) => (
            <div key={attr.key || i} style={traitCard}>
              <div style={traitLabel}>{attr.key}</div>
              <div style={traitValue}>{attr.value}</div>
              {attr.count != null && (
                <div style={traitCount}>{attr.count.toLocaleString()} have this</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
