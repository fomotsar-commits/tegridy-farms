import { useState, useMemo, useCallback, useEffect } from "react";
import { Eth } from "./Icons";
import { fulfillSeaportOrder } from "../api";
import { fulfillNativeOrder } from "../lib/orderbook";
import { recordTransaction } from "../lib/transactions";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useWallet } from "../contexts/WalletContext";

// Rough gas estimate per Seaport fulfillment (~150k gas units)
const GAS_PER_FILL = 150_000n;
const GWEI_DECIMALS = 1e9;

function estimateGas(count, gasPriceGwei = 30) {
  const totalGas = Number(GAS_PER_FILL) * count;
  return (totalGas * gasPriceGwei) / GWEI_DECIMALS;
}

// Build price tier buckets for floor depth visualization (0.1 ETH buckets)
function buildPriceTiers(listings, bucketSize = 0.1) {
  if (!listings || listings.length === 0) return [];
  const buckets = new Map();
  for (const l of listings) {
    const p = Number(l.price);
    if (!p || !isFinite(p)) continue;
    const tierKey = Math.floor(p / bucketSize) * bucketSize;
    buckets.set(tierKey, (buckets.get(tierKey) || 0) + 1);
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([price, count]) => ({ price, count }));
}

// Extract unique trait categories and values from listings
function extractTraitsFromListings(listings) {
  const traitMap = {};
  for (const item of listings) {
    for (const attr of item.attributes || []) {
      if (!attr.key || !attr.value) continue;
      if (!traitMap[attr.key]) traitMap[attr.key] = new Set();
      traitMap[attr.key].add(attr.value);
    }
  }
  return Object.entries(traitMap).map(([key, valuesSet]) => ({
    key,
    values: [...valuesSet].sort(),
  }));
}

