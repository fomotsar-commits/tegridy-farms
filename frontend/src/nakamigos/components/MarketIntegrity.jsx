import { useState, useEffect, useCallback, useMemo } from "react";
import { Eth } from "./Icons";
import { fetchActivity, fetchListings } from "../api";
import { computeMarketIntegrity, fetchCollectionOwners } from "../lib/marketIntegrity";
import { useActiveCollection } from "../contexts/CollectionContext";

// ── Descriptive band → label + color (shared by ownership + floor) ──
const BAND_META = {
  "well-distributed": { label: "Well distributed", color: "var(--green)" },
  mixed: { label: "Mixed", color: "var(--yellow)" },
  concentrated: { label: "Concentrated", color: "var(--red)" },
};
const CONFIDENCE_COLOR = { high: "var(--green)", medium: "var(--yellow)", low: "var(--red)" };

const WINDOW_DAYS = 30;
const FLOOR_DEPTH = 100;

function pct(x, digits = 1) {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}
function num(x, digits = 0) {
  if (x == null || !Number.isFinite(x)) return "—";
  return x.toLocaleString(undefined, { maximumFractionDigits: digits });
}
function shortAddr(a) {
  if (typeof a !== "string" || a.length < 10) return a || "—";
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function Chip({ color, children }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        borderRadius: 999,
        fontFamily: "var(--mono)",
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: "0.04em",
        color,
        background: "color-mix(in srgb, currentColor 12%, transparent)",
        border: "1px solid color-mix(in srgb, currentColor 35%, transparent)",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {children}
    </span>
  );
}

function StatTile({ label, value, sub, color }) {
  return (
    <div
      style={{
        padding: "12px 14px",
        borderRadius: 12,
        background: "var(--surface-glass)",
        border: "1px solid var(--border)",
      }}
    >
      <div style={{ fontFamily: "var(--mono)", fontSize: 8, letterSpacing: "0.08em", color: "var(--text-muted)", marginBottom: 6 }}>
        {label}
      </div>
      <div style={{ fontFamily: "var(--display)", fontSize: 20, fontWeight: 700, color: color || "var(--text)", lineHeight: 1.1 }}>
        {value}
      </div>
      {sub != null && (
        <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", marginTop: 4 }}>{sub}</div>
      )}
    </div>
  );
}

function Section({ title, subtitle, chip, children }) {
  return (
    <div className="analytics-panel" style={{ marginTop: 20 }}>
      <div className="analytics-panel-header" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0 }}>{title}</h3>
          {subtitle && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>{subtitle}</div>
          )}
        </div>
        {chip}
      </div>
      {children}
    </div>
  );
}

function SectionEmpty({ reason }) {
  return (
    <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
      <div className="empty-state-icon">{"🔎"}</div>
      <div className="empty-state-title">Not enough data to measure</div>
      <div className="empty-state-text">{reason || "No on-chain data available for this window."}</div>
    </div>
  );
}

function tileGrid(children) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginTop: 12 }}>
      {children}
    </div>
  );
}

