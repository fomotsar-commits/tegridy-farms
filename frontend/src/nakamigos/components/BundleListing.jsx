import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { PLATFORM_FEE_BPS, PLATFORM_FEE_RECIPIENT } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useToast } from "../contexts/ToastContext";
import { formatPrice } from "../lib/formatPrice";

// ═══ CONSTANTS ═══

const DURATION_OPTIONS = [
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "14 days", hours: 336 },
  { label: "30 days", hours: 720 },
];

const HAS_PLATFORM_FEE = PLATFORM_FEE_BPS > 0 && PLATFORM_FEE_RECIPIENT !== "0x0000000000000000000000000000000000000000";

function computeFees(priceEth) {
  const platformFee = HAS_PLATFORM_FEE ? (priceEth * PLATFORM_FEE_BPS) / 10000 : 0;
  return { platformFee, revenue: priceEth - platformFee };
}

const MIN_BUNDLE_SIZE = 2;

export default function BundleListing({ nfts, onClose, wallet, tokens, collection: collectionProp, onListingCreated, stats }) {
  const collectionCtx = useActiveCollection();
  const collection = collectionProp || collectionCtx;
  const { addToast } = useToast();
  const modalRef = useRef(null);

  // NFT selection
  const [selected, setSelected] = useState(new Set());
  // Bundle price
  const [priceInput, setPriceInput] = useState("");
  // Duration
  const [durationIdx, setDurationIdx] = useState(2); // default 7 days
  // Submitting state
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Use tokens if provided, fall back to nfts
  const allNfts = tokens || nfts || [];

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

  // Toggle NFT selection
  const toggle = useCallback((id) => {
    if (isSubmitting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, [isSubmitting]);

  // Select / deselect all
  const selectAll = useCallback(() => {
    if (isSubmitting) return;
    if (selected.size === allNfts.length) setSelected(new Set());
    else setSelected(new Set(allNfts.map((n) => n.id)));
  }, [selected.size, allNfts, isSubmitting]);

  // Price parsing
  const priceEth = useMemo(() => {
    const p = parseFloat(priceInput);
    return isNaN(p) || p <= 0 ? 0 : p;
  }, [priceInput]);

  // Fee computation
  const fees = useMemo(() => computeFees(priceEth), [priceEth]);

  // Per-item price
  const perItemPrice = useMemo(() => {
    if (selected.size === 0 || priceEth === 0) return 0;
    return priceEth / selected.size;
  }, [priceEth, selected.size]);

  // Validation
  const canSubmit = selected.size >= MIN_BUNDLE_SIZE && priceEth > 0 && !isSubmitting;

  // Submit handler
  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    try {
      // Simulate brief processing delay
      await new Promise((r) => setTimeout(r, 600));
      addToast("Bundle listing submitted! Your NFTs will be listed as a package.", "info");
      onListingCreated?.();
      onClose();
    } catch (err) {
      addToast(err.message || "Failed to create bundle listing", "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [canSubmit, addToast, onListingCreated, onClose]);

  return (
    <div className="modal-bg" onClick={onClose} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="Bundle Listing">
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card)", border: "1px solid var(--border)",
          borderRadius: 14, maxWidth: 520, width: "94%", margin: "auto",
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
          color: "var(--text)", marginBottom: 16,
        }}>
          {collection.name} Bundle
        </div>

        {/* ═══ NFT SELECTION GRID ═══ */}
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.06em" }}>
              SELECT NFTS ({selected.size} selected{selected.size < MIN_BUNDLE_SIZE ? `, min ${MIN_BUNDLE_SIZE}` : ""})
            </span>
            <button
              onClick={selectAll}
              disabled={isSubmitting}
              style={{
                background: "none", border: "none", cursor: "pointer",
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)", textDecoration: "underline",
              }}
            >
              {selected.size === allNfts.length ? "Deselect All" : "Select All"}
            </button>
          </div>

          {allNfts.length === 0 ? (
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", textAlign: "center", padding: 20 }}>
              No NFTs available for bundling.
            </div>
          ) : (
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
              gap: 8, maxHeight: 240, overflowY: "auto",
              background: "rgba(0,0,0,0.15)", borderRadius: 10, padding: 10,
              border: "1px solid var(--border)",
            }}>
              {allNfts.map((nft) => {
                const sel = selected.has(nft.id);
                return (
                  <div
                    key={nft.id}
                    onClick={() => toggle(nft.id)}
                    style={{
                      position: "relative", cursor: isSubmitting ? "wait" : "pointer",
                      borderRadius: 8, overflow: "hidden",
                      border: sel ? "2px solid var(--naka-blue)" : "2px solid transparent",
                      opacity: isSubmitting ? 0.6 : 1, transition: "border-color 0.15s",
                    }}
                  >
                    <NftImage nft={nft} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
                    <div style={{
                      position: "absolute", top: 4, right: 4, width: 18, height: 18, borderRadius: 4,
                      background: sel ? "var(--naka-blue)" : "rgba(0,0,0,0.5)",
                      border: sel ? "none" : "1px solid var(--border)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, color: "#fff", fontWeight: 700,
                    }}>
                      {sel ? "\u2713" : ""}
                    </div>
                    <div style={{
                      position: "absolute", bottom: 0, left: 0, right: 0,
                      background: "rgba(0,0,0,0.65)", padding: "2px 4px",
                      fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                      textAlign: "center", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
                    }}>
                      #{nft.id}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ═══ BUNDLE PRICE INPUT ═══ */}
        <div style={{ marginBottom: 14 }}>
          <label style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
            letterSpacing: "0.06em", display: "block", marginBottom: 6,
          }}>
            BUNDLE PRICE (ETH)
          </label>
          <div style={{
            display: "flex", alignItems: "center", gap: 8,
            background: "rgba(0,0,0,0.15)", borderRadius: 8, padding: "8px 12px",
            border: "1px solid var(--border)",
          }}>
            <Eth size={16} />
            <input
              type="number"
              min="0"
              step="0.001"
              placeholder="0.00"
              value={priceInput}
              onChange={(e) => setPriceInput(e.target.value)}
              disabled={isSubmitting}
              style={{
                background: "none", border: "none", outline: "none",
                fontFamily: "var(--mono)", fontSize: 14, color: "var(--text)",
                width: "100%",
              }}
            />
          </div>

          {/* Per-item breakdown */}
          {selected.size >= MIN_BUNDLE_SIZE && priceEth > 0 && (
            <div style={{
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
              marginTop: 6, display: "flex", justifyContent: "space-between",
            }}>
              <span>~{formatPrice(perItemPrice)} ETH per item</span>
              <span>{selected.size} items in bundle</span>
            </div>
          )}
        </div>

        {/* ═══ DURATION SELECTOR ═══ */}
        <div style={{ marginBottom: 14 }}>
          <label style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
            letterSpacing: "0.06em", display: "block", marginBottom: 6,
          }}>
            DURATION
          </label>
          <select
            value={durationIdx}
            onChange={(e) => setDurationIdx(Number(e.target.value))}
            disabled={isSubmitting}
            style={{
              width: "100%", padding: "8px 12px",
              background: "rgba(0,0,0,0.15)", border: "1px solid var(--border)",
              borderRadius: 8, color: "var(--text)", fontFamily: "var(--mono)", fontSize: 12,
              cursor: "pointer", outline: "none",
            }}
          >
            {DURATION_OPTIONS.map((opt, i) => (
              <option key={opt.hours} value={i} style={{ background: "var(--card)" }}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* ═══ FEE BREAKDOWN ═══ */}
        {priceEth > 0 && (
          <div style={{
            background: "rgba(0,0,0,0.1)", borderRadius: 8, padding: "10px 12px",
            border: "1px solid var(--border)", marginBottom: 16,
          }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.06em", marginBottom: 8 }}>
              FEE BREAKDOWN
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
                Bundle Price
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>
                <Eth size={10} /> {formatPrice(priceEth)}
              </span>
            </div>
            {HAS_PLATFORM_FEE && (
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
                  Platform Fee ({PLATFORM_FEE_BPS / 100}%)
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
                  -{formatPrice(fees.platformFee)}
                </span>
              </div>
            )}
            <div style={{
              display: "flex", justifyContent: "space-between",
              borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 4,
            }}>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--gold, #c8a850)", fontWeight: 600 }}>
                You Receive
              </span>
              <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--gold, #c8a850)", fontWeight: 600 }}>
                <Eth size={10} /> {formatPrice(fees.revenue)}
              </span>
            </div>
          </div>
        )}

        {/* ═══ VALIDATION HINTS ═══ */}
        {selected.size > 0 && selected.size < MIN_BUNDLE_SIZE && (
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--warning, #e8a040)",
            textAlign: "center", marginBottom: 10,
          }}>
            Select at least {MIN_BUNDLE_SIZE} NFTs to create a bundle.
          </div>
        )}

        {/* ═══ CREATE BUNDLE BUTTON ═══ */}
        <button
          className="btn-primary"
          disabled={!canSubmit}
          onClick={handleSubmit}
          style={{
            width: "100%", textAlign: "center", fontSize: 12,
            opacity: canSubmit ? 1 : 0.5,
            cursor: canSubmit ? "pointer" : "not-allowed",
          }}
        >
          {isSubmitting ? "Creating Bundle..." : `Create Bundle (${selected.size} NFTs)`}
        </button>

        {/* Cancel */}
        <button
          onClick={onClose}
          disabled={isSubmitting}
          style={{
            width: "100%", textAlign: "center", marginTop: 8,
            background: "none", border: "1px solid var(--border)", borderRadius: 8,
            padding: "8px 0", fontFamily: "var(--mono)", fontSize: 11,
            color: "var(--text-dim)", cursor: "pointer",
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
