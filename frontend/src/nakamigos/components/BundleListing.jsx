import { useEffect, useRef } from "react";
import NftImage from "./NftImage";
import { useActiveCollection } from "../contexts/CollectionContext";


export default function BundleListing({ nfts, onClose }) {
  const collection = useActiveCollection();
  const modalRef = useRef(null);

  // Close on Escape + focus trap
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") { onClose(); return; }
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
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    const closeBtn = modalRef.current?.querySelector('[aria-label="Close modal"]');
    closeBtn?.focus();
    return () => {
      window.removeEventListener("keydown", h);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  // Show a sample of the user's NFTs (up to 12)
  const previewNfts = nfts.slice(0, 12);

  return (
    <div className="modal-bg" onClick={onClose} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="Bundle Listing">
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card)", border: "1px solid var(--border)",
          borderRadius: 14, maxWidth: 480, width: "94%", margin: "auto",
          padding: "28px 24px", position: "relative",
          maxHeight: "85vh", overflowY: "auto",
        }}
      >
        {/* Close button */}
        <button
          className="modal-close"
          onClick={onClose}
          aria-label="Close modal"
          style={{ position: "absolute", top: 12, right: 14 }}
        >{"\u2715"}</button>

        {/* Type label */}
        <div style={{
          fontFamily: "var(--pixel)", fontSize: 10, color: "var(--gold, #c8a850)",
          letterSpacing: "0.1em", marginBottom: 6,
        }}>
          BUNDLE LISTING
        </div>

        {/* Title */}
        <div style={{
          fontFamily: "var(--display)", fontSize: 18, fontWeight: 600,
          color: "var(--text)", marginBottom: 20,
        }}>
          {collection.name} Bundle Listings
        </div>

        {/* Coming Soon content */}
        <div style={{ textAlign: "center", padding: "10px 0 20px" }}>
          {/* Icon */}
          <div style={{
            width: 56, height: 56, borderRadius: "50%",
            background: "rgba(200,168,80,0.1)", border: "2px solid var(--gold, #c8a850)",
            display: "flex", alignItems: "center", justifyContent: "center",
            margin: "0 auto 16px",
          }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--gold, #c8a850)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 3v18" />
            </svg>
          </div>

          <div style={{
            fontFamily: "var(--display)", fontSize: 16, color: "var(--gold, #c8a850)",
            marginBottom: 8, fontWeight: 600,
          }}>
            Coming Soon
          </div>

          <div style={{
            fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)",
            lineHeight: 1.6, maxWidth: 340, margin: "0 auto 16px",
          }}>
            Bundle listings are not yet supported on the native orderbook.
            This feature will allow you to list multiple NFTs as a single bundle
            at a lower fee rate. For now, you can list NFTs individually.
          </div>

          {/* Preview grid of user's NFTs */}
          {previewNfts.length > 0 && (
            <div style={{
              display: "flex", flexWrap: "wrap", gap: 6,
              justifyContent: "center", margin: "14px 0 6px",
              opacity: 0.5,
            }}>
              {previewNfts.map((nft) => (
                <NftImage
                  key={nft.id}
                  nft={nft}
                  style={{ width: 40, height: 40, borderRadius: 6, objectFit: "cover" }}
                />
              ))}
            </div>
          )}

          {nfts.length > 0 && (
            <div style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)",
              marginBottom: 16,
            }}>
              {nfts.length} NFTs available to list individually
            </div>
          )}
        </div>

        <button className="btn-primary" style={{ width: "100%", textAlign: "center", fontSize: 12 }} onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