// ── Ownership concentration (from the shared detection core) ──
function OwnershipPanel({ result, truncated }) {
  if (!result || !result.measured) {
    return (
      <Section title="Ownership concentration" subtitle="Who holds the collection — via the shared distribution core.">
        <SectionEmpty reason={result?.reason} />
      </Section>
    );
  }
  const a = result.analysis;
  const band = BAND_META[a.band] || BAND_META.mixed;
  const clustered = a.metrics.clusteredSupplyShareOfTotal;
  return (
    <Section
      title="Ownership concentration"
      subtitle="Effective-holder read over the owner set (LP/burn/contract wallets excluded)."
      chip={<Chip color={band.color}>{band.label}</Chip>}
    >
      <p style={{ fontFamily: "var(--display)", fontSize: 14, color: "var(--text)", lineHeight: 1.5, margin: "12px 0 0" }}>
        {a.headline}
      </p>
      {tileGrid(
        <>
          <StatTile label="EFFECTIVE HOLDERS" value={num(a.metrics.effectiveHolders, 0)} sub={`of ${num(a.holderCounts.included)} counted`} color="var(--naka-blue)" />
          <StatTile label="TOP 1 OF SUPPLY" value={pct(a.metrics.top1ShareOfTotal)} color="var(--yellow)" />
          <StatTile label="TOP 10 OF SUPPLY" value={pct(a.metrics.topN.top10)} color="var(--yellow)" />
          <StatTile label="NAKAMOTO COEFF." value={num(a.metrics.nakamotoCoefficient)} sub="wallets to cross 50%" />
          <StatTile label="COORD. CLUSTER" value={clustered == null ? "—" : pct(clustered)} sub={clustered == null ? "no cluster data" : "largest wash-linked group"} color={clustered ? "var(--red)" : undefined} />
          <StatTile label="GINI (2ndary)" value={num(a.metrics.gini, 2)} sub="address ≠ person" />
        </>
      )}

      {/* Exclusions — show what was removed before the math */}
      {a.exclusions.buckets.some((b) => b.excluded) && (
        <div style={{ marginTop: 12, fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
          Excluded before counting:{" "}
          {a.exclusions.buckets
            .filter((b) => b.excluded && b.count > 0)
            .map((b) => `${b.category} (${b.count}, ${pct(b.shareOfTotal)})`)
            .join(" · ") || "none"}
        </div>
      )}
      {a.holderCounts.unclassified > 0 && (
        <div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)" }}>
          {a.holderCounts.unclassified} large wallet(s) are unlabeled ({pct(a.exclusions.unclassifiedShareOfTotal)} of supply) — counted, but they lower confidence rather than being assumed hostile.
        </div>
      )}

      {/* Coordinated-cluster wallets, if any (clickable to profile) */}
      {clustered != null && clustered > 0 && (
        <div style={{ marginTop: 10, fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
          Coordinated wallets are those linked by reciprocal trading in the sales window (see Wash-trade signals below).
        </div>
      )}

      {/* Confidence + caveats */}
      <div style={{ marginTop: 14, padding: 12, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.08em" }}>DATA CONFIDENCE</span>
          <Chip color={CONFIDENCE_COLOR[a.confidence.level]}>{a.confidence.level.toUpperCase()}</Chip>
        </div>
        <ul style={{ margin: 0, paddingLeft: 16, fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", lineHeight: 1.6 }}>
          {a.confidence.reasons.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
          {truncated && <li>Owner list was paginated to a cap — a very large collection may be partially sampled.</li>}
        </ul>
      </div>
      <div style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", lineHeight: 1.6 }}>
        {a.caveats.map((c, i) => (
          <div key={i}>• {c}</div>
        ))}
      </div>
    </Section>
  );
}

// ── Wash-trade / self-dealing signals ──
function WashPanel({ result, onViewProfile }) {
  if (!result || !result.measured) {
    return (
      <Section title="Wash-trade signals" subtitle={`Self-dealing over sales in the last ${WINDOW_DAYS} days.`}>
        <SectionEmpty reason={result?.reason} />
      </Section>
    );
  }
  const suspectColor = result.suspect.shareOfVolume >= 0.15 ? "var(--red)" : result.suspect.shareOfVolume > 0 ? "var(--yellow)" : "var(--green)";
  return (
    <Section
      title="Wash-trade signals"
      subtitle={`${result.comparableSales} comparable sales (of ${result.totalSales}) in the last ${WINDOW_DAYS} days.`}
      chip={<Chip color={suspectColor}>{pct(result.suspect.shareOfVolume, 0)} suspect volume</Chip>}
    >
      {tileGrid(
        <>
          <StatTile label="SAME-WALLET SALES" value={num(result.selfSales.count)} sub={`${pct(result.selfSales.shareOfSales)} of sales`} color={result.selfSales.count ? "var(--red)" : undefined} />
          <StatTile label="COORD. CLUSTERS" value={num(result.coordinatedClusters.count)} sub={result.coordinatedClusters.count ? `${result.coordinatedClusters.internalSales} internal sales` : "none detected"} color={result.coordinatedClusters.count ? "var(--yellow)" : undefined} />
          <StatTile label="ROUND-TRIP TOKENS" value={num(result.roundTripTokens)} sub="returned to a prior owner" />
          <StatTile label="RAPID RE-TRADES" value={num(result.rapidRetradeTokens)} sub="tokens sold 3+ times" />
          <StatTile label="SUSPECT VOLUME" value={<><Eth size={14} />{num(result.suspect.volumeEth, 3)}</>} sub={`of ${num(result.totalVolumeEth, 3)} total`} color={suspectColor} />
          <StatTile label="SUSPECT SALES" value={num(result.suspect.sales)} sub={`${pct(result.suspect.shareOfSales)} of sales`} color={suspectColor} />
        </>
      )}

      {result.coordinatedClusters.clusters.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 8 }}>
            COORDINATED WALLET GROUPS (reciprocal trading in window)
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {result.coordinatedClusters.clusters.slice(0, 6).map((c, i) => (
              <div key={i} style={{ padding: 10, borderRadius: 10, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
                <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginBottom: 6 }}>
                  {c.size} wallets · {c.saleCount} internal sales · <Eth size={9} />{num(c.volumeEth, 3)}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {c.wallets.map((w) => (
                    <button
                      key={w}
                      onClick={() => onViewProfile && onViewProfile(w)}
                      title={w}
                      style={{
                        fontFamily: "var(--mono)", fontSize: 10, padding: "2px 8px", borderRadius: 6,
                        border: "1px solid var(--border)", background: "var(--surface-glass)",
                        color: onViewProfile ? "var(--naka-blue)" : "var(--text-dim)",
                        cursor: onViewProfile ? "pointer" : "default",
                      }}
                    >
                      {shortAddr(w)}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop: 12, fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", lineHeight: 1.6 }}>
        <div>• "Suspect" = same-wallet sales plus sales inside a reciprocal wallet group. It excludes ordinary one-off trades and round-trips (shown separately as context).</div>
        <div>• A wallet appearing here is a description of an on-chain trading pattern, not proof of intent — groups can also be one person tidying their own inventory.</div>
      </div>
    </Section>
  );
}

// ── Floor concentration ──
function FloorPanel({ result }) {
  if (!result || !result.measured) {
    return (
      <Section title="Floor concentration" subtitle="How few wallets supply the cheapest listings.">
        <SectionEmpty reason={result?.reason} />
      </Section>
    );
  }
  const band = BAND_META[result.band] || BAND_META.mixed;
  return (
    <Section
      title="Floor concentration"
      subtitle={`Bottom ${result.depth} of the active listings.`}
      chip={<Chip color={band.color}>{band.label}</Chip>}
    >
      {tileGrid(
        <>
          <StatTile label="FLOOR PRICE" value={<><Eth size={14} />{num(result.floorPriceEth, 4)}</>} color="var(--gold)" />
          <StatTile label="DISTINCT SELLERS" value={num(result.distinctSellers)} sub={`across ${num(result.attributedListings)} listings`} />
          <StatTile label="EFFECTIVE SELLERS" value={num(result.effectiveSellers, 1)} sub="inverse-Simpson" color="var(--naka-blue)" />
          <StatTile label="TOP SELLER SHARE" value={pct(result.topSellerShare)} sub="of floor listings" color={result.topSellerShare >= 0.5 ? "var(--red)" : "var(--yellow)"} />
          <StatTile label="TOP 3 SELLERS" value={pct(result.top3SellerShare)} sub="of floor listings" />
          {result.largestWall && (
            <StatTile
              label="LARGEST PRICE WALL"
              value={<><Eth size={14} />{num(result.largestWall.price, 4)}</>}
              sub={`${result.largestWall.count} listings · ${result.largestWall.sellers} seller(s)`}
              color="var(--red)"
            />
          )}
        </>
      )}
      <div style={{ marginTop: 10, fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)" }}>
        {result.bandReason}
        {result.unattributedListings > 0 && (
          <> {" · "}{result.unattributedListings} listing(s) had no readable seller and were left out of the seller count.</>
        )}
      </div>
    </Section>
  );
}

export default function MarketIntegrity({ stats, addToast, onViewProfile }) {
  const collection = useActiveCollection();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [meta, setMeta] = useState({ truncated: false, salesUnavailable: false, ownersUnavailable: false });
  const [nonce, setNonce] = useState(0);

  const totalSupply = stats?.supply ?? collection.supply;

  const load = useCallback(
    (signal) => {
      setLoading(true);
      setError(null);

      const salesP = fetchActivity({ contract: collection.contract, limit: 100, daysBack: WINDOW_DAYS, signal })
        .then((res) => (res && res.fallback ? { activities: [], fallback: true } : res))
        .catch(() => ({ activities: [], _err: true }));

      const listingsP = fetchListings(collection.slug, {
        openseaSlug: collection.openseaSlug,
        contract: collection.contract,
        signal,
      }).catch(() => ({ listings: [] }));

      const ownersP = fetchCollectionOwners({ contract: collection.contract, signal })
        .then((res) => ({ ...res, _ok: true }))
        .catch(() => ({ owners: [], totalOwners: 0, truncated: false, _ok: false }));

      Promise.all([salesP, listingsP, ownersP])
        .then(([salesRes, listingsRes, ownersRes]) => {
          if (signal?.aborted) return;
          const sales = (salesRes.activities || []).filter((a) => a.type === "sale");
          const listings = listingsRes.listings || [];
          const owners = ownersRes.owners || [];
          const result = computeMarketIntegrity({
            sales,
            listings,
            owners,
            totalSupply,
            floorDepth: FLOOR_DEPTH,
          });
          setData(result);
          setMeta({
            truncated: !!ownersRes.truncated,
            salesUnavailable: !!(salesRes.fallback || salesRes._err),
            ownersUnavailable: ownersRes._ok === false,
          });
        })
        .catch((err) => {
          if (signal?.aborted) return;
          setError(err?.message || "Could not load market-integrity data.");
        })
        .finally(() => {
          if (!signal?.aborted) setLoading(false);
        });
    },
    [collection.contract, collection.slug, collection.openseaSlug, totalSupply],
  );

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load, nonce]);

  const remeasure = useCallback(() => {
    setNonce((n) => n + 1);
    if (addToast) addToast("Re-measuring market integrity…", "info");
  }, [addToast]);

  const observedLabel = useMemo(() => {
    if (!data?.observedAt) return null;
    try {
      return new Date(data.observedAt * 1000).toLocaleString();
    } catch {
      return null;
    }
  }, [data]);

  return (
    <div style={{ maxWidth: 1040, margin: "0 auto", padding: "8px 4px 40px" }}>
      {/* Intro / honest-framing banner */}
      <div style={{ marginTop: 8 }}>
        <h2 style={{ fontFamily: "var(--display)", fontSize: 24, fontWeight: 800, margin: 0, color: "var(--text)" }}>
          Market Integrity
        </h2>
        <p style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", lineHeight: 1.6, marginTop: 8, maxWidth: 720 }}>
          A descriptive, point-in-time measurement of on-chain manipulation signals for {collection.name}:
          self-dealing / wash trades, floor concentration, and coordinated ownership. It reports what the
          chain shows with the method and exclusions disclosed — it is <strong>not an accusation</strong> and
          not financial advice.
        </p>
      </div>

      {/* Method + confidence header row */}
      {data && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginTop: 12 }}>
          <Chip color={CONFIDENCE_COLOR[data.dataConfidence.level]}>DATA {data.dataConfidence.level.toUpperCase()}</Chip>
          <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>{data.method.version}</span>
          {observedLabel && (
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>measured {observedLabel}</span>
          )}
          <button
            onClick={remeasure}
            disabled={loading}
            style={{
              marginLeft: "auto", fontFamily: "var(--mono)", fontSize: 10, padding: "4px 12px", borderRadius: 8,
              border: "1px solid var(--border)", background: "var(--surface-glass)", color: "var(--text)",
              cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1,
            }}
          >
            {loading ? "Measuring…" : "Re-measure"}
          </button>
        </div>
      )}
      {data && data.dataConfidence.gaps.length > 0 && (
        <div style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)" }}>
          Coverage gaps: {data.dataConfidence.gaps.join(" · ")}
        </div>
      )}
      {data && (meta.salesUnavailable || meta.ownersUnavailable) && (
        <div style={{ marginTop: 6, fontFamily: "var(--mono)", fontSize: 9, color: "var(--yellow)" }}>
          {meta.salesUnavailable && "Live sales feed was unavailable (no synthetic data substituted). "}
          {meta.ownersUnavailable && "Owner set could not be read this cycle."}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 20 }}>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 160, borderRadius: 14, animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      )}

      {/* Hard error (all feeds failed at the orchestration level) */}
      {error && !data && (
        <div className="empty-state" style={{ marginTop: 20, borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
          <div className="empty-state-icon">{"⚠️"}</div>
          <div className="empty-state-title">Could not measure right now</div>
          <div className="empty-state-text">{error}</div>
          <button onClick={remeasure} style={{ marginTop: 12, fontFamily: "var(--mono)", fontSize: 11, padding: "6px 16px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--surface-glass)", color: "var(--text)", cursor: "pointer" }}>
            Try again
          </button>
        </div>
      )}

      {/* Results */}
      {data && (
        <>
          <OwnershipPanel result={data.ownership} truncated={meta.truncated} />
          <WashPanel result={data.wash} onViewProfile={onViewProfile} />
          <FloorPanel result={data.floor} />

          <div style={{ marginTop: 18, padding: 14, borderRadius: 12, background: "rgba(255,255,255,0.02)", border: "1px solid var(--border)" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-muted)", letterSpacing: "0.08em", marginBottom: 6 }}>METHOD & CORRECTION</div>
            <p style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", lineHeight: 1.7, margin: 0 }}>
              {data.method.description}
            </p>
            <p style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", lineHeight: 1.7, marginTop: 8 }}>
              {data.correctionPath}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