// Marketplace badge component
function MarketplaceBadge({ marketplace }) {
  const isOpenSea = marketplace?.toLowerCase() === "opensea";
  const label = isOpenSea ? "OS" : "OB";
  const title = isOpenSea ? "OpenSea" : "Native Orderbook";
  const color = isOpenSea ? "#2081e2" : "var(--gold)";
  return (
    <span
      title={title}
      style={{
        fontFamily: "var(--mono)",
        fontSize: 10,
        fontWeight: 700,
        color,
        border: `1px solid ${color}`,
        borderRadius: 3,
        padding: "2px 5px",
        letterSpacing: "0.04em",
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

// Floor depth bar chart
function FloorDepthChart({ tiers, sweepUpToPrice, maxPriceGuard }) {
  if (!tiers || tiers.length === 0) return null;
  const maxCount = Math.max(...tiers.map(t => t.count));
  return (
    <div className="sweep-depth-chart">
      <div className="sweep-section-label">FLOOR DEPTH</div>
      <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 48, marginTop: 6 }}>
        {tiers.map((tier) => {
          const pct = maxCount > 0 ? (tier.count / maxCount) * 100 : 0;
          const inSweep = tier.price <= sweepUpToPrice;
          const excluded = maxPriceGuard != null && tier.price > maxPriceGuard;
          let bg = "rgba(200, 170, 100, 0.15)";
          if (excluded) bg = "rgba(248, 113, 113, 0.15)";
          else if (inSweep) bg = "rgba(212, 168, 67, 0.5)";
          return (
            <div
              key={tier.price}
              title={`${tier.price.toFixed(2)}-${(tier.price + 0.1).toFixed(2)} ETH: ${tier.count} listings`}
              style={{
                flex: 1,
                minWidth: 6,
                maxWidth: 28,
                height: `${Math.max(pct, 4)}%`,
                background: bg,
                borderRadius: "2px 2px 0 0",
                transition: "height 0.2s, background 0.2s",
                cursor: "default",
              }}
            />
          );
        })}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
        <span className="sweep-micro-label">{tiers[0]?.price.toFixed(2)}</span>
        <span className="sweep-micro-label">{tiers[tiers.length - 1]?.price.toFixed(2)} ETH</span>
      </div>
    </div>
  );
}

export default function SweepCalculator({ stats, listings, wallet, onConnect, addToast }) {
  const collection = useActiveCollection();
  const { isWrongNetwork } = useWallet();
  const [count, setCount] = useState(5);
  const [sweeping, setSweeping] = useState(false);
  const [progress, setProgress] = useState(0);

  // Dual mode: "quantity" or "budget"
  const [mode, setMode] = useState("quantity");
  const [budget, setBudget] = useState("");

  // Trait filters
  const [traitCategory, setTraitCategory] = useState("");
  const [traitValue, setTraitValue] = useState("");

  // Max price guard
  const [maxPriceGuard, setMaxPriceGuard] = useState("");

  const floor = stats?.floor ?? null;
  const hasListings = Array.isArray(listings) && listings.length > 0;
  const maxSlider = hasListings ? Math.min(listings.length, 30) : 30;

  // Extract available traits from current listings
  const availableTraits = useMemo(
    () => (hasListings ? extractTraitsFromListings(listings) : []),
    [hasListings, listings]
  );

  // Values for selected trait category
  const traitValues = useMemo(() => {
    if (!traitCategory) return [];
    const cat = availableTraits.find(t => t.key === traitCategory);
    return cat ? cat.values : [];
  }, [traitCategory, availableTraits]);

  // Reset trait value when category changes
  useEffect(() => {
    setTraitValue("");
  }, [traitCategory]);

  // Apply trait filter + max price guard to listings
  const filteredListings = useMemo(() => {
    if (!hasListings) return [];
    let items = listings;

    // Trait filter
    if (traitCategory && traitValue) {
      items = items.filter(item =>
        (item.attributes || []).some(
          a => a.key === traitCategory && a.value === traitValue
        )
      );
    }

    // Max price guard
    const cap = parseFloat(maxPriceGuard);
    if (!isNaN(cap) && cap > 0) {
      items = items.filter(item => item.price != null && item.price <= cap);
    }

    return items;
  }, [hasListings, listings, traitCategory, traitValue, maxPriceGuard]);

  // Budget mode: auto-calculate how many items fit
  const budgetCount = useMemo(() => {
    const budgetEth = parseFloat(budget);
    if (!budgetEth || budgetEth <= 0 || filteredListings.length === 0) return 0;
    let sum = 0;
    let n = 0;
    for (const l of filteredListings) {
      const p = Number(l.price) || 0;
      if (sum + p > budgetEth) break;
      sum += p;
      n++;
    }
    return n;
  }, [budget, filteredListings]);

  // Effective count based on mode
  const effectiveCount = useMemo(() => {
    if (mode === "budget") {
      return Math.min(budgetCount, filteredListings.length);
    }
    return Math.min(count, filteredListings.length);
  }, [mode, count, budgetCount, filteredListings.length]);

  // Clamp count when available listings change
  useEffect(() => {
    if (hasListings && count > maxSlider) {
      setCount(maxSlider);
    }
  }, [hasListings, maxSlider, count]);

  // Price tiers for depth chart
  const priceTiers = useMemo(
    () => buildPriceTiers(filteredListings),
    [filteredListings]
  );

  // Calculate sweep cost from filtered listings
  const sweepData = useMemo(() => {
    if (filteredListings.length === 0) {
      return {
        totalEth: floor != null ? floor * effectiveCount : null,
        source: floor != null ? "Floor estimate" : null,
        avgPrice: floor,
        maxPrice: floor,
        gasEst: estimateGas(effectiveCount),
      };
    }

    const clampedCount = Math.min(effectiveCount, filteredListings.length);
    const sweep = filteredListings.slice(0, clampedCount);
    const totalEth = sweep.reduce((sum, l) => sum + (Number(l.price) || 0), 0);
    const avgPrice = sweep.length > 0 ? totalEth / sweep.length : null;
    const sweepMaxPrice = sweep.length > 0 ? (Number(sweep[sweep.length - 1]?.price) || null) : null;

    const gasEst = estimateGas(clampedCount);

    return {
      totalEth,
      source: "Live listings",
      avgPrice,
      maxPrice: sweepMaxPrice,
      available: filteredListings.length,
      gasEst,
    };
  }, [filteredListings, effectiveCount, floor]);

  // Floor impact preview
  const floorImpact = useMemo(() => {
    if (!hasListings || filteredListings.length === 0) return null;
    const currentFloor = Number(filteredListings[0]?.price) || null;
    if (!currentFloor || effectiveCount === 0) return null;
    const remaining = filteredListings.slice(effectiveCount);
    const newFloor = remaining.length > 0 ? Number(remaining[0].price) : null;
    if (!newFloor) return null;
    const pctChange = ((newFloor - currentFloor) / currentFloor) * 100;
    return { currentFloor, newFloor, pctChange };
  }, [hasListings, filteredListings, effectiveCount]);


  // Sweep max price for depth chart highlighting
  const sweepUpToPrice = useMemo(() => {
    if (filteredListings.length === 0 || effectiveCount === 0) return 0;
    const idx = Math.min(effectiveCount, filteredListings.length) - 1;
    return Number(filteredListings[idx]?.price) || 0;
  }, [filteredListings, effectiveCount]);

  const handleSweep = useCallback(async () => {
    if (!wallet) {
      onConnect?.();
      return;
    }
    if (isWrongNetwork) {
      addToast?.("Wrong network — please switch to Ethereum Mainnet", "error");
      return;
    }
    if (filteredListings.length === 0) return;

    const sweepList = filteredListings.slice(0, effectiveCount).filter(l => l.orderHash);
    if (sweepList.length === 0) {
      addToast?.("No purchasable listings found.", "error");
      return;
    }

    setSweeping(true);
    setProgress(0);
    addToast?.(`Sweeping ${sweepList.length} ${collection.name}...`, "info");

    let bought = 0;
    for (let i = 0; i < sweepList.length; i++) {
      setProgress(i + 1);
      const nft = sweepList[i];
      const result = nft.isNative && nft.nativeOrder
        ? await fulfillNativeOrder(nft.nativeOrder)
        : await fulfillSeaportOrder(nft);

      if (result.success) {
        bought++;
        recordTransaction({ type: "buy", nft, price: nft.price, hash: result.hash, wallet, slug: collection.slug });
      } else if (result.error === "rejected") {
        addToast?.(`Sweep stopped — cancelled at #${i + 1}`, "info");
        break;
      } else if (result.error === "insufficient") {
        addToast?.(`Insufficient ETH — bought ${bought}/${sweepList.length}`, "error");
        break;
      } else {
        addToast?.(`Failed to purchase item ${i + 1}. Please try again.`, "error");
        break;
      }
    }

    if (bought > 0) {
      addToast?.(`Swept ${bought} ${collection.name}!`, "success");
    }
    setSweeping(false);
    setProgress(0);
  }, [wallet, onConnect, isWrongNetwork, filteredListings, effectiveCount, addToast, collection.name, collection.slug]);

  const collectionLabel = collection.name || "NFTs";
  const parsedMaxPrice = parseFloat(maxPriceGuard);
  const maxPriceNum = !isNaN(parsedMaxPrice) && parsedMaxPrice > 0 ? parsedMaxPrice : null;

  return (
    <div className="sweep-calculator">
      <div className="sweep-title">SWEEP {collectionLabel.toUpperCase()}</div>

      {/* === DUAL MODE TOGGLE === */}
      <div className="sweep-mode-toggle">
        <button
          className={`sweep-mode-btn ${mode === "quantity" ? "active" : ""}`}
          onClick={() => setMode("quantity")}
          disabled={sweeping}
        >
          BY QTY
        </button>
        <button
          className={`sweep-mode-btn ${mode === "budget" ? "active" : ""}`}
          onClick={() => setMode("budget")}
          disabled={sweeping}
        >
          BY BUDGET
        </button>
      </div>

      {/* === TRAIT FILTERS === */}
      {availableTraits.length > 0 && (
        <div className="sweep-filters">
          <div className="sweep-section-label">TRAIT FILTER</div>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <select
              className="sweep-select"
              value={traitCategory}
              onChange={e => setTraitCategory(e.target.value)}
              disabled={sweeping}
            >
              <option value="">All traits</option>
              {availableTraits.map(t => (
                <option key={t.key} value={t.key}>{t.key}</option>
              ))}
            </select>
            {traitCategory && (
              <select
                className="sweep-select"
                value={traitValue}
                onChange={e => setTraitValue(e.target.value)}
                disabled={sweeping}
              >
                <option value="">Any value</option>
                {traitValues.map(v => (
                  <option key={v} value={v}>{v}</option>
                ))}
              </select>
            )}
          </div>
          {traitCategory && traitValue && (
            <div className="sweep-micro-label" style={{ marginTop: 4 }}>
              {filteredListings.length} matching listing{filteredListings.length !== 1 ? "s" : ""}
            </div>
          )}
        </div>
      )}

      {/* === MAX PRICE GUARD === */}
      <div className="sweep-filters" style={{ marginTop: 8 }}>
        <div className="sweep-section-label">MAX PRICE PER ITEM</div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          <Eth size={12} />
          <input
            type="number"
            className="sweep-input"
            placeholder="No limit"
            value={maxPriceGuard}
            onChange={e => setMaxPriceGuard(e.target.value)}
            disabled={sweeping}
            min="0"
            step="0.01"
          />
          {maxPriceNum && (
            <button
              className="sweep-clear-btn"
              onClick={() => setMaxPriceGuard("")}
              title="Clear max price"
            >
              x
            </button>
          )}
        </div>
      </div>

      {/* === MODE-SPECIFIC INPUT === */}
      {mode === "quantity" ? (
        <>
          <div className="sweep-count">{effectiveCount}</div>
          <div className="sweep-micro-label" style={{ textAlign: "center", marginBottom: 4 }}>
            {collectionLabel} to sweep
          </div>
          <input
            type="range"
            min="1"
            max={Math.min(filteredListings.length || 30, 30)}
            value={Math.min(count, filteredListings.length || 30)}
            onChange={(e) => setCount(Number(e.target.value))}
            className="sweep-slider"
            disabled={sweeping}
          />
        </>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "12px 0 4px" }}>
            <Eth size={14} />
            <input
              type="number"
              className="sweep-input sweep-input-lg"
              placeholder="ETH budget"
              value={budget}
              onChange={e => setBudget(e.target.value)}
              disabled={sweeping}
              min="0"
              step="0.1"
            />
          </div>
          <div className="sweep-count" style={{ fontSize: 22 }}>{effectiveCount}</div>
          <div className="sweep-micro-label" style={{ textAlign: "center", marginBottom: 4 }}>
            {collectionLabel} fit in budget
          </div>
        </>
      )}

      {/* === FLOOR DEPTH VISUALIZATION === */}
      {priceTiers.length > 1 && (
        <FloorDepthChart
          tiers={priceTiers}
          sweepUpToPrice={sweepUpToPrice}
          maxPriceGuard={maxPriceNum}
        />
      )}

      {/* === FLOOR IMPACT PREVIEW === */}
      {floorImpact && effectiveCount > 0 && (
        <div className="sweep-floor-impact">
          <div className="sweep-section-label">FLOOR IMPACT</div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text)", marginTop: 4 }}>
            <Eth size={11} /> {floorImpact.currentFloor.toFixed(4)}
            <span style={{ color: "var(--text-dim)", margin: "0 6px" }}>{"\u2192"}</span>
            <span style={{ color: floorImpact.pctChange > 0 ? "var(--green, #4ade80)" : "var(--text)" }}>
              <Eth size={11} /> {floorImpact.newFloor.toFixed(4)}
            </span>
            {floorImpact.pctChange > 0 && (
              <span style={{ color: "var(--green, #4ade80)", fontSize: 10, marginLeft: 4 }}>
                (+{floorImpact.pctChange.toFixed(1)}%)
              </span>
            )}
          </div>
        </div>
      )}

      {/* === SWEEP BREAKDOWN === */}
      <div className="sweep-breakdown">
        <div className="sweep-stat">
          <div className="sweep-stat-label">
            {hasListings ? "CHEAPEST" : "FLOOR PRICE"}
            {filteredListings[0]?.marketplace && (
              <span style={{ marginLeft: 4 }}>
                <MarketplaceBadge marketplace={filteredListings[0].marketplace} />
              </span>
            )}
          </div>
          <div className="sweep-stat-value" style={{ color: "var(--gold)" }}>
            {filteredListings.length > 0 && filteredListings[0]?.price != null
              ? <><Eth size={12} /> {Number(filteredListings[0].price).toFixed(4)}</>
              : floor != null ? <><Eth size={12} /> {Number(floor).toFixed(4)}</> : "\u2014"}
          </div>
        </div>
        {filteredListings.length > 0 && sweepData.maxPrice != null && effectiveCount > 1 && (
          <div className="sweep-stat">
            <div className="sweep-stat-label">
              MOST EXPENSIVE
              {filteredListings[effectiveCount - 1]?.marketplace && (
                <span style={{ marginLeft: 4 }}>
                  <MarketplaceBadge marketplace={filteredListings[effectiveCount - 1].marketplace} />
                </span>
              )}
            </div>
            <div className="sweep-stat-value" style={{ color: "var(--text)" }}>
              <Eth size={12} /> {Number(sweepData.maxPrice).toFixed(4)}
            </div>
          </div>
        )}
        <div className="sweep-stat">
          <div className="sweep-stat-label">QUANTITY</div>
          <div className="sweep-stat-value" style={{ color: "var(--text)" }}>
            {effectiveCount} {collectionLabel}
          </div>
        </div>
        <div className="sweep-stat">
          <div className="sweep-stat-label">TOTAL ETH</div>
          <div className="sweep-stat-value" style={{ color: "var(--naka-blue)" }}>
            {sweepData.totalEth != null ? <><Eth size={12} /> {sweepData.totalEth.toFixed(4)}</> : "\u2014"}
          </div>
        </div>
        <div className="sweep-stat">
          <div className="sweep-stat-label">EST. GAS</div>
          <div className="sweep-stat-value" style={{ color: "var(--text-dim)", fontSize: 11 }}>
            ~{sweepData.gasEst.toFixed(4)} ETH
          </div>
        </div>
        <div className="sweep-stat">
          <div className="sweep-stat-label">DATA SOURCE</div>
          <div className="sweep-stat-value" style={{ color: "var(--green)", fontSize: 11 }}>
            {sweepData.source || "Unavailable"}
          </div>
        </div>
      </div>

      {/* Gas estimate is shown in the breakdown above */}

      {/* === SWEEP ITEMS PREVIEW (first 5 with marketplace badges) === */}
      {filteredListings.length > 0 && effectiveCount > 0 && (
        <div className="sweep-items-preview">
          <div className="sweep-section-label">SWEEP QUEUE</div>
          <div style={{ marginTop: 4 }}>
            {filteredListings.slice(0, Math.min(effectiveCount, 5)).map((item, i) => (
              <div key={item.id} className="sweep-queue-item">
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", minWidth: 20 }}>
                  {i + 1}.
                </span>
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  #{item.id}
                </span>
                <MarketplaceBadge marketplace={item.marketplace} />
                <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--gold)", display: "flex", alignItems: "center", gap: 2 }}>
                  <Eth size={9} /> {Number(item.price).toFixed(4)}
                </span>
              </div>
            ))}
            {effectiveCount > 5 && (
              <div className="sweep-micro-label" style={{ marginTop: 2, textAlign: "center" }}>
                +{effectiveCount - 5} more
              </div>
            )}
          </div>
        </div>
      )}

      {filteredListings.length === 0 && hasListings && (traitCategory || maxPriceNum) && (
        <div className="sweep-micro-label" style={{ textAlign: "center", margin: "8px 0", color: "var(--red, #f87171)" }}>
          No listings match your filters
        </div>
      )}

      {!hasListings && (
        <div className="sweep-micro-label" style={{ textAlign: "center", margin: "8px 0" }}>
          No listings available — prices are floor estimates
        </div>
      )}

      <button
        className="btn-primary"
        style={{ display: "block", width: "100%", textAlign: "center", marginTop: 18, fontSize: 12 }}
        disabled={sweeping || (!hasListings && !wallet) || effectiveCount === 0}
        onClick={handleSweep}
      >
        {sweeping
          ? `Sweeping ${progress}/${effectiveCount}...`
          : !wallet
            ? `Connect & Sweep ${effectiveCount} ${collectionLabel}`
            : filteredListings.length === 0
              ? "No listings to sweep"
              : `Sweep ${effectiveCount} ${collectionLabel} for ${sweepData.totalEth?.toFixed(4) || "?"} ETH`}
      </button>
    </div>
  );
}
