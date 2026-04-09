import { useState, useEffect, useCallback, useRef } from "react";
import { useActiveCollection } from "../contexts/CollectionContext";
import { lockScroll, unlockScroll } from "../lib/scrollLock";

const STEPS = [
  {
    target: ".gallery-grid, .virtual-gallery-grid, [data-tour='gallery']",
    title: "Gallery",
    body: null, // dynamic — set at render time using collection name
    position: "bottom",
  },
  {
    target: "[data-tour='floor'], .tab-floor, .listings-tab, button[data-tab='floor']",
    title: "Floor / Listings",
    body: "Buy directly from the marketplace \u2014 lowest prices first",
    position: "bottom",
  },
  {
    target: "[data-tour='wallet'], .wallet-btn, .connect-wallet-btn",
    title: "Wallet",
    body: "Connect your wallet to trade, make offers, and track your collection",
    position: "bottom-end",
  },
  {
    target: "[data-tour='cart'], .cart-icon, .cart-btn",
    title: "Cart",
    body: "Add multiple NFTs to cart for batch purchases \u2014 saves gas",
    position: "bottom-end",
  },
  {
    target: "[data-tour='shortcuts']",
    title: "Keyboard Shortcuts",
    body: "Power user? Press ? anytime for keyboard shortcuts",
    position: "bottom",
    fallbackCenter: true,
  },
];

// Storage key is parameterized per collection via useActiveCollection

// ═══ Keyframes injected once ═══
let styleInjected = false;
function injectKeyframes() {
  if (styleInjected) return;
  styleInjected = true;
  const sheet = document.createElement("style");
  sheet.textContent = `
    @keyframes onboarding-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(111,168,220,0.55); }
      70%  { box-shadow: 0 0 0 14px rgba(111,168,220,0); }
      100% { box-shadow: 0 0 0 0 rgba(111,168,220,0); }
    }
    @keyframes onboarding-fade-in {
      from { opacity: 0; transform: translateY(8px) scale(0.97); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }
    @keyframes onboarding-spotlight {
      from { opacity: 0; }
      to   { opacity: 1; }
    }
  `;
  document.head.appendChild(sheet);
}

// ═══ Tooltip arrow helper ═══
function arrowStyle(position) {
  const base = {
    position: "absolute",
    width: 0,
    height: 0,
    borderLeft: "8px solid transparent",
    borderRight: "8px solid transparent",
  };
  if (position.startsWith("bottom")) {
    return {
      ...base,
      top: -8,
      left: "50%",
      transform: "translateX(-50%)",
      borderBottom: "8px solid rgba(30,32,38,0.92)",
    };
  }
  if (position.startsWith("top")) {
    return {
      ...base,
      bottom: -8,
      left: "50%",
      transform: "translateX(-50%)",
      borderTop: "8px solid rgba(30,32,38,0.92)",
    };
  }
  if (position === "left") {
    return {
      ...base,
      right: -8,
      top: "50%",
      transform: "translateY(-50%)",
      borderLeft: "8px solid rgba(30,32,38,0.92)",
      borderTop: "8px solid transparent",
      borderBottom: "8px solid transparent",
      borderRight: "none",
    };
  }
  if (position === "right") {
    return {
      ...base,
      left: -8,
      top: "50%",
      transform: "translateY(-50%)",
      borderRight: "8px solid rgba(30,32,38,0.92)",
      borderTop: "8px solid transparent",
      borderBottom: "8px solid transparent",
      borderLeft: "none",
    };
  }
  return base;
}

// ═══ Resolve first matching selector ═══
function resolveTarget(selectorGroup) {
  for (const sel of selectorGroup.split(",")) {
    const el = document.querySelector(sel.trim());
    if (el) return el;
  }
  return null;
}

