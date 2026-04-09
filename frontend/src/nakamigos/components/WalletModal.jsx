import { useEffect, useRef } from "react";
import { useWallet, HAS_WC_PROJECT_ID } from "../contexts/WalletContext";
import { useActiveCollection } from "../contexts/CollectionContext";
import { lockScroll, unlockScroll } from "../lib/scrollLock";

const CONNECTOR_ICONS = {
  metaMask: "\u{1F98A}",
  "io.metamask": "\u{1F98A}",
  phantom: "\u{1F47B}",
  rainbow: "\u{1F308}",
  walletConnect: "\u{1F517}",
  coinbaseWalletSDK: "\u{1F535}",
};

const CONNECTOR_LABELS = {
  metaMask: "MetaMask",
  "io.metamask": "MetaMask",
  phantom: "Phantom",
  rainbow: "Rainbow",
  walletConnect: "WalletConnect",
  coinbaseWalletSDK: "Coinbase Wallet",
};

export default function WalletModal({ onClose, addToast }) {
  const collection = useActiveCollection();
  const { connectWallet, disconnect, availableConnectors, isPending, isConnected, address, connectError } = useWallet();
  const modalRef = useRef(null);
  const wasConnectedOnMount = useRef(isConnected && !!address);

  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      // Focus trap
      if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else {
          if (document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    lockScroll();
    // Focus close button on mount
    const closeBtn = modalRef.current?.querySelector('[aria-label="Close modal"]');
    closeBtn?.focus();
    return () => {
      document.removeEventListener("keydown", handleKey);
      unlockScroll();
    };
  }, [onClose]);

  // Auto-close on successful connection (only if user connected AFTER opening modal)
  useEffect(() => {
    if (isConnected && address && !wasConnectedOnMount.current) {
      addToast?.(`Connected: ${address.slice(0, 6)}...${address.slice(-4)}`, "success");
      onClose();
    }
  }, [isConnected, address, onClose, addToast]);

  return (
    <div
      className="modal-bg modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Connect Wallet"
    >
      <div
        ref={modalRef}
        className="modal-enter"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: "32px 28px",
          width: "min(420px, 90vw)",
          backdropFilter: "var(--glass-blur)",
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 24 }}>
          <h2 style={{
            fontFamily: "var(--display)",
            fontSize: 20,
            fontWeight: 700,
            color: "var(--text)",
            letterSpacing: "-0.02em",
          }}>
            Connect Wallet
          </h2>
          <button className="modal-close" onClick={onClose} aria-label="Close modal">{"\u2715"}</button>
        </div>

        <p style={{
          fontFamily: "var(--mono)",
          fontSize: 11,
          color: "var(--text-dim)",
          marginBottom: 20,
          lineHeight: 1.5,
        }}>
          Choose your preferred wallet to connect to {collection.name} Gallery.
        </p>

        {/* Connector list */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {availableConnectors.map((connector) => (
            <button
              key={connector.id}
              onClick={() => connectWallet(connector.id)}
              disabled={isPending}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "14px 16px",
                borderRadius: 12,
                background: "var(--border)",
                border: "1px solid var(--border)",
                cursor: isPending ? "wait" : "pointer",
                transition: "all 0.2s",
                width: "100%",
                textAlign: "left",
                opacity: isPending ? 0.6 : 1,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = "rgba(111,168,220,0.08)";
                e.currentTarget.style.borderColor = "rgba(111,168,220,0.2)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--border)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              {/* Icon */}
              <span style={{
                width: 40, height: 40,
                borderRadius: 10,
                background: "rgba(111,168,220,0.08)",
                display: "grid", placeItems: "center",
                fontSize: 20,
                flexShrink: 0,
              }}>
                {connector.icon ? (
                  <img src={connector.icon} alt="" style={{ width: 24, height: 24, borderRadius: 6 }} />
                ) : (
                  CONNECTOR_ICONS[connector.id] || "\u{1F4B0}"
                )}
              </span>

              {/* Label */}
              <div style={{ flex: 1 }}>
                <div style={{
                  fontFamily: "var(--display)",
                  fontSize: 14,
                  fontWeight: 600,
                  color: "var(--text)",
                }}>
                  {CONNECTOR_LABELS[connector.id] || connector.name}
                </div>
                <div style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--text-muted)",
                  marginTop: 2,
                }}>
                  {(connector.id === "metaMask" || connector.id === "io.metamask") && "Browser extension"}
                  {connector.id === "phantom" && "Phantom browser extension"}
                  {connector.id === "rainbow" && "Rainbow browser extension"}
                  {connector.id === "walletConnect" && "QR code \u00b7 Mobile wallets"}
                  {connector.id === "coinbaseWalletSDK" && "Coinbase Wallet app"}
                </div>
              </div>

              {/* Arrow */}
              <span style={{ color: "var(--text-muted)", fontSize: 16 }}>{"\u2192"}</span>
            </button>
          ))}
        </div>

        {/* Disconnect button (when already connected) */}
        {isConnected && address && (
          <button
            onClick={() => {
              disconnect();
              addToast?.("Wallet disconnected", "info");
              onClose();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              width: "100%",
              padding: "12px 16px",
              marginTop: 12,
              borderRadius: 12,
              background: "rgba(248,113,113,0.06)",
              border: "1px solid rgba(248,113,113,0.15)",
              cursor: "pointer",
              transition: "all 0.2s",
              fontFamily: "var(--display)",
              fontSize: 13,
              fontWeight: 600,
              color: "var(--red, #ff6464)",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = "rgba(248,113,113,0.12)";
              e.currentTarget.style.borderColor = "rgba(248,113,113,0.3)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = "rgba(248,113,113,0.06)";
              e.currentTarget.style.borderColor = "rgba(248,113,113,0.15)";
            }}
          >
            Disconnect ({address.slice(0, 6)}...{address.slice(-4)})
          </button>
        )}

        {isPending && (
          <div style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--naka-blue)",
            textAlign: "center",
            marginTop: 16,
          }}>
            <span className="spinner" /> Connecting...
          </div>
        )}

        {connectError && !isPending && (
          <div style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--red)",
            background: "rgba(248,113,113,0.06)",
            border: "1px solid rgba(248,113,113,0.15)",
            borderRadius: 8,
            padding: "10px 14px",
            marginTop: 12,
            textAlign: "center",
            lineHeight: 1.5,
          }}>
            {connectError.includes("provider")
              ? "No wallet extension detected. Please install MetaMask or another Web3 wallet."
              : connectError.includes("reject") || connectError.includes("denied")
              ? "Connection request was declined."
              : "Could not connect wallet. Please try again."}
          </div>
        )}

        {!HAS_WC_PROJECT_ID && (
          <div style={{
            fontFamily: "var(--mono)",
            fontSize: 10,
            color: "var(--naka-blue, #6fa8dc)",
            background: "rgba(111,168,220,0.06)",
            border: "1px solid rgba(111,168,220,0.12)",
            borderRadius: 8,
            padding: "10px 14px",
            marginTop: 12,
            textAlign: "center",
            lineHeight: 1.5,
          }}>
            WalletConnect &amp; Rainbow require a project ID.
            <br />
            Set <strong>VITE_WALLETCONNECT_PROJECT_ID</strong> in .env
          </div>
        )}

        <div style={{
          fontFamily: "var(--mono)",
          fontSize: 9,
          color: "var(--text-faint)",
          textAlign: "center",
          marginTop: 20,
          lineHeight: 1.6,
        }}>
          By connecting, you agree to the terms of use.
          <br />
          Supports Ethereum Mainnet only.
        </div>
      </div>
    </div>
  );
}
