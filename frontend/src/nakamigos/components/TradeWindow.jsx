import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Eth } from "./Icons";
import NftImage from "./NftImage";
import { COLLECTIONS } from "../constants";
import { fetchWalletNfts } from "../api";
import { alchemyGet } from "../lib/proxy";
import { createTradeOffer, MAX_ITEMS_PER_SIDE } from "../lib/trades";
import { estimateTokenValue, tradeDelta } from "../lib/valuation";
import { lockScroll, unlockScroll } from "../lib/scrollLock";

const COLLECTION_LIST = Object.values(COLLECTIONS);

const SUPPLY_BY_CONTRACT = COLLECTION_LIST.reduce((m, c) => {
  m[c.contract.toLowerCase()] = c.supply;
  return m;
}, {});
const keyOf = (n) => `${n.contract.toLowerCase()}:${n.id ?? n.tokenId}`;

// Classic game-trade-window scam defense: when the two sides' estimated
// floor values diverge hard, say so loudly before anyone signs.
const LOPSIDED_RATIO = 0.6;

function SidePanel({ title, accent, tokens, loading, selected, onToggle, emptyText }) {
  return (
    <div style={{ flex: "1 1 300px", minWidth: 260 }}>
      <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: accent, letterSpacing: "0.08em", marginBottom: 8 }}>
        {title} ({selected.size}/{MAX_ITEMS_PER_SIDE})
      </div>
      <div style={{
        border: "1px solid var(--border)", borderRadius: 10, padding: 10,
        background: "rgba(0,0,0,0.2)", maxHeight: 260, overflowY: "auto",
      }}>
        {loading ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 8 }}>
            {Array.from({ length: 8 }, (_, i) => (
              <div key={i} className="skeleton" style={{ aspectRatio: "1", borderRadius: 8 }} />
            ))}
          </div>
        ) : tokens.length === 0 ? (
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", padding: "16px 4px", textAlign: "center" }}>
            {emptyText}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(72px, 1fr))", gap: 8 }}>
            {tokens.map((nft) => {
              const k = keyOf(nft);
              const isSel = selected.has(k);
              return (
                <div
                  key={k}
                  onClick={() => onToggle(nft)}
                  role="checkbox"
                  aria-checked={isSel}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(nft); } }}
                  style={{
                    position: "relative", cursor: "pointer", borderRadius: 8, overflow: "hidden",
                    border: isSel ? `2px solid ${accent}` : "2px solid transparent",
                    opacity: !isSel && selected.size >= MAX_ITEMS_PER_SIDE ? 0.4 : 1,
                  }}
                  title={`${nft.collectionName} #${nft.id}`}
                >
                  <NftImage nft={nft} style={{ width: "100%", aspectRatio: "1", objectFit: "cover", display: "block" }} />
                  <div style={{
                    position: "absolute", bottom: 0, left: 0, right: 0,
                    fontFamily: "var(--mono)", fontSize: 8, padding: "2px 4px",
                    background: "rgba(0,0,0,0.7)", color: isSel ? accent : "var(--text-dim)",
                  }}>
                    #{nft.id}
                  </div>
                  {isSel && (
                    <div style={{
                      position: "absolute", top: 3, right: 3, width: 16, height: 16, borderRadius: 4,
                      background: accent, color: "#000", fontSize: 11, fontWeight: 700,
                      display: "flex", alignItems: "center", justifyContent: "center",
                    }}>{"✓"}</div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * P2P trade builder — the "trade window". Select NFTs from both wallets,
 * add optional cash legs (your side = WETH, their side = ETH), review the
 * floor-value balance, sign once.
 */
export default function TradeWindow({ wallet, counterparty: initialCounterparty, initialRequested, prefillGive, counterOf = null, boardMode = false, onClose, addToast, onCreated }) {
  const [counterparty, setCounterparty] = useState(initialCounterparty || "");
  const [counterpartyLocked] = useState(!!initialCounterparty);
  // Board mode: wildcard slot counts per collection contract (lowercase)
  const [wildcards, setWildcards] = useState({});
  const [myTokens, setMyTokens] = useState([]);
  const [theirTokens, setTheirTokens] = useState([]);
  const [loadingMine, setLoadingMine] = useState(false);
  const [loadingTheirs, setLoadingTheirs] = useState(false);
  const [give, setGive] = useState(() => new Map((prefillGive || []).map(n => [keyOf(n), n])));
  const [get, setGet] = useState(() => new Map((initialRequested || []).map(n => [keyOf(n), n])));
  const [wethTopup, setWethTopup] = useState("");
  const [ethTopup, setEthTopup] = useState("");
  // Dutch legs ("" = static): sweetener rises to wethEnd, ask decays to ethEnd
  const [wethEnd, setWethEnd] = useState("");
  const [ethEnd, setEthEnd] = useState("");
  const [floors, setFloors] = useState({}); // contract(lower) -> ETH float
  const [submitting, setSubmitting] = useState(false);
  const modalRef = useRef(null);

  const validCounterparty = boardMode
    || (/^0x[a-fA-F0-9]{40}$/.test(counterparty) && counterparty.toLowerCase() !== (wallet || "").toLowerCase());
  const wildcardTotal = Object.values(wildcards).reduce((s, n) => s + n, 0);

  // Focus trap + Escape + ref-counted scroll lock (MakeOfferModal pattern)
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape") { e.stopImmediatePropagation(); onClose(); return; }
      if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) { e.preventDefault(); last.focus(); }
        } else if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener("keydown", h);
    lockScroll();
    return () => { window.removeEventListener("keydown", h); unlockScroll(); };
  }, [onClose]);

  // Load both inventories across all supported collections
  const loadInventory = useCallback(async (owner, setTokens, setLoading) => {
    if (!owner) return;
    setLoading(true);
    try {
      const batches = await Promise.all(COLLECTION_LIST.map(async (c) => {
        try {
          const res = await fetchWalletNfts(owner, c.contract, c.metadataBase);
          return (res?.tokens || []).map(t => ({ ...t, contract: c.contract, collectionName: c.name, pixelated: c.pixelated }));
        } catch { return []; }
      }));
      setTokens(batches.flat());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadInventory(wallet, setMyTokens, setLoadingMine); }, [wallet, loadInventory]);
  useEffect(() => {
    if (validCounterparty) loadInventory(counterparty, setTheirTokens, setLoadingTheirs);
    else setTheirTokens([]);
  }, [counterparty, validCounterparty, loadInventory]);

  // Floor prices per collection (best-effort, for the balance meter only)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out = {};
      await Promise.all(COLLECTION_LIST.map(async (c) => {
        try {
          const d = await alchemyGet("getFloorPrice", { contractAddress: c.contract });
          const f = d?.openSea?.floorPrice;
          if (Number.isFinite(f)) out[c.contract.toLowerCase()] = f;
        } catch { /* meter shows em-dash */ }
      }));
      if (!cancelled) setFloors(out);
    })();
    return () => { cancelled = true; };
  }, []);

  const toggle = (map, setMap, otherMap) => (nft) => {
    const k = keyOf(nft);
    setMap(prev => {
      const next = new Map(prev);
      if (next.has(k)) next.delete(k);
      else if (next.size < MAX_ITEMS_PER_SIDE && !otherMap.has(k)) next.set(k, nft);
      return next;
    });
  };

  // Rarity-adjusted side valuation (same formula as the modal's fair-value
  // badge). Tokens without a known rank fall back to plain floor; dutch legs
  // count at their END amount (the maker's full commitment).
  const sideValue = (map, topupEth, topupEndEth) => {
    let v = 0; let known = true;
    for (const nft of map.values()) {
      const contract = nft.contract.toLowerCase();
      const est = estimateTokenValue({
        floor: floors[contract],
        rank: nft.rank,
        supply: SUPPLY_BY_CONTRACT[contract],
      });
      if (est > 0) v += est; else known = false;
    }
    const t = parseFloat(topupEndEth || topupEth);
    if (Number.isFinite(t) && t > 0) v += t;
    return { value: v, known };
  };

  const giveVal = sideValue(give, wethTopup, wethEnd);
  const getVal = boardMode
    ? (() => {
        let v = 0; let known = true;
        for (const [contract, count] of Object.entries(wildcards)) {
          const f = floors[contract];
          if (Number.isFinite(f)) v += f * count; else if (count > 0) known = false;
        }
        const t = parseFloat(ethEnd || ethTopup);
        if (Number.isFinite(t) && t > 0) v += t;
        return { value: v, known };
      })()
    : sideValue(get, ethTopup, ethEnd);
  const lopsided = giveVal.known && getVal.known && giveVal.value > 0 && getVal.value > 0
    && Math.min(giveVal.value, getVal.value) / Math.max(giveVal.value, getVal.value) < LOPSIDED_RATIO;
  const delta = giveVal.known && getVal.known ? tradeDelta(giveVal.value, getVal.value) : null;

  const canSubmit = give.size > 0 && !submitting
    && (boardMode ? wildcardTotal > 0 && wildcardTotal <= MAX_ITEMS_PER_SIDE : validCounterparty && get.size > 0);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const getEntries = boardMode
        ? Object.entries(wildcards).flatMap(([contract, count]) =>
            Array.from({ length: count }, () => ({ contract, any: true })))
        : [...get.values()].map(n => ({ contract: n.contract, tokenId: String(n.id ?? n.tokenId) }));
      const result = await createTradeOffer({
        give: [...give.values()].map(n => ({ contract: n.contract, tokenId: String(n.id ?? n.tokenId) })),
        get: getEntries,
        taker: boardMode ? null : counterparty,
        open: boardMode,
        wethTopupEth: wethTopup || "0",
        ethTopupEth: ethTopup || "0",
        wethTopupEndEth: wethEnd.trim() ? wethEnd : null,
        ethTopupEndEth: ethEnd.trim() ? ethEnd : null,
        counterOf: boardMode ? null : counterOf,
      });
      if (result.success) {
        addToast?.(boardMode ? "Posted to the trade board!" : counterOf ? "Counter-offer sent!" : "Trade offer sent!", "success");
        onCreated?.(result.trade);
        onClose();
      } else if (result.error !== "rejected") {
        addToast?.(result.message || "Trade failed", "error");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const fmtVal = (v) => v.known ? `≈ ${v.value.toFixed(4)} ETH` : "—";

  return (
    <div className="modal-bg" onClick={onClose} style={{ zIndex: 1100 }} role="dialog" aria-modal="true" aria-label={boardMode ? "Post an open trade to the board" : counterOf ? "Counter trade offer" : "Create trade offer"}>
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--bg, #0b0b14)", border: "1px solid var(--border)", borderRadius: 14,
          width: "min(860px, 94vw)", maxHeight: "90vh", overflowY: "auto",
          padding: "20px 22px", margin: "4vh auto", position: "relative",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div>
            <div style={{ fontFamily: "var(--pixel)", fontSize: 12, color: "var(--naka-blue)", letterSpacing: "0.1em" }}>
              {boardMode ? "POST TO TRADE BOARD" : counterOf ? "COUNTER OFFER" : "P2P TRADE"}
            </div>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>
              {boardMode
                ? "Public open offer — the first wallet holding what you ask for can accept. Settles atomically on Seaport."
                : "Settles atomically on Seaport. Only the wallet you name can accept."}
            </div>
          </div>
          <button aria-label="Close modal" onClick={onClose} className="btn-secondary" style={{ padding: "6px 12px", fontSize: 12 }}>{"✕"}</button>
        </div>

        {/* Counterparty (directed trades only) */}
        {!boardMode && (
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.06em", marginBottom: 6 }}>
            TRADE WITH
          </div>
          <input
            value={counterparty}
            disabled={counterpartyLocked}
            onChange={(e) => setCounterparty(e.target.value.trim())}
            placeholder="0x… wallet address"
            spellCheck={false}
            style={{
              width: "100%", fontFamily: "var(--mono)", fontSize: 12, padding: "10px 12px",
              borderRadius: 8, border: `1px solid ${counterparty && !validCounterparty ? "var(--red)" : "var(--border)"}`,
              background: "rgba(0,0,0,0.25)", color: "var(--text)",
              opacity: counterpartyLocked ? 0.7 : 1,
            }}
          />
          {counterparty && !validCounterparty && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--red)", marginTop: 4 }}>
              Enter a valid address that isn't your own
            </div>
          )}
        </div>
        )}

        {/* Two panels */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <SidePanel
            title="YOU GIVE"
            accent="var(--gold)"
            tokens={myTokens}
            loading={loadingMine}
            selected={give}
            onToggle={toggle(give, setGive, get)}
            emptyText={wallet ? "No NFTs from the supported collections in your wallet" : "Connect your wallet"}
          />
          {boardMode ? (
            <div style={{ flex: "1 1 300px", minWidth: 260 }}>
              <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--green)", letterSpacing: "0.08em", marginBottom: 8 }}>
                YOU GET ({wildcardTotal}/{MAX_ITEMS_PER_SIDE})
              </div>
              <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 12, background: "rgba(0,0,0,0.2)" }}>
                {COLLECTION_LIST.map((c) => {
                  const key = c.contract.toLowerCase();
                  const count = wildcards[key] || 0;
                  const floor = floors[key];
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 2px", borderBottom: "1px solid var(--border)" }}>
                      <div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text)" }}>Any {c.name}</div>
                        <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", marginTop: 2 }}>
                          {Number.isFinite(floor) ? `floor ${floor.toFixed(4)} ETH` : "floor —"}
                        </div>
                      </div>
                      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                        <button
                          className="btn-secondary"
                          aria-label={`Remove one Any ${c.name} slot`}
                          style={{ fontSize: 12, padding: "2px 10px", opacity: count === 0 ? 0.4 : 1 }}
                          disabled={count === 0}
                          onClick={() => setWildcards((w) => ({ ...w, [key]: Math.max(0, (w[key] || 0) - 1) }))}
                        >
                          −
                        </button>
                        <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: count > 0 ? "var(--green)" : "var(--text-dim)", minWidth: 14, textAlign: "center" }}>{count}</span>
                        <button
                          className="btn-secondary"
                          aria-label={`Add one Any ${c.name} slot`}
                          style={{ fontSize: 12, padding: "2px 10px", opacity: wildcardTotal >= MAX_ITEMS_PER_SIDE ? 0.4 : 1 }}
                          disabled={wildcardTotal >= MAX_ITEMS_PER_SIDE}
                          onClick={() => setWildcards((w) => ({ ...w, [key]: (w[key] || 0) + 1 }))}
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
                <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
                  The acceptor chooses which of their tokens fill each "Any" slot.
                </div>
              </div>
            </div>
          ) : (
          <SidePanel
            title="YOU GET"
            accent="var(--green)"
            tokens={theirTokens}
            loading={loadingTheirs}
            selected={get}
            onToggle={toggle(get, setGet, give)}
            emptyText={validCounterparty ? "No NFTs from the supported collections in that wallet" : "Enter the counterparty address above"}
          />
          )}
        </div>

        {/* Cash legs */}
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", marginTop: 14 }}>
          <div style={{ flex: "1 1 260px" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)", letterSpacing: "0.06em", marginBottom: 6 }}>
              + YOU ADD (WETH, optional)
            </div>
            <input
              value={wethTopup}
              onChange={(e) => setWethTopup(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 12, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "rgba(0,0,0,0.25)", color: "var(--text)" }}
            />
            <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", marginTop: 4 }}>
              Wrapped automatically if needed — Seaport can't pull plain ETH from the offer side
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={wethEnd !== ""}
                onChange={(e) => setWethEnd(e.target.checked ? (wethTopup || "0.01") : "")}
              />
              {"📈"} Auto-sweeten until accepted
            </label>
            {wethEnd !== "" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap" }}>rises to</span>
                <input
                  value={wethEnd}
                  onChange={(e) => setWethEnd(e.target.value)}
                  inputMode="decimal"
                  aria-label="Final WETH sweetener at expiry"
                  style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(212,168,67,0.3)", background: "rgba(0,0,0,0.25)", color: "var(--text)" }}
                />
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>by expiry</span>
              </div>
            )}
          </div>
          <div style={{ flex: "1 1 260px" }}>
            <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", letterSpacing: "0.06em", marginBottom: 6 }}>
              + THEY ADD (ETH, optional)
            </div>
            <input
              value={ethTopup}
              onChange={(e) => setEthTopup(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
              style={{ width: "100%", fontFamily: "var(--mono)", fontSize: 12, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "rgba(0,0,0,0.25)", color: "var(--text)" }}
            />
            <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", marginTop: 4 }}>
              Paid by the counterparty when they accept
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontFamily: "var(--mono)", fontSize: 9, color: "var(--green)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={ethEnd !== ""}
                onChange={(e) => setEthEnd(e.target.checked ? "0" : "")}
              />
              {"📉"} Ask decays until accepted
            </label>
            {ethEnd !== "" && (
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", whiteSpace: "nowrap" }}>falls to</span>
                <input
                  value={ethEnd}
                  onChange={(e) => setEthEnd(e.target.value)}
                  inputMode="decimal"
                  aria-label="Final ETH ask at expiry"
                  style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11, padding: "8px 10px", borderRadius: 8, border: "1px solid rgba(74,222,128,0.3)", background: "rgba(0,0,0,0.25)", color: "var(--text)" }}
                />
                <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)" }}>by expiry</span>
              </div>
            )}
          </div>
        </div>

        {/* Balance meter */}
        <div style={{
          display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap",
          marginTop: 14, padding: "10px 14px", borderRadius: 8,
          background: "rgba(111,168,220,0.04)", border: "1px solid rgba(111,168,220,0.1)",
        }}>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
            You give <span style={{ color: "var(--gold)" }}>{fmtVal(giveVal)}</span>
          </div>
          <div style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-dim)" }}>
            You get <span style={{ color: "var(--green)" }}>{fmtVal(getVal)}</span>
          </div>
          {delta != null && Math.abs(delta) >= 0.02 && (
            <div style={{
              fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
              color: delta > 0 ? "var(--green)" : "var(--gold)",
            }}>
              ≈ {delta > 0 ? "+" : ""}{(delta * 100).toFixed(1)}% for you
            </div>
          )}
          <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)" }}>
            rarity-adjusted estimate
          </div>
        </div>
        {lopsided && (
          <div style={{
            marginTop: 8, padding: "10px 14px", borderRadius: 8,
            background: "rgba(248,113,113,0.06)", border: "1px solid rgba(248,113,113,0.2)",
            fontFamily: "var(--mono)", fontSize: 10, color: "var(--red)",
          }}>
            {"⚠"} This trade is heavily one-sided by floor value. Double-check every token ID before signing.
          </div>
        )}

        {/* Submit */}
        <div style={{ display: "flex", gap: 10, marginTop: 16 }}>
          <button
            className="btn-primary"
            style={{ flex: 1, opacity: canSubmit ? 1 : 0.5 }}
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting ? "Check your wallet…" : boardMode ? "Sign & post to board" : counterOf ? "Sign counter-offer" : "Sign trade offer"}
          </button>
        </div>
        <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", marginTop: 8, lineHeight: 1.5 }}>
          Signing is gas-free. Your items only move if the counterparty accepts, in one atomic Seaport transaction.
          Offers expire in 72h. NFT-for-NFT swaps carry no fee.
        </div>
      </div>
    </div>
  );
}
