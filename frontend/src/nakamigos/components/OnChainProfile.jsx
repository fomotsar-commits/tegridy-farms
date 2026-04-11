import { useState, useEffect, useCallback, useRef } from "react";
import { fetchWalletNfts, fetchCollectionStats, fetchActivity, shortenAddress } from "../api";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { useActiveCollection } from "../contexts/CollectionContext";

const MAX_GRID = 24;

const EVENT_COLORS = {
  sale: "var(--green)",
  ask: "var(--yellow)",
  bid: "var(--purple)",
  transfer: "var(--text-dim)",
  mint: "var(--gold)",
};

const EVENT_LABELS = {
  sale: "Sale",
  ask: "Listed",
  bid: "Bid",
  transfer: "Transfer",
  mint: "Mint",
};

function formatTimeAgo(ts) {
  const diff = Math.floor((Date.now() - ts) / 1000);
  if (diff < 0) return "just now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function GradientAvatar({ address, size = 80 }) {
  const hash = (address || "").slice(2, 10);
  const h1 = parseInt(hash.slice(0, 3), 16) % 360;
  const h2 = (h1 + 120) % 360;
  const initials = address ? `${address.slice(2, 4).toUpperCase()}` : "??";

  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `linear-gradient(135deg, hsl(${h1}, 60%, 35%), hsl(${h2}, 50%, 25%))`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "var(--mono)",
        fontSize: size * 0.3,
        fontWeight: 700,
        color: "rgba(255,255,255,0.7)",
        border: "2px solid rgba(200,168,80,0.3)",
        flexShrink: 0,
      }}
    >
      {initials}
    </div>
  );
}

function Badge({ label, icon, color }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "4px 12px",
        borderRadius: 20,
        background: `${color}18`,
        border: `1px solid ${color}40`,
        fontFamily: "var(--mono)",
        fontSize: 10,
        fontWeight: 600,
        color: color,
        letterSpacing: "0.06em",
        textTransform: "uppercase",
      }}
    >
      {icon && <span style={{ fontSize: 13 }}>{icon}</span>}
      {label}
    </span>
  );
}

