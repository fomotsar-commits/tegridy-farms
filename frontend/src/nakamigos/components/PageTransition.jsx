import { useRef, useLayoutEffect, useEffect, useState, useCallback, useMemo } from "react";

// Glitch + stagger dissolve transition
// Phase 1: RGB glitch split — old content shakes with dramatic color distortion
// Phase 2: Dark blocks sweep over content in a staggered diagonal
// Phase 3: Blocks dissolve away revealing new content underneath

const COLS = 8;
const ROWS = 6;
const GLITCH_MS = 200;
const COVER_MS = 400;
const REVEAL_MS = 450;

function injectStyles() {
  // Always replace to pick up changes during HMR/dev
  document.getElementById("page-tx-styles")?.remove();
  const style = document.createElement("style");
  style.id = "page-tx-styles";
  style.textContent = `
    .page-tx-wrap { position: relative; width: 100%; overflow: hidden; }
    .page-tx-content { width: 100%; transition: none; }

    .page-tx-glitch {
      animation: ptxGlitch ${GLITCH_MS}ms steps(6) forwards;
    }
    @keyframes ptxGlitch {
      0%   { filter: none; transform: none; }
      10%  { filter: saturate(5) hue-rotate(20deg) brightness(1.4); transform: translate(10px, -3px) skewX(-2deg) scale(1.01); }
      20%  { filter: saturate(0.2) hue-rotate(-30deg) brightness(1.7); transform: translate(-12px, 5px) skewX(3deg) scale(0.99); }
      30%  { filter: saturate(5) hue-rotate(45deg) contrast(1.6); transform: translate(6px, 3px) skewX(-1deg) scale(1.02); }
      40%  { filter: invert(0.12) hue-rotate(-35deg) brightness(0.7); transform: translate(-8px, -5px) skewY(1deg); }
      50%  { filter: saturate(3) hue-rotate(55deg) brightness(1.5); transform: translate(14px, -2px) skewX(2deg); }
      60%  { filter: saturate(0.1) brightness(2) contrast(0.5); transform: translate(-5px, 6px) skewX(-2deg); }
      70%  { filter: hue-rotate(-40deg) brightness(0.5) saturate(4); transform: translate(8px, -4px) scale(0.98); }
      80%  { filter: saturate(4) hue-rotate(60deg) brightness(1.6); transform: translate(-10px, 3px) scale(1.02); }
      90%  { filter: invert(0.15) brightness(1.8); transform: translate(4px, -6px) skewX(1deg); }
      100% { filter: none; transform: none; }
    }

    .page-tx-block {
      position: absolute;
      overflow: hidden;
      will-change: transform, opacity;
      pointer-events: none;
      z-index: 5;
    }

    /* Dark blocks sweep IN over old content */
    .page-tx-block-cover {
      opacity: 0;
      animation: ptxBlockCover var(--block-dur) var(--block-delay) cubic-bezier(0.22, 0.68, 0.36, 1) forwards;
    }
    @keyframes ptxBlockCover {
      0%   { opacity: 0; transform: scale(1.15) rotate(var(--rot)); filter: brightness(2); }
      20%  { opacity: 0.7; filter: brightness(1.4); }
      50%  { opacity: 1; filter: brightness(1); }
      100% { opacity: 1; transform: none; filter: none; }
    }

    /* Dark blocks dissolve OUT revealing new content */
    .page-tx-block-reveal {
      opacity: 1;
      animation: ptxBlockReveal var(--block-dur) var(--block-delay) cubic-bezier(0.4, 0, 0.8, 0.2) forwards;
    }
    @keyframes ptxBlockReveal {
      0%   { opacity: 1; transform: none; filter: none; }
      30%  { opacity: 0.8; filter: brightness(1.5); transform: translate(calc(var(--dx) * 0.3), calc(var(--dy) * 0.3)) scale(0.97); }
      60%  { opacity: 0.4; filter: brightness(1.8); transform: translate(calc(var(--dx) * 0.7), calc(var(--dy) * 0.7)) scale(0.9); }
      100% { opacity: 0; transform: translate(var(--dx), var(--dy)) scale(0.8) rotate(var(--rot)); filter: brightness(3); }
    }

    .page-tx-scanline {
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 4px;
      background: linear-gradient(90deg, transparent 0%, var(--gold, #c8a850) 20%, #fff 50%, var(--naka-blue, #6fa8dc) 80%, transparent 100%);
      opacity: 0;
      z-index: 15;
      pointer-events: none;
      filter: blur(0.5px);
      animation: ptxScan ${COVER_MS + REVEAL_MS}ms ease-in-out forwards;
    }
    @keyframes ptxScan {
      0%   { top: 0%; opacity: 1; }
      100% { top: 100%; opacity: 0.3; }
    }

    .page-tx-flash {
      position: absolute;
      inset: 0;
      z-index: 12;
      pointer-events: none;
      animation: ptxFlash 180ms ease-out forwards;
    }
    @keyframes ptxFlash {
      0%   { opacity: 0.85; }
      100% { opacity: 0; }
    }

    /* RGB split overlays during glitch */
    .page-tx-rgb-red {
      position: absolute; inset: 0; z-index: 10;
      pointer-events: none; mix-blend-mode: screen;
      box-shadow: inset 0 0 80px rgba(255,0,50,0.12);
      animation: ptxRGBRed ${GLITCH_MS}ms steps(4) forwards;
    }
    .page-tx-rgb-blue {
      position: absolute; inset: 0; z-index: 10;
      pointer-events: none; mix-blend-mode: screen;
      box-shadow: inset 0 0 80px rgba(0,100,255,0.12);
      animation: ptxRGBBlue ${GLITCH_MS}ms steps(4) forwards;
    }
    @keyframes ptxRGBRed {
      0%, 100% { transform: none; opacity: 0; }
      20% { transform: translate(8px, -3px); opacity: 1; }
      40% { transform: translate(-6px, 4px); opacity: 0.7; }
      60% { transform: translate(10px, 2px); opacity: 1; }
      80% { transform: translate(-4px, -5px); opacity: 0.5; }
    }
    @keyframes ptxRGBBlue {
      0%, 100% { transform: none; opacity: 0; }
      20% { transform: translate(-7px, 4px); opacity: 1; }
      40% { transform: translate(9px, -2px); opacity: 0.8; }
      60% { transform: translate(-10px, -3px); opacity: 1; }
      80% { transform: translate(5px, 5px); opacity: 0.6; }
    }

    .page-tx-noise {
      position: absolute; inset: 0; z-index: 8;
      pointer-events: none;
      background: repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(255,255,255,0.02) 2px, rgba(255,255,255,0.02) 4px);
      animation: ptxNoise ${GLITCH_MS}ms linear forwards;
    }
    @keyframes ptxNoise {
      0% { opacity: 0; }
      20% { opacity: 0.7; }
      80% { opacity: 0.5; }
      100% { opacity: 0; }
    }
  `;
  document.head.appendChild(style);
}

