import { useEffect, useState, useRef, useCallback, useMemo, lazy, Suspense } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import OfferPanel from "./OfferPanel";
import MakeOfferModal from "./MakeOfferModal";
import ErrorBoundary from "./ErrorBoundary";
import TransactionProgress, { useTransactionProgress } from "./TransactionProgress";
import { OPENSEA_ITEM, ETHERSCAN_TOKEN, CHARACTER_TYPES, GNSS_SPECIES, JB_LEGENDARIES } from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useTradingMode } from "../contexts/TradingModeContext";
import { copyToClipboard, fulfillSeaportOrder, fetchTokenSalesHistory, getProvider } from "../api";
import { validateOrderQuick } from "../lib/orderValidator";
import { recordTransaction } from "../lib/transactions";
import { lockScroll, unlockScroll } from "../lib/scrollLock";

const ComparableSales = lazy(() => import("./ComparableSales").catch(() => ({ default: () => null })));

function FairValueBadge({ nft, floorPrice, supply }) {
  if (!nft?.rank || !floorPrice || floorPrice <= 0) return null;
  if (!supply || supply <= 0) return null;
  // Rarity multiplier: log-based scale capped at 5x floor to avoid absurd estimates
  const percentile = 1 - (nft.rank - 1) / supply; // 0..1, higher = rarer
  const multiplier = 1 + Math.log1p(percentile * 9) / Math.log(10) * 1.5; // ~1x to ~2.5x
  const fairValue = Math.min(floorPrice * multiplier, floorPrice * 5);
  const label = nft.price
    ? nft.price < fairValue * 0.85 ? "UNDERVALUED" : nft.price > fairValue * 1.15 ? "OVERVALUED" : "FAIR"
    : null;
  const color = label === "UNDERVALUED" ? "var(--green)" : label === "OVERVALUED" ? "var(--red)" : "var(--yellow)";

  return (
    <div style={{
      fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
      marginTop: 8, display: "flex", alignItems: "center", gap: 8,
    }}>
      <span>Est. Fair Value: <Eth size={10} /> {fairValue.toFixed(4)}</span>
      {label && (
        <span style={{
          fontSize: 8, fontWeight: 700, color, background: `${color}15`,
          border: `1px solid ${color}30`, borderRadius: 3, padding: "1px 6px",
          letterSpacing: "0.06em",
        }}>{label}</span>
      )}
    </div>
  );
}

function PriceHistoryChart({ tokenId, contract }) {
  const [sales, setSales] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetchTokenSalesHistory(tokenId, contract).then((data) => {
      if (!cancelled) setSales(data);
    }).catch((err) => {
      if (!cancelled) {
        console.error("Failed to fetch sales history:", err);
        setSales([]);
      }
    });
    return () => { cancelled = true; };
  }, [tokenId, contract]);

  if (!sales) return null;
  if (sales.length === 0) return (
    <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", marginTop: 8 }}>
      No sales history for this token
    </div>
  );

  const prices = sales.map(s => s.price);
  const maxP = Math.max(...prices);
  const minP = Math.min(...prices);
  const range = maxP - minP || 1;
  const w = 260, h = 80, pad = 4;

  const points = sales.map((s, i) => {
    const x = pad + (i / Math.max(sales.length - 1, 1)) * (w - pad * 2);
    const y = pad + (1 - (s.price - minP) / range) * (h - pad * 2);
    return `${x},${y}`;
  }).join(" ");

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.08em", marginBottom: 8 }}>
        PRICE HISTORY ({sales.length} sale{sales.length !== 1 ? "s" : ""})
      </div>
      <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" style={{ display: "block", opacity: 0.8, maxWidth: w }}>
        <polyline
          fill="none"
          stroke="var(--gold)"
          strokeWidth="1.5"
          points={points}
        />
        {sales.map((s, i) => {
          const x = pad + (i / Math.max(sales.length - 1, 1)) * (w - pad * 2);
          const y = pad + (1 - (s.price - minP) / range) * (h - pad * 2);
          return <circle key={i} cx={x} cy={y} r="2.5" fill="var(--gold)" opacity="0.7" />;
        })}
      </svg>
      <div style={{ display: "flex", justifyContent: "space-between", fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
        <span><Eth size={9} /> {minP.toFixed(4)}</span>
        <span>Avg: <Eth size={9} /> {(prices.reduce((a, b) => a + b, 0) / prices.length).toFixed(4)}</span>
        <span><Eth size={9} /> {maxP.toFixed(4)}</span>
      </div>
    </div>
  );
}

