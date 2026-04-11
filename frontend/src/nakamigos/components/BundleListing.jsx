import { useState, useEffect, useCallback, useRef } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { getProvider } from "../api";
import { SEAPORT_ADDRESS, SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, CONDUIT_KEY, CONDUIT_ADDRESS, OPENSEA_FEE_RECIPIENT, OPENSEA_FEE_BPS, PLATFORM_FEE_RECIPIENT, PLATFORM_FEE_BPS } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";
import { openseaPost } from "../lib/proxy";


const DURATION_OPTIONS = [
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
  { label: "6 months", hours: 4320 },
];

export default function BundleListing({ nfts, wallet, onClose, addToast, onConnect }) {
  const collection = useActiveCollection();
  const [selected, setSelected] = useState(new Set());
  const [price, setPrice] = useState("");
  const [duration, setDuration] = useState(168);
  const [step, setStep] = useState("input"); // input | approving | signing | posting | done
  const [stepLabel, setStepLabel] = useState("");
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

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (selected.size === nfts.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(nfts.map((n) => n.id)));
    }
  }, [nfts, selected.size]);

  const selectedNfts = nfts.filter((n) => selected.has(n.id));
  const priceNum = parseFloat(price);
  const isValidPrice = priceNum > 0 && isFinite(priceNum);
  const canSubmit = selected.size >= 2 && isValidPrice;

  // Fee breakdown
  const osFeePercent = OPENSEA_FEE_BPS / 100;
  const osFeeEth = isValidPrice ? (priceNum * OPENSEA_FEE_BPS) / 10000 : 0;
  const platformFeePercent = PLATFORM_FEE_BPS / 100;
  const platformFeeEth = isValidPrice ? (priceNum * PLATFORM_FEE_BPS) / 10000 : 0;
  const hasPlatformFee = PLATFORM_FEE_BPS > 0 && PLATFORM_FEE_RECIPIENT !== "0x0000000000000000000000000000000000000000";
  const totalFeeEth = osFeeEth + (hasPlatformFee ? platformFeeEth : 0);
  const sellerReceives = isValidPrice ? priceNum - totalFeeEth : 0;

  const isSubmitting = step === "approving" || step === "signing" || step === "posting";

  const handleSubmit = useCallback(async () => {
    if (!wallet) { onConnect?.(); return; }
    if (selected.size < 2) { addToast?.("Select at least 2 NFTs for a bundle", "error"); return; }
    if (!isValidPrice) { addToast?.("Enter a valid price", "error"); return; }
    if (priceNum < 0.0001) { addToast?.("Price too low (min 0.0001 ETH)", "error"); return; }

    try {
      const { ethers } = await import("ethers");
      const provider = getProvider();
      if (!provider) { addToast?.("MetaMask not found", "error"); return; }

      const browserProvider = new ethers.BrowserProvider(provider);
      const signer = await browserProvider.getSigner();
      const sellerAddress = await signer.getAddress();
      const priceWei = ethers.parseEther(String(priceNum));

      // Step 1: Check NFT approval for Seaport conduit
      setStep("approving");
      setStepLabel("Approving NFTs...");

      const erc721ABI = [
        "function isApprovedForAll(address owner, address operator) view returns (bool)",
        "function setApprovalForAll(address operator, bool approved)",
      ];
      const nftContract = new ethers.Contract(collection.contract, erc721ABI, signer);
      const isApproved = await nftContract.isApprovedForAll(sellerAddress, CONDUIT_ADDRESS);

      if (!isApproved) {
        const approveTx = await nftContract.setApprovalForAll(CONDUIT_ADDRESS, true);
        await approveTx.wait();
      }

      // Step 2: Build Seaport order with multiple offer items
      setStep("signing");
      setStepLabel("Signing order...");

      const now = Math.floor(Date.now() / 1000);
      const endTime = now + duration * 3600;

      const osFee = (priceWei * BigInt(OPENSEA_FEE_BPS)) / 10000n;
      const platFee = (priceWei * BigInt(PLATFORM_FEE_BPS)) / 10000n;
      const platFeeActive = PLATFORM_FEE_BPS > 0 && PLATFORM_FEE_RECIPIENT !== "0x0000000000000000000000000000000000000000";
      const sellerAmount = priceWei - osFee - (platFeeActive ? platFee : 0n);

      // Offer: one ERC-721 item per selected NFT
      const offer = selectedNfts.map((nft) => ({
        itemType: 2, // ERC721
        token: collection.contract,
        identifierOrCriteria: String(nft.id),
        startAmount: "1",
        endAmount: "1",
      }));

      // Consideration: seller receives + fees
      const consideration = [
        {
          itemType: 0, // ETH
          token: "0x0000000000000000000000000000000000000000",
          identifierOrCriteria: "0",
          startAmount: sellerAmount.toString(),
          endAmount: sellerAmount.toString(),
          recipient: sellerAddress,
        },
        {
          itemType: 0, // ETH - OpenSea fee
          token: "0x0000000000000000000000000000000000000000",
          identifierOrCriteria: "0",
          startAmount: osFee.toString(),
          endAmount: osFee.toString(),
          recipient: OPENSEA_FEE_RECIPIENT,
        },
      ];

      if (platFeeActive) {
        consideration.push({
          itemType: 0, // ETH - Platform fee
          token: "0x0000000000000000000000000000000000000000",
          identifierOrCriteria: "0",
          startAmount: platFee.toString(),
          endAmount: platFee.toString(),
          recipient: PLATFORM_FEE_RECIPIENT,
        });
      }

      const orderParameters = {
        offerer: sellerAddress,
        zone: "0x0000000000000000000000000000000000000000",
        offer,
        consideration,
        orderType: 2, // FULL_OPEN_VIA_CONDUIT — required when using conduitKey
        startTime: String(now),
        endTime: String(endTime),
        zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
        salt: ethers.hexlify(ethers.randomBytes(32)),
        conduitKey: CONDUIT_KEY,
        totalOriginalConsiderationItems: consideration.length,
      };

      // Step 3: Get counter from Seaport contract
      const seaportABI = ["function getCounter(address) view returns (uint256)"];
      const seaport = new ethers.Contract(SEAPORT_ADDRESS, seaportABI, browserProvider);
      const counter = await seaport.getCounter(sellerAddress);

      // Step 4: Sign EIP-712
      const signData = { ...orderParameters, counter: counter.toString() };
      const signature = await signer.signTypedData(SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, signData);

      // Step 5: POST to OpenSea
      setStep("posting");
      setStepLabel("Posting bundle listing...");

      try {
        await openseaPost("orders/ethereum/seaport/listings", {
          parameters: {
            ...orderParameters,
            totalOriginalConsiderationItems: orderParameters.consideration.length,
          },
          signature,
          protocol_address: SEAPORT_ADDRESS,
        });
      } catch (err) {
        console.error("OpenSea bundle listing POST failed:", err.message);
        addToast?.("OpenSea rejected the bundle listing", "error");
        setStep("input");
        return;
      }

      setStep("done");
      setStepLabel("Bundle Listed!");
      addToast?.(`Bundle of ${selected.size} ${collection.name} NFTs listed for ${priceNum} ETH`, "success");
    } catch (err) {
      if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        setStep("input");
        addToast?.("Listing cancelled", "info");
        return;
      }
      console.error("Bundle listing error:", err);
      setStep("input");
      addToast?.("Failed to create bundle listing. Please try again or check your wallet connection.", "error");
    }
  }, [wallet, onConnect, price, priceNum, isValidPrice, duration, selected, selectedNfts, addToast, collection]);

  // Step indicator dots
  const steps = ["approving", "signing", "posting", "done"];
  const currentStepIndex = steps.indexOf(step);

  return (
    <div className="modal-bg" onClick={() => { if (!isSubmitting) onClose(); }} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="Bundle Listing">
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card)", border: "1px solid var(--border)",
          borderRadius: 14, maxWidth: 560, width: "94%", margin: "auto",
          padding: "28px 24px", position: "relative",
          maxHeight: "90vh", overflowY: "auto",
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
          List {collection.name} Bundle for Sale
        </div>

        {step === "done" ? (
          /* ═══ SUCCESS STATE ═══ */
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{
              width: 56, height: 56, borderRadius: "50%",
              background: "rgba(46,204,113,0.12)", border: "2px solid var(--green)",
              display: "flex", alignItems: "center", justifyContent: "center",
              margin: "0 auto 16px",
            }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div style={{ fontFamily: "var(--display)", fontSize: 16, color: "var(--green)", marginBottom: 8 }}>
              {collection.name} Bundle Listed!
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginBottom: 4 }}>
              {selected.size} {collection.name} NFTs bundled for {priceNum} ETH on OpenSea.
            </div>
            <div style={{
              display: "flex", flexWrap: "wrap", gap: 6,
              justifyContent: "center", margin: "14px 0",
            }}>
              {selectedNfts.map((nft) => (
                <NftImage
                  key={nft.id}
                  nft={nft}
                  style={{ width: 40, height: 40, borderRadius: 6, objectFit: "cover" }}
                />
              ))}
            </div>
            <button className="btn-primary" style={{ marginTop: 18, width: "100%" }} onClick={onClose}>
              Done
            </button>
          </div>
        ) : (
          <>
            {/* ═══ SELECT ALL / COUNT ═══ */}
            <div style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              marginBottom: 10,
            }}>
              <span style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                letterSpacing: "0.06em",
              }}>
                SELECT NFTS ({selected.size} selected)
              </span>
              <button
                onClick={selectAll}
                disabled={isSubmitting}
                style={{
                  background: "none", border: "none", cursor: "pointer",
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)",
                  textDecoration: "underline",
                }}
              >
                {selected.size === nfts.length ? "Deselect All" : "Select All"}
              </button>
            </div>

            {/* ═══ NFT SELECTION GRID ═══ */}
            <div style={{
              display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
              gap: 8, marginBottom: 16,
              maxHeight: 220, overflowY: "auto",
              background: "rgba(0,0,0,0.15)", borderRadius: 10, padding: 10,
              border: "1px solid var(--border)",
            }}>
              {nfts.map((nft) => {
                const isSelected = selected.has(nft.id);
                return (
                  <div
                    key={nft.id}
                    onClick={() => !isSubmitting && toggleSelect(nft.id)}
                    style={{
                      position: "relative", cursor: isSubmitting ? "wait" : "pointer",
                      borderRadius: 8, overflow: "hidden",
                      border: isSelected
                        ? "2px solid var(--naka-blue)"
                        : "2px solid transparent",
                      opacity: isSubmitting ? 0.6 : 1,
                      transition: "border-color 0.15s",
                    }}
                  >
                    <NftImage
                      nft={nft}
                      style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }}
                    />
                    {/* Checkbox overlay */}
                    <div style={{
                      position: "absolute", top: 4, right: 4,
                      width: 18, height: 18, borderRadius: 4,
                      background: isSelected ? "var(--naka-blue)" : "rgba(0,0,0,0.5)",
                      border: isSelected ? "none" : "1px solid var(--border)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 11, color: "#fff", fontWeight: 700,
                    }}>
                      {isSelected ? "\u2713" : ""}
                    </div>
                    {/* Token ID label */}
                    <div style={{
                      position: "absolute", bottom: 0, left: 0, right: 0,
                      background: "rgba(0,0,0,0.65)", padding: "2px 4px",
                      fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-dim)",
                      textAlign: "center", whiteSpace: "nowrap", overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}>
                      #{nft.id}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* ═══ SELECTED SUMMARY ═══ */}
            {selectedNfts.length > 0 && (
              <div style={{
                display: "flex", alignItems: "center", gap: 8, marginBottom: 16,
                background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: "10px 12px",
                border: "1px solid var(--border)", flexWrap: "wrap",
              }}>
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                  marginRight: 4,
                }}>
                  Bundle:
                </span>
                {selectedNfts.map((nft) => (
                  <NftImage
                    key={nft.id}
                    nft={nft}
                    style={{ width: 32, height: 32, borderRadius: 6, objectFit: "cover" }}
                  />
                ))}
                <span style={{
                  fontFamily: "var(--mono)", fontSize: 10, color: "var(--text)",
                  marginLeft: "auto",
                }}>
                  {selectedNfts.length} NFTs
                </span>
              </div>
            )}

            {/* Minimum selection warning */}
            {selected.size > 0 && selected.size < 2 && (
              <div style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--gold, #c8a850)",
                marginBottom: 12, textAlign: "center",
              }}>
                Select at least 2 NFTs to create a bundle
              </div>
            )}

            {/* ═══ PRICE INPUT ═══ */}
            <div style={{ marginBottom: 16 }}>
              <label style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                letterSpacing: "0.06em", display: "block", marginBottom: 6,
              }}>
                TOTAL BUNDLE PRICE (ETH)
              </label>
              <div style={{
                display: "flex", alignItems: "center", gap: 8,
                background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)",
                borderRadius: 8, padding: "10px 14px",
              }}>
                <Eth size={14} />
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  placeholder="0.00"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  disabled={isSubmitting}
                  style={{
                    flex: 1, background: "transparent", border: "none", outline: "none",
                    fontFamily: "var(--mono)", fontSize: 16, color: "var(--text)",
                  }}
                />
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>ETH</span>
              </div>
              {selectedNfts.length >= 2 && isValidPrice && (
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)",
                  marginTop: 4, textAlign: "right",
                }}>
                  ~{(priceNum / selectedNfts.length).toFixed(4)} ETH per NFT
                </div>
              )}
            </div>

            {/* ═══ FEE BREAKDOWN ═══ */}
            {isValidPrice && (
              <div style={{
                background: "rgba(111,168,220,0.04)", border: "1px solid rgba(111,168,220,0.1)",
                borderRadius: 8, padding: "10px 12px", marginBottom: 16,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>OpenSea fee ({osFeePercent}%)</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>-{osFeeEth.toFixed(4)} ETH</span>
                </div>
                {hasPlatformFee && (
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>Platform fee ({platformFeePercent}%)</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>-{platformFeeEth.toFixed(4)} ETH</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--green)" }}>You receive</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--green)", fontWeight: 600 }}>{sellerReceives.toFixed(4)} ETH</span>
                </div>
              </div>
            )}

            {/* ═══ DURATION SELECTOR ═══ */}
            <div style={{ marginBottom: 18 }}>
              <label style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
                letterSpacing: "0.06em", display: "block", marginBottom: 6,
              }}>
                DURATION
              </label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {DURATION_OPTIONS.map((opt) => (
                  <button
                    key={opt.hours}
                    onClick={() => setDuration(opt.hours)}
                    disabled={isSubmitting}
                    style={{
                      padding: "6px 12px", borderRadius: 6,
                      fontFamily: "var(--mono)", fontSize: 10,
                      border: duration === opt.hours
                        ? "1px solid var(--naka-blue)"
                        : "1px solid var(--border)",
                      background: duration === opt.hours
                        ? "rgba(111,168,220,0.1)"
                        : "rgba(0,0,0,0.2)",
                      color: duration === opt.hours ? "var(--naka-blue)" : "var(--text-dim)",
                      cursor: isSubmitting ? "wait" : "pointer",
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ═══ STEP INDICATORS ═══ */}
            {isSubmitting && (
              <div style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                gap: 8, marginBottom: 16,
              }}>
                {steps.slice(0, -1).map((s, i) => {
                  const isActive = i === currentStepIndex;
                  const isComplete = i < currentStepIndex;
                  return (
                    <div key={s} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{
                        width: 22, height: 22, borderRadius: "50%",
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 10, fontFamily: "var(--mono)",
                        background: isComplete
                          ? "var(--green)"
                          : isActive
                            ? "var(--naka-blue)"
                            : "var(--border)",
                        color: isComplete || isActive ? "#fff" : "var(--text-dim)",
                        border: isActive ? "2px solid var(--naka-blue)" : "none",
                      }}>
                        {isComplete ? "\u2713" : i + 1}
                      </div>
                      {i < steps.length - 2 && (
                        <div style={{
                          width: 20, height: 1,
                          background: isComplete ? "var(--green)" : "var(--border)",
                        }} />
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {isSubmitting && (
              <div style={{
                textAlign: "center", fontFamily: "var(--mono)", fontSize: 11,
                color: "var(--naka-blue)", marginBottom: 16,
              }}>
                {stepLabel}
              </div>
            )}

            {/* ═══ SUBMIT BUTTON ═══ */}
            <button
              className="btn-primary"
              style={{ width: "100%", textAlign: "center", fontSize: 12 }}
              disabled={isSubmitting || (wallet && !canSubmit)}
              onClick={handleSubmit}
            >
              {isSubmitting
                ? stepLabel || "Processing..."
                : !wallet
                  ? "Connect Wallet"
                  : selected.size < 2
                    ? "Select at Least 2 NFTs"
                    : isValidPrice
                      ? `List Bundle for ${priceNum} ETH`
                      : "Enter a Price"
              }
            </button>
          </>
        )}
      </div>
    </div>
  );
}