export default function PageTransition({ tabKey, children }) {
  const wrapRef = useRef(null);
  const prevKeyRef = useRef(tabKey);
  const [phase, setPhase] = useState("idle");
  const timersRef = useRef([]);
  const pendingChildrenRef = useRef(null);
  const [displayed, setDisplayed] = useState(children);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const addTimer = useCallback((fn, ms) => {
    timersRef.current.push(setTimeout(fn, ms));
  }, []);

  useLayoutEffect(() => {
    injectStyles();
  }, []);

  // Transition effect — only triggers on tabKey change
  useLayoutEffect(() => {
    if (prevKeyRef.current === tabKey) return;
    prevKeyRef.current = tabKey;

    pendingChildrenRef.current = children;
    clearTimers();

    // Phase 1: Glitch (old content with dramatic RGB distortion)
    setPhase("glitch");

    addTimer(() => {
      // Phase 2: Cover — dark blocks sweep over, hiding old content
      setPhase("cover");

      addTimer(() => {
        // Swap content while fully covered by blocks
        setDisplayed(pendingChildrenRef.current);

        // Phase 3: Reveal — blocks scatter away showing new content
        setPhase("reveal");

        addTimer(() => {
          pendingChildrenRef.current = null;
          setPhase("idle");
        }, REVEAL_MS + 100);
      }, COVER_MS);
    }, GLITCH_MS);

    return clearTimers;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabKey]);

  // Sync children when not transitioning
  useEffect(() => {
    if (phase === "idle" && pendingChildrenRef.current === null) {
      setDisplayed(children);
    }
  }, [children, phase]);

  // Pre-compute random scatter values once so they stay stable across renders
  const blockRandom = useMemo(() => {
    const data = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const angle = Math.random() * Math.PI * 2;
        const magnitude = 25 + Math.random() * 50;
        data.push({
          dx: Math.cos(angle) * magnitude,
          dy: Math.sin(angle) * magnitude,
          rot: (Math.random() - 0.5) * 4,
        });
      }
    }
    return data;
  }, []);

  // Generate block grid
  const renderBlocks = useCallback((animClass) => {
    const blocks = [];
    const w = 100 / COLS;
    const h = 100 / ROWS;
    const isCover = animClass === "page-tx-block-cover";
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const idx = r * COLS + c;
        // Diagonal stagger from top-left
        const dist = (r + c) / (ROWS + COLS - 2);
        const delay = dist * (isCover ? COVER_MS * 0.6 : REVEAL_MS * 0.55);
        const dur = isCover ? COVER_MS * 0.5 : REVEAL_MS * 0.6;

        const { dx, dy, rot } = blockRandom[idx];

        blocks.push(
          <div
            key={`${r}-${c}`}
            className={`page-tx-block ${animClass}`}
            style={{
              left: `${c * w}%`,
              top: `${r * h}%`,
              width: `${w}%`,
              height: `${h}%`,
              "--block-delay": `${delay}ms`,
              "--block-dur": `${dur}ms`,
              "--dx": `${dx}px`,
              "--dy": `${dy}px`,
              "--rot": `${rot}deg`,
              background: "linear-gradient(135deg, rgba(8,8,14,0.96), rgba(12,10,20,0.94))",
              borderRight: "1px solid rgba(200,168,80,0.1)",
              borderBottom: "1px solid rgba(0,255,255,0.06)",
              boxShadow: "inset 0 0 6px rgba(0,255,255,0.02)",
            }}
          />
        );
      }
    }
    return blocks;
  }, [blockRandom]);

  const glitchClass = phase === "glitch" ? "page-tx-glitch" : "";

  return (
    <div ref={wrapRef} className="page-tx-wrap">
      {/* RGB split overlays during glitch */}
      {phase === "glitch" && (
        <>
          <div className="page-tx-rgb-red" />
          <div className="page-tx-rgb-blue" />
          <div className="page-tx-noise" />
          {/* Edge chromatic aberration */}
          <div style={{
            position: "absolute", inset: 0, zIndex: 11, pointerEvents: "none",
            boxShadow: "inset 6px 0 20px rgba(255,0,80,0.12), inset -6px 0 20px rgba(0,150,255,0.12), inset 0 4px 15px rgba(0,255,200,0.06), inset 0 -4px 15px rgba(200,168,80,0.08)",
          }} />
        </>
      )}

      {/* Scanline sweep */}
      {(phase === "cover" || phase === "reveal") && (
        <div className="page-tx-scanline" />
      )}

      {/* Flash on phase transitions */}
      {phase === "cover" && (
        <div className="page-tx-flash" style={{ background: "radial-gradient(circle at center, rgba(255,255,255,0.3) 0%, rgba(200,168,80,0.2) 30%, rgba(0,255,255,0.08) 60%, transparent 70%)" }} />
      )}

      {/* Dark blocks sweep in to cover old content */}
      {phase === "cover" && renderBlocks("page-tx-block-cover")}

      {/* Dark blocks scatter away to reveal new content */}
      {phase === "reveal" && renderBlocks("page-tx-block-reveal")}

      {/* Content */}
      <div
        className={`page-tx-content ${glitchClass}`}
        style={{ width: "100%" }}
      >
        {displayed}
      </div>
    </div>
  );
}