export default function Modal({ nft, onClose, onTheater, onShare, isFavorite, onToggleFavorite, wallet, onConnect, addToast, onViewProfile, floorPrice, statsSupply, allTokens }) {
  const collection = useActiveCollection();
  const { isLite } = useTradingMode();
  const [copied, setCopied] = useState(null);
  const [buying, setBuying] = useState(false);
  const [showOfferModal, setShowOfferModal] = useState(false);
  const [orderWarning, setOrderWarning] = useState(null); // { status, reason, warnings }
  const modalRef = useRef(null);
  const showOfferModalRef = useRef(false);
  const { startTransaction, closeProgress, progressProps } = useTransactionProgress({ collectionName: collection.name });

  // Run quick validation (Layer 1+2) when modal opens with a priced order
  useEffect(() => {
    if (!nft?.orderHash || !nft?.price) return;
    let cancelled = false;
    (async () => {
      try {
        let ethersProvider = null;
        const ethProvider = getProvider();
        if (ethProvider) {
          const { ethers } = await import("ethers");
          ethersProvider = new ethers.BrowserProvider(ethProvider);
        }
        const result = await validateOrderQuick(ethersProvider, nft);
        if (!cancelled) {
          if (result.status !== "green") {
            setOrderWarning(result);
          } else {
            setOrderWarning(null);
          }
        }
      } catch {
        // Don't block on validation failure
      }
    })();
    return () => { cancelled = true; };
  }, [nft?.orderHash, nft?.price, nft?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep ref in sync so the keydown handler always sees current state
  showOfferModalRef.current = showOfferModal;

  useEffect(() => {
    if (!nft) return;
    const handleKey = (e) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        if (showOfferModalRef.current) {
          setShowOfferModal(false);
          return;
        }
        onClose();
      }
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
    // Store the element that had focus before modal opened, to restore on close
    const previouslyFocused = document.activeElement;
    // Focus the close button on mount
    const closeBtn = modalRef.current?.querySelector('[aria-label="Close modal"]');
    closeBtn?.focus();
    return () => {
      document.removeEventListener("keydown", handleKey);
      unlockScroll();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [nft, onClose]);

  // Compute display name: prefer nft.name, but if it's just "#ID", prefix with collection name
  const displayName = useMemo(() => {
    if (!nft) return "";
    if (nft.name && nft.name !== `#${nft.id}`) return nft.name;
    return `${collection.name} #${nft.id}`;
  }, [nft, collection.name]);

  // Build trait count map from allTokens for rarity percentages.
  // Also track how many tokens contributed so we can use the right denominator.
  const { traitCountMap, loadedCount } = useMemo(() => {
    if (!allTokens || allTokens.length === 0) return { traitCountMap: null, loadedCount: 0 };
    const counts = {};
    for (const token of allTokens) {
      for (const attr of token.attributes || []) {
        const key = `${attr.key}::${attr.value}`;
        counts[key] = (counts[key] || 0) + 1;
      }
    }
    return { traitCountMap: counts, loadedCount: allTokens.length };
  }, [allTokens]);

  // Best supply figure: prefer live API supply, then config, then loaded token count
  const supplyForRarity = statsSupply || collection.supply || (allTokens?.length || 0);

  // For trait rarity %: when only a fraction of the collection is loaded,
  // the trait counts come from loaded tokens only. Use loadedCount as the
  // denominator for accurate percentages within the loaded set, and flag
  // that the data is approximate. Once 80%+ is loaded, use full supply.
  const traitDenominator = loadedCount >= supplyForRarity * 0.8 ? supplyForRarity : loadedCount;
  const traitRarityApprox = loadedCount > 0 && loadedCount < supplyForRarity * 0.8;

  // Rank badge: show for top 25% of the collection supply
  const rankThreshold = Math.max(Math.floor(supplyForRarity * 0.25), 1);

  if (!nft) return null;

  const openSeaUrl = OPENSEA_ITEM(nft.id, collection.contract);

  const handleCopy = async (text, label) => {
    await copyToClipboard(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  };

  return (
    <div className="modal-bg modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={`NFT Detail: ${displayName}`}>
      <div ref={modalRef} className="modal-content modal-enter" onClick={(e) => e.stopPropagation()}>
        {/* Image Side */}
        <div className="modal-image-side">
          <div className="modal-image-wrap">
            <NftImage nft={nft} large style={{ width: "100%", display: "block" }} />
          </div>
          {nft.rank && nft.rank <= rankThreshold && (
            <div className="modal-rank-badge">
              RANK #{nft.rank}
            </div>
          )}
          <button
            className={`modal-fav-btn ${isFavorite ? "active" : ""}`}
            onClick={() => onToggleFavorite(nft.id)}
            title={isFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-label={isFavorite ? "Remove from favorites" : "Add to favorites"}
            aria-pressed={isFavorite}
          >
            {isFavorite ? "\u2665" : "\u2661"}
          </button>
        </div>

        {/* Details Side */}
        <div className="modal-details">
          {/* Header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
            <div>
              <h2 style={{ fontFamily: "var(--display)", fontSize: "clamp(16px, 5vw, 26px)", fontWeight: 700, color: "var(--text)", letterSpacing: "-0.03em" }}>
                {displayName}
              </h2>
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", marginTop: 6, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                <span
                  onClick={() => handleCopy(nft.id, "id")}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCopy(nft.id, "id"); } }}
                  className="copyable"
                  title="Copy Token ID"
                  role="button"
                  tabIndex={0}
                >
                  Token #{nft.id} {copied === "id" ? "\u2713" : ""}
                </span>
                <span>{"\u00b7"} ERC-721</span>
                {nft.owner && (
                  <>
                    <span
                      onClick={() => handleCopy(nft.owner, "owner")}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCopy(nft.owner, "owner"); } }}
                      className="copyable"
                      title="Copy owner address"
                      role="button"
                      tabIndex={0}
                    >
                      {"\u00b7"} {nft.owner.slice(0, 6)}...{nft.owner.slice(-4)} {copied === "owner" ? "\u2713" : ""}
                    </span>
                    {onViewProfile && (
                      <span
                        onClick={() => onViewProfile(nft.owner)}
                        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onViewProfile(nft.owner); } }}
                        className="copyable"
                        title="View on-chain profile"
                        role="button"
                        tabIndex={0}
                        style={{ color: "var(--naka-blue)" }}
                      >
                        {"\u00b7"} Profile
                      </span>
                    )}
                  </>
                )}
              </div>
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              {onShare && (
                <button
                  className="modal-close"
                  onClick={onShare}
                  title="Share Card"
                  aria-label="Generate shareable card"
                  style={{ fontSize: 14 }}
                >
                  {"\u{1F4E4}"}
                </button>
              )}
              {onTheater && (
                <button
                  className="modal-close"
                  onClick={onTheater}
                  title="Theater Mode"
                  aria-label="Open theater mode"
                  style={{ fontSize: 16 }}
                >
                  ⛶
                </button>
              )}
              <button
                className="modal-close"
                onClick={() => handleCopy(`${window.location.origin}/${collection.slug}/nft/${nft.id}`, "share")}
                title="Copy link"
                aria-label="Copy shareable link"
              >
                {copied === "share" ? "\u2713" : "\u{1F517}"}
              </button>
              <button className="modal-close" onClick={onClose} aria-label="Close modal">{"\u2715"}</button>
            </div>
          </div>

          {/* Price */}
          {nft.price != null && nft.price > 0 && (
            <div className="price-box">
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.08em", marginBottom: 10 }}>
                CURRENT PRICE
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Eth size={20} />
                <span style={{ fontFamily: "var(--display)", fontSize: 34, fontWeight: 700, color: "var(--text)" }}>
                  {Number(nft.price).toFixed(4)}
                </span>
              </div>
              {nft.lastSale != null && nft.lastSale > 0 && (
                <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
                  Last sale: <Eth size={11} /> {Number(nft.lastSale).toFixed(4)}
                </div>
              )}
            </div>
          )}

          {/* Fair Value Estimate — hidden in Lite mode */}
          {!isLite && <FairValueBadge nft={nft} floorPrice={floorPrice} supply={supplyForRarity} />}

          {/* Price History Chart */}
          <PriceHistoryChart tokenId={nft.id} contract={collection.contract} />

          {/* Order validation warning — hidden in Lite mode */}
          {!isLite && orderWarning && (
            <div style={{
              background: orderWarning.status === "red" ? "rgba(248,113,113,0.08)" : "rgba(251,191,36,0.08)",
              border: `1px solid ${orderWarning.status === "red" ? "rgba(248,113,113,0.2)" : "rgba(251,191,36,0.2)"}`,
              borderRadius: 8,
              padding: "8px 12px",
              marginBottom: 4,
              display: "flex",
              alignItems: "flex-start",
              gap: 8,
            }}>
              <span style={{ fontSize: 14, lineHeight: 1.2 }}>
                {orderWarning.status === "red" ? "\u26D4" : "\u26A0"}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontFamily: "var(--mono)", fontSize: 10,
                  color: orderWarning.status === "red" ? "var(--red, #f87171)" : "var(--yellow, #fbbf24)",
                  letterSpacing: "0.04em", fontWeight: 700,
                }}>
                  {orderWarning.status === "red" ? "ORDER INVALID" : "ORDER WARNING"}
                </div>
                {orderWarning.reason && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                    {orderWarning.reason}
                  </div>
                )}
                {orderWarning.warnings?.length > 0 && !orderWarning.reason && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
                    {orderWarning.warnings.join("; ")}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div style={{ display: "flex", gap: 10 }}>
            {nft.orderHash && nft.price ? (
              <button
                className="btn-primary"
                style={{ flex: 1 }}
                disabled={buying}
                aria-label="Buy this NFT"
                onClick={() => {
                  if (!wallet) { onConnect?.(); return; }
                  setBuying(true);
                  startTransaction({
                    nft,
                    price: Number(nft.price),
                    onExecute: () => fulfillSeaportOrder(nft),
                    onSuccess: ({ hash, gasUsed }) => {
                      recordTransaction({ type: "buy", nft, price: nft.price, hash, wallet, slug: collection.slug });
                      addToast?.(`Success! Bought #${nft.id}`, "success");
                      setBuying(false);
                    },
                    onError: () => {
                      setBuying(false);
                    },
                  });
                }}
              >
                {buying ? "Confirming..." : !wallet ? "Connect Wallet to Buy" : `Buy for ${Number(nft.price ?? 0).toFixed(4)} ETH`}
              </button>
            ) : (
              <button className="btn-primary" style={{ flex: 1 }} aria-label="Buy this NFT" onClick={() => window.open(openSeaUrl, "_blank", "noopener,noreferrer")}>
                Buy on OpenSea
              </button>
            )}
            <button
              className="btn-secondary"
              style={{ flex: 0, whiteSpace: "nowrap", padding: "0 16px" }}
              aria-label="Make an offer on this NFT"
              onClick={() => setShowOfferModal(true)}
            >
              Make Offer
            </button>
          </div>

          {/* Offers on this token */}
          <OfferPanel
            tokenId={nft.id}
            wallet={wallet}
            addToast={addToast}
            onMakeOffer={() => setShowOfferModal(true)}
            ownerAddress={nft?.owner}
          />

          {/* Comparable Sales — hidden in Lite mode */}
          {!isLite && allTokens && allTokens.length > 0 && (
            <ErrorBoundary title="">
              <Suspense fallback={null}>
                <ComparableSales nft={nft} allTokens={allTokens} />
              </Suspense>
            </ErrorBoundary>
          )}

          {/* Type / Species Lore Callout */}
          {(() => {
            const attrs = nft.attributes || [];
            const typeAttr = attrs.find(a => a.key === "Type")?.value;
            const specieAttr = attrs.find(a => a.key === "Specie")?.value;
            const legendaryAttr = attrs.find(a => a.key === "Legendary Name")?.value;
            const charType = typeAttr && CHARACTER_TYPES.find(t => typeAttr === t.name || typeAttr.endsWith(t.name) || typeAttr.startsWith(t.name));
            const species = specieAttr && GNSS_SPECIES.find(s => s.name === specieAttr);
            const legendary = legendaryAttr && JB_LEGENDARIES.find(l => l.name === legendaryAttr);
            const loreItem = charType || species || legendary;
            if (!loreItem) return null;
            const isUltra = charType ? charType.count <= 36 : species ? species.rarityTier === "legendary" : !!legendary;
            const tierLabel = legendary ? "LEGENDARY 1/1" : charType ? (charType.count <= 36 ? "ULTRA RARE" : charType.count <= 868 ? "RARE TYPE" : null) : species?.rarityTier?.toUpperCase();
            return (
              <div style={{
                background: isUltra ? "linear-gradient(135deg, rgba(200,168,80,0.10), rgba(200,168,80,0.03))" : "var(--surface)",
                border: isUltra ? "1px solid rgba(200,168,80,0.25)" : "1px solid rgba(255,255,255,0.06)",
                borderRadius: 10, padding: "12px 14px", marginBottom: 12,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontFamily: "var(--display)", fontSize: 13, fontWeight: 600, color: isUltra ? "var(--gold)" : "var(--text)" }}>
                    {charType?.name || species?.name || legendary?.name}
                  </span>
                  {tierLabel && (
                    <span style={{
                      fontFamily: "var(--mono)", fontSize: 8, padding: "2px 6px", borderRadius: 4,
                      background: isUltra ? "rgba(200,168,80,0.15)" : "rgba(100,160,255,0.1)",
                      color: isUltra ? "var(--gold)" : "var(--naka-blue)",
                    }}>
                      {tierLabel}
                    </span>
                  )}
                </div>
                <div style={{ fontFamily: "var(--display)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6 }}>
                  {charType?.description || species?.visualDescription || legendary?.description}
                </div>
                {(charType?.count || species?.supply) && (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>
                    {charType ? `${charType.count.toLocaleString()} exist (${charType.percentage}%)` : species?.supply ? `${species.supply.toLocaleString()} beings` : ""}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Traits */}
          <div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.08em", marginBottom: 10 }}>
              TRAITS {Array.isArray(nft.attributes) && nft.attributes.length > 0 ? `(${nft.attributes.length})` : ""}
              {traitRarityApprox && Array.isArray(nft.attributes) && nft.attributes.length > 0 && (
                <span style={{ marginLeft: 6, fontSize: 9, color: "var(--text-muted)", fontWeight: 400 }}>
                  (based on {loadedCount.toLocaleString()}/{supplyForRarity.toLocaleString()} loaded)
                </span>
              )}
            </div>
            {Array.isArray(nft.attributes) && nft.attributes.length > 0 ? (
              <div className="traits-grid">
                {nft.attributes.map((attr, i) => {
                  const traitKey = `${attr.key}::${attr.value}`;
                  const count = traitCountMap?.[traitKey] ?? attr.count ?? null;
                  const pct = count != null && traitDenominator > 0
                    ? ((count / traitDenominator) * 100)
                    : null;
                  return (
                    <div key={attr.key || i} className="trait-cell">
                      <div className="trait-key">{attr.key ?? "Unknown"}</div>
                      <div className="trait-value">{attr.value ?? "None"}</div>
                      {count != null ? (
                        <div className="trait-rarity">
                          {Number(count).toLocaleString()} ({pct != null ? (pct < 1 ? pct.toFixed(2) : pct.toFixed(1)) : "?"}%{traitRarityApprox ? "~" : ""})
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)" }}>
                No traits available for this token
              </div>
            )}
          </div>

          {/* Metadata Grid */}
          <div className="meta-grid">
            {[
              ["TOKEN ID", `#${nft.id}`],
              ["CHAIN", "Ethereum"],
              ["STANDARD", "ERC-721"],
              ["CONTRACT", `${collection.contract.slice(0, 6)}...${collection.contract.slice(-5)}`],
            ].map(([k, v]) => (
              <div
                key={k}
                className={`meta-cell ${k === "CONTRACT" ? "copyable" : ""}`}
                onClick={k === "CONTRACT" ? () => handleCopy(collection.contract, "contract") : undefined}
                onKeyDown={k === "CONTRACT" ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleCopy(collection.contract, "contract"); } } : undefined}
                role={k === "CONTRACT" ? "button" : undefined}
                tabIndex={k === "CONTRACT" ? 0 : undefined}
                title={k === "CONTRACT" ? "Copy full address" : undefined}
              >
                <div className="meta-label">{k} {k === "CONTRACT" && copied === "contract" ? "\u2713" : ""}</div>
                <div className="meta-value">{v}</div>
              </div>
            ))}
          </div>

          {/* External Links */}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              ["OpenSea", openSeaUrl],
              ["Etherscan", ETHERSCAN_TOKEN(nft.id, collection.contract)],
            ].map(([label, url]) => (
              <a key={label} href={url} target="_blank" rel="noopener noreferrer" className="ext-link">
                {label} {"\u2197"}
              </a>
            ))}
          </div>
        </div>
      </div>

      {showOfferModal && (
        <MakeOfferModal
          nft={nft}
          onClose={() => setShowOfferModal(false)}
          wallet={wallet}
          onConnect={onConnect}
          addToast={addToast}
        />
      )}

      <TransactionProgress
        {...progressProps}
      />
    </div>
  );
}
