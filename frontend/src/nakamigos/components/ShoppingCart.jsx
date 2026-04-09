import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { fulfillSeaportOrder, getProvider } from "../api";
import { recordTransaction } from "../lib/transactions";
import { getFriendlyError } from "../lib/errorMessages";
import { validateOrderFillability } from "../lib/orderValidator";
import { useActiveCollection } from "../contexts/CollectionContext";
import EmptyState from "./EmptyState";

export default function ShoppingCart({
  cart,
  onRemove,
  onClear,
  onClose,
  wallet,
  onConnect,
  addToast,
  isOpen,
  listings,
  onRefreshCart,
}) {
  const { slug } = useActiveCollection();
  const [buying, setBuying] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [confirming, setConfirming] = useState(false);
  const [estimatedGas, setEstimatedGas] = useState(null);
  const [estimatingGas, setEstimatingGas] = useState(false);
  // Order validation state: Map of item.id -> { status, reason, warnings }
  const [validationResults, setValidationResults] = useState({});
  const [validating, setValidating] = useState(false);

  // Detect stale cart prices by comparing with current listings
  const staleItems = useMemo(() => {
    if (!listings?.length || !cart.length) return [];
    return cart.filter(item => {
      const currentListing = listings.find(l => String(l.tokenId) === String(item.id));
      if (!currentListing) return true; // listing may have been removed
      return Math.abs(currentListing.price - item.price) > 1e-6;
    });
  }, [cart, listings]);
  const panelRef = useRef(null);

  // ESC to close — stopImmediatePropagation prevents other Escape handlers from firing
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (confirming) {
          setConfirming(false);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose, confirming]);

  // Focus trap — focus panel on open and trap Tab key within it
  useEffect(() => {
    if (!isOpen) return;
    if (panelRef.current) panelRef.current.focus();
    const handleTab = (e) => {
      if (e.key !== "Tab" || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first || document.activeElement === panelRef.current) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", handleTab);
    return () => window.removeEventListener("keydown", handleTab);
  }, [isOpen]);

  // Reset confirmation when cart changes
  useEffect(() => {
    setConfirming(false);
    setEstimatedGas(null);
  }, [cart.length]);

  const totalPrice = cart.reduce((sum, item) => sum + (item.price || 0), 0);

  // Count items missing order data
  const itemsMissingOrder = cart.filter(item => !item.orderHash);
  const purchasableItems = cart.filter(item => item.orderHash);

  // Estimate gas for the batch purchase
  const estimateGas = useCallback(async () => {
    if (!wallet) return;
    setEstimatingGas(true);
    try {
      const ethProvider = getProvider();
      if (!ethProvider) {
        // Fallback: rough estimate of ~150k gas per Seaport fill at ~30 gwei
        const perTxGas = 0.0045; // ~150k gas * 30 gwei
        setEstimatedGas(purchasableItems.length * perTxGas);
        return;
      }

      const { ethers } = await import("ethers");
      const provider = new ethers.BrowserProvider(ethProvider);
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || BigInt(30e9);

      // Estimate ~200k gas per Seaport fulfillment (conservative)
      const gasPerTx = BigInt(200000);
      const totalGasWei = gasPrice * gasPerTx * BigInt(purchasableItems.length);
      const totalGasEth = parseFloat(ethers.formatEther(totalGasWei));

      setEstimatedGas(totalGasEth);
    } catch (err) {
      console.warn("Gas estimation failed:", err.message);
      // Fallback estimate
      const perTxGas = 0.0045;
      setEstimatedGas(purchasableItems.length * perTxGas);
    } finally {
      setEstimatingGas(false);
    }
  }, [wallet, purchasableItems.length]);

  // Validate all cart items before checkout
  const validateCart = useCallback(async () => {
    if (!cart.length) return;
    setValidating(true);
    const results = {};

    try {
      let ethersProvider = null;
      const ethProvider = getProvider();
      if (ethProvider) {
        const { ethers } = await import("ethers");
        ethersProvider = new ethers.BrowserProvider(ethProvider);
      }

      // Validate all items in parallel
      const validations = await Promise.all(
        cart.map(async (item) => {
          if (!item.orderHash) {
            return { id: item.id, status: "red", reason: "Missing order data", warnings: [] };
          }
          try {
            const result = await validateOrderFillability(ethersProvider, item, wallet);
            return { id: item.id, ...result };
          } catch {
            return { id: item.id, status: "yellow", warnings: ["Validation check failed"], layer: 0 };
          }
        })
      );

      for (const v of validations) {
        results[v.id] = v;
      }
    } catch {
      // If validation itself fails, don't block -- mark all as yellow
      for (const item of cart) {
        results[item.id] = { status: "yellow", warnings: ["Could not validate"], layer: 0 };
      }
    }

    setValidationResults(results);
    setValidating(false);

    // Auto-remove items that definitively fail validation
    const removedNames = [];
    for (const item of cart) {
      const v = results[item.id];
      if (v?.status === "red") {
        removedNames.push(`${item.name}: ${v.reason}`);
        onRemove(item.id);
      }
    }
    if (removedNames.length > 0) {
      addToast?.(`Removed ${removedNames.length} invalid item${removedNames.length !== 1 ? "s" : ""} from cart`, "warning");
    }

    return results;
  }, [cart, wallet, onRemove, addToast]);

  // Initiate confirmation step
  const handleSweepClick = useCallback(async () => {
    if (!wallet) {
      onConnect();
      return;
    }

    if (cart.length === 0) return;

    // Check if any items can actually be purchased
    if (purchasableItems.length === 0) {
      addToast?.("No items have order data — cannot purchase. Try adding items from the Listings tab.", "error");
      return;
    }

    // Warn about items missing order data
    if (itemsMissingOrder.length > 0) {
      addToast?.(`${itemsMissingOrder.length} item(s) missing order data and will be skipped`, "warning");
    }

    // Run validation before showing confirmation
    addToast?.("Validating orders...", "info");
    const results = await validateCart();

    // Check if any purchasable items remain after validation removed red items
    const remainingPurchasable = purchasableItems.filter(
      item => !results[item.id] || results[item.id].status !== "red"
    );
    if (remainingPurchasable.length === 0) {
      addToast?.("No valid items remaining in cart", "error");
      return;
    }

    // Show confirmation step and estimate gas
    setConfirming(true);
    estimateGas();
  }, [wallet, cart.length, purchasableItems.length, itemsMissingOrder.length, onConnect, addToast, estimateGas, validateCart]);

  // Execute the actual sweep after confirmation
  const handleConfirmSweep = useCallback(async () => {
    setConfirming(false);
    setBuying(true);
    setProgress({ current: 0, total: purchasableItems.length });

    for (let i = 0; i < purchasableItems.length; i++) {
      const item = purchasableItems[i];
      setProgress({ current: i + 1, total: purchasableItems.length });

      // Re-check that the listing is still available at the expected price.
      const currentListing = listings?.find(l => String(l.tokenId) === String(item.id));
      if (!currentListing) {
        addToast?.(`${item.name} is no longer listed — skipping`, "warning");
        onRemove(item.id);
        continue;
      }
      if (currentListing.price !== item.price) {
        addToast?.(`${item.name} price changed (${item.price} → ${currentListing.price} ETH) — skipping`, "warning");
        onRemove(item.id);
        continue;
      }

      addToast?.(`Buying ${item.name}... (${i + 1}/${purchasableItems.length})`, "info");

      const result = await fulfillSeaportOrder(item);

      if (result.success) {
        recordTransaction({ type: "buy", nft: item, price: item.price, hash: result.hash, wallet, slug });
        addToast?.(`Purchased ${item.name}!`, "success");
        onRemove(item.id);
      } else if (result.error === "rejected") {
        addToast?.("Transaction cancelled by user", "info");
        break;
      } else {
        const friendly = getFriendlyError(result.message || result.error || "Transaction failed");
        addToast?.(`Failed to buy ${item.name} — ${friendly}`, "error");
        // Skip and continue with remaining items
        addToast?.(`Skipping ${item.name}, continuing with remaining...`, "warning");
        continue;
      }
    }

    setBuying(false);
    setProgress({ current: 0, total: 0 });
    setEstimatedGas(null);
  }, [purchasableItems, listings, onRemove, addToast, wallet, slug]);

  const handleCancelConfirm = useCallback(() => {
    setConfirming(false);
    setEstimatedGas(null);
  }, []);

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 8000,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(6px)",
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? "auto" : "none",
          transition: "opacity 0.3s ease",
        }}
      />

      {/* Drawer */}
      <aside
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Shopping cart"
        aria-modal="true"
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: 380,
          maxWidth: "100vw",
          zIndex: 8001,
          background: "var(--surface, #111)",
          borderLeft: "1px solid var(--border, #222)",
          display: "flex",
          flexDirection: "column",
          transform: isOpen ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.35s cubic-bezier(0.4,0,0.2,1)",
          boxShadow: isOpen ? "-8px 0 40px rgba(0,0,0,0.6)" : "none",
          outline: "none",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "18px 20px 14px",
          borderBottom: "1px solid var(--border, #222)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{
              fontFamily: "var(--display)",
              fontSize: 16,
              fontWeight: 700,
              color: "var(--text, #eee)",
              letterSpacing: "0.04em",
            }}>
              CART
            </span>
            {cart.length > 0 && (
              <span style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                fontWeight: 700,
                color: "var(--bg, #000)",
                background: "var(--gold, #d4a843)",
                borderRadius: 10,
                padding: "2px 8px",
                minWidth: 20,
                textAlign: "center",
                lineHeight: "16px",
              }}>
                {cart.length}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            aria-label="Close cart"
            style={{
              fontFamily: "var(--mono)",
              fontSize: 18,
              color: "var(--text-dim)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px 8px",
              lineHeight: 1,
            }}
          >
            ✕
          </button>
        </div>

        {/* Items or empty state */}
        <div style={{
          flex: 1,
          overflowY: "auto",
          padding: "10px 0",
        }}>
          {cart.length === 0 ? (
            <EmptyState type="cart" style={{ height: "100%", display: "flex", flexDirection: "column", justifyContent: "center" }} />
          ) : (
            cart.map((item) => (
              <div
                key={item.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "10px 20px",
                  borderBottom: "1px solid var(--border)",
                  transition: "background 0.15s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = "var(--border)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
              >
                {/* Thumbnail */}
                <div style={{
                  width: 52,
                  height: 52,
                  borderRadius: 6,
                  overflow: "hidden",
                  flexShrink: 0,
                  border: "1px solid var(--border, #222)",
                }}>
                  <NftImage
                    nft={item}
                    style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  />
                </div>

                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontFamily: "var(--display)",
                    fontSize: 13,
                    fontWeight: 600,
                    color: "var(--text, #eee)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}>
                    {item.name}
                  </div>
                  <div style={{
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--gold, #d4a843)",
                    marginTop: 2,
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                  }}>
                    <Eth />
                    {item.price ?? "—"}
                  </div>
                </div>

                {/* Validation status indicator */}
                {(() => {
                  const v = validationResults[item.id];
                  if (!item.orderHash) {
                    return (
                      <span
                        title="Missing order data — cannot purchase"
                        style={{
                          fontFamily: "var(--mono)", fontSize: 9,
                          color: "var(--red, #f87171)", background: "rgba(248,113,113,0.1)",
                          border: "1px solid rgba(248,113,113,0.2)", borderRadius: 4,
                          padding: "2px 5px", flexShrink: 0, letterSpacing: "0.04em",
                        }}
                      >
                        NO ORDER
                      </span>
                    );
                  }
                  if (!v) return null;
                  const colors = {
                    green: { color: "var(--green, #4ade80)", bg: "rgba(74,222,128,0.1)", border: "rgba(74,222,128,0.2)" },
                    yellow: { color: "var(--yellow, #fbbf24)", bg: "rgba(251,191,36,0.1)", border: "rgba(251,191,36,0.2)" },
                    red: { color: "var(--red, #f87171)", bg: "rgba(248,113,113,0.1)", border: "rgba(248,113,113,0.2)" },
                  };
                  const c = colors[v.status] || colors.yellow;
                  const label = v.status === "green" ? "VALID" : v.status === "yellow" ? "WARN" : "FAIL";
                  const title = v.reason || (v.warnings?.length ? v.warnings.join("; ") : "");
                  return (
                    <span
                      title={title}
                      style={{
                        fontFamily: "var(--mono)", fontSize: 9,
                        color: c.color, background: c.bg,
                        border: `1px solid ${c.border}`, borderRadius: 4,
                        padding: "2px 5px", flexShrink: 0, letterSpacing: "0.04em",
                        cursor: title ? "help" : "default",
                      }}
                    >
                      {label}
                    </span>
                  );
                })()}

                {/* Remove button */}
                <button
                  onClick={() => onRemove(item.id)}
                  aria-label={`Remove ${item.name} from cart`}
                  disabled={buying}
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 14,
                    color: "var(--text-dim)",
                    background: "none",
                    border: "none",
                    cursor: buying ? "not-allowed" : "pointer",
                    padding: "4px 6px",
                    borderRadius: 4,
                    transition: "color 0.15s, background 0.15s",
                    flexShrink: 0,
                    opacity: buying ? 0.3 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!buying) {
                      e.currentTarget.style.color = "var(--red, #f87171)";
                      e.currentTarget.style.background = "rgba(248,113,113,0.08)";
                    }
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.color = "var(--text-dim)";
                    e.currentTarget.style.background = "none";
                  }}
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer — summary + actions */}
        {cart.length > 0 && (
          <div style={{
            borderTop: "1px solid var(--border, #222)",
            padding: "16px 20px 20px",
          }}>
            {/* Summary */}
            <div style={{ marginBottom: 14 }}>
              <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}>
                <span style={{
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--text-dim)",
                  letterSpacing: "0.08em",
                }}>
                  {cart.length} ITEM{cart.length !== 1 ? "S" : ""}
                  {itemsMissingOrder.length > 0 && (
                    <span style={{ color: "var(--red, #f87171)", marginLeft: 6 }}>
                      ({itemsMissingOrder.length} NOT PURCHASABLE)
                    </span>
                  )}
                </span>
                <span style={{
                  fontFamily: "var(--mono)",
                  fontSize: 14,
                  fontWeight: 700,
                  color: "var(--gold, #d4a843)",
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                }}>
                  <Eth />
                  {totalPrice.toFixed(4)}
                </span>
              </div>

              {/* Estimated gas cost */}
              {estimatedGas !== null && (
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 4,
                }}>
                  <span style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--text-dim)",
                    letterSpacing: "0.08em",
                  }}>
                    EST. GAS
                  </span>
                  <span style={{
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    color: "var(--text-dim)",
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                  }}>
                    ~<Eth />{estimatedGas.toFixed(4)}
                  </span>
                </div>
              )}

              {/* Total with gas */}
              {estimatedGas !== null && (
                <div style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginBottom: 4,
                  paddingTop: 4,
                  borderTop: "1px solid var(--border)",
                }}>
                  <span style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--text-dim)",
                    letterSpacing: "0.08em",
                  }}>
                    TOTAL (INCL. GAS)
                  </span>
                  <span style={{
                    fontFamily: "var(--mono)",
                    fontSize: 13,
                    fontWeight: 700,
                    color: "var(--text, #eee)",
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                  }}>
                    <Eth />{(totalPrice + estimatedGas).toFixed(4)}
                  </span>
                </div>
              )}

              {/* Gas estimation shown above when available */}
            </div>

            {/* Stale price warning */}
            {staleItems.length > 0 && !buying && (
              <div style={{
                background: "rgba(251,191,36,0.08)",
                border: "1px solid rgba(251,191,36,0.2)",
                borderRadius: 6,
                padding: "8px 10px",
                marginBottom: 10,
                display: "flex",
                alignItems: "center",
                gap: 8,
              }}>
                <span style={{ fontSize: 14 }}>&#9888;</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--yellow, #fbbf24)", letterSpacing: "0.04em" }}>
                    {staleItems.length} item{staleItems.length !== 1 ? "s" : ""} may have changed price
                  </div>
                </div>
                {onRefreshCart && (
                  <button
                    onClick={onRefreshCart}
                    style={{
                      fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue, #6fa8dc)",
                      background: "none", border: "1px solid var(--naka-blue, #6fa8dc)",
                      borderRadius: 4, padding: "3px 8px", cursor: "pointer",
                    }}
                  >
                    REFRESH
                  </button>
                )}
              </div>
            )}

            {/* Validating indicator */}
            {validating && (
              <div style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--naka-blue, #6fa8dc)",
                textAlign: "center",
                marginBottom: 10,
                letterSpacing: "0.04em",
              }}>
                Validating orders...
              </div>
            )}

            {/* Progress */}
            {buying && (
              <div style={{
                fontFamily: "var(--mono)",
                fontSize: 11,
                color: "var(--naka-blue, #6fa8dc)",
                textAlign: "center",
                marginBottom: 10,
                letterSpacing: "0.04em",
              }}>
                Buying {progress.current}/{progress.total}...
              </div>
            )}

            {/* Confirmation step */}
            {confirming && !buying && (
              <div style={{
                background: "rgba(212,168,67,0.08)",
                border: "1px solid rgba(212,168,67,0.2)",
                borderRadius: 8,
                padding: "12px 14px",
                marginBottom: 12,
              }}>
                <div style={{
                  fontFamily: "var(--display)",
                  fontSize: 12,
                  fontWeight: 700,
                  color: "var(--gold, #d4a843)",
                  letterSpacing: "0.06em",
                  marginBottom: 8,
                }}>
                  CONFIRM PURCHASE
                </div>
                <div style={{
                  fontFamily: "var(--mono)",
                  fontSize: 11,
                  color: "var(--text, #eee)",
                  lineHeight: 1.6,
                  marginBottom: 4,
                }}>
                  {purchasableItems.length} item{purchasableItems.length !== 1 ? "s" : ""} for{" "}
                  <strong>{purchasableItems.reduce((s, i) => s + (i.price || 0), 0).toFixed(4)} ETH</strong>
                </div>
                {estimatingGas && (
                  <div style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--text-dim)",
                    marginBottom: 4,
                  }}>
                    Estimating gas...
                  </div>
                )}
                {estimatedGas !== null && (
                  <div style={{
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--text-dim)",
                    marginBottom: 4,
                  }}>
                    + ~{estimatedGas.toFixed(4)} ETH gas
                  </div>
                )}
                <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                  <button
                    onClick={handleConfirmSweep}
                    disabled={buying}
                    style={{
                      flex: 1,
                      fontFamily: "var(--display)",
                      fontSize: 12,
                      fontWeight: 700,
                      letterSpacing: "0.06em",
                      color: "var(--bg, #000)",
                      background: "var(--gold, #d4a843)",
                      border: "none",
                      borderRadius: 6,
                      padding: "9px 0",
                      cursor: "pointer",
                      transition: "filter 0.15s",
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.filter = "brightness(1.1)"; }}
                    onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
                  >
                    CONFIRM
                  </button>
                  <button
                    onClick={handleCancelConfirm}
                    style={{
                      flex: 1,
                      fontFamily: "var(--mono)",
                      fontSize: 11,
                      letterSpacing: "0.06em",
                      color: "var(--text-dim)",
                      background: "none",
                      border: "1px solid var(--border, #222)",
                      borderRadius: 6,
                      padding: "9px 0",
                      cursor: "pointer",
                      transition: "color 0.15s, border-color 0.15s",
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.color = "var(--text, #eee)";
                      e.currentTarget.style.borderColor = "var(--text-muted)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = "var(--text-dim)";
                      e.currentTarget.style.borderColor = "var(--border, #222)";
                    }}
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            )}

            {/* Sweep All */}
            {!confirming && (
              <button
                onClick={handleSweepClick}
                disabled={buying || validating}
                style={{
                  width: "100%",
                  fontFamily: "var(--display)",
                  fontSize: 13,
                  fontWeight: 700,
                  letterSpacing: "0.06em",
                  color: "var(--bg, #000)",
                  background: (buying || validating)
                    ? "rgba(212,168,67,0.4)"
                    : "var(--gold, #d4a843)",
                  border: "none",
                  borderRadius: 8,
                  padding: "12px 0",
                  cursor: (buying || validating) ? "not-allowed" : "pointer",
                  transition: "background 0.2s, transform 0.1s",
                  marginBottom: 8,
                }}
                onMouseEnter={(e) => {
                  if (!buying && !validating) e.currentTarget.style.filter = "brightness(1.1)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.filter = "none";
                }}
                onMouseDown={(e) => {
                  if (!buying) e.currentTarget.style.transform = "scale(0.98)";
                }}
                onMouseUp={(e) => {
                  e.currentTarget.style.transform = "scale(1)";
                }}
              >
                {buying
                  ? `BUYING ${progress.current}/${progress.total}...`
                  : validating
                    ? "VALIDATING..."
                    : wallet
                      ? "SWEEP ALL"
                      : "CONNECT WALLET"}
              </button>
            )}

            {/* Clear Cart */}
            <button
              onClick={onClear}
              disabled={buying || confirming}
              style={{
                width: "100%",
                fontFamily: "var(--mono)",
                fontSize: 11,
                letterSpacing: "0.06em",
                color: "var(--text-dim)",
                background: "none",
                border: "1px solid var(--border, #222)",
                borderRadius: 8,
                padding: "9px 0",
                cursor: (buying || confirming) ? "not-allowed" : "pointer",
                transition: "color 0.15s, border-color 0.15s",
                opacity: (buying || confirming) ? 0.4 : 1,
                marginTop: confirming ? 8 : 0,
              }}
              onMouseEnter={(e) => {
                if (!buying && !confirming) {
                  e.currentTarget.style.color = "var(--red, #f87171)";
                  e.currentTarget.style.borderColor = "rgba(248,113,113,0.25)";
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border, #222)";
              }}
            >
              CLEAR CART
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
