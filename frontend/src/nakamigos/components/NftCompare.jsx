import { useState, useEffect, useCallback, useMemo } from "react";
import NftImage from "./NftImage";
import { Eth } from "./Icons";
import { fetchWalletNfts, shortenAddress } from "../api";
import { useActiveCollection } from "../contexts/CollectionContext";
import { useWalletState, useWalletActions } from "../contexts/WalletContext";
// P2P sends route through the AUDITED trade SDK (lib/trades → /api/orderbook,
// service-role write + canonical Seaport order). The previous hand-rolled path
// here built an orderType-2/OpenSea-zone order and stored it via the anon client
// to trade_offers — a table migration 007 made service-role-only — so every send
// RLS-failed into a localStorage stub yet still toasted success: a signed trade
// that never reached the counterparty (and wasn't even fulfillable in-app).
import { createTradeOffer as createDirectedTrade } from "../lib/trades";

const cardStyle = {
  background: "var(--surface-glass)",
  backdropFilter: "var(--glass-blur)",
  border: "1px solid var(--border)",
  borderRadius: 16,
  padding: 20,
  display: "flex",
  flexDirection: "column",
  gap: 12,
  minHeight: 340,
};

const searchInputStyle = {
  width: "100%",
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 12,
  outline: "none",
  boxSizing: "border-box",
};

const ethInputStyle = {
  width: "100%",
  padding: "10px 14px",
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 13,
  outline: "none",
  boxSizing: "border-box",
};

const resultItemStyle = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "8px 10px",
  borderRadius: 8,
  cursor: "pointer",
  transition: "background 0.15s",
};

const tradeButtonStyle = {
  padding: "14px 32px",
  borderRadius: 12,
  border: "none",
  background: "var(--gold)",
  color: "var(--bg)",
  fontFamily: "var(--pixel)",
  fontSize: 10,
  letterSpacing: "0.06em",
  cursor: "pointer",
  fontWeight: 700,
  transition: "opacity 0.2s, transform 0.15s",
};

function NftSlot({ nft, label, searchValue, onSearchChange, searchResults, onSelect, onClear, placeholder }) {
  if (nft) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
        <div style={{ position: "relative", width: "100%", maxWidth: 200, cursor: "pointer" }} onClick={onClear}>
          <NftImage
            nft={nft}
            large
            style={{ width: "100%", aspectRatio: "1", objectFit: "cover", borderRadius: 12 }}
          />
          <div style={{
            position: "absolute", top: 6, right: 6, width: 22, height: 22, borderRadius: "50%",
            background: "rgba(0,0,0,0.6)", color: "#fff", display: "flex", alignItems: "center",
            justifyContent: "center", fontSize: 12, lineHeight: 1,
          }}>
            x
          </div>
        </div>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontFamily: "var(--display)", fontSize: 14, fontWeight: 700, color: "var(--text)" }}>{nft.name}</div>
          {nft.rank && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--gold)", marginTop: 4 }}>Rank #{nft.rank}</div>
          )}
          {nft.owner && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>
              Owner: {shortenAddress(nft.owner)}
            </div>
          )}
        </div>
        {nft.attributes && nft.attributes.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, justifyContent: "center", maxWidth: 220 }}>
            {nft.attributes.slice(0, 6).map((a) => (
              <span key={a.key} style={{
                fontFamily: "var(--mono)", fontSize: 9, padding: "3px 7px", borderRadius: 6,
                background: "rgba(255,255,255,0.06)", color: "var(--text-dim)", border: "1px solid var(--border)",
              }}>
                {a.key}: {a.value}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <input
        style={searchInputStyle}
        placeholder={placeholder || "Search by name or ID..."}
        value={searchValue}
        onChange={(e) => onSearchChange(e.target.value)}
        autoComplete="off"
      />
      {searchResults.length > 0 && (
        <div style={{
          maxHeight: 240, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2,
          background: "rgba(0,0,0,0.2)", borderRadius: 10, padding: 6,
        }}>
          {searchResults.map((n) => (
            <div
              key={n.id}
              style={resultItemStyle}
              onClick={() => onSelect(n)}
              onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(255,255,255,0.06)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
            >
              <NftImage nft={n} style={{ width: 36, height: 36, borderRadius: 6, objectFit: "cover" }} />
              <span style={{ fontFamily: "var(--display)", fontSize: 13, color: "var(--text)" }}>{n.name}</span>
              {n.rank && <span style={{ marginLeft: "auto", color: "var(--gold)", fontFamily: "var(--mono)", fontSize: 10 }}>#{n.rank}</span>}
            </div>
          ))}
        </div>
      )}
      {!searchValue && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          height: 120, opacity: 0.15, fontSize: 40,
        }}>
          +
        </div>
      )}
    </div>
  );
}

