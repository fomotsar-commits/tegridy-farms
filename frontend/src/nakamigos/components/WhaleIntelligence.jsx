import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Eth } from "./Icons";
import { formatPrice } from "../lib/formatPrice";
import { fetchTopHolders, fetchActivity, fetchWalletNfts, shortenAddress } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";

// SUPPLY is now dynamic per collection — passed via stats or fetched from context
const REFRESH_MS = 30000;

const MEDAL_COLORS = ["#ffd700", "#c0c0c0", "#cd7f32"];

function formatTimeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

/* ── Section skeleton ── */
function SectionSkeleton({ rows = 6, height = 48 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="skeleton"
          style={{
            height,
            borderRadius: 12,
            animationDelay: `${i * 80}ms`,
          }}
        />
      ))}
    </div>
  );
}

/* ── Pulsing live badge ── */
function LiveBadge() {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        fontFamily: "var(--mono)",
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: "0.1em",
        color: "var(--green)",
        background: "rgba(74, 222, 128, 0.06)",
        border: "1px solid rgba(74, 222, 128, 0.15)",
        borderRadius: 6,
        padding: "3px 8px",
      }}
    >
      <span
        className="live-dot"
        style={{ width: 5, height: 5 }}
      />
      LIVE
    </span>
  );
}

/* ── Section heading ── */
function SectionHeading({ title, live, children }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        marginBottom: 20,
      }}
    >
      <h3
        style={{
          fontFamily: "var(--serif)",
          fontSize: 22,
          fontWeight: 600,
          color: "var(--text)",
          margin: 0,
        }}
      >
        {title}
      </h3>
      {live && <LiveBadge />}
      {children}
    </div>
  );
}

/* ── Horizontal concentration bar ── */
function ConcentrationBar({ label, percent, color = "var(--gold)" }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 5,
        }}
      >
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 11,
            color: "var(--text-dim)",
            letterSpacing: "0.04em",
          }}
        >
          {label}
        </span>
        <span
          style={{
            fontFamily: "var(--mono)",
            fontSize: 12,
            fontWeight: 700,
            color,
          }}
        >
          {percent.toFixed(1)}%
        </span>
      </div>
      <div
        style={{
          height: 8,
          borderRadius: 4,
          background: "var(--border)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${Math.min(percent, 100)}%`,
            height: "100%",
            borderRadius: 4,
            background: `linear-gradient(90deg, ${color}, ${color}88)`,
            transition: "width 0.6s ease",
          }}
        />
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   MAIN COMPONENT
   ══════════════════════════════════════════ */
