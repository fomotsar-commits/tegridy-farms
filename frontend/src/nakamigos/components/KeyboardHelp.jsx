import { useEffect, useRef, useCallback } from "react";
import { lockScroll, unlockScroll } from "../lib/scrollLock";

const SHORTCUTS = [
  ["Navigation", [
    ["j / k", "Next / previous item"],
    ["Enter", "Open selected item"],
    ["Escape", "Close modal / deselect"],
    ["g", "Go to Gallery"],
    ["1\u20139, 0", "Switch tabs"],
  ]],
  ["Actions", [
    ["f", "Toggle favorite (focused card)"],
    ["c", "Add to cart (focused card)"],
    ["s or /", "Focus search"],
    ["m", "Toggle sound"],
    ["?", "Toggle this help"],
  ]],
];

const overlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 10200,
  background: "rgba(0,0,0,0.75)",
  backdropFilter: "blur(12px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  animation: "fadeIn 0.15s ease-out",
};

const panelStyle = {
  background: "var(--surface, #111)",
  border: "1px solid var(--border, #333)",
  borderRadius: 16,
  padding: "32px 40px",
  maxWidth: 520,
  width: "90vw",
  boxShadow: "0 0 60px rgba(200,168,80,0.15)",
};

const titleStyle = {
  fontFamily: "var(--pixel)",
  fontSize: 11,
  color: "var(--gold, #c8a850)",
  letterSpacing: "0.08em",
  marginBottom: 24,
  textAlign: "center",
};

const sectionStyle = {
  fontFamily: "var(--pixel)",
  fontSize: 8,
  color: "var(--naka-blue, #6fa8dc)",
  letterSpacing: "0.06em",
  marginTop: 20,
  marginBottom: 10,
  textTransform: "uppercase",
};

const rowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "6px 0",
  borderBottom: "1px solid rgba(255,255,255,0.04)",
};

const keyStyle = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--text, #fff)",
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6,
  padding: "3px 8px",
  minWidth: 28,
  textAlign: "center",
  display: "inline-block",
};

const descStyle = {
  fontFamily: "var(--mono)",
  fontSize: 11,
  color: "var(--text-muted, #888)",
};

export default function KeyboardHelp({ onClose }) {
  const panelRef = useRef(null);
  const closeButtonRef = useRef(null);

  // Focus the close button on mount for screen readers + lock scroll
  useEffect(() => {
    closeButtonRef.current?.focus();
    lockScroll();
    return () => { unlockScroll(); };
  }, []);

  // Focus trap: keep Tab cycling within the modal
  const handleKeyDown = useCallback((e) => {
    if (e.key === "Escape" || e.key === "?") {
      e.preventDefault();
      onClose();
      return;
    }

    if (e.key === "Tab") {
      const panel = panelRef.current;
      if (!panel) return;
      const focusable = panel.querySelectorAll('button, [href], [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
  }, [onClose]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  return (
    <div style={overlayStyle} onClick={onClose} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
      <div ref={panelRef} style={panelStyle} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <div style={titleStyle}>KEYBOARD SHORTCUTS</div>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close keyboard shortcuts"
            style={{
              background: "none", border: "1px solid var(--border, #333)",
              borderRadius: 6, color: "var(--text-muted, #888)", cursor: "pointer",
              fontSize: 14, width: 28, height: 28, display: "flex",
              alignItems: "center", justifyContent: "center",
            }}
          >
            {"\u2715"}
          </button>
        </div>
        {SHORTCUTS.map(([section, keys]) => (
          <div key={section}>
            <div style={sectionStyle}>{section}</div>
            {keys.map(([key, desc]) => (
              <div key={key} style={rowStyle}>
                <span style={keyStyle}>{key}</span>
                <span style={descStyle}>{desc}</span>
              </div>
            ))}
          </div>
        ))}
        <div style={{ textAlign: "center", marginTop: 24, fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)" }}>
          Press <span style={keyStyle}>?</span> or <span style={keyStyle}>Esc</span> to close
        </div>
      </div>
    </div>
  );
}
