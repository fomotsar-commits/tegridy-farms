import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { shortenAddress } from "../api";
import { useSiweAuth } from "../hooks/useSiweAuth";
import useEns from "../hooks/useEns";
import { fetchThread, fetchConversations, sendDm, markThreadRead } from "../lib/dm";
import { fetchTrades, acceptTrade } from "../lib/trades";
import { TradeSummary } from "./TradeChips";

const POLL_MS = 15_000; // inside the proxy's 20/min wallet budget
const MAX_CHARS = 500;
const BLOCK_KEY = "nakamigos_dm_blocked";

/* ── helpers ─────────────────────────────────────────────────────── */

const fmtClock = (ts) =>
  new Date(ts).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const fmtAgo = (ts) => {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  if (mins < 1440) return `${Math.floor(mins / 60)}h`;
  return new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
};

// Deterministic identicon: two hues from the address, no dependencies.
const avatarStyle = (addr, size = 28) => {
  let h1 = 0, h2 = 0;
  const a = (addr || "0x").toLowerCase();
  for (let i = 2; i < a.length; i++) {
    const c = a.charCodeAt(i);
    if (i % 2) h1 = (h1 * 31 + c) % 360; else h2 = (h2 * 31 + c) % 360;
  }
  return {
    width: size, height: size, minWidth: size, borderRadius: "50%",
    background: `linear-gradient(135deg, hsl(${h1} 65% 55%), hsl(${h2} 65% 35%))`,
    border: "1px solid var(--border)",
  };
};

const loadBlocked = () => {
  try { return new Set(JSON.parse(localStorage.getItem(BLOCK_KEY) || "[]")); }
  catch { return new Set(); }
};

function PeerName({ address, style }) {
  const { ensName } = useEns(address);
  return <span style={style} title={address}>{ensName || shortenAddress(address)}</span>;
}

/* ── trade card inside a thread ──────────────────────────────────── */

function DmTradeCard({ tradeId, tradesById, wallet, addToast, onOpenTrades, onTradeChanged }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const trade = tradesById?.[tradeId];

  if (!trade) {
    return (
      <button
        onClick={() => onOpenTrades?.()}
        style={{
          display: "block", width: "100%", textAlign: "left", cursor: "pointer",
          fontFamily: "var(--mono)", fontSize: 9, color: "var(--gold)",
          background: "rgba(212,168,67,0.08)", border: "1px solid rgba(212,168,67,0.2)",
          borderRadius: 6, padding: "6px 8px", marginBottom: 6,
        }}
      >
        {"⇄"} Trade offer — view in Trades
      </button>
    );
  }

  const amTarget = trade.target_owner?.toLowerCase() === wallet.toLowerCase();
  const isActive = trade.status === "active" && (!trade.expires_at || new Date(trade.expires_at).getTime() > Date.now());
  const statusColor = { active: "var(--naka-blue)", accepted: "var(--green)", declined: "var(--red)" }[trade.status] || "var(--text-muted)";

  return (
    <div style={{
      background: "rgba(212,168,67,0.05)", border: "1px solid rgba(212,168,67,0.18)",
      borderRadius: 8, padding: "8px 10px", marginBottom: 6,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--gold)", letterSpacing: "0.08em" }}>{"⇄"} TRADE OFFER</span>
        <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: statusColor, textTransform: "uppercase", letterSpacing: "0.06em" }}>{trade.status}</span>
      </div>
      <TradeSummary trade={trade} viewer={wallet} />
      <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
        {isActive && amTarget && (
          confirming ? (
            <button
              className="btn-primary"
              style={{ fontSize: 9, padding: "6px 12px" }}
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await acceptTrade(trade);
                  if (result.success) {
                    addToast?.("Trade executed!", "success");
                    onTradeChanged?.();
                  } else if (result.error !== "rejected") {
                    addToast?.(result.message || "Trade failed", "error");
                  }
                } finally {
                  setBusy(false);
                  setConfirming(false);
                }
              }}
            >
              {busy ? "Trading…" : "Confirm — sign & execute"}
            </button>
          ) : (
            <button className="btn-primary" style={{ fontSize: 9, padding: "6px 12px" }} onClick={() => setConfirming(true)}>
              Accept trade
            </button>
          )
        )}
        <button className="btn-secondary" style={{ fontSize: 9, padding: "6px 12px" }} onClick={() => onOpenTrades?.()}>
          Open in Trades
        </button>
      </div>
    </div>
  );
}