export default function WhaleIntelligence({ onViewProfile, stats } = {}) {
  const collection = useActiveCollection();
  /* ── State ── */
  const [holders, setHolders] = useState([]);
  const [activities, setActivities] = useState([]);
  const [loadingHolders, setLoadingHolders] = useState(true);
  const [loadingActivity, setLoadingActivity] = useState(true);
  const [holdersLive, setHoldersLive] = useState(false);
  const [activityLive, setActivityLive] = useState(false);
  const [expandedHolder, setExpandedHolder] = useState(null);
  // Prefer live API supply (stats.supply from getContractMetadata.totalSupply),
  // fall back to collection config supply, then 20000 as last resort
  const SUPPLY = stats?.supply || collection.supply || 20000;
  const [totalOwners, setTotalOwners] = useState(0);
  const [apiTotalHeld, setApiTotalHeld] = useState(0);
  const [expandedNfts, setExpandedNfts] = useState([]);
  const [loadingNfts, setLoadingNfts] = useState(false);
  const [error, setError] = useState(null);

  const mountedRef = useRef(true);

  /* ── Data fetching ── */
  const loadHolders = useCallback(async () => {
    try {
      const data = await fetchTopHolders({ contract: collection.contract, limit: 25 });
      if (!mountedRef.current) return;
      setHolders(data.holders || []);
      setTotalOwners(data.totalOwners || 0);
      setApiTotalHeld(data.totalHeld || 0);
      setHoldersLive(!data.fallback);
    } catch (err) {
      console.warn("WhaleIntelligence: fetchTopHolders error:", err.message);
      if (mountedRef.current) setError("Could not load top holders. Please check your connection and try again.");
    } finally {
      if (mountedRef.current) setLoadingHolders(false);
    }
  }, [collection.contract]);

  const loadActivity = useCallback(async () => {
    try {
      const data = await fetchActivity({ contract: collection.contract, limit: 50 });
      if (!mountedRef.current) return;
      setActivities(data.activities || []);
      setActivityLive(!data.fallback);
    } catch (err) {
      console.warn("WhaleIntelligence: fetchActivity error:", err.message);
      if (mountedRef.current) setError("Could not load activity feed. Please check your connection and try again.");
    } finally {
      if (mountedRef.current) setLoadingActivity(false);
    }
  }, [collection.contract]);

  // Reset state when collection changes to avoid stale data from previous collection
  useEffect(() => {
    setHolders([]);
    setActivities([]);
    setTotalOwners(0);
    setApiTotalHeld(0);
    setLoadingHolders(true);
    setLoadingActivity(true);
    setHoldersLive(false);
    setActivityLive(false);
    setExpandedHolder(null);
    setExpandedNfts([]);
    setError(null);
  }, [collection.contract]);

  useEffect(() => {
    mountedRef.current = true;
    loadHolders();
    loadActivity();
    const iv = setInterval(() => {
      loadHolders();
      loadActivity();
    }, REFRESH_MS);
    return () => {
      mountedRef.current = false;
      clearInterval(iv);
    };
  }, [loadHolders, loadActivity]);

  /* ── Expand holder to see their NFTs ── */
  const toggleHolder = useCallback(
    async (address) => {
      if (expandedHolder === address) {
        setExpandedHolder(null);
        setExpandedNfts([]);
        return;
      }
      setExpandedHolder(address);
      setExpandedNfts([]);
      setLoadingNfts(true);
      const data = await fetchWalletNfts(address, collection.contract, collection.metadataBase);
      if (!mountedRef.current) return;
      setExpandedNfts(data.tokens || []);
      setLoadingNfts(false);
    },
    [expandedHolder, collection.contract]
  );

  /* ── Derived: holder address set (full addresses) for cross-ref ── */
  const holderAddressSet = useMemo(() => {
    const set = new Set();
    for (const h of holders) {
      if (h.address) {
        set.add(h.address.toLowerCase());
        // Also store shortened version for matching activity from/to
        set.add(shortenAddress(h.address).toLowerCase());
      }
    }
    return set;
  }, [holders]);

  /* ── Whale transactions: activities involving a top-25 holder ── */
  const whaleTransactions = useMemo(() => {
    if (!holders.length || !activities.length) return [];
    return activities.filter((a) => {
      // Use full addresses for matching when available, fall back to shortened
      const from = (a.fromFull || a.from || "").toLowerCase();
      const to = (a.toFull || a.to || "").toLowerCase();
      return holderAddressSet.has(from) || holderAddressSet.has(to);
    });
  }, [activities, holders, holderAddressSet]);

  /* ── Accumulation trend ── */
  const trend = useMemo(() => {
    if (!whaleTransactions.length) return null;
    let buys = 0;
    let sells = 0;
    for (const tx of whaleTransactions) {
      const to = (tx.toFull || tx.to || "").toLowerCase();
      const from = (tx.fromFull || tx.from || "").toLowerCase();
      if (holderAddressSet.has(to)) buys++;
      if (holderAddressSet.has(from)) sells++;
    }
    return {
      buys,
      sells,
      net: buys - sells,
      label: buys >= sells ? "ACCUMULATING" : "DISTRIBUTING",
      color: buys >= sells ? "var(--green)" : "var(--red)",
    };
  }, [whaleTransactions, holderAddressSet]);

  /* ── Holder distribution stats ── */
  const distribution = useMemo(() => {
    if (!holders.length) return null;
    const totalHeld = holders.reduce((s, h) => s + h.count, 0);
    const top10 = holders.slice(0, 10).reduce((s, h) => s + h.count, 0);
    const top25 = holders.slice(0, 25).reduce((s, h) => s + h.count, 0);
    // Top 100 estimation: we only have top 25, so extrapolate or show what we have
    return {
      top10Pct: (top10 / SUPPLY) * 100,
      top25Pct: (top25 / SUPPLY) * 100,
      totalHeld,
    };
  }, [holders, SUPPLY]);

  /* ── Max count for bar width ── */
  const maxCount = useMemo(
    () => (holders.length ? holders[0].count : 1),
    [holders]
  );

  const isLive = holdersLive || activityLive;

  /* ── ENS resolution for top holders (with localStorage cache) ── */
  const ENS_MAX = 500;
  function pruneEnsCache(cache) {
    const entries = Object.entries(cache);
    if (entries.length <= ENS_MAX) return cache;
    return Object.fromEntries(entries.slice(-ENS_MAX));
  }
  const [ensMap, setEnsMap] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem("ens_cache") || "{}");
    } catch { return {}; }
  });
  const ensMapRef = useRef(ensMap);
  useEffect(() => { ensMapRef.current = ensMap; }, [ensMap]);

  useEffect(() => {
    if (holders.length === 0) return;
    let mounted = true;

    async function resolveAll() {
      try {
        // Collect addresses from top holders AND whale transaction participants
        const addressSet = new Set();
        for (const h of holders.slice(0, 15)) {
          if (h.address) addressSet.add(h.address);
        }
        // Also resolve addresses appearing in whale transactions
        for (const tx of whaleTransactions.slice(0, 15)) {
          if (tx.fromFull) addressSet.add(tx.fromFull);
          if (tx.toFull) addressSet.add(tx.toFull);
        }
        const toResolve = [...addressSet].map(a => ({ address: a }));
        // Only resolve addresses not already cached — read from ref to avoid stale closure
        const uncached = toResolve.filter((h) => {
          const v = ensMapRef.current[h.address?.toLowerCase()];
          if (!v) return true;
          // Handle both string and {name, ts} cache formats
          const name = typeof v === "string" ? v : v?.name;
          return !name;
        });
        if (uncached.length === 0) return;

        const { ethers } = await import("ethers");
        const provider = new ethers.JsonRpcProvider("https://eth.llamarpc.com");

        // Process in batches of 3 to avoid rate limiting
        const BATCH_SIZE = 3;
        const ENS_TIMEOUT = 5000;

        for (let i = 0; i < uncached.length; i += BATCH_SIZE) {
          if (!mounted) return;
          const batch = uncached.slice(i, i + BATCH_SIZE);

          const results = await Promise.allSettled(
            batch.map(async (h) => {
              // Race each lookup against a 5-second timeout
              const lookupPromise = provider.lookupAddress(h.address);
              const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("ENS lookup timeout")), ENS_TIMEOUT)
              );
              const name = await Promise.race([lookupPromise, timeoutPromise]);
              return { address: h.address, name };
            })
          );
          if (!mounted) return;

          const updated = { ...ensMapRef.current };
          let changed = false;
          for (const r of results) {
            if (r.status === "fulfilled" && r.value.name) {
              updated[r.value.address.toLowerCase()] = r.value.name;
              changed = true;
            }
          }
          if (changed) {
            const pruned = pruneEnsCache(updated);
            ensMapRef.current = pruned;
            setEnsMap(pruned);
            try {
              localStorage.setItem("ens_cache", JSON.stringify(pruned));
            } catch { /* quota exceeded — non-critical */ }
          }
        }
      } catch (_) {
        /* ENS resolution is best-effort */
      }
    }
    resolveAll();
    return () => { mounted = false; };
  }, [holders, whaleTransactions]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Helper: get display name for an address (ENS or shortened) ── */
  const getDisplayName = useCallback((fullAddress, shortAddress) => {
    if (!fullAddress) return shortAddress || "?";
    const v = ensMap[fullAddress.toLowerCase()];
    const ensName = typeof v === "string" ? v : v?.name;
    return ensName || shortAddress || shortenAddress(fullAddress);
  }, [ensMap]);

  /* ══ STYLES ══ */
  const panelStyle = {
    background: "var(--surface-glass)",
    border: "1px solid var(--border)",
    borderRadius: 16,
    padding: "24px 28px",
    marginBottom: 24,
  };

  const alertCardStyle = {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "12px 16px",
    background: "rgba(200,170,100,0.04)",
    border: "1px solid rgba(200,170,100,0.1)",
    borderRadius: 12,
    marginBottom: 8,
    animation: "fadeIn 0.3s ease",
  };

  return (
    <section
      style={{
        maxWidth: 1200,
        margin: "0 auto",
        padding: "40px 20px",
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <h2
          style={{
            fontFamily: "var(--serif)",
            fontSize: 32,
            fontWeight: 600,
            color: "var(--text)",
            margin: 0,
          }}
        >
          Whale Intelligence
        </h2>
        {isLive && <LiveBadge />}
      </div>
      <div
        style={{
          width: 60,
          height: 2,
          background: "linear-gradient(90deg, #c8a850, transparent)",
          marginBottom: 32,
        }}
      />

      {/* ── Error banner ── */}
      {error && (
        <div className="error-banner" style={{ marginBottom: 16 }}>
          <span>{error}</span>
          <button onClick={() => { setError(null); loadHolders(); loadActivity(); }}>Retry</button>
        </div>
      )}

      {/* ── Layout grid ── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 24,
          alignItems: "start",
        }}
      >
        {/* ═══════ LEFT COLUMN ═══════ */}
        <div>
          {/* ── 1. TOP HOLDERS ── */}
          <div style={panelStyle}>
            <SectionHeading title="Top Holders" live={holdersLive}>
              {!loadingHolders && holders.length > 0 && (
                <span
                  style={{
                    marginLeft: "auto",
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    color: "var(--text-dim)",
                  }}
                >
                  Top {holders.length} / {SUPPLY.toLocaleString()}
                </span>
              )}
            </SectionHeading>
            {!loadingHolders && holders.length > 0 && (
              <div style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)",
                marginBottom: 14, marginTop: -12, letterSpacing: "0.03em",
              }}>
                Distribution of top {holders.length} holders (by holding size)
                {totalOwners > 0 && <> &middot; {totalOwners.toLocaleString()} unique owners</>}
              </div>
            )}

            {loadingHolders ? (
              <SectionSkeleton rows={10} height={52} />
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 6,
                }}
              >
                {holders.map((h, i) => {
                  const pct = (h.count / SUPPLY) * 100;
                  const isMedal = i < 3;
                  const medalColor = MEDAL_COLORS[i];
                  const isExpanded = expandedHolder === h.address;
                  const ensRaw = ensMap[h.address?.toLowerCase()];
                  const ensName = h.ens || (typeof ensRaw === "string" ? ensRaw : ensRaw?.name) || null;

                  return (
                    <div key={h.address || i}>
                      {/* Holder row */}
                      <div
                        onClick={() => toggleHolder(h.address)}
                        className="card-reveal"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          padding: "10px 14px",
                          borderRadius: 12,
                          background: isMedal
                            ? `linear-gradient(135deg, ${medalColor}08, transparent)`
                            : "var(--border)",
                          border: isMedal
                            ? `1px solid ${medalColor}20`
                            : "1px solid var(--border)",
                          cursor: "pointer",
                          transition: "background 0.2s",
                          animationDelay: `${i * 40}ms`,
                        }}
                      >
                        {/* Rank badge */}
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 11,
                            fontWeight: 700,
                            width: 28,
                            height: 28,
                            borderRadius: 8,
                            display: "grid",
                            placeItems: "center",
                            flexShrink: 0,
                            background: isMedal
                              ? `${medalColor}15`
                              : "var(--border)",
                            color: isMedal ? medalColor : "var(--text-dim)",
                            border: isMedal
                              ? `1px solid ${medalColor}25`
                              : "1px solid transparent",
                          }}
                        >
                          {i + 1}
                        </span>

                        {/* Address */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <a
                            href={/^0x[a-fA-F0-9]{40}$/.test(h.address) ? `https://etherscan.io/address/${h.address}` : "#"}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{
                              fontFamily: "var(--display)",
                              fontSize: 13,
                              fontWeight: 600,
                              color: isMedal ? medalColor : "var(--text)",
                              textDecoration: "none",
                            }}
                          >
                            {ensName || shortenAddress(h.address)}
                          </a>
                          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 1 }}>
                            {ensName && (
                              <span
                                style={{
                                  fontFamily: "var(--mono)",
                                  fontSize: 9,
                                  color: "var(--text-muted)",
                                }}
                              >
                                {shortenAddress(h.address)}
                              </span>
                            )}
                            {onViewProfile && (
                              <span
                                onClick={(e) => { e.stopPropagation(); onViewProfile(h.address); }}
                                style={{
                                  fontFamily: "var(--mono)",
                                  fontSize: 9,
                                  color: "var(--naka-blue)",
                                  cursor: "pointer",
                                  opacity: 0.8,
                                }}
                                title="View on-chain profile"
                              >
                                Profile
                              </span>
                            )}
                          </div>
                        </div>

                        {/* Count & percentage bar */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 10,
                            flexShrink: 0,
                          }}
                        >
                          <div
                            style={{
                              width: 80,
                              height: 6,
                              borderRadius: 3,
                              background: "var(--border)",
                              overflow: "hidden",
                            }}
                          >
                            <div
                              style={{
                                width: `${Math.max(
                                  (h.count / maxCount) * 100,
                                  2
                                )}%`,
                                height: "100%",
                                borderRadius: 3,
                                background: isMedal
                                  ? `linear-gradient(90deg, ${medalColor}, ${medalColor}88)`
                                  : "linear-gradient(90deg, #c8a850, #c8a85066)",
                                transition: "width 0.4s ease",
                              }}
                            />
                          </div>
                          <span
                            style={{
                              fontFamily: "var(--mono)",
                              fontSize: 12,
                              fontWeight: 700,
                              color: isMedal ? medalColor : "var(--gold)",
                              minWidth: 36,
                              textAlign: "right",
                            }}
                          >
                            {h.count}
                          </span>
                          <span
                            style={{
                              fontFamily: "var(--mono)",
                              fontSize: 9,
                              color: "var(--text-dim)",
                              minWidth: 40,
                              textAlign: "right",
                            }}
                          >
                            {pct.toFixed(2)}%
                          </span>
                        </div>

                        {/* Expand indicator */}
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 10,
                            color: "var(--text-muted)",
                            transition: "transform 0.2s",
                            transform: isExpanded
                              ? "rotate(90deg)"
                              : "rotate(0deg)",
                          }}
                        >
                          {"\u25B6"}
                        </span>
                      </div>

                      {/* Expanded: show wallet NFTs */}
                      {isExpanded && (
                        <div
                          style={{
                            padding: "12px 16px 12px 54px",
                            borderLeft: `2px solid ${
                              isMedal ? medalColor + "30" : "rgba(200,170,100,0.1)"
                            }`,
                            marginLeft: 14,
                            marginTop: 4,
                            marginBottom: 4,
                          }}
                        >
                          {loadingNfts ? (
                            <div
                              style={{
                                display: "flex",
                                gap: 8,
                                flexWrap: "wrap",
                              }}
                            >
                              {Array.from({ length: 6 }, (_, j) => (
                                <div
                                  key={j}
                                  className="skeleton"
                                  style={{
                                    width: 56,
                                    height: 56,
                                    borderRadius: 8,
                                  }}
                                />
                              ))}
                            </div>
                          ) : expandedNfts.length > 0 ? (
                            <>
                              <div
                                style={{
                                  fontFamily: "var(--mono)",
                                  fontSize: 9,
                                  color: "var(--text-dim)",
                                  marginBottom: 8,
                                  letterSpacing: "0.06em",
                                }}
                              >
                                {expandedNfts.length} {collection.name.toUpperCase()} HELD
                              </div>
                              <div
                                style={{
                                  display: "flex",
                                  gap: 6,
                                  flexWrap: "wrap",
                                  maxHeight: 180,
                                  overflowY: "auto",
                                }}
                              >
                                {expandedNfts.slice(0, 30).map((nft) => (
                                  <div
                                    key={nft.id}
                                    title={nft.name}
                                    style={{
                                      width: 52,
                                      height: 52,
                                      borderRadius: 8,
                                      overflow: "hidden",
                                      border:
                                        "1px solid rgba(200,170,100,0.1)",
                                    }}
                                  >
                                    <img
                                      src={nft.image}
                                      alt={nft.name}
                                      loading="lazy"
                                      style={{
                                        width: "100%",
                                        height: "100%",
                                        objectFit: "cover",
                                      }}
                                    />
                                  </div>
                                ))}
                                {expandedNfts.length > 30 && (
                                  <div
                                    style={{
                                      width: 52,
                                      height: 52,
                                      borderRadius: 8,
                                      background: "rgba(200,170,100,0.06)",
                                      border:
                                        "1px solid rgba(200,170,100,0.1)",
                                      display: "grid",
                                      placeItems: "center",
                                      fontFamily: "var(--mono)",
                                      fontSize: 10,
                                      color: "var(--text-dim)",
                                    }}
                                  >
                                    +{expandedNfts.length - 30}
                                  </div>
                                )}
                              </div>
                            </>
                          ) : (
                            <div
                              style={{
                                fontFamily: "var(--mono)",
                                fontSize: 10,
                                color: "var(--text-muted)",
                              }}
                            >
                              No {collection.name} held by this wallet.
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── 4. HOLDER DISTRIBUTION ── */}
          <div style={panelStyle}>
            <SectionHeading title="Holder Concentration" live={false} />
            {!loadingHolders && holders.length > 0 && (
              <div style={{
                fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)",
                marginBottom: 14, marginTop: -12, letterSpacing: "0.03em",
              }}>
                Based on top {holders.length} holders vs. {SUPPLY.toLocaleString()} total supply
              </div>
            )}

            {loadingHolders ? (
              <SectionSkeleton rows={3} height={40} />
            ) : distribution ? (
              <div>
                <ConcentrationBar
                  label="Top 10 Holders"
                  percent={distribution.top10Pct}
                  color="var(--gold)"
                />
                <ConcentrationBar
                  label="Top 25 Holders"
                  percent={distribution.top25Pct}
                  color="var(--purple)"
                />
                <div
                  style={{
                    marginTop: 16,
                    padding: "12px 16px",
                    borderRadius: 10,
                    background: "var(--border)",
                    border: "1px solid var(--border)",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <span
                    style={{
                      fontFamily: "var(--mono)",
                      fontSize: 10,
                      color: "var(--text-dim)",
                      letterSpacing: "0.06em",
                    }}
                  >
                    TOTAL HELD BY TOP 25
                  </span>
                  <span
                    style={{
                      fontFamily: "var(--display)",
                      fontSize: 18,
                      fontWeight: 700,
                      color: "var(--text)",
                    }}
                  >
                    {distribution.totalHeld.toLocaleString()}
                    <span
                      style={{
                        fontSize: 11,
                        color: "var(--text-dim)",
                        fontWeight: 400,
                        marginLeft: 4,
                      }}
                    >
                      / {SUPPLY.toLocaleString()}
                    </span>
                  </span>
                </div>
              </div>
            ) : (
              <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
                <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83D\uDCCA"}</div>
                <div className="empty-state-title" style={{ fontSize: 13 }}>No Holder Data for {collection.name}</div>
                <div className="empty-state-text" style={{ fontSize: 10 }}>Holder distribution will appear once data is loaded.</div>
              </div>
            )}
          </div>
        </div>

        {/* ═══════ RIGHT COLUMN ═══════ */}
        <div>
          {/* ── 2. ACCUMULATION TRENDS ── */}
          <div style={panelStyle}>
            <SectionHeading title="Accumulation Trends" live={activityLive} />

            {loadingActivity || loadingHolders ? (
              <SectionSkeleton rows={4} height={44} />
            ) : trend ? (
              <div>
                {/* Trend indicator */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 14,
                    padding: "16px 20px",
                    borderRadius: 14,
                    background: `${trend.color}08`,
                    border: `1px solid ${trend.color}18`,
                    marginBottom: 20,
                  }}
                >
                  <span
                    style={{
                      fontSize: 28,
                      lineHeight: 1,
                    }}
                  >
                    {trend.net >= 0 ? "\u2191" : "\u2193"}
                  </span>
                  <div>
                    <div
                      style={{
                        fontFamily: "var(--display)",
                        fontSize: 16,
                        fontWeight: 700,
                        color: trend.color,
                        letterSpacing: "0.06em",
                      }}
                    >
                      Whales are {trend.label}
                    </div>
                    <div
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 10,
                        color: "var(--text-dim)",
                        marginTop: 3,
                      }}
                    >
                      {trend.buys} inflows &middot; {trend.sells} outflows
                      &middot; Net {trend.net >= 0 ? "+" : ""}
                      {trend.net}
                    </div>
                  </div>
                </div>

                {/* Recent whale transactions */}
                <div
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 9,
                    color: "var(--text-dim)",
                    letterSpacing: "0.1em",
                    marginBottom: 10,
                    textTransform: "uppercase",
                  }}
                >
                  Recent Whale Transactions
                </div>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                    maxHeight: 320,
                    overflowY: "auto",
                  }}
                >
                  {whaleTransactions.length === 0 ? (
                    <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
                      <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83D\uDC33"}</div>
                      <div className="empty-state-title" style={{ fontSize: 13 }}>No Whale Transactions</div>
                      <div className="empty-state-text" style={{ fontSize: 10 }}>No large holder activity detected in recent {collection.name} trades.</div>
                    </div>
                  ) : (
                    whaleTransactions.slice(0, 15).map((tx, i) => (
                      <div
                        key={tx.hash ? `${tx.hash}-${i}` : i}
                        className="card-reveal"
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px 12px",
                          borderRadius: 10,
                          background: "var(--border)",
                          border: "1px solid var(--border)",
                          animationDelay: `${i * 40}ms`,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 9,
                            fontWeight: 600,
                            padding: "2px 6px",
                            borderRadius: 4,
                            background: "rgba(74, 222, 128, 0.08)",
                            color: "var(--green)",
                            border: "1px solid rgba(74, 222, 128, 0.15)",
                          }}
                        >
                          {tx.type === "sale"
                            ? "Sale"
                            : tx.type === "ask"
                            ? "List"
                            : tx.type || "Tx"}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--display)",
                            fontSize: 12,
                            color: "var(--text-dim)",
                            fontWeight: 500,
                          }}
                        >
                          {tx.token?.name || "\u2014"}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 9,
                            color: "var(--text-muted)",
                          }}
                        >
                          {getDisplayName(tx.fromFull, tx.from)} {"\u2192"} {getDisplayName(tx.toFull, tx.to)}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 11,
                            color: tx.price ? "var(--gold)" : "var(--text-muted)",
                            marginLeft: "auto",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {tx.price ? (
                            <>
                              <Eth />
                              {formatPrice(tx.price)}
                            </>
                          ) : (
                            "\u2014"
                          )}
                        </span>
                        <span
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 9,
                            color: "var(--text-muted)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {formatTimeAgo(tx.time)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
                <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\u2191\u2193"}</div>
                <div className="empty-state-title" style={{ fontSize: 13 }}>No Whale Activity for {collection.name}</div>
                <div className="empty-state-text" style={{ fontSize: 10 }}>
                  {activities.length === 0
                    ? `No recent sales found for ${collection.name}.`
                    : `None of the ${activities.length} recent ${collection.name} sales involved top ${holders.length} holders.`}
                </div>
              </div>
            )}
          </div>

          {/* ── 3. WHALE ALERTS ── */}
          <div style={panelStyle}>
            <SectionHeading title="Whale Alerts" live={activityLive}>
              {whaleTransactions.length > 0 && (
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontFamily: "var(--mono)",
                    fontSize: 10,
                    fontWeight: 700,
                    color: "var(--yellow)",
                    background: "rgba(251, 191, 36, 0.1)",
                    border: "1px solid rgba(251, 191, 36, 0.2)",
                    borderRadius: 10,
                    padding: "2px 8px",
                    animation: "pulse 2s ease-in-out infinite",
                  }}
                >
                  {whaleTransactions.length}
                </span>
              )}
            </SectionHeading>

            {loadingActivity || loadingHolders ? (
              <SectionSkeleton rows={4} height={52} />
            ) : whaleTransactions.length === 0 ? (
              <div className="empty-state" style={{ padding: "32px 0", minHeight: "auto" }}>
                <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83D\uDC33"}</div>
                <div className="empty-state-title" style={{ fontSize: 13 }}>No Whale Activity for {collection.name}</div>
                <div className="empty-state-text" style={{ fontSize: 10 }}>Large {collection.name} holder transactions will appear here as they happen.</div>
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  maxHeight: 400,
                  overflowY: "auto",
                }}
              >
                {whaleTransactions.slice(0, 10).map((tx, i) => {
                  const isRecent =
                    Date.now() - tx.time < 600000; // within 10 min
                  return (
                    <div
                      key={tx.hash ? `alert-${tx.hash}-${i}` : `alert-${i}`}
                      className="card-reveal"
                      style={{
                        ...alertCardStyle,
                        animationDelay: `${i * 60}ms`,
                        borderColor: isRecent
                          ? "rgba(251, 191, 36, 0.2)"
                          : "rgba(200,170,100,0.1)",
                        position: "relative",
                      }}
                    >
                      {isRecent && (
                        <span
                          style={{
                            position: "absolute",
                            top: 6,
                            right: 8,
                            width: 6,
                            height: 6,
                            borderRadius: "50%",
                            background: "var(--yellow)",
                            animation: "pulse 1.5s ease-in-out infinite",
                          }}
                        />
                      )}
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: 10,
                          background: "rgba(200,170,100,0.06)",
                          border: "1px solid rgba(200,170,100,0.1)",
                          display: "grid",
                          placeItems: "center",
                          flexShrink: 0,
                          fontSize: 16,
                        }}
                      >
                        {"\uD83D\uDC33"}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontFamily: "var(--display)",
                            fontSize: 13,
                            fontWeight: 600,
                            color: "var(--text)",
                            marginBottom: 2,
                          }}
                        >
                          {tx.type === "sale"
                            ? "Whale Sale"
                            : tx.type === "ask"
                            ? "Whale Listed"
                            : tx.type === "bid"
                            ? "Whale Bid"
                            : "Whale Move"}{" "}
                          {tx.token?.name || ""}
                        </div>
                        <div
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 9,
                            color: "var(--text-dim)",
                          }}
                        >
                          {getDisplayName(tx.fromFull, tx.from)} {"\u2192"} {getDisplayName(tx.toFull, tx.to)}
                        </div>
                      </div>
                      <div style={{ textAlign: "right", flexShrink: 0 }}>
                        <div
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 13,
                            fontWeight: 700,
                            color: "var(--gold)",
                          }}
                        >
                          {tx.price ? (
                            <>
                              <Eth />
                              {formatPrice(tx.price)}
                            </>
                          ) : (
                            "\u2014"
                          )}
                        </div>
                        <div
                          style={{
                            fontFamily: "var(--mono)",
                            fontSize: 9,
                            color: "var(--text-muted)",
                            marginTop: 2,
                          }}
                        >
                          {formatTimeAgo(tx.time)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Inline keyframes for pulse animation ── */}
      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </section>
  );
}
