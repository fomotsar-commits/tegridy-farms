import { useState, useEffect, useCallback, useRef } from "react";
import { Eth } from "./Icons";
import { getWethBalance, getEthBalance, formatEth } from "../lib/weth";
import { createItemOffer, createTraitOffer, createCollectionOffer, fetchMyOffers } from "../api-offers";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useWalletState, useWalletActions } from "../contexts/WalletContext";
import { lockScroll, unlockScroll } from "../lib/scrollLock";
import { getFriendlyError } from "../lib/errorMessages";
import { sanitizeDecimalInput } from "../../lib/formatting";
import { pageArt } from "../../lib/artConfig";

const EXPIRATION_OPTIONS = [
  { label: "1 hour", hours: 1 },
  { label: "6 hours", hours: 6 },
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
];

export default function MakeOfferModal({ nft, trait, collection, onClose, wallet, onConnect, addToast, onSuccess }) {
  const { isWrongNetwork } = useWalletState();
  const { switchChain } = useWalletActions();
  const activeCollection = useActiveCollection();
  const collectionName = activeCollection.name;
  const collectionSlug = activeCollection.openseaSlug || activeCollection.slug;
  const collectionContract = activeCollection.contract;
  const modalRef = useRef(null);

  const [price, setPrice] = useState("");
  const [expiration, setExpiration] = useState(168);
  const [step, setStep] = useState("input"); // input | submitting | done
  const [stepLabel, setStepLabel] = useState("");
  const [wethBal, setWethBal] = useState(null);
  const [ethBal, setEthBal] = useState(null);
  const [activeOfferTotal, setActiveOfferTotal] = useState(0n);

  const isTraitOffer = !!trait;
  const isCollectionOffer = !!collection;
  const title = isCollectionOffer
    ? `Collection Offer on ${collectionName}`
    : isTraitOffer
      ? `Offer on ${trait.key}: ${trait.value}`
      : `Make Offer on #${nft?.id}`;

  const typeLabel = isCollectionOffer
    ? "COLLECTION OFFER"
    : isTraitOffer
      ? "TRAIT OFFER"
      : "MAKE OFFER";

  // Reset submitting state if wallet disconnects mid-transaction
  useEffect(() => {
    if (!wallet && step === "submitting") {
      setStep("input");
      setStepLabel("");
    }
  }, [wallet, step]);

  // Load balances and active offer totals
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    Promise.all([getWethBalance(wallet), getEthBalance(wallet)])
      .then(([w, e]) => {
        if (!cancelled) { setWethBal(w); setEthBal(e); }
      })
      .catch((err) => console.warn('[MakeOfferModal] balance fetch failed:', err?.message ?? err));
    fetchMyOffers(wallet, collectionContract)
      .then((offers) => {
        if (cancelled) return;
        const total = offers.reduce(
          (sum, o) => sum + BigInt(o.priceWei || "0"), 0n
        );
        setActiveOfferTotal(total);
      })
      .catch((err) => console.warn('[MakeOfferModal] fetchMyOffers failed:', err?.message ?? err));
    return () => { cancelled = true; };
  }, [wallet, collectionContract]);

  const handleSubmit = useCallback(async () => {
    if (!wallet) { onConnect?.(); return; }
    if (isWrongNetwork) { addToast?.("Wrong network — please switch to Ethereum Mainnet", "error"); switchChain?.(); return; }
    const priceNum = parseFloat(price);
    if (!priceNum || priceNum <= 0) { addToast?.("Enter a valid price", "error"); return; }

    setStep("submitting");
    setStepLabel("Preparing offer...");

    let result;

    try {
      setStepLabel("Signing & submitting offer...");
      if (isCollectionOffer) {
        result = await createCollectionOffer({
          priceEth: priceNum,
          expirationHours: expiration,
          slug: collectionSlug,
        });
      } else if (isTraitOffer) {
        result = await createTraitOffer({
          traitType: trait.key,
          traitValue: trait.value,
          priceEth: priceNum,
          expirationHours: expiration,
          slug: collectionSlug,
        });
      } else {
        result = await createItemOffer({
          tokenId: nft.id,
          priceEth: priceNum,
          expirationHours: expiration,
          contract: collectionContract,
        });
      }
    } catch (err) {
      setStep("input");
      // The create* helpers convert their own failures into typed results, so a
      // THROW here is something they did not anticipate. Swallowing it entirely
      // left the user with retry advice and us with nothing in the console.
      console.error("[MakeOfferModal] offer submission threw:", err);
      addToast?.(getFriendlyError(err), "error");
      return;
    }

    // Defensive: a helper that returns nothing would otherwise TypeError on
    // `result.success` OUTSIDE the try above, blanking the modal with no toast.
    if (!result) {
      setStep("input");
      addToast?.("Offer failed — the wallet returned no result. Reconnect and try again.", "error");
      return;
    }

    if (result.success) {
      setStep("done");
      onSuccess?.();
      if (isCollectionOffer) {
        addToast?.(`Collection offer placed: ${priceNum} WETH for any ${collectionName}`, "success");
      } else if (isTraitOffer) {
        addToast?.(`Trait offer placed: ${priceNum} WETH for any ${collectionName} with ${trait.key}: ${trait.value}`, "success");
      } else {
        addToast?.(`Offer placed on ${collectionName} #${nft.id} for ${priceNum} WETH`, "success");
      }
    } else if (result.error === "rejected") {
      setStep("input");
      addToast?.("Offer cancelled", "info");
    } else if (result.error === "insufficient") {
      setStep("input");
      addToast?.("Insufficient ETH + WETH balance. You may need to wrap more ETH.", "error");
    } else if (result.error === "build-failed") {
      setStep("input");
      addToast?.("Could not build this offer. Check that the collection supports offers.", "error");
    } else if (result.error === "post-failed") {
      setStep("input");
      addToast?.("Offer was rejected. It may be below the minimum or the collection is not eligible.", "error");
    } else if (result.error === "wallet-mismatch" || result.error === "no-wallet") {
      setStep("input");
      // "Please try again" is advice that CANNOT work here: retrying re-signs from
      // the same wrong identity, or with no wallet at all. `assertSameWallet`
      // (api.js) already produced a message naming both addresses — show it
      // verbatim rather than collapsing it into the generic bucket.
      //
      // ⚠ An earlier version of this comment justified the direct call by claiming
      // getFriendlyError "strips long hex and truncates over 120 chars". Measured:
      // it returns this message BYTE-IDENTICAL. shortenAddress (api.js:1172) emits
      // `0x1111...1111` — 4 hex digits after the prefix, while the strip regex needs
      // {8,} — and the message is 104 chars. api.js:1126-1128 says outright that it
      // is kept under 120 BECAUSE callers render it through getFriendlyError.
      //
      // The bypass is harmless; the false rationale was not. Six other sites render
      // this same message THROUGH getFriendlyError (Listings, OfferPanel,
      // OrderBookPanel, ShoppingCart, SweepCalculator, TransactionProgress), so an
      // editor who believed the old comment and lengthened the message to full
      // addresses would silently collapse all six to "Transaction failed".
      addToast?.(
        result.message || "No wallet connected. Reconnect your wallet and try again.",
        "error",
      );
    } else if (result.error === "wrong-chain" || result.error === "no-network") {
      setStep("input");
      // Same class: retrying on the wrong chain fails identically every time. Name
      // the reason and offer the one action that fixes it.
      addToast?.(result.message || "Wrong network — please switch to Ethereum Mainnet", "error");
      switchChain?.();
    } else {
      setStep("input");
      // Everything still typed (wrap-failed, approve-failed, failed, …) carries a
      // specific message from the helper. Prefer it; the generic retry line is the
      // last resort for a result that named no reason at all.
      addToast?.(
        result.message ? getFriendlyError(result.message) : "Offer failed. Please try again.",
        "error",
      );
    }
  }, [wallet, onConnect, price, expiration, nft, trait, isTraitOffer, isCollectionOffer, collectionSlug, collectionContract, collectionName, addToast, onSuccess, isWrongNetwork, switchChain]);

  // Close on Escape + focus trap — stopImmediatePropagation prevents parent modal from also closing
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        onClose();
        return;
      }
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
    // Ref-counted, so locking is safe whether this modal is nested under the
    // NFT detail Modal (which also locks) or opened standalone from
    // CollectionOffersPanel / TraitExplorer (which don't).
    lockScroll();
    const previouslyFocused = document.activeElement;
    const closeBtn = modalRef.current?.querySelector('[aria-label="Close modal"]');
    closeBtn?.focus();
    return () => {
      window.removeEventListener("keydown", h);
      unlockScroll();
      // Restore focus to the pre-open element (matches Modal.jsx / TheaterMode.jsx).
      // Opened standalone from CollectionOffersPanel / TraitExplorer there is no
      // parent dialog to do this, so focus would otherwise fall to <body>.
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [onClose]);

  const infoText = isCollectionOffer
    ? `This offer applies to ANY ${collectionName} NFT. The first owner to accept will fulfill the order. Uses WETH.`
    : isTraitOffer
      ? `This offer applies to ANY ${collectionName} with this trait. The first owner to accept will fulfill the order.`
      : "Offers use WETH (Wrapped ETH). If you don't have enough WETH, your ETH will be automatically wrapped.";

  return (
    <div className="modal-bg" onClick={onClose} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="Make Offer">
      <div
        ref={modalRef}
        className="offer-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          // Art-backed panel. `--card` stays the final layer so a 404 on the art
          // degrades to the old flat panel rather than transparent. Scrim is the
          // heaviest of the three popups (0.86->0.9): this form shows BALANCES and
          // an irreversible-offer warning, so legibility outranks how much of the
          // piece reads through. `backgroundAttachment: local` keeps the art pinned
          // to the panel while the form scrolls inside `overflowY: auto` — without
          // it the image slides against the content on short viewports.
          background: `linear-gradient(180deg, rgba(10,16,32,0.86) 0%, rgba(10,16,32,0.90) 100%), url(${pageArt("make-offer", 0).src}) center / cover no-repeat, var(--card)`,
          backgroundAttachment: "local",
          border: "1px solid var(--border)",
          borderRadius: 14, maxWidth: 420, width: "90%", margin: "auto",
          padding: "28px 24px", position: "relative",
          // Match TradeWindow / BulkListingWizard so a tall offer form (balances,
          // warnings, expiry buttons) scrolls instead of clipping the close button
          // off the top of short viewports.
          maxHeight: "90vh", overflowY: "auto",
          textShadow: "0 1px 10px rgba(0,0,0,0.95), 0 0 3px rgba(0,0,0,0.9)",
        }}
      >
        <button
          className="modal-close"
          onClick={onClose}
          aria-label="Close modal"
          style={{ position: "absolute", top: 12, right: 14 }}
        >{"\u2715"}</button>

        <div style={{
          fontFamily: "var(--pixel)", fontSize: 10, color: "var(--naka-blue)",
          letterSpacing: "0.1em", marginBottom: 6,
        }}>
          {typeLabel}
        </div>
        <div style={{
          fontFamily: "var(--display)", fontSize: 18, fontWeight: 600,
          color: "var(--text)", marginBottom: 20,
        }}>
          {title}
        </div>

        {step === "done" ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>{"\u2705"}</div>
            <div style={{ fontFamily: "var(--display)", fontSize: 16, color: "var(--green)", marginBottom: 8 }}>
              Offer Submitted!
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
              Your offer is now live on OpenSea.
            </div>
            <button className="btn-primary" style={{ marginTop: 18, width: "100%" }} onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            {/* Balances */}
            {wallet && (
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 18,
              }}>
                <div style={{
                  background: "rgba(111,168,220,0.04)", border: "1px solid rgba(111,168,220,0.1)",
                  borderRadius: 8, padding: "10px 12px",
                }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.06em" }}>ETH BALANCE</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)", marginTop: 4 }}>
                    {ethBal !== null ? formatEth(ethBal) : "..."}
                  </div>
                </div>
                <div style={{
                  background: "rgba(111,168,220,0.04)", border: "1px solid rgba(111,168,220,0.1)",
                  borderRadius: 8, padding: "10px 12px",
                }}>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.06em" }}>WETH BALANCE</div>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)", marginTop: 4 }}>
                    {wethBal !== null ? formatEth(wethBal) : "..."}
                  </div>
                </div>
              </div>
            )}

            {/* Price input */}
            <div style={{ marginBottom: 16 }}>
              <label htmlFor="offer-price-input" style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                letterSpacing: "0.06em", display: "block", marginBottom: 6,
              }}>
                OFFER PRICE (WETH)
              </label>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)",
                borderRadius: 8, padding: "10px 14px",
              }}>
                <Eth size={14} />
                <input
                  id="offer-price-input"
                  type="text"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(sanitizeDecimalInput(e.target.value))}
                  disabled={step === "submitting"}
                  style={{
                    flex: 1, background: "transparent", border: "none", outline: "none",
                    fontFamily: "var(--mono)", fontSize: 16, color: "var(--text)",
                  }}
                />
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>WETH</span>
              </div>
              {price && wethBal !== null && parseFloat(price) > 0 && (() => {
                const [whole = "0", frac = ""] = price.split(".");
                const priceWei = BigInt(whole || "0") * BigInt(1e18) + BigInt((frac + "000000000000000000").slice(0, 18));
                const needsWrap = priceWei > wethBal;
                return (
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 10, marginTop: 6,
                  color: needsWrap ? "var(--red, #e74c3c)" : "var(--green)",
                }}>
                  {needsWrap
                    ? "ETH will be auto-wrapped to WETH during submission"
                    : "Sufficient WETH balance"
                  }
                </div>);
              })()}
            </div>

            {/* Overcommitment warning */}
            {price && wethBal !== null && parseFloat(price) > 0 && (() => {
              const [whole = "0", frac = ""] = price.split(".");
              const priceWei = BigInt(whole || "0") * BigInt(1e18) + BigInt((frac + "000000000000000000").slice(0, 18));
              const totalCommitted = activeOfferTotal + priceWei;
              const gasBuffer = BigInt(Math.floor(0.01 * 1e18));
              const availableBal = wethBal + (ethBal || 0n) - gasBuffer;
              if (totalCommitted > availableBal) {
                return (
                  <div role="alert" style={{
                    fontFamily: "var(--mono)", fontSize: 10, marginBottom: 14,
                    padding: "8px 12px", borderRadius: 8,
                    background: "rgba(231,76,60,0.08)", border: "1px solid rgba(231,76,60,0.25)",
                    color: "var(--red, #e74c3c)", lineHeight: 1.5,
                  }}>
                    Warning: Your active offers ({formatEth(activeOfferTotal)} WETH) plus this offer
                    would total {formatEth(totalCommitted)} WETH, exceeding your balance
                    of {formatEth(wethBal)} WETH. If multiple offers are accepted simultaneously,
                    some may fail.
                  </div>
                );
              }
              return null;
            })()}

            {/* Expiration */}
            <div style={{ marginBottom: 20 }}>
              <span id="expiration-label" style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                letterSpacing: "0.06em", display: "block", marginBottom: 6,
              }}>
                EXPIRATION
              </span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }} role="group" aria-labelledby="expiration-label">
                {EXPIRATION_OPTIONS.map((opt) => (
                  <button
                    key={opt.hours}
                    onClick={() => setExpiration(opt.hours)}
                    disabled={step === "submitting"}
                    aria-pressed={expiration === opt.hours}
                    style={{
                      padding: "6px 12px", borderRadius: 6,
                      fontFamily: "var(--mono)", fontSize: 10,
                      border: expiration === opt.hours
                        ? "1px solid var(--naka-blue)"
                        : "1px solid var(--border)",
                      background: expiration === opt.hours
                        ? "rgba(111,168,220,0.1)"
                        : "rgba(0,0,0,0.2)",
                      color: expiration === opt.hours ? "var(--naka-blue)" : "var(--text-dim)",
                      cursor: step === "submitting" ? "wait" : "pointer",
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Info about offers */}
            <div style={{
              fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)",
              marginBottom: 18, lineHeight: 1.6,
            }}>
              {infoText}
            </div>

            {/* Wrong network warning */}
            {wallet && isWrongNetwork && (
              <div role="alert" style={{
                fontFamily: "var(--mono)", fontSize: 11, marginBottom: 12,
                padding: "10px 14px", borderRadius: 8,
                background: "rgba(248,113,113,0.08)", border: "1px solid rgba(248,113,113,0.2)",
                color: "var(--red, #f87171)", textAlign: "center", lineHeight: 1.5,
              }}>
                Wrong network detected.{" "}
                <button
                  onClick={() => switchChain?.()}
                  style={{
                    background: "none", border: "none", cursor: "pointer",
                    color: "var(--naka-blue)", textDecoration: "underline",
                    fontFamily: "var(--mono)", fontSize: 11, padding: 0,
                  }}
                >
                  Switch to Ethereum Mainnet
                </button>
              </div>
            )}

            {/* Submit */}
            <button
              className="btn-primary"
              type="button"
              style={{ width: "100%", textAlign: "center", fontSize: 12 }}
              disabled={step === "submitting" || (wallet && isWrongNetwork)}
              aria-disabled={step === "submitting" || (wallet && isWrongNetwork)}
              onClick={handleSubmit}
            >
              {step === "submitting"
                ? stepLabel || "Processing..."
                : !wallet
                  ? "Connect Wallet"
                  : price
                    ? `Place ${price} WETH ${isCollectionOffer ? "Collection " : ""}Offer`
                    : "Enter a Price"
              }
            </button>
          </>
        )}
      </div>
    </div>
  );
}