export default function OnChainProfile({ address, onClose, onPick, wallet, onEdit }) {
  const collection = useActiveCollection();
  const [tokens, setTokens] = useState([]);
  const [totalCount, setTotalCount] = useState(0);
  const [floorPrice, setFloorPrice] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ensName, setEnsName] = useState(null);
  const [ensAvatar, setEnsAvatar] = useState(null);
  const [copied, setCopied] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [activities, setActivities] = useState([]);
  const [visible, setVisible] = useState(false);
  const prevCollectionRef = useRef(collection.contract);

  // Slide-in animation
  useEffect(() => {
    const frame = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Reset NFT state when collection changes
  useEffect(() => {
    if (prevCollectionRef.current !== collection.contract) {
      setTokens([]);
      setTotalCount(0);
      setFloorPrice(null);
      setLoading(true);
      setShowAll(false);
      setActivities([]);
      prevCollectionRef.current = collection.contract;
    }
  }, [collection.contract]);

  // Fetch wallet NFTs — pass metadataBase so images resolve for all collections
  useEffect(() => {
    if (!address) return;
    let mounted = true;
    setLoading(true);

    fetchWalletNfts(address, collection.contract, collection.metadataBase).then((data) => {
      if (!mounted) return;
      setTokens(data.tokens || []);
      setTotalCount(data.totalCount || 0);
      setLoading(false);
    });

    return () => {
      mounted = false;
    };
  }, [address, collection.contract, collection.metadataBase]);

  // Fetch real floor price for this collection
  useEffect(() => {
    let mounted = true;
    fetchCollectionStats({ contract: collection.contract, slug: collection.slug, openseaSlug: collection.openseaSlug }).then((stats) => {
      if (mounted && stats.floor != null) setFloorPrice(stats.floor);
    }).catch(() => {});
    return () => { mounted = false; };
  }, [collection.contract, collection.slug, collection.openseaSlug]);

  // Resolve ENS
  useEffect(() => {
    if (!address) return;
    let mounted = true;

    async function resolveEns() {
      try {
        const { ethers } = await import("ethers");
        const provider = new ethers.JsonRpcProvider("https://eth.llamarpc.com");
        const name = await provider.lookupAddress(address);
        if (!mounted) return;
        if (name) {
          setEnsName(name);
          try {
            const avatar = await provider.getAvatar(name);
            if (mounted && avatar) {
              // Only allow http(s) avatar URLs — block javascript:, data:, etc.
              try {
                const url = new URL(avatar);
                if (url.protocol === "https:" || url.protocol === "http:") {
                  setEnsAvatar(avatar);
                }
              } catch {
                /* malformed URL — ignore */
              }
            }
          } catch (_) {
            /* avatar optional */
          }
        }
      } catch (_) {
        /* ENS resolution is best-effort */
      }
    }

    resolveEns();
    return () => {
      mounted = false;
    };
  }, [address]);

  // Fetch recent activity for this collection
  useEffect(() => {
    if (!address) return;
    let mounted = true;
    // NOTE: fetchActivity does not currently support an address filter parameter.
    // We fetch collection activity and filter client-side for this wallet's transactions.
    fetchActivity({ contract: collection.contract, limit: 50 })
      .then(data => {
        if (!mounted) return;
        const addrLower = address.toLowerCase();
        const walletActivities = (data.activities || []).filter(
          a => a.fromFull?.toLowerCase() === addrLower || a.toFull?.toLowerCase() === addrLower
        );
        setActivities(walletActivities.slice(0, 4));
      })
      .catch(() => {
        if (mounted) setActivities([]);
      });
    return () => { mounted = false; };
  }, [address, collection.contract]);

  const handleCopy = useCallback(() => {
    if (!address) return;
    try {
      navigator.clipboard.writeText(address).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }).catch(() => {
        // Fallback for insecure contexts or denied permission
        const el = document.createElement("textarea");
        el.value = address;
        el.style.position = "fixed";
        el.style.opacity = "0";
        document.body.appendChild(el);
        el.select();
        document.execCommand("copy");
        document.body.removeChild(el);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      });
    } catch {
      // Clipboard API not available at all
      setCopied(false);
    }
  }, [address]);

  const handleClose = useCallback(() => {
    setVisible(false);
    setTimeout(() => onClose?.(), 320);
  }, [onClose]);

  if (!address) return null;

  const displayTokens = showAll ? tokens : tokens.slice(0, MAX_GRID);
  const portfolioValue = floorPrice != null ? totalCount * floorPrice : null;
  const isWhale = totalCount >= 10;
  const isCollector = totalCount >= 5;
  const isOwnProfile = wallet && address.toLowerCase() === wallet.toLowerCase();

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9000,
        display: "flex",
        justifyContent: "flex-end",
        background: visible ? "rgba(0,0,0,0.65)" : "rgba(0,0,0,0)",
        backdropFilter: visible ? "blur(6px)" : "none",
        transition: "background 0.3s ease, backdrop-filter 0.3s ease",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 560,
          height: "100vh",
          overflowY: "auto",
          background: "linear-gradient(180deg, rgba(16,14,12,0.97) 0%, rgba(10,9,8,0.99) 100%)",
          borderLeft: "1px solid rgba(200,168,80,0.15)",
          boxShadow: "-8px 0 40px rgba(0,0,0,0.6)",
          transform: visible ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.32s cubic-bezier(0.22,1,0.36,1)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {/* Close button */}
        <button
          onClick={handleClose}
          style={{
            position: "absolute",
            top: 16,
            right: 16,
            width: 36,
            height: 36,
            borderRadius: "50%",
            border: "1px solid rgba(200,168,80,0.2)",
            background: "rgba(20,18,16,0.8)",
            color: "var(--text-dim)",
            fontSize: 18,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 10,
            transition: "color 0.2s, border-color 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--gold)";
            e.currentTarget.style.borderColor = "rgba(200,168,80,0.5)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-dim)";
            e.currentTarget.style.borderColor = "rgba(200,168,80,0.2)";
          }}
        >
          &#x2715;
        </button>

        {/* ═══ Profile Header ═══ */}
        <div
          style={{
            padding: "40px 32px 28px",
            borderBottom: "1px solid rgba(200,168,80,0.1)",
            display: "flex",
            gap: 20,
            alignItems: "center",
          }}
        >
          {ensAvatar ? (
            <img
              src={ensAvatar}
              alt="ENS Avatar"
              style={{
                width: 80,
                height: 80,
                borderRadius: "50%",
                border: "2px solid rgba(200,168,80,0.3)",
                objectFit: "cover",
                flexShrink: 0,
              }}
            />
          ) : (
            <GradientAvatar address={address} size={80} />
          )}

          <div style={{ minWidth: 0, flex: 1 }}>
            {ensName && (
              <div
                style={{
                  fontFamily: "var(--display)",
                  fontSize: 22,
                  fontWeight: 700,
                  color: "var(--text)",
                  marginBottom: 4,
                  letterSpacing: "-0.01em",
                }}
              >
                {ensName}
              </div>
            )}
            <div
              onClick={handleCopy}
              title="Click to copy full address"
              style={{
                fontFamily: "var(--mono)",
                fontSize: ensName ? 12 : 16,
                color: ensName ? "var(--text-dim)" : "var(--text)",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: 6,
                transition: "color 0.2s",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.color = "var(--gold)")}
              onMouseLeave={(e) => (e.currentTarget.style.color = ensName ? "var(--text-dim)" : "var(--text)")}
            >
              {shortenAddress(address)}
              <span style={{ fontSize: 10, opacity: 0.6 }}>
                {copied ? "COPIED" : "COPY"}
              </span>
            </div>
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                color: "var(--text-dim)",
                marginTop: 6,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span>{collection.name} &middot; On-Chain Profile</span>
              {isOwnProfile && onEdit && (
                <button
                  onClick={onEdit}
                  style={{
                    background: "none",
                    border: "1px solid rgba(200,168,80,0.3)",
                    borderRadius: 4,
                    padding: "2px 8px",
                    fontFamily: "var(--mono)",
                    fontSize: 9,
                    color: "var(--gold)",
                    cursor: "pointer",
                    letterSpacing: "0.04em",
                    textTransform: "uppercase",
                    transition: "background 0.2s, border-color 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = "rgba(200,168,80,0.1)";
                    e.currentTarget.style.borderColor = "rgba(200,168,80,0.5)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "none";
                    e.currentTarget.style.borderColor = "rgba(200,168,80,0.3)";
                  }}
                >
                  Edit
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ═══ Stats Row ═══ */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 1,
            background: "rgba(200,168,80,0.08)",
            borderBottom: "1px solid rgba(200,168,80,0.1)",
          }}
        >
          {[
            {
              label: `${collection.name.toUpperCase()} OWNED`,
              value: loading ? "\u2014" : totalCount,
              gold: true,
            },
            {
              label: "EST. VALUE",
              value: loading ? "\u2014" : portfolioValue != null ? `${portfolioValue.toFixed(3)}` : "\u2014",
              eth: !loading && portfolioValue != null,
              gold: true,
            },
            {
              label: "STATUS",
              value: loading ? "\u2014" : totalCount === 0 ? "Observer" : isWhale ? "Whale" : isCollector ? "Collector" : "Holder",
              gold: false,
            },
          ].map((stat, i) => (
            <div
              key={i}
              style={{
                padding: "20px 16px",
                background: "rgba(10,9,8,0.9)",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 9,
                  color: "var(--text-dim)",
                  letterSpacing: "0.1em",
                  marginBottom: 6,
                }}
              >
                {stat.label}
              </div>
              <div
                style={{
                  fontFamily: "var(--display)",
                  fontSize: 20,
                  fontWeight: 700,
                  color: stat.gold ? "var(--gold)" : "var(--text-dim)",
                }}
              >
                {stat.eth && stat.value !== "\u2014" && <Eth size={15} />}
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {/* ═══ Reputation Badges ═══ */}
        <div
          style={{
            padding: "16px 32px",
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            borderBottom: "1px solid rgba(200,168,80,0.08)",
          }}
        >
          {isWhale && <Badge label="Whale" icon={"\uD83D\uDC33"} color="var(--gold)" />}
          {isWhale && <Badge label="Diamond Hands" icon={"\uD83D\uDC8E"} color="var(--naka-blue)" />}
          {isCollector && !isWhale && <Badge label="Collector" icon={"\u2B50"} color="var(--purple)" />}
          {!isWhale && !isCollector && totalCount > 0 && (
            <Badge label="Holder" icon={"\u2728"} color="var(--green)" />
          )}
          {totalCount === 0 && !loading && (
            <Badge label="Observer" icon={"\uD83D\uDC41"} color="var(--text-muted)" />
          )}
        </div>

        {/* ═══ Collection Grid ═══ */}
        <div style={{ padding: "24px 32px 16px" }}>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "baseline",
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontFamily: "var(--mono)",
                fontSize: 10,
                color: "var(--text-dim)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
              }}
            >
              Collection
            </div>
            {totalCount > MAX_GRID && !showAll && (
              <button
                onClick={() => setShowAll(true)}
                style={{
                  background: "none",
                  border: "none",
                  fontFamily: "var(--mono)",
                  fontSize: 10,
                  color: "var(--gold)",
                  cursor: "pointer",
                  letterSpacing: "0.04em",
                  padding: 0,
                }}
              >
                View all {totalCount} &rarr;
              </button>
            )}
          </div>

          {loading ? (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 8,
              }}
            >
              {Array.from({ length: 8 }).map((_, i) => (
                <div
                  key={i}
                  className="skeleton"
                  style={{
                    aspectRatio: "1",
                    borderRadius: 8,
                    animationDelay: `${i * 50}ms`,
                  }}
                />
              ))}
            </div>
          ) : tokens.length === 0 ? (
            <div className="empty-state" style={{ padding: "32px 0", minHeight: "auto" }}>
              <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83D\uDDBC"}</div>
              <div className="empty-state-title" style={{ fontSize: 13 }}>No {collection.name} Found</div>
              <div className="empty-state-text" style={{ fontSize: 10 }}>This wallet does not hold any {collection.name} NFTs.</div>
            </div>
          ) : (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(4, 1fr)",
                gap: 8,
              }}
            >
              {displayTokens.map((nft) => (
                <div
                  key={nft.id}
                  onClick={() => onPick?.(nft)}
                  style={{
                    position: "relative",
                    aspectRatio: "1",
                    borderRadius: 8,
                    overflow: "hidden",
                    cursor: "pointer",
                    border: "1px solid rgba(200,168,80,0.1)",
                    transition: "border-color 0.2s, transform 0.2s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = "rgba(200,168,80,0.4)";
                    e.currentTarget.style.transform = "scale(1.04)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = "rgba(200,168,80,0.1)";
                    e.currentTarget.style.transform = "scale(1)";
                  }}
                >
                  <NftImage
                    nft={nft}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                  <div
                    style={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      right: 0,
                      padding: "12px 6px 4px",
                      background: "linear-gradient(transparent, rgba(0,0,0,0.85))",
                      fontFamily: "var(--mono)",
                      fontSize: 9,
                      color: "var(--text-dim)",
                      textAlign: "center",
                    }}
                  >
                    #{nft.id}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ═══ Recent Activity ═══ */}
        <div
          style={{
            padding: "8px 32px 32px",
            borderTop: "1px solid rgba(200,168,80,0.08)",
          }}
        >
          <div
            style={{
              fontFamily: "var(--mono)",
              fontSize: 10,
              color: "var(--text-dim)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              marginBottom: 14,
              marginTop: 16,
            }}
          >
            Recent Activity
          </div>

          {activities.length === 0 ? (
            <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
              <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83D\uDCCA"}</div>
              <div className="empty-state-title" style={{ fontSize: 13 }}>No Recent Activity</div>
              <div className="empty-state-text" style={{ fontSize: 10 }}>Activity for this wallet will appear here as trades happen.</div>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {activities.map((a, i) => {
                const color = EVENT_COLORS[a.type] || "var(--text-muted)";
                const label = EVENT_LABELS[a.type] || a.type;

                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "10px 12px",
                      borderRadius: 8,
                      background: "rgba(200,168,80,0.03)",
                      transition: "background 0.2s",
                    }}
                    onMouseEnter={(e) =>
                      (e.currentTarget.style.background = "rgba(200,168,80,0.07)")
                    }
                    onMouseLeave={(e) =>
                      (e.currentTarget.style.background = "rgba(200,168,80,0.03)")
                    }
                  >
                    {/* Type badge */}
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 9,
                        fontWeight: 700,
                        color: color,
                        background: `${color}15`,
                        border: `1px solid ${color}30`,
                        borderRadius: 4,
                        padding: "2px 8px",
                        letterSpacing: "0.05em",
                        textTransform: "uppercase",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {label}
                    </span>

                    {/* Token name */}
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 12,
                        color: "var(--text)",
                        fontWeight: 600,
                        minWidth: 50,
                      }}
                    >
                      {a.token?.name || "\u2014"}
                    </span>

                    {/* Price */}
                    {a.price != null && (
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 12,
                          color: "var(--gold)",
                          fontWeight: 600,
                          display: "flex",
                          alignItems: "center",
                        }}
                      >
                        <Eth size={11} />
                        {a.price}
                      </span>
                    )}

                    {/* Marketplace */}
                    {a.marketplace && (
                      <span
                        style={{
                          fontFamily: "var(--mono)",
                          fontSize: 9,
                          color: "var(--text-dim)",
                          marginLeft: "auto",
                        }}
                      >
                        {a.marketplace}
                      </span>
                    )}

                    {/* Time */}
                    <span
                      style={{
                        fontFamily: "var(--mono)",
                        fontSize: 9,
                        color: "var(--text-muted)",
                        marginLeft: a.marketplace ? 0 : "auto",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {formatTimeAgo(a.time)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
