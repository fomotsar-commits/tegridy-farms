import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { getProvider } from "../api";
import {
  SEAPORT_ADDRESS, SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES,
  CONDUIT_KEY, CONDUIT_ADDRESS,
  OPENSEA_FEE_RECIPIENT, OPENSEA_FEE_BPS,
  PLATFORM_FEE_RECIPIENT, PLATFORM_FEE_BPS,
} from "../constants";
import { useActiveCollection } from "../contexts/CollectionContext";
import { openseaPost } from "../lib/proxy";
import { createNativeListing } from "../lib/orderbook";
import { formatPrice } from "../lib/formatPrice";

// ═══ CONSTANTS ═══

const DURATION_OPTIONS = [
  { label: "1 day", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
];

const PRICING_MODES = [
  { value: "floor", label: "Floor Price", desc: "List all at floor price with multiplier" },
  { value: "trait", label: "Trait Floor", desc: "Price each by highest trait floor" },
  { value: "ladder", label: "Ladder", desc: "Distribute prices by rarity" },
];

const MARKETPLACE_OPTIONS = [
  { value: "opensea", label: "OpenSea (Seaport)", feeLabel: `${OPENSEA_FEE_BPS / 100}% + ${PLATFORM_FEE_BPS / 100}%` },
  { value: "native", label: "Native Orderbook", feeLabel: `${PLATFORM_FEE_BPS / 100}% only` },
];

const HAS_PLATFORM_FEE = PLATFORM_FEE_BPS > 0 && PLATFORM_FEE_RECIPIENT !== "0x0000000000000000000000000000000000000000";

function computeFees(priceEth, marketplace) {
  const osFee = marketplace === "opensea" ? Math.round(priceEth * OPENSEA_FEE_BPS) / 10000 : 0;
  const platformFee = HAS_PLATFORM_FEE ? (priceEth * PLATFORM_FEE_BPS) / 10000 : 0;
  return { osFee, platformFee, total: osFee + platformFee, revenue: priceEth - osFee - platformFee };
}

// ═══ STEP COMPONENTS ═══

function StepSelect({ tokens, selected, setSelected, listingMap, isSubmitting }) {
  const unlisted = useMemo(
    () => tokens.filter((t) => !listingMap.has(String(t.id))),
    [tokens, listingMap],
  );

  const toggle = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, [setSelected]);

  const selectAll = useCallback(() => {
    if (selected.size === unlisted.length) setSelected(new Set());
    else setSelected(new Set(unlisted.map((n) => n.id)));
  }, [selected.size, unlisted, setSelected]);

  return (
    <>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.06em" }}>
          SELECT NFTS ({selected.size} selected)
        </span>
        <button
          onClick={selectAll}
          disabled={isSubmitting}
          style={{
            background: "none", border: "none", cursor: "pointer",
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)", textDecoration: "underline",
          }}
        >
          {selected.size === unlisted.length ? "Deselect All" : "Select All"}
        </button>
      </div>

      {unlisted.length === 0 ? (
        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", textAlign: "center", padding: 20 }}>
          All NFTs are already listed.
        </div>
      ) : (
        <div style={{
          display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))",
          gap: 8, maxHeight: 280, overflowY: "auto",
          background: "rgba(0,0,0,0.15)", borderRadius: 10, padding: 10,
          border: "1px solid var(--border)",
        }}>
          {unlisted.map((nft) => {
            const sel = selected.has(nft.id);
            return (
              <div
                key={nft.id}
                onClick={() => !isSubmitting && toggle(nft.id)}
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
    </>
  );
}

function StepPricing({ selectedNfts, pricingMode, setPricingMode, multiplier, setMultiplier, ladderStart, setLadderStart, ladderEnd, setLadderEnd, priceOverrides, setPriceOverrides, floorPrice, marketplace }) {
  // Compute auto-prices per NFT based on mode
  const autoPrices = useMemo(() => {
    const floor = floorPrice || 0;
    const prices = {};
    if (pricingMode === "floor") {
      for (const nft of selectedNfts) {
        prices[nft.id] = +(floor * multiplier).toFixed(6);
      }
    } else if (pricingMode === "trait") {
      for (const nft of selectedNfts) {
        // Use highest trait floor from attributes; fallback to collection floor
        let maxTraitFloor = 0;
        for (const attr of (nft.attributes || [])) {
          const tf = attr.traitFloor || 0;
          if (tf > maxTraitFloor) maxTraitFloor = tf;
        }
        const base = maxTraitFloor > 0 ? maxTraitFloor : floor;
        prices[nft.id] = +(base * multiplier).toFixed(6);
      }
    } else if (pricingMode === "ladder") {
      const start = parseFloat(ladderStart) || 0;
      const end = parseFloat(ladderEnd) || 0;
      // Sort by rarity: lowest rank = rarest = highest price
      const sorted = [...selectedNfts].sort((a, b) => (a.rank || 99999) - (b.rank || 99999));
      const count = sorted.length;
      sorted.forEach((nft, i) => {
        const price = count <= 1 ? start : end - ((end - start) * i) / (count - 1);
        prices[nft.id] = +price.toFixed(6);
      });
    }
    return prices;
  }, [selectedNfts, pricingMode, multiplier, ladderStart, ladderEnd, floorPrice]);

  const getPrice = useCallback((id) => {
    if (priceOverrides[id] !== undefined && priceOverrides[id] !== "") return parseFloat(priceOverrides[id]) || 0;
    return autoPrices[id] || 0;
  }, [priceOverrides, autoPrices]);

  const totalRevenue = useMemo(() => {
    let sum = 0;
    for (const nft of selectedNfts) {
      const p = getPrice(nft.id);
      const { revenue } = computeFees(p, marketplace);
      sum += revenue;
    }
    return sum;
  }, [selectedNfts, getPrice, marketplace]);

  return (
    <>
      {/* Pricing mode selector */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.06em", marginBottom: 8 }}>
          PRICING STRATEGY
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {PRICING_MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => setPricingMode(m.value)}
              style={{
                flex: 1, minWidth: 90, padding: "12px 12px", borderRadius: 8, cursor: "pointer",
                border: pricingMode === m.value ? "1px solid var(--naka-blue)" : "1px solid var(--border)",
                background: pricingMode === m.value ? "rgba(111,168,220,0.1)" : "rgba(0,0,0,0.2)",
                color: pricingMode === m.value ? "var(--naka-blue)" : "var(--text-dim)",
                textAlign: "left",
              }}
            >
              <div style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 600 }}>{m.label}</div>
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, marginTop: 2, opacity: 0.7 }}>{m.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Multiplier slider for floor/trait modes */}
      {(pricingMode === "floor" || pricingMode === "trait") && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>MULTIPLIER</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--naka-blue)", fontWeight: 600 }}>{multiplier.toFixed(2)}x</span>
          </div>
          <input
            type="range"
            min="0.95"
            max="1.5"
            step="0.01"
            value={multiplier}
            onChange={(e) => setMultiplier(parseFloat(e.target.value))}
            aria-label={`Price multiplier: ${multiplier.toFixed(2)}x`}
            style={{ width: "100%", accentColor: "var(--naka-blue)" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>0.95x</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>1.50x</span>
          </div>
        </div>
      )}

      {/* Ladder price range inputs */}
      {pricingMode === "ladder" && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
          <div>
            <label htmlFor="ladder-start-price" style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>
              START PRICE (ETH)
            </label>
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
            }}>
              <Eth size={12} />
              <input
                id="ladder-start-price"
                type="number" inputMode="decimal" step="0.001" min="0" placeholder="0.10"
                value={ladderStart} onChange={(e) => setLadderStart(e.target.value)}
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)" }}
              />
            </div>
          </div>
          <div>
            <label htmlFor="ladder-end-price" style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", display: "block", marginBottom: 4 }}>
              END PRICE (ETH)
            </label>
            <div style={{
              display: "flex", alignItems: "center", gap: 6,
              background: "rgba(0,0,0,0.3)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px",
            }}>
              <Eth size={12} />
              <input
                id="ladder-end-price"
                type="number" inputMode="decimal" step="0.001" min="0" placeholder="0.50"
                value={ladderEnd} onChange={(e) => setLadderEnd(e.target.value)}
                style={{ flex: 1, background: "transparent", border: "none", outline: "none", fontFamily: "var(--mono)", fontSize: 13, color: "var(--text)" }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Per-item price table */}
      <div style={{
        maxHeight: 240, overflowY: "auto", overflowX: "auto", WebkitOverflowScrolling: "touch",
        border: "1px solid var(--border)", borderRadius: 10,
        background: "rgba(0,0,0,0.15)",
      }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", padding: "8px 10px", textAlign: "left", letterSpacing: "0.06em" }}>NFT</th>
              <th style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", padding: "8px 10px", textAlign: "right", letterSpacing: "0.06em" }}>RANK</th>
              <th style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", padding: "8px 6px", textAlign: "right", letterSpacing: "0.06em" }}>PRICE (ETH)</th>
              <th style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", padding: "8px 10px", textAlign: "right", letterSpacing: "0.06em" }}>REVENUE</th>
            </tr>
          </thead>
          <tbody>
            {selectedNfts.map((nft) => {
              const p = getPrice(nft.id);
              const { revenue } = computeFees(p, marketplace);
              const hasOverride = priceOverrides[nft.id] !== undefined && priceOverrides[nft.id] !== "";
              return (
                <tr key={nft.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "6px 10px", display: "flex", alignItems: "center", gap: 8 }}>
                    <NftImage nft={nft} style={{ width: 28, height: 28, borderRadius: 4, objectFit: "cover" }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>#{nft.id}</span>
                  </td>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", padding: "6px 10px", textAlign: "right" }}>
                    {nft.rank ? `#${nft.rank}` : "\u2014"}
                  </td>
                  <td style={{ padding: "6px 6px", textAlign: "right" }}>
                    <input
                      type="number" inputMode="decimal" step="0.001" min="0"
                      aria-label={`Price for #${nft.id}`}
                      placeholder={autoPrices[nft.id]?.toFixed(4) || "0.00"}
                      value={priceOverrides[nft.id] ?? ""}
                      onChange={(e) => setPriceOverrides((prev) => ({ ...prev, [nft.id]: e.target.value }))}
                      style={{
                        width: "100%", maxWidth: 90, minWidth: 60, background: hasOverride ? "rgba(111,168,220,0.08)" : "transparent",
                        border: hasOverride ? "1px solid var(--naka-blue)" : "1px solid var(--border)",
                        borderRadius: 4, padding: "4px 6px", textAlign: "right",
                        fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)", outline: "none",
                      }}
                    />
                  </td>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--green)", padding: "6px 10px", textAlign: "right" }}>
                    {revenue > 0 ? revenue.toFixed(4) : "\u2014"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Total revenue */}
      <div style={{
        display: "flex", justifyContent: "space-between", alignItems: "center",
        marginTop: 12, padding: "10px 12px", borderRadius: 8,
        background: "rgba(46,204,113,0.06)", border: "1px solid rgba(46,204,113,0.15)",
      }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>TOTAL EST. REVENUE</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 14, color: "var(--green)", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
          <Eth size={12} /> {formatPrice(totalRevenue)}
        </span>
      </div>
    </>
  );
}

function StepOptions({ duration, setDuration, marketplace, setMarketplace }) {
  return (
    <>
      {/* Duration */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.06em", marginBottom: 8 }}>
          LISTING DURATION
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {DURATION_OPTIONS.map((opt) => (
            <button
              key={opt.hours}
              onClick={() => setDuration(opt.hours)}
              style={{
                padding: "12px 16px", borderRadius: 8, cursor: "pointer",
                fontFamily: "var(--mono)", fontSize: 12, minHeight: 44,
                border: duration === opt.hours ? "1px solid var(--naka-blue)" : "1px solid var(--border)",
                background: duration === opt.hours ? "rgba(111,168,220,0.1)" : "rgba(0,0,0,0.2)",
                color: duration === opt.hours ? "var(--naka-blue)" : "var(--text-dim)",
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Marketplace */}
      <div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", letterSpacing: "0.06em", marginBottom: 8 }}>
          MARKETPLACE
        </div>
        <div style={{ display: "flex", gap: 10, flexDirection: "column" }}>
          {MARKETPLACE_OPTIONS.map((m) => (
            <button
              key={m.value}
              onClick={() => setMarketplace(m.value)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                padding: "14px 16px", borderRadius: 10, cursor: "pointer", textAlign: "left", minHeight: 44,
                border: marketplace === m.value ? "1px solid var(--naka-blue)" : "1px solid var(--border)",
                background: marketplace === m.value ? "rgba(111,168,220,0.08)" : "rgba(0,0,0,0.2)",
                color: marketplace === m.value ? "var(--text)" : "var(--text-dim)",
              }}
            >
              <div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 12, fontWeight: 600 }}>{m.label}</div>
                <div style={{ fontFamily: "var(--mono)", fontSize: 9, marginTop: 2, opacity: 0.7 }}>Fees: {m.feeLabel}</div>
              </div>
              <div style={{
                width: 20, height: 20, borderRadius: "50%",
                border: marketplace === m.value ? "2px solid var(--naka-blue)" : "2px solid var(--border)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                {marketplace === m.value && (
                  <div style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--naka-blue)" }} />
                )}
              </div>
            </button>
          ))}
        </div>
        {marketplace === "native" && (
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)", marginTop: 8, lineHeight: 1.5 }}>
            Native orderbook saves {OPENSEA_FEE_BPS / 100}% per listing vs OpenSea. Orders are Seaport-compatible and can be filled on-chain.
          </div>
        )}
      </div>
    </>
  );
}

function StepReview({ selectedNfts, getPrice, duration, marketplace, collection }) {
  const durationLabel = DURATION_OPTIONS.find((d) => d.hours === duration)?.label || `${duration}h`;
  const marketplaceLabel = marketplace === "opensea" ? "OpenSea (Seaport)" : "Native Orderbook";

  let totalPrice = 0;
  let totalOsFee = 0;
  let totalPlatformFee = 0;
  let totalRevenue = 0;
  for (const nft of selectedNfts) {
    const p = getPrice(nft.id);
    const fees = computeFees(p, marketplace);
    totalPrice += p;
    totalOsFee += fees.osFee;
    totalPlatformFee += fees.platformFee;
    totalRevenue += fees.revenue;
  }

  return (
    <>
      <div style={{
        maxHeight: 200, overflowY: "auto", overflowX: "auto", WebkitOverflowScrolling: "touch",
        border: "1px solid var(--border)", borderRadius: 10,
        background: "rgba(0,0,0,0.15)", marginBottom: 16,
      }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              <th style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", padding: "8px 10px", textAlign: "left" }}>NFT</th>
              <th style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", padding: "8px 10px", textAlign: "right" }}>PRICE</th>
              <th style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", padding: "8px 10px", textAlign: "right" }}>REVENUE</th>
            </tr>
          </thead>
          <tbody>
            {selectedNfts.map((nft) => {
              const p = getPrice(nft.id);
              const { revenue } = computeFees(p, marketplace);
              return (
                <tr key={nft.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                  <td style={{ padding: "6px 10px", display: "flex", alignItems: "center", gap: 8 }}>
                    <NftImage nft={nft} style={{ width: 24, height: 24, borderRadius: 4, objectFit: "cover" }} />
                    <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>#{nft.id}</span>
                  </td>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)", padding: "6px 10px", textAlign: "right" }}>
                    {formatPrice(p)}
                  </td>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--green)", padding: "6px 10px", textAlign: "right" }}>
                    {formatPrice(revenue)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Summary cards */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 8, padding: "10px 12px", border: "1px solid var(--border)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>MARKETPLACE</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)", marginTop: 4 }}>{marketplaceLabel}</div>
        </div>
        <div style={{ background: "rgba(0,0,0,0.2)", borderRadius: 8, padding: "10px 12px", border: "1px solid var(--border)" }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>DURATION</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)", marginTop: 4 }}>{durationLabel}</div>
        </div>
      </div>

      {/* Fee breakdown */}
      <div style={{
        background: "rgba(111,168,220,0.04)", border: "1px solid rgba(111,168,220,0.1)",
        borderRadius: 8, padding: "12px 14px", marginBottom: 16,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>Total list price</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text)" }}>{formatPrice(totalPrice)} ETH</span>
        </div>
        {marketplace === "opensea" && (
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>OpenSea fee ({OPENSEA_FEE_BPS / 100}%)</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>-{formatPrice(totalOsFee)} ETH</span>
          </div>
        )}
        {HAS_PLATFORM_FEE && (
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>Platform fee ({PLATFORM_FEE_BPS / 100}%)</span>
            <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>-{formatPrice(totalPlatformFee)} ETH</span>
          </div>
        )}
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6, marginTop: 4, display: "flex", justifyContent: "space-between" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--green)", fontWeight: 600 }}>You receive</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--green)", fontWeight: 600 }}>{formatPrice(totalRevenue)} ETH</span>
        </div>
      </div>
    </>
  );
}

// ═══ MAIN WIZARD ═══

const STEPS = ["select", "pricing", "options", "review"];
const STEP_LABELS = ["Select NFTs", "Set Prices", "Options", "Review & List"];

export default function BulkListingWizard({ tokens, wallet, onClose, addToast, onConnect, stats, listingMap }) {
  const collection = useActiveCollection();
  const modalRef = useRef(null);

  // Wizard state
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState(new Set());

  // Pricing state
  const [pricingMode, setPricingMode] = useState("floor");
  const [multiplier, setMultiplier] = useState(1.0);
  const [ladderStart, setLadderStart] = useState("");
  const [ladderEnd, setLadderEnd] = useState("");
  const [priceOverrides, setPriceOverrides] = useState({});

  // Options state
  const [duration, setDuration] = useState(168);
  const [marketplace, setMarketplace] = useState("opensea");

  // Submission state
  const [submitting, setSubmitting] = useState(false);
  const [submitLabel, setSubmitLabel] = useState("");
  const [submitProgress, setSubmitProgress] = useState(0);
  const [done, setDone] = useState(false);

  const floorPrice = stats?.floor != null && isFinite(stats.floor) ? stats.floor : 0;

  const selectedNfts = useMemo(
    () => tokens.filter((t) => selected.has(t.id)),
    [tokens, selected],
  );

  // Price computation matching StepPricing logic
  const autoPrices = useMemo(() => {
    const floor = floorPrice || 0;
    const prices = {};
    if (pricingMode === "floor") {
      for (const nft of selectedNfts) prices[nft.id] = +(floor * multiplier).toFixed(6);
    } else if (pricingMode === "trait") {
      for (const nft of selectedNfts) {
        let maxTraitFloor = 0;
        for (const attr of (nft.attributes || [])) {
          const tf = attr.traitFloor || 0;
          if (tf > maxTraitFloor) maxTraitFloor = tf;
        }
        const base = maxTraitFloor > 0 ? maxTraitFloor : floor;
        prices[nft.id] = +(base * multiplier).toFixed(6);
      }
    } else if (pricingMode === "ladder") {
      const start = parseFloat(ladderStart) || 0;
      const end = parseFloat(ladderEnd) || 0;
      const sorted = [...selectedNfts].sort((a, b) => (a.rank || 99999) - (b.rank || 99999));
      const count = sorted.length;
      sorted.forEach((nft, i) => {
        const price = count <= 1 ? start : end - ((end - start) * i) / (count - 1);
        prices[nft.id] = +price.toFixed(6);
      });
    }
    return prices;
  }, [selectedNfts, pricingMode, multiplier, ladderStart, ladderEnd, floorPrice]);

  const getPrice = useCallback((id) => {
    if (priceOverrides[id] !== undefined && priceOverrides[id] !== "") return parseFloat(priceOverrides[id]) || 0;
    return autoPrices[id] || 0;
  }, [priceOverrides, autoPrices]);

  // Escape / focus trap
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); return; }
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
    return () => { window.removeEventListener("keydown", h); document.body.style.overflow = ""; };
  }, [onClose]);

  const canNext = useMemo(() => {
    if (step === 0) return selected.size > 0;
    if (step === 1) {
      // Every selected NFT must have a price > 0
      return selectedNfts.every((nft) => getPrice(nft.id) > 0);
    }
    return true;
  }, [step, selected.size, selectedNfts, getPrice]);

  // ═══ SUBMIT — List All ═══
  const handleListAll = useCallback(async () => {
    if (!wallet) { onConnect?.(); return; }
    if (selectedNfts.length === 0) return;

    setSubmitting(true);
    setSubmitProgress(0);

    try {
      if (marketplace === "opensea") {
        // OpenSea: individual Seaport listings signed + posted one by one
        const { ethers } = await import("ethers");
        const provider = getProvider();
        if (!provider) { addToast?.("Wallet not found", "error"); setSubmitting(false); return; }

        const browserProvider = new ethers.BrowserProvider(provider);
        const signer = await browserProvider.getSigner();
        const sellerAddress = await signer.getAddress();

        // Check NFT approval for conduit
        setSubmitLabel("Checking approval...");
        const nftContract = new ethers.Contract(collection.contract, [
          "function isApprovedForAll(address,address) view returns (bool)",
          "function setApprovalForAll(address,bool)",
        ], signer);
        const isApproved = await nftContract.isApprovedForAll(sellerAddress, CONDUIT_ADDRESS);
        if (!isApproved) {
          setSubmitLabel("Approving NFTs for Seaport...");
          const approveTx = await nftContract.setApprovalForAll(CONDUIT_ADDRESS, true);
          await approveTx.wait();
        }

        // Set up Seaport contract for counter fetches
        const seaportABI = ["function getCounter(address) view returns (uint256)"];
        const seaport = new ethers.Contract(SEAPORT_ADDRESS, seaportABI, browserProvider);

        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < selectedNfts.length; i++) {
          const nft = selectedNfts[i];
          const priceEth = getPrice(nft.id);
          if (priceEth <= 0) { failCount++; continue; }

          setSubmitLabel(`Signing listing ${i + 1}/${selectedNfts.length} (#${nft.id})...`);
          setSubmitProgress(((i + 0.3) / selectedNfts.length) * 100);

          try {
            // Fetch fresh counter for each listing to avoid stale counter errors
            const counter = await seaport.getCounter(sellerAddress);
            const priceWei = ethers.parseEther(String(priceEth));
            const now = Math.floor(Date.now() / 1000);
            const endTime = now + duration * 3600;

            const osFee = (priceWei * BigInt(OPENSEA_FEE_BPS)) / 10000n;
            const platFee = (priceWei * BigInt(PLATFORM_FEE_BPS)) / 10000n;
            const sellerAmount = priceWei - osFee - (HAS_PLATFORM_FEE ? platFee : 0n);

            const consideration = [
              {
                itemType: 0,
                token: "0x0000000000000000000000000000000000000000",
                identifierOrCriteria: "0",
                startAmount: sellerAmount.toString(),
                endAmount: sellerAmount.toString(),
                recipient: sellerAddress,
              },
              {
                itemType: 0,
                token: "0x0000000000000000000000000000000000000000",
                identifierOrCriteria: "0",
                startAmount: osFee.toString(),
                endAmount: osFee.toString(),
                recipient: OPENSEA_FEE_RECIPIENT,
              },
            ];

            if (HAS_PLATFORM_FEE) {
              consideration.push({
                itemType: 0,
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
              offer: [{
                itemType: 2,
                token: collection.contract,
                identifierOrCriteria: String(nft.id),
                startAmount: "1",
                endAmount: "1",
              }],
              consideration,
              orderType: 2, // FULL_OPEN_VIA_CONDUIT — required when using conduitKey
              startTime: String(now),
              endTime: String(endTime),
              zoneHash: "0x0000000000000000000000000000000000000000000000000000000000000000",
              salt: ethers.hexlify(ethers.randomBytes(32)),
              conduitKey: CONDUIT_KEY,
              totalOriginalConsiderationItems: consideration.length,
            };

            const signData = { ...orderParameters, counter: counter.toString() };
            const signature = await signer.signTypedData(SEAPORT_DOMAIN, SEAPORT_ORDER_TYPES, signData);

            setSubmitLabel(`Posting listing ${i + 1}/${selectedNfts.length} (#${nft.id})...`);
            setSubmitProgress(((i + 0.7) / selectedNfts.length) * 100);

            await openseaPost("orders/ethereum/seaport/listings", {
              parameters: { ...orderParameters, counter: counter.toString(), totalOriginalConsiderationItems: orderParameters.consideration.length },
              signature,
              protocol_address: SEAPORT_ADDRESS,
            });

            successCount++;
          } catch (err) {
            if (err.code === 4001 || err.code === "ACTION_REJECTED") {
              addToast?.(`Listing for #${nft.id} cancelled by user`, "info");
              failCount++;
              // Stop on user rejection
              break;
            }
            console.error(`Listing #${nft.id} failed:`, err);
            addToast?.(`Failed to list #${nft.id}: ${err.shortMessage || err.message}`, "error");
            failCount++;
          }

          setSubmitProgress(((i + 1) / selectedNfts.length) * 100);
        }

        if (successCount > 0) {
          addToast?.(`${successCount} NFT${successCount > 1 ? "s" : ""} listed on OpenSea!${failCount > 0 ? ` (${failCount} failed)` : ""}`, "success");
          setSubmitting(false);
          setDone(true);
        } else {
          addToast?.("No listings were created.", "error");
          setSubmitting(false);
        }
      } else {
        // Native orderbook: loop through createNativeListing
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < selectedNfts.length; i++) {
          const nft = selectedNfts[i];
          const priceEth = getPrice(nft.id);
          if (priceEth <= 0) { failCount++; continue; }

          setSubmitLabel(`Listing ${i + 1}/${selectedNfts.length} (#${nft.id}) on native orderbook...`);
          setSubmitProgress(((i + 0.5) / selectedNfts.length) * 100);

          try {
            const result = await createNativeListing({
              contract: collection.contract,
              tokenId: nft.id,
              priceEth,
              expirationHours: duration,
            });

            if (result.success) {
              successCount++;
            } else if (result.error === "rejected") {
              addToast?.(`Listing for #${nft.id} cancelled by user`, "info");
              failCount++;
              break;
            } else {
              addToast?.(`Failed to list #${nft.id}: ${result.message}`, "error");
              failCount++;
            }
          } catch (itemErr) {
            console.error(`Native listing error for #${nft.id}:`, itemErr);
            addToast?.(`Error listing #${nft.id}: ${itemErr.message || "Unknown error"}`, "error");
            failCount++;
          }

          setSubmitProgress(((i + 1) / selectedNfts.length) * 100);
        }

        if (successCount > 0) {
          addToast?.(`${successCount} NFT${successCount > 1 ? "s" : ""} listed on native orderbook!${failCount > 0 ? ` (${failCount} failed)` : ""}`, "success");
          setSubmitting(false);
          setDone(true);
        } else {
          addToast?.("No listings were created.", "error");
          setSubmitting(false);
        }
      }
    } catch (err) {
      if (err.message?.includes('approval')) {
        addToast?.("NFT approval was rejected or failed", "error");
      } else if (err.code === 4001 || err.code === "ACTION_REJECTED") {
        addToast?.("Listing cancelled", "info");
      } else {
        console.error("Bulk listing error:", err);
        addToast?.("Bulk listing failed. Please try again.", "error");
      }
      setSubmitLabel("");
      setSubmitting(false);
    }
  }, [wallet, onConnect, selectedNfts, getPrice, duration, marketplace, collection, addToast]);

  // ═══ RENDER ═══

  return (
    <div className="modal-bg" onClick={() => { if (!submitting) onClose(); }} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label="Bulk Listing Wizard">
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--card)", border: "1px solid var(--border)",
          borderRadius: 14, maxWidth: 620, width: "94%", margin: "auto",
          padding: "28px 20px", position: "relative",
          maxHeight: "85vh", overflowY: "auto",
        }}
      >
        {/* Close button */}
        <button
          className="modal-close"
          onClick={() => { if (!submitting) onClose(); }}
          aria-label="Close modal"
          style={{ position: "absolute", top: 12, right: 14 }}
        >{"\u2715"}</button>

        {/* Type label */}
        <div style={{
          fontFamily: "var(--pixel)", fontSize: 10, color: "var(--gold)",
          letterSpacing: "0.1em", marginBottom: 6,
        }}>
          BULK LISTING
        </div>

        {/* Title */}
        <div style={{
          fontFamily: "var(--display)", fontSize: 18, fontWeight: 600,
          color: "var(--text)", marginBottom: 16,
        }}>
          List Multiple {collection.name} for Sale
        </div>

        {/* Step indicator */}
        {!done && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 20 }}>
            {STEPS.map((s, i) => (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 6, flex: i < STEPS.length - 1 ? 1 : undefined }}>
                <div
                  onClick={() => !submitting && i < step && setStep(i)}
                  style={{
                    width: 32, height: 32, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 11, fontFamily: "var(--mono)", fontWeight: 600,
                    cursor: !submitting && i < step ? "pointer" : "default",
                    background: i < step ? "var(--green)" : i === step ? "var(--naka-blue)" : "var(--border)",
                    color: i <= step ? "#fff" : "var(--text-dim)",
                    transition: "background 0.2s",
                  }}
                >
                  {i < step ? "\u2713" : i + 1}
                </div>
                {i < STEPS.length - 1 && (
                  <div style={{ flex: 1, height: 1, background: i < step ? "var(--green)" : "var(--border)" }} />
                )}
              </div>
            ))}
          </div>
        )}

        {/* Step label */}
        {!done && !submitting && (
          <div style={{
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)",
            letterSpacing: "0.06em", marginBottom: 14,
          }}>
            STEP {step + 1}: {STEP_LABELS[step]}
          </div>
        )}

        {/* Done state */}
        {done ? (
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
              Listings Created!
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)" }}>
              Your {collection.name} NFTs are now listed for sale.
            </div>
            <button className="btn-primary" style={{ marginTop: 20, width: "100%" }} onClick={onClose}>
              Done
            </button>
          </div>
        ) : submitting ? (
          /* Submission progress */
          <div style={{ padding: "20px 0" }}>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 12, color: "var(--naka-blue)",
              textAlign: "center", marginBottom: 16,
            }}>
              {submitLabel}
            </div>
            <div style={{
              width: "100%", height: 6, borderRadius: 3,
              background: "var(--border)", overflow: "hidden",
            }}>
              <div style={{
                height: "100%", borderRadius: 3,
                background: "var(--naka-blue)",
                width: `${submitProgress}%`,
                transition: "width 0.3s",
              }} />
            </div>
            <div style={{
              fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)",
              textAlign: "center", marginTop: 8,
            }}>
              {Math.round(submitProgress)}% complete
            </div>
          </div>
        ) : (
          <>
            {/* Step content */}
            {step === 0 && (
              <StepSelect
                tokens={tokens}
                selected={selected}
                setSelected={setSelected}
                listingMap={listingMap}
                isSubmitting={false}
              />
            )}
            {step === 1 && (
              <StepPricing
                selectedNfts={selectedNfts}
                pricingMode={pricingMode}
                setPricingMode={setPricingMode}
                multiplier={multiplier}
                setMultiplier={setMultiplier}
                ladderStart={ladderStart}
                setLadderStart={setLadderStart}
                ladderEnd={ladderEnd}
                setLadderEnd={setLadderEnd}
                priceOverrides={priceOverrides}
                setPriceOverrides={setPriceOverrides}
                floorPrice={floorPrice}
                marketplace={marketplace}
              />
            )}
            {step === 2 && (
              <StepOptions
                duration={duration}
                setDuration={setDuration}
                marketplace={marketplace}
                setMarketplace={setMarketplace}
              />
            )}
            {step === 3 && (
              <StepReview
                selectedNfts={selectedNfts}
                getPrice={getPrice}
                duration={duration}
                marketplace={marketplace}
                collection={collection}
              />
            )}

            {/* Navigation buttons */}
            <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
              {step > 0 && (
                <button
                  onClick={() => setStep((s) => s - 1)}
                  style={{
                    flex: 1, padding: "14px", borderRadius: 8, cursor: "pointer", minHeight: 44,
                    fontFamily: "var(--mono)", fontSize: 12,
                    background: "rgba(0,0,0,0.2)", border: "1px solid var(--border)",
                    color: "var(--text-dim)",
                  }}
                >
                  Back
                </button>
              )}
              {step < 3 ? (
                <button
                  className="btn-primary"
                  type="button"
                  onClick={() => setStep((s) => s + 1)}
                  disabled={!canNext}
                  aria-disabled={!canNext}
                  style={{ flex: 2, textAlign: "center", fontSize: 12 }}
                >
                  {step === 0
                    ? `Continue with ${selected.size} NFT${selected.size !== 1 ? "s" : ""}`
                    : "Next"}
                </button>
              ) : (
                <button
                  className="btn-primary"
                  type="button"
                  onClick={handleListAll}
                  disabled={!wallet || selectedNfts.length === 0}
                  aria-disabled={!wallet || selectedNfts.length === 0}
                  style={{ flex: 2, textAlign: "center", fontSize: 12 }}
                >
                  {!wallet
                    ? "Connect Wallet"
                    : `List ${selectedNfts.length} NFT${selectedNfts.length !== 1 ? "s" : ""}`}
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
