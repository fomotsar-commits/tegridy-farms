import { useState, useCallback, useEffect, useMemo } from "react";
import NftImage from "./NftImage";
import { Eth } from "./Icons";
import { formatPrice } from "../lib/formatPrice";
import EmptyState from "./EmptyState";
import { useActiveCollection } from "../contexts/CollectionContext";

const getUserdata = () => import("../lib/userdata");

function loadWatchlist(slug) {
  try { return JSON.parse(localStorage.getItem(`${slug}_watchlist`) || "[]"); } catch { return []; }
}
function saveWatchlist(items, slug) {
  try { localStorage.setItem(`${slug}_watchlist`, JSON.stringify(items)); } catch { /* quota */ }
}

export default function Watchlist({ tokens, onPick, addToast, setTab, wallet }) {
  const collection = useActiveCollection();
  const [watchlist, setWatchlist] = useState(() => loadWatchlist(collection.slug));
  const [search, setSearch] = useState("");
  const [showSearch, setShowSearch] = useState(false);

  // Reload watchlist and reset search when collection changes
  useEffect(() => {
    setWatchlist(loadWatchlist(collection.slug));
    setSearch("");
    setShowSearch(false);
  }, [collection.slug]);

  // Sync watchlist from Supabase when wallet connects or collection changes
  useEffect(() => {
    if (!wallet) return;
    const currentItems = loadWatchlist(collection.slug);
    getUserdata().then(({ syncWatchlist }) =>
      syncWatchlist(wallet, currentItems, collection.slug).then((merged) => {
        setWatchlist(merged);
        saveWatchlist(merged, collection.slug);
      })
    );
  }, [wallet, collection.slug]);

  // Build a set of already-watched IDs for fast lookup
  const watchedIds = useMemo(() => new Set(watchlist.map((w) => w.id)), [watchlist]);

  const searchResults = useMemo(() => {
    if (search.length === 0) return [];
    const q = search.toLowerCase();
    return tokens
      .filter((t) =>
        !watchedIds.has(t.id) &&
        ((t.name || "").toLowerCase().includes(q) || String(t.id).includes(search))
      )
      .slice(0, 6);
  }, [search, tokens, watchedIds]);

  const addToWatchlist = useCallback((nft) => {
    setWatchlist((prev) => {
      if (prev.some((w) => w.id === nft.id)) return prev;
      const next = [...prev, { id: nft.id, addedAt: Date.now(), targetPrice: null, note: "" }];
      saveWatchlist(next, collection.slug);
      addToast?.(`Added ${nft.name} to watchlist`, "success");
      if (wallet) {
        getUserdata().then(({ addWatchlistRemote }) =>
          addWatchlistRemote(wallet, nft.id, {}, collection.slug)
        );
      }
      return next;
    });
    setSearch("");
    setShowSearch(false);
  }, [addToast, collection.slug, wallet]);

  const removeFromWatchlist = useCallback((id) => {
    setWatchlist((prev) => {
      const next = prev.filter((w) => w.id !== id);
      saveWatchlist(next, collection.slug);
      if (wallet) {
        getUserdata().then(({ removeWatchlistRemote }) =>
          removeWatchlistRemote(wallet, id, collection.slug)
        );
      }
      return next;
    });
  }, [collection.slug, wallet]);

  const updateNote = useCallback((id, note) => {
    setWatchlist((prev) => {
      const next = prev.map((w) => w.id === id ? { ...w, note } : w);
      saveWatchlist(next, collection.slug);
      if (wallet) {
        const item = next.find((w) => w.id === id);
        getUserdata().then(({ addWatchlistRemote }) =>
          addWatchlistRemote(wallet, id, { targetPrice: item?.targetPrice, note }, collection.slug)
        );
      }
      return next;
    });
  }, [collection.slug, wallet]);

  const updateTarget = useCallback((id, targetPrice) => {
    setWatchlist((prev) => {
      const next = prev.map((w) => w.id === id ? { ...w, targetPrice: targetPrice || null } : w);
      saveWatchlist(next, collection.slug);
      if (wallet) {
        const item = next.find((w) => w.id === id);
        getUserdata().then(({ addWatchlistRemote }) =>
          addWatchlistRemote(wallet, id, { targetPrice: targetPrice || null, note: item?.note }, collection.slug)
        );
      }
      return next;
    });
  }, [collection.slug, wallet]);

  const watchedNfts = useMemo(() => tokens.filter((t) => watchedIds.has(t.id)), [tokens, watchedIds]);
  const watchDataMap = useMemo(() => {
    const map = new Map();
    for (const w of watchlist) map.set(w.id, w);
    return map;
  }, [watchlist]);
  const getWatchData = useCallback((id) => watchDataMap.get(id) || {}, [watchDataMap]);

  return (
    <section className="watchlist-section">
      <div className="watchlist-header">
        <div>
          <div className="watchlist-title">WATCHLIST</div>
          <div className="watchlist-subtitle">Track {collection.name} NFTs and set price alerts</div>
        </div>
        <button className="watchlist-add-btn" onClick={() => setShowSearch(!showSearch)}>
          + Add to Watchlist
        </button>
      </div>

      {/* Search to add */}
      {showSearch && (
        <div className="watchlist-search-wrap">
          <input
            className="watchlist-search-input"
            placeholder={`Search ${collection.name} by name or token ID...`}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            autoFocus
          />
          {search.length > 0 && searchResults.length === 0 && (
            <div className="watchlist-search-results">
              <div style={{ padding: "12px 16px", fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>
                No results found
              </div>
            </div>
          )}
          {searchResults.length > 0 && (
            <div className="watchlist-search-results">
              {searchResults.map((nft) => (
                <div key={nft.id} className="watchlist-search-item" onClick={() => addToWatchlist(nft)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addToWatchlist(nft); } }} role="button" tabIndex={0} aria-label={`Add ${nft.name} to watchlist`}>
                  <NftImage nft={nft} style={{ width: 32, height: 32, borderRadius: 4, objectFit: "cover" }} />
                  <span style={{ fontFamily: "var(--display)", fontSize: 12, color: "var(--text)" }}>{nft.name}</span>
                  {nft.rank && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--gold)", marginLeft: "auto" }}>#{nft.rank}</span>}
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-muted)", marginLeft: 8 }}>+ Add</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Empty state */}
      {watchlist.length === 0 && !showSearch && (
        <EmptyState type="watchlist" collectionName={collection.name} onAction={setTab ? (tab) => setTab(tab) : undefined} />
      )}

      {/* Watchlist items */}
      <div className="watchlist-grid">
        {watchedNfts.map((nft) => {
          const data = getWatchData(nft.id);
          const belowTarget = data.targetPrice && nft.price && nft.price <= data.targetPrice;
          return (
            <div key={nft.id} className={`watchlist-card ${belowTarget ? "alert" : ""}`}>
              <div className="watchlist-card-image" onClick={() => onPick(nft)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(nft); } }} role="button" tabIndex={0} aria-label={`View ${nft.name}`}>
                <NftImage nft={nft} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              </div>
              <div className="watchlist-card-body">
                <div className="watchlist-card-top">
                  <span style={{ fontFamily: "var(--display)", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{nft.name}</span>
                  <button className="watchlist-remove" onClick={() => removeFromWatchlist(nft.id)} title="Remove">{"\u2715"}</button>
                </div>
                <div className="watchlist-card-meta">
                  {nft.rank && <span style={{ color: "var(--gold)" }}>Rank #{nft.rank}</span>}
                  {nft.price && <span style={{ color: "var(--naka-blue)" }}><Eth size={10} /> {formatPrice(nft.price)}</span>}
                </div>
                <div className="watchlist-card-inputs">
                  <div>
                    <label style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-dim)", letterSpacing: "0.06em" }}>TARGET PRICE (ETH)</label>
                    <input
                      type="number"
                      step="0.001"
                      className="watchlist-target-input"
                      placeholder="0.00"
                      value={data.targetPrice || ""}
                      onChange={(e) => updateTarget(nft.id, parseFloat(e.target.value))}
                    />
                  </div>
                  <div>
                    <label style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-dim)", letterSpacing: "0.06em" }}>NOTE</label>
                    <input
                      className="watchlist-note-input"
                      placeholder="Add a note..."
                      value={data.note || ""}
                      onChange={(e) => updateNote(nft.id, e.target.value)}
                    />
                  </div>
                </div>
                {belowTarget && (
                  <div className="watchlist-alert-badge">
                    {"\u26A0"} Below target price!
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