/* ── main component ──────────────────────────────────────────────── */

/**
 * Wallet-to-wallet DMs, server-mediated (SIWE cookie → RLS). Full messaging
 * surface: ENS identities, unread badges, day separators, optimistic sends
 * with retry, read receipts, inline trade cards with accept-from-thread,
 * per-wallet blocking, and single-pane navigation on narrow screens.
 */
export default function DirectMessages({ wallet, addToast, initialPeer = null, initialTradeId = null, onOpenTrades, embedded = false }) {
  const { isAuthenticating, signIn } = useSiweAuth();
  const [convos, setConvos] = useState([]);
  const [peer, setPeer] = useState(initialPeer ? initialPeer.toLowerCase() : null);
  const [peerInput, setPeerInput] = useState("");
  const [thread, setThread] = useState([]);
  const [pending, setPending] = useState([]); // optimistic sends: {key, text, tradeId, failed}
  const [text, setText] = useState("");
  const [state, setState] = useState("loading"); // loading | ready | needs-auth | not-enabled | error
  const [sending, setSending] = useState(false);
  const [blocked, setBlocked] = useState(loadBlocked);
  const [tradesById, setTradesById] = useState({});
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 640px)").matches);
  const listRef = useRef(null);
  const pendingTradeRef = useRef(initialTradeId);
  const peerEns = useEns(peer);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 640px)");
    const onChange = (e) => setIsNarrow(e.matches);
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, []);

  const classify = (err) => {
    if (err?.needsAuth) return "needs-auth";
    // 4xx (e.g. PostgREST rejecting the missing table pre-migration) reads
    // as not-enabled; network failures / 5xx are transient → retryable.
    if (err?.status && err.status < 500) return "not-enabled";
    return "error";
  };

  const loadConvos = useCallback(async () => {
    if (!wallet) return;
    try {
      const list = await fetchConversations(wallet);
      setConvos(list);
      setState((s) => (s === "loading" || s === "error" ? "ready" : s));
    } catch (err) {
      setState(classify(err));
    }
  }, [wallet]);

  const loadThread = useCallback(async () => {
    if (!wallet || !peer) return;
    try {
      const msgs = await fetchThread(wallet, peer);
      setThread(msgs);
      // Drop optimistic entries the server now returns
      setPending((prev) => prev.filter((p) => !msgs.some((m) => m.text === p.text && m.sender.toLowerCase() === wallet.toLowerCase())));
      setState("ready");
      markThreadRead(wallet, peer);
    } catch (err) {
      setState(classify(err));
    }
  }, [wallet, peer]);

  // Trades map for inline cards (both directions, all statuses)
  const loadTradesMap = useCallback(async () => {
    if (!wallet) return;
    try {
      const [inc, out] = await Promise.all([
        fetchTrades({ wallet, role: "incoming", status: "all" }),
        fetchTrades({ wallet, role: "outgoing", status: "all" }),
      ]);
      const map = {};
      for (const t of [...(inc.trades || []), ...(out.trades || [])]) map[t.id] = t;
      setTradesById(map);
    } catch { /* cards fall back to the deep link */ }
  }, [wallet]);

  useEffect(() => { loadConvos(); loadTradesMap(); }, [loadConvos, loadTradesMap]);
  useEffect(() => {
    loadThread();
    if (!peer) return;
    const t = setInterval(() => { if (!document.hidden) { loadThread(); loadConvos(); } }, POLL_MS);
    return () => clearInterval(t);
  }, [peer, loadThread, loadConvos]);

  // Autoscroll only when already near the bottom (don't yank mid-history)
  const nearBottomRef = useRef(true);
  useEffect(() => {
    const el = listRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [thread.length, pending.length, peer]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  const toggleBlock = useCallback((addr) => {
    setBlocked((prev) => {
      const next = new Set(prev);
      const a = addr.toLowerCase();
      if (next.has(a)) next.delete(a); else next.add(a);
      try { localStorage.setItem(BLOCK_KEY, JSON.stringify([...next])); } catch { /* quota */ }
      return next;
    });
  }, []);

  const doSend = useCallback(async (body, tradeId, optimisticKey) => {
    try {
      const msg = await sendDm({ me: wallet, other: peer, text: body, tradeId });
      if (msg) {
        setThread((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        setPending((prev) => prev.filter((p) => p.key !== optimisticKey));
        loadConvos();
      }
    } catch (err) {
      if (err.needsAuth) { setState("needs-auth"); setPending((prev) => prev.filter((p) => p.key !== optimisticKey)); }
      else setPending((prev) => prev.map((p) => (p.key === optimisticKey ? { ...p, failed: true } : p)));
    }
  }, [wallet, peer, loadConvos]);

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || !wallet || !peer || sending) return;
    if (trimmed.length > MAX_CHARS) return;
    setSending(true);
    nearBottomRef.current = true;
    const tradeId = pendingTradeRef.current;
    pendingTradeRef.current = null;
    const key = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setPending((prev) => [...prev, { key, text: trimmed, tradeId, failed: false }]);
    setText("");
    await doSend(trimmed, tradeId, key);
    setSending(false);
  }, [text, wallet, peer, sending, doSend]);

  const retryPending = useCallback((p) => {
    setPending((prev) => prev.map((x) => (x.key === p.key ? { ...x, failed: false } : x)));
    doSend(p.text, p.tradeId, p.key);
  }, [doSend]);

  const visibleConvos = useMemo(
    () => convos.filter((c) => !blocked.has(c.peer.toLowerCase())),
    [convos, blocked],
  );

  // Read receipt: the newest of MY messages that the peer has read
  const lastReadOwnId = useMemo(() => {
    let best = null;
    for (const m of thread) {
      if (m.sender.toLowerCase() === wallet?.toLowerCase() && m.readAt) {
        if (!best || m.timestamp > best.timestamp) best = m;
      }
    }
    return best?.id || null;
  }, [thread, wallet]);

  /* ── gates ── */

  if (!wallet) {
    return (
      <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
        <div className="empty-state-icon">{"✉"}</div>
        <div className="empty-state-title">Direct Messages</div>
        <div className="empty-state-text">Connect your wallet to message other traders.</div>
      </div>
    );
  }

  if (state === "needs-auth") {
    return (
      <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
        <div className="empty-state-icon">{"✉"}</div>
        <div className="empty-state-title">Sign in for DMs</div>
        <div className="empty-state-text">Direct messages are private — a one-time signature proves this wallet is yours.</div>
        <button
          className="btn-primary"
          style={{ marginTop: 14, padding: "10px 24px" }}
          disabled={isAuthenticating}
          onClick={async () => {
            const ok = await signIn();
            if (ok) { setState("loading"); loadConvos(); if (peer) loadThread(); }
          }}
        >
          {isAuthenticating ? "Check your wallet…" : "Sign in"}
        </button>
      </div>
    );
  }

  if (state === "not-enabled") {
    return (
      <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
        <div className="empty-state-icon">{"✉"}</div>
        <div className="empty-state-title">DMs aren't enabled yet</div>
        <div className="empty-state-text">The messaging backend (migration 007) hasn't been switched on. Check back soon.</div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <div className="empty-state" style={{ borderRadius: 12, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
        <div className="empty-state-icon">{"📡"}</div>
        <div className="empty-state-title">Messages Unreachable</div>
        <div className="empty-state-text">Couldn't reach the messaging service — your history is safe.</div>
        <button className="btn-secondary" style={{ marginTop: 14, padding: "10px 24px" }} onClick={() => { setState("loading"); loadConvos(); if (peer) loadThread(); }}>
          Retry
        </button>
      </div>
    );
  }

  const showList = !isNarrow || !peer;
  const showThread = !isNarrow || !!peer;

  /* ── layout ── */

  return (
    <div style={{ display: "flex", gap: 12, flexWrap: isNarrow ? "nowrap" : "wrap", minHeight: embedded ? 360 : 420 }} aria-label="Direct messages">
      {/* Conversation list */}
      {showList && (
        <div style={{ flex: isNarrow ? "1 1 auto" : "1 1 200px", maxWidth: isNarrow ? "none" : 280, width: isNarrow ? "100%" : undefined }}>
          <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input
              value={peerInput}
              onChange={(e) => setPeerInput(e.target.value.trim())}
              onKeyDown={(e) => { if (e.key === "Enter" && /^0x[a-fA-F0-9]{40}$/.test(peerInput)) { setPeer(peerInput.toLowerCase()); setPeerInput(""); } }}
              placeholder="New DM: 0x…"
              aria-label="Start a new conversation by wallet address"
              spellCheck={false}
              style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 10, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--border)", background: "rgba(0,0,0,0.25)", color: "var(--text)" }}
            />
            <button
              className="btn-secondary"
              style={{ fontSize: 10, padding: "6px 10px" }}
              disabled={!/^0x[a-fA-F0-9]{40}$/.test(peerInput) || peerInput.toLowerCase() === wallet.toLowerCase()}
              onClick={() => { setPeer(peerInput.toLowerCase()); setPeerInput(""); }}
            >
              Open
            </button>
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }} role="list" aria-label="Conversations">
            {state === "loading" ? (
              <div style={{ padding: 8 }}>
                {Array.from({ length: 3 }, (_, i) => <div key={i} className="skeleton" style={{ height: 44, borderRadius: 8, marginBottom: 6 }} />)}
              </div>
            ) : visibleConvos.length === 0 ? (
              <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", padding: 14, textAlign: "center" }}>
                No conversations yet — start one above or message a trader from a trade card.
              </div>
            ) : (
              visibleConvos.map((c) => (
                <button
                  key={c.channelKey}
                  role="listitem"
                  onClick={() => { setPeer(c.peer); nearBottomRef.current = true; }}
                  style={{
                    display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left", cursor: "pointer",
                    padding: "9px 10px", background: peer === c.peer ? "rgba(111,168,220,0.08)" : "transparent",
                    border: "none", borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div style={avatarStyle(c.peer)} aria-hidden="true" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6 }}>
                      <PeerName address={c.peer} style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--naka-blue)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} />
                      <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{fmtAgo(c.last.timestamp)}</span>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 6, marginTop: 3 }}>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 9, color: c.unread ? "var(--text)" : "var(--text-dim)", fontWeight: c.unread ? 700 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.last.tradeId ? "⇄ Trade offer" : c.last.text}
                      </span>
                      {c.unread > 0 && (
                        <span aria-label={`${c.unread} unread`} style={{ fontFamily: "var(--mono)", fontSize: 8, background: "var(--naka-blue)", color: "#000", borderRadius: 8, padding: "1px 6px", fontWeight: 700 }}>
                          {c.unread}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
          {blocked.size > 0 && (
            <div style={{ display: "flex", justifyContent: "center", gap: 6, padding: "6px 0", fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)" }}>
              {blocked.size} blocked
              <button
                onClick={() => { setBlocked(new Set()); try { localStorage.setItem(BLOCK_KEY, "[]"); } catch { /* quota */ } }}
                style={{ background: "none", border: "none", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 8, color: "var(--naka-blue)", padding: 0 }}
              >
                unblock all
              </button>
            </div>
          )}
        </div>
      )}

      {/* Thread */}
      {showThread && (
        <div style={{ flex: "2 1 320px", display: "flex", flexDirection: "column", width: isNarrow ? "100%" : undefined }}>
          {!peer ? (
            <div className="empty-state" style={{ flex: 1, borderRadius: 10, background: "var(--surface-glass)", border: "1px solid var(--border)" }}>
              <div className="empty-state-icon">{"✉"}</div>
              <div className="empty-state-text">Pick a conversation or start a new one.</div>
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "2px 2px 8px" }}>
                {isNarrow && (
                  <button className="btn-secondary" style={{ fontSize: 10, padding: "4px 10px" }} onClick={() => setPeer(null)} aria-label="Back to conversations">
                    {"←"}
                  </button>
                )}
                <div style={avatarStyle(peer, 24)} aria-hidden="true" />
                <PeerName address={peer} style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--naka-blue)", flex: 1 }} />
                {peerEns.ensName && (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)" }}>{shortenAddress(peer)}</span>
                )}
                <button
                  className="btn-secondary"
                  style={{ fontSize: 9, padding: "4px 10px", color: blocked.has(peer) ? "var(--green)" : "var(--red)" }}
                  onClick={() => toggleBlock(peer)}
                  title={blocked.has(peer) ? "Unblock this wallet" : "Block: hides the conversation and stops notifications (local only)"}
                >
                  {blocked.has(peer) ? "Unblock" : "Block"}
                </button>
              </div>
              <div
                ref={listRef}
                onScroll={onScroll}
                role="log"
                aria-label={`Conversation with ${peerEns.ensName || shortenAddress(peer)}`}
                style={{ flex: 1, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 10, padding: 12, minHeight: 240, maxHeight: 380 }}
              >
                {state === "loading" && thread.length === 0 ? (
                  <div style={{ padding: 8 }}>
                    {Array.from({ length: 4 }, (_, i) => <div key={i} className="skeleton" style={{ height: 36, borderRadius: 8, marginBottom: 8, width: i % 2 ? "60%" : "75%", marginLeft: i % 2 ? "auto" : 0 }} />)}
                  </div>
                ) : thread.length === 0 && pending.length === 0 ? (
                  <div style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--text-dim)", textAlign: "center", paddingTop: 40 }}>
                    No messages yet — say hi or send a trade offer.
                  </div>
                ) : (
                  <>
                    {thread.map((m, i) => {
                      const own = m.sender.toLowerCase() === wallet.toLowerCase();
                      const prev = thread[i - 1];
                      const newDay = !prev || dayLabel(prev.timestamp) !== dayLabel(m.timestamp);
                      const grouped = prev && prev.sender === m.sender && !newDay && m.timestamp - prev.timestamp < 5 * 60_000;
                      return (
                        <div key={m.id}>
                          {newDay && (
                            <div style={{ textAlign: "center", fontFamily: "var(--mono)", fontSize: 8, color: "var(--text-muted)", letterSpacing: "0.08em", margin: "10px 0 8px" }}>
                              {dayLabel(m.timestamp).toUpperCase()}
                            </div>
                          )}
                          <div style={{ display: "flex", justifyContent: own ? "flex-end" : "flex-start", marginTop: grouped ? 2 : 8 }}>
                            <div style={{
                              maxWidth: "78%", padding: "7px 11px",
                              borderRadius: grouped ? 8 : 10,
                              background: own ? "rgba(111,168,220,0.10)" : "rgba(255,255,255,0.04)",
                              border: "1px solid var(--border)",
                            }}>
                              {m.tradeId && (
                                <DmTradeCard
                                  tradeId={m.tradeId}
                                  tradesById={tradesById}
                                  wallet={wallet}
                                  addToast={addToast}
                                  onOpenTrades={onOpenTrades}
                                  onTradeChanged={loadTradesMap}
                                />
                              )}
                              <div style={{ fontFamily: "var(--display)", fontSize: 12, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                                {m.text}
                              </div>
                              <div style={{ fontFamily: "var(--mono)", fontSize: 7, color: "var(--text-muted)", marginTop: 3, textAlign: own ? "right" : "left" }}>
                                {fmtClock(m.timestamp)}
                                {own && m.id === lastReadOwnId && <span style={{ marginLeft: 5, color: "var(--naka-blue)" }}>{"✓✓ read"}</span>}
                              </div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    {pending.map((p) => (
                      <div key={p.key} style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}>
                        <div style={{
                          maxWidth: "78%", padding: "7px 11px", borderRadius: 10,
                          background: "rgba(111,168,220,0.06)", border: `1px dashed ${p.failed ? "var(--red)" : "var(--border)"}`,
                          opacity: p.failed ? 1 : 0.7,
                        }}>
                          <div style={{ fontFamily: "var(--display)", fontSize: 12, color: "var(--text)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{p.text}</div>
                          <div style={{ fontFamily: "var(--mono)", fontSize: 7, color: p.failed ? "var(--red)" : "var(--text-muted)", marginTop: 3, textAlign: "right" }}>
                            {p.failed ? (
                              <>
                                failed —{" "}
                                <button onClick={() => retryPending(p)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--naka-blue)", fontFamily: "var(--mono)", fontSize: 7, padding: 0 }}>
                                  retry
                                </button>
                              </>
                            ) : "sending…"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </>
                )}
              </div>
              {pendingTradeRef.current && (
                <div style={{ fontFamily: "var(--mono)", fontSize: 8, color: "var(--gold)", padding: "6px 2px 0" }}>
                  {"⇄"} A trade card will be attached to your next message
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 8, alignItems: "flex-end" }}>
                <div style={{ flex: 1 }}>
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
                    placeholder={`Message ${peerEns.ensName || shortenAddress(peer)}…`}
                    aria-label="Message text"
                    rows={1}
                    maxLength={MAX_CHARS}
                    style={{ width: "100%", fontFamily: "var(--display)", fontSize: 12, padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "rgba(0,0,0,0.25)", color: "var(--text)", resize: "none" }}
                  />
                  <div style={{ fontFamily: "var(--mono)", fontSize: 7, color: text.length > MAX_CHARS - 50 ? "var(--gold)" : "var(--text-muted)", textAlign: "right", marginTop: 2 }}>
                    {text.length} / {MAX_CHARS}
                  </div>
                </div>
                <button className="btn-primary" style={{ fontSize: 11, padding: "10px 18px", marginBottom: 14 }} disabled={sending || !text.trim()} onClick={handleSend}>
                  Send
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
