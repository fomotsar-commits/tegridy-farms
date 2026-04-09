import { useState, useEffect, useCallback } from "react";

// ═══ PWA INSTALL PROMPT ═══
// Shows a subtle banner when the app is installable.
// Pattern used by every major PWA marketplace.

export default function InstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem("pwa_install_dismissed") === "true"; } catch { return false; }
  });

  useEffect(() => {
    const handler = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
    };
    window.addEventListener("beforeinstallprompt", handler);
    return () => window.removeEventListener("beforeinstallprompt", handler);
  }, []);

  const handleInstall = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setDeferredPrompt(null);
    }
  }, [deferredPrompt]);

  const handleDismiss = useCallback(() => {
    setDismissed(true);
    try { localStorage.setItem("pwa_install_dismissed", "true"); } catch {}
  }, []);

  if (!deferredPrompt || dismissed) return null;

  return (
    <div style={{
      position: "fixed", bottom: 70, left: "50%", transform: "translateX(-50%)",
      zIndex: 9500, background: "var(--surface-glass)",
      backdropFilter: "var(--glass-blur)", border: "1px solid var(--border)",
      borderRadius: 12, padding: "12px 20px",
      display: "flex", alignItems: "center", gap: 12,
      boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
      maxWidth: "calc(100vw - 32px)",
    }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontFamily: "var(--pixel)", fontSize: 9, color: "var(--gold)", letterSpacing: "0.1em" }}>
          INSTALL APP
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
          Add to home screen for the full experience
        </div>
      </div>
      <button
        onClick={handleInstall}
        className="btn-primary"
        style={{ fontSize: 10, padding: "8px 16px", whiteSpace: "nowrap" }}
      >
        Install
      </button>
      <button
        onClick={handleDismiss}
        style={{
          background: "none", border: "none", color: "var(--text-muted)",
          cursor: "pointer", fontSize: 16, padding: "4px",
        }}
        aria-label="Dismiss install prompt"
      >
        x
      </button>
    </div>
  );
}
