import { useState, useEffect, useRef, useCallback } from "react";
import NftImage from "./NftImage";
import { useActiveCollection } from "../contexts/CollectionContext";
import { lockScroll, unlockScroll } from "../lib/scrollLock";
import { trapFocus } from "../lib/trapFocus";
import { rankTier } from "../constants";

/* ─── Fade-in keyframes (injected once) ─── */
const STYLE_ID = "theater-mode-keyframes";
function ensureKeyframes() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes theater-fade-in {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
  `;
  document.head.appendChild(style);
}

/* ─── Main Component ─── */
export default function TheaterMode({ nft, onClose, isFavorite, onToggleFavorite }) {
  const collection = useActiveCollection();
  const [showTraits, setShowTraits] = useState(false);
  const [visible, setVisible] = useState(false);
  // F793: dialog container + close-button refs for focus management / trap.
  const overlayRef = useRef(null);
  const closeBtnRef = useRef(null);

  // Fade in on mount
  useEffect(() => {
    ensureKeyframes();
    requestAnimationFrame(() => setVisible(true));
    // Ref-counted lock (shared with the underlying Modal) so closing Theater
    // over a still-open detail modal doesn't unlock the body behind it (F786).
    lockScroll();
    // F793: move focus into the dialog so Tab cycles within it (and Escape /
    // the close button are reachable for keyboard + screen-reader users).
    const prevFocused = document.activeElement;
    closeBtnRef.current?.focus();
    return () => {
      unlockScroll();
      if (prevFocused instanceof HTMLElement) prevFocused.focus();
    };
  }, []);

  // Keyboard controls
  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(onClose, 300);
  }, [onClose]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        // Theater is the topmost overlay — it must win Escape so it doesn't
        // orphan over a still-open detail modal. Capture phase + stop
        // propagation intercepts the key before the modal's handler runs (F616).
        e.stopImmediatePropagation();
        handleClose();
        return;
      }
      if (e.key === "t" || e.key === "T") setShowTraits((p) => !p);
      if (e.key === "f" || e.key === "F") onToggleFavorite?.(nft.id);
      // F793: keep Tab cycling within the dialog (filters :disabled via F800).
      trapFocus(overlayRef.current, e);
    };
    // useCapture: true so this runs before the document bubble-phase listeners
    // registered earlier by the underlying Modal.
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
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
    transition: "opacity 0.15s ease",
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
    transition: "padding-right 0.15s ease",
    paddingRight: showTraits ? 300 : 0,
  };

  const imageStyle = {
    maxHeight: "80vh",
    maxWidth: "70vw",
    objectFit: "contain",
    borderRadius: 3,
    zIndex: 1,
    boxShadow: "none",
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
    background: "rgba(17,19,22,0.96)",
    borderTop: "1px solid var(--border)",
    transition: "right 0.15s ease",
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
    fontSize: 13,
    color: "var(--text-dim)",
    letterSpacing: "0.04em",
  };

  // F809: color the rank badge by the shared rankTier scale (gold≤0.5% /
  // blue≤2.5% / plain) so the tier reads identically to Modal and ShareCard.
  // Visibility is unchanged — any ranked token still shows the badge (additive).
  const theaterTier = hasRank ? rankTier(nft.rank, supply) : null;
  const TIER_BADGE = {
    gold:  { color: "var(--gold)", background: "rgba(255,255,255,0.07)",  border: "1px solid rgba(255,255,255,0.16)" },
    blue:  { color: "#ffffff",     background: "rgba(255,255,255,0.07)",  border: "1px solid rgba(255,255,255,0.16)" },
    plain: { color: "#c4ccda",     background: "rgba(180,190,210,0.08)", border: "1px solid rgba(180,190,210,0.2)" },
  };
  const rankBadge = {
    fontFamily: "var(--mono)",
    fontSize: 11,
    borderRadius: 3,
    padding: "3px 8px",
    letterSpacing: "0.06em",
    ...(TIER_BADGE[theaterTier] || TIER_BADGE.gold),
  };

  const hudRight = {
    display: "flex",
    alignItems: "center",
    gap: 10,
  };

  const hudBtn = {
    background: "var(--border)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 4,
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
    background: "rgba(17,19,22,0.96)",
    borderLeft: "1px solid var(--border)",
    transform: showTraits ? "translateX(0)" : "translateX(100%)",
    transition: "transform 0.15s ease",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
  };

  const sidebarHeader = {
    fontFamily: "var(--mono)",
    fontSize: 11,
    color: "var(--text-dim)",
    letterSpacing: "0.1em",
    padding: "24px 20px 12px",
    borderBottom: "1px solid var(--border)",
  };

  const traitCard = {
    background: "rgba(255,255,255,0.025)",
    border: "1px solid var(--border)",
    borderRadius: 4,
    padding: "12px 14px",
  };

  const traitLabel = {
    fontFamily: "var(--mono)",
    fontSize: 11,
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
    fontSize: 11,
    color: "var(--text-muted)",
    marginTop: 4,
  };

  const toggleBtn = {
    position: "fixed",
    right: showTraits ? 300 : 0,
    top: "50%",
    transform: "translateY(-50%)",
    zIndex: 11,
    background: "rgba(17,19,22,0.96)",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRight: showTraits ? "none" : "1px solid rgba(255,255,255,0.08)",
    borderLeft: showTraits ? "1px solid rgba(255,255,255,0.08)" : "1px solid rgba(255,255,255,0.08)",
    borderRadius: showTraits ? "6px 0 0 6px" : "6px 0 0 6px",
    color: "var(--text-dim)",
    cursor: "pointer",
    padding: "12px 8px",
    fontSize: 13,
    fontFamily: "var(--mono)",
    letterSpacing: "0.04em",
    writingMode: "vertical-rl",
    transition: "right 0.15s ease",
  };

  return (
    <div
      ref={overlayRef}
      style={overlay}
      onClick={handleClose}
      role="dialog"
      aria-modal="true"
      aria-label={`${nft.name} — theater view`}
    >
      {/* Centered Image Area */}
      <div style={imageContainer} onClick={(e) => e.stopPropagation()}>
        <NftImage nft={nft} large style={imageStyle} />
      </div>

      {/* Bottom HUD */}
      <div style={hudBar} onClick={(e) => e.stopPropagation()}>
        <div style={hudLeft}>
          <span style={nftName}>{nft.name}</span>
          {/* The name already includes "#<id>" — show the trait count here
              instead of repeating the id (F624). */}
          {attrs.length > 0 && <span style={tokenId}>{attrs.length} traits</span>}
          {hasRank && <span style={rankBadge}>RANK #{nft.rank}</span>}
        </div>
        <div style={hudRight}>
          <button
            style={favBtn}
            onClick={() => onToggleFavorite?.(nft.id)}
            aria-pressed={!!isFavorite}
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            title={isFavorite ? "Remove from favorites (F)" : "Add to favorites (F)"}
          >
            {isFavorite ? "\u2665" : "\u2661"}
          </button>
          <button
            ref={closeBtnRef}
            style={hudBtn}
            onClick={handleClose}
            aria-label="Close theater view"
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
            <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-muted)", padding: "20px 0", textAlign: "center" }}>
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