export default function NftCompare({ tokens, onPick, wallet, onConnect, addToast, setTab }) {
  const collection = useActiveCollection();
  const { isWrongNetwork } = useWalletState();
  const { switchChain } = useWalletActions();
  // Left panel (your NFT)
  const [yourNft, setYourNft] = useState(null);
  const [yourSearch, setYourSearch] = useState("");
  const [yourEth, setYourEth] = useState("");
  const [ownedNfts, setOwnedNfts] = useState([]);
  const [loadingOwned, setLoadingOwned] = useState(false);

  // Right panel (their NFT)
  const [theirNft, setTheirNft] = useState(null);
  const [theirSearch, setTheirSearch] = useState("");
  const [theirEth, setTheirEth] = useState("");

  // Trade state
  const [submitting, setSubmitting] = useState(false);
  const [step, setStep] = useState("");

  // Reset selections when collection changes
  useEffect(() => {
    setYourNft(null);
    setTheirNft(null);
    setYourSearch("");
    setTheirSearch("");
    setYourEth("");
    setTheirEth("");
  }, [collection.slug]);

  // Fetch owned NFTs when wallet changes
  useEffect(() => {
    if (!wallet) {
      setOwnedNfts([]);
      return;
    }
    let cancelled = false;
    setLoadingOwned(true);
    fetchWalletNfts(wallet, collection.contract, collection.metadataBase).then(({ tokens: owned }) => {
      if (!cancelled) {
        // Enrich with rarity data from full collection
        const enriched = owned.map((o) => {
          const full = tokens.find((t) => String(t.id) === String(o.id));
          return full ? { ...o, rank: full.rank, rarityScore: full.rarityScore, attributes: full.attributes || o.attributes } : o;
        });
        setOwnedNfts(enriched);
        setLoadingOwned(false);
      }
    }).catch(() => {
      if (!cancelled) {
        setOwnedNfts([]);
        setLoadingOwned(false);
      }
    });
    return () => { cancelled = true; };
  }, [wallet, tokens, collection.contract]);

  // Search: your NFTs (owned only)
  const yourResults = useMemo(() => {
    if (!yourSearch || yourSearch.length < 1) return [];
    const lower = yourSearch.toLowerCase();
    return ownedNfts
      .filter((t) => t.name.toLowerCase().includes(lower) || String(t.id).includes(yourSearch))
      .slice(0, 8);
  }, [ownedNfts, yourSearch]);

  // Search: their NFTs (any token in collection)
  const theirResults = useMemo(() => {
    if (!theirSearch || theirSearch.length < 1) return [];
    const lower = theirSearch.toLowerCase();
    return tokens
      .filter((t) => t.name.toLowerCase().includes(lower) || String(t.id).includes(theirSearch))
      .slice(0, 8);
  }, [tokens, theirSearch]);

  const canSubmit = wallet && yourNft && theirNft && !submitting;

  // Send the trade through the AUDITED P2P SDK — it owns approvals, the WETH
  // wrap, the canonical Seaport order, the signature, and the service-role
  // /api/orderbook write, and returns a typed {success|error|rejected} result so
  // a failed persist surfaces honestly instead of toasting a phantom success.
  const handleSendTrade = useCallback(async () => {
    if (!wallet) { onConnect?.(); return; }
    if (isWrongNetwork) { addToast?.("Wrong network — please switch to Ethereum Mainnet", "error"); switchChain?.(); return; }
    if (!yourNft || !theirNft) { addToast?.("Select both NFTs", "error"); return; }
    if (!theirNft.owner) { addToast?.("Target NFT owner unknown — pick a token with a known holder", "error"); return; }
    if (theirNft.owner.toLowerCase() === wallet.toLowerCase()) { addToast?.("You already own this NFT", "error"); return; }

    setSubmitting(true);
    setStep("Building trade...");
    try {
      const result = await createDirectedTrade({
        give: [{ contract: collection.contract, tokenId: String(yourNft.id) }],
        get: [{ contract: collection.contract, tokenId: String(theirNft.id) }],
        taker: theirNft.owner,
        wethTopupEth: yourEth || "0",   // ETH you ADD — wrapped to WETH on the offer side
        ethTopupEth: theirEth || "0",   // ETH you REQUEST — taker pays native on fulfillment
      });
      if (result?.success) {
        addToast?.(`Trade offer sent: #${yourNft.id} for #${theirNft.id}`, "success");
        setYourNft(null);
        setTheirNft(null);
        setYourEth("");
        setTheirEth("");
        setYourSearch("");
        setTheirSearch("");
      } else if (result?.error === "rejected") {
        addToast?.("Trade cancelled", "info");
      } else {
        addToast?.(result?.message || "Trade failed. Please try again.", "error");
      }
    } catch (err) {
      console.error("Trade error:", err);
      addToast?.("Trade failed. Please try again or check your wallet connection.", "error");
    }
    setSubmitting(false);
    setStep("");
  }, [wallet, onConnect, isWrongNetwork, switchChain, yourNft, theirNft, yourEth, theirEth, addToast, collection.contract]);

  if (!wallet) {
    return (
      <section style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px" }}>
        <div className="wallet-connect-prompt">
          <div className="wallet-connect-icon">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M16 3h5v5" /><path d="M4 20L21 3" /><path d="M21 16v5h-5" /><path d="M15 15l6 6" /><path d="M4 4l5 5" />
            </svg>
          </div>
          <h3 className="wallet-connect-title">Connect Your Wallet</h3>
          <p className="wallet-connect-desc">
            Connect your wallet to swap {collection.name} directly with other holders through peer-to-peer trades.
          </p>
          <button className="btn-primary wallet-connect-btn" onClick={onConnect}>
            Connect Wallet
          </button>
        </div>
      </section>
    );
  }

  return (
    <section style={{ maxWidth: 900, margin: "0 auto", padding: "32px 16px" }}>
      {/* Title */}
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontFamily: "var(--pixel)", fontSize: 12, color: "var(--gold)", letterSpacing: "0.08em", marginBottom: 8 }}>
          P2P TRADE
        </div>
        <div style={{ fontFamily: "var(--display)", fontSize: 14, color: "var(--text-dim)", maxWidth: 500, margin: "0 auto" }}>
          Swap {collection.name} directly with other holders. Select your NFT, pick the one you want, and send a trade offer.
        </div>
      </div>

      {/* Two-panel layout */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 16, alignItems: "start", marginBottom: 32 }}>
        {/* Left: YOUR NFT */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 9, color: "var(--naka-blue)", letterSpacing: "0.06em", textAlign: "center" }}>
            YOUR NFT
          </div>
          {loadingOwned ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 0" }}>
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="skeleton" style={{ height: 40, borderRadius: 8, animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
          ) : ownedNfts.length === 0 ? (
            <div className="empty-state" style={{ padding: "24px 0", minHeight: "auto" }}>
              <div className="empty-state-icon" style={{ fontSize: 28, marginBottom: 8 }}>{"\uD83D\uDDBC"}</div>
              <div className="empty-state-title" style={{ fontSize: 13 }}>No {collection.name} Found</div>
              <div className="empty-state-text" style={{ fontSize: 10 }}>Your wallet does not hold any {collection.name} NFTs to trade.</div>
            </div>
          ) : (
            <NftSlot
              nft={yourNft}
              searchValue={yourSearch}
              onSearchChange={setYourSearch}
              searchResults={yourResults}
              onSelect={(n) => { setYourNft(n); setYourSearch(""); }}
              onClear={() => setYourNft(null)}
              placeholder="Search your NFTs..."
            />
          )}

          {/* ETH sweetener */}
          <div style={{ marginTop: "auto" }}>
            <div style={{ fontFamily: "var(--pixel)", fontSize: 8, color: "var(--text-dim)", marginBottom: 6, letterSpacing: "0.04em" }}>
              ADD ETH (OPTIONAL)
            </div>
            <div style={{ position: "relative" }}>
              <input
                style={ethInputStyle}
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={yourEth}
                onChange={(e) => setYourEth(e.target.value)}
              />
              <span style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", pointerEvents: "none",
              }}>
                <Eth size={10} /> ETH
              </span>
            </div>
          </div>
        </div>

        {/* Center: Arrow + Button */}
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 16, paddingTop: 60, minWidth: 60,
        }}>
          <div style={{ fontSize: 28, color: "var(--gold)", opacity: 0.6 }}>
            &#8596;
          </div>
          <button
            disabled={!canSubmit}
            onClick={handleSendTrade}
            style={{
              ...tradeButtonStyle,
              opacity: canSubmit ? 1 : 0.35,
              cursor: canSubmit ? "pointer" : "not-allowed",
            }}
          >
            {submitting ? step || "SENDING..." : "SEND TRADE"}
          </button>
        </div>

        {/* Right: THEIR NFT */}
        <div style={cardStyle}>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 9, color: "var(--gold)", letterSpacing: "0.06em", textAlign: "center" }}>
            THEIR NFT
          </div>
          <NftSlot
            nft={theirNft}
            searchValue={theirSearch}
            onSearchChange={setTheirSearch}
            searchResults={theirResults}
            onSelect={(n) => { setTheirNft(n); setTheirSearch(""); }}
            onClear={() => setTheirNft(null)}
            placeholder={`Search any ${collection.name}...`}
          />

          {/* ETH request */}
          <div style={{ marginTop: "auto" }}>
            <div style={{ fontFamily: "var(--pixel)", fontSize: 8, color: "var(--text-dim)", marginBottom: 6, letterSpacing: "0.04em" }}>
              REQUEST ETH (OPTIONAL)
            </div>
            <div style={{ position: "relative" }}>
              <input
                style={ethInputStyle}
                type="number"
                min="0"
                step="0.01"
                placeholder="0.00"
                value={theirEth}
                onChange={(e) => setTheirEth(e.target.value)}
              />
              <span style={{
                position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)",
                fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", pointerEvents: "none",
              }}>
                <Eth size={10} /> ETH
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Trade offers (incoming, sent, counters, cancels) are reviewed and
          settled in the audited P2P Trades surface \u2014 this tab is for picking
          the pair and firing the offer. */}
      <div style={{
        background: "var(--surface-glass)", backdropFilter: "var(--glass-blur)",
        border: "1px solid var(--border)", borderRadius: 16, padding: 24,
        display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 14,
      }}>
        <div>
          <div style={{ fontFamily: "var(--pixel)", fontSize: 10, color: "var(--gold)", letterSpacing: "0.06em", marginBottom: 8 }}>
            INCOMING &amp; SENT TRADES
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-dim)", maxWidth: 460, lineHeight: 1.5 }}>
            Review, accept, counter, or cancel your trade offers in the Trades tab \u2014 the same on-chain order book your sent offers post to.
          </div>
        </div>
        <button
          className="btn-primary"
          style={{ padding: "10px 22px", whiteSpace: "nowrap" }}
          onClick={() => setTab?.("trades")}
        >
          {"Open Trades \u2192"}
        </button>
      </div>
    </section>
  );
}