export default function Onboarding({ onComplete }) {
  const collection = useActiveCollection();
  const storageKey = `${collection.slug}_onboarded`;
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const [tooltipPos, setTooltipPos] = useState(null);
  const [spotlightRect, setSpotlightRect] = useState(null);
  const tooltipRef = useRef(null);

  // ── First-visit detection ──
  useEffect(() => {
    try { if (localStorage.getItem(storageKey) === "true") return; } catch { return; }
    injectKeyframes();
    // small delay so the page has time to render target elements
    const timer = setTimeout(() => setActive(true), 600);
    return () => clearTimeout(timer);
  }, [storageKey]);

  // ── Position tooltip relative to target ──
  const positionTooltip = useCallback(() => {
    const cfg = STEPS[step];
    if (!cfg) return;

    const el = resolveTarget(cfg.target);
    const gap = 14;

    if (!el) {
      // fallback: center on screen
      setSpotlightRect(null);
      setTooltipPos({
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
      });
      return;
    }

    const rect = el.getBoundingClientRect();
    const pad = 6;
    setSpotlightRect({
      top: rect.top - pad,
      left: rect.left - pad,
      width: rect.width + pad * 2,
      height: rect.height + pad * 2,
      borderRadius: 8,
    });

    // calculate tooltip placement
    const pos = {};
    const position = cfg.position || "bottom";

    if (position.startsWith("bottom")) {
      pos.top = rect.bottom + gap;
      pos.left = position === "bottom-end"
        ? rect.right - 320
        : rect.left + rect.width / 2 - 160;
    } else if (position.startsWith("top")) {
      pos.bottom = window.innerHeight - rect.top + gap;
      pos.left = rect.left + rect.width / 2 - 160;
    }

    // clamp to viewport
    if (pos.left !== undefined) {
      pos.left = Math.max(16, Math.min(pos.left, window.innerWidth - 336));
    }
    if (pos.top !== undefined) {
      pos.top = Math.max(16, Math.min(pos.top, window.innerHeight - 220));
    }

    setTooltipPos(pos);
  }, [step]);

  useEffect(() => {
    if (!active) return;
    positionTooltip();
    window.addEventListener("resize", positionTooltip);
    window.addEventListener("scroll", positionTooltip, true);
    return () => {
      window.removeEventListener("resize", positionTooltip);
      window.removeEventListener("scroll", positionTooltip, true);
    };
  }, [active, step, positionTooltip]);

  // ── Lock body scroll ──
  useEffect(() => {
    if (!active) return;
    lockScroll();
    return () => { unlockScroll(); };
  }, [active]);

  const finish = useCallback(() => {
    setActive(false);
    try { localStorage.setItem(storageKey, "true"); } catch { /* quota exceeded */ }
    onComplete?.();
  }, [onComplete, storageKey]);

  const next = useCallback(() => {
    if (step >= STEPS.length - 1) {
      finish();
    } else {
      setStep((s) => s + 1);
    }
  }, [step, finish]);

  const prev = useCallback(() => {
    setStep((s) => Math.max(0, s - 1));
  }, []);

  // ── Keyboard nav ──
  useEffect(() => {
    if (!active) return;
    const handle = (e) => {
      if (e.key === "Escape") finish();
      if (e.key === "ArrowRight" || e.key === "Enter") next();
      if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [active, finish, next, prev]);

  if (!active) return null;

  const cfg = STEPS[step];
  const isLast = step === STEPS.length - 1;

  // ═══ Overlay with spotlight cutout using CSS clip-path ═══
  const overlayStyle = {
    position: "fixed",
    inset: 0,
    zIndex: 99998,
    background: "rgba(0,0,0,0.72)",
    animation: "onboarding-spotlight 300ms ease-out",
    transition: "clip-path 350ms cubic-bezier(.4,0,.2,1)",
    clipPath: spotlightRect
      ? `polygon(
          0% 0%, 0% 100%, 100% 100%, 100% 0%,
          0% 0%,
          ${spotlightRect.left}px ${spotlightRect.top}px,
          ${spotlightRect.left}px ${spotlightRect.top + spotlightRect.height}px,
          ${spotlightRect.left + spotlightRect.width}px ${spotlightRect.top + spotlightRect.height}px,
          ${spotlightRect.left + spotlightRect.width}px ${spotlightRect.top}px,
          ${spotlightRect.left}px ${spotlightRect.top}px,
          0% 0%
        )`
      : "none",
  };

  // ═══ Pulse ring around highlighted element ═══
  const pulseStyle = spotlightRect ? {
    position: "fixed",
    top: spotlightRect.top,
    left: spotlightRect.left,
    width: spotlightRect.width,
    height: spotlightRect.height,
    borderRadius: spotlightRect.borderRadius,
    border: "2px solid var(--naka-blue, #6fa8dc)",
    animation: "onboarding-pulse 1.8s ease-out infinite",
    pointerEvents: "none",
    zIndex: 99999,
    transition: "all 350ms cubic-bezier(.4,0,.2,1)",
  } : null;

  // ═══ Tooltip card ═══
  const tooltipStyle = {
    position: "fixed",
    zIndex: 100000,
    width: 320,
    ...tooltipPos,
    background: "rgba(30,32,38,0.92)",
    backdropFilter: "blur(18px)",
    WebkitBackdropFilter: "blur(18px)",
    border: "1px solid var(--border, rgba(255,255,255,0.08))",
    borderRadius: 14,
    padding: "22px 22px 18px",
    color: "var(--text, #f0f0f0)",
    fontFamily: "var(--mono, 'IBM Plex Mono', monospace)",
    animation: "onboarding-fade-in 280ms ease-out",
    boxShadow: "0 8px 40px rgba(0,0,0,0.55), 0 0 0 1px rgba(111,168,220,0.12)",
  };

  const stepCountStyle = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginBottom: 10,
    fontSize: 11,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: "var(--naka-blue, #6fa8dc)",
    fontFamily: "var(--mono, 'IBM Plex Mono', monospace)",
  };

  const titleStyle = {
    margin: "0 0 8px",
    fontSize: 17,
    fontWeight: 700,
    fontFamily: "var(--display, 'Space Grotesk', sans-serif)",
    color: "var(--text, #f0f0f0)",
    letterSpacing: "-0.01em",
  };

  const bodyStyle = {
    margin: 0,
    fontSize: 13,
    lineHeight: 1.55,
    color: "var(--text-dim, rgba(240,240,240,0.72))",
  };

  const dotsContainerStyle = {
    display: "flex",
    gap: 6,
    marginTop: 16,
    marginBottom: 14,
    justifyContent: "center",
  };

  const dotStyle = (i) => ({
    width: i === step ? 18 : 7,
    height: 7,
    borderRadius: 4,
    background: i === step
      ? "var(--naka-blue, #6fa8dc)"
      : "var(--text-muted, rgba(255,255,255,0.18))",
    transition: "all 300ms ease",
  });

  const btnRowStyle = {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 8,
  };

  const btnBase = {
    border: "none",
    cursor: "pointer",
    fontFamily: "var(--mono, 'IBM Plex Mono', monospace)",
    fontSize: 13,
    fontWeight: 600,
    borderRadius: 8,
    padding: "8px 18px",
    transition: "all 180ms ease",
    letterSpacing: "0.02em",
  };

  const skipBtnStyle = {
    ...btnBase,
    background: "transparent",
    color: "var(--text-muted, rgba(255,255,255,0.35))",
  };

  const prevBtnStyle = {
    ...btnBase,
    background: "rgba(255,255,255,0.06)",
    color: "var(--text-dim, rgba(240,240,240,0.72))",
  };

  const nextBtnStyle = {
    ...btnBase,
    background: "var(--naka-blue, #6fa8dc)",
    color: "var(--bg)",
  };

  return (
    <>
      {/* Dark overlay with spotlight cutout */}
      <div style={overlayStyle} onClick={finish} />

      {/* Pulse ring */}
      {pulseStyle && <div style={pulseStyle} />}

      {/* Tooltip */}
      <div ref={tooltipRef} style={tooltipStyle} onClick={(e) => e.stopPropagation()}>
        {/* Arrow */}
        <div style={arrowStyle(cfg.position || "bottom")} />

        {/* Step indicator */}
        <div style={stepCountStyle}>
          <span style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "rgba(111,168,220,0.15)",
            fontSize: 11,
            fontWeight: 700,
          }}>
            {step + 1}
          </span>
          <span>of {STEPS.length}</span>
        </div>

        {/* Content */}
        <h3 style={titleStyle}>{cfg.title}</h3>
        <p style={bodyStyle}>{cfg.body || `Browse the ${collection.name} collection with rarity scores and trait filtering`}</p>

        {/* Progress dots */}
        <div style={dotsContainerStyle}>
          {STEPS.map((_, i) => (
            <div key={i} style={dotStyle(i)} />
          ))}
        </div>

        {/* Buttons */}
        <div style={btnRowStyle}>
          <button
            style={skipBtnStyle}
            onClick={finish}
            onMouseEnter={(e) => { e.target.style.color = "var(--text-dim, rgba(240,240,240,0.72))"; }}
            onMouseLeave={(e) => { e.target.style.color = "var(--text-muted, rgba(255,255,255,0.35))"; }}
          >
            Skip
          </button>

          <div style={{ display: "flex", gap: 8 }}>
            {step > 0 && (
              <button
                style={prevBtnStyle}
                onClick={prev}
                onMouseEnter={(e) => { e.target.style.background = "rgba(255,255,255,0.10)"; }}
                onMouseLeave={(e) => { e.target.style.background = "rgba(255,255,255,0.06)"; }}
              >
                Back
              </button>
            )}
            <button
              style={nextBtnStyle}
              onClick={next}
              onMouseEnter={(e) => { e.target.style.filter = "brightness(1.12)"; }}
              onMouseLeave={(e) => { e.target.style.filter = "none"; }}
            >
              {isLast ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
