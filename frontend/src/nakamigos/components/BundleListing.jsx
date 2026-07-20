import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { PLATFORM_FEE_BPS, PLATFORM_FEE_RECIPIENT, BUNDLE_LISTING_ENABLED } from "../constants";
import { createNativeBundleListing, MAX_BUNDLE_ITEMS } from "../lib/orderbook";
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

  // ═══ ALREADY-LISTED DETECTION ═══
  // A token can legally sit in an active SINGLE listing and inside a bundle at the
  // same time — Seaport happily holds both signatures. But they are mutually
  // exclusive at fill time: whichever executes first moves the NFT, and the other
  // order then reverts on the BUYER, who pays gas for nothing and reads it as the
  // marketplace being broken. Nothing on-chain can prevent this, so the seller has
  // to be told before they sign.
  const [alreadyListed, setAlreadyListed] = useState(() => new Set());
  useEffect(() => {
    if (!wallet || !collection?.contract) return;
    let cancelled = false;
    const params = new URLSearchParams({
      action: "query",
      contract: collection.contract,
      maker: wallet,
      status: "active",
      limit: "200",
    });
    // Advisory only: if this fails the seller simply doesn't get the warning.
    fetch(`/api/orderbook?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d?.orders) return;
        setAlreadyListed(new Set(d.orders.map((o) => String(o.token_id)).filter((t) => t !== "null")));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [wallet, collection?.contract]);

  // Toggle NFT selection
  const toggle = useCallback((id) => {
    if (isSubmitting) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size >= MAX_BUNDLE_ITEMS) return prev; // cap — ignore adds past the server max
      else next.add(id);
      return next;
    });
  }, [isSubmitting]);

  // Select / deselect all — capped at MAX_BUNDLE_ITEMS (the server rejects larger bundles).
  const selectAll = useCallback(() => {
    if (isSubmitting) return;
    const selectable = Math.min(allNfts.length, MAX_BUNDLE_ITEMS);
    if (selected.size >= selectable) setSelected(new Set());
    else setSelected(new Set(allNfts.slice(0, MAX_BUNDLE_ITEMS).map((n) => n.id)));
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

  // Selected tokens that ALSO have an active single listing (see alreadyListed above).
  const conflicting = useMemo(
    () => [...selected].filter((id) => alreadyListed.has(String(id))),
    [selected, alreadyListed],
  );

  // Validation
  const canSubmit = selected.size >= MIN_BUNDLE_SIZE && selected.size <= MAX_BUNDLE_ITEMS && priceEth > 0 && !isSubmitting;

  // Submit handler — creates a REAL multi-item Seaport bundle order via
  // createNativeBundleListing. When the feature flag is off it is honest: it tells the
  // user it's coming soon and lists NOTHING (no fake success toast). It only reports
  // success on an actual signed + stored order.
  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;
    if (!BUNDLE_LISTING_ENABLED) {
      addToast("Bundle listing is coming soon — it isn't live yet, so nothing was listed.", "info");
      return;
    }
    setIsSubmitting(true);
    try {
      const items = allNfts
        .filter((n) => selected.has(n.id))
        .map((n) => ({ contract: n.contract || collection?.contract, tokenId: n.id }));
      const result = await createNativeBundleListing({
        items,
        priceEth,
        expirationHours: DURATION_OPTIONS[durationIdx].hours,
      });
      if (result?.success) {
        addToast(`Bundle listed — ${items.length} NFTs for ${priceEth} ETH.`, "success");
        onListingCreated?.();
        onClose();
      } else if (result?.error === "timeout") {
        // A timeout is INDETERMINATE, not a failure — the abort fires client-side and
        // the server may well have stored the row. Telling the seller it failed invites
        // a retry, and a retry signs a fresh salt, which produces a DIFFERENT order hash
        // and so slips past the duplicate-hash guard: two live bundles over the same
        // NFTs. Send them to their listings to check instead of inviting the retry.
        // (Bundle go-live re-audit, must-fix 4.)
        addToast(
          "Timed out waiting for confirmation. Your bundle may still have been created — check My Listings before trying again.",
          "info",
        );
        onListingCreated?.();
        onClose();
      } else {
        addToast(result?.message || "Failed to create bundle listing", "error");
      }
    } catch (err) {
      addToast(err.message || "Failed to create bundle listing", "error");
    } finally {
      setIsSubmitting(false);
    }
  }, [canSubmit, allNfts, selected, priceEth, durationIdx, collection, addToast, onListingCreated, onClose]);

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
                const listedAlone = alreadyListed.has(String(nft.id));
                return (
                  <div
                    key={nft.id}
                    onClick={() => toggle(nft.id)}
                    title={listedAlone ? `#${nft.id} already has an active single listing` : undefined}
                    style={{
                      position: "relative", cursor: isSubmitting ? "wait" : "pointer",
                      borderRadius: 8, overflow: "hidden",
                      border: sel
                        ? `2px solid ${listedAlone ? "var(--gold)" : "var(--naka-blue)"}`
                        : "2px solid transparent",
                      opacity: isSubmitting ? 0.6 : 1, transition: "border-color 0.15s",
                    }}
                  >
                    {listedAlone && (
                      <div style={{
                        position: "absolute", top: 4, left: 4, zIndex: 1,
                        background: "var(--gold)", color: "#000", borderRadius: 3,
                        fontFamily: "var(--mono)", fontSize: 8, fontWeight: 700,
                        padding: "1px 3px", letterSpacing: "0.04em",
                      }}>
                        LISTED
                      </div>
                    )}
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

        {conflicting.length > 0 && (
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--gold, #c8a850)",
            marginBottom: 10, padding: "8px 10px", borderRadius: 8, lineHeight: 1.5,
            background: "rgba(200,168,80,0.08)", border: "1px solid rgba(200,168,80,0.25)",
          }}>
            {conflicting.length === 1
              ? `#${conflicting[0]} is already listed on its own.`
              : `${conflicting.length} of these are already listed on their own (${conflicting.slice(0, 4).map((t) => `#${t}`).join(", ")}${conflicting.length > 4 ? "…" : ""}).`}
            {" "}Both orders stay valid, so whichever sells first cancels the other — the
            second buyer's transaction will fail. Cancel the single listings first if you
            only want the bundle to be fillable.
          </div>
        )}

        {!BUNDLE_LISTING_ENABLED && (
          <div style={{
            fontSize: 11, color: "var(--gold, #c8a850)", textAlign: "center",
            marginBottom: 10, padding: "8px 10px", borderRadius: 8,
            background: "rgba(200,168,80,0.08)", border: "1px solid rgba(200,168,80,0.25)",
          }}>
            Bundle listing is coming soon. You can set one up to preview the fees, but it
            isn't live yet — nothing will be listed.
          </div>
        )}

        {/* ═══ CREATE BUNDLE BUTTON ═══ */}
        <button
          className="btn-primary"
          disabled={!canSubmit || !BUNDLE_LISTING_ENABLED}
          onClick={handleSubmit}
          style={{
            width: "100%", textAlign: "center", fontSize: 12,
            opacity: canSubmit && BUNDLE_LISTING_ENABLED ? 1 : 0.5,
            cursor: canSubmit && BUNDLE_LISTING_ENABLED ? "pointer" : "not-allowed",
          }}
        >
          {!BUNDLE_LISTING_ENABLED
            ? "Coming Soon"
            : isSubmitting ? "Creating Bundle..." : `Create Bundle (${selected.size} NFTs)`}
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
